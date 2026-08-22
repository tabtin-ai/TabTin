package cmd

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

const (
	docSkillCLISectionBegin = "<!-- tabdoc-cli-commands:begin -->"
	docSkillCLISectionEnd   = "<!-- tabdoc-cli-commands:end -->"
)

// docCommandAIHelp 是 Agent/skill 侧的一条命令知识：Invoke 进 SKILL 表第一列，Help 进 ai-help / 第二列。
type docCommandAIHelp struct {
	Invoke string
	Help   string
}

// docAIHelpRegistry 以 `doc <子路径>` 为 key。doc 叶子命令必须全覆盖（含 destructive）。
// 内容从 tabdoc-operator SKILL.md §CLI 命令清单 迁入——后续只改这里 + 重新 generate skill 段。
var docAIHelpRegistry = map[string]docCommandAIHelp{
	"list": {
		Invoke: "`tabtin doc list`",
		Help:   "列出文档（支持 `--page` `--page-size`，与后端分页契约一致）",
	},
	"create": {
		Invoke: "`tabtin doc create --title <title> [--markdown <文本 | @文件 | ->] [--icon <emoji>] [--cover-image <url>] [--parent-item-id <context_item_id>] [--parent-id <document_id>]`",
		Help:   "创建云端 TabDoc 文档：用户请求“生成文档/报告”时，最终产物是云端文档。Agent 为新建或整篇更新长 TabDoc 正文而新建临时 Markdown 草稿时，唯一允许 `write_file` 创建的路径是工作区相对 `.agent-drafts/<slug>.md`；草稿仅用于 `--markdown @.agent-drafts/<slug>.md` 上传，不能汇报为本地交付。短文可直接传入，或读取用户已有的本地 Markdown。**`--title` 就是整篇文章标题；content 不写文章级 `#`，直接从导语开始、章节从 `##` 开始。**`--markdown` 一步带入初始正文（服务端转 ProseMirror），`--icon`/`--cover-image` 设元数据。**挂到知识库侧栏父资源用 `--parent-item-id`（ContextItem.parent）；`--parent-id` 只写 Document.parent（内页树），不会出现在知识库树。**注：create 不接 `--tags`（schema 无 tags 字段），标签建后用 `doc update --tags`**",
	},
	"search": {
		Invoke: "`tabtin doc search --query <keywords>`",
		Help:   "全文搜索（有搜索词时必须用它，别用 list 冒充 search）",
	},
	"search-blocks": {
		Invoke: "`tabtin doc search-blocks <id> --query <keywords>`",
		Help:   "在单篇文档内搜索正文命中的具体 block，返回可直接给 `read-block` / `update-block` 使用的 block-id",
	},
	"read": {
		Invoke: "`tabtin doc read <id>`",
		Help:   "读取当前或指定云端 TabDoc 的完整内容 + 元数据（含 `latest_version` / `updated_at`）；上下文给出 current_doc_id 时直接把 id 传给它",
	},
	"chunks": {
		Invoke: "`tabtin doc chunks <id> [--start <n>] [--limit <n>]`",
		Help:   "超大文档按块分页读取（每块含 chunk_index / plaintext_preview / blob_b64）——比一次 read 全文省 token",
	},
	"export": {
		Invoke: "`tabtin doc export <id> --export-format markdown|html|txt|docx|pdf [--output <path>]`",
		Help:   "导出文档正文。docx/pdf 是二进制格式，必须搭配 --output 写盘才能拿到可打开的文件；pdf 经服务端渲染，可能较慢",
	},
	"delete": {
		Invoke: "`tabtin doc delete <id>`",
		Help:   "归档（软删除，第一级）",
	},
	"list-blocks": {
		Invoke: "`tabtin doc list-blocks <id>`",
		Help:   "列文档顶层 block 大纲（id / type / level / preview / index）——比 read 省 token",
	},
	"update": {
		Invoke: "`tabtin doc update <id> --title / --status / --parent-id / --icon / --cover-image / --cover-position / --tags`",
		Help:   "改元数据（不改正文）。`--cover-position` 是封面纵向焦点 0~1；`--tags` 整组替换；至少传一个字段。**知识库树改挂用 `doc move`，不要用这里的 `--parent-id`**",
	},
	"move": {
		Invoke: "`tabtin doc move <id> --parent-item-id <context_item_id>|--root`",
		Help:   "在知识库侧栏树中移动文档（改 ContextItem.parent）。`--parent-item-id` 与 `--root` 互斥；需 `--organization-id`。与 `doc update --parent-id`（Document 内页树）无关",
	},
	"save-content": {
		Invoke: "`tabtin doc save-content <id> [--title <title>] --markdown <文本 | @文件路径 | ->`",
		Help:   "**整篇替换**保存正文（`--markdown` 支持直接传文本、`@文件` 读文件、`-` 读 stdin）。`--title` 就是整篇文章标题；content 不写文章级 `#`，直接从导语开始、章节从 `##` 开始。传 `--title` 时 CLI 移除 content 开头的首个 H1；正文以 H1 开头却没传 `--title` 时拒绝写入。**仅用于大改/整篇重写；小改用 block 命令**",
	},
	"read-block": {
		Invoke: "`tabtin doc read-block <id> <block-id>`",
		Help:   "读单个 block 的 markdown（省 token；先 `list-blocks` 拿 block-id）",
	},
	"read-section": {
		Invoke: "`tabtin doc read-section <id> <heading-block-id>`",
		Help:   "读整章：标题 + 其后正文直到下一个同级/更高级标题前（heading-block-id 由 `list-blocks` 给；比逐块 read-block 拼接省往返）",
	},
	"update-block": {
		Invoke: "`tabtin doc update-block <id> <block-id> --markdown <...>`",
		Help:   "**精准替换单个 block**（只动这一块、不碰其余）。block-id 由 `list-blocks` 给",
	},
	"format-text": {
		Invoke: "`tabtin doc format-text <id> <block-id> --text <原文> [--bold set|unset] [--text-color <颜色>] [--background-color <颜色>]`",
		Help:   "**配置原生文字样式**：覆盖粗体/斜体/下划线/删除线/行内代码、文字颜色、背景色和链接。先 read-block 确认唯一原文；未传的样式保持不变，颜色 `default` 清除，链接用 `--link-url`/`--remove-link`。不要用 `<mark>`、`==...==`、HTML/CSS 或 update-block 重写文本样式",
	},
	"highlight-text": {
		Invoke: "`tabtin doc highlight-text <id> <block-id> --text <原文> [--color yellow]`",
		Help:   "兼容快捷方式：仅设置背景色；新任务优先用 `format-text --background-color <颜色>`，以便同时表达完整文字样式",
	},
	"insert-block": {
		Invoke: "`tabtin doc insert-block <id> --markdown <...> [--at-start | --after <block-id>]`",
		Help:   "插入一段：`--at-start` 放到文档顶部，`--after` 放到某 block 之后，省略位置参数=末尾追加（同 append）",
	},
	"delete-block": {
		Invoke: "`tabtin doc delete-block <id> <block-id>`",
		Help:   "删除单个 block（其余块不动）",
	},
	"append": {
		Invoke: "`tabtin doc append <id> --markdown <...>`",
		Help:   "**末尾追加一段**（只加不重写全文）——加一段就用它，别 read 全文再整篇 save",
	},
	"embed-table": {
		Invoke: "`tabtin doc embed-table <id> --table-id <table-id> [--title <title>] [--view-id <view-id>] [--after <block-id>]`",
		Help:   "**把已有 TabData 嵌入为 tabdataBlock**（≠ markdown 管道表）。自动生成带双引号的 `:::tabdata{tableId=\"...\"}`；空/无引号 tableId 以及 ID 内控制字符硬失败，title 换行/控制字符归一为空格。工作流：`table create` → 取 id → `doc embed-table` → `list-blocks` 确认 type=tabdataBlock",
	},
	"insert-image": {
		Invoke: "`tabtin doc insert-image <id> --file <path.png> [--alt <文本>] [--at-start | --after <block-id>]`",
		Help:   "**上传本地图片并作为标准 Markdown 图片插入**（`![alt](url)`，非自定义块）：上传会显式创建可长期访问的 TabDoc 图片副本，避免私有裸链接裂图。`--at-start` 放到文档顶部，`--after` 放到某 block 之后，省略位置参数则追加末尾",
	},
	"insert-html": {
		Invoke: "`tabtin doc insert-html <id> --file <path.html> [--title <t>] [--height <n>] [--after <block-id>]`",
		Help:   "**产出交互式 HTML 放进文档**（架构图/脑暴板/原型/数据可视化，单文件自包含 HTML）：私有上传（is_public=false）+ 插 HTML 块（沙箱 iframe 按 fileId 授权渲染）。新块 `src=\"\"`，只靠 `fileId`。缺 `--title` 用文件名、缺 `--height` 用 480、缺 `--after` 追加末尾",
	},
	"update-html": {
		Invoke: "`tabtin doc update-html <id> <block-id> --file <path.html> [--title <t>] [--height <n>]`",
		Help:   "**替换某个 HTML 块的内容**（AI 编辑回路：`read-block` 取 fileId → `GET /api/tabdoc/documents/<id>/html-artifacts/<fileId>` 授权下载 → 本地改 → update-html 重传）。缺 `--title`/`--height` 沿用现有块；块不是 HTML 块会报错",
	},
	"trash": {
		Invoke: "`tabtin doc trash <id>`",
		Help:   "移入回收站（第二级软删，可恢复）",
	},
	"restore": {
		Invoke: "`tabtin doc restore <id>`",
		Help:   "从回收站恢复（`trash` 的逆操作，trashed → 原状态）",
	},
	"unarchive": {
		Invoke: "`tabtin doc unarchive <id>`",
		Help:   "从归档恢复（解档，`delete` 的逆操作：archived → active）",
	},
	"permanent-delete": {
		Invoke: "`tabtin doc permanent-delete <id> --yes`",
		Help:   "永久删除（不可恢复，需 admin；前置：文档已在回收站）",
	},
	"version list": {
		Invoke: "`tabtin doc version list <id>`",
		Help:   "列出文档版本历史（支持 `--limit` `--offset`），返回的 `id` 即下面各子命令的版本 id",
	},
	"version preview": {
		Invoke: "`tabtin doc version preview <id> <history-id>`",
		Help:   "预览某版本的 Markdown 内容（只读，不改当前文档）",
	},
	"version restore": {
		Invoke: "`tabtin doc version restore <id> <history-id>`",
		Help:   "恢复文档到某版本（可选 `--base-version` 并发保护）",
	},
	"version save": {
		Invoke: "`tabtin doc version save <id> [--name <name>]`",
		Help:   "把当前内容存为命名版本（永久保留，可选 `--base-version`）——**仅用户明示时才代调，agent 常规写入走自动 VH**",
	},
	"version rename": {
		Invoke: "`tabtin doc version rename <id> <version-id> <name>`",
		Help:   "重命名命名版本",
	},
	"version rm": {
		Invoke: "`tabtin doc version rm <id> <version-id>`",
		Help:   "删除命名版本（软删，可逆语义，无需 `--yes`）",
	},
	"collaborator list": {
		Invoke: "`tabtin doc collaborator list <id>`",
		Help:   "列出协作者（含 owner），返回 `{owner, collaborators:[...]}`，每条含 `user_id`/`permission`",
	},
	"collaborator invite": {
		Invoke: "`tabtin doc collaborator invite <id> --user-ids <uid> --role <viewer|editor|admin>`",
		Help:   "批量邀请协作者（`--user-ids` 可重复，单次上限 50；需 owner/admin）。用户只给 email 时，先用 `tabtin organization members --search <email>` 反查同组织 user_id；执行后检查 `skipped`",
	},
	"collaborator update": {
		Invoke: "`tabtin doc collaborator update <id> <user-id> --role <viewer|editor|admin>`",
		Help:   "改协作者权限（owner 不可改；需 owner/admin）",
	},
	"collaborator rm": {
		Invoke: "`tabtin doc collaborator rm <id> <user-id>`",
		Help:   "移除协作者（软删，可重新邀请；owner 不可移除；需 owner/admin）",
	},
	"share set": {
		Invoke: "`tabtin doc share set <id> --share-type <public|organization> [--acknowledge-public-exposure] [--permission <view|comment|edit>] [--password <pwd>] [--expire-hours <n>] [--allow-download=false] [--allow-copy=false]`",
		Help:   "开/改分享（互斥 create-or-update）。**`--share-type` 必填**；`public`=免登录全网可达，首次扩权须 `--acknowledge-public-exposure`（否则 409）。`organization` 目标组织用全局 `--organization-id` 指定",
	},
	"share get": {
		Invoke: "`tabtin doc share get <id> [--share-type <public|organization>]`",
		Help:   "查看当前分享设置（只读；省略 `--share-type`=当前有效分享）",
	},
	"share off": {
		Invoke: "`tabtin doc share off <id> [--share-type <public|organization>]`",
		Help:   "关闭分享（软删 `is_active=False`，可用 `set` 重开；省略 `--share-type`=当前有效分享）",
	},
	"share refresh": {
		Invoke: "`tabtin doc share refresh <id> [--share-type <public|organization>]`",
		Help:   "轮换分享短链（旧链接立即失效；省略 `--share-type`=当前有效分享）",
	},
	"perm get": {
		Invoke: "`tabtin doc perm get <id>`",
		Help:   "列出文档权限覆盖条目（需 admin；与 collaborator list 不同）",
	},
	"perm set": {
		Invoke: "`tabtin doc perm set <id> --entries @file | --entry user:<id>:<role>`",
		Help:   "⚠ 全量 replace 权限表（禁空；须保留自身 user:<id>:admin）。先 get 再改完整列表",
	},
	"shared-with-me": {
		Invoke: "`tabtin doc shared-with-me`",
		Help:   "列出分享给我的文档（资源级协作发现入口；组织过滤用全局 --organization-id）",
	},
	"import markdown": {
		Invoke: "`tabtin doc import markdown --markdown <文本 | @文件 | ->`",
		Help:   "把 Markdown 转成草稿（pm_json + markdown），**不落库**——需配合 create/save-content 写入；agent 落库优先直接 create/save-content",
	},
	"import file": {
		Invoke: "`tabtin doc import file --file-record-id <fid>`",
		Help:   "提交 PDF/Word 异步 Import Job（202 + data.job）；再用 `doc import job status/result` poll 取草稿后 create/save-content；`<fid>` 先 `tabtin oss upload`",
	},
	"import job status": {
		Invoke: "`tabtin doc import job status <job-id>`",
		Help:   "查询 import job 进度（status/stage/result_available）",
	},
	"import job result": {
		Invoke: "`tabtin doc import job result <job-id>`",
		Help:   "任务完成后取草稿（markdown/pm_json）；未就绪返回 409",
	},
	"import job retry": {
		Invoke: "`tabtin doc import job retry <job-id>`",
		Help:   "重试失败的 import job",
	},
	"import job cancel": {
		Invoke: "`tabtin doc import job cancel <job-id>`",
		Help:   "取消进行中的 import job",
	},
	"comment list": {
		Invoke: "`tabtin doc comment list <id> [--threads]`",
		Help:   "列出评论；默认旧平铺 comments，`--threads` 走评论线程",
	},
	"comment add": {
		Invoke: "`tabtin doc comment add <id> --document|--block-id|--start-block-id ... [--body|--image]`",
		Help:   "创建评论线程（全文/整块/文字范围）；可重复 `--image`（≤9）",
	},
	"comment reply": {
		Invoke: "`tabtin doc comment reply <id> <thread-id> [--body|--image]`",
		Help:   "回复评论线程；可附图",
	},
	"comment resolve": {
		Invoke: "`tabtin doc comment resolve <id> <thread-id>`",
		Help:   "将评论线程标为已解决",
	},
	"comment reopen": {
		Invoke: "`tabtin doc comment reopen <id> <thread-id>`",
		Help:   "重新打开已解决的评论线程",
	},
	"comment reanchor": {
		Invoke: "`tabtin doc comment reanchor <id> <thread-id> --block-id|--start-block-id ...`",
		Help:   "重新关联失效的评论锚点",
	},
	"comment create": {
		Invoke: "`tabtin doc comment create <id> --body <文本>`",
		Help:   "新增文档评论（旧接口；新流程用 add）",
	},
	"comment rm": {
		Invoke: "`tabtin doc comment rm <id> <comment-id>`",
		Help:   "删除文档评论（旧接口）",
	},
}

