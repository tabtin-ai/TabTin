---
name: task-tracker
description: >
  任务进度跟踪——登记步骤计划、实时更新状态、记录决策与问题、
  跨会话恢复、多 Agent 分工协作。接到 ≥3 步的复杂任务、
  或用户说"做个计划 / 列步骤 / 跟踪进度"时在动手前调用，
  用多维表向用户可视化跟踪进度；简单一两步的任务不要建跟踪表。
metadata:
  version: 0.2.3
  tabtin:
    category: collaboration
    displayName: "Task Tracker"
    emoji: "\U0001F4CB"
    tags: [agent, task, tracking, table]
---

# Task Tracker

Use this skill when the agent is about to execute a non-trivial task that would benefit from structured progress tracking visible to the user.

## When to Create a Tracking Table

Create a tracking table when the task meets **any** of these criteria:

- Requires 3 or more distinct steps
- Involves modifying multiple files
- Requires technical decisions or trade-offs
- User explicitly asks to plan, organize, or track

**Do NOT create** a tracking table for:

- Simple questions or explanations
- Single-file edits or quick fixes
- Tasks the user describes as "quick" or "simple"

## How to Create

Use CLI to create a task tracking table with standard fields:

```bash
tabtin table create --name "🤖 <short task description>" --fields '[
  {"name":"任务","field_type":"text"},
  {"name":"状态","field_type":"select","options":{"choices":["⬜ 待做","🟡 进行中","✅ 完成","🔴 阻塞","❌ 取消"]}},
  {"name":"阶段","field_type":"text"},
  {"name":"摘要","field_type":"text"},
  {"name":"决策","field_type":"text"},
  {"name":"问题","field_type":"text"},
  {"name":"负责人","field_type":"text"},
  {"name":"开始时间","field_type":"date","options":{"formatting":{"date":"YYYY/MM/DD","time":"HH:mm","timeZone":"Asia/Shanghai"}}},
  {"name":"更新时间","field_type":"date","options":{"formatting":{"date":"YYYY/MM/DD","time":"HH:mm","timeZone":"Asia/Shanghai"}}}
]'
```

> 这套固定 schema（含 🤖 前缀 + 状态选项）可直接跑 [`scripts/create-tracker-table.sh`](scripts/create-tracker-table.sh)` "<task description>"`，
> 它就是上面这条 `table create` 的封装、成功后打印 `table_id`；插入初始任务行仍按下面手动 `bulk-insert`。

## 资源导航（按需运行）

- `scripts/create-tracker-table.sh`：当你要用标准字段快速建一张新的跟踪表时运行；如果用户已给出自定义字段，按正文手动 `tabtin table create`。
- `scripts/update-tracker-task.sh`：当你只想安全更新某一行状态/摘要（避免手写 SQL 引号或漏 WHERE）时运行；更新时机仍按「When to Update」判断。

Then insert initial tasks:

```bash
tabtin table record bulk-insert --table-id <table_id> --records '[
  {"任务":"Specific subtask description","阶段":"Phase 1: Discovery","状态":"🟡 进行中"},
  {"任务":"Another subtask","阶段":"Phase 1: Discovery","状态":"⬜ 待做"},
  {"任务":"Implementation subtask","阶段":"Phase 2: Implementation","状态":"⬜ 待做"}
]'
```

Rules:
- Table name MUST start with 🤖
- Use the user's language for table name and task descriptions
- Keep phases between 3-7 (same as Planning-with-Files principle)
- Each phase can have multiple subtask rows
- The first subtask is automatically set to 🟡 in progress

## How to Update Progress

Run `tabtin table execute` to update the current task row (CLI 替代 FC；
原 tabdata 写入类 FC 已于 Wave 4a / 2026-05-01 下架，Agent 工具集里只剩 CLI 这条路):

