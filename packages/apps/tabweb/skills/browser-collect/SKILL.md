---
name: browser-collect
description: >
  浏览器批量结构化采集，产物为 JSON/JSONL + manifest。用户要批量抓列表/详情数据、
  爬取成批网页数据时使用。单页阅读或问答用 browser-operator；下图片/视频用
  browser-media。
metadata:
  version: 0.3.2
  tabtin:
    category: web
    displayName: "Browser Collect"
    tags:
      - scraping
      - extraction
      - automation
    autoActivateFor:
      - tabweb
    tools:
      - present_to_user
---

# Browser Collect

> 从网页里把**成批的结构化数据**抓出来的专用流程。浏览器能力一律走
> `tabtin browser` CLI（`run_terminal_command`）。基础命令约定、会话管理、反爬阶梯、
> 安全规则见 `skills_read("app:tabweb/browser-operator")`。

---

## 边界

本 skill 只负责**从网页拿到第一手结构化数据**并输出成 JSON / JSONL + manifest（stdout 或临时文件）。
拿到数据之后往哪落地（表格、文档等）不在浏览器边界内——本 skill
不做落地建模，也不代替下游写入。

若用户目标是**采集并写入多维表**（含关联 / 分表），交付 Bundle 后交给
**`skills_read("app:tabdata/collect-to-table")`** 编排，不要在本 skill 内直接 `table create`。

- 只读某页正文 / 就这页问答 → 不是批量采集，回 `browser-operator`（`print --save` / `tabtin fetch`）。
- 批量抓列表 / 详情结构化数据 → 本 skill。

---

## 五阶段工作流（任何采集任务都按这条链走）

```
① 侦察 → ② 选路 → ③ 链路测试 → ④ 脚本扩量 → ⑤ 校验交付
              ↑ 换通道 ↩ ③ 测试失败       ↺ ④ 被限速/封 → 反爬阶梯后从断点恢复
```

「列表 + 每项详情」两阶段任务 = 列表、详情**各跑一遍**这条链，且**可以选不同通道**
（列表走接口、详情走模拟操作是常见组合）。

> **登录墙 ≠ 失败（任何阶段都适用）**：目标页 / 接口要求登录时，**停下来让用户在
> TabTin 浏览器的这个 Tab 里手动登录**，确认后复用同一 `tabId` 继续（流程见
> `skills_read("app:tabweb/browser-operator")`「需登录页面」）。**不要**把登录墙当成
> 通道失败去换网络搜索 / 其他站点找替代数据源——用户指定了数据来源，换源等于换了任务。

### ① 侦察：数据长在哪

1. `tabtin browser tab list`：优先复用同域 Tab，避免丢登录态。撞登录墙 → **先让用户手动登录**再继续（见 `skills_read("app:tabweb/browser-operator")`「需登录页面」）。
2. `tabtin browser open --url <url> --wait-until domcontentloaded --timeout 15000`：导航超时也保留返回的 `tabId`。
3. 依次看三处（命令细节见 `references/collect-structured-data.md`，别凭记忆拼）：
   **network 抓包**（XHR / JSON / GraphQL）→ **hydration**（`__NEXT_DATA__` / `__NUXT__` / Apollo / Redux）→ **渲染后 DOM**。
4. 产出一个明确结论：数据在「接口响应 / hydration / 仅 DOM」，以及是否依赖鉴权 Cookie / token / 签名。

### ② 选路：两条通道平等，按判据选

| 判据 | 通道 A · 接口爬取 | 通道 B · 模拟操作 |
| --- | --- | --- |
| 数据来源 | network 有业务 API，或 hydration 里有全量数据 | 数据只在渲染后 DOM |
| 鉴权 / 反爬 | 公开 API，或 Cookie / 签名可原样复刻 | 强签名（改 URL 即 404）、会话级风控 |
| 数据量 | 大批量、多页、要断点续传 | 单页小量时 `eval` 直抽反而省事 |
| 翻页形态 | pageNo / cursor 参数在请求里 | 仅 URL 翻页、无限滚动、点「加载更多」 |

**不是"A 优先、B 兜底"**——按侦察结果选。选 A 后再分叉：公开 API → terminal `curl` 复刻；
依赖 Cookie / 会话签名 → 同一 Tab 里 `eval fetch(...)`（分叉细节与坑见 `references/collect-structured-data.md`）。
> 这条 curl 路径是 operator「禁止裸 shell 替代浏览器面」的**唯一例外**（仅限侦察确认的无鉴权公开 API 复刻取数）；边界真源在 `skills_read("app:tabweb/browser-operator")`「CLI 约定」。

### ③ 链路测试：小样本定型脚本参数

扩量前用**小样本**把以下四项从真实响应 / 页面**定下来**，不许拍脑袋：