// docSkillCLIOrder 与 apps_doc_test.go TestDocCommandsMounted 期望顺序一致，保证 SKILL 表稳定。
var docSkillCLIOrder = []string{
	"list", "create", "move", "search", "search-blocks", "read", "chunks", "export",
	"delete", "list-blocks", "update", "save-content",
	"read-block", "read-section", "update-block", "format-text", "highlight-text", "insert-block", "delete-block", "append", "embed-table",
	"insert-image", "insert-html", "update-html",
	"trash", "restore", "unarchive", "permanent-delete",
	"version list", "version preview", "version restore",
	"version save", "version rename", "version rm",
	"collaborator list", "collaborator invite", "collaborator update", "collaborator rm",
	"share set", "share get", "share off", "share refresh",
	"perm get", "perm set",
	"shared-with-me",
	"import markdown", "import file",
	"import job status", "import job result", "import job retry", "import job cancel",
	"comment list", "comment add", "comment reply", "comment resolve", "comment reopen", "comment reanchor",
	"comment create", "comment rm",
}

func applyDocAIHelpRegistry(root *cobra.Command) {
	for _, leaf := range walkLeafDocCommands(root) {
		rel := docRelativePath(leaf)
		entry, ok := docAIHelpRegistry[rel]
		if !ok {
			continue
		}
		cmdutil.SetCommandAIHelp(leaf, entry.Help)
	}
}

func renderDocSkillCLITableMarkdown() string {
	var b strings.Builder
	b.WriteString("| 命令 | 用途 |\n")
	b.WriteString("|------|------|\n")
	for _, rel := range docSkillCLIOrder {
		entry, ok := docAIHelpRegistry[rel]
		if !ok {
			continue
		}
		// 表格 cell 内反引号不二次转义；Help 里的 | 需避免（当前内容无裸 | 分隔符）
		fmt.Fprintf(&b, "| %s | %s |\n", entry.Invoke, entry.Help)
	}
	return strings.TrimRight(b.String(), "\n") + "\n"
}

func renderDocSkillCLISectionMarkdown() string {
	return docSkillCLISectionBegin + "\n\n" + renderDocSkillCLITableMarkdown() + "\n" + docSkillCLISectionEnd + "\n"
}
