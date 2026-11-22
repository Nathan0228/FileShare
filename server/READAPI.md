# 实验 1B 后端接口说明书

SFT/1 是 React 客户端与 Go 服务之间的文件共享协议。客户端在一个标签页内复用一条 WebSocket 长连接，完成 Passkey 登录、账号权限管理、文件共享和并行上传下载。MariaDB 保存身份、权限、元数据和上传断点，文件数据写入 VPS 的专用数据卷。服务端通过显式报文确认文件完成，并继续维护连接。

## 运行与部署

### VPS 与 Cloudflare Pages

1. 将 React 静态站点绑定到生产域名（例如 `fs.findingai.top`）。将另一条 DNS-only A 或 AAAA 记录（例如 `fs-api.findingai.top`）指向 VPS，并为 Caddy 开放公网 TCP 80 和 443。
2. 在 `server` 目录把 [`.env.example`](.env.example) 复制为 `.env`，填写域名，并给数据库应用账号和 root 账号设置两个独立的强密码。
3. 构建并启动服务，随后在 VPS 本地终端生成首位管理员的注册邀请。

   ```sh
   cp .env.example .env
   # 编辑 .env
   docker compose up -d --build
   docker compose exec -T app /usr/local/bin/sft bootstrap --username admin
   ```

   命令输出 15 分钟内有效的邀请令牌。通过可信渠道交付，管理员在页面用它登记 Passkey，再按账号名登录。同一管理员在首次成功登记之前可以重新生成邀请，新令牌会替换旧令牌。
4. React 以 `wss://fs-api.findingai.top/sft` 为连接地址，并在 CSP 的 `connect-src` 中允许该 WSS 端点。

[Compose 配置](compose.yaml) 使用 MariaDB 11.4，将 Go 与数据库放在私有网络中。[Caddy 配置](Caddyfile) 在公网终止 TLS 1.3，通过 HTTP/1.1 升级到 WebSocket，只反代 `/sft`。Go 的 `/healthz` 和 `/readyz` 供受信运维网络使用，分别返回 204，以及可用时 204、不可用时 503。应用容器以 UID/GID 10001 运行，根文件系统只读，业务数据卷挂载到 `/srv/sft`。备份时保留同一时间点的数据库和文件卷。

### 本地开发

需要 Go 1.26 和一个已创建的 MariaDB 数据库。应用数据库账号须能在该库创建表和访问业务数据。`migrate` 可重复运行，`serve` 和 `bootstrap` 启动时也会检查并应用迁移。[数据库结构](internal/store/schema.sql)

```powershell
# 在 server 目录执行。先用实际数据库密码替换示例值。
$env:SFT_DB_PASSWORD = '替换为数据库应用账号密码'
go run ./cmd/sft migrate
go run ./cmd/sft bootstrap --username admin
go run ./cmd/sft serve
```

默认前端 Origin 为 `http://localhost:5173`，RP ID 为 `localhost`，WS 地址为 `ws://127.0.0.1:8080/sft`。保持页面的实际 Origin 与配置一致。本地明文 WS 用于环回开发，公网使用 WSS。

| 环境变量 | 用途及默认值 |
| --- | --- |
| `SFT_API_HOST` | Compose 中供 Caddy 使用的 API 域名 |
| `SFT_ORIGIN` | 精确匹配的前端 Origin，例 `https://fs.findingai.top`。本地默认 `http://localhost:5173` |
| `SFT_RP_ID` | 前端 Origin 的主机名，例 `app.example.com`。本地默认 `localhost` |
| `SFT_DB_DSN` | 可选的 Go MySQL DSN。设置后覆盖下列数据库连接参数 |
| `SFT_DB_ADDR` | 本地默认 `127.0.0.1:3306`，Compose 使用 `db:3306` |
| `SFT_DB_NAME` / `SFT_DB_USER` | 数据库名及应用账号，默认均为 `sft` |
| `SFT_DB_PASSWORD` | 应用账号密码。未设置 DSN 时必填 |
| `MARIADB_ROOT_PASSWORD` | Compose 中 MariaDB 初始化所需的 root 密码 |
| `SFT_LISTEN_ADDR` | Go 监听地址。本地默认 `127.0.0.1:8080`，Compose 使用容器内 `0.0.0.0:8080` |
| `SFT_STORAGE_ROOT` | 本地默认 `./data`，Compose 使用 `/srv/sft`。分片与成品位于其中的 `staging` 和 `objects`，需在同一文件系统 |
| `SFT_TRUST_PROXY` | 默认 `false`。Compose 中由 Caddy 覆盖写入 `X-SFT-Client-IP`，Go 使用 `true`。仅在应用入口由受信代理独占时启用 |
| `SFT_LOG_LEVEL` | 默认 `info`。`debug` 会记录收到 Pong 的连接 ID，便于验收长连接 |

