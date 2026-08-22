# Desktop Operator · CLI 命令参考

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

所有命令通过 `run_terminal_command(command="tabtin desktop ...")` 执行。输出默认 JSON 格式，人类阅读可加 `--format table`。

### 截屏

```bash
tabtin desktop screenshot                                  # 截取主显示器全屏
tabtin desktop screenshot --display <id>                   # 截取指定显示器
tabtin desktop screenshot --region 100,200,800,600         # 截取指定区域（x,y,w,h）
tabtin desktop screenshot --max-dim 1920                   # 设置截图最大边长（默认 1280）
tabtin desktop screenshot --save ~/screenshots/check.jpg   # 指定保存路径
```

返回值（JSON）：

```json
{
  "sessionId": "auto-1745080245000",
  "path": "/Users/x/.tabtin/screenshots/screen-2026-04-19.jpg",
  "width": 1280,
  "height": 800,
  "displayWidth": 1280,
  "displayHeight": 800,
  "scaleFactor": 1.0
}
```

- `sessionId`：**当前 session 的唯一 id**。后续调 `session extend-allowlist --session-id <id>` / `session end --session-id <id>` 等元命令必填此值；会话内反复调用 `screenshot` 返回的 sessionId 保持不变，直到 session 结束（空闲超时 / 显示器变化 / 用户撤销 / 手动 end）
- `path`：截图文件路径，用于后续图像分析
- `width` / `height`：截图实际像素尺寸——你在截图上看到的坐标即基于此尺寸
- `scaleFactor`：截图与逻辑屏幕的比例，CLI 内部用于反算，你不需要关心

### 鼠标操作

```bash
tabtin desktop click 640 400                               # 左键单击
tabtin desktop click 640 400 --button right                # 右键单击
tabtin desktop click 640 400 --button middle               # 中键单击
tabtin desktop click 640 400 --count 2                     # 双击
tabtin desktop click 640 400 --count 3                     # 三击（常用于选中整行文本）
tabtin desktop scroll 640 400 --dy -3                      # 向上滚动 3 格
tabtin desktop scroll 640 400 --dy 5                       # 向下滚动 5 格
tabtin desktop scroll 640 400 --dx 2                       # 向右水平滚动
tabtin desktop drag 100,200 500,200                        # 从 (100,200) 拖拽到 (500,200)
tabtin desktop drag 100,200 500,200 --duration 1000        # 拖拽持续 1 秒
tabtin desktop move 640 400                                # 移动鼠标到坐标（不点击）
```

- 所有坐标基于最近一次 `screenshot` 的坐标系
- `scroll --dy` 负值向上，正值向下；`--dx` 负值向左，正值向右
- `drag` 默认 500ms 动画时长，ease-out 插值，拖拽完成后 50ms settle

### 键盘操作

```bash
tabtin desktop type "Hello World"                          # 逐字符输入（ASCII）
tabtin desktop type "你好世界" --clipboard                  # 剪贴板粘贴（中文/特殊字符必用）
tabtin desktop key Enter                                   # 按回车
tabtin desktop key Tab                                     # 按 Tab
tabtin desktop key Escape                                  # 按 Escape（普通按键，不会触发中止）
tabtin desktop key Backspace --repeat 5                    # 连按 5 次退格
tabtin desktop key a --modifiers cmd                       # Cmd+A（全选）
tabtin desktop key c --modifiers cmd                       # Cmd+C（复制）
tabtin desktop key v --modifiers cmd                       # Cmd+V（粘贴）
tabtin desktop hotkey cmd c                                # 复制（等价于 key c --modifiers cmd）
tabtin desktop hotkey cmd shift s                          # Cmd+Shift+S（另存为）
tabtin desktop hotkey alt Tab                              # Alt+Tab（切换窗口）
```

- `type` 默认逐字符输入，仅适合 ASCII 字符
- `type --clipboard` 通过剪贴板粘贴，适合中文、日文、emoji 等非 ASCII 内容
- `hotkey` 是 `key --modifiers` 的快捷写法，参数为空格分隔的按键序列
- 常用键名：Enter, Tab, Escape, Backspace, Delete, Space, Up, Down, Left, Right, Home, End, PageUp, PageDown

