# Electron 开源开发指南

本文只覆盖 TabTin 桌面客户端。默认路径面向全球开发者，同时提供显式的中国大陆下载配置，而且不会修改开发者的全局 npm 配置。

## 社区开发快速开始

Windows 和 macOS 用户可以在仓库根目录直接双击启动：

- Windows：双击 `start-community-dev.bat`
- macOS：双击 `start-community-dev.command`

双击入口默认自动选择下载源。也可以在仓库根目录通过终端运行统一入口：

```bash
node scripts/dev.mjs community
```

该命令会执行必需的 Doctor 检查、按需安装 Electron 依赖、准备公开客户端环境、复用健康后端或启动后端、等待 Django、Collab Live 和 Centrifugo 健康，然后才启动 Electron。每个阶段都会打印耗时；只有 Electron 主窗口真正完成加载后才会显示“Electron 已就绪”。就绪前若发生构建失败、模块缺失、进程退出，命令会立即失败；首次冷启动最多等待 10 分钟。依赖已安装后，可使用等价别名 `pnpm dev:community`。

本地后端基础设施统一由 Docker Compose 管理。运行前请启动 Docker Desktop 或其他 Docker daemon。

中国大陆网络环境建议显式选择国内下载源，以减少首次启动时的源探测和下载波动：

```bash
node scripts/dev.mjs community --region cn
```

如需强制使用官方源（global）而不是自动选择区域：

```bash
node scripts/dev.mjs community --region global
```

如需只执行环境检查，不安装依赖、不启动后端，也不启动 Electron：

```bash
node scripts/dev.mjs community --doctor
```

如需不启动任何阶段、只打印完整编排计划：

```bash
node scripts/dev.mjs community --dry-run
```

若后端由你自行管理，此模式仍会检查健康状态，但不会启动或重启后端：

```bash
node scripts/dev.mjs community --skip-backend
```

### Windows 终端

Windows 用户可直接双击仓库根目录的 `start-community-dev.bat`，也可在 PowerShell、命令提示符（CMD）或 Git Bash 中运行同一条 `node scripts/dev.mjs community` 命令。该命令在 Windows 内部选择原生后端链路，无需 Bash 或 WSL。

### macOS 终端

macOS 用户可直接双击仓库根目录的 `start-community-dev.command`，也可在 Terminal 中运行统一 Node 命令。若系统提示文件不可执行，请先在仓库根目录运行 `chmod +x start-community-dev.command`；通过 Git clone 获取源码时会保留可执行权限。

## 高级用法与排障

- Node.js 18 或更高版本，以及 pnpm 9。
- 用于原生 Node 模块的 Python 3。
- 平台编译工具：Windows 安装 Visual Studio Build Tools 的 **Desktop development with C++**；macOS 安装 Xcode Command Line Tools；Linux 安装 `make` 和 C/C++ 编译器。

安装依赖前先检查本机工具链：

```bash
pnpm bootstrap:electron:doctor
```

doctor 会区分“下载源配置”和“原生编译环境”。镜像可以加速下载，但不能代替 Python、编译器、系统 SDK，也不会替你配置公司代理。

## 安装（Install）

全球配置使用 npm 官方 registry 和 Electron 正常的上游二进制来源：

```bash
pnpm bootstrap:electron
```

中国大陆开发者可以显式选择只对安装子进程生效的 npm、Electron、electron-builder 二进制和 Sentry CLI 镜像：

```bash
pnpm bootstrap:electron:cn
```

两条命令都使用同一份已提交的 `pnpm-lock.yaml` 和 `--frozen-lockfile`。国内配置不会执行 `npm config set`，不会修改用户级 `.npmrc`，命令退出后也不会保留镜像环境变量。

默认开发启动只准备 Python runtime，不会在冷启动下载约 283 MB 的 LibreOffice。需要 Office 高保真预览或准备打包资源时，再显式运行：

```bash
pnpm --dir apps/tabtin-electron runtimes:fetch -- --only office
```

Office runtime 默认根据系统时区与 locale 选择下载区域：中国大陆优先使用经过大小和 SHA-256 校验的预构建归档，其他区域优先使用 The Document Foundation 与 Poppler 官方源；首选源不可用时会自动回退。可通过 `TABTIN_RUNTIME_REGION=cn` 或 `TABTIN_RUNTIME_REGION=global` 强制选择。该变量只影响当前命令，无需写入 `.env`。

