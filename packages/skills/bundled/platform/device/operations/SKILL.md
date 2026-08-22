---
name: device-operations
description: >
  查询移动设备状态——读取当前 Space 内已绑定的 iOS
  / Android / IoT 能力设备的设备信息、电池状态、网络状态。
  用户提到"手机电量""iPhone 型号""Wi-Fi""蜂窝网络""低电量模式""设备是否在线"时激活。
  当前 Space 没有连接能力设备时，直接告诉用户在手机端
  TabTin App 登录并加入此 Space，不要反复重试。
metadata:
  version: 0.2.0
  tabtin:
    category: device
    autoActivateFor: []
    tags:
      - mobile
      - ios
      - android
      - battery
      - network
      - wifi
      - cellular
      - low-power-mode
      - online
    tools:
      - get_device_info
      - get_battery_info
      - get_network_info
---

# Device Operations

读取当前 Space 内已绑定**能力设备（capability device）**的实时状态。首批支持 device_info / battery / network_info 三类只读能力。

## 关键概念（动手前必读）

**"能力设备" 指数据型设备**——iOS / Android（device_type=mobile）或 IoT 设备，**不是**你正在运行的桌面 Electron / Daemon / 云端 control 设备。

| 你当前所在的 runtime | 是不是能力设备？ | 你能直接读自己的电量 / 型号吗？ |
|---|---|---|
| 桌面 Electron / Daemon / 云端 Django Agent | 不是（control 设备） | **不能**——本 Skill 不读你脚下这台机器 |
| iOS / Android device_runtime | 是（capability device） | 能（前提是该设备已登录并绑到当前 Space） |

本 Skill 的所有工具都是**远程查询**：通过当前 Space 路由到该 Space 已绑定的能力设备执行。如果当前 Space 没有连接的能力设备，所有调用都会失败——不是工具坏了，是没有可派发的目标设备。

## 适用场景

- 用户问“我这台手机是什么型号 / 什么系统版本”
- 用户问“现在手机电量多少，是否在充电”
- 用户问“当前是 Wi-Fi 还是蜂窝网络，设备是否在线”

## 不适用场景（避免误用）

- **用户问“我这台电脑 / 桌面 / Mac / Windows 的电量 / 网络 / 型号”**——本 Skill 不读 control 设备。请用 `run_terminal_command` 跑 `system_profiler` / `pmset` / `ipconfig` 之类的本机命令
- **用户没有连过手机，只在桌面客户端**——本 Skill 用不上，请直接告诉用户“此功能需要先在手机端 TabTin App 登录并加入当前组织”
- **用户问通话记录 / 短信 / 联系人 / 应用列表 / 截屏**——这些是 mobile_l1 / mobile_l2 能力，不在本 Skill 范围（请到 `app:tabphone/phone-operator` 或 Django 设备工具）

## 调用入口的两条路径

工具有 **FC 工具（function call）** 和 **CLI 命令** 两种调用形式，但**不是所有 runtime 都同时暴露两种**——按你看到什么选什么。

### 路径 A：FC 工具——仅在 Django 云端 Agent runtime 直接可见

`get_device_info` / `get_battery_info` / `get_network_info` 是 Django 后端注册的工具。只有当你跑在**云端 Django Agent runtime** 时，工具列表里才会出现这三个名字，可以直接 function call。

**判断方法**：检查你这一轮收到的 tools 列表（即可调用的工具清单）。**列表里没有 `get_device_info` 就表示你是本地 runtime（Electron / Daemon），改走路径 B**。

不要这样做：

- ❌ 先尝试 function call 再降级——本地 runtime 上这一步必然失败
- ❌ 调 `mcp_list_tools` / 翻其他工具列表去找——这些工具不在 MCP server 里，是 Django 后端工具
- ❌ 用 `rag_search` / `memory_search` 找设备信息——这些不读实时设备状态

### 路径 B：CLI 命令——本地 runtime（Electron / Daemon）的唯一调用方式

通过 `run_terminal_command` 执行 `tabtin device …` 命令。CLI 内部走 cli-server（Electron 主进程或 Daemon 进程），最终调 Django `/api/tabtinspace/devices/query` 派发到 Space 的能力设备。**两端是同一条派发链路**——CLI 调用结果跟 FC 工具调用结果等价，只是入口不同。

**默认推荐路径 B**——只要你看到的工具列表里没有 `get_device_info`，就直接走 CLI，不要尝试 function call。

## 资源导航（按需读取）

- `references/tool-reference.md`：仅在你走路径 A（FC 工具直调）并且需要核对入参/出参 schema 或示例时读取；路径 B（CLI）场景优先按本文件 CLI 章节执行。

## FC 工具说明（路径 A）

> 三个 FC 工具的入参 / 出参 schema 与示例（get_device_info / get_battery_info / get_network_info）见 [`references/tool-reference.md`](references/tool-reference.md)。

## CLI 命令（路径 B）

通过 `run_terminal_command` 执行：

```bash
tabtin device info    [--space-id <id>] [--timeout 30] [--format json]
tabtin device battery [--space-id <id>] [--timeout 30] [--format json]
tabtin device network [--space-id <id>] [--timeout 30] [--format json]
```

