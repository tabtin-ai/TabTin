# Table Modeling · 执行配方

## 单表

适合单实体标量数据，相关名单只需作为文本展示。

```bash
tabtin table create --name "豆瓣Top250(简版)" --fields '[
  {"name":"电影名","field_type":"text"},
  {"name":"豆瓣ID","field_type":"text","description":"业务键"},
  {"name":"评分","field_type":"number","options":{"precision":1}},
  {"name":"年份","field_type":"number"},
  {"name":"链接","field_type":"url"},
  {"name":"主演摘要","field_type":"long_text"}
]'
```

## 双表 + link

适合子项需要独立查询、去重、复用或反向查的场景。

```bash
# 1. 先建被关联表
tabtin table create --name "豆瓣演员" --fields '[
  {"name":"姓名","field_type":"text"},
  {"name":"豆瓣ID","field_type":"text","description":"业务键"}
]'
# -> ACTOR_TABLE_ID

# 2. 再建主表
tabtin table create --name "豆瓣Top250" --fields '[
  {"name":"电影名","field_type":"text"},
  {"name":"豆瓣ID","field_type":"text","description":"业务键"},
  {"name":"评分","field_type":"number"}
]'
# -> MOVIE_TABLE_ID

# 3. 建双向关联
tabtin table link create \
  --table-id "$MOVIE_TABLE_ID" \
  --name "演职员" \
  --foreign-table-id "$ACTOR_TABLE_ID" \
  --relationship ManyMany
```

写入 link 前先取得目标 record_id；值格式是 `[{"id":"<目标 record UUID>"}]`。
运行时挂、解绑和核对关联边见 `skills_read("app:tabdata/table-association")`。

## 同表树形

任务/子任务、部门层级等场景使用：

```bash
tabtin table sub-record ensure-parent-field --table-id "$TABLE_ID"
tabtin table sub-record create --table-id "$TABLE_ID" --parent-record-id "$PARENT_ID" --data '{"任务":"子任务"}'
tabtin table sub-record move --table-id "$TABLE_ID" --record-id "$CHILD_ID" --parent-record-id "$NEW_PARENT_ID"
```

同表树形不是跨表 link；不要混用。