### 批处理（batch）—— 单次调用多步

**用途**：Agent 遇到"点击输入框 → 输入文字 → 按 Return"这类**可预测序列**时，用 batch 一次调用替代 3 次单步调用，省 2 次 LLM RTT（每次 200–1500ms）。规范 § 4.5.2 定义。

**基本用法**：

```bash
# 从 stdin 读（推荐，避免临时文件）
echo '[{"action":"click","x":640,"y":400},{"action":"type","text":"hi"},{"action":"key","key":"Enter"}]' \
  | tabtin desktop batch -

# 从文件读
tabtin desktop batch --file ops.json

# 位置参数也支持文件路径（等价于 --file）
tabtin desktop batch ops.json
```

**子动作 action 枚举（9 种）**：`click` / `scroll` / `drag` / `move` / `type` / `key` / `hotkey` / `screenshot` / `wait`。每种的字段与对应单步 CLI 一致——比如 `click` 需要 `x / y`（还可选 `button / count`）、`type` 需要 `text`（可选 `useClipboard: true`）、`wait` 需要 `ms`。

**JSON 字段 vs 单步 CLI flag 命名差异一览 · 9 种子动作完整对照**：

| 单步 CLI | batch JSON 字段 | 说明 |
|----------|-----------------|------|
| `click <x> <y> [--button right] [--count 2]` | `{"action":"click","x":..,"y":..,"button":"right","count":2}` | flag 去 `--` 变驼峰字段；`button` 缺省 `"left"`、`count` 缺省 `1` |
| `scroll <x> <y> [--dx ..] [--dy ..]` | `{"action":"scroll","x":..,"y":..,"dx":..,"dy":..}` | `dx` / `dy` 可选，未传视为 0（两者至少传一个） |
| `drag <fromX>,<fromY> <toX>,<toY>` | `{"action":"drag","fromX":..,"fromY":..,"toX":..,"toY":..}` | CLI 的位置参数拆成 4 个独立字段；4 项均必填 |
| `move <x> <y>` | `{"action":"move","x":..,"y":..}` | 鼠标移动不点击；两项必填 |
| `type "..." [--clipboard]` | `{"action":"type","text":"...","useClipboard":true}` | JSON 用**驼峰** `useClipboard`，**不是** `--clipboard`；中日韩/emoji 必须 `useClipboard:true` |
| `key <key> [--modifiers cmd,shift] [--repeat 2]` | `{"action":"key","key":"a","modifiers":["cmd","shift"],"repeat":2}` | `modifiers` 是**数组**不是逗号字符串；`repeat` 缺省 1 |
| `hotkey cmd c` | `{"action":"hotkey","keys":["cmd","c"]}` | CLI 位置参数在 JSON 里合并成 `keys` 数组；**至少 2 项**（最后一个是主键，前面全是修饰键） |
| `screenshot [--display N] [--max-dim 1024]` | `{"action":"screenshot","displayId":1,"maxDimension":1024}` | 字段都可选；**batch 首项禁止 screenshot**（见下方"硬规则"） |
| *（CLI 无）* | `{"action":"wait","ms":500}` | batch 专用：等待指定毫秒数再继续下一步（最大 30000ms）；适合"点击后等动画/加载再操作"的场景 |

**session 归属**：batch 默认复用当前活跃 session（由最近一次 `tabtin desktop screenshot` 建立）。多 session 排障时可显式传 `--session-id <sid>`，普通场景不用关心。

**硬规则：batch 首项不能是 screenshot**（规范 § 4.5.2 · Q5）

```bash
# ❌ 错误：batch 第 1 项是 screenshot
echo '[{"action":"screenshot"},{"action":"click","x":10,"y":20}]' | tabtin desktop batch -
# → 返回 VALIDATION_ERROR：
# "batch 首项不能是 screenshot，请先单独调 tabtin desktop screenshot 建立 session 后再发起 batch。"

# ✅ 正确：先单独 screenshot 建立 session，再发 batch
tabtin desktop screenshot
echo '[{"action":"click","x":10,"y":20},{"action":"screenshot"}]' | tabtin desktop batch -
```

