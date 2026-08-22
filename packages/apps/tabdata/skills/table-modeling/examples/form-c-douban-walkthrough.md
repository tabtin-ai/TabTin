# Table Modeling · 形态 C（双表 + link）豆瓣 Top250 完整示范

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

> 这是 Wave 3 的核心范例。每条命令都对应当前 cli-server 路由，可直接搬到对话里跑。
>
> 本文只覆盖**落表侧**（建表 → 去重 upsert → 业务键索引 → 写 link）。上游「从豆瓣页面把
> 列表 / 详情抓成 JSON」的浏览器侧流程（含 selector 自验、两阶段采集、断点续传）看
> `skills_read("app:tabweb/browser-collect")`——采集数据以其产物（`list.jsonl` +
> `detail/*.json`）为输入接到本文 5.4 节。

### 5.1 关键陷阱（**先看再写，否则一定踩坑**）

1. **建表顺序：先建子表（被指向的那张），再建主表**
   `link` 字段的 `options.foreignTableId` 必填，目标表必须已存在。
2. **写 link 字段值时，演员的 `record_id` 必须先拿到**
   `record upsert` 当前**只返回计数、不返回 record_id 映射**（CLI `record upsert --help` 已写明）。
   要拿映射就在 upsert 之后用 `tabtin table record list --page-size 1000` 重拉一次，按业务键建索引。
3. **批量建字段（`field bulk-add` / `table create --fields` 含 link）**
   普通字段可以批量创建；link 单独用 `table link create`，便于核对目标表和双向关系。
4. **双向 link 自动建对称字段**——别手工在子表上再加一个反向 link，会重复。

### 5.2 阶段 0：与用户对齐 + 形态决策

```text
Agent: 「采集 Top250 + 演职员」我有两种做法：
       ① 单表，演员塞在一列文本里看（简单但没法反向查）
       ② 双表（电影 + 演员）用 link 关联，能在演员表搜「梁朝伟」反查他参演的电影
       要哪种？
User:  ② 双表
→ 锁定双表形态（双向 link）
```

### 5.3 阶段 1：建表（先子表后主表，再建 link）

```bash
tabtin table create --name "豆瓣演员" --fields '[
  {"name":"姓名","field_type":"text"},
  {"name":"豆瓣ID","field_type":"text","description":"用于去重的业务键"},
  {"name":"角色类型","field_type":"multi_select","options":{"choices":["导演","主演","编剧"]}},
  {"name":"详情链接","field_type":"url"}
]'
ACTOR_TABLE_ID=<上一行返回的 table_id>

tabtin table create --name "豆瓣Top250" --fields '[
  {"name":"电影名","field_type":"text"},
  {"name":"豆瓣ID","field_type":"text"},
  {"name":"评分","field_type":"number","options":{"precision":1}},
  {"name":"年份","field_type":"number"}
]'
MOVIE_TABLE_ID=<上一行返回的 table_id>

tabtin table link create --table-id $MOVIE_TABLE_ID \
  --name "演职员" --foreign-table-id $ACTOR_TABLE_ID --relationship ManyMany
LINK_FIELD_ID=<上一行返回的 field_id>
# 等价旧写法：field add --field-type link --options '{"foreignTableId":"...","relationship":"ManyMany","isOneWay":false}'
```

> 想用 bulk-add 一次建多个普通字段也可以，**但 link 单独走一条命令**最稳：
> ```bash
> tabtin table field bulk-add --table-id $MOVIE_TABLE_ID --fields '[
>   {"name":"封面","field_type":"attachment"},
>   {"name":"片长","field_type":"number"},
>   {"name":"上映时间","field_type":"date"}
> ]'
> ```

### 5.4 阶段 2：先把演员去重写入（upsert，业务键= 豆瓣ID）

```bash
tabtin table record upsert \
  --table-id $ACTOR_TABLE_ID \
  --records '[
    {"姓名":"梁朝伟","豆瓣ID":"1041006","角色类型":["主演"],
     "详情链接":"https://movie.douban.com/celebrity/1041006/"},
    {"姓名":"刘德华","豆瓣ID":"1041010","角色类型":["主演"]}
  ]' \
  --upsert-on '["豆瓣ID"]'
```

### 5.5 阶段 3：重拉演员表，建「业务键 → record_id」索引

> upsert 不返回映射，必须重拉。`record list` 单页上限 1000，超过分页。
> 下面这段分页循环可直接跑 [`../scripts/build-record-index.sh`](../scripts/build-record-index.sh)`--table-id $ACTOR_TABLE_ID --key-field "豆瓣ID"`（封装本段、输出 `{业务键: record_id}`）。

```bash
> /tmp/actor_index.jsonl
page=1
while true; do
  resp=$(tabtin table record list --table-id $ACTOR_TABLE_ID \
    --page $page --page-size 1000 --format json)
  count=$(echo "$resp" | jq '.data.records | length')
  [ "$count" = "0" ] && break
  echo "$resp" | jq -c '.data.records[] | {key: .fields["豆瓣ID"], rid: .id}' \
    >> /tmp/actor_index.jsonl
  [ "$count" -lt 1000 ] && break
  page=$((page+1))
done

jq -s 'map({(.key): .rid}) | add' /tmp/actor_index.jsonl > /tmp/actor_index.json
```

### 5.6 阶段 4：写电影主表（带 link 字段值）

> link 字段值的标准格式：`[{"id":"<演员 record UUID>"}, ...]`

```bash
ACTOR_LIANG=$(jq -r '."1041006"' /tmp/actor_index.json)
ACTOR_LIU=$(jq   -r '."1041010"' /tmp/actor_index.json)

tabtin table record bulk-insert \
  --table-id $MOVIE_TABLE_ID \
  --records "[
    {\"电影名\":\"无间道\",\"豆瓣ID\":\"1307914\",\"评分\":9.3,\"年份\":2002,
     \"演职员\":[{\"id\":\"$ACTOR_LIANG\"},{\"id\":\"$ACTOR_LIU\"}]}
  ]"
```

### 5.7 阶段 5：验证 + 复述

```bash
tabtin table query 'SELECT COUNT(*) FROM "豆瓣Top250"'
tabtin table query 'SELECT COUNT(*) FROM "豆瓣演员"'

# 抽样：演员反查（对称字段名由 LinkFieldService 自动生成，
# 实际名字以 tabtin table field list --table-id $ACTOR_TABLE_ID 为准）
tabtin table query "
  SELECT \"姓名\" FROM \"豆瓣演员\" WHERE \"姓名\" = '梁朝伟' LIMIT 1
"
```

最后向用户复述（见 §二 Step 3 模板）。

---