> 这条按「任务」定位行、置状态/摘要并把「更新时间」设为 `NOW()` 的固定 UPDATE 可直接跑
> [`scripts/update-tracker-task.sh`](scripts/update-tracker-task.sh)`--table "🤖 xxx" --task "<任务文本>" --status "✅ 完成" [--summary ...]`
> （封装下面的 SQL、自动转义 + 强制带 WHERE）；何时更新、写什么内容仍按本节判断。

```bash
tabtin table execute "
UPDATE \"🤖 xxx\" SET
  \"状态\" = '✅ 完成',
  \"摘要\" = 'Brief summary of what was done and the result',
  \"更新时间\" = NOW()
WHERE \"任务\" = 'current task description';
"

tabtin table execute "
UPDATE \"🤖 xxx\" SET
  \"状态\" = '🟡 进行中',
  \"开始时间\" = NOW()
WHERE \"任务\" = 'next task description';
"
```

### When to Update

- **Status changes**: Immediately when starting or completing a subtask
- **Summary**: When a phase completes, write a brief summary
- **Decisions**: Record immediately when making a technical or design decision
- **Problems**: Record immediately when encountering an error, include attempt count

### Problem Recording Format

```
Attempt 1: [error description] -> [solution tried]
Attempt 2: [error description] -> [different approach]
```

## How to Read User Modifications

**Before starting each new phase**, query the table for current state via `tabtin table query`:

```bash
tabtin table query "
SELECT \"任务\", \"状态\", \"阶段\", \"决策\", \"问题\"
FROM \"🤖 xxx\"
WHERE \"状态\" NOT IN ('✅ 完成', '❌ 取消')
ORDER BY "__order"
"
```

Adjust behavior based on what you find:
- Row status changed to ❌ 取消 -> Skip that task
- Row status changed from 🟡 进行中 back to ⬜ 待做 -> Pause it, work on other tasks first
- User appended text to 决策 or 问题 fields -> Treat as new constraints
- Row order (`__order`) changed -> Follow the new order

## Cross-Session Recovery

When starting a new session, check if the project has existing tracking tables:

1. Use `tabtin table list` or `tabtin table query "SELECT ..."` to get available tables
2. Look for tables whose name starts with 🤖
3. If found, query incomplete tasks:

```bash
tabtin table query "
SELECT \"任务\", \"状态\", \"阶段\", \"摘要\", \"决策\", \"问题\"
FROM \"🤖 xxx\"
WHERE \"状态\" NOT IN ('✅ 完成', '❌ 取消')
ORDER BY "__order"
"
```

4. Also read completed tasks for context:

```bash
tabtin table query "
SELECT \"任务\", \"摘要\", \"决策\"
FROM \"🤖 xxx\"
WHERE \"状态\" = '✅ 完成'
ORDER BY "__order"
"
```

5. Resume from the first incomplete task.

## Multi-Agent Collaboration

If acting as a **sub-agent**:
1. Check if a tracking table already exists (created by the main agent)
2. Find your assigned rows: `WHERE "负责人" = '<your identifier>'`
3. Only update rows assigned to you

If acting as a **main agent** delegating subtasks:
1. Create rows for sub-agents with their identifier in the 负责人 field
2. Periodically check for blocked items: `WHERE "状态" = '🔴 阻塞'`

## When tracking gets nested (任务 + 子任务、阶段 + 阶段内任务)

The flat schema above is enough for most agent-tracking scenarios. If you genuinely need
hierarchy (parent task → child subtasks, or task → linked artifact records), don't squeeze
it into the 阶段 text column—use the proper structure:

- **同表父子**：用 `tabtin table sub-record ensure-parent-field` + `sub-record create` 建自引用 link 树
- **任务关联到外部对象**（比如关联到 PR、文档）：在跟踪表加一个 `link` 字段指向外部表，点击关联记录查看详情

完整建模与决策树看 `skills_read("app:tabdata/table-modeling")`。否则默认就保持扁平表，不要过度设计。