**为什么**：batch 入口走一次 `desktop_input` 策略评估；若首项又是 screenshot，会产生"入口已审批但子动作触发新审批"的复杂耦合。**非首项**的 screenshot 是正常子动作，用于中途刷新坐标系——不受此限制。但**不要无脑每步后都插 screenshot**：batch 内每插一次 `screenshot` 约增加 300–600ms（完整截屏落盘），会把 batch 的 RTT 收益磨平；**只在"某步可能触发 UI 大改、后续步必须看新画面才能点"时才插**，可预测序列（点输入框 → 输入 → 回车）不要插中间 screenshot。

**典型场景：Excel 填表（场景 2 的 batch 版本）**

推荐写法（避开 `run_terminal_command` 的反引号 + heredoc + JSON 三层引号嵌套；改走"先 Write JSON 文件 → batch --file"）：

```bash
# 单步版本（Wave 2 写法，5 次 LLM RTT）
run_terminal_command(command="tabtin desktop screenshot")                    # 1
run_terminal_command(command="tabtin desktop click 120 180")                 # 2
run_terminal_command(command="tabtin desktop type '项目进度报告' --clipboard") # 3
run_terminal_command(command="tabtin desktop key Tab")                       # 4
run_terminal_command(command="tabtin desktop type '2026-04-22'")             # 5
run_terminal_command(command="tabtin desktop key Enter")                     # 6

# batch 版本（Wave 3 写法，2 次 LLM RTT）
run_terminal_command(command="tabtin desktop screenshot")   # 仍然要先单独 screenshot（Q5）

# 步骤 A：用 Write 工具把 actions 写到 /tmp/desktop-batch.json，内容为：
# [
#   {"action":"click","x":120,"y":180},
#   {"action":"type","text":"项目进度报告","useClipboard":true},
#   {"action":"key","key":"Tab"},
#   {"action":"type","text":"2026-04-22"},
#   {"action":"key","key":"Enter"}
# ]

# 步骤 B：用 --file 直接读（无需跟 shell 引号搏斗）
run_terminal_command(command="tabtin desktop batch --file /tmp/desktop-batch.json")
```

> 简短示例用 `echo '...' | tabtin desktop batch -` 的 stdin 写法是可以的（见本章开头"基本用法"）；但在 `run_terminal_command` 场景下的**多步长 JSON 首选 --file**，避免 heredoc/反引号嵌套导致的转义错误。

**返回格式**：

```json
{
  "stepsCompleted": 5,
  "stepFailed": null,
  "lastScreenshot": null
}
```

- `lastScreenshot`：若 batch 内**含** `screenshot` 子动作，此字段是**最后一次** screenshot 的返回对象（含 `path` / `width` / `height` / `scaleFactor`），Agent 可直接复用该对象的坐标系继续后续点击，无需再单独调 `tabtin desktop screenshot`；若 batch 内**不含** screenshot 子动作，此字段为 `null`。

**失败策略：stop-on-first-error**（不自动回滚）

```json
{
  "stepsCompleted": 2,
  "stepFailed": 2,
  "failedAction": "hotkey",
  "error": { "code": "POLICY_BLOCKED", "message": "系统级快捷键被安全策略阻止..." }
}
```

**字段语义（0-based）**：

- `stepFailed`（0-based 索引）= 失败的**那一步**在原 actions 数组里的下标。例如 `stepFailed: 2` 表示 `actions[2]` 失败。
- `stepsCompleted` = **成功执行完毕**的步数。失败路径下 `stepsCompleted === stepFailed`（两者都等于"失败前已完成的步数"）——例如 `stepFailed: 2` 意味着 `actions[0]` 和 `actions[1]` 已执行、`actions[2]` 失败、`actions[3+]` 未执行。成功路径下 `stepsCompleted === actions.length`、`stepFailed === null`。
- `failedAction` = 失败步的 `action` 类型（便于你按类型分桶处理）。
- 审计 jsonl 里的 `batch_step.<N>.<sub_action>` 的 N 与 `stepFailed` 同一套 0-based 索引，方便交叉查。

