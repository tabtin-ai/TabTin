---
name: desktop-operator
description: >
  桌面操控（Computer Use）——截屏、点击 / 拖拽 /
  滚动鼠标、输入键盘、管理窗口。用户提到"操控桌面""打开应用""点击屏幕""截屏""桌面自动化""Computer
  Use"时使用。
metadata:
  version: 0.1.0
  tabtin:
    category: device
    autoActivateFor:
      - tabdesktop
    tags:
      - desktop
      - automation
      - computer-use
    tools:
      - run_terminal_command
---

# Desktop Operator

通过 `tabtin desktop` CLI 命令操控用户的 macOS / Windows 桌面。所有操作通过 `run_terminal_command(command="tabtin desktop ...")` 执行——**不使用 FC 工具**。仅在 Electron 桌面客户端运行时可用（headless / daemon 模式不支持，Linux 也不支持）。

## 平台支持

| 平台 | 支持状态 |
|------|----------|
| macOS | 全部能力可用，需「辅助功能」+「屏幕录制」权限（`系统设置 → 隐私与安全性`） |
| Windows | 全部能力可用，UAC 弹窗需用户手动处理 |
| Linux | **明确不支持**——所有桌面操控命令直接返回中文「不支持」错误，应当切换到 macOS / Windows |

## 方法路由

**操作类**（session 内使用）：

| 目标 | CLI 命令 |
|------|---------|
| 截取屏幕 | `tabtin desktop screenshot` |
| 获取 AX 快照（元素树） | `tabtin desktop accessibility-tree` |
| **按元素名点击**（AX 优先） | `tabtin desktop click-element --name "名称" [--role Role]` |
| **按元素名输入**（AX 优先） | `tabtin desktop type-into-element --name "名称" "文本"` |
| 鼠标点击（坐标，AX 不可用时回退） | `tabtin desktop click <x> <y>` |
| 鼠标拖拽 | `tabtin desktop drag <x1>,<y1> <x2>,<y2>` |
| 鼠标滚动 | `tabtin desktop scroll <x> <y> --dy <n>` |
| 移动鼠标（不点击） | `tabtin desktop move <x> <y>` |
| 输入文字 | `tabtin desktop type "text"` |
| 输入中文/特殊字符 | `tabtin desktop type "中文" --clipboard` |
| 按键 / 组合键 | `tabtin desktop key` / `tabtin desktop hotkey` |
| 列出所有窗口 | `tabtin desktop windows` |
| 激活窗口到前台 | `tabtin desktop activate "App Name"` |
| 打开应用（按名称或 .app 路径） | `tabtin desktop open "App Name"` / `tabtin desktop open "/Applications/X.app"` |
| **批处理多步**（Wave 3） | `tabtin desktop batch -` (读 stdin) / `tabtin desktop batch --file ops.json` |

> **禁止误开系统终端**：用户说「打开终端」指的是 **TabTin 应用内终端**，请用 `tabtin terminal open`，**不要**用 `tabtin desktop open "PowerShell"` / `"Windows Terminal"` / `"cmd"`。只有用户明确要求外部系统终端时，才用 `tabtin desktop open "PowerShell" --external`。

**会话与授权管理**（元命令，详见下方「会话与授权管理」章节）：

| 目标 | CLI 命令 |
|------|---------|
| 诊断系统权限（辅助功能 / 屏幕录制） | `tabtin desktop accessibility [--prompt]` |
| 手动启动 / 结束会话（高级） | `tabtin desktop session start` / `tabtin desktop session end` |
| 中途扩展 allowedApps 白名单 | `tabtin desktop session extend-allowlist <app>... --session-id <sid>` |
| 撤销「总是允许」授权 | `tabtin desktop revoke-approval` |

## 核心工作流

### 标准操控循环（铁律）

每次桌面操控遵循 **截屏 → AX 查询（有能力时）→ 分析 → 操作 → 截屏验证** 循环：

```
1. tabtin desktop screenshot                         ← 获取当前屏幕画面（必须第一步）
2. tabtin desktop accessibility-tree                  ← 获取元素结构（有 AX 时优先）
3. 分析截图 + AX 快照，确定操作方式                     ← 你来判断
4. tabtin desktop click-element / type-into-element   ← AX 精确操作（优先）
   或 tabtin desktop click / type / hotkey            ← 坐标操作（AX 不可用时回退）
5. tabtin desktop screenshot                         ← 验证操作结果
6. 如果未达预期，回到步骤 2 重新分析
```

