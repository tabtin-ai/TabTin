# TabTin Community 快速开始

本指南合并自 Windows 与 macOS 社区安装指引，面向第一次接触 TabTin 的普通用户和开发者。

> 目标：安装 Docker → 启动 TabTin Community Server → 启动 Desktop Client → 配置自己的模型 → 开始第一次对话。
>
> 当前公开仓库地址：`https://github.com/tabtin-ai/TabTin`。文中的示例地址和 API Key 均为公开占位值，请替换为自己的配置。

## 一、最短版本

### Windows

1. 安装并启动 Docker Desktop。
2. 下载并解压 TabTin Community。
3. 双击 `start.bat`。
4. 等待显示 `TabTin Community READY`。
5. 启动 TabTin Desktop Client。
6. 注册或登录。
7. 进入“设置 → 模型配置 → BYOK”。
8. 添加自己的模型并开始聊天。

开发者可以在项目根目录执行 `start.bat`；底层统一使用根目录 `compose.yaml`。

### macOS

1. 安装并启动 Docker Desktop。
2. 下载并解压 TabTin Community。
3. 双击 `start.command`。
4. 等待显示 `TabTin Community READY`。
5. 启动 TabTin Desktop Client。
6. 注册或登录。
7. 进入“设置 → 模型配置 → BYOK”。
8. 添加自己的模型并开始聊天。

开发者可以在项目根目录执行 `./start.sh`；底层统一使用根目录 `compose.yaml`。

## 二、安装 Docker Desktop

TabTin Community Server 运行在 Docker 中。用户不需要单独安装 PostgreSQL、Redis、Python、Celery 或 Centrifugo，这些服务由 TabTin 的 Community 环境启动。