**拿到 `stepFailed !== null` 后的续跑策略**：

- **不要**对相同的整段 batch 重新发——前面 `stepsCompleted` 步已经生效（屏幕上文字输入了、光标位置变了）。
- **不要**机械 `actions.slice(stepFailed + 1)` 然后再发一次 batch——失败的那一步通常是"需要修正前置条件再重做"（例如 pixelCompare 屏幕变了 → 先 screenshot 再重点那个坐标），**跳过失败步直接往后跑**大概率跟原意图不符。
- **正确做法**：根据 `error.code` / `failedAction` / `error.message` 特征词三项一起分桶（**同样是 `POLICY_BLOCKED`，下面两种子情形的处置完全不同**——`error.code` 一样，必须看 `failedAction` 和 `message` 特征词才能分开）：
    - `POLICY_BLOCKED` + `failedAction: click/drag` + message 含"屏幕内容与上次截图不一致" → **pixelCompare 挡住了**，重新 `screenshot` + 分析新画面 + 重做**从失败步开始**的后续动作（可能需要用新坐标组一条新 batch）
    - `POLICY_BLOCKED` + `failedAction: hotkey/key` + message 含"系统级快捷键被安全策略阻止" → **危险键被拦了**，这是产品约束，改用别的交互方式（比如改用菜单点击）
    - `ABORTED` → 用户中止整个会话，停下告知用户
    - `VALIDATION_ERROR` → 入口参数问题，检查 JSON schema 再重发

**pixelCompare 失败时的 Agent 反应**

Wave 3 开启了"点击前 9×9 像素陈旧度校验"（规范 § 4.5.3，默认开启）——点击前系统会立即再截屏一次，比对目标 9×9 区域，确认屏幕没被别的弹窗 / 动画 / 异步加载改过再点。两种结果：

- **9×9 相等** → 点击正常执行，Agent 无感知；
- **9×9 不等** → 点击被中止，返回 `POLICY_BLOCKED + 中文文案`：

    > 点击位置的屏幕内容与上次截图不一致（9×9 像素块已变化）。
    > 本次点击未执行，避免点在 Agent 未看到过的内容上。
    > 请先运行 tabtin desktop screenshot 重新截图，再基于新坐标点击。

**正确反应**：**重新 screenshot → 根据新画面重新分析坐标 → 再点击**。**不要**简单重试原坐标——屏幕已经变了，原坐标很可能是空点或点错按钮。batch 内遇到这个错误时，`stepFailed` 会指向出事的那一步，Agent 应该从新 screenshot 开始而不是"跳过这步继续后面"。

红线保证：**新截屏失败 / 解码失败 / 冷启动等技术异常**，校验自动跳过，点击照常执行——Agent 不会因校验系统本身的抖动而无法完成任务。你唯一需要学的就是"**收到"屏幕内容与上次截图不一致"就重新截屏**"这一件事。

**性能取舍 · 何时考虑关闭 pixelCompare**

pixelCompare 每次 `click` / `drag` 前会多一次 `desktopCapturer` 截屏（~100ms 在主流机器上）+ 2 次 9×9 raw byte 比对（<1ms）。单次点击的额外开销用户察觉不到；**batch 内连续 click** 时，N 次点击会累计 `N × ~100ms`——例如 batch 内 10 次连续 click 会额外增加约 1 秒。如果你的场景是"已经确信屏幕稳定的大量连续点击"（例如 Agent 跑单元测试 UI 脚本、批量填数据 1000 行），可以关掉 pixelCompare 换速度：

