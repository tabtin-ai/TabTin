# Browser Collect · 通道 B 模拟操作 + 列表详情两阶段

> 对应主 SKILL 五阶段里选了「通道 B · 模拟操作」之后的 ③链路测试、④脚本扩量、⑤校验交付，
> 以及「列表 + 每项详情」两阶段组合（豆瓣 Top250 + 演职员、商品列表 + SKU、文章列表 + 全文）。
> 通道 A（接口爬取）见 `references/collect-structured-data.md`。
>
> 两阶段任务里列表和详情**各自选路**：列表接口能复刻就走 A，只有详情被迫走 B（或反过来）都是正常组合。

## ③ 链路测试：先验 selector 再扩量

selector 易碎是采集任务常态——**别复制粘贴示例就跑**。扩量前必做：

1. `tabtin browser glance --screenshot --save /tmp/page.png` 看当前页真实结构；示例里的 selector 不在就按实际结构改。
2. 对第一页 / 第一条跑一遍抽取 `eval`，确认返回的 JSON 字段非空、前 3 条与页面可见内容一致。
3. 定翻页模式：URL 翻页（列表页有 `?page=` / `?start=`）还是无限滚动（往下滚才加载）；终止条件用「总页数 / 总条数」或「滚动后无新增条目」。

测试失败（selector 全碎、页面结构被风控替换）→ 回主 SKILL ②选路，看能否换通道 A。
页面跳到登录页不算测试失败——停下来让用户在当前 Tab 手动登录，确认后继续；**不要**换网络搜索 / 其他站点找替代数据源。

## ④ 脚本扩量

### 阶段 1 · 列表（URL 翻页型）

```bash
TASK=/tmp/collect-$(date +%s); mkdir -p "$TASK"
# 打开列表页记下 tabId —— 后面所有翻页/详情都复用这个 tab，会话/Cookie 不丢
TAB=$(tabtin browser open --url "https://movie.douban.com/top250" --format json | jq -r '.data.tabId')

> "$TASK/list.jsonl"
for offset in 0 25 50 75 100 125 150 175 200 225; do   # 终止条件：③ 定型的总页数
  tabtin browser open --url "https://movie.douban.com/top250?start=${offset}" --tab-id "$TAB" || { echo "offset $offset: open failed" >&2; break; }
  tabtin browser wait --selector ".grid_view" --timeout 5000 || { echo "offset $offset: selector missing (风控/改版?)" >&2; break; }
  ROW=$(tabtin browser eval --tab-id "$TAB" --expression "
    JSON.stringify([...document.querySelectorAll('.item')].map(it => ({
      id: (it.querySelector('.hd a').href.match(/subject\\/(\\d+)/)||[])[1],
      name: it.querySelector('.title').textContent.trim(),
      url: it.querySelector('.hd a').href,
      rating: parseFloat(it.querySelector('.rating_num').textContent)
    })))" --format json | jq -r '.data.result | fromjson | .[] | @json') || { echo "offset $offset: eval failed" >&2; break; }
  [ -n "$ROW" ] || { echo "offset $offset: empty extraction" >&2; break; }
  echo "$ROW" >> "$TASK/list.jsonl"
  sleep 2   # 反爬冷却
done
```

> 示例 selector（`.grid_view` / `.item` / `#info` 等）是 2026-05 验证过的豆瓣结构，DOM 经常微调，按 ③ 的流程先自验。

### 阶段 1 变体 · 无限滚动型

没有翻页 URL、往下滚才加载时，用 `act` 的 `scroll` 动作（不带 selector = 滚到页面底部）循环触发加载，以「滚动后条目数不再增长」为终止条件：

```bash
PREV=0
for round in $(seq 1 10); do          # 轮数上限 = 有界初始批次
  tabtin browser act --tab-id "$TAB" --actions '[{"type":"scroll"}]' || break
  tabtin browser wait --timeout 2000  # 等懒加载请求发完
  COUNT=$(tabtin browser eval --tab-id "$TAB" --expression "document.querySelectorAll('.item').length" --format json | jq -r '.data.result')
  [ "$COUNT" -le "$PREV" ] && break   # 终止条件：无新增条目
  PREV=$COUNT
  sleep 1
done
# 收敛后一次性抽全量条目（同上 eval 抽取），或每轮增量抽新条目按 id 去重
```

> 滚动型页面若侦察时发现数据其实来自 XHR（滚动只是触发请求），优先回通道 A 按 cursor 模板复刻接口——比模拟滚动稳得多。

### 阶段 2 · 详情循环

