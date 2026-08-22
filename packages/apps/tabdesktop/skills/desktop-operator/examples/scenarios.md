# Desktop Operator · 典型场景示例

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

> 以下 5 个场景与规范 `docs/planning/tabdesktop-spec-v1.md` § 8.4 对齐，可直接拷贝执行。每个场景都列"前置"说明——少了前置条件场景本身会在某一步失败。

### 场景 1：在 Figma 中截取设计稿

**前置**：Figma 已安装且已登录、目标文件已打开且有至少一个可导出画板。

```bash
# 1. 截屏启动桌面操控（首次触发审批 + 建立坐标系）
run_terminal_command(command="tabtin desktop screenshot")

# 2. 激活 Figma 窗口到前台并再次截屏确认
run_terminal_command(command="tabtin desktop activate 'Figma'")
run_terminal_command(command="tabtin desktop screenshot")
# → 记下目标画板坐标

# 3. 点击目标画板并验证选中
run_terminal_command(command="tabtin desktop click 400 300")
run_terminal_command(command="tabtin desktop screenshot")
# → 确认画板已选中

# 4. 用快捷键打开导出对话框，截屏跟踪结果
run_terminal_command(command="tabtin desktop hotkey cmd shift e")
run_terminal_command(command="tabtin desktop screenshot")
# → 确认导出对话框已打开，继续后续点击「导出」按钮
```

### 场景 2：在 Excel 中填写表格数据（含中文）

**前置**：Microsoft Excel 已安装（可以未启动，让 `open` 启动它）；若是试用 / 过期版本请先完成激活或登录。

```bash
# 1. 截屏启动桌面操控
run_terminal_command(command="tabtin desktop screenshot")

# 2. 打开 Excel（应用名形式）并等待启动
run_terminal_command(command="tabtin desktop open 'Microsoft Excel'")
run_terminal_command(command="tabtin desktop screenshot")
# → 等待应用启动后确认

# 3. 点击单元格 A1 并输入中文标题（中文必走 --clipboard）
run_terminal_command(command="tabtin desktop click 120 180")
run_terminal_command(command="tabtin desktop type '项目进度报告' --clipboard")
run_terminal_command(command="tabtin desktop key Tab")

# 4. 输入日期（ASCII 直接输入）并回车提交
run_terminal_command(command="tabtin desktop type '2026-04-19'")
run_terminal_command(command="tabtin desktop key Enter")

# 5. 截屏验证数据已正确填入
run_terminal_command(command="tabtin desktop screenshot")
```

### 场景 2b：在 Excel 中填写表格数据（AX 版 · 按元素名操作）

**前置**：与场景 2 相同。本场景演示有 AX 能力时如何精确定位元素，不需要猜坐标。

```bash
# 1. 截屏启动桌面操控
run_terminal_command(command="tabtin desktop screenshot")

# 2. 打开 Excel（应用名形式）并等待启动
run_terminal_command(command="tabtin desktop open 'Microsoft Excel'")
run_terminal_command(command="tabtin desktop screenshot")
# → 等待应用启动后确认

# 3. 查看 AX 快照，确认元素结构
run_terminal_command(command="tabtin desktop accessibility-tree --window 'Excel'")
# → 找到 DataItem "A1"、Edit 元素等

# 4. 按元素名点击 A1 并输入中文标题
run_terminal_command(command="tabtin desktop click-element --name 'A1' --role DataItem")
run_terminal_command(command="tabtin desktop type '项目进度报告' --clipboard")
run_terminal_command(command="tabtin desktop key Tab")

# 5. 输入日期并回车提交
run_terminal_command(command="tabtin desktop type '2026-04-23'")
run_terminal_command(command="tabtin desktop key Enter")

# 6. 截屏验证数据已正确填入
run_terminal_command(command="tabtin desktop screenshot")
```

### 场景 2c：登录表单填写（AX 版 · type-into-element）

**前置**：目标应用已启动并显示登录表单。

```bash
# 1. 截屏启动桌面操控
run_terminal_command(command="tabtin desktop screenshot")

# 2. 查看 AX 快照，确认表单元素
run_terminal_command(command="tabtin desktop accessibility-tree")
# → 找到 Edit "Email"、Edit "Password"、Button "Login" 等

# 3. 按元素名直接输入——不需要先点击再输入
run_terminal_command(command="tabtin desktop type-into-element --name 'Email' 'user@example.com'")
run_terminal_command(command="tabtin desktop type-into-element --name 'Password' 'my_pwd_123'")

# 4. 按元素名点击登录按钮
run_terminal_command(command="tabtin desktop click-element --name 'Login' --role Button")

# 5. 截屏验证登录结果
run_terminal_command(command="tabtin desktop screenshot")
```

