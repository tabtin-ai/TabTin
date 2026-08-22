---
name: table-import-export
description: >
  多维表导入导出——导入 JSON/JSONL、CSV、Excel 写进多维表，
  导出表格为 CSV / Excel / PDF 文件交付。手上已有结构化文件/JSON 要写进表、
  或要把表导出成文件时调用；建表走 `table create`（字段类型自定），
  导入可自动补建缺失字段；写 link 字段值、
  建表失败怎么办也看这份。
  若需求是「从网页/浏览器采集并落多维表」（含分表确认与关联），改走
  app:tabdata/collect-to-table；本 skill 只在编排确认方案后负责写入格式。
metadata:
  version: 0.4.8
  tabtin:
    category: data
    displayName: "Table Import & Export"
    autoActivateFor:
      - tabdata
    tools:
      - run_terminal_command
---

# Table Import & Export

从网页、文本或文件中提取结构化数据并写入 TabData 表格。

> **当前网页数据建成多维表**属于通用网页采集：先用当前 Tab / `browser-collect` 得到 JSON、JSONL 或 CSV，再由 `collect-to-table` 编排本 skill 的 `table import json` / `table import csv` 等能力写入。来源站点不改变这条路线。
> 只有用户**明确要求迁移飞书云盘、飞书知识库或飞书资产**时，才使用 `skills_read("app:tabtin-integrations-lite-pack/feishu-import-to-org")` 与 `tabtin feishu *`；仅凭 URL 或域名不能改走飞书专用通道。

> **先拿最权威的数据源，再让 LLM 做字段映射和清洗。** 静态正文、半结构文本可以直接让 LLM 提取；动态列表 / 搜索页 / API JSON 场景里，源 JSON 是第一数据源，LLM 负责建模、字段命名、类型推断和去重。

## 写入前的数据真实性门禁

导入的目标是把来源里的真实信息结构化，不是把每个单元格都填满。写入前先做一次字段来源对照：

| 字段情况 | 写入规则 |
|---|---|
| 来源直接提供 | 原样映射；多来源时给每行保留对应来源 |
| 可确定性计算 / 换算 | 可以写入，但同时保留原始值，并记录公式或换算规则 |
| 来源没有 | 省略该值或写 `null`；禁止用常识、均值或“合理估计”补齐 |

- 外部网页 / API 数据应保留来源链接和获取时间；同一批只有一个来源时可放在表说明，
  多来源或需要逐行追溯时增加“来源链接”“获取时间”字段。
- 来源字段与目标字段语义不完全一致时不要强塞。例如“风力 4-5 级”不等于来源直接提供了
  精确的 `km/h`；若换算，必须保留“4-5 级”并说明换算规则。
- 写入命令返回成功不等于所有数据都成功：以回执中的 `success_count`、`failed_count`、
  `errors` 为准；有失败时明确报告，不得只说“全部完成”。
- `--dry-run` 和 import preview 只用于预演，不能作为“已导入”的完成凭证。
- 写入回执已经给出成功 / 失败条数时，以它作为主要完成凭证；没有异常时不要为了证明完成，
  连续改写查询命令反复读取同一批记录。

最终回复至少包含：目标表、真实成功 / 失败条数、数据来源，以及因缺少可靠来源而留空的字段。

## 第 0 步：先做「形态决策」，再考虑导入

接到「采集 X 列表 + 每个 X 的子项 Y」「关联表格」「主表 + 详情」类需求时，
**不要直接奔 `tabtin table create`**——先决定建几张表、字段怎么挑：

| 用户场景 | 落到 |
|---|---|
| 详情都是标量（评分/参数/单价） | **形态 A 单表** |
| 子项无需独立查询 | **形态 A 单表**，用文本或普通字段表达 |
| 子项是独立实体、需要反向查 / 跨主行复用 | **形态 B 双表 + link** |

完整的反问模板、决策树、ABC 三种形态的端到端示例（豆瓣电影 + 演员）都在
`skills_read("app:tabdata/table-modeling")`——本 SKILL 只负责"决定好之后怎么写入"，
不要在这里重复决策内容。

## 方法选择

