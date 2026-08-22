# TabDoc Operator · Workflow Patterns

> 本文从主 [`../SKILL.md`](../SKILL.md) 物理拆出（内容逐字保留，未改语义）。

### Pattern 1 — 创建并写入正文

**长文或元数据未确认时：固定走三阶段，正文只提交一次。**

1. **A：先写完整草稿。** 仅当 Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown 草稿时，
   才用 `write_file` 写到相对工作区路径 `.agent-drafts/<slug>.md`。`write_file` 不会展开 shell
   变量；受限 shell 下**禁止**用 `>` 重定向或 heredoc 写草稿。
2. **B：只用可靠的最小参数创建。** 标题确定后，用 `--markdown @文件` 把正文连同
   create 一次提交；用户不会看到空文档。
3. **C：后置修正元数据。** create 成功后，再用 `doc update` 设置或修正 icon、cover、
   parent、tags 等元数据，不要重写正文。

```bash
# A：调用 write_file 工具，把完整 Markdown 写入：
# .agent-drafts/<slug>.md

# B：创建时只提交可靠的 title + 正文；记下 data.document.id
tabtin doc create --title "周报 2026-W18" --markdown @.agent-drafts/<slug>.md --format json

# C：仅修正元数据，不传正文；tags 不在 create schema，只能在这里设置
tabtin doc update <document-id> --icon 📊 --cover-image "https://example.com/cover.png" --parent-id <parent-id> --tags 周报 --tags 项目
```

**失败恢复纪律**：
- create 仅在 CLI **明确返回参数/校验错误**时，才可只修正 title 等短参数并**复用同一份草稿文件**重试 create；不要重新生成或重写正文。
- 网络超时、断连等**结果未知**时，**不得直接重试 create**：后端没有幂等键，先运行
  `tabtin doc search --query "<title>" --format json` 核对是否已创建；若无法唯一确认，必须请求用户确认后再继续。
- create 成功、元数据 update 失败时，正文草稿与已创建正文不受影响。明确校验错误只修正元数据再重试
  update；如果 CLI 实际返回 `409`，才遵循既有通用处理：先运行
  `tabtin doc read <document-id> --format json` 获取当前 `latest_version`，判断后带新的
  `--base-version <latest-version>` 重试 update。这不是该创建后元数据流程的并发保证；**绝不**重写正文或调用
  `save-content`。

**快捷路径：短文且所有参数已确定时，可走一步创建快捷路径**，并带上 create 支持的元数据：

```bash
# 读取用户已有 / 已存在的本地 Markdown；不是 Agent 用 write_file 新建临时草稿的路径
tabtin doc create --title "周报 2026-W18" --markdown @./weekly.md --icon 📊 --cover-image "https://example.com/cover.png" --parent-id <parent-id> --format json
# create 不支持 --tags；需要 tags 时仍在创建成功后用 doc update <document-id> --tags 周报
```

Agent 为新建或整篇更新长 TabDoc 正文而新建草稿时，仍只能用 `write_file` 创建工作区相对
`.agent-drafts/<slug>.md`，再通过 `--markdown @.agent-drafts/<slug>.md` 上传；这不适用于其它 Agent 临时 Markdown、Plan 或 Study 草稿。

草稿用于当前任务的可恢复重试；任务成功后按现有工作目录策略保留，不自动删除，也不要求用户清理。

**注意**：`save-content` 是**整体替换**——**只在「大改 / 整篇重写」时用**。小改**别用它**（旧做法「read 全文 → 本地拼接 → 整篇 save」已废弃：费 token、易误改无关段、协作冲突面大）：

| 你要做的 | 用这个（只动目标块，不重写全文） |
|---|---|
| 末尾加一段 | `doc append <id> --markdown <...>` |
| 在某段后插入 | `doc insert-block <id> --markdown <...> --after <block-id>` |
| 改某一段 | `doc update-block <id> <block-id> --markdown <...>` |
| 删某一段 | `doc delete-block <id> <block-id>` |

`block-id` 先用 `doc list-blocks <id>` 拿。整篇替换（save-content）仍 **`--base-version` 必传 + 409 重试**；block 命令也接受 `--base-version`。

