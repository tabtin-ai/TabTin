# tabtin-sdk

TabTin Data SDK for Python — fluent query API for TabData.

## Quick Start

```bash
pip install tabtin-sdk
```

```python
from tabtin_sdk import Client

client = Client("https://api.example.com", "ttn_xxx_yyy")
client.init()  # Load table names (optional if using UUIDs)
```

## Query Records

```python
# Select all
result = client.table("任务").select("*").execute()
for record in result.data.records:
    print(record.fields)

# Filter + sort + limit
result = (
    client.table("任务")
    .select("标题, 状态, 负责人")
    .eq("状态", "进行中")
    .order("创建时间", ascending=False)
    .limit(10)
    .execute()
)

# Multiple filters
result = (
    client.table("订单")
    .select("*")
    .gt("金额", 100)
    .neq("状态", "已取消")
    .execute()
)
```

## Insert Records

```python
# Single
client.table("任务").insert({"标题": "新任务", "状态": "待处理"})

# Batch
client.table("任务").insert([
    {"标题": "任务A", "负责人": "张三"},
    {"标题": "任务B", "负责人": "李四"},
])
```

## Update Records

```python
# Update by ID
client.table("任务").update("record-uuid", {"状态": "已完成"})

# Batch update
client.table("任务").batch_update([
    {"id": "uuid-1", "fields": {"状态": "完成"}},
    {"id": "uuid-2", "fields": {"状态": "进行中"}},
])
```

## Upsert

```python
client.table("任务").upsert(
    {"标题": "任务A", "状态": "完成"},
    on_conflict="标题",
)

# Batch
client.table("任务").upsert(
    [
        {"标题": "任务A", "状态": "完成"},
        {"标题": "任务B", "状态": "进行中"},
    ],
    on_conflict="标题",
)
```

## Delete Records

```python
# Single
client.table("任务").delete("record-uuid")

# Batch
client.table("任务").delete(["uuid-1", "uuid-2"])
```

## Aggregation

```python
result = client.table("订单").aggregate([
    {"field": "金额", "function": "sum"},
    {"field": "金额", "function": "avg"},
    {"field": "订单号", "function": "count"},
])
```

## SQL Query

```python
# Read-only
result = client.sql("agent-space-uuid", "SELECT * FROM 任务 WHERE 负责人 = %s", ["张三"])
print(result.data.columns, result.data.rows)

# Write
client.sql_execute(
    "agent-space-uuid",
    "UPDATE 任务 SET 状态 = %s WHERE 负责人 = %s",
    ["已完成", "张三"],
)
```

## Context Manager

```python
with Client("https://api.example.com", "ttn_xxx_yyy") as client:
    client.init()
    result = client.table("任务").select("*").execute()
```

## Error Handling

```python
result = client.table("任务").select("*").execute()

if result.error:
    print(f"Error {result.error.code}: {result.error}")
else:
    print(f"Found {result.data.total} records")
```
