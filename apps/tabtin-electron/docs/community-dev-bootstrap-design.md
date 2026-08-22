# 社区版 Electron 一键开发启动设计

## 状态

- 日期：2026-08-20
- 目标分支：`opensource/v1`
- 状态：方案已确认，等待设计文档复核

## 背景

社区开发者从干净克隆到看到 TabTin Electron 窗口，当前需要分别理解工具链检查、国内或海外依赖源、根环境变量、后端服务启动、健康检查和 Electron 启动。仓库已经具备这些局部能力，但入口分散：

- `scripts/electron/install-dependencies.mjs` 支持官方源和中国大陆镜像。
- `scripts/electron/dev.mjs` 提供跨平台 Electron dev 启动。
- macOS/Linux 使用 `scripts/backend/start.sh` 启动本地后端。
- Windows 使用 `scripts/backend/start.bat` 及对应的 Django、Celery、Collab、Centrifugo 原生启动脚本。

本设计不重写这些成熟链路，而是在其上增加一个跨平台编排层，让开发者只面对一个命令和一套错误语言。

## 目标

开发者在仓库根目录运行一条跨平台命令后，系统自动完成以下流程：

1. 检查本机工具链并给出可执行的修复提示。
2. 为海外开发者使用官方源，为中国大陆网络选择可用镜像。
3. 使用同一份锁文件安装 Electron 及其工作区依赖，不修改用户全局 npm 配置。
4. 生成并校验仅含公开客户端配置的本地 Electron 环境文件。
5. 复用已健康的本地后端，或调用对应平台的后端启动入口。
6. 等待 Django、Collab Live 和 Centrifugo 健康后启动 Electron。
7. 重复执行时跳过不必要的安装和后端重启。

## 非目标

- 不在 Electron 编排器中实现 Django、数据库、Redis、Celery 或迁移逻辑。
- 不用 Node 重写现有 Bash 或批处理后端脚本。
- 不自动安装需要管理员权限的 Docker、Python、编译器或系统 SDK。
- 不启动 Daemon、AdminDash、iOS 或 Android。
- 不处理社区安装包的签名、公证或发布；本设计只覆盖本地开发启动。

## 方案选择

采用跨平台 Node 编排器，保留平台原生后端适配器。

没有采用以下方案：

- 扩展 `scripts/dev/menu.sh`：用户入口仍依赖 Bash，不能解决 Windows 首次体验。
- 在 `start-all.sh` 中直接启动 Electron：后端与桌面端生命周期和维护职责会被耦合。
- 同一个脚本同时兼容 Bash 与 CMD：转义、路径和信号行为脆弱，维护成本高。

## 用户入口

无需安装工作区依赖即可使用的主入口：

```bash
node scripts/dev.mjs community
```

安装完成后提供等价别名：

```bash
pnpm dev:community
```

首版支持以下参数：

```text
--region auto|cn|global  下载源策略，默认 auto
--skip-backend           后端由开发者自行管理，只执行健康检查
--doctor                 仅运行环境检查
--dry-run                打印经过脱敏的执行计划，不安装或启动
--help                   显示帮助
```

不增加交互式菜单。默认值应覆盖首次体验，参数用于自动化和故障排查。

## 总体流程

```text
解析参数
  → 工具链 doctor
  → 解析下载区域
  → 确保 Electron 依赖可用
  → 生成并校验公开客户端环境文件
  → 探测后端健康状态
  → 必要时调用平台后端适配器
  → 等待后端健康
  → 前台启动 Electron
```

任一步失败都停止后续步骤。后端未健康时不打开功能残缺的客户端。

## 模块边界

### 顶层编排器

`scripts/dev.mjs community` 进入 Electron Community 编排器；具体实现位于 `scripts/electron/community/`。网络探测、环境文件生成、后端适配和健康检查分别放在可单测模块中。

### 依赖安装器

扩展现有 `scripts/electron/install-dependencies.mjs`，继续作为依赖安装的唯一实现。编排器调用它的公开函数，不复制 registry 或二进制镜像表。

### 后端适配器

Node 根据 `process.platform` 选择命令：

| 平台 | 后端入口 |
| --- | --- |
| Windows | `cmd.exe /d /s /c scripts\\start-all.bat` |
| macOS/Linux | `bash scripts/backend/start.sh` |

Windows 用户可以从 PowerShell、CMD 或 Git Bash 运行统一 Node 入口；内部始终进入 Windows 原生批处理链路，不要求安装 Bash 或 WSL。

