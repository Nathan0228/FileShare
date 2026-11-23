# FileShare 文件共享平台

可以做你的文件多设备共享平台，也可以为好友分配账户进行更加方便的分享。

# 如何本地部署

- 首先使用Docker进行容器化部署/server目录下的文件，创建.env文件，添加compose.local.yaml中所需要用到的密码等环境变量。

```
cd ../server
docker compose -f compose.local.yaml up --build -d
```
构建成功后，你会看到两个容器已经启动，分别是数据库`maraiadb`和`app`。

接着再创建管理员邀请令牌，执行命令，

```
docker compose -f compose.local.yaml run --rm app bootstrap --username admin
```

其中你可以更改管理员用户名`admin`。

后端启动完成。

- 前端在web文件下进行
```
cd ../web
npm run build
```
在浏览器打开网址https://localhost:5173使用在后端中创建的邀请令牌进行注册，然后使用用户名和Pass Key进行登录。

# 网络部署

- 后端采用GO服务部署到VPS中，可参考compose.yaml和Dockerfile部署文件进行创建.env文件并添加相应的环境变量。
- 前端部署到Cloudflare的Pages服务中。

具体部署可参考/server和/web目录下的README.md文件。

# 相关链接

欢迎访问并使用FileShare，在线网址[FileShare](https://fs.findingai.top)

如果你需要开通账户进行体验，请联系我[email](mailto:chenmoliang2022@outlook.com)

个人博客网址底部亦有联系方式：[EasyQ](https://easyq.findingai.top)

后续仍会持续更新，更新脉络将同步[EasyQ](https://easyq.findingai.top).