## 连接与二进制报头

浏览器使用 `new WebSocket(url, "sft.v1")`，并把 `binaryType` 设为 `"arraybuffer"`。服务端要求升级路径为 `/sft`、请求没有查询参数、Origin 与配置精确匹配，且客户端只请求子协议 `sft.v1`。普通 HTTP 请求、Origin 不匹配和连接限额会分别得到 HTTP 400、403 或 429。Go 服务发送 WebSocket Ping，浏览器自动回复 Pong，服务端通过读超时清理断开的连接。

一个 WebSocket 二进制消息对应一个 SFT/1 报文。报头固定 32 字节，多字节整数使用网络大端序。

| 偏移 | 长度 | 字段 | 约定 |
| ---: | ---: | --- | --- |
| 0 | 2 | `Magic` | 固定字节 `53 46`（ASCII `SF`） |
| 2 | 1 | `Version` | 固定 `01` |
| 3 | 1 | `Type` | 下表的十六进制消息编号 |
| 4 | 4 | `PayloadLen` | 仅计算载荷字节。消息总长须等于 `32 + PayloadLen` |
| 8 | 4 | `RequestID` | 每条连接从 1 开始严格递增，允许跳号。响应回显此值，并发响应可乱序。重试分配新值 |
| 12 | 16 | `TransferID` | 上传使用 `uploadId`，下载使用不可变 `fileId`。无任务上下文时填全零。建立任务的请求填全零，由 `PUT_READY` 或 `GET_READY` 首次返回 ID |
| 28 | 4 | `ChunkIndex` | 从 0 开始。只有 `PUT_DATA`、`GET_CHUNK` 和对应响应使用索引，其他消息填 `FFFFFFFF` |

控制载荷为 UTF-8 JSON 对象，最大 16 KiB。字段名区分大小写，重复键和未知的顶层字段会被拒绝。表中列为“空”的消息使用 0 字节。文件数据载荷是 `32 字节原始 SHA-256 + 分片数据`，最大 262176 字节。WebSocket 消息总上限 262208 字节。JSON 中 UUID 使用小写标准连字符格式，报头使用对应的 16 个原始字节。JSON 中 SHA-256 为 64 个小写十六进制字符。令牌、认证器二进制字段和断点位图使用无填充 base64url。

例如，`RequestID=1` 且载荷为空的 `LOGOUT` 报文共有 32 字节。下面的三行按顺序拼接。

```text
53 46 01 08 00 00 00 00 00 00 00 01
00 00 00 00 00 00 00 00 00 00 00 00 00 00 00 00
ff ff ff ff
```

## 消息目录

下表的方向均为客户端请求 → Go 响应。通用成功为 `7D OK`，表中未指定响应载荷时为空。通用失败为 `7E ERROR`，带 `{"code":"…","retryable":false}`。