- **开关现状（v2.1 模块零起 plumbing 已通）**：pixelCompare **默认启用**。管理员 / 工程师可改 `packages/apps/tabdesktop/app.json` 的 `tabdesktop.pixelCompare.enabled = false` 后**重启 TabTin 客户端**关闭——v2.1 模块零（规范 § 3.5.5）打通了 app.json → runtime plumbing，改配置重启即生效（v1.8 的"声明了不生效"债已偿还）。运行时还可走 `DesktopExecutorService.setPixelCompareEnabled(false)`（Space 切换 / 测试场景），不必重启。**注意**：实时热更新（不重启就生效）由后续 Space 配置热更新 Wave 提供，模块零阶段需要重启一次。
- **判断准则**：场景里"屏幕被外部改变"的概率可忽略（关掉风险低），而点击次数 ≥ 10 且对延迟敏感（收益高）——满足这两条再考虑关
- **默认不要关**：Agent 正常操控场景（动态 UI / 用户可能切屏 / 页面有动画）pixelCompare 的"防盲点击"价值 > 每步 100ms 的延迟
- **关闭后的 Agent 行为契约**：若工程侧关闭了 pixelCompare，Agent 将不再收到"屏幕内容与上次截图不一致"错误；若场景本身 UI 不稳定（动画 / 异步加载 / 弹窗），建议 Agent 在关键节点手动插入 `screenshot` 校验代偿。

不确定就别关。"更稳" vs "更快"的取舍由真人用户 / Space 管理员显式决定，Agent 不该替用户改这个开关。

> **区域截图模式下的行为契约（Wave 3.1）**：当 session 最近一次 screenshot 使用了 `--region`，pixelCompare 会在后续 click / drag 时**自动跳过校验放行**——因为 last 是区域裁出的小图、fresh 是整屏，两者维度不对齐、9×9 对比必然误判。这是按 pixelCompare 红线"异常不阻塞点击"的延伸处置，Agent 无需特殊处理；若需恢复保护，请改用全屏 screenshot 建立坐标系。

### Accessibility Tree（按元素名操作）

```bash
# 获取 AX 快照
tabtin desktop accessibility-tree                               # 前台窗口
tabtin desktop accessibility-tree --window 'Figma'              # 按标题匹配
tabtin desktop accessibility-tree --bundle-id com.apple.TextEdit # 按 bundle id
tabtin desktop accessibility-tree --max-depth 6                  # 更深层级

# 按元素名点击
tabtin desktop click-element --name 'Share' --role Button       # 按名称+角色
tabtin desktop click-element --name 'Save' --nth 1              # 同名元素取第 2 个
tabtin desktop click-element --name 'A1' --role DataItem        # Excel 单元格

# 按元素名输入
tabtin desktop type-into-element --name 'Email' 'user@example.com'
tabtin desktop type-into-element --name 'Search' '规范文档' --clipboard
```

- `click-element` 内部先查 AX 拿 bounds，再走现有 click 路径（含 pixelCompare 防护）
- `type-into-element` 先 click 激活元素，再 type 输入文本
- 收到 `ELEMENT_NOT_FOUND` 时：先检查 name/role 拼写，再考虑目标 UI 是否不暴露 AX（canvas/自绘界面），确认后回退坐标点击
- 收到 `AX_UNAVAILABLE` 时：macOS 辅助功能权限未授予，引导用户到「系统设置 → 隐私与安全性 → 辅助功能」授权

### 窗口管理

```bash
tabtin desktop windows                                     # 列出所有窗口（JSON）
tabtin desktop windows --format table                      # 人类可读格式
tabtin desktop activate "Google Chrome"                    # 按应用名或窗口标题激活
tabtin desktop open "Slack"                                # 打开应用（按应用名）
tabtin desktop open "/Applications/Visual Studio Code.app" # 打开应用（按 .app 路径）
```

- `open` 接受两种参数形式：**应用名**（macOS 走 `open -a`）或 **可执行路径 / .app 路径**（macOS 走 `open <path>`、Windows 走 `Start-Process -FilePath`）。如果不确定应用是否安装在标准位置，传完整 .app 路径更稳。

`windows` 返回值（JSON 数组）：

```json
[
  {
    "id": "0",
    "app": "Code",
    "title": "SKILL.md — TabTin",
    "position": { "x": 0, "y": 25 },
    "size": { "width": 1280, "height": 775 },
    "focused": true
  }
]
```
