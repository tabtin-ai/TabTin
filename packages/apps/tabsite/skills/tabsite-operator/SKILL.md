---
name: tabsite-operator
description: >
  网站创建发布——创建、管理、发布轻量级网站 / Dashboard
  / 轻应用，站点直接调用 TabData API。用户要搭站点
  / 做仪表盘 / 发布轻应用时使用。
metadata:
  version: 0.2.0
  tabtin:
    category: web
    displayName: "TabSite Operator"
    tags:
      - site
      - webapp
      - dashboard
    autoActivateFor:
      - tabsite
    tools:
      - tabsite_create_site
      - tabsite_list_sites
      - tabsite_get_site
      - tabsite_update_site
      - tabsite_publish_site
      - tabsite_rollback_site
      - tabsite_provision_token
      - run_terminal_command
---

# TabSite Operator

当用户需要创建网站、着陆页、Dashboard 或轻应用时使用此技能。

**架构**：TabCode 写前端代码 → TabSite 构建发布 → 前端直接调 TabData API 获取数据。不需要额外的后端服务或云函数。

```
TabCode（写代码）→ tabtin site build（构建+上传+发布）→ site.example.com/s/{slug}
                                                              ↓
                                                    fetch(TabData API)
```

## FC 工具

| 工具 | 作用 | 风险等级 |
|------|------|----------|
| `tabsite_create_site` | 创建站点（dashboard 模板自动配 Token） | review |
| `tabsite_list_sites` | 列出 Space 中的所有站点 | safe |
| `tabsite_get_site` | 获取站点详情和版本历史 | safe |
| `tabsite_update_site` | 更新属性，含 tabdata_table_ids 绑定 | review |
| `tabsite_publish_site` | 发布新版本到线上 | review |
| `tabsite_rollback_site` | 回滚到指定版本 | review |
| `tabsite_provision_token` | 为站点创建只读 TabData Token（幂等） | review |

### 一条龙流程（推荐）

```python
# 1. 创建 dashboard 站点 → Token 自动创建 + .env.local 自动写入
tabsite_create_site(name="客户看板", template="dashboard")

# 2. 在 TabCode 中修改代码
run_terminal_command(command="tabtin code edit --path 'src/App.tsx' --edits '[{\"old_string\":\"...\",\"new_string\":\"...\"}]'")

# 3. 构建发布（一条命令搞定）
run_terminal_command(command="tabtin site build <site-id>")
# 注：build 含「构建+上传+发布」三步，常 30s-3min。foreground 超 120s
# 默认会终止进程树，主动加 wait_ms=0 更干净——立即拿到 session_id + pid +
# output_file；任务完成时 push 通知会激活下一轮 turn。
# 进度用 read_file(path=output_file)（path 取 envelope 返回值，不要假设）；
# 想中途取消用 run_terminal_command 跑 `kill <pid>`。
```

dashboard 模板创建后，`VITE_TABTIN_TOKEN` 和 `VITE_TABTIN_API_URL` 已自动写入 `.env.local`，前端代码通过 `import.meta.env` 读取即可。

### 数据联动

站点前端直接调用 TabData Open API：

```typescript
const API_URL = import.meta.env.VITE_TABTIN_API_URL
const TOKEN = import.meta.env.VITE_TABTIN_TOKEN
const SPACE_ID = import.meta.env.VITE_TABTIN_SPACE_ID
const TABLE_ID = import.meta.env.VITE_TABTIN_TABLE_ID

const res = await fetch(
  `${API_URL}/api/open/v1/spaces/${SPACE_ID}/data/tables/${TABLE_ID}/records?page_size=50`,
  { headers: { Authorization: `Bearer ${TOKEN}` } },
)
const { data } = await res.json()
```

Token 默认 readonly scope，如需写入需手动升级。

### blank 站点接入数据

blank 模板不自动创建 Token，需手动：

```python
tabsite_provision_token(site_id="<id>")
# 返回 VITE_TABTIN_TOKEN → 用 `tabtin code write` 写入 .env.local
```

### 绑定数据表

```python
tabsite_update_site(
  site_id="<id>",
  tabdata_table_ids=["table-uuid-1", "table-uuid-2"],
)
```

## CLI 命令

| 命令 | 作用 |
|------|------|
| `tabtin site create <name>` | 创建站点（--template dashboard 自动配 Token） |
| `tabtin site list` | 列出站点 |
| `tabtin site info <id>` | 站点详情 |
| `tabtin site build <id>` | 构建 + 上传 + 发布（一条命令） |
| `tabtin site publish <id>` | 单独发布（需提供 --dist-url） |
| `tabtin site rollback <id> <ver>` | 回滚版本 |

### 常用示例

```bash
# 创建 dashboard 站点（Token 自动配置）
tabtin site create "销售看板" --template dashboard

# 一键构建发布
tabtin site build <site-id> -m "v1: 初始版本"

# 回滚
tabtin site rollback <site-id> 1
```

## 约束

- dashboard 模板创建后 Token 已自动注入，通常无需手动操作
- Token 暴露在前端代码中，确保 scope 最小化（默认 readonly）
- 发布前确保代码已构建（`tabtin site build` 自动处理）
- 站点默认公开；如需关闭外部访问，请使用 `tabsite_update_site(is_public=False)`
- 密码保护功能暂不可用，请勿依赖 `password` 参数做访问控制
- 每次发布自动生成版本快照，支持随时回滚