| 请求 | 请求载荷 | 成功响应与载荷 |
| --- | --- | --- |
| `01 ENROLL_BEGIN` | `{inviteToken}` | `02 CHALLENGE` · `{challengeId,options}` |
| `03 ENROLL_FINISH` | `{challengeId,credential}` | `7D OK` |
| `04 AUTH_BEGIN` | `{username}` | `02 CHALLENGE` · `{challengeId,options}` |
| `05 AUTH_FINISH` | `{challengeId,credential}` | `06 AUTH_OK` · `{userId,role,permissions,token}` |
| `07 SESSION_ATTACH` | `{token}` | `06 AUTH_OK` · `{userId,role,permissions,token}` |
| `08 LOGOUT` | 空 | `7D OK` |
| `10 LIST` | `{scope,cursor}`，`scope` 为 `owned` 或 `shared` | `11 LIST_OK` · `{items,nextCursor}` |
| `12 SHARE_SET` | `{fileId,grantee,allow}` 或 `{fileId,grantees,allow}`，`allow` 为布尔值 | `7D OK` |
| `13 ADMIN` | `{action,...}`，见管理员接口 | `7D OK`，载荷取决于操作 |
| `14 FILE_DELETE` | `{fileId}` | `7D OK` |
| `15 USER_PROFILE` | 空 | `16 USER_PROFILE_OK` · `{userId,username,role,permissions,quotaBytes,usedBytes,reservedBytes}` |
| `17 OUTGOING_SHARES` | `{view,cursor}`，`view` 为 `active` 或 `history` | `18 OUTGOING_SHARES_OK` · `{items,nextCursor}` |
| `19 FRIENDS` | `{cursor}`，首个游标可省略 | `1A FRIENDS_OK` · `{items,nextCursor}` |
| `1B FRIEND_NOTE` | `{friendId,note}` | `7D OK` |
| `20 PUT_BEGIN` | `{opId,name,size,sha256}` | `21 PUT_READY` · `{size,sha256,chunkBytes,state}`，报头返回上传 ID |
| `22 PUT_DATA` | 分片摘要与数据 | `7D OK`，报头回显上传 ID 和索引 |
| `23 PUT_STATUS` | 空 | `24 PUT_STATE` · `{state,bitmap,fileId}`，未发布时 `fileId` 为 `null` |
| `25 PUT_COMMIT` | 空 | `26 PUT_DONE` · `{fileId}` |
| `27 PUT_CANCEL` | 空 | `7D OK`，取消未发布任务 |
| `28 PUT_PAUSE` | 空 | `7D OK`，释放绑定并保留已确认分片 |
| `30 GET_BEGIN` | `{fileId}` | `31 GET_READY` · `{name,size,sha256,chunkBytes}`，报头返回 `fileId` |
| `32 GET_CHUNK` | 空 | `33 GET_DATA` · 分片摘要与数据，报头回显文件 ID 和索引 |
| `34 GET_DONE` | `{sha256}`，为客户端验证后的整文件摘要 | `7D OK`，记录完成并释放下载绑定 |
| `35 GET_CLOSE` | 空 | `7D OK`，释放当前下载绑定 |

### 注册、登录与重连

- 注册时用 `ENROLL_BEGIN` 交换一次性挑战。把返回的 `options` 交给 `PublicKeyCredential.parseCreationOptionsFromJSON`，再调用 `navigator.credentials.create({publicKey})`。将凭据的 `toJSON()` 结果和原 `challengeId` 发送到同一连接的 `ENROLL_FINISH`。成功后执行登录。
- 登录时发送 `AUTH_BEGIN`。把 `options` 交给 `PublicKeyCredential.parseRequestOptionsFromJSON`，再调用 `navigator.credentials.get({publicKey})`。在同一连接发送 `AUTH_FINISH`，其 `credential` 为断言的 `toJSON()` 结果。两种 `options` 都直接表示 WebAuthn 公钥选项，调用时由浏览器端包装成 `{publicKey}`。
- 每条连接最多保留一个待完成挑战，后发挑战替换前一个。挑战绑定连接、用途和用户，120 秒内一次性使用。注册采用 ES256 并要求用户验证。账号最多 8 个有效凭据。
- `AUTH_OK` 返回用户 ID、`admin` 或 `user` 角色、权限数组和 32 字节随机会话令牌的 base64url 表示。页面把令牌留在内存。掉线重连后先发 `SESSION_ATTACH`，再恢复任务。刷新页面或过期后重新 Passkey 登录。会话绝对有效期 8 小时，业务空闲 30 分钟过期。Ping/Pong 不更新业务空闲期限。
- `LOGOUT` 撤销当前令牌并释放连接上的传输绑定。客户端收到 OK 后可正常发送 WS Close 1000。更换账号时建立新连接。