| 场景 | 推荐方式 | 说明 |
|------|---------|------|
| 新建表格写入数据 | `tabtin table create` → `tabtin table record bulk-insert` | 先建表（含字段），再写入；**key 必须是字段显示名** |
| 追加到已有表格 | `tabtin table record bulk-insert --table-id <id>` | 直接写入已有表 |
| 按业务键去重写入 | `tabtin table record upsert --upsert-on '["键字段"]'` | 命中则更新、未命中则建；**不返回 record_id 映射** |
| 从文件导入 | `tabtin table import json --table-id <id> --file <path>`（csv / excel 同理） | JSON/CSV/Excel 文件导入；支持智能字段映射与补建缺失字段。**`--table-id` 必填**——import 不会自动建表 |
| 下载导入模板 | `tabtin table import template --table-id <id> --file-format json --output ./tpl.json` | 生成 **JSON 对象数组**：key=字段显示名（表头），至少 **2 行**示例（便于看出如何分行）；UI「下载 JSON 模板」同形。改示例值为真实数据后 `import json`。若文件是两行纯文本（像 CSV），不是合法 JSON，请重新下载 |
| 导入预览 | `tabtin table import preview --table-id <id> --file-type json --file <path>` | 写入前检查字段映射和样例（file-type: csv\|excel\|json） |
| 导出文件 | `tabtin table export excel/csv/pdf --table-id <id> --output <path>` | `--output` 为本地路径；**JSON 导出当前关闭**，需要 JSON 时用 `record list --format json` |
| 大表导出 / 大文件导入 | `export ... --async` + `export wait` + `export download`；`import file` | 同步通道超时才用；见下方「场景四」 |
| 工作区快照 | `tabtin table import snapshot --yes`、`tabtin table export snapshot` | 迁移场景；导入快照高风险，必须 `--yes` |
| 写关联字段值（form C） | 见下方「写入 link 字段」段 | link 值格式 `[{"id":"<目标 record UUID>"}]` |

## 工作流

### 场景一：新建表格 + 写入数据

```bash
# 1. 建表（含字段定义）
# select / multi_select 务必带 options.choices；否则列表与字段设置里没有可选项。
# 若漏传，bulk-insert 写入的值会自动补进 choices，但建字段时写全更稳妥。
tabtin table create --name "投资事件" --fields '[
  {"name":"公司","field_type":"text"},
  {"name":"金额","field_type":"number"},
  {"name":"轮次","field_type":"select","options":{"choices":["种子轮","A轮","B轮","C轮"]}},
  {"name":"日期","field_type":"date"},
  {"name":"投资方","field_type":"text"}
]'
# → 返回 table_id

# 2. 批量写入
tabtin table record bulk-insert --table-id <table_id> --records '[
  {"公司":"示例科技","金额":1000,"轮次":"A轮","日期":"2024-03-15","投资方":"某资本"},
  ...
]'
```

### 场景一补充：上游是 JSONL / 英文字段（网页采集常见）

**硬规则：写入 key = 表字段显示名**（常见中文）。上游 JSON 是 `title` / `company_name` 时，**必须先 remap**，否则
`bulk-insert` 会因「无有效字段匹配」整批失败（不会再静默建成空行）。

```bash
# 1) 可选：先拿模板对照字段名
tabtin table import template --table-id <table_id> --file-format json --output ./tpl.json

# 2) 清洗（英文字段 → 显示名）+ 聚合成 JSON array
jq -c '{"名称": .name, "ID": (.id | tostring),
        "日期": (.ts / 1000 | strftime("%Y-%m-%d"))}' /tmp/list.jsonl \
  | jq -s '.' > /tmp/records.json

# 3) 写入（PowerShell 下 @file 请加引号：--records '@./records.json'）
tabtin table record bulk-insert --table-id <table_id> --records @/tmp/records.json

# 4) 抽查非空——不能只看 success_count
tabtin table record list --table-id <table_id> --page-size 3 --format json
```

CLI 对多行 JSONL 的 `@file` 也可能自动聚合成数组；仍建议显式 `jq -s`，并保证 key 已 remap。

### 场景二：追加到已有表格

```bash
# 先确认表结构（字段名以此为准）
tabtin table info --table-id <table_id>

# 追加记录（字段名须与表结构匹配）
tabtin table record bulk-insert --table-id <table_id> --records '[...]'
```

### 场景三：从文件导入

