---
name: collect-to-table
description: Use when 用户要把网页采集结果或已有成批结构化数据落入多维表，且数据含嵌套明细、可复用对象、关联或反查需求，或落库前需要判断单表还是多表；也用于要求可重跑、批次覆盖或采集后直接建表。
metadata:
  version: 0.1.9
  tabtin:
    category: data
    displayName: "采集落多维表"
    autoActivateFor:
      - tabdata
      - tabweb
    tools:
      - run_terminal_command
    tags:
      - orchestration
      - requires-body
      - collect
      - table
  runtime: cloud
  requires:
    bins:
      - tabtin
  canonicalName: collect-to-table
---

# 采集落多维表 V2

## 核心原则

先判断数据结构，再确认分表方案，再确认是否复用历史表，最后写入并验证。简单扁平数据可豁免分表确认；任务内新建的表可直接复用；工作区里本轮之前已有的表，写入前必须一次性问清能否复用。

## 输入范围

接受两类输入：

- 尚无数据：按需加载 `app:tabweb/browser-collect`，获得结构化采集结果。
- 已有数据：接手用户提供的 JSON、JSONL、CSV、对象数组或等价结构，不要求重新采集。

当来源是**当前已登录网页**时，先在 Browser Operator 中锁定当前 Tab，保留登录态与用户已经展开 / 筛选后的页面状态，再调用 `app:tabweb/browser-collect` 或当前 Tab 的 JSON Schema 投影形成结构化数据。不要因为来源 URL 属于某个第三方站点而切换成该站点的资产迁移 CLI。

网页采集的 bundle 必须保留来源链接与获取时间；资源或字段抓取失败时记录缺失项，不能用常识补值，也不能只凭写表命令成功就声称完整导入。

把输入统一为 CollectBundle。字段契约见 [references/bundle-contract.md](references/bundle-contract.md)，仅在需要整理或检查输入时读取。

## 状态与阶段

依次执行，不能跳过阶段：

| 阶段 | 必须产出的状态 |
|---|---|
| 1. 接手数据 | `bundle`、`task_id`、预期记录数 |
| 2. 识别结构 | 主实体、明细、可复用对象及其候选键 |
| 3. 方案门闩 | `confirmed_plan`，或明确记录 `flat_exemption=true` |
| 3.5 复用门闩 | `reuse_plan`，并维护 `task_created_table_ids` |
| 4. 写入 | 表 ID、字段 ID、关联字段、实际写入数（遵守 `reuse_plan`） |
| 5. 验证 | 与方案对应的验收结果全部通过 |
| 6. 复盘 | 表名、条数、关联、合并策略和缺失项 |

阶段 3.5 细则见 [references/reuse-plan.md](references/reuse-plan.md)。无历史候选时可写空 `reuse_plan` 并跳过 `ask_user`；有历史候选且尚无完整 `reuse_plan` 时，禁止进入写入。

任何阶段缺少对应状态，不得进入下一阶段。

## 识别数据角色

只使用通用角色，不预设业务表名：

- **主实体**：用户要保存的顶层对象，一条记录对应一个主对象。
- **明细**：主实体下的列表项，例如评论、SKU、章节或参与记录。
- **可复用对象**：会跨多个主实体重复出现，并可能需要反查的对象，例如人员、标签或机构。

主实体和可复用对象默认按稳定业务键合并。明细默认按本次 `task_id` 做批次快照，不因自造明细键而自动改成长期合并。

## 方案门闩

先计算：

```text
requires_confirmation =
  存在嵌套列表
  OR 存在两个及以上可独立存在的实体
  OR 用户要求关联、一对多或跨实体反查
  OR 同一可复用对象跨主实体重复出现
```

### `requires_confirmation = true`

如果还没有 `confirmed_plan`：

1. 下一次工具调用必须是 `ask_user`。
2. 一次性展示推荐方案和替代方案。
3. 收到用户选择后写入 `confirmed_plan`。
4. 用户回复前，禁止调用任何 `table create`、`field add`、`link create`、`import`、`bulk-insert`、`upsert`、`update` 或其他写表命令。