### 当前账号资料

登录或恢复会话后可调用 `USER_PROFILE` 获取当前用户名、角色、权限及配额。请求载荷为 0 字节，报头 `TransferID` 填全零，`ChunkIndex` 填 `FFFFFFFF`。身份由当前会话确定。服务端从 MariaDB 读取最新授权、已用字节数和未完成上传的预留字节数。普通用户和管理员均可查询自己的资料。未登录返回 `UNAUTH`，携带载荷或任务编号返回 `BAD_REQUEST`。

### 文件列表与共享

`LIST` 返回条目 `{fileId,name,size,owner,createdAt,sharedAt}`。`createdAt` 是文件通过校验并发布的时间。所有者在 `owned` 查询自己的文件，此时 `sharedAt` 为 `null`。`shared` 返回读权限有效且当前账号具备 `DOWNLOAD` 的文件，`sharedAt` 为本账号当前授权生效的时间。时间字符串采用 RFC 3339 UTC 格式。所有者具备 `SHARE` 时可针对指定用户授予或撤销读取权限。只有启用且具备 `DOWNLOAD` 的所有者或受让者可下载。管理员访问文件也按同一规则授权。只有所有者可删除文件，服务端立即隐藏文件，再由后台回收对象。

列表和管理员查询的首个 cursor 传 `null` 或省略。每页最多 20 条，同时受控制载荷大小限制。有下一页时客户端原样传回 `nextCursor`。游标关联当前用户、查询类型及条件，服务重启后从首页重新查询。

`OUTGOING_SHARES` 只返回当前会话账号发出的共享，条目为 `{fileId,name,grantee,action,createdAt,deleted}`。`active` 返回调用者拥有的未删除文件的当前授权条目，`action` 为 `grant`，`createdAt` 为授权时间。接收者实际下载时仍需通过账号和下载权限检查。`history` 按最新操作优先返回近 30 天的成功授权及撤销，`action` 为 `grant` 或 `revoke`。已删除文件的历史可显示 `deleted:true`。查询游标与当前账号和视图绑定。

`SHARE_SET` 接受单个账号名 `grantee`，或包含 1 到 20 个唯一账号名的 `grantees`。每次请求只指定一个文件，所有账号的授权或撤销在同一事务内生效，事务也逐个记录接收者的审计事件。账号不存在、向自己操作、授权给已停用账号或无权管理文件时返回 `DENIED`。批量共享多个文件时，前端逐文件发出请求，已成功文件立即生效，失败文件可单独重试。批量下载将文件逐一加入传输队列，批量删除逐文件调用 `FILE_DELETE`。

### 好友与备注

`FRIENDS` 按账号名返回当前用户的好友，条目为 `{userId,username,note,enabled}`。双方各自至少成功授予过对方一次文件读权限后，关系自动成立。关系记录独立于文件权限，撤销、删除文件和清理审计后仍保留。数据库迁移 2 从现有授权以及仍保留的成功授权审计中恢复历史记录。

`FRIEND_NOTE` 的 `friendId` 必须是当前账号的好友 ID。备注仅对保存它的账号可见。服务端去掉首尾空白，接收最多 80 个 Unicode 字符的单行文本，空字符串用于清除备注。变更仅更新当前账号对该好友的备注。

### 管理员接口

账号名长度为 1 至 64，匹配 `[a-z0-9][a-z0-9._-]{0,63}`。`ADMIN` 的账号写操作面向普通用户。权限数组可包含 `UPLOAD`、`DOWNLOAD`、`SHARE`，各项最多出现一次。

