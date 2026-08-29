# TabTin Community Open Source Guide

TabTin Community 面向希望在自己电脑上运行 TabTin Server、连接桌面客户端并使用自有模型服务的用户。默认安装只监听本机地址，模型费用由你配置的 BYOK Provider 直接结算。

## Quick Start (Windows)

1. **Install Docker Desktop**
   从 [Docker Desktop 官方网站](https://www.docker.com/products/docker-desktop/) 下载并启动 Docker Desktop。
2. **Download TabTin source**
   使用 Git clone，或在 GitHub 选择 Download ZIP 并解压到本机目录。
3. 双击源码根目录中的 **`start.bat`**。首次启动需要构建镜像，请等待窗口显示 `TabTin Community is READY`。
4. 启动 **TabTin Desktop Client**。
5. 完成 **Register / Login**。
6. 打开 **Settings → Model Configuration → BYOK**，添加 OpenAI-compatible Provider 与模型。
7. 返回 Agent 对话并 **Start Chat**。

首次启动会在根目录缺少 `.env` 时自动从 `.env.example` 创建它。服务端 Edition 统一由该文件中的 `TABTIN_EDITION` 控制，启动脚本和容器不再另外写死；默认模板为 `TABTIN_EDITION=community`。手机号注册/登录固定提示码由 `AUTH_FIXED_VERIFICATION_CODE` 单独控制，留空即关闭，不再由 Edition 隐式启用。

## 日常使用

- `start.bat`：启动或恢复 TabTin Community，并等待服务就绪。
- `status.bat`：查看 Docker、TabTin Server 与 Centrifugo 状态。
- `stop.bat`：停止本项目服务，默认保留账号、Workspace、BYOK 配置、聊天历史和本地文件。

macOS 用户可以直接双击：

- `start.command`：启动并等待 READY。
- `status.command`：查看 Server 与 Realtime 状态。
- `stop.command`：停止服务并保留数据。

macOS / Linux 终端用户可运行：

```bash
./start.sh
./status.sh
./stop.sh
```

这些入口都从脚本自身位置定位源码目录，因此可以从其他工作目录启动，也支持源码路径包含空格。`./community start|logs|stop` 继续作为日志查看与兼容入口。

服务端地址固定为 `http://127.0.0.1:6060`。首次登录后，即使尚未配置模型，TabTin Server 与桌面客户端仍可正常使用；聊天会提示 AI NOT CONFIGURED，完成 BYOK 配置后即可发送消息。

## Electron 人工验收

- [ ] Electron Community 客户端能启动
- [ ] API 指向 `127.0.0.1:6060`
- [ ] 无公司 API fallback
- [ ] 注册 / 登录成功
- [ ] Workspace 正常
- [ ] Settings → Model Configuration → BYOK 页面正常
- [ ] 配置模型成功
- [ ] 发出对话成功
- [ ] Assistant 返回正常
- [ ] 未连接公司 IM、Sentry 或 updater
