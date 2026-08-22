# 选项类字段的选项管理

## 基本信息

- 用例 ID：`tabdata.select-option-management`
- 所属能力：TabData / 字段管理 / 选项类字段选项管理
- 优先级：P0
- 自动化场景文件：`tests/electron/scenarios/tabdata-select-option-management.scenario.ts`
- 目标命令：`pnpm e2e:run --scenario tabdata.select-option-management`

## 测试目标

验证 TabData 选项类字段支持已用选项重命名：

- 重命名已被使用的选项后，所有使用该选项的记录同步显示新名称。

## 前置条件

- TabTin Electron 已启动。
- Django、Collab Live、Centrifugo 等 dev stack 已启动。
- 用户已登录，并进入一个 Space。
- Space 中已启用“多维表”。
- 准备一张测试表，名称建议为“选项管理验收表”。
- 表中包含字段：
  - `客户名称`：文本字段。
  - `状态`：单选字段。
- `状态` 字段初始选项：
  - `待处理`
  - `进行中`
  - `已完成`
- 至少两条记录的 `状态` 为 `进行中`。
- 至少一条记录的 `状态` 为 `待处理`。

## 用户操作步骤

1. 打开 TabTin Electron。
2. 进入目标 Space。
3. 点击左侧“多维表”入口。
4. 在多维表资源列表中打开测试表“选项管理验收表”。
5. 确认进入表格编辑页，可以看到 `客户名称` 和 `状态` 字段。
6. 打开 `状态` 字段的字段设置或选项管理入口。
7. 将已被使用的选项 `进行中` 重命名为 `处理中`。
8. 保存或确认重命名。
9. 回到表格记录区域。
10. 观察所有原来状态为 `进行中` 的记录。
11. 确认这些记录现在都显示为 `处理中`。
12. 刷新或重新打开该表。
13. 再次确认重命名后的结果保持一致。

## 预期结果

- `进行中` 重命名为 `处理中` 后，所有使用该选项的记录同步显示新名称。
- 刷新或重新打开表格后，最终状态仍然保持一致。
- 整个过程中不应出现白屏、错误 toast、数据回滚异常或记录显示不一致。

## 自动化契约

自动化实现必须尽量贴近上述用户流程。不能只通过后端 service 直接修改字段配置来替代整条 UI 流程。

最低可接受自动化覆盖：

- 必须打开 Electron 中的具体 TabData 表格编辑页，而不是停留在多维表资源列表页。
- 必须通过 Electron 字段设置面板修改选项输入框并点击保存，不能用后端 service 直接改字段配置。
- 重命名已用选项后，必须验证至少两条原使用记录都显示新名称。
- 证据包必须包含结构化快照，说明重命名前的初始数据、UI 保存结果和记录最终值。

未达到上述最低覆盖时，即使后端数据断言通过，也只能视为“后端语义验收”，不能标记为完整 Electron UI E2E。

## 证据要求

运行后应在证据包中至少保留：

- `summary.md`：用例通过/失败摘要。
- `result.json`：结构化步骤结果。
- `snapshots/select-option-management-prepared.json`：重命名前的初始表、字段和已用记录。
- `snapshots/select-option-management-ui-rename.json`：Electron 字段设置面板保存后的 renderer 取证。
- `snapshots/select-option-management-verify-rename.json`：重命名后字段选项与已用记录最终值。
- 能证明 Electron 已打开具体表格编辑页的 renderer 取证或 probe 日志。
- 如果失败，`issueDraft.md` 应说明失败发生在字段保存、记录同步或刷新确认的哪一步。