下载：[Docker Desktop](https://www.docker.com/products/docker-desktop/)

### Windows

支持 Windows 10 / 11。安装并启动 Docker Desktop，等待 Docker Engine 显示正在运行。

可选检查（CMD 或 PowerShell）：

```powershell
docker --version
docker compose version
```

### macOS

Docker Desktop 同时支持 Apple Silicon（M1/M2/M3/M4 等）和 Intel Mac，请按官网提示选择对应版本。安装完成后打开 Docker Desktop，等待 Docker Engine 启动完成。

可选检查（Terminal）：

```bash
docker --version
docker compose version
```

## 三、下载 Community 并确认根目录

普通用户可以打开仓库页面，选择 **Code → Download ZIP**，下载后解压。开发者可以使用：

```bash
git clone https://github.com/tabtin-ai/TabTin.git
cd TabTin
```

进入根目录后，应能看到 `README.md`、`compose.yaml`、启动/停止/状态脚本和 `apps/` 目录。普通用户只需要关心当前系统对应的启动、停止和状态脚本：

| Windows | macOS |
| --- | --- |
| `start.bat` | `start.command` |
| `stop.bat` | `stop.command` |
| `status.bat` | `status.command` |

不需要先理解 PostgreSQL、Redis、Migration、Celery 或 Centrifugo 的内部实现。

## 四、启动 TabTin Community Server

### Windows

确认 Docker Desktop 已启动后，双击 `start.bat`，或在 CMD/PowerShell 中执行：

```powershell
start.bat
```

### macOS

确认 Docker Desktop 已启动后，双击 `start.command`。如果 macOS 第一次阻止执行，右键文件并选择“打开”，再确认“打开”。开发者也可以在 Terminal 中执行：

```bash
./start.sh
```

如果首次提示没有执行权限：

```bash
chmod +x start.sh stop.sh status.sh
./start.sh
```

## 五、启动脚本会自动完成什么

普通用户不需要手动处理以下步骤：

1. 检查 Docker 和 Docker Compose。
2. 检查 Community 服务。
3. 准备安装级 Secret。
4. 启动 PostgreSQL 和 Redis。
5. 执行数据库 Migration。
6. 执行 Community Bootstrap。
7. 启动 Django、Celery 和 Centrifugo。
8. 执行健康检查并显示 READY。

不需要手动运行 `docker compose`、`migrate`、`bootstrap`、`seed_scene_bindings`，也不需要手动配置 PostgreSQL、Redis、Celery 或 Centrifugo。

正常启动后会看到类似提示：

```text
========================================
TabTin Community is READY
========================================
Backend:
http://127.0.0.1:6060
Realtime:
ws://127.0.0.1:8100
Next:
1. Start TabTin Desktop Client
2. Register or Login
3. Settings → Model Configuration → BYOK
4. Start chatting
========================================
```

## 六、检查 Server 状态

普通用户：

- Windows：双击 `status.bat`。
- macOS：双击 `status.command`。

开发者也可以执行：

```bash
# macOS
./status.sh

# Windows 或 macOS
docker compose ps
```

正常情况下，Community 长期运行的服务包括 `postgres`、`redis`、`django`、`celery` 和 `centrifugo`。

如果需要确认 Backend 已 Ready，可在浏览器打开：

```text
http://127.0.0.1:6060/health/ready
```

Community 默认本地端点：

```text
API:        http://127.0.0.1:6060
Centrifugo: ws://127.0.0.1:8100/connection/websocket
```

普通用户不需要手动配置这些地址。

## 七、启动 TabTin Desktop Client

Server 显示 READY 后，启动桌面客户端：

- Windows：启动 `TabTin Community.exe` 或已安装的 TabTin Community。
- macOS：启动 `TabTin Community.app`。如果是首次打开从网络下载的应用，右键应用并选择“打开”，按系统提示确认来源。

Community Desktop 应自动连接本地 API `127.0.0.1:6060` 和实时服务 `127.0.0.1:8100`，用户不需要填写服务器地址。

## 八、注册、登录与 BYOK

第一次打开客户端时选择注册或登录。注册完成后，Community 环境会在本地准备 User、Organization、Workspace、Agent 和 Device；已有账号直接登录即可。

首次进入后看到 `SYSTEM: READY`、`AI: NOT CONFIGURED` 是正常状态。这不代表安装失败。Community 不会自动创建官方模型、官方 API Key、免费模型额度、Wallet、Payment 或 Official Credit，需要使用自己的模型 API。

进入桌面端：

1. 打开“设置”。
2. 进入“模型配置”。
3. 选择 BYOK（自带模型）。
4. 填写 Provider、Model Name、Base URL 和 API Key。
5. 保存后返回 Chat / Agent。

示例（公开占位值）：

```text
Base URL: https://api.example.org/v1
API Key:  <your-api-key>
Model:    <your-model-name>
```

![登录界面参考图](assets/community-installation/login.png)

![模型配置与 BYOK 入口参考图](assets/community-installation/model-config.png)

按下面四步完成接入。图中红字为操作提示：

1. 在「接入订阅套餐」里选择平台；若使用中转站或文档未列出的平台，再改 API Base URL；填写 API Key 后点「一键接入」。
2. 平台接入后，在「已接入的平台」里点「+ 在此渠道添加模型」。
3. 把供应商提供的模型 ID 填进「模型名称」，点「添加模型」。
4. 点「测试连接」，出现「连通正常」即完成。

![接入订阅套餐：选择平台、填写 API Base URL 和 API Key](assets/community-installation/byok-subscribe-plan.png)

![已接入平台后，在该渠道添加模型](assets/community-installation/byok-add-model-entry.png)

![添加模型：填写供应商模型 ID 后点击添加](assets/community-installation/byok-add-model-dialog.png)

![测试连接，显示「连通正常」即完成](assets/community-installation/byok-test-connection.png)

## 九、第一次对话

进入 Chat / Agent，输入“你好”。正常链路是：

```text
TabTin Desktop
    ↓
TabTin Community Server
    ↓
你的 BYOK Provider
    ↓
你的 AI Model
    ↓
Agent
    ↓
Assistant Response
```

如果 Assistant 正常返回内容，说明 Community 基础安装和模型配置已经成功。

![工作区与 Agent 参考图](assets/community-installation/workspace.png)

## 十、以后如何启动与停止

以后再次使用：

1. 启动 Docker Desktop。
2. 等待 Docker Engine Running。
3. Windows 双击 `start.bat`，macOS 双击 `start.command`。
4. 启动 TabTin Desktop Client。

默认数据会继续保留。

停止服务不会删除用户数据：

- Windows：双击 `stop.bat`。
- macOS：双击 `stop.command`，或在 Terminal 中执行 `./stop.sh`。
- 开发者也可以执行 `docker compose stop`。

## 十一、不要使用这些危险命令

如果只是正常停止 TabTin，不要执行：

```bash
docker compose down -v
docker volume prune
docker system prune --volumes
```

这些操作可能删除用户 Workspace、Agent、模型配置、聊天历史和 Local Storage 文件。

## 十二、常见问题

### 双击启动后提示 Docker 不可用

确认 Docker Desktop 已启动，等待 Docker Engine Running，然后执行：

```bash
docker info
```

如果仍然失败，重新启动 Docker Desktop 后再启动 TabTin。

### 第一次启动很慢

第一次启动可能需要构建 Django 镜像、下载依赖、创建数据库、执行 Migration 和 Bootstrap。只要终端仍持续输出正常进度，就不要强制关闭。

### Windows 端口 6060 或 8100 被占用

```powershell
netstat -ano | findstr :6060
netstat -ano | findstr :8100
```

停止占用端口的其他程序后再启动 TabTin。

### macOS 端口 6060 或 8100 被占用

```bash
lsof -i :6060
lsof -i :8100
```

停止占用端口的其他程序后再启动 TabTin。

### Server READY，但不能聊天

检查“设置 → 模型配置 → BYOK”。如果没有配置模型，显示 `AI NOT CONFIGURED` 属于正常状态。

### 模型配置后仍然失败

依次检查 Base URL、API Key、Model Name 是否正确，电脑能否访问模型服务，以及所选模型是否支持当前 Agent 所需能力。不要把 API Key 提交到 Git。

## 十三、安装成功标准

完成下面整条链路，就说明 Community 已安装成功：

```text
安装 Docker Desktop
    ↓
Docker Engine Running
    ↓
下载并解压 TabTin
    ↓
启动 start.bat / start.command
    ↓
TabTin Community READY
    ↓
启动 Desktop Client
    ↓
注册 / 登录
    ↓
进入 Workspace / Agent
    ↓
设置 → 模型配置 → BYOK
    ↓
添加自己的模型
    ↓
发送“你好”
    ↓
Assistant 正常返回
```

给普通用户的最终记忆方式：

```text
Docker Desktop → start.bat / start.command → TabTin Desktop → BYOK → Chat
```