确认卡使用产品语言，不说 A/B/C：

- 推荐：主实体、明细分别成表并关联；检测到可复用对象时说明是否建议单独成表。
- 备选：只建一张扁平表。
- 调整：允许用户修改分表数量、表名及追加或覆盖策略。

### `requires_confirmation = false`

仅在以下任一可观察条件成立时设置 `flat_exemption=true` 并直接写一张表：

- 数据只有标量字段，没有嵌套列表、独立子实体和反查需求。
- 用户已经明确要求“一张表、扁平、不要关联”。
- 用户要求按本次对话中已经确认的方案重跑，且 `confirmed_plan` 仍在状态中。

不确定是否满足豁免时，按 `requires_confirmation=true` 处理。

## 复用门闩

在方案门闩完成之后、写入之前执行。完整规则读 [references/reuse-plan.md](references/reuse-plan.md)。

摘要：

1. 维护 `task_created_table_ids`（本轮 `table create` 成功则追加）。
2. 用 `table list` / `table info` 找同角色候选；任务内表可直接复用。
3. 存在历史候选且尚无完整 `reuse_plan` 时：下一次工具调用必须是 `ask_user`；用产品语言说明发现了哪些可复用历史表并询问能否复用（措辞由你按场景生成，不要求固定开场句）；默认勾选复用；提供「全部新建」与「其他」。
4. 多张历史表合并一次确认，禁止逐张询问。
5. 用户回复前，禁止任何写表命令（与方案门闩相同禁止清单）。

## 按阶段加载工兵 Skill

不要一开始批量读取所有相关 Skill：

- 没有结构化数据时，只加载 `app:tabweb/browser-collect`。
- 用户确认多表方案后，按需加载 `app:tabdata/table-modeling` 和 `app:tabdata/table-association`。
- 准备批量导入或需要确认值格式时，再加载 `app:tabdata/table-import-export`。
- 已有简单单表且只做 CRUD 时，转交 `app:tabdata/table-operator`，不要继续本编排。

## 写入与验证

进入写入阶段前，必须已有完整 `reuse_plan`（见 [references/reuse-plan.md](references/reuse-plan.md)），再读取 [references/write-and-verify.md](references/write-and-verify.md) 并按其中顺序执行。

必须满足：

- 多行写入使用批量命令；少量定向补救才允许单行操作。
- 明细同 `task_id` 重跑时先清除本批旧行，再写入本批全集。
- 关联值使用记录 ID 数组，不写姓名等普通字符串。
- 验收失败只定向补救；未经用户明确要求，不整表重建或整链重采。
- 所有适用断言通过前，不得向用户声称完成。

## 最终复盘

只在验证通过后汇报：

1. 建立或复用了哪些表，以及关联方向。
2. 主实体、明细、可复用对象分别写入多少条。
3. 使用什么业务键合并，哪些数据按本批覆盖。
4. 是否存在部分采集、失败项或弱键重名风险。
5. 用户应在多维表 App 中打开哪些表查看结果。

## 常见错误

| 错误 | 正确处理 |
|---|---|
| 把 `skills_read` 当成已经执行 Skill | 任务执行必须先 `skill_invoke` |
| 读完 Skill 后直接说“我开始建表” | 命中方案门闩或复用门闩时，下一次调用只能是 `ask_user` |
| 查到历史同角色表就直接 upsert | 先走复用门闩，一次确认能否复用 |
| 历史表一张一张 `ask_user` | 合并为一张确认卡（含全部新建 / 其他） |
| 为了省事把嵌套明细塞进一个文本列 | 先让用户选择分表或扁平方案 |
| 对明细只做 upsert | 同任务重跑默认先清本批旧行再批量写入 |
| 一开始加载全部表格和浏览器 Skill | 按当前阶段只加载必要工兵 |
| 只看命令成功就宣告完成 | 读取验证参考并核对行数、关联和批次快照 |
