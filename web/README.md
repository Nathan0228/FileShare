# FileShare 前端

## 本地开发

从 `web` 目录安装依赖和启动 Vite。

```sh
npm ci
npm run dev
```

默认连接 `ws://127.0.0.1:8080/sft`。启动 Go 后端后，用 `http://localhost:5173` 打开页面，让页面 Origin 和 WebAuthn RP ID 与后端默认值一致。后端的数据库迁移、首个管理员邀请码和消息格式见 [READAPI.md](../server/READAPI.md)。

如需使用其他地址，将 `.env.example` 复制到 `.env.local` 并设置 `VITE_SFT_WS_URL`。客户端构建变量是公开信息，邀请码通过登录页面输入。

## 代码目录

- `src/app` 包含路由、登录和管理员路由守卫、工作区布局。
- `src/components` 包含共享 UI，包括按钮、表单、反馈提示、原生对话框和图标入口。
- `src/features` 按认证、文件、传输、管理员和通知组织。
- `src/services` 实现二进制 SFT/1 报文、长连接、会话和 Passkey。
- `src/styles` 管理 Tailwind 主题和通用样式。SVG 统一放在 `public/assets/svg`，页面通过 `/assets/svg/` 引用。

## 构建和 Cloudflare Pages

```sh
npm run lint
npm run build
```

Pages 的项目根目录设为 `web`，构建命令为 `npm run build`，产物目录为 `dist`。默认生产端点为 `wss://fs-api.findingai.top/sft`。自定义部署可设置 `VITE_SFT_WS_URL`，生产端点须使用 WSS，并在后端填写准确的 `SFT_ORIGIN` 和 `SFT_RP_ID`。React Router 处理前端 404，保留 Pages 的 [SPA 路由回退](https://developers.cloudflare.com/pages/configuration/serving-pages/#single-page-application-spa-rendering)。

Passkey 需要支持 WebAuthn 的浏览器和安全上下文。传输断点按照后端端点和账号保存在 IndexedDB，会话令牌仅保存在内存。上传跨刷新续传时，界面会要求重新选择并校验原文件。下载先校验完整文件，再提供保存操作。
