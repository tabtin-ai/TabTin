# 本地开发与 Debug 构建

[English](getting-started.en.md)

这是一份从源码运行 TabTin 的执行指南。除非另有说明，命令均从仓库根目录执行。

## 两条启动路线

| 路线 | 适用场景 |
| --- | --- |
| Agent 启动 | Agent 安装环境后，按需求选择快速预览或全量预览 |
| 手动启动 | 自己准备环境，并按需运行底层启动命令或单个服务 |

快速预览和全量预览是 Agent 启动时的两种模式，不是额外的启动路线。快速预览适合尽快体验桌面端；全量预览适合完整跨端联调。两者都是本地开发入口，不等同于 Community 分发包或正式 Release 构建。

## 方式一：Agent 启动

把 [Community 开发 Agent 提示词](community-dev-agent-prompt.md) 和本指南交给 Agent。Agent 必须先检查操作系统、CPU 架构以及 Node.js、pnpm、Python、Go、Git、Docker 和当前平台构建工具。缺失依赖时，只能使用系统包管理器或软件官方渠道安装；不得使用来源不明的安装包、第三方脚本或未经核验的镜像。

| 检测结果 | Agent 动作 | 何时暂停 |
| --- | --- | --- |
| 依赖已安装 | 检查版本、架构和 PATH 后继续 | 版本不符合项目要求时先处理 |
| 依赖缺失但可自动安装 | 通过系统包管理器或官方安装器安装，然后重新检查 | 安装失败时报告错误 |
| 需要管理员权限 | 尝试执行提权命令 | 系统拒绝授权时暂停 |
| macOS 安全确认、Docker 首次启动或许可证确认 | 明确写出需要确认的应用、权限或按钮 | 用户确认后从当前步骤继续 |
| Docker 已安装但未运行 | 自动启动 Docker Desktop 或 Docker Engine | 启动被系统拦截或失败时暂停 |
| Docker daemon 未就绪 | 在有上限的循环中重复执行 `docker info` | 到达上限时报告最后错误 |

Agent 不得覆盖已有本地配置、修改全局 npm registry、绕过健康检查或把未生成的产物报告为成功。只有系统权限、Docker 首次启动、安全确认和许可证确认必须由用户完成时，才暂停请求用户操作。

环境准备完成后，告诉 Agent 运行以下提示词之一：

```text
请运行 https://github.com/tabtin-ai/TabTin 的「快速预览」
```

快速预览启动服务端和 Electron 桌面客户端，适合尽快体验桌面端，不启动 AdminDash 运管后台和 tabtin-web 在线平台。

```text
请运行 https://github.com/tabtin-ai/TabTin 的「全量预览」
```

全量预览启动服务端、AdminDash 运管后台、tabtin-web 在线平台和 Electron 桌面客户端，并覆盖桌面、Android、iOS Debug 包的验收入口。Android 和 iOS 包需要在对应平台单独构建，不会由全量预览命令自动启动。

### 全量预览的默认服务端地址

当用户没有明确指定服务端 IP 时，Agent 必须先探测运行 TabTin 服务端这台电脑当前可用的局域网 IPv4 地址，并将它作为三端打包的默认服务端地址；不得把 `localhost` 或 `127.0.0.1` 写入需要被其他设备访问的包中。用户明确指定服务端 IP 时，以用户指定值为准。

使用同一个 `<LAN_IP>` 配置桌面端、Android 和 iOS：

- **桌面端**：在根目录 `.env.local` 中将 `TABTIN_API_BASE_URL` / `VITE_API_BASE_URL` 设为 `http://<LAN_IP>:6060/api`，将 `VITE_COLLAB_WS_BASE`、`VITE_CENTRIFUGO_WS_URL` 和 `VITE_PUBLIC_WEB_BASE_URL` 分别设为 `ws://<LAN_IP>:4100`、`ws://<LAN_IP>:8100/connection/websocket` 和 `http://<LAN_IP>:5176`，然后再执行全量预览或桌面 Debug 构建。
- **Android**：构建 Debug APK 时传入 `-PDEV_HOST=<LAN_IP> -PDEV_PORT=6060 -PDEV_WEB_BASE_URL=http://<LAN_IP>:5176`。真机必须与服务端电脑在同一局域网；只有 Android Emulator 未使用局域网地址时，才使用其宿主机映射地址 `10.0.2.2`。
- **iOS**：使用桌面端生成的环境二维码导入上述局域网地址后，再构建或安装 Debug 包；不要填写 `localhost`。

Agent 还必须确认服务端监听地址和操作系统防火墙允许局域网设备访问 `6060`、`4100`、`8100` 和 `5176`，并在报告中记录实际使用的 `<LAN_IP>`。如果无法探测到可用局域网 IPv4 或端口无法从设备访问，应暂停并报告原因，不得静默回退到回环地址或线上服务。

