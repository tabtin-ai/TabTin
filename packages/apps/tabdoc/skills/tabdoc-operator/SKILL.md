---
name: tabdoc-operator
description: >
  文档操作——创建、编辑、检索、整理叙事性长文档、
  报告、需求 spec、会议纪要、知识沉淀。用户要写 /
  改 / 查长文档时使用；正文给出 `tabtin doc` CLI 的稳定操作流程。
metadata:
  version: 0.14.6
  tabtin:
    category: doc
    displayName: "TabDoc Operator"
    tags:
      - document
      - knowledge
      - search
    autoActivateFor:
      - tabdoc
    tools:
      - execute_command
---

# TabDoc Operator

任务涉及创建 / 编辑 / 检索 / 组织 TabDoc 文档时使用本 skill。

> **范式说明**：tabdoc 操作走 `tabtin doc` CLI（通过 `execute_command` 调），**不依赖 FC 工具**。这跟其他已启用的内置 App 一致。
>
> 如果你以前看过的版本里有 `tabdoc_create_document` / `tabdoc_update_document` 等 FC 工具——它们已**全部退役**，你不会在工具清单里看到。
>
> **当前网页生成 TabDoc**是通用网页导入：先由 Browser Operator 锁定当前 Tab 的 `<locked-tab-id>`，执行 `tabtin browser print --include all --tab-id <locked-tab-id> --save <path.md>`，再用本 skill 建文档。来源站点不改变这条路线。
> 只有用户**明确要求迁移飞书云盘、飞书知识库或飞书资产**时，才用 `skills_read("app:tabtin-integrations-lite-pack/feishu-import-to-org")` 与 `tabtin feishu *`；仅凭 URL 或域名不能改走飞书专用通道。

## 当前网页导入契约（Hard Contract · 必读）

1. 接手 Browser Operator 通过当前 Tab 产出的 `--include all` Markdown 与资源清单；不能用默认 print 的纯正文产物，因为它会剥掉图片、链接和表格。
2. 正文里的公开长期 URL 可以保留。`blob:`、登录态图片、短期签名 URL 等资源必须先用 `tabtin browser resource download --tab-id <locked-tab-id> --url <url>` 从同一锁定 Tab 下载，再用 `tabtin oss upload` 得到稳定 URL，替换 Markdown 中对应的图片 / 资源引用后创建文档；文档已创建时可用 `doc insert-image` 补入本地图片。
3. 用 `tabtin doc create --title <title> --markdown @<path.md>` 建文档；若需走 Markdown 草稿转换，也必须把 `doc import markdown` 的结果继续写入 create / save-content，不能把草稿当成最终文档。
4. 创建后读取目标文档，按源页面与采集结果核对标题 / 正文，以及图片、链接、表格的数量和关键内容。任何资源下载、上传、替换或渲染失败都要列为缺失项；不得在仍有缺失或失败时声称完整导入成功。

## 正文标题契约（Hard Contract · 必读）

TabDoc 的 `title` 就是整篇文章标题，`content` 不是一份需要自带标题的独立 Markdown 文件。Agent 新建或整篇重写正文时：

- `tabtin doc create --title "<标题>"` 负责整篇文章标题；上传的 Markdown content **不得再以任何文章级 `# <标题>` 开头**。
- 正文直接从导语开始；章节从 `##` 开始。不要为了“Markdown 完整性”补一个全文大标题。
- 更新既有文档时同样遵守：title 留在元数据，content 首块不是 H1。
- CLI 只做结构兜底：create 的 content 若以 H1 开头，发送前移除首个 H1；`save-content` 显式传 `--title` 时同样移除首个 H1，没传 `--title` 则拒绝这类写入。

完成标准：生成草稿后检查首个非空块；它不能是 H1。

## 输出契约（Hard Contract · 必读）

**任何 chat 回复里出现 doc 标题（list / search / create / read / 提到某文档），都必须写成 markdown link**——否则用户得手动去侧栏找，体验断裂。canonical 形态唯一：

```markdown
[<title>](tabtin://resource/document/<id>?hint=tabdoc)
```

| 字段 | 取值 | 不能写成 |
|---|---|---|
| path 第 1 段 | `document` | ❌ `doc` `tabdoc` `documents` |
| `hint` | `tabdoc` | ❌ `document` `tabdocs` `doc` |

**list / search 结果回复样板（直接抄）**：

```markdown
找到 3 篇文档：

| 标题 | 创建 | 版本 |
|------|------|------|
| [厦门旅游](tabtin://resource/document/8a21f144-46d2-4f8c-ae08-519a6fce9605?hint=tabdoc) | 5/28 12:39 | v3 |
| [杭州旅游](tabtin://resource/document/a926ea31-9902-48c1-970e-d0f6a8fa4ae5?hint=tabdoc) | 5/28 02:58 | v4 |
| [东北旅游](tabtin://resource/document/5f4d3938-ea46-4bd3-8b8b-22bba7a6a69c?hint=tabdoc) | 5/27 13:24 | v3 |
```

**search 带 snippet 的样板**：

```markdown
找到 2 条匹配 "项目进展"：

- [Q3 周报](tabtin://resource/document/d7f34d67-2c1a-4b6e-9f30-8e5a1c7d4b21?hint=tabdoc) — *…本周项目进展顺利，三个里程碑按期…*
- [产品规划](tabtin://resource/document/ad070d7b-58e3-4f92-b1c6-3d9a72e05f48?hint=tabdoc) — *…下半年核心项目进展将聚焦在…*
```

**`<id>` 必须写完整**——从 CLI 输出里原样复制整个 id，一个字符都不能省。snippet 正文可以用 `…` 截断，**链接里的 id 绝对不行**：截断的 id（如 `02eda024-5f11-…`）会原样进用户界面的产物卡片，点击后端直接报「document_id 不是合法 UUID」。

**禁止形态**（用户点不动）：

```text
**厦门旅游**                                                  ❌ 纯加粗，无链接
| 厦门旅游 |                                                  ❌ 表格里纯字符串
**厦门旅游** 🟢                                               ❌ 装饰性 emoji 替代不了 link
[厦门旅游](tabtin://resource/doc/<id>?hint=document)         ❌ type/hint 双 typo
[厦门旅游](tabtin://resource/document/<id>?hint=document)    ❌ hint 错（应为 tabdoc）
[厦门旅游](tabtin://resource/document/02eda024-…?hint=tabdoc) ❌ id 被截断（必须完整复制）
tabtin://resource/document/02eda024-5f11-4d4a-85c2-…         ❌ 裸链接 + 截断 id，双重违约
```