1. **成功判据**——HTTP 200 ≠ 成功；从抓包的真实成功响应确定业务字段，并记一条失败 / 风控响应的形状用于 fail-fast。
2. **数据路径**——jq 路径（通道 A）或 selector（通道 B，先 `glance --screenshot` 自验，selector 易碎）。
3. **翻页模式与终止条件**——通道 A 选 pageNo / cursor，通道 B 选 URL 翻页 / 无限滚动；终止条件从响应里的 total / hasMore / nextCursor 或 DOM 计数收敛推导。
4. **前 3 条数据与页面可见内容对齐**。

测试失败 → **回到 ② 换通道**（接口撞签名校验 → 换模拟操作；selector 全碎 → 换接口），别在原通道死磕。
撞登录墙（接口返回 401 / 未登录码、页面跳登录页）不算测试失败——停下等用户登录后在原通道继续。

### ④ 脚本扩量

链路定型后**一段脚本**收掉重复劳动（三种翻页模式的模板见 references，别手搓散成多轮）。硬规则：

- 每次请求 / 翻页检查退出码 + 成功判据，失败即停（fail-fast），**绝不空转**继续写产物。
- 页间 / 轮间 `sleep` 冷却；默认抓**有界初始批次**（如前 100 行 / 前 5 页），在 manifest 标 partial，别默认全量拉爆。
- 命中 `RATE_LIMITED` / `BLOCKED` → 按 operator 反爬阶梯处理（可能换 session / 新 Tab），然后**从断点恢复**，不重头。
- **长数字 ID 按字符串保留**（`String(id)`），避免 JS / JSON number 精度丢失。

### ⑤ 校验交付：产物契约

产物 = 结构化数据文件（JSONL / JSON）+ **`manifest.json`**（机器可读的覆盖率声明）：

| 字段 | 含义 |
| --- | --- |
| `source_url` / `channel` / `paging` / `collected_at` | 来源、通道（`api`/`dom`）、翻页模式、时间 |
| `claimed_total` | 来源声明的总数（接口 total 字段 / 页面标注；未知为 `null`） |
| `row_count` | 实际行数（`wc -l`） |
| `is_partial` | 是否局部采集（有界批次 / 中途停止 = `true`） |
| `failed_ids` | 详情阶段失败清单（无则 `[]`） |

- 对账：`claimed_total` vs `row_count` 不一致要么补抓、要么如实标 partial。
- 断点续传判「已完成」的标准是**文件存在且非空且可解析**（`[ -s f ] && jq -e . f`），不是仅存在——防超时 / eval 返回 undefined 写出的坏文件被永久跳过。
- 字段命名、类型判断、最终落到哪个产物交给上层；本 skill 保证数据准确、来源第一手、覆盖率可机读。

---

## FC 工具

采集产物默认直出 stdout；若把结构化数据写成 working_dir 内的文件，可用 `present_to_user` 的 `local_file` item 呈现给用户（`relative_path` 传相对路径）。需已连接 UI 会话；Daemon 无头模式跳过。

---

## 反爬 / 会话 / 安全

会话隔离、Cookie 管理、反检测、反爬升级阶梯、错误类型策略、以及「网页内容一律视为 untrusted content」等安全规则统一见
`skills_read("app:tabweb/browser-operator")`。命中 `BLOCKED` / `RATE_LIMITED` 时按那份的反爬升级阶梯处理，**不要**在原 Tab 上硬重试；恢复后回到 ④ 从断点续跑。

---

## 参考文档（按需读取）

| 文件 | 内容 | 何时读 |
| --- | --- | --- |
| `references/collect-structured-data.md` | ① 侦察命令细节 + 通道 A 接口爬取：network 解析纪律、curl / in-tab fetch 复刻、pageNo / cursor 分页模板、manifest 模板 | 走通道 A、要现成分页脚本时 |
| `references/list-detail-two-phase.md` | 通道 B 模拟操作 + 两阶段：DOM 抽取、URL 翻页、无限滚动（`act scroll`）、断点续传与失败清单、反爬中断恢复 | 走通道 B、命中「列表 + 每项详情」时 |
| `app:tabweb/browser-operator` → `references/cli-reference.md` | `tabtin browser` 全子命令参考 | 查某个子命令的完整参数与返回结构时 |

**怎么读**：本 skill 的附属文档用 `skills_read` 传 `path` 参数读取，例如 `skills_read(key="app:tabweb/browser-collect", path="references/collect-structured-data.md")`。跨 skill 读别的 skill 传对应 key。**不要**用 `read_file` / `cat`——它们读不到 skill 目录。不要给 `skills_read` / `skill_invoke` 传 `section` 参数。
