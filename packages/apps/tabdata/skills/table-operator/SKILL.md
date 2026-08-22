---
name: table-operator
description: >
  多维表操作——加字段、改记录、删行、批量插入更新、记录评论协作、
  搜索记录、建看板 / 表单视图、转换字段类型。
  用户正在操作某张表格时的默认入口；要建多张关联表先走
  table-modeling 做形态决策，统计分析查询走 table-query。
metadata:
  version: 0.4.11
  tabtin:
    category: data
    displayName: "Table Operator"
    autoActivateFor:
      - tabdata
    tools:
      - run_terminal_command
---

# Table Operator

表格是 TabData 的核心对象，每张表由**字段（Field）**和**记录（Record）**组成。
所有操作统一通过 `tabtin table` CLI 完成（按 D6 北极星：tabdata + tabweb 数据采集链 0 次 FC，
GUI bridge 类 FC 不在该边界内，按需正常使用）。

> **做关联表 / 列表+详情 / 双表设计 / 任何"建几张表"决策**之前，**必须先**
> 网页采集整链落表 → `skills_read("app:tabdata/collect-to-table")`。
> `skills_read("app:tabdata/table-modeling")` 拿决策树——本 SKILL 只覆盖**单表 CRUD**，
> 不解释单表与双表 link 的形态选择，瞎建会留隐患。

## 意图规则（看板 / 视图）

| 用户说法 | 必须行为 |
|---------|---------|
| 「加 / 新建 / 创建看板（或视图）」 | **必须**执行 `view create`，不得因 `view list` 已有同名/同类看板就复用 |
| 「确保有看板 / 没有就建」 | 才允许先 `view list`，有则复用、无则 `view create` |
| 「把某列卡片拖到另一列 / 改单选值」 | 用 `record update`（优先批量或 `--set`），**禁止**改走 Browser |

不得因为发现旧看板就擅自改变用户目标（例如用户说「加个看板」却只汇报「已有看板可用」）。

## 方法路由

| 目标 | CLI 命令 |
|------|---------|
| 创建表格 | `tabtin table create --name "表名" --fields '[...]'`；挂知识库父资源加 `--parent-item-id <context_item_id>` |
| 知识库树中移动表格 | `tabtin table move --table-id <id> --parent-item-id <context_item_id>` 或 `--root` |
| 查看表结构 | `tabtin table info --table-id <table-id>` |
| 添加普通字段 | `tabtin table field add --table-id <id> --name "字段" --field-type text` |
| 添加 link | **形态决策**先 `skills_read("app:tabdata/table-modeling")`；**挂/解绑关联边**走 `skills_read("app:tabdata/table-association")`（`table link create/add/set/remove/list`） |
| 批量添加字段 | `tabtin table field bulk-add --table-id <id> --fields '[...]'`（普通字段和 link 可同批） |
| 插入单条记录 | `tabtin table record insert --table-id <id> --data '{...}'` |
| 批量插入 | `tabtin table record bulk-insert --table-id <id> --records '[...]'` |
| 更新记录（简单） | `tabtin table record update --table-id <id> --record-id <rid> --set "字段=值"` |
| 更新记录（JSON） | `tabtin table record update --table-id <id> --record-id <rid> --data '@patch.json'` |
| 批量更新记录 | `tabtin table record update --table-id <id> --records '@records.json'` |
| 删除记录（永久删除） | `tabtin table record delete --table-id <id> --record-id <rid> --yes` |
| 记录评论 | `tabtin table record comment list\|create\|reply\|rm`；回复必须用 `reply <record-id> <comment-id>` |
| 字段影响预检 | `tabtin table field explain\|delete-references\|conversion-references` |
| 列表记录 | `tabtin table record list --table-id <id>` |
| 按复制链接读取记录 | `tabtin table record detail "<TabTin 记录链接>" --format json` |
| 按关键词搜记录 | `tabtin table search --table-id <id> --search "<关键词>"`（有搜索词时必须用它，别用 `record list` 冒充 search；支持 `--field-id` 限定字段、`--view-id` 限定视图、`--take` 控制返回数） |
| SQL 查询 | `tabtin table query "SELECT ..."` |
| SQL 写入 | `tabtin table execute "UPDATE ..."` |
| 字段类型转换 | `tabtin table field convert --field-id <fid> --target-type <type>` （先 `field list` 拿 field-id；高风险转换加 `--force` 或 `--async`） |
| 创建看板视图 | `tabtin table view create --table-id <id> --name "看板" --view-type kanban --group-by-field-id <可分组字段ID>`（**必须**显式指定分组字段；`select` 为推荐类型，非硬要求；排除 attachment；复杂分组才用 `--groups`） |
| 查询视图记录 | `tabtin table view records --view-id <view-id>` |