参数说明：

- `--space-id`：默认使用当前终端上下文里的 Space。若不在 Space 终端里执行（比如 Daemon / 自动化脚本），显式传入
- `--timeout`：默认 30 秒；后端最多 300 秒。能力设备离线或响应慢时可适当调大
- `--format`：当前仅支持 `json`

成功返回示例：

```json
{
  "ok": true,
  "data": {
    "platform": "ios",
    "system_name": "iOS",
    "system_version": "18.2",
    "model": "iPhone",
    "name": "Demo iPhone"
  }
}
```

## 失败处理（重要——避免反复重试 + 避免给用户错误的回复）

CLI 命令本身**真实存在**，调用时返回非 0 的 exit code 几乎都是后端业务态错误，**不是命令不识别**。

### stderr 的双层结构

`tabtin device …` 失败时 `run_terminal_command` 看到的 stderr 是 **Go CLI 又包了一层** 的双层 JSON：

```json
{
  "ok": false,
  "error": {
    "code": "API_ERROR",
    "message": "请求失败 (status 404): {\"ok\":false,\"error\":{\"code\":\"NOT_FOUND\",\"message\":\"设备能力查询失败\",\"retryable\":false,\"suggestions\":[\"请确认 --space-id 对应的 Space 仍存在且属于当前组织\"]}}"
  },
  "meta": {"exit_code": 5}
}
```

**外层** `error.code = API_ERROR` 只是 Go CLI 的 HTTP 包装信号——**不是真正的业务错误**。**真因要解析内层**：把 `error.message` 里 `请求失败 (status N): ` 后面的 JSON 字符串提取出来再 `JSON.parse`，看内层的 `error.code` 才是 cli-server 的归一码。

如果直接拿外层 `API_ERROR` 当业务码处理，**100% 会误诊**。

### 内层归一码（cli-server `mapBackendErrorCode` 之后的）

按内层 `error.code` 处理：

| 内层 error.code | HTTP 状态 | 真实含义 | 应该怎么办 |
|---|---|---|---|
| `VALIDATION_ERROR` | 400 / 422 | 缺少 `--space-id` 等必要参数 | **可重试一次**：补上 `--space-id <当前 Space 的 ID>`（identity 提示里就有当前 Space ID） |
| `NOT_FOUND` | 404 | **Space 不存在 / 不属于当前组织 / Space ID 输错** | 告诉用户当前 Space ID 在后端找不到（可能 Space 已删除或 ID 错），让用户确认；**不要重试** |
| `PERMISSION_DENIED` | 403 | 当前账号对该 Space 无访问权限 | 告诉用户切换组织 / 联系管理员；不要重试 |
| `TASK_FAILED` | 409 | **该 Space 没有绑定且在线的能力设备**（cli-server 把后端 `DEVICE_RUNTIME_UNAVAILABLE` / `DEVICE_RUNTIME_OFFLINE` 都映射成这个码） | **不要再调任何 device 工具**。直接告诉用户：当前工作空间还没有可用的手机；需要在 iOS / Android 端打开 TabTin App，登录并加入当前组织，确保 App 在前台或保持后台运行权限。等用户确认连上后再重试一次 |
| `TASK_TIMEOUT` | 504 | 设备在线但响应超时（手机退到后台/网络差） | 提示用户把手机端 App 切回前台，可重试一次 |
| `BACKEND_ERROR` | 500 / 502 | 后端未分类错误 / device_runtime 投递失败 | 把 `error.message` 原样转述给用户，不要臆造原因 |
| `AUTH_MISSING` | 401 | 未认证 / token 过期 | 告诉用户重新登录 TabTin |

> 路径 A（Django 云端 FC 工具直调）的 error code 体系不太一样——内层 code 可能直接是 `DEVICE_RUNTIME_UNAVAILABLE` / `DEVICE_RUNTIME_OFFLINE` 等原始码（没经 cli-server 重映射）。语义跟上表 `TASK_FAILED` 行一致——按"没绑/离线"处理。

### 反模式（dogfood 教训）

- ❌ 看到外层 `API_ERROR` 就推断"工具坏了 / 命令不存在 / API 挂了"——**这只是 Go CLI 的 HTTP 包装**，要解析内层
- ❌ 多次重试同一命令——`NOT_FOUND` / `PERMISSION_DENIED` / `TASK_FAILED` 不会自己好转
- ❌ 含混回复"可能是 Space 不存在 / 也可能是设备离线 / 也可能是组织问题"——**按内层 code 给单一明确的诊断**，不要把多种猜测一起列给用户
- ❌ 告诉用户"系统坏了 / 工具没注册"——这些都是**后端正常的业务态**，不是 bug
- ❌ 跟用户说话时朗读 `NOT_FOUND` / `TASK_FAILED` / `error.code` 等英文术语——这些是内部码，**对用户用自然中文**："还没连上手机" / "Space 找不到" / "等设备响应超时"

## 多设备处理

如果同一工作空间里有多台能力设备，系统会自动选择当前 Space 内可用且满足能力的一台。回答时要基于返回结果本身（看 `data.name` 或 `device_fingerprint`），**不要擅自假设是哪一台手机**。