> 字段反例对照表 + Parser 兜底别名说明见 [Pattern 2 文末「回复模板」段](#文档列表--检索结果回复模板chat-输出协议)；本契约一切场景适用，**别名是兜底，不是写法许可**。

## 输出协议与 jq 路径约定

`--format json` 输出的 stdout 是**完整 envelope**：

```json
{"ok": true, "data": {"<真实业务数据>": "..."}, "meta": {"...": "..."}}
```

所以 jq 路径要分清两种情形：

- **外部管道 `| jq`** 拿到的是完整 envelope，**所有路径都要 `.data.` 前缀**：
  `tabtin doc read doc_xxx --format json | jq '.data.document.latest_version'`
- **CLI 内置 `--jq`** 自动 unwrap 一层 envelope，**直接写 `.foo` 不加 `.data.`**：
  `tabtin doc read doc_xxx --jq '.document.latest_version'`

下面所有 Pattern 的 jq 示例都遵循此约定。如果你跑出来 jq 拿不到值，**99% 是这两种路径混了**——
重新检查你用的是 `| jq` 还是 `--jq`。

## 正文字段命名速查

TabDoc 读写字段名不是同一套，直接调 REST 或写 jq 时按场景区分：

- **创建请求**：`initial_content_markdown` / `initial_content_pm_json` / `initial_content_plaintext`；CLI `doc create --markdown` 会替你映射。
- **保存请求**：`content_markdown` / `content_pm_json` / `content_plaintext`；CLI `doc save-content --markdown` 会替你映射。
- **读取响应**：`doc read` 返回的 `content` 里用 `description_markdown` / `description_json` / `description_plaintext`。
- **分块读取**：`doc chunks` 的二进制块字段是 `blob_b64`，不是 `blob`。

## CLI 命令清单

<!-- tabdoc-cli-commands:begin -->

| 命令 | 用途 |
|------|------|
| `tabtin doc list` | 列出文档（支持 `--page` `--page-size`，与后端分页契约一致） |
| `tabtin doc create --title <title> [--markdown <文本 | @文件 | ->] [--icon <emoji>] [--cover-image <url>] [--parent-item-id <context_item_id>] [--parent-id <document_id>]` | 创建云端 TabDoc 文档：用户请求“生成文档/报告”时，最终产物是云端文档。Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown 草稿时，唯一允许 `write_file` 创建的路径是工作区相对 `.agent-drafts/<slug>.md`；草稿仅用于 `--markdown @.agent-drafts/<slug>.md` 上传，不能汇报为本地交付。短文可直接传入，或读取用户已有的本地 Markdown。**`--title` 就是整篇文章标题；content 不写文章级 `#`，直接从导语开始、章节从 `##` 开始。**`--markdown` 一步带入初始正文（服务端转 ProseMirror），`--icon`/`--cover-image` 设元数据。**挂到知识库侧栏父资源用 `--parent-item-id`（ContextItem.parent）；`--parent-id` 只写 Document.parent（内页树），不会出现在知识库树。**注：create 不接 `--tags`（schema 无 tags 字段），标签建后用 `doc update --tags`** |
| `tabtin doc move <id> --parent-item-id <context_item_id>|--root` | 在知识库侧栏树中移动文档（改 ContextItem.parent）。`--parent-item-id` 与 `--root` 互斥；需 `--organization-id`。与 `doc update --parent-id`（Document 内页树）无关 |
| `tabtin doc search --query <keywords>` | 全文搜索（有搜索词时必须用它，别用 list 冒充 search） |
| `tabtin doc search-blocks <id> --query <keywords>` | 在单篇文档内搜索正文命中的具体 block，返回可直接给 `read-block` / `update-block` 使用的 block-id |
| `tabtin doc read <id>` | 读取当前或指定云端 TabDoc 的完整内容 + 元数据（含 `latest_version` / `updated_at`）；上下文给出 current_doc_id 时直接把 id 传给它 |
| `tabtin doc chunks <id> [--start <n>] [--limit <n>]` | 超大文档按块分页读取（每块含 chunk_index / plaintext_preview / blob_b64）——比一次 read 全文省 token |
| `tabtin doc export <id> --export-format markdown|html|txt|docx|pdf [--output <path>]` | 导出文档正文。docx/pdf 是二进制格式，必须搭配 --output 写盘才能拿到可打开的文件；pdf 经服务端渲染，可能较慢 |
| `tabtin doc delete <id>` | 归档（软删除，第一级） |
| `tabtin doc list-blocks <id>` | 列文档顶层 block 大纲（id / type / level / preview / index）——比 read 省 token |
| `tabtin doc update <id> --title / --status / --parent-id / --icon / --cover-image / --cover-position / --tags` | 改元数据（不改正文）。`--cover-position` 是封面纵向焦点 0~1；`--tags` 整组替换；至少传一个字段。**知识库树改挂用 `doc move`，不要用这里的 `--parent-id`** |
| `tabtin doc save-content <id> [--title <title>] --markdown <文本 | @文件路径 | ->` | **整篇替换**保存正文（`--markdown` 支持直接传文本、`@文件` 读文件、`-` 读 stdin）。`--title` 就是整篇文章标题；content 不写文章级 `#`，直接从导语开始、章节从 `##` 开始。传 `--title` 时 CLI 移除 content 开头的首个 H1；正文以 H1 开头却没传 `--title` 时拒绝写入。**仅用于大改/整篇重写；小改用 block 命令** |
| `tabtin doc read-block <id> <block-id>` | 读单个 block 的 markdown（省 token；先 `list-blocks` 拿 block-id） |
| `tabtin doc read-section <id> <heading-block-id>` | 读整章：标题 + 其后正文直到下一个同级/更高级标题前（heading-block-id 由 `list-blocks` 给；比逐块 read-block 拼接省往返） |
| `tabtin doc update-block <id> <block-id> --markdown <...>` | **精准替换单个 block**（只动这一块、不碰其余）。block-id 由 `list-blocks` 给 |
| `tabtin doc format-text <id> <block-id> --text <原文> [--bold set|unset] [--text-color <颜色>] [--background-color <颜色>]` | **配置原生文字样式**：覆盖粗体/斜体/下划线/删除线/行内代码、文字颜色、背景色和链接。先 read-block 确认唯一原文；未传的样式保持不变，颜色 `default` 清除，链接用 `--link-url`/`--remove-link`。不要用 `<mark>`、`==...==`、HTML/CSS 或 update-block 重写文本样式 |
| `tabtin doc highlight-text <id> <block-id> --text <原文> [--color yellow]` | 兼容快捷方式：仅设置背景色；新任务优先用 `format-text --background-color <颜色>`，以便同时表达完整文字样式 |
| `tabtin doc insert-block <id> --markdown <...> [--at-start | --after <block-id>]` | 插入一段：`--at-start` 放到文档顶部，`--after` 放到某 block 之后，省略位置参数=末尾追加（同 append） |
| `tabtin doc delete-block <id> <block-id>` | 删除单个 block（其余块不动） |
| `tabtin doc append <id> --markdown <...>` | **末尾追加一段**（只加不重写全文）——加一段就用它，别 read 全文再整篇 save |
| `tabtin doc embed-table <id> --table-id <table-id> [--title <title>] [--view-id <view-id>] [--after <block-id>]` | **把已有 TabData 嵌入为 tabdataBlock**（≠ markdown 管道表）。自动生成带双引号的 `:::tabdata{tableId="..."}`；空/无引号 tableId 以及 ID 内控制字符硬失败，title 换行/控制字符归一为空格。工作流：`table create` → 取 id → `doc embed-table` → `list-blocks` 确认 type=tabdataBlock |
| `tabtin doc insert-image <id> --file <path.png> [--alt <文本>] [--at-start | --after <block-id>]` | **上传本地图片并作为标准 Markdown 图片插入**（`![alt](url)`，非自定义块）：上传会显式创建可长期访问的 TabDoc 图片副本，避免私有裸链接裂图。`--at-start` 放到文档顶部，`--after` 放到某 block 之后，省略位置参数则追加末尾 |
| `tabtin doc insert-html <id> --file <path.html> [--title <t>] [--height <n>] [--after <block-id>]` | **产出交互式 HTML 放进文档**（架构图/脑暴板/原型/数据可视化，单文件自包含 HTML）：私有上传（is_public=false）+ 插 HTML 块（沙箱 iframe 按 fileId 授权渲染）。新块 `src=""`，只靠 `fileId`。缺 `--title` 用文件名、缺 `--height` 用 480、缺 `--after` 追加末尾 |
| `tabtin doc update-html <id> <block-id> --file <path.html> [--title <t>] [--height <n>]` | **替换某个 HTML 块的内容**（AI 编辑回路：`read-block` 取 fileId → `GET /api/tabdoc/documents/<id>/html-artifacts/<fileId>` 授权下载 → 本地改 → update-html 重传）。缺 `--title`/`--height` 沿用现有块；块不是 HTML 块会报错 |
| `tabtin doc trash <id>` | 移入回收站（第二级软删，可恢复） |
| `tabtin doc restore <id>` | 从回收站恢复（`trash` 的逆操作，trashed → 原状态） |
| `tabtin doc unarchive <id>` | 从归档恢复（解档，`delete` 的逆操作：archived → active） |
| `tabtin doc permanent-delete <id> --yes` | 永久删除（不可恢复，需 admin；前置：文档已在回收站） |
| `tabtin doc version list <id>` | 列出文档版本历史（支持 `--limit` `--offset`），返回的 `id` 即下面各子命令的版本 id |
| `tabtin doc version preview <id> <history-id>` | 预览某版本的 Markdown 内容（只读，不改当前文档） |
| `tabtin doc version restore <id> <history-id>` | 恢复文档到某版本（可选 `--base-version` 并发保护） |
| `tabtin doc version save <id> [--name <name>]` | 把当前内容存为命名版本（永久保留，可选 `--base-version`）——**仅用户明示时才代调，agent 常规写入走自动 VH** |
| `tabtin doc version rename <id> <version-id> <name>` | 重命名命名版本 |
| `tabtin doc version rm <id> <version-id>` | 删除命名版本（软删，可逆语义，无需 `--yes`） |
| `tabtin doc collaborator list <id>` | 列出协作者（含 owner），返回 `{owner, collaborators:[...]}`，每条含 `user_id`/`permission` |
| `tabtin doc collaborator invite <id> --user-ids <uid> --role <viewer|editor|admin>` | 批量邀请协作者（`--user-ids` 可重复，单次上限 50；需 owner/admin）。用户只给 email 时，先用 `tabtin organization members --search <email>` 反查同组织 user_id；执行后检查 `skipped` |
| `tabtin doc collaborator update <id> <user-id> --role <viewer|editor|admin>` | 改协作者权限（owner 不可改；需 owner/admin） |
| `tabtin doc collaborator rm <id> <user-id>` | 移除协作者（软删，可重新邀请；owner 不可移除；需 owner/admin） |
| `tabtin doc share set <id> --share-type <public|organization> [--acknowledge-public-exposure] [--permission <view|comment|edit>] [--password <pwd>] [--expire-hours <n>] [--allow-download=false] [--allow-copy=false]` | 开/改分享（互斥 create-or-update）。**`--share-type` 必填**；`public`=免登录全网可达，首次扩权须 `--acknowledge-public-exposure`（否则 409）。`organization` 目标组织用全局 `--organization-id` 指定 |
| `tabtin doc share get <id> [--share-type <public|organization>]` | 查看当前分享设置（只读；省略 `--share-type`=当前有效分享） |
| `tabtin doc share off <id> [--share-type <public|organization>]` | 关闭分享（软删 `is_active=False`，可用 `set` 重开；省略 `--share-type`=当前有效分享） |
| `tabtin doc share refresh <id> [--share-type <public|organization>]` | 轮换分享短链（旧链接立即失效；省略 `--share-type`=当前有效分享） |
| `tabtin doc perm get <id>` | 列出文档权限覆盖条目（需 admin；与 collaborator list 不同） |
| `tabtin doc perm set <id> --entries @file | --entry user:<id>:<role>` | ⚠ 全量 replace 权限表（禁空；须保留自身 user:<id>:admin）。先 get 再改完整列表 |
| `tabtin doc shared-with-me` | 列出分享给我的文档（资源级协作发现入口；组织过滤用全局 --organization-id） |
| `tabtin doc import markdown --markdown <文本 | @文件 | ->` | 把 Markdown 转成草稿（pm_json + markdown），**不落库**——需配合 create/save-content 写入；agent 落库优先直接 create/save-content |
| `tabtin doc import file --file-record-id <fid>` | 提交 PDF/Word 异步 Import Job（202 + data.job）；再用 `doc import job status/result` poll 取草稿后 create/save-content；`<fid>` 先 `tabtin oss upload` |
| `tabtin doc import job status <job-id>` | 查询 import job 进度（status/stage/result_available） |
| `tabtin doc import job result <job-id>` | 任务完成后取草稿（markdown/pm_json）；未就绪返回 409 |
| `tabtin doc import job retry <job-id>` | 重试失败的 import job |
| `tabtin doc import job cancel <job-id>` | 取消进行中的 import job |
| `tabtin doc comment list <id> [--threads]` | 列出评论；默认旧平铺 comments，`--threads` 走评论线程 |
| `tabtin doc comment add <id> --document|--block-id|--start-block-id ... [--body|--image]` | 创建评论线程（全文/整块/文字范围）；可重复 `--image`（≤9） |
| `tabtin doc comment reply <id> <thread-id> [--body|--image]` | 回复评论线程；可附图 |
| `tabtin doc comment resolve <id> <thread-id>` | 将评论线程标为已解决 |
| `tabtin doc comment reopen <id> <thread-id>` | 重新打开已解决的评论线程 |
| `tabtin doc comment reanchor <id> <thread-id> --block-id|--start-block-id ...` | 重新关联失效的评论锚点 |
| `tabtin doc comment create <id> --body <文本>` | 新增文档评论（旧接口；新流程用 add） |
| `tabtin doc comment rm <id> <comment-id>` | 删除文档评论（旧接口） |

<!-- tabdoc-cli-commands:end -->

## 长文可靠写入（Hard Rule）

- 仅当 Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown 草稿时，**必须**先用 `write_file`
  写到相对工作区路径 `.agent-drafts/<slug>.md`，再执行
  `tabtin doc create --title "<title>" --markdown @.agent-drafts/<slug>.md --format json`。
  禁止把全文内联进 shell command，也禁止用 shell `>` 重定向或 heredoc 写草稿。
- create 只带可靠的最小参数；icon、cover、tags 等易错元数据在创建成功后用
  `tabtin doc update <document-id> ...` 后置设置或修正，正文不重写。
  **知识库挂载例外**：要挂到侧栏父资源时，create 当场传 `--parent-item-id <context_item_id>`
  （写 `ContextItem.parent`）。不要用 `--parent-id`——那是 Document 内页树，侧栏看不到。
  已有文档改挂用 `tabtin doc move <id> --parent-item-id <ctx>|--root`（勿用 `doc update --parent-id`）。
- create 仅在 CLI **明确返回参数/校验错误**时，才可只修正短参数并复用同一份草稿文件重试；
  不要重新生成或重写正文。网络超时、断连等**结果未知**时，**不得直接重试 create**：后端没有
  幂等键，先运行 `tabtin doc search --query "<title>" --format json` 核对是否已创建；若无法唯一确认，
  必须请求用户确认后再继续。
- metadata update 失败时，正文草稿与已创建正文不受影响。明确校验错误只修正元数据再重试 update；
  如果 CLI 实际返回 `409`，才遵循既有通用处理：先 `tabtin doc read <document-id> --format json`
  获取当前 `latest_version`，判断后带新的 `--base-version <latest-version>` 重试 update。这不是该创建后元数据流程的并发保证；全程不要重新生成或重写正文，也不要调用 `save-content`。
- **短文且所有参数已确定时**，可走一步创建快捷路径；草稿用于当前任务的可恢复重试，任务成功后按
  现有工作目录策略保留，不自动删除，也不要求用户清理。

## Workflow Patterns

> 9 个工作流范式（创建写入 / 搜索摘要 / 省 token 阅读 / 重组删除 / 提取正文 / 版本管理 / 协作者管理 / 导入外部内容 / 文档分享）与 chat 回复模板见 [`references/workflow-patterns.md`](references/workflow-patterns.md)。

## 资源导航（按需读取）

- `references/workflow-patterns.md`：当你要套用完整工作流模板、或需要可直接复用的 chat 回复模板时读取；日常命令调用优先看本文件主流程与命令清单，不默认加载整份参考文档。

## 并发保护（base-version）

`save-content` / `update` / `doc version restore` / `doc version save` 都接受 `--base-version`：

- 你读文档时（`tabtin doc read`）拿到 `latest_version`
- 写回时把 `latest_version` 当作 `--base-version` 传进去
- 服务端发现版本变了（别人/别的进程同时改了文档）会返回 `409 VERSION_CONFLICT`
- 收到 409 → 重新 `read` → 决定是合并还是覆盖 → 重试

不传 `--base-version` 也能写成功，但失去并发保护。**chat 里 LLM 单独操作时可省，多 Agent / 多用户场景必传**。

## 写 markdown 给 TabDoc 时的常见雷区

TabDoc 后端用自研扫描式 markdown 解析器（不是标准库），有些 LLM 常出的写法会**调用成功但文档烂掉**——
后端不会报错，agent 完全无感。下面是经实测确认的高频盲区：

1. **价格场景多个 `$`**：`总价 $5 加 $10` 中间 "5 加 $" 会被吞为公式 latex。
   正确写法：`总价 \$5 加 \$10`（反斜杠转义）或 `` 总价 `$5` 加 `$10` ``（反引号包代码）。
2. **块级公式 / 代码块未闭合**：`$$` 和 ` ``` ` 必须成对，否则**吞光后续所有内容**。
   写完检查一遍奇偶。
3. **Agent 写入时只使用 `:::tabdata` directive**。Docusaurus/VuePress 的
   `:::note` / `:::warning` / `:::callout` 全部会退化为带 `:::` 的字面段落。需要警告框就用
   `> ⚠️ 警告内容` blockquote 替代。
4. **公式语法**：只支持 `$...$` 行内 + `$$...$$` 块；LaTeX `\(...\)` `\[...\]` **不识别**。
5. **`:::tabdata` attr 必须双引号**：`:::tabdata{tableId="tbl-001"}` 对，`:::tabdata{tableId=tbl-001}`
   会在 CLI/API **硬失败**（不再静默丢 tableId）。**嵌入多维表请用一等命令**
   `tabtin doc embed-table <doc-id> --table-id <table-id>`，不要手写 directive。
   普通 markdown 管道表（`| a | b |`）只生成 `table` block，**不等于** `tabdataBlock`。
6. **正文里手写 HTML 标签**：`<div>` `<img>` 等会保留为文本但渲染层会被 sanitize 吃掉。已有公开图片 URL 用 markdown
   `![alt](url)` 语法；**本地图片文件**用下面的「图片插入」一条命令自动上传+拼块。**要嵌入整块交互式 HTML（架构图/原型/可视化）不要往正文塞 `<html>`——用下面的「HTML 块」**。
7. **多行 Markdown 禁止在 shell 双引号里写字面 `\n`**：zsh / PowerShell 双引号
   **不会**把 `\n` 展开成真实换行，CLI 也不解码——有序列表会变成带 `\n` 字样的单行段落。
   标题 + 列表等多行内容必须 `write_file` → `--markdown @.agent-drafts/<slug>.md`，或 `--markdown -`。
   CLI 会对「无真实换行 + 结构向字面 `\n`」硬失败并提示改姿势。
8. **含 `$a` / `$x` 的公式禁止放进 PowerShell/zsh 双引号**：双引号会把未定义
   `$变量` 展开为空，公式变成 `：^2 - b^2...$` 这种残片，编辑器也无法 KaTeX 渲染。
   **公式 / 多行内容一律** `write_file` → `--markdown @.agent-drafts/<slug>.md`（或 stdin）。
   不需要专用 `doc insert-formula`——`$...$` / `$$...$$` 就是公式入口。
   CLI 会对「只剩行尾单个 `$` + LaTeX 残片」硬失败。

（CLI 在 `doc save-content` / `doc create --markdown` / `doc import markdown` 等写入口会在 stderr 打 warning
提示上述 1/2/3 类问题，但不阻塞调用——agent 看到 warning 自己决定要不要改 markdown 再重试。
`:::tabdata` 无引号/空 tableId 是硬失败，见 ；第 7 类字面 `\n`、第 8 类 shell `$` 展开由 CLI 硬拦。）

## 图片插入（本地文件 → OSS → 正文）

**什么时候用**：你手上是一张**本地图片文件**（截图、生成的图表、下载的图片），想放进文档正文——标准 Markdown 图片，不是交互式内容。**已有现成的公开图片 URL** 时，直接在正文写 `![alt](url)`（雷区 6）即可，不需要这条命令，只有**本地文件**才需要先上传。

```bash
# 把本地图片传到 OSS 并作为标准 Markdown 图片插入文档——一步到位（内部：上传→拼 ![alt](url)→插块）
tabtin doc insert-image <document-id> --file ./chart.png --alt "销售趋势图"
#   --alt 缺省用文件名去扩展名；--after <block-id> 插到某块之后，缺省追加末尾
#   返回 data.file_id + data.url（OSS 公开 URL）+ data.markdown + data.block（插块结果）

# 插到某个 block 之后
tabtin doc insert-image <document-id> --file /tmp/screenshot.png --after <block-id>
```

**雷区**：

1. 支持 png/jpg/jpeg/gif/webp/svg；上传路径白名单同 `insert-html`——只接 `$HOME` 或 `/tmp` 下的路径（symlink 会被拒），单文件 ≤100MB。
2. **失败可重试不必重传**——若上传成功但插块失败，错误 `detail` 里保留 `file_id` + 已拼好的 markdown + 一条 `recovery_command`，直接跑那条 `doc insert-block` 补写即可，不用重新上传。
3. 生成的是标准 Markdown 图片（无沙箱 iframe）；需要**自定义交互 HTML**（可点可拖的架构图/原型/可视化）用下面的「HTML 块」，不要拿图片凑合。
4. 这条命令目前只覆盖**插入**；要替换已插入图片的图（≈ `update-html` 对图片的等价物）暂无一等命令，改法是 `list-blocks` 找到目标块、重新 `insert-image` 插一张新图、再 `delete-block` 删旧块。

## HTML 块（交互式内容嵌入）

**什么时候用**：你产出了一份**自包含的单文件 HTML**——交互式架构图、脑暴板、原型、数据可视化（内嵌 CSS/JS、可点可拖）——想把它作为一个块放进文档。对标飞书：HTML 以文件附件上传，文档块只存引用，前端用**沙箱 iframe 在线渲染**。这跟"正文里写 `<div>`"（会被 sanitize 吃掉，见雷区 6）是两回事。

需要**静态图**用 `![alt](url)`；需要**数据表**用 `:::tabdata`；只有需要**自定义交互 HTML** 才用 HTML 块。

**插入：一条命令搞定（私有上传 OSS + 拼块）**

```bash
# 把本地 .html 私有上传并作为 HTML 块插入文档——一步到位（内部：is_public=false 上传→拼 :::htmlblock{fileId,src="",...}→插块）
tabtin doc insert-html <document-id> --file ./architecture.html --title "系统架构图" --height 600
#   --title 缺省用文件名去扩展名；--height 缺省 480；--after <block-id> 插到某块之后，缺省追加末尾
#   返回 data.file_id + data.url=""（新块不写永久公开 URL）+ data.block（插块结果）

# 插到某个 block 之后
tabtin doc insert-html <document-id> --file /tmp/dashboard.html --after <block-id>
```

**编辑回路：读 → 授权下载 → 本地改 → 重传替换**

HTML 块的正文不在文档里、在 OSS 上，所以"改 HTML"是**授权下载→改→重传**，不是改 markdown、也不是匿名 curl `src`：

```bash
# 1. read-block 看到 HTML 块长这样：:::htmlblock{fileId="..." src="" title="架构图" height="480"}
#    （历史块可能仍有非空 src，仅作兼容回退；新块以 fileId 为准）
tabtin doc read-block <document-id> <block-id> --jq .markdown
FILE_ID=$(tabtin doc read-block <document-id> <block-id> --jq .markdown | grep -oE 'fileId="[^"]+"' | head -1 | sed 's/fileId="//;s/"//')

# 2. 用文档 ACL 授权端点下载（JWT；禁止匿名 GET 永久 OSS URL）
#    GET /api/tabdoc/documents/<document-id>/html-artifacts/<fileId>
curl -fsSL -H "Authorization: Bearer $TABTIN_TOKEN" \
  "$TABTIN_API_BASE/api/tabdoc/documents/<document-id>/html-artifacts/$FILE_ID" \
  -o /tmp/edit.html

# 3. 本地改 /tmp/edit.html …

# 4. update-html 重传新文件替换该块（缺 --title/--height 沿用现有块的值；块不是 HTML 块会报错）
tabtin doc update-html <document-id> <block-id> --file /tmp/edit.html
```

**雷区（必读）**：

1. **新 HTML 默认私有，权限跟随所属文档**——成员按文档 viewer ACL 读；访客仅在文档开启分享后按 DocumentShare 规则读。不要假设 `src` 可匿名打开；历史公开直链（旧块非空 `src`）仍可能可达，但这不是新契约。
2. **iframe 是沙箱**——渲染时**没有宿主权限**：拿不到 TabTin 的 cookie/登录态、调不了 TabTin API、跨不了同源。HTML 要能独立运行。
3. **必须自包含单文件**——CSS/JS 尽量内联进这一个 `.html`；外链资源必须是 **https** 且**沙箱内可达**（公网 CDN 可以，内网/需登录的不行）。
4. **上传路径白名单**——`--file` 只接 `$HOME` 或 `/tmp` 下的路径（symlink 会被拒），单文件 ≤100MB。先把 HTML 写到 `~/` 或 `/tmp/` 再传。
5. **失败可重试不必重传**——若"上传成功但插块/替换失败"，错误 `detail` 里保留 `file_id` + 已拼好的 markdown + 一条 `recovery_command`，直接跑那条 `doc insert-block` / `doc update-block` 补写即可，不用重新上传。

## 用户给了 URL 不是 doc_id 怎么办

agent 拿到的 doc id 99% 是 chat 上下文里前一步返回的字面 id（如 `doc_xxx`）。但偶尔用户会贴
TabTin URL 进 chat：

```
https://www.example.com/docs/doc_xxx
tabtin://resource/document/doc_xxx?hint=tabdoc
```

CLI **不解析 URL**，直接传会 404。提取方法：

```bash
DOC_ID=$(echo "$user_input" | grep -oE 'doc_[a-zA-Z0-9]+' | head -1)
tabtin doc read "$DOC_ID"
```

## Rules

- **回复里凡出现文档标题，必须写成 `[<title>](tabtin://resource/document/<id>?hint=tabdoc)`**——表格 / 列表 / 散文里都一样；纯文字 / 加粗 / `**title**` 都算违约（顶部「输出契约」段有 list / search 可抄样板）
- **链接里的 `<id>` 必须完整复制**——禁止 `…` / `...` / 手动截断；不带 label 的裸 `tabtin://` 链接也禁止（截断 id 会进产物卡片且点击必失败）
- 用户说「找/搜/检索 XX 文档」必须走 `tabtin doc search`，**不要**降级为 `doc list` 客户端字符串过滤；**禁止** `rag_search` 0 条后改 `doc list` 凑数
- **创建文档前先 `tabtin doc search`** 看是否已有同名 / 同主题文档，避免重复
- 标题要简洁有意义，方便后续搜索
- `update` 改元数据 vs `save-content` 改正文是两个端点——别混
- **CLI 写正文使用 `--markdown`**：仅当 Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown
  草稿时，先用 `write_file` 写入相对工作区路径 `.agent-drafts/<slug>.md`，再以
  `--markdown @.agent-drafts/<slug>.md` 创建；禁止把全文内联到 shell command，也禁止用 shell
  `>` 重定向或 heredoc 写草稿。创建后的元数据修正走
  `doc update`：校验错误先修元数据；如果 CLI 实际返回 409，才按既有通用处理重新 `doc read` 并带
  新 `--base-version` 重试，不重写正文
- 不要在文档正文里存 API keys / 密码 / 凭据
- 只操作当前 Organization 内的文档（CLI 默认按当前组织上下文；`space_id` 为遗留可选）

## Safety

- 不在文档正文里存敏感凭据
- 尊重 Organization 边界——只操作当前用户有 viewer 权限以上的文档（CLI 会做权限校验）

## 历史变更

- **0.14.6 (2026-08-17)**：当前网页导入恢复通用路线——Browser 保真采集正文与资源，临时资源转存后用 TabDoc 既有创建 / 导入能力落库；只有显式飞书资产迁移才进入飞书专用通道。
- **0.14.5 (2026-08-17)**：飞书迁入路由补强——覆盖“当前浏览器已打开飞书文档、生成 TabDoc”这一隐式来源场景；禁止 browser/fetch 抽文本后走 Markdown 建文档，专用能力不可用时显式停下，不再有损降级。
- **0.14.4 (2026-08-07)**：按产品语义收敛正文契约——`title` 是整篇文章标题，content 不再出现任何文章级首个 H1；移除标题相似度、标点和 emoji 判断，create/save-content 只按正文结构处理首个 H1。
- **0.14.3 (2026-08-07)**：快照回归修复——同名正文 H1 只多装饰性引号时仍去重；顶层 `tabtin doc` 示例改为 `create --title --markdown` 一步写入，`save-content` 示例显式携带 `--title`；正文以 H1 开头但无 title 上下文时拒绝写入，覆盖 Agent 未加载完整 Skill、只读取 relevant_cli 的路径。
- **0.14.2 (2026-08-07)**：正文标题契约——文档标题只放 `title` 元数据；Agent 新生成正文从导语开始、章节从 H2 开始，不再重复同名 H1。CLI create/save-content 在显式传 `--title` 时移除正文首个完全同名 H1，其他 H1 保留。
- **0.14.1 (2026-07-27)**：——移除 `doc html-share get|set|off`；HTML 块浏览改走文档级 `doc share`（DocumentShare）+ `documentId`/`blockId`。
- **0.14.0 (2026-07-26)**： (W4)——补 `doc perm get|set`（DocumentPermission 全量 replace；禁空 + 保留自身 admin）、`doc shared-with-me`、`doc html-share get|set|off`（已于 0.14.1 移除，改走文档级 share）。命令表由 `doc_ai_help.go` 重生。
- **0.13.0 (2026-07-26)**： (W2d)——补图片插入命令 `doc insert-image`（镜像 insert-html 编排：本地图片上传 OSS → 拼标准 Markdown `![alt](url)` → 插块，两步走 Go CLI Execute 多请求编排，无新后端）。与 insert-html 的关键差异：图片是标准 CommonMark 语法（非自定义 directive），不固定 `mime_type`（服务端按扩展名 png/jpg/jpeg/gif/webp/svg 自动识别）。命令清单加 1 行 + 新增「图片插入（本地文件 → OSS → 正文）」段 + [`references/workflow-patterns.md`](references/workflow-patterns.md) Pattern 11 同步。上传成功但插块失败时错误 `detail` 保留 `file_id` + 可重跑 `doc insert-block` 命令。
- **0.12.0 (2026-07-26)**：——TabDoc HTML 权限收束：新上传强制 `is_public=false`、块持久化 `src=""`、读取走 `GET /api/tabdoc/documents/<id>/html-artifacts/<fileId>`（分享端走 share 端点）。Skill / Pattern 10 / AIHelp 同步去掉「OSS 公开对象 / 匿名 curl src」旧契约；历史非空 `src` 仅兼容回退。
- **0.11.0 (2026-07-08)**：——补 HTML 嵌入块命令 `doc insert-html` / `doc update-html`。**注**：公开直链契约已由 0.12.0 /  废止。
- **0.10.4 (2026-07-24)**：——补 `doc move --parent-item-id|--root`（改挂知识库树）；与 create 的 `--parent-item-id` 对称。
- **0.10.3 (2026-07-24)**：——`doc create` 补 `--parent-item-id`（知识库树 `ContextItem.parent`）；澄清 `--parent-id` 仅写 Document 内页树、侧栏不可见。长文写入规则同步：挂侧栏父资源时 create 当场传 `--parent-item-id`，勿用 `--parent-id`。
- **0.10.1 (2026-07-06)**： 治理——search 样板里的截断 UUID（`d7f34d67-…`）教坏了模型：实测 Kimi K2.6 照抄样板风格输出 `tabtin://resource/document/02eda024-5f11-4d4a-85c2-…` 截断链接，前端产物卡收进后点击报「document_id 不是合法 UUID」。样板改为完整 UUID，输出契约与 Rules 加「id 必须完整复制、禁止截断/裸链接」硬规则，禁止形态补两条截断反例。前端同步在 `extractResourceLinkArtifacts` 丢弃含 `…` 的 id 兜底。
- **0.10.0 (2026-05-30)**：§CLI 命令清单改为从 `packages/tabtin-cli-go/cmd/doc_ai_help.go`（CommandDef `AIHelp` + `Invoke`）自动生成；维护命令知识只改 Go registry + `python3 scripts/generate-tabdoc-skill-section.py`，CI `--check` 防 drift。
- **0.9.7 (2026-05-28)**：ISSUE-F 治理——0.9.6 已写硬规则但人肉验证 P0 #1–#5 仍 0 条 `tabtin://` 输出。归因：① 旧 hard rule 埋在 §441 Rules 章（全文 470+ 行），模型读到时注意力衰减；② 缺可粘贴样板，旧 §「回复模板」只给一行格式 `[<title>](url)`，list/search 跑完模型不知道整个表格怎么列。本期改造：① **顶部新增 §输出契约（Hard Contract · 必读）**，紧跟「范式说明」前移到 §22 之后、CLI 命令清单之前——模型最早能读到的硬契约；② **嵌入两套可粘贴样板**：list 通用表格（标题 / 创建 / 版本三列，第一列必须是 link）+ search 带 snippet 的列表，含真实 UUID 范例可直接抄；③ **禁止形态扩展到 5 条**，加入「`**title**` 加粗」「`| title |` 表格纯字符串」「emoji 装饰替代 link」三种本轮验证实测的违约形态；④ **Rules 第 1 条** 从「创建前先 search」改为「回复必须用 canonical link」（违约频率最高的提到最显眼）；⑤ **Pattern 2 文末「回复模板」段** 精简——核心样板已搬顶部，本段只保留 Parser 三类兜底别名（`type=doc → document` / `hint=document → tabdoc` / `hint=doc → tabdoc`）的对照表，明示「别名是兜底，不是写法许可」。Parser 侧 0.9.6 已实装的别名维持不变。
- **0.9.7 (2026-05-28)**：ISSUE-G — Pattern 2 加「doc search vs rag vs list」决策树；Rules 明示禁止 rag 0 条后 list 降级。配合 `agent-prompt` `CROSS_TOOL_DECISIONS` carve-out（TabDoc 关键词 → `doc search` CLI）。
- **0.10.0 (2026-05-29)**：补 block 级编辑命令组 `doc read-block` / `update-block` / `insert-block` / `delete-block` + `doc append`（对接后端新增 `block_service` + `GET/PATCH/POST/DELETE /documents/{id}/blocks[/{block_id}]`，TD-3）。命令清单 6 行 + Pattern 1「整篇 vs block」纪律改写：**小改（加/改/删一段）一律用 block 命令、只动目标块；`save-content` 退回仅大改/整篇重写**。退役「read 全文 + 本地拼接 + 整篇 save」的旧追加做法（费 token、易误改无关段、协作冲突面大）。
- **0.9.6 (2026-05-28)**：人肉验证发现 P0 #4/#5 半通过——agent 在 chat 回复里给文档链接用了 `tabtin://resource/doc/<id>?hint=document`（type 段写简写 + hint 段写 resource type 双 typo），ResourceRouter manifest 只注册 `type=document`，点击无反应（ISSUE-F）。本期双管齐下治理：① Pattern 2 文末新增「文档列表 / 检索结果回复模板」段，给出 canonical `[<title>](tabtin://resource/document/<id>?hint=tabdoc)` 模板 + 四条 forbidden 反例 + 字段对照表；② Rules 顶部加 hard rule「chat 回复链接只用 canonical 形态」+「找/搜/检索 必须走 search 不降级 list」；③ Pattern 2 加 list-vs-search 分界说明（list 只看标题、无 snippet、SQLite 中文 FULLTEXT 空时不静默退化）。Parser 侧同步加 `type=doc → document` / `hint=document → tabdoc` / `hint=doc → tabdoc` 三类兜底别名（TS + Python 双端，跨语言 fixture 同步——其中 `hint=doc` 是首次 Electron 重验 P0 #4 实测捕获的新 typo 形态），但 SKILL 仍强制 canonical 输出——别名只兜底字面 typo，不是写法许可。
- **0.9.5 (2026-05-24)**：A1 后端 P0 修复（`api_share.py:221` view 层 kwarg）通过测试，`doc share set` live 可用——0.9.4 引入的顶部 S1 警示段已删除。基于 C6/C7 调研落地两项 Pattern 重写：① **Pattern 6 按读侧（6.1）/ 写侧（6.2）拆双层结构**——明示 `version list/preview/restore` 是 agent 自然要用的诊断+回滚链路，`version save/rename/rm` 是 user-driven UI 行为（用户明示才动），引入 collab 自动版本节点 + Checkpoint 体系的认知避免 agent 错把命名版本当"完成大任务的自然收尾"（后端 CAP-017 `MAX_NAMED_VERSIONS_PER_DOC=50` 是反诱导配额，不是上限承诺）；② **Pattern 7 加 email→user-id 反查段**——明示走 `organization members` + jq 过滤路径或 `tabtin api` 逃生口（CLI `organization members` 透传 `--search` 跟踪 followup 中），不再让 agent 自由发挥（推回用户输 user-id 是 UX 灾难）。
- **0.9.4 (2026-05-24)**：CLI 收口质量补丁——综合修订（一份 PR）：①顶部新增 S1 警示段（修复确认前常驻，0.9.5 已随 A1 PASS 删除）；②新增「输出协议与 jq 路径约定」节解释 envelope 结构 + `| jq` vs `--jq` 路径差异；③修全 9 处 `| jq` 缺 `.data.` 前缀（影响 Pattern 1/2/3/5/6/7/8/9 几乎全部 jq 示例）；④share off/refresh 描述去"仅 public"（实现已支持 organization）；⑤Pattern 1 创建工作流主推一步法、两步法降级为脚注；⑥Pattern 3 补 list-blocks vs chunks 选择标准；⑦Pattern 4 补"查文档状态= `doc read --jq .document.status`"；⑧Pattern 6 加 restore 杀手副作用警告（断协作者连接）；⑨Pattern 8 改清"import markdown vs save-content 适用边界"；⑩Pattern 9 跨组织分享假希望改严（明示 validate_organization_scope 不允许跨）；⑪新增 markdown 雷区段（`\$` 转义/`:::xxx` 白名单/`$$` 闭合 etc.）；⑫新增 URL → doc_id 提取 gotcha。
- **0.9.3 (2026-05-23)**：分享端到端打通 + 范围收敛为「公开 + organization 内部」。① **跨组织分享下线**——0.9.2 提到的「D2=B 跨租户分享后端已开放」是未端到端打通的半成品，本期明确只做「分享给资源所属组织」：后端 `validate_organization_scope` 改严格（目标组织恒等于资源组织），半成品代码 + 开关已删除。② **organization 分享真正可用**——此前 tabtin-web 查看端（`SharedDocPage`/`SharedTablePage`）匿名取数、登录用户也拿不到身份，organization 分享即便后端修了也看不了；现查看端带 JWT，未登录引导登录 / 非成员提示无权 / 成员正常渲染。③ 表格 records 端点修复（原调用不存在的 `ViewService.get_view_records` 一律 500），分享密码改走 `X-Share-Password` 请求头、不再进 URL。`doc share *` 命令签名不变。
- **0.9.2 (2026-05-22)**：**P0 警示去除**——0.9.1 提到的 3 类后端缺陷（organization 分享死功能 / 分享管理横向越权 / 元信息泄漏）已全部修复并通过端到端测试（PRD `apps/tabtin_django/apps/tabdoc/PRD-shareperm-p0-fix.md`）。`doc share *` 全部命令现可正常使用，含 `--share-type organization`（限分享给文档所属组织；跨组织分享见 0.9.3 已下线）。`doc collaborator *` 与所有非分享命令继续不受影响。
- **0.9.1 (2026-05-22)**：在 `doc share *` 命令清单 + 分享段添加 ⚠️ **P0 警示**——后端排查发现：① `--share-type organization` 端到端死功能（公开端点 auth 漏配 + `OrganizationMember.is_active` 字段不存在双重 bug，PRD 写了从未端到端测过、零测试覆盖）；② 分享管理端点（set/off/refresh）存在**横向越权**（不校验 owner/admin，任何登录用户拿 doc_id 可操作）；③ `GET /shared/{share_id}` 元信息端点 0 鉴权，密码保护只保护正文不保护 title/cover。完整诊断 + 修复路线见 `docs/agent/cli-spec/tabdoc-permission-product-issues.md`。**`doc share` 工作流仍可用但请注意边界**：① 当前只用 `--share-type public`；② 敏感文档不要把 ID 暴露在 URL/日志；③ 敏感标题慎用密码保护代替——它不保护元信息。`doc collaborator *` 与所有非分享命令不受影响。**0.9.2 已修复，此警示作废**。
- **0.9.0 (2026-05-22)**：补分享命令组 `doc share <set\|get\|off\|refresh>`（doc 下第四个嵌套子命令组，对接后端 `api_share.py` 的 `POST/GET/DELETE /documents/{id}/share`、`POST /documents/{id}/share/refresh`）；命令清单 4 行 + 新增 Pattern 9（分享 public vs organization，含安全警示）同步。**安全设计**：`--share-type`（`public`/`organization`）无默认值、`Required` 强制显式选，避免误建公开链接；Long 警示 `public`=免登录全网可达。`set` 是 create-or-update upsert；share 的 `--permission` 是 `view`/`comment`/`edit`（`DocumentShare.PERMISSION_CHOICES`，与协作者那套 viewer/editor/admin 不同）；`--password` 三态（不传保留/空串清空/非空设新）。**organization 分享目标组织复用全局 `--organization-id`**（命令级若声明会与全局 persistent flag 撞名 + 撞 body key `organization_id`）。**`off`/`refresh` 仅作用于 public 分享**：后端 `share_type` 是 ninja query 参（已对 ninja 1.5.3 `_get_param_type` 核验），而写命令管线只对 GET 做 body→query，`DELETE`/`POST` 投递不进去——故不暴露 `--share-type` 以免假承诺（organization 关闭/轮换属已知缺口，需后端把 `share_type` 改 body 字段或管线支持非 GET query）。
- **0.8.0 (2026-05-22)**：富化 `doc create` / `doc update`（只加 flag，未动既有 title/status/parent-id 行为）。`create` 加 `--markdown`（FlagString，支持 @文件/-stdin → `initial_content_markdown`，一步建带内容文档，服务端 markdown→ProseMirror）+ `--icon`（→ `icon`，max 64）+ `--cover-image`（→ `cover_image`）；**`create` 刻意不加 `--tags`——`DocumentCreateRequest`/`create_document` 服务层/视图均无 tags 字段，传了会被静默丢弃，标签是 update 端能力**。`update` 加 `--icon`/`--cover-image`/`--cover-position`（FlagFloat → `cover_position`，服务端 clamp [0,1]）/`--tags`（FlagStringSlice → `tags`，整组替换），并把这 4 个新 flag 纳入 `RequiresOneOf`（连同原 title/status/parent-id），确保单传 `--icon`/`--tags`/`--cover-position` 不被误判「啥都没传」。命令清单两行 + Pattern 1 同步。
- **0.7.0 (2026-05-22)**：补导入命令组 `doc import <markdown\|file>`（doc 下第三个嵌套子命令组，对接后端 `api.py` 的 `POST /import/markdown`、`POST /import/file`）；命令清单 + 新增 Pattern 8（导入工作流）同步。**关键：导入只产出草稿（`{pm_json, markdown, plaintext}`），不创建文档**——要落库须接 `doc create` / `doc save-content`（后端无独立"确认草稿"端点，第二步即普通创建/保存）。`import file` 收 **`file_record_id`**（OSS 文件引用，先 `tabtin oss upload` 取得），**不是本地文件直传 / multipart**——后端 schema `DocumentImportFileRequest` 即 `{organization_id, file_record_id}`（`space_id` 为遗留可选）。两端点均需 editor 角色。
- **0.6.0 (2026-05-22)**：补协作者命令组 `doc collaborator <list\|invite\|update\|rm>`（doc 下第二个嵌套子命令组，对接后端 `api_share.py` 的 `GET/POST /documents/{id}/collaborators`、`PATCH/DELETE /documents/{id}/collaborators/{user_id}`）；命令清单 + 新增 Pattern 7（协作者管理）同步。权限固定三档 viewer/editor/admin（`--role` 用 FlagEnum）；邀请**按 user-id 批量**（`--user-ids` 可重复，上限 50）非 email；invite/update/rm 需 owner/admin，owner 受保护不可 update/rm；`rm` 是软删可逆（RiskWrite，无需 `--yes`）。
- **0.5.0 (2026-05-22)**：补版本命令组 `doc version <list\|preview\|restore\|save\|rename\|rm>`（doc 下首个嵌套子命令组，对接后端 V3 `collab.VersionHistory`：`GET /histories`、`GET /histories/{hid}/preview`、`POST /restore-history`、`POST/PATCH/DELETE /versions[/{vid}]`）；命令清单 + 新增 Pattern 6（版本管理）+ 并发保护章节同步。`history-id` 与 `version-id` 是同一 id 空间。**legacy A 组（`/revisions`、collab `/restore`）按决策跳过**，不暴露。
- **0.4.0 (2026-05-22)**：补回收站命令组 `doc trash` / `doc restore` / `doc unarchive` / `doc permanent-delete`（对接后端 `/trash`、`/restore-from-trash`、`/unarchive`、`/permanent` 端点），命令清单 + Pattern 4 同步更新为三级删除生命周期。
- **0.3.0 (2026-05-04, Wave 12)**：FC 工具全退役，改成 `tabtin doc` CLI 工作流。`tabdoc_create_document` / `tabdoc_update_document` / `tabdoc_search_documents` / `tabdoc_read_document` / `tabdoc_list_documents` / `tabdoc_list_blocks` 6 个 FC 在 capability 层从未真实暴露给 LLM（NOT_WIRED stub），现在 capability 类一并删除；`tabdoc_read_block` / `tabdoc_update_block` / `tabdoc_insert_block` / `tabdoc_delete_block` 4 个 FC 是历史误列（agent-runtime 中根本未定义）
- **0.2.0**：列了 6+4 个 tabdoc_* FC（这些 FC 实际从未真实暴露给 LLM，是虚假能力清单）