```bash
# 下载 JSON 模板 → 按字段名填数据 → 导入
tabtin table import template --table-id <table_id> --file-format json --output ./tpl.json
# 编辑 tpl.json 为真实数据数组后：
tabtin table import json --table-id <table_id> --file ./tpl.json

# CSV / Excel
tabtin table import csv --table-id <table_id> --file ./data.csv
tabtin table import excel --table-id <table_id> --file ./data.xlsx --sheet-name Sheet1

# 写入前预览
tabtin table import preview --table-id <table_id> --file-type json --file ./data.json
```

### 场景四：大表异步导出 / 大文件导入

**默认仍走场景三的同步命令**；只有表体量大到同步请求会超时（先用 `export stats` 预检），
或导入文件超过同步通道上限时，才切异步。异步链路是「拿 `task_id` → 轮询 → 下载」三步：

```bash
# 0) 体量预检：记录数 / 预估大小 / 是否建议异步
tabtin table export stats --table-id <table_id> --format json

# 1) 发起异步导出，立刻返回 task_id（不阻塞）
tabtin table export excel --table-id <table_id> --async --format json

# 2) 轮询到终态；失败时退出码非 0，成功时输出含 file_id
tabtin table export wait --task-id <task_id> --wait-timeout 1800 --interval 3 --format json

# 3) 按 file_id 下载到本地（超大文件会改为返回签名 download_url）
tabtin table export download --file-id <file_id> -o ./export.xlsx
```

大文件导入用 `import file`（文件类型由扩展名推断，也可 `--file-type` 显式指定）：

```bash
tabtin table import file --table-id <table_id> --file ./big-data.csv --format json
# 小文件直接同步返回导入摘要；大文件返回 task_id → 复用同一个 wait 命令
tabtin table export wait --task-id <task_id> --format json
```

- 上限：**CSV / JSON 10MB、Excel 20MB**。`import file` 只把路径发给客户端服务，
  由它读盘——所以文件必须在**跑客户端的那台机器**的 `$HOME` 或 `/tmp` 下，且不能是软链。
  超过 6MB 时客户端会先把文件直传对象存储，再按 `file_id` 发起导入，不占请求体。
- 超过上限就别指望命令帮你分片：先按行/按 sheet 拆成多个文件分批导。
- `export wait` 对导出和导入任务通用（后端同一套任务登记表）。
- 交付前仍以 `wait` 终态回执里的 `success_count` / `failed_count` 为准，不要只看「已提交」。

## 操作规则

- 数据提取由 LLM 直接完成，无需调用额外提取工具
- 表名由你结合用户意图、数据来源（页面标题 / 文件名 / 域名）和字段语义生成简短中文名并显式传 `--name`，不要用「采集数据」「新表」这类泛化名
- **长数字 ID（订单号、豆瓣 ID、雪花 ID 等）用 `text` 字段写入，不要用 `number`**——超长整数走 number 会丢精度或触发数值校验失败
- 用户目标明确时直接建表、写入、导出；只有字段含义或去重键会影响结果正确性且无法从数据判断时，才用 `ask_user` 让用户选择
- 单次 `bulk-insert` 上限 **1000 条**，超过时分批调用
- 大批量数据（>1000 条）建议使用 `tabtin table import json` 走文件导入
- **字段名必须与 `tabtin table info` / 导入模板一致**；全部 key 未命中时写入会失败并提示未知 key，不得当成成功
- 写入回执有 `warnings`（部分未知字段已忽略）时必须向用户说明；不能只看 `success_count`——用 `record list` 抽查格子非空
- 全空对象 `{}` 不要当有效交付；禁止用「导入成功」掩盖空行
- 用户要求 Excel / xlsx / 表格文件时，写入后必须执行 `tabtin table export excel --table-id <table_id> --output ./result.xlsx`，并把文件路径作为最终交付物。`--output` 用**相对路径**（落 working_dir），**不要**写成 `~/Desktop`、`/Users/.../Desktop` 等 working_dir 之外的绝对路径
- 用户要求 CSV / PDF 时用对应导出子命令；需要 JSON 交付时用 `record list --format json`（**不要**用已关闭的 `export json`）
- `tabtin table export snapshot` / `import snapshot --yes` 面向 Organization 级表快照迁移；其中导入快照会覆盖/恢复组织内表数据，属于高影响操作，必须显式确认。

## 建表 / 写入失败时怎么办（不要绕过平台）

「采集到（多维）表」的交付物是 **Organization 内的 TabData 表**——产物要在产品里可见、可协作。建表 / 写入失败时按这条纪律处理，**不要**为了「先交付」就改道把数据用 shell 写成本地文件：