仍复用同一个 `TAB`（保会话），每条详情一个文件，失败记清单：

```bash
mkdir -p "$TASK/detail"; > "$TASK/failed_ids.txt"
while IFS= read -r row; do
  id=$(echo "$row" | jq -r '.id')
  url=$(echo "$row" | jq -r '.url')
  # 断点续传：文件存在且非空且可解析才算已完成——防超时/eval undefined 写出的坏文件被永久跳过
  [ -s "$TASK/detail/${id}.json" ] && jq -e . "$TASK/detail/${id}.json" > /dev/null 2>&1 && continue

  if ! tabtin browser open --url "$url" --tab-id "$TAB" \
     || ! tabtin browser wait --selector "#info" --timeout 5000; then
    echo "$id" >> "$TASK/failed_ids.txt"; echo "detail $id: load failed" >&2
    sleep 5; continue                 # 单条失败记清单继续；连续多条失败按反爬阶梯停下
  fi
  tabtin browser eval --tab-id "$TAB" --expression "
    JSON.stringify({
      year: (document.querySelector('.year')?.textContent||'').replace(/[()]/g,''),
      directors: [...document.querySelectorAll('a[rel=v:directedBy]')].map(a => ({name:a.textContent,url:a.href,role:'导演'})),
      stars: [...document.querySelectorAll('a[rel=v:starring]')].map(a => ({name:a.textContent,url:a.href,role:'主演'}))
    })" --format json | jq -r '.data.result | fromjson' > "$TASK/detail/${id}.json" \
    || { echo "$id" >> "$TASK/failed_ids.txt"; rm -f "$TASK/detail/${id}.json"; }
  # 产物校验：空文件 = 失败，删掉并记清单，让断点续传下轮重抓
  [ -s "$TASK/detail/${id}.json" ] || { echo "$id" >> "$TASK/failed_ids.txt"; rm -f "$TASK/detail/${id}.json"; }
  sleep 2
done < "$TASK/list.jsonl"
```

硬规则：

- **每条命令都检查退出码**：`open` / `wait` / `eval` 任一失败要么 break（列表阶段）要么记 `failed_ids.txt` 继续（详情阶段），**绝不空转**把后续全写成空文件。
- **详情钻取拿真实链接**：列表抽取时从 DOM 拿 `a.href` 原文（含 `xsec_token` 等签名参数），**不要**从 id 拼 URL——拼出来的链接丢签名会撞风控 / 被 `UNVERIFIED_NAVIGATION_URL` 守卫拦。
- **反爬中断恢复**：连续多条 `BLOCKED` → 按 operator 反爬阶梯（`clear-session` → `random-ua` → 新 `--session` 重开 Tab），**更新 `TAB` 变量**后重进详情循环——断点续传会自动跳过已完成的，失败清单里的会重抓。
- **循环中途跳登录页 = 会话过期，不是反爬**：停下来让用户在当前 Tab 重新登录，确认后重进循环断点续跑；别 `clear-session`（会把仅剩的登录态也清掉），更别换数据源。
- 中间产物全部落文件，不放内存：250 个详情串行 30 分钟+，中途必失败一次。

### 为什么复用同一个 `--tab-id`

- 未登录站点有 IP / 会话级限速；每次新开 Tab = 新会话，等于自找封禁。
- 登录态站点（飞书、Notion、内部系统）必须保留 Cookie，**不能用 `print --url`**（临时隐藏 Tab 无会话）。
- 浏览器实例启动慢，Tab 复用快很多。

## ⑤ 校验交付：manifest

```bash
ROWS=$(wc -l < "$TASK/list.jsonl")
DETAILS=$(ls "$TASK/detail" | wc -l)
jq -n --argjson rows "$ROWS" --argjson details "$DETAILS" \
  --argjson failed "$(jq -R . "$TASK/failed_ids.txt" | jq -s 'unique')" '{
  source_url: "https://movie.douban.com/top250",
  channel: "dom",
  paging: "url",
  collected_at: (now | todate),
  claimed_total: 250,
  row_count: $rows,
  detail_count: $details,
  is_partial: ($rows < 250 or ($failed | length) > 0),
  failed_ids: $failed
}' > "$TASK/manifest.json"
```

对账：`row_count` 对不上 `claimed_total`（页面标注的总数，未知为 `null`）或 `failed_ids` 非空 → 要么重跑详情循环补抓（断点续传只补缺的），要么如实标 partial 交付。产物 = `list.jsonl` + `detail/*.json` + `manifest.json`，交给上层消费。
