---
name: table-association
description: >
  多维表关联运行时操作——创建 link 字段、挂/解绑关联目标、
  查候选记录、改单/多关联基数、核对当前关联。用户说「关联到 / 挂上 /
  取消关联 / 连到分类 / 多选关联 / 反向也能查」或要在已有两张表之间
  读写关联边时调用。形态决策（建几张表）仍走 table-modeling；
  单表 CRUD 走 table-operator。
metadata:
  version: 0.1.0
  tabtin:
    category: data
    displayName: "Table Association"
    autoActivateFor:
      - tabdata
    tools:
      - run_terminal_command
  runtime: cloud
  requires:
    bins:
      - tabtin
  cliHelp: "tabtin table link --help"
  canonicalName: table-association
---

# Table Association

> 只回答一件事：**在已有（或刚建好的）表之间，怎么挂 / 解 / 查关联。**
> 「网页采集并落多维表」整链 → `skills_read("app:tabdata/collect-to-table")`（本 skill 只当挂边工兵）。
> 「该不该拆成两张表」→ `skills_read("app:tabdata/table-modeling")`。
> 普通字段与行 CRUD → `skills_read("app:tabdata/table-operator")`。

所有命令走 `tabtin table link`（底层仍是 link 字段 + `LinkRecord`；**没有** `is_multi` 这个 options 键）。

---

## 一、先分清：单关联 vs 多关联

| 产品说法 | `relationship` | 单元格形态 | 典型场景 |
|---------|----------------|-----------|---------|
| **单关联** | `ManyOne`（常用）或 `OneOne` | 一个目标 `{id,title}` 或 `null` | 任务→分类、订单→客户 |
| **多关联** | `ManyMany`（常用）或 `OneMany` | 目标数组 `[{id,title},...]` | 电影→演员、文章→标签 |

- **默认双向**（`isOneWay=false`）：目标表会自动多一列对称字段，能反向查。**不要**再手建反向 link。
- **单向**（`--one-way`）：只在本表看到关联，目标表不建对称列。

人话复述给用户时说「挂上另一张表的一行/多行」「两边都能跳」，少说 relationship 英文。

---

## 二、方法路由（按意图选命令）

| 目标 | 命令 |
|------|------|
| 新建关联字段 | `tabtin table link create --table-id <本表> --name "..." --foreign-table-id <目标表> --relationship ManyMany\|ManyOne` |
| 改基数 / 单向双向 / 主显字段 | `tabtin table link update --field-id <link字段> ...` |
| 搜可挂的目标行 | `tabtin table link linkable-records --table-id <本表> --field-id <link字段> --search "<关键词>"` |
| **增量挂上** | `tabtin table link add --table-id <本表> --field-id <link字段> --record-id <行> --target-ids <uuid>` |
| **整格覆盖**（只留这些） | `tabtin table link set ... --targets '["uuid1","uuid2"]'` |
| **解绑** / 清空 | `tabtin table link remove ... --target-ids <uuid>` 或 `--all` |
| 核对当前挂了谁 | `tabtin table link list --table-id <本表> --field-id <link字段> --record-id <行>` |

> `populate-choices` 只服务 **select / multi_select**，与 link 边无关——别拿来处理关联。

---

## 三、标准编排（Agent 抄这段）

### 3.1 已有两张表，要挂多对多

```bash
# 1) 建关联列（先有目标表）
tabtin table link create \
  --table-id "$HOST_TABLE" --name "演职员" \
  --foreign-table-id "$TARGET_TABLE" \
  --relationship ManyMany

# 记下返回的 field_id → LINK_FIELD

# 2) 搜目标 UUID（禁止把姓名直接当 link 值）
tabtin table link linkable-records \
  --table-id "$HOST_TABLE" --field-id "$LINK_FIELD" \
  --search "梁朝伟" --format json
# → TARGET_RID

# 3) 挂上（增量）
tabtin table link add \
  --table-id "$HOST_TABLE" --field-id "$LINK_FIELD" \
  --record-id "$HOST_RID" --target-ids "$TARGET_RID"

# 4) 核对
tabtin table link list \
  --table-id "$HOST_TABLE" --field-id "$LINK_FIELD" \
  --record-id "$HOST_RID" --format json
```

### 3.2 单关联（如看板「分类」用关联表而不是 select）

```bash
tabtin table link create \
  --table-id "$TASK_TABLE" --name "分类" \
  --foreign-table-id "$CATEGORY_TABLE" \
  --relationship ManyOne

# 换分类 = add（单关联语义：覆盖为新目标）或 set
tabtin table link add \
  --table-id "$TASK_TABLE" --field-id "$LINK_FIELD" \
  --record-id "$TASK_RID" --target-ids "$CATEGORY_RID"
```

### 3.3 只想替换整列关联、不要合并

```bash
tabtin table link set \
  --table-id "$HOST_TABLE" --field-id "$LINK_FIELD" \
  --record-id "$HOST_RID" \
  --targets '["uuid-a","uuid-b"]'

# 清空
tabtin table link set ... --targets '[]'
# 或
tabtin table link remove ... --all
```

### 3.4 插入新行时顺便挂关联

仍可用 `record insert`，值必须是 id：

```bash
tabtin table record insert --table-id "$HOST_TABLE" --data '{
  "标题":"无间道",
  "演职员":[{"id":"<演员uuid>"}]
}'
```

已有行优先 `link add/set`，少用手拼整行 JSON。

---

## 四、硬约束（违反必翻车）

1. **值 = 目标 record UUID**，不是显示名、不是本表 field id。
2. **先有目标表，再 `link create`**（`foreignTableId` 必填）。
3. **双向不要手建对称字段**——系统会建。
4. **`link add` / `remove` 走 Desktop/Daemon**（cli-server 读-改-写）。纯 API 直连请用 `link set`（或先 `list` 再 `set`）。远程 `list` 可能返回整条 record，与 Desktop 裁剪结构不同——优先 Desktop。
5. **单关联 `add` = 覆盖**为传入的最后一个 id，不是追加第二条。
6. **`link set` 必须显式传 `--targets` / `--target-ids`**；清空用 `--targets '[]'` 或 `remove --all`，禁止漏参误清空。
7. 同表树形父子（任务子任务）走 `tabtin table sub-record *`，不是本 SKILL 的跨表 link。
8. **并发**：`add`/`remove` 是读-改-写，无行锁；并行挂同一格可能丢边——串行调用。

---

## 五、与其它 skill 的边界

| 场景 | 读谁 |
|------|------|
| 电影+演员该用单表还是双表 link？ | `app:tabdata/table-modeling` |
| 改标题、加普通列、看板视图、搜行 | `app:tabdata/table-operator` |
| SQL 里读 link JSON / JOIN 思路 | `app:tabdata/table-query` |
| 导入 CSV 时 link 列怎么写 | `app:tabdata/table-import-export` |
| **挂/解/查关联边** | **本 SKILL** |

完成后用人话告诉用户：哪两张表、哪一列能点进去跳转、反向列在哪（若双向）。