| `action` | 其他请求字段 | 响应与行为 |
| --- | --- | --- |
| `create` | `username` | 空 OK。新账号启用，初始权限为空，配额为 0 |
| `setAccess` | `username,enabled,permissions,quotaBytes` | 空 OK。配额为 0 到 2^50 字节整数，并须覆盖已用和预留字节。禁用账号时撤销其会话和待消费邀请 |
| `invite` | `username` | `{inviteToken}`。对启用账号签发 15 分钟有效的一次性邀请，并替换该账号以前尚未消费的邀请 |
| `revokeCredential` | `username,credentialId` | 空 OK。凭据 ID 为 base64url，同步撤销由该凭据建立的会话 |
| `users` | `cursor`，可选 `role` 和 `search` | `{items,nextCursor}`，条目为 `{userId,username,role,enabled,permissions,quotaBytes,usedBytes,reservedBytes,createdAt}`，`createdAt` 是 RFC 3339 UTC 格式的账号创建时间 |
| `credentials` | `username,cursor` | `{items,nextCursor}`，条目为 `{credentialId,createdAt,revokedAt}` |
| `audit` | `cursor` | `{items,nextCursor}`，条目为 `{id,actorId,action,targetId,result,createdAt,requestMeta}` |

审计 `id` 是十进制字符串，时间为 RFC 3339 UTC 字符串，缺省的撤销时间、操作者、目标和附加信息为 `null`。引导管理员的初始配额为 8 GiB。管理员可先用 `create` 创建用户，再用 `setAccess` 下发权限与配额，最后用 `invite` 签发登记邀请。

`users` 的 `role` 可选 `admin` 或 `user`。`role` 为 `user` 时可以用 `search` 按用户名中包含的文字搜索。搜索词去除首尾空格后按不区分大小写的方式匹配，最多 64 个 ASCII 字母、数字、点、下划线或连字符。更改角色或搜索词后，从空游标开始请求。

### 上传、确认与续传

1. 客户端计算文件大小和整文件 SHA-256，持久化本次新生成的 UUID `opId`，发送 `PUT_BEGIN`。同一账号重发相同 `opId` 与相同元信息会复用原任务。元信息冲突返回 `CONFLICT`。
2. 收到 `PUT_READY` 后保存报头中的上传 ID。单文件最大 512 MiB，分片固定为 256 KiB（262144 字节）。第 `i` 片偏移为 `i × 262144`，大小为文件剩余字节与 262144 的较小值。空文件直接提交。
3. 以 `PUT_DATA` 发送带块摘要的分片，Go 在文件持久化与 MariaDB 分片记录提交后回复 OK。确认丢失可用新 RequestID 重发同一索引，相同内容幂等确认。
4. 收齐分片确认后发 `PUT_COMMIT`。服务端按顺序合并、校验大小和 SHA-256，再发布并返回 `PUT_DONE`。成功回包丢失时可查状态或重复提交，结果复用原 fileId。
5. 暂停时先等待该文件在途请求结束，再发 `PUT_PAUSE`。掉线或暂停后，认证并核对本地原文件，再以原上传 ID 调用 `PUT_STATUS` 重新绑定。未取得上传 ID 时重新提交原 `PUT_BEGIN`。一条上传任务同时只绑定一条连接。

`PUT_STATE.state` 为 `OPEN`、`VERIFYING`、`READY`、`CANCELLED`、`EXPIRED` 或 `FAILED`。暂停仍为 `OPEN`。正常活动可延长 24 小时断点保留期。位图的字节数为 `ceil(分片数 / 8)`，分片 `i` 对应字节 `floor(i/8)` 的第 `i%8` 个低位。位值 1 表示已确认。举例，600 KiB 文件有 3 片，索引 0 和 2 已确认时位图是 `05`，无填充 base64url 为 `BQ`，只需补传索引 1。

### 下载与续传