### 场景 3：跨应用复制粘贴（Safari → Notes）

**前置**：Safari 和 Notes 都已启动（两者都是 macOS 内置应用，默认都在）；如果 allowedApps 限定了白名单，两个应用名都要在列表里（精确匹配，完整名 `Safari` / `Notes`）。

```bash
# 1. 第一步必须 screenshot——它是建立 session、触发审批、冻结坐标系的入口
run_terminal_command(command="tabtin desktop screenshot")

# 2. 激活源应用 Safari 并再次截屏定位要复制的内容
run_terminal_command(command="tabtin desktop activate 'Safari'")
run_terminal_command(command="tabtin desktop screenshot")

# 3. 三击选中整段文本，复制
run_terminal_command(command="tabtin desktop click 400 250 --count 3")
run_terminal_command(command="tabtin desktop hotkey cmd c")

# 4. 切换到目标应用 Notes 并截屏定位粘贴位置
run_terminal_command(command="tabtin desktop activate 'Notes'")
run_terminal_command(command="tabtin desktop screenshot")

# 5. 点击目标位置并粘贴
run_terminal_command(command="tabtin desktop click 300 200")
run_terminal_command(command="tabtin desktop hotkey cmd v")
run_terminal_command(command="tabtin desktop screenshot")
# → 验证粘贴结果
```

### 场景 4：桌面应用测试（Electron 应用登录流程）

**前置**：目标 Electron 应用已安装到 `/Applications/` 或等价标准位置；测试用的账号 / 密码已准备好（建议用测试账号而非真实生产凭据，避免审计留痕）。

```bash
# 1. 首次截屏，触发审批 + 建立 session
run_terminal_command(command="tabtin desktop screenshot")

# 2. 启动目标 Electron 应用（已运行则激活）
run_terminal_command(command="tabtin desktop open 'TabTin'")
run_terminal_command(command="tabtin desktop screenshot")
# → 验证 TabTin 窗口已出现

# 3. 点击登录按钮（坐标来自上一步截图分析）
run_terminal_command(command="tabtin desktop click 640 400")
run_terminal_command(command="tabtin desktop screenshot")
# → 验证登录对话框已弹出

# 4. 填写登录表单
run_terminal_command(command="tabtin desktop click 500 280")
run_terminal_command(command="tabtin desktop type 'test@example.com'")
run_terminal_command(command="tabtin desktop key Tab")
run_terminal_command(command="tabtin desktop type 'my_password_123'")
run_terminal_command(command="tabtin desktop key Enter")
run_terminal_command(command="tabtin desktop screenshot")
# → 验证登录成功（看到主界面）

# 5. 触发关键业务操作并截屏跟踪
run_terminal_command(command="tabtin desktop click 200 300")
run_terminal_command(command="tabtin desktop screenshot")
# → 验证业务操作结果
```

### 场景 5：桌面内联动（截图整理 → Notes → Mail）

**前置**：桌面 Mail 应用已配置至少一个邮件账户并能正常发信。TabDesktop 会话第一步必须是 `tabtin desktop screenshot`。

```bash
# 阶段 1：首次截屏触发审批 + 建立 session
run_terminal_command(command="tabtin desktop screenshot")

# 阶段 2：在桌面 Notes 中整理（按应用名打开 → 粘贴本地图片路径）
run_terminal_command(command="tabtin desktop open 'Notes'")
run_terminal_command(command="tabtin desktop screenshot")
run_terminal_command(command="tabtin desktop click 400 300")
run_terminal_command(command="tabtin desktop type '~/Downloads/chat.png' --clipboard")
run_terminal_command(command="tabtin desktop screenshot")
# → 确认图像路径已插入

# 阶段 3：切换到 Mail 应用（也可走完整 .app 路径形式打开）
run_terminal_command(command="tabtin desktop activate 'Mail'")
run_terminal_command(command="tabtin desktop screenshot")
run_terminal_command(command="tabtin desktop hotkey cmd n")
run_terminal_command(command="tabtin desktop screenshot")
# → 新邮件窗口已弹出

# 阶段 4：填写收件人 / 主题 / 正文
run_terminal_command(command="tabtin desktop click 400 200")
run_terminal_command(command="tabtin desktop type 'boss@example.com'")
run_terminal_command(command="tabtin desktop key Tab")
run_terminal_command(command="tabtin desktop type 'Weekly Summary'")
run_terminal_command(command="tabtin desktop key Tab")
run_terminal_command(command="tabtin desktop type '详见附件' --clipboard")

# 阶段 5：发送（mac Mail 快捷键 cmd+shift+d）并截屏验证
run_terminal_command(command="tabtin desktop hotkey cmd shift d")
run_terminal_command(command="tabtin desktop screenshot")
# → 确认发送成功
```