**AX 优先策略**：

- **有 AX 时优先用 AX**：目标应用的前台窗口用 `tabtin desktop accessibility-tree` 能拿到结构化元素时，优先用 `click-element` / `type-into-element` 操作——不需要猜坐标，UI 怎么动都能找对
- **只有 AX 找不到时才回退坐标**：元素是 canvas 原生绘制（如 Figma 画布内元素、游戏引擎、Web 里的 `<canvas>` / `<svg>` 拖放元素）、或 role 不符合交互白名单、或收到 `ELEMENT_NOT_FOUND` / `AX_UNAVAILABLE` 错误时，再回落到 `tabtin desktop screenshot` + `tabtin desktop click <x> <y>`
- **做完必验**：AX 操作和坐标操作一样，每步后 screenshot 验证

**关键约束**：

- **TabDesktop 会话的第一步必须是 `screenshot`**：它既是坐标系建立的入口，也是首次审批的触发点。在 `activate` / `open` / `windows` / `accessibility-tree` 之前都要先 screenshot，没有 session 就没有锁、没有审批，后续都会被路由层挡住。
- **随时可中止**：用户按 `Cmd+Shift+Esc`（macOS）/ `Ctrl+Alt+Esc`（Windows）可立即终止桌面操控——你会收到 `ABORTED` 错误，应停止当前流程并告知用户
- **每次操作后截屏验证**：确认操作是否生效，不要盲目连续操作
- **一次只做一步**：不要在没有验证的情况下连续执行多个操作

### 中文输入

中文、日文、emoji 等非 ASCII 字符**必须**使用剪贴板模式：

```
tabtin desktop type "你好世界" --clipboard
```

`--clipboard` 模式通过剪贴板粘贴文本，绕过逐字符输入的编码问题。系统会自动保存和恢复原有剪贴板内容。

## 坐标系统

- 所有坐标基于**最近一次 `screenshot` 返回的坐标系**
- CLI 内部自动处理 Retina / HiDPI 缩放——你提供截图上看到的坐标，系统自动换算为实际屏幕坐标
- `screenshot` 返回的 JSON 包含 `scaleFactor`，你**不需要手动换算**
- **首次截屏时冻结坐标系**（bounds + scaleFactor）。如果 session 期间显示器配置变化（插拔显示器、调分辨率、改缩放），当前 session 会**立即结束**并返回 `DISPLAY_CONFIG_CHANGED` 错误——不是坐标漂移后静默继续。收到该错误时，应立即重新运行 `tabtin desktop screenshot` 建立新 session 与新坐标系，再继续后续操作（规范 § 5.3 规则 8 · fail-fast 设计）

## 安全须知

### 审批机制

- **首次使用桌面操控需用户审批**——系统弹出权限确认对话框，四个按钮：「允许」（单次）/「拒绝」/「总是允许」/「永不允许」
- **鼠标键盘输入即使在全自动模式下也需要用户确认**——这是不可逆操作
- **系统级快捷键（Cmd+Q / Alt+F4 等）默认被拦截**，需单独授权 `systemKeyCombos`

### 桌面操控的授权生命周期

这三件事是用户每天都会撞上的，Agent 必须主动向用户解释：

- **「总是允许」有 24 小时 TTL**：用户首次点「总是允许」后，接下来 **24 小时内**的桌面操控不再弹审批；过了 24 小时，下一次 `tabtin desktop screenshot` 会再次弹窗。用户以为"永久允许"而第二天又看到弹窗是常见误解，要主动说明
- **随时可撤销授权**：用户可在 TabTin「设置 → 凭据与授权 → 桌面操控授权」面板**随时撤销**当前持久化的「总是允许」记录；CLI 等价命令：`tabtin desktop revoke-approval`（见下方元命令专章）
- **Space 管理员可关闭桌面操控**：管理员或用户把 `device_permissions.desktop_observe` 设为 `block` 时，本 Space 的所有 `tabtin desktop` 命令（除 `accessibility` 诊断外）都会返回 `POLICY_BLOCKED` 三段式错误。遇到此错误时，应告知用户"当前 Space 关闭了桌面操控权限"并让用户或管理员去 **Space 设置 → 授权策略** 打开，**不要**尝试用 `osascript` / PowerShell / `run_terminal_command` 绕路执行等价操作——那是幻觉，云端 / 客户端两侧都会拦