## 启动 Electron（Run Electron）

在仓库根目录启动桌面客户端：

```bash
pnpm --dir apps/tabtin-electron dev
```

渲染层改动通常会热更新。修改主进程、preload、IPC、原生模块或环境变量后，需要重启 Electron。依赖 API 的流程还需要兼容的后端地址；启动 Electron 不会自动启动后端。

## 构建配置（Build Profiles）

`production`、`preprod` 和 `local` 继续作为官方/内部构建配置；`community` 是开源发行配置：

- 必须提供 API、Collab WebSocket、Centrifugo WebSocket、公开 Web 四个公开端点。自建 TabChat 使用同一 API Origin 下的 Django `/api/im`，腾讯控制面会被关闭。它们共同构成社区包的完整信任边界，并在构建时写入安装包。
- 未设置 `TABTIN_COMMUNITY_UPDATE_FEED_URL` 时，自动更新默认关闭。
- 配置更新源时必须使用 HTTPS，地址会写入打包元数据；运行时环境变量不能替换或扩大信任范围。
- 社区构建默认跳过 TabTin 官方 sourcemap 上传和公证服务。

Linux/macOS shell 示例（不启用自动更新）：

```bash
export TABTIN_COMMUNITY_API_BASE_URL=https://api.example.org/api
export TABTIN_COMMUNITY_COLLAB_WS_BASE=wss://api.example.org/collab
export TABTIN_COMMUNITY_CENTRIFUGO_WS_URL=wss://api.example.org/connection/websocket
export TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL=https://web.example.org
pnpm --dir apps/tabtin-electron build:linux:community
```

PowerShell 示例（使用社区自行维护的更新源）：

```powershell
$env:TABTIN_COMMUNITY_API_BASE_URL = "https://api.example.org/api"
$env:TABTIN_COMMUNITY_COLLAB_WS_BASE = "wss://api.example.org/collab"
$env:TABTIN_COMMUNITY_CENTRIFUGO_WS_URL = "wss://api.example.org/connection/websocket"
$env:TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL = "https://web.example.org"
$env:TABTIN_COMMUNITY_UPDATE_FEED_URL = "https://downloads.example.org/desktop"
pnpm --dir apps/tabtin-electron build:win:community
```

## 原生模块排障（Native Module Troubleshooting）

Electron 安装期间会重新编译 `node-pty`。如果全部下载已经完成后安装仍失败，通常是原生工具链问题，而不是 registry 问题：

- Windows：安装 Python 和 Visual Studio Build Tools，并勾选 C++ 桌面工作负载。
- macOS：安装 Python；缺少 Command Line Tools 时运行 `xcode-select --install`。
- Linux：安装 Python、`make`、C/C++ 编译器，以及发行版要求的开发头文件。

排查镜像选择时可以使用 `--dry-run`，它不会修改 `node_modules`：

```bash
node scripts/electron/install-dependencies.mjs --region cn --dry-run
```

## 安全模型（Security Model）

- `VITE_*` 值（包括 `VITE_SENTRY_DSN` 和 SDK 应用 ID）属于公开客户端配置，不是服务端秘密。
- `SOURCEMAP_UPLOAD_KEY`、`SENTRY_AUTH_TOKEN`、代码签名密钥和签名 PIN 只能通过打包进程环境注入，不得写入任何已提交的 `.env` 文件。
- 安装包审计会阻止 env 文件、私钥材料和上传 token 形态进入产物，同时不会打印秘密值。
- 社区包只接受构建时声明的四个公开服务端点；Django IM 复用该 API Origin，云元数据端点和 URL 内嵌账号密码仍会被拒绝。

共享改动前运行 Electron 开源审计：

```bash
pnpm --dir apps/tabtin-electron audit:opensource
```

## 不会启动的内容（What This Does Not Start）

一键入口会按需调用项目已有的后端启动脚本，但不会实现或改造后端启动逻辑。它不会启动 TabTin Daemon、AdminDash、iOS 或 Android，也不会创建公开仓库、改写 Git 历史、决定项目级许可证或治理根 `.env`。这些属于 Electron 工作流以外、由其他负责人处理的项目级开源事项。