- `tabtin table create` 返回 **`QUOTA_EXCEEDED`（表格数量已达上限）**：把可执行原因摊给用户——「当前 Organization 表格数已达上限（如 20/20）。我可以删除不再使用的表后重写，或你升级套餐 / 换 Organization，告诉我怎么处理」——然后停下等指示。**不要**退化成 `cat > ~/Desktop/xxx.xlsx`、`pandas.to_excel('/Users/.../Desktop/..')` 之类把数据落到本地文件代替建表：那样产物在组织应用门 / 产品里看不到，等于采集没成功。
- 返回 **`PERMISSION_DENIED`**：说明当前身份对该 Organization 无写权限，向用户报告并确认目标 Organization，不要改写本地文件绕过。
- 确需先把已采集的数据落盘做断点续传 / 中间缓存，只能写 `/tmp` 或 working_dir 内（相对路径），且要明确说明这是**中间产物不是交付物**，最终仍要落成 Organization 里的表。

## 写入 link 字段（双表形态简短示例）

完整建模思路看 `skills_read("app:tabdata/table-modeling")`，这里只演示**写入时数据格式怎么填**。

写入时值是 `[{"id":"<目标 record UUID>"}]`：

```bash
# 1) 先把子表 upsert 进去（按业务键去重）
tabtin table record upsert --table-id $ACTOR_TABLE_ID \
  --records '[{"姓名":"梁朝伟","豆瓣ID":"1041006"}]' \
  --upsert-on '["豆瓣ID"]'

# 2) upsert 不返回 record_id 映射，必须再 list 一次建索引（page-size 上限 1000）
tabtin table record list --table-id $ACTOR_TABLE_ID --page-size 1000 --format json \
  | jq -c '.data.records[] | {key: .fields["豆瓣ID"], rid: .id}' > /tmp/actor_idx.jsonl

# 3) 写主表时把 record_id 拼进 link 字段
ACTOR_LIANG=$(grep '"1041006"' /tmp/actor_idx.jsonl | jq -r '.rid')
tabtin table record bulk-insert --table-id $MOVIE_TABLE_ID --records "[
  {\"电影名\":\"无间道\",\"豆瓣ID\":\"1307914\",\"评分\":9.3,
   \"演职员\":[{\"id\":\"$ACTOR_LIANG\"}]}
]"
```

> **采集场景里"写入 link"是高频踩坑点**。这段 SKILL 给的是模板；双表建模和
> 双向关联的完整流程看 `skills_read("app:tabdata/table-modeling", path="examples/form-c-douban-walkthrough.md")`。
>
> 上面第 2 步「重拉建索引」的固定分页循环可直接跑
> [`../table-modeling/scripts/build-record-index.sh`](../table-modeling/scripts/build-record-index.sh)`--table-id $ACTOR_TABLE_ID --key-field "豆瓣ID"`
> （输出 `{业务键: record_id}` 映射）；脚本只是便捷路径，link 值仍是 `[{"id":"<record_id>"}]`。

## 上游数据来源（网页采集等）

浏览器怎么抓数据**不在本 skill 边界内**——网页侧只负责产出结构化 JSON / JSONL（如
`/tmp/list.jsonl` + `/tmp/detail/*.json`）。

- **网页/采集 → 多维表整链（含分表确认、关联、混合幂等）** → 先走
  **`skills_read("app:tabdata/collect-to-table")`**，由编排调度本 skill；**不要**跳过编排直接单表 import 交差。
- **仅采集、用户不要落表** → `skills_read("app:tabweb/browser-collect")`
- 编排已确认方案后：按 `table-modeling` 形态 + 本 skill 场景一/三写入（少量
  `record bulk-insert`，文件走 `import json`）；C 形态先 upsert 子表去重 → 重拉建
  record_id 索引 → 主表 bulk-insert 带 link 值（见上节）。

> **0 FC 边界（D6）**：从网页抽取 → 整理 → 写入表格这条**采集链上全程走 CLI**，
> 不要回头用早期那些 web 抓取 / tabdata 写入类 FC（Wave 4a / 2026-05-01 已下架，
> Agent 工具集里看不到了）。
> GUI bridge 类 FC（请求拦截、分屏布局等）不在该边界内，按需正常使用。
