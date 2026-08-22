---
name: table-query
description: >
  多维表查询——用 SQL 筛选检索、统计汇总、分组聚合（COUNT/
  SUM/平均）、排序去重、按条件批量更新。用户要"查一下
  / 统计 / 汇总 / 分析 / 算一下"表里数据时调用；加字段
  / 改视图等结构操作走 table-operator。
metadata:
  version: 0.2.4
  tabtin:
    category: data
    displayName: "Table Query"
    autoActivateFor:
      - tabdata
    preload_tools_for:
      - tabdoc
      - tabcode
      - tabslide
      - tabdesign
    tools:
      - run_terminal_command
---

# Table Query

通过 SQL 查询/写入 TabData 数据。

> **统一走 CLI**：`tabtin table query "<SQL>"` 读、`tabtin table execute "<SQL>"` 写。
> 原 FC 工具（`sql_catalog` / `sql_query` / `sql_execute`）已删除（Wave 4a / D4 全删 FC），
> CLI 通过 `run_terminal_command` 调用，能管道、能脚本、能与其他 `tabtin` 命令组合。

## SQL 规则

- 使用显示名称（中文或英文表名 / 字段名）— 系统自动解析为内部标识符
- 标识符必须用双引号：`"字段名"`
- 主键是 `__id`（不是 `_id`）
- **UPDATE / DELETE 必须带真实收敛的 WHERE** — 安全层会拒绝恒真条件（如 `WHERE 1=1`、`WHERE TRUE`、`WHERE "__id" IS NOT NULL`）。如果确实要改很多行，先 `SELECT COUNT(*)` 看规模，再用业务条件分批；不要伪造全表 WHERE。
- **删除记录优先用 `tabtin table record delete`**（按 record_id 精准删，是产品推荐路径）；
  非要走 SQL `DELETE` 时 `tabtin table execute "DELETE ..." --allow-delete` 才会被允许，
  且只删数据行（不删表/不改 schema）
- 不要用 SQL DELETE 做软删——用 `UPDATE ... SET "状态" = '已取消'` 表达业务语义
- **优先一条批量 UPDATE** — 不要逐行生成语句
- 大表加 `LIMIT` — 避免无限制的 `SELECT *`
- link 字段不能通过 SQL UPDATE 改关联关系；要改关联关系用
  `tabtin table record update --data` 或 `tabtin table link add/set/remove`

## SQL 模板

```sql
-- 查询
SELECT "__id", "<字段>" FROM "<表名>" WHERE "<条件字段>" > <值> LIMIT 100

-- 聚合
SELECT "<分组字段>", COUNT(*) as cnt FROM "<表名>" GROUP BY "<分组字段>"

-- 批量更新：WHERE 必须是业务条件，不能用恒真条件
UPDATE "<表名>" SET "<字段>" = '<前缀>' || "<字段>" || '<后缀>' WHERE "<状态>" = '待处理'
```

## 效率规则

- 上下文已包含当前表字段 → 不要再调结构查询
- 对话开头不要预查系统表 — 系统会自动注入
- 工具报错时先分析原因，不要盲目重试
- 大表先用 `COUNT(*)` 摸清规模再决定是否 `LIMIT`

## CLI 操作

通过 `run_terminal_command` 执行 `tabtin table` 命令：

```bash
# SQL 查询（只读）
tabtin table query "SELECT * FROM \"任务\" WHERE \"状态\" = '进行中' ORDER BY \"优先级\" DESC LIMIT 20"
tabtin table query "SELECT \"部门\", COUNT(*) as cnt FROM \"员工\" GROUP BY \"部门\""

# SQL 写入（INSERT / UPDATE）
tabtin table execute "UPDATE \"任务\" SET \"状态\" = '已完成' WHERE \"负责人\" = '张三' AND \"截止日期\" < '2024-01-01'"

# 命令组合（CLI 优势）：把查询结果给下一条命令处理
tabtin table query "SELECT \"__id\" FROM \"任务\" WHERE \"状态\" = '已取消'" --format json \
  | jq -r '.data.rows[][0]' \
  | xargs -I{} tabtin table record delete --table-id <id> --record-id {} --yes
```

## 看表结构

```bash
tabtin table list                              # 列出当前 Organization 下所有表
tabtin table info --table-id <id>              # 看单表（字段名/类型/约束）
tabtin table field list --table-id <id>        # 看字段详情
```

## link 字段在 SQL 里的写法

- **link 字段** SELECT 出来是关联记录的简略 JSON——形态因 link 配置而异，写 SQL 前先 `tabtin table info` 看具体形态
- 跨 link 反向查（"梁朝伟参演了哪些电影"）—— 双向 link 时子表上会自动产生对称字段，**直接 SELECT 那一列**即可，比 JOIN 简单

> 还不熟悉 link 怎么建？先读 `skills_read("app:tabdata/table-modeling")`。

## 与其他 SKILL 的关系

- 建表 / 写入 / 关联建模 → `skills_read("app:tabdata/table-modeling")`
- 字段管理 / 视图 → `skills_read("app:tabdata/table-operator")`
- 网页采集后写入 → `skills_read("app:tabdata/table-import-export")`