> **SQL 查询/写入** → 使用 `skills_read("app:tabdata/table-query")` 获取 SQL 规则。
> **数据导入/提取** → 使用 `skills_read("app:tabdata/table-import-export")` 获取导入导出指南。
> **关联建模（单表还是双表 link）** → `skills_read("app:tabdata/table-modeling")`。
> **关联运行时（挂/解绑/查候选）** → `skills_read("app:tabdata/table-association")`。
> 本 SKILL 只覆盖单表 CRUD，不解释关联形态与边操作。

## 注意事项

- **搜索走 `table search`，不要用 list 冒充**：用户说「找 / 搜 / 查一下 XX 记录」时必须走 `tabtin table search --table-id <id> --search "<关键词>"`——它是专门的全文搜索端点（`POST /table/search`），命中率与相关性都比 `record list --search` 的列表过滤好。`record list` 是列表命令，`--search` 只是辅助过滤，不要用它冒充搜索。需要限定范围时加 `--field-id` / `--view-id`，控制返回数加 `--take`。
- **先查结构再操作**：写操作前先 `tabtin table info --table-id <table-id>` 确认字段名和类型。
- **批量优先**：多条记录用 `record bulk-insert` / 一次 `--records` 批量更新，避免逐条插入/更新。
- **批量上限（单次）**：`record bulk-insert` ≤ **1000 条**（`MAX_BULK_RECORDS`）、`record list --page-size` ≤ **1000 条/页**（`MAX_PAGE_SIZE`）、`field bulk-add` ≤ **50 字段**（`MAX_BULK_FIELDS`）。超过就分批——1500 行要 2 页拉、写两次 bulk-insert。
- **高风险命令必须显式确认**：所有 `RiskHigh` / destructive 命令不带 `--yes` 会被 CLI 拦截。常见例子包括 `record delete --yes`、`field delete --yes`、`view delete --yes`、`import snapshot --yes`、`attachment delete --yes`、`webhook delete --yes`、`token delete --yes`、`version delete --yes`、`policy delete --yes`、`collaborator remove --yes`；不确定时先看对应命令的 `--help`。
- **上下文已有字段信息时不要重复查询**：系统会自动注入当前表的字段列表。
- **工具报错时先分析原因，不要盲目重试**。
- **建表 / 写入失败（`QUOTA_EXCEEDED` 表格数量已达上限、`PERMISSION_DENIED` 等）时**：把可执行原因摊给用户（删表 / 升级 / 换 Organization），**不要**绕过平台改写本地文件（尤其 ~/Desktop 等 working_dir 之外路径）当交付——产物只落 Organization 内 TabData 表或 working_dir。详见 `skills_read("app:tabdata/table-import-export")`。
- **禁止 Browser 降级**：TabData 数据操作（字段/记录/视图/看板）一律走 `tabtin table` CLI。L2 CLI 失败时，最多按下方「Windows 安全输入」重试一次；随后报告真实错误（保留 CLI/后端错误码与请求标识），**不得**改走网页 Browser、SQL 逃生口，或让用户手动在 UI 完成。
- **没有读回证据禁止宣称成功**：缺 `view detail` / `record list|detail` 读回前，禁止输出「搞定」或成功任务卡。

## 当前 CLI 能力索引

`tabtin table` 当前覆盖 162 条命令（2026-08-14，复现：`go run . commands --json` 过滤 `table`）。常用 CRUD 在本 SKILL 里；遇到下列目标直接看对应 `--help`：

| 目标 | 命令组 |
|---|---|
| 表属性 / 搜索 / 软删恢复 | `table update/delete/archive/restore/stats/search/trash` |
| 记录详情 / 评论 / 重排 / 历史 / 撤销重做 | `table record detail/comment/reorder/history/undo/redo` |
| 字段详情 / 更新 / 删除 / 排序 / 类型转换预检 | `table field detail/update/delete/reorder/check/preview/convert` |
| 视图详情 / 视图记录 / 统计 / 表单分享 | `table view detail/update/delete/records/statistics/form-share-*` |
| link 创建 / 挂解绑 / 列表 / 候选 / select 选项填充 | `table link create/set/add/remove/list/linkable-*/populate-choices`（详 `table-association`） |
| 同表父子层级 | `table sub-record create/move/parent-field/ensure-parent-field/self-link-fields/reorder-tree` |
| 导入导出 / 附件 / webhook / 版本 / 表历史 | `table import/export/attachment/webhook/version/history` |
| API Token / 公开表单 / 协作者 / RLS / 全文索引 | `table token/form/collaborator/policy/search-index` |