1. 以 `GET_BEGIN` 获取清单，核对不可变 fileId、大小、分片尺寸和整文件摘要。
2. 用 `GET_CHUNK` 按索引请求缺失分片。收到 `GET_DATA` 后先校验分片摘要，再持久化数据和位图。前端向页面报告已持久化的字节进度。
3. 重连后再次 `GET_BEGIN` 并比对清单，补请求缺失或复验失败的索引。浏览器负责保存和恢复下载侧数据。Go 按最新权限读取分片，写入 WebSocket 之前再校验一次授权。
4. 全部块核验整文件大小和摘要后发 `GET_DONE`。完成回包丢失时重新 `GET_BEGIN` 后再提交 `GET_DONE`，服务端会合并同一用户和文件的完成记录。暂停时可发 `GET_CLOSE` 释放服务器绑定，保存的本地块仍可用于下次下载。

## 限额、错误与重试

Go 监听器启用 TCP keepalive。服务端每 25 秒发送 WS Ping，允许 10 秒 Pong 响应窗口，单次 WS 写超时 10 秒。新连接在 2 分钟内须完成首次认证。上传或下载完成后继续复用该连接。

- 连接限额为全局 128、每 IP 8、每认证账号 4。每账号最多 4 个活跃文件任务（上传和下载合计）及 8 个未完成上传任务。
- 每连接最多 8 个在途数据操作，每个任务最多 2 个。`PUT_COMMIT` 在该任务的数据确认后单独提交，后台最长处理 2 分钟。暂停、取消及下载完成也应等待同任务在途请求排空。
- 每分钟认证请求上限为每 IP 36 次，`AUTH_BEGIN` 另受每账号名 12 次限制。非认证控制请求每 IP 1200 次。数据分片操作每账号 2400 次、全局 19200 次每分钟。前端使用退避和抖动，并在浏览器发送缓冲积压时暂缓入队。

| `code` | 处理 |
| --- | --- |
| `BUSY`、`RATE_LIMIT` | 释放闲置任务或等当前在途请求结束，带抖动退避后新建 RequestID 重试 |
| `INCOMPLETE` | 查询 `PUT_STATUS`，补齐缺失块后重新提交 |
| `STORAGE_UNAVAILABLE` | 临时数据库、文件系统或磁盘容量问题。退避后先确认服务端任务状态 |
| `UNAUTH` | 当前登录、挑战或会话无效。重新开始 Passkey 流程或连接有效会话 |
| `DENIED` | 对象不存在、当前账号缺少权限或任务尚未绑定。检查权限与绑定状态 |
| `BAD_REQUEST`、`CONFLICT`、`HASH_MISMATCH` | 检查报文字段、上传元信息或摘要，修正后再发 |
| `QUOTA`、`EXPIRED` | 检查账号配额或建立新的上传任务 |

结构错误使用 WS 1002 关闭，包括坏报头、非二进制业务消息及重复或倒序的 RequestID。超出 WS 消息上限使用 1009。连接队列满时可能收到 `BUSY` 或 WS 1013。重连时重置 RequestID 计数，保留逻辑任务 ID。连接错误时按有上限的指数退避重试。

## 验证命令

在 `server` 执行 `go test ./...` 和 `go vet ./...`。数据库集成测试分别覆盖带真实 ES256 签名的认证、文件恢复，以及从 WebSocket 握手到续传和撤权的完整链路。各项测试会在指定库应用迁移并写入测试数据，请使用独立的临时库。连接 MariaDB 后执行下列命令。

```powershell
$env:SFT_AUTH_TEST_DSN = 'sft_test:密码@tcp(127.0.0.1:3306)/sft_auth_test'
$env:SFT_TRANSFER_TEST_DSN = 'sft_test:密码@tcp(127.0.0.1:3306)/sft_transfer_test'
$env:SFT_GATEWAY_TEST_DSN = 'sft_test:密码@tcp(127.0.0.1:3306)/sft_gateway_test'
go test -count=1 ./...
```

部署验收时用两名账号验证授权与撤权，在同一连接交错上传和下载多个文件，再断开连接验证续传。核对浏览器及服务端的整文件 SHA-256。将 `SFT_LOG_LEVEL` 暂时设为 `debug`，可在上传结束后检查相同连接 ID 是否继续收到 Pong。