**导出到本地 ≠ save-content**：

```bash
# ✅ 把云端文档导出成工作目录里的 markdown（只读，不改文档）
tabtin doc export <document-id> --export-format markdown --output ./报告.md

# ❌ 禁止：把目标路径塞进 --markdown（少写 @ 时会把路径字符串整篇盖进正文）
# tabtin doc save-content <id> --markdown "$TABTIN_WORKSPACE/报告.md"
```

### Pattern 1b — 嵌入 TabData 多维表（tabdataBlock）

**多维表嵌入 ≠ markdown 管道表。** `| a | b |` 只生成普通 `table` block；要在文档里挂一张真实 TabData，必须走 `tabdataBlock`。

**可粘贴工作流**：

```bash
# 1. 建表（或 table list 复用已有表），记下 data.id / table_id
tabtin table create --name "销售明细" --format json

# 2. 一等命令嵌入——自动生成带双引号的 :::tabdata{tableId="..."}，空 id 硬失败
tabtin doc embed-table <document-id> --table-id <table-id> --title "销售明细" --format json

# 3. 回读验证：list-blocks 应出现 type=tabdataBlock，且 attrs 带正确 tableId
tabtin doc list-blocks <document-id> --format json
tabtin doc read-block <document-id> <block-id> --format json
```

**禁止**：
- 手写 `:::tabdata{tableId=xxx}`（无双引号）——CLI/API 硬失败，不再静默成功
- 用管道表冒充多维表嵌入
- 把空 `--table-id` 当成功

### Pattern 2 — 搜索 + 摘要

**决策树（先读再动 CLI）**：

| 用户意图 | 用什么 | 禁止 |
|---------|--------|------|
| 找 / 搜 / 检索 **XX 文档**（标题或正文关键词） | `tabtin doc search --query "…"` | `rag_search`；`doc list` 筛标题冒充 search |
| 已知文档，找正文里**哪一段 / 哪个 block**含关键词 | `tabtin doc search-blocks <document-id> --query "…"` | `list-blocks` 只看 80 字 preview 后猜 block |
| 列出全部 / 最近文档（无关键词） | `tabtin doc list --format json` | 在用户给了搜索词时还走 list |
| 语义相似 / 跨表·邮件·知识库向量探索 | `rag_search`（用户明确或任务与 TabDoc 无关） | 替代上面的 doc search |

```bash
# 1. 关键词搜索（找文档的第一步）
tabtin doc search --query "项目进展" --format json | jq '.data.items[] | {id: .document.id, title: .document.title, snippet}'

# 2. 命中正文后，在目标文档里定位具体 block
tabtin doc search-blocks <document-id> --query "项目进展" --format json | jq '.data.blocks[] | {block_id, index, snippet}'

# 3. 读准目标 block，再决定是否 update-block / insert-block / delete-block
tabtin doc read-block <document-id> <block-id>
```

**用户说「找 / 搜 / 检索 XX 文档」=必须走 `doc search`**——别图省事改用 `rag_search` 或 `doc list` 在客户端按标题字符串过滤：
- list 只看标题，正文含关键词但标题不含时漏检（典型：「周末攻略」正文写满杭州 → 搜「杭州」漏）
- list 没 snippet，用户看不到命中上下文
- `dev` 用 SQLite 时中文 FULLTEXT 可能返回空——这是已知 backend 限制，不是 fallback 到 list 的理由；若 0 命中要在回复里如实说明、提示用户换关键词，**不要静默退化**

### 文档列表 / 检索结果回复模板（chat 输出协议）