## CLI 使用指南

### Windows 安全输入（结构化 JSON）

Windows / PowerShell 下**禁止** inline JSON（引号会被剥掉）。复杂载荷统一：

1. 用 `write_file`（或 `python -c "import json; json.dump(...)"`）写入 `.agent-drafts/<name>.json`（**UTF-8 无 BOM**）
2. 传参时用**带引号**的 `@file`：`--groups '@.agent-drafts/groups.json'`、`--data '@.agent-drafts/patch.json'`、`--records '@.agent-drafts/records.json'`
3. 简单单字段更新优先 `--set "字段=值"`（含 `"标题=123"`），完全不走 JSON

未加引号的 `@file` 在 PowerShell 里可能被当成 splatting——必须加引号。

> **禁止**用 PowerShell 5.x 的 `Set-Content -Encoding utf8` 写 JSON——它会写 BOM，导致 `--data/@records` 在路由层变成字符串而不是对象/数组。优先 `write_file` / `python json.dump` / `Out-File -Encoding utf8NoBOM`（PS 7+）。

### 建表（含字段定义）

一步完成建表 + 加字段：

```bash
tabtin table create --name "用户表" --fields '[
  {"name":"姓名","field_type":"text"},
  {"name":"年龄","field_type":"number"},
  {"name":"邮箱","field_type":"email"},
  {"name":"注册日期","field_type":"date"},
  {"name":"文章链接","field_type":"url"}
]'
```

字段类型挑对再建：URL / 链接 / 网址列必须用 `field_type":"url"`，不要写成 `text`
（CLI 会对「*链接 / *url」类列名做 text→url 纠偏，但模型应直接写对）。

返回 `table_id`，后续操作均需此 ID。Windows 下把 `fields` 写入 `.agent-drafts/fields.json` 后用 `--fields '@.agent-drafts/fields.json'`。

### 添加字段

```bash
tabtin table field add --table-id <id> --name "状态" --field-type select --options '{"choices":["待处理","进行中","已完成"]}'
# select / multi_select 必须带 options.choices；只写 field_type 会导致下拉无选项。
# 漏传时，后续 record 写入会把单元格值自动补进 choices。
```

批量添加：

```bash
tabtin table field bulk-add --table-id <id> --fields '[
  {"name":"优先级","field_type":"select","options":{"choices":["高","中","低"]}},
  {"name":"截止日期","field_type":"date"}
]'
```

### 记录操作

TabData 右键「复制记录链接」会生成不携带 Space / Workspace 上下文的稳定
`tabtin://` 资源链接；读取时把链接作为位置参数，更新时用 `--url`。旧版本复制的
本地页面 URL 也继续兼容，两种链接都会复用当前 TabTin Profile 的授权
（Electron 已登录时走 managed profile，**不必**先 `tabtin agent use`）：

```bash
tabtin table record detail "tabtin://resource/table/<table-id>?hint=tabdata&recordIds=<record-id>" --format json
tabtin table record update --url "tabtin://resource/table/<table-id>?hint=tabdata&recordIds=<record-id>" --set "状态=完成"

tabtin table record detail "http://127.0.0.1:5175/table/<table-id>/record/<record-id>" --format json
tabtin table record update --url "http://127.0.0.1:5175/table/<table-id>/record/<record-id>" --set "状态=完成"
```

`tabtin://` 链接必须通过 `recordIds` 指定恰好一条记录，不携带 Space / Workspace
上下文。旧的 `--table-id` + `--record-id` 方式继续支持；不要让 Agent 手工拆链接后再拼 ID。

**硬约束（记录链接）**：看到 `tabtin://resource/table/...?recordIds=` 或
`/table/<id>/record/<id>` 时，**必须**用上面的 `table record detail` /
`table record update --url`。**禁止**退回 `manage.py shell`、直连 Django ORM、
或手工拆 UUID 后拼其它旁路。CLI 报错时先修 Profile / 鉴权 / 链接合法性，
不要换数据源。

插入单条：

```bash
tabtin table record insert --table-id <id> --data '{"姓名":"张三","年龄":28,"邮箱":"zhang@example.com"}'
```

