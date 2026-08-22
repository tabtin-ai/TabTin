# 本地开发与桌面打包

[English](getting-started.en.md)

这是一份从源码运行 TabTin 的简明指南。所有命令都在仓库根目录执行。

## 1. 准备环境

请先安装：

- [Node.js](https://nodejs.org/en/download) 18 或更高版本（建议使用当前 LTS 版本）
- [pnpm](https://pnpm.io/installation) 9.15.0
- [Python 3](https://www.python.org/downloads/)
- [Go](https://go.dev/dl/)
- [Docker Desktop](https://docs.docker.com/desktop/)（Windows 或 macOS）或 [Docker Engine](https://docs.docker.com/engine/install/)（Linux），并启动 Docker
- [Git](https://git-scm.com/downloads)

不确定是否安装完整也没关系，下一步会自动检查。

## 2. 检查环境

先启动 Docker：

- **Windows 或 macOS**：从开始菜单或“应用程序”中打开 Docker Desktop，等待界面显示 Docker 已运行。
- **Linux**：运行 `sudo systemctl start docker`。

然后运行环境检查：

```bash
node scripts/dev.mjs community --doctor
```

必需项目都显示 `PASS` 后继续。该检查也会确认 Docker 是否可以连接；如需单独检查，可以运行 `docker info`。

## 3. 创建本地验证码配置

首次启动前，若根目录没有 `.env.local`，复制已提交的本地示例：

```bash
cp apps/tabtin_django/.env.local.example .env.local
```

该示例仅限本机回环地址，并默认使用验证码 `888888`，不会发送真实短信或邮件。已有 `.env.local` 时不要覆盖它；按需合并这两项公开开发配置。

## 4. 启动 TabTin

运行：

```bash
node scripts/dev.mjs community
```

首次启动会自动安装依赖、启动本地后端并构建 Electron，可能需要几分钟。看到下面的信息，并且桌面窗口已经打开，就表示启动成功：

```text
[community-dev] Electron 已就绪
```

在运行命令的终端按 `Ctrl+C` 可以关闭 Electron。

中国大陆网络可以改用国内下载配置：

```bash
node scripts/dev.mjs community --region cn
```

启动器生成的本地配置位于 `apps/tabtin-electron/.env.opensource.local`。该文件不会被 Git 提交，请不要在其中保存服务端密钥。

## 5. 打包桌面客户端

社区包需要四个公开服务地址：

| 变量 | 示例 |
| --- | --- |
| `TABTIN_COMMUNITY_API_BASE_URL` | `https://api.example.org/api` |
| `TABTIN_COMMUNITY_COLLAB_WS_BASE` | `wss://api.example.org/collab` |
| `TABTIN_COMMUNITY_CENTRIFUGO_WS_URL` | `wss://api.example.org/connection/websocket` |
| `TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL` | `https://web.example.org` |

这些地址会写入客户端安装包，不能包含账号、密码或其他凭据。

### macOS 或 Linux

```bash
export TABTIN_COMMUNITY_API_BASE_URL=https://api.example.org/api
export TABTIN_COMMUNITY_COLLAB_WS_BASE=wss://api.example.org/collab
export TABTIN_COMMUNITY_CENTRIFUGO_WS_URL=wss://api.example.org/connection/websocket
export TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL=https://web.example.org

# macOS 运行这一条
pnpm --dir apps/tabtin-electron build:mac:community

# Linux 运行这一条
pnpm --dir apps/tabtin-electron build:linux:community
```

### Windows PowerShell

```powershell
$env:TABTIN_COMMUNITY_API_BASE_URL = "https://api.example.org/api"
$env:TABTIN_COMMUNITY_COLLAB_WS_BASE = "wss://api.example.org/collab"
$env:TABTIN_COMMUNITY_CENTRIFUGO_WS_URL = "wss://api.example.org/connection/websocket"
$env:TABTIN_COMMUNITY_PUBLIC_WEB_BASE_URL = "https://web.example.org"

pnpm --dir apps/tabtin-electron build:win:community
```

构建成功后，安装包位于：

```text
apps/tabtin-electron/dist-app/
```

## 遇到问题

- **环境检查失败**：根据失败项目安装对应工具，再次运行 `--doctor`。
- **`build-tools` 检查失败**：Windows 安装 [Visual Studio Build Tools](https://visualstudio.microsoft.com/downloads/) 的 **Desktop development with C++**；macOS 按 [Apple 官方说明](https://developer.apple.com/documentation/xcode/installing-the-command-line-tools)运行 `xcode-select --install`；Linux 通过发行版的软件包管理器安装 [GNU Make](https://www.gnu.org/software/make/) 和 C++ 编译器（例如 [GCC](https://gcc.gnu.org/)）。Windows 打包还需要 [Git for Windows](https://git-scm.com/downloads/win)。
- **`docker info` 无法连接**：先启动 [Docker Desktop](https://docs.docker.com/desktop/) 或 [Linux Docker Engine](https://docs.docker.com/engine/install/)，再重新检查。
- **后端无法启动**：查看终端中最先出现的错误。
- **依赖安装失败**：检查 Python 3 和当前系统的编译工具。
- **Electron 没有显示“已就绪”**：检查终端中是否有构建失败、模块缺失或端口占用。
- **打包审计失败**：不要跳过审计或分发失败产物，应修正配置后重新构建。

更多参数、手动安装和原生模块排障见 [Electron 开源开发指南](../../apps/tabtin-electron/docs/open-source-development.zh-CN.md)。

## 使用 AI 操作

可以把本文交给 AI 执行，但应要求它：

1. 先运行 `--doctor`，通过后再启动或打包。
2. 首次启动时，若 `.env.local` 不存在，复制 `apps/tabtin_django/.env.local.example` 到根目录；不得覆盖或提交已有本地配置。
3. 不修改全局 npm 配置，不重新生成锁文件。
4. 不绕过健康检查或打包审计。