> 主契约 + 可粘贴样板见顶部 [输出契约（Hard Contract）](#输出契约hard-contract--必读)；本段补 Parser 兜底说明，**别**当成写法许可。

Parser 双端（TS + Python）加了三类容错别名让历史 typo 不至于完全打不开：

| 输入 | 解析为 | 你仍应输出 |
|---|---|---|
| `tabtin://resource/doc/<id>?hint=tabdoc` | `document` + `tabdoc` | `document` + `tabdoc` |
| `tabtin://resource/document/<id>?hint=document` | `document` + `tabdoc` | `document` + `tabdoc` |
| `tabtin://resource/document/<id>?hint=doc` | `document` + `tabdoc` | `document` + `tabdoc` |

**别名是兜底，不是写法许可**——你输出时仍走 canonical `tabtin://resource/document/<id>?hint=tabdoc`，别赌别人 parser 都装好了同款别名（外部分享 / 第三方集成 / 老版本客户端都可能没有）。

### Pattern 3 — 长文档省 token 阅读

文档很长（超过几千 token）时，**别直接 `tabtin doc read`**。有关键词就先 `search-blocks` 直达命中块；没有关键词、只是浏览结构时再用 `list-blocks` 看大纲：

```bash
# 1. 有关键词：直接定位命中 block
tabtin doc search-blocks <document-id> --query "项目进展" --format json

# 2. 无关键词：看顶层 block 结构
tabtin doc list-blocks <document-id> --format json
# 返回 [{id, type, level, preview, index}, ...]
# preview 是每个 block 前 80 字符

# 3. 根据命中块或大纲决定要不要读全文
tabtin doc read <document-id>
```

**`list-blocks` vs `chunks` 怎么选**：
- 中等文档（几千 token）：`list-blocks` 看大纲 → `read` 取全文（一次拿完）
- 超大文档（几万 token+）：`list-blocks` 看大纲 → `chunks --start N --limit 10` 按页拉 blob
  （`chunks` 每块含 plaintext_preview + binary blob，按 chunk_index 翻页省 token 极限场景才用）

### Pattern 4 — 重组 / 删除生命周期

**先看当前状态再决定下一步**：

```bash
tabtin doc read <document-id> --jq '.document.status'
# active / archived / trashed —— 决定走 unarchive 还是 restore
```

tabdoc 有**三级软删**，删得越深恢复路径越不同——别一上来就 permanent-delete：

```bash
# 改父文档（重组层级）
tabtin doc update <document-id> --parent-id <new-parent-id>

# ── 第一级：归档（冷存储，最轻）──
tabtin doc delete <document-id>             # 等价 doc update --status archived
tabtin doc unarchive <document-id>          # 解档恢复（archived → active）

# ── 第二级：回收站（可恢复的删除）──
tabtin doc trash <document-id>              # active/archived → trashed
tabtin doc restore <document-id>            # 从回收站恢复（trashed → 原状态）

# ── 第三级：永久删除（终点，不可恢复）──
# 前置：文档必须先在回收站（先 doc trash）；需要 admin 角色
tabtin doc permanent-delete <document-id> --dry-run   # 先预演
tabtin doc permanent-delete <document-id> --yes       # 框架强制 --yes 才真删
```

**恢复路径要对**：从归档回来用 `unarchive`，从回收站回来用 `restore`——这是两个不同的逆操作，别混。`restore` 是"回收站恢复"，**不是**"恢复到某个历史版本"（版本回滚走另一条端点）。

### Pattern 5 — 提取正文给下游使用

```bash
# 拿 Markdown
tabtin doc read <document-id> --format json | jq -r '.data.content.description_markdown'

# 部分文档
tabtin doc list-blocks <document-id> --format json | jq '.data.blocks[] | select(.type == "heading")'
```

### Pattern 6 — 版本管理（历史 / 命名版本 / 回滚）

`doc version` 是 `doc` 下的嵌套子命令组，对接 V3 版本历史（`collab.VersionHistory`）。

**先理解两条平行的版本通道**——避免误把命名版本当成 agent 的常规写动作：

| 通道 | 谁用 | 怎么触发 | 用途 |
|---|---|---|---|
| **命名版本**（`doc version save/rename/rm`） | **用户** | UI 里 Cmd+Shift+S / VersionPanel 输入名+保存 | 用户的里程碑（v1 发布 / 评审稿 / 归档） |
| **自动版本历史**（`doc version list/preview/restore`） | **agent + 用户共用** | 每次写文档自动产生（含 `editor_type='agent'` + `agent_run_id`）| agent 操作回滚 / 历史追溯 |
| **Checkpoint 回滚**（chat 里"回退到此消息"） | **系统自动** | Agent 每次 tool 调用前 / 审批前 | 回退所有 AI 操作（跨文件 + 多资源聚合）|

**关键：agent 写入 doc 时 collab 体系会自动产生带 `agent_run_id` 的版本节点**——agent 不需要也不应该再用 `version save` 去"记录自己刚做的事"，这会污染用户的命名版本视图（用户视角下"命名版本"标签里应该都是他自己打的里程碑）。

#### 6.1 读侧：agent 自然要用（list / preview / restore）

```bash
# 1. 看版本历史，挑出要回滚 / 操作的版本 id
tabtin doc version list <document-id> --format json | jq '.data.histories[] | {id, name, is_named, editor_type, created_at}'
#   重点看 editor_type：user/agent/system，能区分某版本是用户手改的还是 agent 写的

# 2. 回滚前先预览该版本内容，确认没挑错
tabtin doc version preview <document-id> <history-id> --jq .markdown

# 3. 恢复到该版本（推荐带 --base-version 做并发保护）
tabtin doc read <document-id> --format json | jq '.data.document.latest_version'
tabtin doc version restore <document-id> <history-id> --base-version 12
```

> ⚠️ **协作场景慎用 restore**：`doc version restore` 会**断开当前在线协作连接**
> （Hocuspocus force_close）——在线编辑的用户会突然被踢出。在多人协作的文档上做 restore 前，
> 应先通知用户保存当前编辑、或确认无人在编辑。
> 如果 collab-live 不可用，restore 会返回 200 + `warning="format_conversion_pending"`
> 或 `collab_sync_warning` 字段——别只看 HTTP 200，要看 warning。

#### 6.2 写侧：用户明示才动（save / rename / rm）

`save / rename / rm` 是**用户主动的 UI 行为**——用户在编辑器里有快捷键（Cmd+Shift+S）和 VersionPanel 输入框可直接操作。**默认不要主动调**，只在以下场景代为执行：

| 用户明示这样说 | 该用哪条 |
|---|---|
| "发布前帮我备个版本叫 v1" / "打个里程碑" / "存一下当前版本" | `doc version save <id> --name "<用户给的名>"` |
| "把 v1 这个版本改名为 v1.0 评审稿" | `doc version rename <id> <vid> "<新名>"` |
| "把那个 v0 草稿命名版本删了" / "清理一下命名版本" | `doc version rm <id> <vid>`（**操作前先 `version list --jq '.histories[] \| select(.is_named)'` 给用户确认哪几条**）|

**不要在以下场景主动调 save**：
- agent 写完一稿文档想"记录一下"——collab 体系已经自动产生带 `agent_run_id` 的 VH 节点，restore 走 `version list` + `version restore` 即可
- agent 大改前想"备份"——这是 Checkpoint 体系的职责，不是命名版本
- 批量任务里给每个文档自动打版本——会快速撞 50 个/文档配额（`CAP-017`）+ 污染用户视图

```bash
# 用户明示场景示例：
tabtin doc version save <document-id> --name "v1 正式发布"        # 用户说"发布前备个版本叫 v1 正式发布"
tabtin doc version rename <document-id> <version-id> "v1（已评审）" # 用户说"v1 改名为 v1（已评审）"
tabtin doc version rm <document-id> <version-id>                    # 用户说"删掉这个旧版本"

# 任何 version 写操作都支持 dry-run 预演
tabtin doc version save <document-id> --dry-run --format json
```

**`doc version restore`（版本回滚）vs `doc restore`（回收站恢复）vs chat 里"回退到此消息"是三件事**：
- `doc version restore`：单文档回到某历史版本（用户/agent 都可用）
- `doc restore`：把回收站里的整个文档拿回来
- chat 里"回退到此消息"（Checkpoint）：跨文件/多资源/对话状态聚合回滚——**agent 不直接调，由用户在 chat UI 触发**

命名版本上限：每文档最多 50 个，超出 `doc version save` 报 `VALIDATION_ERROR`——这个配额本身就是后端的反诱导设计（`CAP-017: 防止 Agent 高频调用无限膨胀`），别去撞。

### Pattern 7 — 协作者管理（邀请 / 改权限 / 移除）

`doc collaborator` 是 `doc` 下的嵌套子命令组，对接后端 `/documents/{id}/collaborators` 端点。**权限是固定三档 `viewer`/`editor`/`admin`**；邀请/改权限/移除都需要你对该文档有 **owner 或 admin** 角色，list 只需 viewer+。

#### 用户只给了 email，怎么找 user-id

用户的指令 99% 是 "邀请 zhang@example.com 编辑这个文档"——但 `invite --user-ids` 只接 UUID 形态的 user-id。**别让用户输 user-id（UX 灾难），自己走下面任一路径反查**：

```bash
# 路径 1（推荐，小 organization <50 人）：拉全成员后 jq 反查
tabtin organization members --format json \
  | jq -r '.data.members[] | select(.user.email=="zhang@example.com") | .user.id'

# 路径 2（推荐，大 organization）：直接用 CLI 搜同组织成员
#   后端 list_members 支持模糊匹配 email/phone/nickname/username；
#   多组织时务必显式传文档所属 --organization-id，避免搜错组织。
tabtin organization members --organization-id <organization-id> --search zhang@example.com --format json \
  | jq -r '.data.members[0].user.id'

# 反查到 id 后再调 invite
tabtin doc collaborator invite <document-id> --user-ids <uid> --role editor
```

**反查不到怎么办**：
- 后端 `_filter_organization_members` 强制"被邀请人必须是同 organization 成员"——
  不在同 wt 的 email 现在**找不到也邀不动**（会被 `invite` 静默 skip 进 `not_in_organization`）
- 跨 organization 邀请属于"外部协作者"PRD 范围（`docs/prd/cross-organization-collaboration-v1.md`），
  **未实施**——告诉用户"对方需先加入本组织，或我帮你建一个 organization 分享链接（`doc share set --share-type organization`）"

```bash
# 1. 看现有协作者（含 owner），拿到各人的 user_id
tabtin doc collaborator list <document-id> --format json | jq '{owner: .data.owner.user_id, collaborators: [.data.collaborators[] | {user_id, permission}]}'

# 2. 批量邀请（按 user-id，不是 email）——--user-ids 可重复传多个，单次上限 50；所有人授同一权限
tabtin doc collaborator invite <document-id> --user-ids usr_aaa --user-ids usr_bbb --role editor --format json
#   返回 {notified, skipped:[{user_id, reason}]}，必须检查 skipped：
#   - 已是该权限的人沉默跳过（不计入 notified、不进 skipped）
#   - 非同 organization 成员 → skipped 标 not_in_organization；邀请自己 → self；邀请 owner → is_owner

# 3. 改某人权限（owner 的权限不可改，会报 CANNOT_MODIFY_OWNER）
tabtin doc collaborator update <document-id> usr_aaa --role admin

# 4. 移除协作者（软删，可用 invite 重新激活；owner 不可移除，报 CANNOT_REMOVE_OWNER）
tabtin doc collaborator rm <document-id> usr_aaa --dry-run    # 先预演
tabtin doc collaborator rm <document-id> usr_aaa             # RiskWrite，无需 --yes
```

**关键语义**：
- **按 user-id 邀请，不是 email**——`--user-ids` 接的是用户 ID（先用别处的用户检索拿到 id）。
- **被邀请人必须是同 organization 成员**，否则进 `skipped` 的 `not_in_organization`，不会报错中断。
- **`rm` 是软删可逆**（收回访问、置 `is_active=False`），之后 `invite` 同一人会重新激活——所以是 `RiskWrite` 不强制 `--yes`，但仍可 `--dry-run` 预演。
- `update` / `rm` 的 `<user-id>` 是**协作者**的 id（取自 `collaborator list`），不是 owner。

### Pattern 8 — 导入外部内容（草稿 → 落库）

**关键边界**：`doc import` 系列只做"转换"产出草稿（`{pm_json, markdown, plaintext}`），**不直接创建文档**。落库必须接 `doc create` / `doc save-content`。

**Markdown 场景：直接用 `save-content`，不用 `import markdown`**
markdown 落库不需要 import——`doc save-content <id> --markdown @file` 一步搞定（服务端自动转 pm_json）。
`doc import markdown` 主要服务的是**前端两步导入流程**（前端拿 `pm_json` 在客户端做归一化校验后再 `create`，
见 `apps/tabtin-electron/.../ContextHome.tsx` + `packages/tabdoc-ui/.../DocList.tsx`）。
**agent 几乎不用**——除非你确实要先拿 `pm_json/plaintext` 做预览 / 校验 / 二次加工，否则一律走 `create --markdown` 或 `save-content --markdown` 一步搞定。

**PDF/Word 场景：必须三步（上传 OSS 取 file_id → import 转草稿 → save 落库）**

```bash
FID=$(tabtin oss upload ./report.pdf --format json | jq -r '.data.file_id')
tabtin doc import file --file-record-id "$FID" --format json | jq -r '.data.markdown' > /tmp/draft.md
tabtin doc create --title "导入：季度报告" --format json   # 记下 .data.document.id
tabtin doc save-content <document-id> --markdown @/tmp/draft.md
```

> ⚠️ **常见踩坑**：如果 `doc import file` 报 `403 PERMISSION_DENIED tabdoc.file_not_in_organization`，
> 原因多半是 daemon 跑在 organization A 但 CLI profile.DefaultOrganization 是 organization B（多 profile 切换
> 不重启 daemon 会触发）—— 用 `tabtin auth whoami` 看 CLI 当前 organization，对照 daemon 起的
> organization，必要时 `tabtin-daemon init --force` 切对 organization 再试。

**其它边界**：markdown 上限 5MB；PDF/Word 解析后段数超上限会报 `VALIDATION_ERROR`；导入和落库都需 **editor** 角色；任何 `doc import file` 调用可加 `--dry-run --format json` 预演不调后端。

### Pattern 9 — 文档分享（public vs organization）

`doc share` 是 `doc` 下的嵌套子命令组，对接后端 `/documents/{id}/share[/refresh]`。这是一个**有控制的分享系统**，不是无脑公开链接——`set` 的 **`--share-type` 必须显式传**（无默认值，强制你有意识地选）。

> ⚠️ **安全第一**：`public` 分享 = **免登录、任何拿到链接的人都能访问**。敏感文档**优先用 `organization`**（限组织成员、需登录）。扩到 `public` **必须**加 `--acknowledge-public-exposure`（否则 409），并建议加 `--password` / `--expire-hours`。永远不要无脑对敏感内容建裸 `public` 链接。

```bash
# ── 推荐：先开 organization（组织内）──
tabtin doc share set <document-id> --share-type organization --organization-id wt_yyy --format json

# ── public 分享（免登录链接）——须确认公网暴露 + 敏感内容请加密码/有效期 ──
tabtin doc share set <document-id> --share-type public --acknowledge-public-exposure --password s3cret --expire-hours 24 --format json
#   返回 {share:{share_id, ...}}；share_id 是短链 token，访问者凭它访问。
#   缺 --acknowledge-public-exposure → 409 PUBLIC_EXPOSURE_ACK_REQUIRED
#   --permission view|comment|edit（默认 view，注意不是协作者那套 viewer/editor/admin）
#   --allow-download=false / --allow-copy=false 关掉下载/复制（默认都允许）
#   --password 三态：不传=保留旧密码；传空串 ""=清空密码；传非空=设新密码

# ── 查看当前有效分享（只读；省略 --share-type）──
tabtin doc share get <document-id> --format json | jq '.data.share | {share_id, share_type, has_password, expire_at, visit_count}'
tabtin doc share get <document-id> --share-type organization --format json   # 显式查指定类型

# ── 链接疑似泄露：轮换短链（旧链接立即失效，分享配置不变）──
tabtin doc share refresh <document-id> --dry-run --format json   # 先预演
tabtin doc share refresh <document-id> --format json             # 轮换当前有效分享

# ── 关闭分享（软删，可用 set 重开）──
tabtin doc share off <document-id> --dry-run --format json
tabtin doc share off <document-id>                               # 关闭当前有效分享；RiskWrite，无需 --yes
```

**关键语义**：
- **`set` 的 `--share-type` 必填且无默认**（安全设计）——逼你显式区分 `public`（全网可达）与 `organization`（限组织）。后端只接受这两种。
- **扩到 public 须 `--acknowledge-public-exposure`**：与 UI ConfirmDialog 对齐的后端强制确认；已有 active public 时仅改权限/密码无需重复确认。
- **`set` 是互斥 create-or-update**：每文档最多一个 active 分享；切类型会停用另一类型，旧 `share_id` 立即失效。
- **share 的 `--permission` 是 `view`/`comment`/`edit`**（默认 `view`），**与协作者命令的 `viewer`/`editor`/`admin` 不是一回事**，别混。
- **`organization` 目标组织 = 资源所属组织（严格不可跨）**：当前后端
  `DocumentShareService.validate_organization_scope` 强制目标 organization ≡ 文档所属 organization，
  跨组织分享会返回 400 `INVALID_ORGANIZATION_ID`。所以全局 `--organization-id` 兼任"当前操作上下文"
  和"分享目标组织"（二者必相等）。**agent 接到"分享给另一个组织"的需求**：直接告诉用户做不到，
  改用 public 链接 + 密码 / 改邀请目标组织成员为协作者。0.9.3 跨组织分享已下线，本期不支持。
- **`get` / `off` / `refresh` 省略 `--share-type`** → 操作当前有效分享；也可显式传 `public|organization`。
- **`refresh` 只换 share_id 短链 token**，不删分享、不动权限/密码/有效期——专治"链接泄露需作废重发"。
- **`off` 是软删**（`is_active=False`），不物理删除，之后 `set` 可重开，故 `RiskWrite` 不强制 `--yes`。

### Pattern 10 — 嵌入交互式 HTML 块（架构图 / 原型 / 可视化）

`doc insert-html` / `doc update-html` 让你把一份**自包含单文件 HTML**（内联 CSS/JS、可交互）作为一个块放进文档。对标飞书：HTML 以**私有文件附件**上传 OSS，文档块只存 `fileId`（新块 `src=""`），前端用**沙箱 iframe** + 授权 Blob 在线渲染，权限跟随所属文档 / 文档分享。

**什么时候用 HTML 块 vs 别的**：

| 你要嵌入的 | 用什么 |
|---|---|
| 静态图片（已有 URL） | markdown `![alt](url)` |
| 静态图片（本地文件） | `doc insert-image`（见 Pattern 11，自动上传 OSS + 拼 markdown） |
| 数据表 | `:::tabdata{tableId="..."}` |
| 流程图 | 静态图片或 HTML 块（按交互需求选择） |
| **自定义交互 HTML**（架构图/脑暴板/原型/数据可视化，可点可拖） | **HTML 块（`doc insert-html`）** |
| 正文里几个 `<div>`/`<span>` | 别塞——渲染层 sanitize 会吃掉（见主 SKILL「雷区」6）|

**插入：一步到位（内部私有上传 + 拼 `:::htmlblock{...}` + 插块）**

```bash
# 把本地 .html 私有传到 OSS 并作为 HTML 块插入——一条命令
tabtin doc insert-html <document-id> --file ./architecture.html --title "系统架构图" --height 600 --format json
#   返回 data.file_id + data.url="" + data.block（插块结果，含 inserted_block_ids）
#   --title 缺省用文件名去扩展名；--height 缺省 480；--after <block-id> 插到某块之后，缺省追加末尾

# 先预演（不发请求，看两步 plan）
tabtin doc insert-html <document-id> --file ./architecture.html --dry-run --format json
```

**编辑回路：读 → 授权下载 → 本地改 → 重传替换**（HTML 正文在 OSS 上，不在文档里）

```bash
# 1. read-block 看到 HTML 块：:::htmlblock{fileId="..." src="" title="架构图" height="480"}
tabtin doc read-block <document-id> <block-id> --jq .markdown
FILE_ID=$(tabtin doc read-block <document-id> <block-id> --jq .markdown | grep -oE 'fileId="[^"]+"' | head -1 | sed 's/fileId="//;s/"//')

# 2. 授权端点下载（JWT；禁止匿名 curl 永久 OSS URL）
curl -fsSL -H "Authorization: Bearer $TABTIN_TOKEN" \
  "$TABTIN_API_BASE/api/tabdoc/documents/<document-id>/html-artifacts/$FILE_ID" \
  -o /tmp/edit.html

# 3. 本地改 /tmp/edit.html …

# 4. update-html 重传替换（缺 --title/--height 沿用现有块；目标块不是 HTML 块会报错退出）
tabtin doc update-html <document-id> <block-id> --file /tmp/edit.html --format json
```

**关键语义 / 雷区**：

- **markdown 块契约固定**：`:::htmlblock{fileId="..." src="..." title="..." height="480"}`，属性顺序 `fileId, src, title, height`；`height` 是数字。新块 `src=""`；历史块可能仍有非空 `src`（仅兼容回退）。命令替你拼，一般无需手写——若手写走 `insert-block --markdown`，属性顺序/引号别错。
- **新 HTML 默认私有，权限跟随文档**：成员走文档 viewer ACL；访客走 DocumentShare。不要假设 `src` 可匿名打开。
- **iframe 是沙箱**：渲染时无宿主权限——拿不到 TabTin cookie / 登录态、调不了 TabTin API、跨不了同源。HTML 必须能独立运行。
- **必须自包含单文件**：CSS/JS 尽量内联；外链资源必须 **https** 且沙箱内可达（公网 CDN 行，内网 / 需登录的不行）。
- **上传路径白名单**：`--file` 只接 `$HOME` / `/tmp` 下路径（symlink 被拒），单文件 ≤100MB——先把 HTML 写到 `~/` 或 `/tmp/` 再传。
- **写块失败可重试不必重传**：若上传成功但插块 / 替换失败，错误 `detail` 保留 `file_id` + 已拼好的 `markdown` + 一条 `recovery_command`（`doc insert-block` / `doc update-block`），直接跑那条补写即可，不用重新上传。
- 两条都是 `RiskWrite`，都支持 `--dry-run` 预演多步 plan。

### Pattern 11 — 插入本地图片（上传 OSS + 拼 Markdown 图片）

`doc insert-image` 让你把一张**本地图片文件**（截图 / 生成的图表 / 下载的图片）作为标准 Markdown 图片放进文档正文——`![alt](url)`，不是自定义块，渲染层原生支持，无需沙箱。跟 insert-html 同一套"上传→拼块"两步编排，但更轻：不涉及 directive、不涉及 title/height。

**什么时候用 insert-image vs 直写 markdown**：

| 你手上有的 | 用什么 |
|---|---|
| **已有公开图片 URL**（别处上传好的、外链图床） | 直接 `--markdown "![alt](url)"` 走 `insert-block` / `append` |
| **本地图片文件**（还没上传） | `doc insert-image`（自动上传 + 拼块，省一次手动 `oss upload` + 拼 markdown） |

**插入：一步到位（内部上传 OSS + 拼 `![alt](url)` + 插块）**

```bash
tabtin doc insert-image <document-id> --file ./chart.png --alt "销售趋势图" --format json
#   返回 data.file_id + data.url（OSS 公开 URL）+ data.markdown + data.block（插块结果，含 inserted_block_ids）
#   --alt 缺省用文件名去扩展名；--after <block-id> 插到某块之后，缺省追加末尾

# 先预演（不发请求，看两步 plan）
tabtin doc insert-image <document-id> --file ./chart.png --dry-run --format json
```

**关键语义 / 雷区**：

- **支持扩展名**：png/jpg/jpeg/gif/webp/svg；上传路径白名单同 `insert-html`——只接 `$HOME` / `/tmp` 下路径（symlink 被拒），单文件 ≤100MB。
- **不固定 `mime_type`**：跟 insert-html 固定 `text/html` 不同，图片扩展名多样，交给服务端按扩展名自动识别。
- **写块失败可重试不必重传**：若上传成功但插块失败，错误 `detail` 保留 `file_id` + 已拼好的 `markdown` + 一条 `recovery_command`（`doc insert-block`），直接跑那条补写即可，不用重新上传。
- **目前只覆盖插入**：替换已插入图片的图暂无一等命令（≈ `update-html` 的等价物未做），改法是 `list-blocks` 找到目标块、`insert-image` 插新图、再 `delete-block` 删旧块。
- `RiskWrite`，支持 `--dry-run` 预演两步 plan。