## 方式二：手动启动

手动启动不需要使用“快速预览”或“全量预览”的提示词。完成下面的环境和配置准备后，直接运行需要的底层命令；如果需要完整联调链路，可运行 `pnpm dev`。

### 1. 准备依赖

读取根目录 `package.json` 的 `engines.node` 和 `packageManager`，不要凭记忆指定版本。当前项目要求 Node.js `>=18.0.0`，并声明 pnpm `9.15.0`：

```bash
node --version
corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm --version
```

还需要 Python、Go、Git、Docker，以及当前平台的 Electron 构建工具。macOS 优先使用 Homebrew 和 Apple 官方渠道；Windows 优先使用 `winget` 和厂商官方渠道，打包需要 Visual Studio Build Tools 的 **Desktop development with C++**；Linux 使用发行版官方包管理器。Docker 只能从 [Docker 官方渠道](https://docs.docker.com/get-docker/) 安装。

Docker 安装后确认 daemon 已就绪：

```bash
docker info
```

### 2. 创建本地配置

只复制不存在的文件，不覆盖已有配置：

```bash
test -f .env || cp .env.example .env
```

`.env` 保存本机基础配置；个人覆盖放在根目录 `.env.local`。两个文件都不得提交。按需填写数据库、Redis、LLM、Sentry、短信、IM 和支付配置；未配置的第三方能力默认关闭或拒绝启动，不会自动回退到线上环境。

首次启动前建议执行：

```bash
node scripts/dev.mjs community --doctor
pnpm install --frozen-lockfile
```

### 3. 启动桌面开发链路

```bash
node scripts/dev.mjs community
```

它会检查并准备 Community 开发环境，启动或复用本地后端，等待 Django、Collab 和 Centrifugo 健康后启动 Electron。成功条件是终端报告 Electron 已就绪且桌面窗口打开；仅有进程或端口不能算成功。长驻进程在当前终端前台运行，按 `Ctrl+C` 停止。

中国大陆网络环境可显式选择下载源：

```bash
node scripts/dev.mjs community --region cn
```

### 4. 启动完整联调链路

```bash
pnpm dev
```

完整联调链路会按以下顺序工作：

1. 启动本地后端及其依赖，并等待 Django/API、Collab、Centrifugo 健康；
2. 使用本地配置完成一次 Electron local 构建；
3. 启动 AdminDash；
4. 启动 tabtin-web；
5. 启动 Electron。

所有子进程由当前命令管理，按 `Ctrl+C` 停止。健康检查、Electron 构建或任一客户端启动失败时，流程必须停止并报告首个错误。个人 `.env.local` 会同时用于本地启动和全量预览的 Electron 构建。

如需单独调试某个服务，可使用：

```bash
node scripts/dev.mjs backend
node scripts/dev.mjs admindash
node scripts/dev.mjs tabtin-web
node scripts/dev.mjs electron
```

这些单独入口不会代替全量预览的完整健康检查和启动顺序。

## Community 桌面包

Community 包需要四个公开服务地址，不能包含账号、密码或其他凭据：

```bash
export TABTIN_COMMUNITY_API_BASE_URL=https://api.example.org/api
export TABTIN_COMMUNITY_COLLAB_WS_BASE=wss://api.example.org/collab
export TABTIN_COMMUNITY_CENTRIFUGO_WS_URL=wss://api.example.org/connection/websocket
export TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL=https://web.example.org
```

macOS/Linux 执行 `pnpm --dir apps/tabtin-electron build:mac:community` 或 `build:linux:community`；Windows PowerShell 设置同名 `$env:` 变量后执行 `build:win:community`。安装包应出现在 `apps/tabtin-electron/dist-app/`。这是 Community 分发流程，不是下方 Debug 构建的验收证据。

## Debug 构建验收

只有实际生成 Debug 产物后才能报告成功；开发进程、默认 Release 构建或仅有 `win-unpacked` 目录都不能替代 Debug 产物。

- **macOS/Linux Electron**：执行 `pnpm --dir apps/tabtin-electron build:mac:local` 或 `build:linux:local`，确认 `dist-app/` 中存在对应平台产物。
- **Android**：在 `apps/tabtin-android` 执行 `./gradlew :app:assembleDebug`（Windows 执行 `./gradlew.bat :app:assembleDebug`），确认 `app/build/outputs/apk/debug/` 中有 APK。
- **macOS iOS Simulator**：安装 Xcode 后执行 Debug `xcodebuild`，确认 `dist/ios-debug/Build/Products/Debug-iphonesimulator/Tabtin.app` 存在。
- **Windows/Linux iOS**：跳过并报告需要 macOS 与 Xcode，这是平台限制。

构建超时或失败时，报告具体错误、已完成步骤和实际生成的产物，不要用 Release 产物替代 Debug 产物。