### 紧急中止快捷键

用户**随时可以按以下组合键中止**所有桌面操控：

- macOS：`Cmd+Shift+Esc`
- Windows：`Ctrl+Alt+Esc`

> 注意：是**组合键**，不是单独按 `Esc`——单 `Esc` 在浏览器/IDE 等场景中过于易触发，且无法注册为系统级快捷键。操控被中止后你会收到中文错误信息，应立即停止当前流程并告知用户。

### 禁止操作

- **不可逆危险操作**：不要关闭未保存的文档、不要删除文件、不要关机/重启
- **系统级快捷键**：不要使用 Cmd+Q / Alt+F4 等关闭应用的快捷键，除非用户明确要求
- **敏感信息**：不要截取/操作包含密码、银行卡、私钥等敏感内容的页面
- **并发冲突**：同一时间只有一个 Agent session 可以操控桌面（文件锁互斥），收到锁冲突错误时停止重试

### 扩展操作范围（allowedApps 扩权）

session 首次 `screenshot` 时若声明了 `allowedApps`（如 `[Figma, VS Code]`），session 内所有鼠标类操作只能落在这些应用上，坐标命中其他应用 → 收到"操作被阻止：坐标指向「Chrome」，不在允许列表 [Figma, VS Code] 中"错误。

**应用名必须完整匹配**（规范 § 6.6 · 大小写不敏感 + trim，**精确匹配而非子串**）：

- ✅ `allowedApps: ['Google Chrome']` + 当前应用 `'Google Chrome'` → 放行
- ✅ `allowedApps: ['Google Chrome']` + 当前应用 `'google chrome'` → 放行（大小写不敏感）
- ❌ `allowedApps: ['Chrome']` + 当前应用 `'Google Chrome'` → **不放行**（Chrome ≠ Google Chrome）
- ❌ `allowedApps: ['Code']` + 当前应用 `'Xcode'` → **不放行**（Code ≠ Xcode；Wave 2.2 之前的子串匹配会误放行，已改精确匹配）

写 allowedApps 时**给完整应用名**（macOS 可用 `tabtin desktop windows --format table` 查 `app` 字段）；拿捏不准就等撞到 `POLICY_BLOCKED` 后读错误文案里的"当前应用名「X」"再走扩权命令。

**正确应对路径**（规范 § 6.12）：

1. **不要** 直接重试原点击或切换到 activate Chrome，会继续被 `requireAllowedApp` 挡住
2. **不要** 尝试结束会话重开——那会丢失 session 状态并引入额外审批
3. **正确做法**：调用扩权命令，等待用户审批通过后再继续

```bash
# 扩单个应用
run_terminal_command(command="tabtin desktop session extend-allowlist 'Google Chrome' --session-id <sid>")

# 扩多个（去重合并）
run_terminal_command(command="tabtin desktop session extend-allowlist 'Finder' 'Preview' --session-id <sid>")

# 建议带 --reason 帮用户判断
run_terminal_command(command="tabtin desktop session extend-allowlist 'Google Chrome' --session-id <sid> --reason '需要在浏览器里查规范文档'")
```

返回成功 → 继续操控新应用；返回 `NEEDS_APPROVAL`（用户拒绝或超时）→ 向用户解释当前 allowedApps 不包含目标应用并询问是否改道，**不要**立即重试扩权。

**约束**：

- 扩权**必须**重新弹窗（不走"总是允许"缓存）；这是 v1 的安全承诺
- `--session-id` 必填，必须等于当前 active session 的 id（可从首次 `screenshot` 返回的 `sessionId` 读取）
- 扩权成功后 session 其余状态（坐标系、clipboardWrite 等）完全不变

### 会话与授权管理（元命令）

下列命令不参与"截屏 → 点击 → 验证"主循环，但会在排障 / 授权生命周期里用到。Agent 通常不主动调用，错误文案里引导到这些命令时再用。