后端脚本负责启动进程并以退出码表示启动请求是否成功。最终健康判定由 Node 编排器统一执行，避免 `.bat` 与 `.sh` 的成功标准漂移。

### Electron 启动器

后端健康后，编排器以前台子进程调用现有 `scripts/electron/dev.mjs --env-file <path>`。信号和退出码继续由现有启动器处理。Electron 退出时不自动停止后端，方便开发者热重启客户端。

## 下载源策略

区域选择遵循以下优先级：

1. 显式 `--region`。
2. `TABTIN_DEV_REGION` 进程环境变量。
3. `auto` 探测结果。

`auto` 同时探测 npm registry 与当前 Electron 版本的二进制来源。官方源在合理时限内可用时优先官方源；官方源超时或不可达、国内镜像可用时选择 `cn`。探测结果必须打印，且告诉开发者如何显式覆盖。

国内配置继续只注入安装子进程，至少包含：

- npm registry
- Electron 二进制镜像
- electron-builder 二进制镜像
- Sentry CLI 镜像

不得执行 `npm config set`，不得修改用户级或仓库级 `.npmrc`。安装前完成源选择；原生模块编译失败时不得通过盲目换源掩盖工具链问题。

## 工具链检查

doctor 按“必需”和“可选降级”输出，不只检查命令是否存在。

必需检查：

- Node 满足根 `package.json#engines.node`。
- pnpm 与 `packageManager` 主版本一致；若 pnpm 不在 PATH、Corepack 可用，则通过 Corepack 调用，不修改全局配置。
- Python 3 可用。
- 平台原生编译环境可用：Windows C++ Build Tools、macOS Xcode Command Line Tools、Linux `make` 与 C/C++ 编译器。
- 后端未健康且未使用 `--skip-backend` 时，Docker 和平台后端入口可用。
- Electron `predev` 需要构建 Go CLI 时，Go 工具链可用。

可选能力缺失必须明确说明影响。例如文件生成附加能力缺失可以降级，但不能用笼统警告让开发者猜测是否能继续。

doctor 不自动安装需要管理员权限的系统组件。失败信息包含平台对应的安装名称、检测命令和重新运行入口。

## Electron 环境配置

生成文件：

```text
apps/tabtin-electron/.env.opensource.local
```

该文件加入 `.gitignore`，并通过 `--env-file` 显式加载。生成过程只允许写入白名单中的公开客户端配置，不复制根 `.env` 的服务端密钥或商业配置。

默认本地配置包括：

```dotenv
TABTIN_LOCAL_DEV_MODE=native
TABTIN_API_BASE_URL=http://127.0.0.1:6060/api
VITE_API_BASE_URL=http://127.0.0.1:6060/api
VITE_COLLAB_WS_BASE=ws://127.0.0.1:4100
VITE_CENTRIFUGO_WS_URL=ws://127.0.0.1:8100/connection/websocket
VITE_PUBLIC_WEB_BASE_URL=http://127.0.0.1:5176
VITE_DEV_SERVER_PORT=5175
VITE_DISTRIBUTION_KIND=community
```

Django IM 与主 API 同源，统一使用 `VITE_API_BASE_URL`。

环境文件使用原子写入。若已有文件：

- 白名单键保持开发者显式设置。
- 缺失键补入安全的本地默认值。
- URL 格式错误、存在未展开占位符或本应为本地的地址指向未知远端时停止并说明具体键。
- 日志只输出键名和公开 origin，不打印任何非白名单值。

`TABTIN_COMMUNITY_API_BASE_URL` 是社区安装包构建输入，不是本地开发必填项。

## 后端健康契约

编排器在启动后端前先探测，全部健康时直接复用：

| 能力 | 地址 | 成功条件 |
| --- | --- | --- |
| Django | `http://127.0.0.1:6060/health` | HTTP 2xx，正文包含 `healthy` |
| Collab Live | `http://127.0.0.1:4100/health` | HTTP 2xx，正文包含 `ok` |
| Centrifugo | `127.0.0.1:8100` | TCP 端口可连接 |

若未全部健康且没有 `--skip-backend`，调用平台后端适配器，然后以有上限的重试等待健康。超时报告必须逐项列出失败服务、探测地址和对应日志目录。

`--skip-backend` 不表示忽略健康检查，只表示不代替开发者启动后端。后端不健康时仍不启动 Electron。