批量插入（单次 ≤1000 条）：

```bash
tabtin table record bulk-insert --table-id <id> --records '[
  {"姓名":"张三","年龄":28},
  {"姓名":"李四","年龄":32}
]'
```

更新（优先 `--set`，可重复）：

```bash
tabtin table record update --table-id <id> --record-id <rid> --set "测试单选=好吧"
tabtin table record update --table-id <id> --record-id <rid> --set "标题=123"
tabtin table record update --table-id <id> --record-id <rid> --set status=done --set score=3
# --set 一律按字符串保留（含 123/true/null）——文本/单选列直接用它。
# 需要 JSON 数字/布尔/对象/数组时，走 --data '@.agent-drafts/patch.json'。
# 需要字段 UUID 作 key 时加 --field-key-type id（主要影响响应 key 形态）
```

批量移动 / 批量改字段（一次 `--records`）：

```bash
# 先 write_file 到 .agent-drafts/records.json（UTF-8 无 BOM），再：
tabtin table record update --table-id <id> --records '@.agent-drafts/records.json'
```

### 记录评论协作

先列出评论拿到目标 `comment.id`，回复时同时传记录 ID 与父评论 ID。不要用 `comment create`
模拟回复；独立评论才用 `create`。每次写入都生成并保存 `client_request_id`，重试同一次写入时
必须复用原值，避免重复评论：

```bash
tabtin table record comment list <record-id> --format json
tabtin table record comment reply <record-id> <comment-id> \
  --content "已核对，负责人正确" \
  --mention-user-ids '["<user-id>"]' \
  --client-request-id <request-id> \
  --format json
```

返回的 `comment.reply_to.id` 必须等于目标父评论 ID。父评论不存在、已删除或不属于当前记录时，
服务端会返回“回复的评论不存在”；应重新 `list` 核对记录与评论，不要降级成新增独立评论。
Agent 署名由当前受信任的运行/会话上下文自动携带，禁止尝试传 `agent_id`。

### 看板：新建流程（强制）

用户说「加/新建看板」时按此顺序，**不得跳步**：

```bash
# 1) 找可分组字段 ID（非 attachment；select 为推荐，text/date/checkbox 等亦可）
tabtin table field list --table-id <id> --format json

# 2) 新建看板（一等参数，勿拼底层 groups JSON；必须显式指定 group_by_field）
tabtin table view create --table-id <id> --name "跟进看板" --view-type kanban \
  --group-by-field-id <groupable_field_id>

# 3) 读回验收：config.group_by_field 与 groups[0].field_id 必须指向该字段
tabtin table view detail --view-id <view_id> --format json
```

复杂多级分组才用 `--groups '@.agent-drafts/groups.json'`（与 `--group-by-field-id` 互斥）。

> **禁止**在未核对 `view detail` 的 `group_by_field` / `groups` 前，向用户宣称「已按某某字段分列」。表里没有可用的非文件型字段时如实说明；创建后漏分组用 `view update --view-id <id> --groups '...'` 补充分组（改分列请传 `--groups`，不要只改 `--config`）。分组契约正典见 `docs/agent/tabdata-view-grouping-contract.md`。

### 看板：移动卡片流程（强制）

```bash
# 1) 找到源列记录（按关键词或列表）
tabtin table search --table-id <id> --search "321" --format json
# 或 tabtin table record list --table-id <id> --format json

# 2) 优先一次批量更新；简单单条用 --set（文本数字如 123 直接 --set "标题=123"）
tabtin table record update --table-id <id> --records '@.agent-drafts/move.json'
# 单条：
tabtin table record update --table-id <id> --record-id <rid> --set "标题=123"

# 3) 读回确认：空源值记录数应为 0；目标列（如 标题=123）数量增加；必要时再 view detail
tabtin table view detail --view-id <view_id> --format json
tabtin table record list --table-id <id> --format json
# / tabtin table record detail --record-id <rid> --format json
```

没有步骤 3 的读回证据，禁止输出「搞定」或成功任务卡。

> **写失败后禁止污染试错**：`--set` / `--data` / `--records` 首次失败时，先核对参数形态与错误码；**不得**用 `abc`、引号、临时占位值写进真实记录做探测。需要验证契约时用 dry-run 或只读命令。

### 大批量数据写入

单次 `bulk-insert` 上限 1000 条，超过分批；更大数据量（文件 / stdin 导入）走
`skills_read("app:tabdata/table-import-export")`。