**`tabtin desktop accessibility [--prompt]`** — 诊断系统权限

```bash
# 读当前 macOS 辅助功能 + 屏幕录制权限状态（只读诊断，不触发审批）
run_terminal_command(command="tabtin desktop accessibility")
# → { trusted: true/false, screenRecording: true/false, screenRecordingStatus: 'granted'|'denied'|'unavailable', platform: 'darwin'|'win32'|'linux' }

# --prompt 让 macOS 系统弹出引导对话框（首次授权时用户可直接点进系统设置）
run_terminal_command(command="tabtin desktop accessibility --prompt")
```

- **macOS**：返回真实的辅助功能 / 屏幕录制授权状态；`--prompt` 触发系统级引导
- **Windows**：无 TCC 概念，恒返回 `trusted: true / screenRecording: true`（合理默认，不代表真的授权过）
- **Linux**：诊断豁免（`trusted: false / screenRecording: false / screenRecordingStatus: 'unavailable'`），不会被"不支持"统吞
- **用途**：收到 `TCC_DENIED` 错误时用来确认授权状态；一般不在主循环里调用

**`tabtin desktop session start` / `tabtin desktop session end`** — 手动会话管理（高级）

```bash
# 手动启动会话（一般不用——推荐用 screenshot 隐式启动）
run_terminal_command(command="tabtin desktop session start")

# 主动结束当前会话（释放锁）
run_terminal_command(command="tabtin desktop session end")
```

- **推荐路径**：首次 `screenshot` 会自动 `session start`——不用显式调用
- **何时用 end**：任务完成后想立即释放锁，让其他 Agent session 可以接手；不 end 的话会在空闲 10 分钟后自动超时结束

**`tabtin desktop session extend-allowlist <app>... --session-id <sid> [--reason <text>]`** — 中途扩展白名单

见上一节「扩展操作范围」，要求给**完整应用名**（精确匹配语义）。

**`tabtin desktop revoke-approval`** — 撤销"总是允许"授权

```bash
# 清掉持久化的 desktop-approval.json，下次 screenshot 会重新弹审批
run_terminal_command(command="tabtin desktop revoke-approval")
```

- **等价 UI 路径**：TabTin「设置 → 凭据与授权 → 桌面操控授权 → 撤销」
- **何时用**：用户说"不想再给 TabTin 桌面权限了"、或怀疑"总是允许"被误点、或排障时想强制重新走一次审批流程
- **作用范围**：只清持久化授权，不会中止当前正在进行的 session（想中止 session 按 Cmd+Shift+Esc / Ctrl+Alt+Esc）

## 注意事项

- **窗口遮挡**：点击无反应时，可能是目标被其他窗口遮挡，先用 `activate` 激活目标窗口
- **加载延迟**：点击按钮后应用可能需要时间响应，等待 1-2 秒再截屏验证
- **弹窗处理**：系统弹窗（权限请求、UAC、保存确认）可能遮挡目标，需先处理弹窗
- **坐标漂移**：页面滚动、窗口移动、弹窗出现都会导致旧坐标失效，必须重新截屏
- **操控锁冲突**：收到「桌面操控被另一个 session 占用」错误时，不要重试，告知用户

## 资源导航（按需读取）

- `references/cli-reference.md`：当你需要查某个 `tabtin desktop` 子命令的完整 flag、JSON 返回字段或边界行为时读取；常规流程直接按本文件主章节执行。
- `examples/scenarios.md`：仅在需要端到端范式（例如跨应用流程、坐标版 vs AX 版对照）时读取；示例用于套用结构，不默认整份塞入上下文。

## CLI 命令参考

> 完整命令参考（截屏 / 鼠标 / 键盘 / 批处理 batch / Accessibility Tree / 窗口管理，含全部 flag、JSON 字段、返回格式）见 [`references/cli-reference.md`](references/cli-reference.md)。

## 典型场景示例

> 5 个端到端场景（Figma 截图 / Excel 填表坐标版与 AX 版 / 登录表单 / 跨应用复制粘贴 / Electron 应用测试 / 跨设备联动）见 [`examples/scenarios.md`](examples/scenarios.md)。