## 错误模型

错误按阶段分类并使用稳定退出码：

| 类别 | 示例 | 行为 |
| --- | --- | --- |
| 工具链 | 缺少 Python、Go 或编译器 | 启动前失败，给出平台修复指引 |
| 下载网络 | registry 或二进制源不可达 | 显示已选区域和覆盖参数 |
| 依赖安装 | 锁文件不一致、原生模块编译失败 | 保留原始子进程退出码并给出分类提示 |
| 环境配置 | URL 非法、占位符未展开 | 指明键名，不打印秘密值 |
| 后端 | 启动命令失败或健康超时 | 列出失败服务和日志位置 |
| Electron | dev 进程启动失败或退出 | 透传退出码，不自动关闭后端 |

Ctrl+C 只终止前台 Electron 启动链路。已经脱离运行的后端服务保持运行。

## 重复执行与缓存

首次运行执行完整安装。后续运行根据锁文件指纹和 Electron 工作区安装标记判断是否需要再次安装。指纹变化或关键模块缺失时重新执行冻结锁文件安装；否则直接进入环境和健康检查。

缓存只保存非敏感元数据，例如锁文件摘要、区域和成功时间。缓存损坏时回退为重新安装，不阻塞启动。

## 测试设计

### 单元测试

- 参数解析和优先级。
- 官方源与国内镜像选择。
- 镜像变量只存在于安装子进程。
- 平台后端命令解析，特别是 Windows `cmd.exe` 参数和含空格路径。
- 环境白名单、合并、原子写入和脱敏输出。
- 健康检查状态聚合、超时和退出码映射。
- 缓存命中、锁文件变化和损坏回退。

### 集成测试

- 使用临时 HTTP 服务模拟三项健康端点。
- 使用假的 `pnpm`、`cmd.exe` 和 `bash` 子进程记录调用计划，避免测试修改真实依赖或服务。
- `--dry-run` 在 Windows、macOS、Linux 计划中不产生写操作。
- 中英文开发文档暴露相同的可执行命令。

### 本地验收

- Windows PowerShell、CMD、Git Bash 分别运行同一 Node 入口，均选择 `.bat` 后端链路。
- macOS/Linux 选择 `.sh` 后端链路。
- 国内配置不修改全局 `.npmrc`。
- 后端已经健康时不重启服务。
- 干净安装后 Django、Collab、Centrifugo 健康，Electron 5175 可用并出现窗口。
- 第二次运行跳过依赖安装，直接进入健康检查和 Electron。
- 运行 Electron 开源审计，确认生成环境文件不进入 Git 或安装包。

## 文档调整

更新中英文 Electron 开源开发指南，把一键入口放在最前面。现有 doctor、全球安装、国内安装和手动 Electron 启动命令保留为故障排查和高级用法。

根 README 的快速开始只引用统一入口和详细指南，不重复维护环境变量表。

## 分阶段交付

1. 增加可单测的 Node 编排器、平台后端适配和统一健康检查。
2. 扩展现有安装器的 `auto` 区域解析和工具链 doctor。
3. 增加公开客户端环境文件生成与校验。
4. 接入现有 Electron 启动器，补齐重复执行缓存。
5. 更新中英文文档并完成 Windows 真实启动验收。
6. 与后端负责人复核 `.bat`/`.sh` 的能力对齐；后端内部改造不进入本任务。

## 验收标准

- Windows 开发者无需安装 Bash 或 WSL。
- PowerShell、CMD、Windows Git Bash、macOS Terminal 和 Linux shell 使用同一入口命令。
- 海外官方源和中国大陆镜像均可显式选择，`auto` 有可解释结果。
- 不修改全局 npm 配置，不复制或打印服务端秘密。
- 开发者无需手填 Electron 本地环境变量。
- 后端未健康时不启动 Electron，失败信息能定位到具体服务。
- 首次启动成功后，再次启动不重复执行昂贵步骤。
- 现有手动安装和启动命令继续可用。

## 已知边界

- 系统级工具链仍需开发者按 doctor 指引安装。
- 后端依赖安装和 Windows `venv-windows` 创建由后端启动链路负责，本任务只做前置检测和调用。
- 当前 CI 停跑，跨平台验收依赖可复现的 dry-run/集成测试和各平台人工执行记录。
- Electron 本地启动成功不代表社区安装包构建、签名和升级链路已经验收。
