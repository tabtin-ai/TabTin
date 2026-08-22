// apps_doc_html.go — TabDoc HTML 嵌入块的两条编排命令（doc insert-html / update-html）。
//
// 为什么要这两条命令
// ------------------
// TabDoc 的 HTML 块对标飞书：HTML 以**私有文件附件**上传到 OSS，文档块只存
// fileId（新块 src=""），前端按文档 ACL / 分享 ACL 授权拉取后用沙箱 iframe 渲染。
// Agent 要把一份自包含 HTML（交互式架构图 / 原型 / 数据可视化）放进文档，端到端得
// 两步：先把本地 .html 私有上传拿回 file_id，再把约定的 :::htmlblock{...} markdown
// 插进文档块链路。
//
// 文件生命周期：上传时把 context_type 声明为 'document'（见 docHTMLUploadBody），
// 让 cli-server 把 FileUsage 登记为 document 语义，从而随文档归档 / 永久删除被 TabDoc 的
// FileUsage 清理路径一并释放、孤儿文件可回收。update-html 替换下来的旧文件保持 active
// 不动（版本恢复依赖旧 URL 可达，刻意行为），直到文档删除时同 context_id 下的 document
// usages 一起释放。
//
// 声明式 CommandDef（单 Method+Path）只发一个请求，喂不了这种"上传→拼块"的
// 两步编排；oss upload / insert-block 这些已有命令各自只覆盖一步。所以这里走
// CommandDef.Execute 自定义钩子（规范 §3.1 推荐路径，比 RunFunc 更收敛：Execute
// 只管业务逻辑，dry-run 用 DryRun 钩子、输入校验用 Validate，输出统一走 output 层），
// 在 Go 侧把 /oss/upload 与 /api/tabdoc/.../blocks 两个请求串起来。
//
// markdown 块语法契约（与 doc-editor TS 侧 + Django markdown_exchange.py 三方锁死，
// 一字不能差）：
//
//	:::htmlblock{fileId="xxx" src="" title="架构图" height="480"}
//	:::
//
// 属性顺序固定 fileId, src, title, height；新块 src 为空串；height 是数字字符串。
// 转义规则（\\ 与 \"）与 TS pmJsonToMarkdown 的 escapeAttr / Django _esc_attr 对齐——
// buildHTMLBlockMarkdown 就是这三方的 Go 镜像。
//
// 容错设计（诊断性）：上传是第一步、写块是第二步。上传成功但写块失败时，file_id
// 已经产生（OSS 里有对象），错误 envelope 的 detail 里保留 file_id / 已拼好的
// markdown / 一条可直接重跑的 recovery 命令——Agent 无需重新上传就能补写块。
package cmd

import (
	"encoding/json"
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

const (
	// 上传参数：HTML 块的 OSS 归类。folder/module 与飞书"文档附件"语义对齐，
	// mime-type 固定 text/html（沙箱 iframe 按 HTML 渲染）。
	docHTMLUploadFolder = "tabdoc/html"
	docHTMLUploadModule = "tabdoc"
	docHTMLMimeType     = "text/html"

	// context_type='document'：让 cli-server 把 FileUsage 登记为 document 语义，
	// 纳入 TabDoc 归档/删除的 FileUsage 清理路径，文档删除后引用释放、孤儿文件可回收
	// 。白名单见 packages/cli-routes/src/routes/oss.ts。
	docHTMLUploadContextType = "document"

	// 默认块高度 480、默认标题"未命名 HTML"——与 TS/Django 三方序列化默认值对齐。
	docHTMLDefaultHeight = 480
	docHTMLDefaultTitle  = "未命名 HTML"

	// pm_json 里 HTML 块的节点 type（camelCase，与 doc-editor htmlBlock 节点 +
	// Django read_block 返回的 block_type 一致）。
	docHTMLNodeType = "htmlBlock"
)

// htmlBlockOpenRe 抓 :::htmlblock{...} 开行的属性串，与 doc-editor HTMLBLOCK_OPEN_RE /
// Django _HTMLBLOCK_OPEN_RE 同款正则。用于 update-html 从现有块 markdown 解析 title/height。
var htmlBlockOpenRe = regexp.MustCompile(`(?m)^:::htmlblock\{(.+)\}\s*$`)

// htmlBlockHeightRe 从属性串抓 height="<数字>"（与 doc-editor markdownToPmJson 的
// height 解析一致：只认纯数字）。
var htmlBlockHeightRe = regexp.MustCompile(`height="(\d+)"`)

// registerDocHTMLCommands 挂载 `doc insert-html` / `doc update-html` 两条编排命令。
// HTML 块浏览权限跟随文档 DocumentShare；独立 `doc html-share` 已移除。
//
// insert/update-html 是 doc 顶层叶子命令（与 insert-block 平级），归块级编辑一类。
// 它们不走声明式 Method+Path，而是用 Execute 钩子做多请求编排；DryRun 钩子输出完整
// 多步 plan，与其它写命令的 --dry-run 行为一致。
func registerDocHTMLCommands(parent *cobra.Command, f *cmdutil.Factory) {
	// Layer: L2
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "insert-html <document-id>", Short: "上传 HTML 文件并作为 HTML 块插入文档（上传→拼块两步编排）",
		Long: `把一份本地自包含 HTML 文件私有上传到 OSS，并作为 HTML 嵌入块插入文档——一条命令完成"上传→拼块"两步。
适合 Agent 产出交互式内容（架构图 / 脑暴板 / 原型 / 数据可视化，单文件 HTML）后放进文档：块在文档里以沙箱 iframe 在线渲染，权限跟随所属文档。
--file 是本地 .html 路径（须在 $HOME 或 /tmp 下，单文件上限 100MB）；--title 缺省用文件名（去扩展名），--height 缺省 480；--after 指定插到某 block 之后，缺省追加到文档末尾。
底层先 POST /oss/upload（is_public=false）拿 file_id，再拼 :::htmlblock{fileId=... src="" ...} markdown 走 insert-block 链路插块；新块不写永久公开 URL。上传成功但插块失败时，错误里保留 file_id 以便重试（无需重新上传）。`,
		Example: "  tabtin doc insert-html doc_xxx --file ./architecture.html\n" +
			"  tabtin doc insert-html doc_xxx --file /tmp/dashboard.html --title \"数据看板\" --height 600\n" +
			"  tabtin doc insert-html doc_xxx --file ./proto.html --after blk_yyy\n" +
			"  tabtin doc insert-html doc_xxx --file ./chart.html --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		RequiresAuth: true,
		HasFormat:    true,
		Flags: []cmdutil.FlagDef{
			{Name: "file", Type: cmdutil.FlagFile, Required: true, Desc: "本地 HTML 文件路径（须在 $HOME 或 /tmp 下，单文件 ≤100MB）"},
			{Name: "title", Type: cmdutil.FlagString, NoFileInput: true, Desc: "块标题（缺省用文件名去扩展名）"},
			{Name: "height", Type: cmdutil.FlagInt, Default: docHTMLDefaultHeight, Desc: "块高度像素（缺省 480；≤0 回退 480）"},
			{Name: "after", Type: cmdutil.FlagString, Desc: "插到此 block 之后（block-id，取自 doc list-blocks）；缺省追加末尾"},
		},
		Execute: docInsertHTMLExecute(f),
		DryRun:  docInsertHTMLDryRun,
	})

	// Layer: L2
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "update-html <document-id> <block-id>", Short: "用新 HTML 文件替换某个 HTML 块（读→上传→替换三步编排）",
		Long: `用一份新的本地 HTML 文件替换文档里已有的 HTML 块——AI 编辑 HTML 块的正路：读现有块 → 授权下载 → 本地改 → 上传新文件 → 替换引用。
先 GET 现有块拿到 markdown（含 fileId），用授权端点 GET /api/tabdoc/documents/<id>/html-artifacts/<fileId> 下载现有 HTML（ 私有化后禁止匿名 curl src）；目标块不是 HTML 块时直接报错退出。
--file 是新的本地 .html 路径（同 insert-html 的路径白名单 + 大小限制）；<block-id> 取自 doc list-blocks / read-block。
底层三步：读现有块 → POST /oss/upload 传新文件 → PATCH 块为新的 :::htmlblock{...}（新 fileId/src + 沿用或覆盖的 title/height）。上传成功但替换失败时，错误里保留新 file_id 以便重试。`,
		Example: "  tabtin doc update-html doc_xxx blk_yyy --file ./architecture-v2.html\n" +
			"  tabtin doc update-html doc_xxx blk_yyy --file /tmp/dashboard.html --title \"数据看板 v2\"\n" +
			"  tabtin doc update-html doc_xxx blk_yyy --file ./proto.html --height 720\n" +
			"  tabtin doc update-html doc_xxx blk_yyy --file ./chart.html --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		RequiresAuth: true,
		HasFormat:    true,
		Flags: []cmdutil.FlagDef{
			{Name: "file", Type: cmdutil.FlagFile, Required: true, Desc: "新的本地 HTML 文件路径（须在 $HOME 或 /tmp 下，单文件 ≤100MB）"},
			{Name: "title", Type: cmdutil.FlagString, NoFileInput: true, Desc: "块标题（缺省沿用现有块的 title）"},
			{Name: "height", Type: cmdutil.FlagInt, Desc: "块高度像素（缺省沿用现有块的 height；≤0 回退 480）"},
		},
		Execute: docUpdateHTMLExecute(f),
		DryRun:  docUpdateHTMLDryRun,
	})
}

// ── Execute 钩子 ──────────────────────────────────────────────

func docInsertHTMLExecute(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		docID, err := docHTMLRequireArg(ctx, 0, "document-id",
			"tabtin doc insert-html <document-id> --file <path.html>")
		if err != nil {
			return err
		}
		filePath := ctx.Str("file")
		if filePath == "" {
			return docHTMLValidationExit("必须提供 --file <path.html>",
				"tabtin doc insert-html "+docID+" --file ./chart.html")
		}
		title := docHTMLResolveTitle(ctx, docHTMLTitleFromFile(filePath))
		height := docHTMLResolveHeight(ctx, docHTMLDefaultHeight)

		tr, err := requireCliServerTransport(f, "doc insert-html")
		if err != nil {
			return err
		}

		// 第一步：上传 HTML 文件到 OSS。
		fileID, src, err := docHTMLUpload(ctx, tr, docID, filePath)
		if err != nil {
			return err
		}

		// 第二步：拼 markdown → 插块。失败时 file_id 已产生，保留到 detail。
		markdown := buildHTMLBlockMarkdown(fileID, src, title, height)
		blockBody := map[string]any{"markdown": markdown}
		after := ctx.Str("after")
		if after != "" {
			blockBody["after_block_id"] = after
		}
		docHTMLInjectScope(ctx, blockBody)

		recovery := docHTMLInsertRecoveryCmd(docID, markdown, after, false)
		blockPath := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/blocks"
		resp, reqErr := tr.Request(ctx.ReqContext, "POST", blockPath, blockBody, nil)
		if reqErr != nil || resp.Status >= 400 {
			return docHTMLStepFailed(resp, reqErr, "插入 HTML 块", docHTMLRecoveryDetail(fileID, src, markdown, recovery))
		}

		out := map[string]any{
			"file_id":  fileID,
			"url":      src,
			"title":    title,
			"height":   height,
			"markdown": markdown,
			"block":    docHTMLDataField(resp.Data),
		}
		output.PrintResult(output.SuccessEnvelope(out), f.Format)
		return nil
	}
}

func docUpdateHTMLExecute(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		docID, err := docHTMLRequireArg(ctx, 0, "document-id",
			"tabtin doc update-html <document-id> <block-id> --file <path.html>")
		if err != nil {
			return err
		}
		blockID, err := docHTMLRequireArg(ctx, 1, "block-id",
			"tabtin doc update-html <document-id> <block-id> --file <path.html>")
		if err != nil {
			return err
		}
		filePath := ctx.Str("file")
		if filePath == "" {
			return docHTMLValidationExit("必须提供 --file <path.html>",
				"tabtin doc update-html "+docID+" "+blockID+" --file ./chart.html")
		}

		tr, err := requireCliServerTransport(f, "doc update-html")
		if err != nil {
			return err
		}

		// 第一步：读现有块，确认是 HTML 块 + 取出现有 title/height 作为缺省。
		blockType, existingMD, err := docHTMLReadBlock(ctx, tr, docID, blockID)
		if err != nil {
			return err
		}
		if blockType != docHTMLNodeType {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError),
				fmt.Sprintf("block %s 不是 HTML 块（当前类型：%s），update-html 只能改 HTML 块", blockID, docHTMLDisplayType(blockType)),
				"用 doc list-blocks 确认块类型；改普通块用 doc update-block，插入新 HTML 块用 doc insert-html",
				output.ExitValidation,
			))
		}
		existingTitle, existingHeight := parseHTMLBlockTitleHeight(existingMD)
		title := docHTMLResolveTitle(ctx, existingTitle)
		height := docHTMLResolveHeight(ctx, existingHeight)

		// 第二步：上传新 HTML 文件。
		fileID, src, err := docHTMLUpload(ctx, tr, docID, filePath)
		if err != nil {
			return err
		}

		// 第三步：PATCH 块为新的 :::htmlblock{...}。失败时保留新 file_id。
		markdown := buildHTMLBlockMarkdown(fileID, src, title, height)
		blockBody := map[string]any{"markdown": markdown}
		docHTMLInjectScope(ctx, blockBody)

		recovery := docHTMLUpdateRecoveryCmd(docID, blockID, markdown)
		blockPath := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/blocks/" + url.PathEscape(blockID)
		resp, reqErr := tr.Request(ctx.ReqContext, "PATCH", blockPath, blockBody, nil)
		if reqErr != nil || resp.Status >= 400 {
			return docHTMLStepFailed(resp, reqErr, "替换 HTML 块", docHTMLRecoveryDetail(fileID, src, markdown, recovery))
		}

		out := map[string]any{
			"file_id":  fileID,
			"url":      src,
			"title":    title,
			"height":   height,
			"markdown": markdown,
			"block":    docHTMLDataField(resp.Data),
		}
		output.PrintResult(output.SuccessEnvelope(out), f.Format)
		return nil
	}
}

// ── DryRun 钩子（多步 plan 预演，不发任何请求）──────────────────

func docInsertHTMLDryRun(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
	docID := docHTMLArgOr(ctx, 0, "<document-id>")
	filePath := ctx.Str("file")
	title := docHTMLResolveTitle(ctx, docHTMLTitleFromFile(filePath))
	height := docHTMLResolveHeight(ctx, docHTMLDefaultHeight)

	uploadBody := docHTMLUploadBody(docID, filePath)
	blockBody := map[string]any{"markdown": docHTMLPlaceholderMarkdown(title, height)}
	if after := ctx.Str("after"); after != "" {
		blockBody["after_block_id"] = after
	}
	return cmdutil.NewDryRunPlan().
		Desc("上传 HTML 文件到 OSS，再拼 :::htmlblock{...} 插入文档块（两步编排；块的 fileId/src 由第 1 步上传结果回填）").
		Step("POST", "/oss/upload", uploadBody).File(filePath).
		Step("POST", "/api/tabdoc/documents/"+docID+"/blocks", blockBody)
}

func docUpdateHTMLDryRun(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
	docID := docHTMLArgOr(ctx, 0, "<document-id>")
	blockID := docHTMLArgOr(ctx, 1, "<block-id>")
	filePath := ctx.Str("file")

	// dry-run 不发网络请求，取不到现有块的 title/height——用占位符表达"沿用现有值或 --title/--height"。
	title := "<沿用现有块 title>"
	if ctx.Changed("title") {
		if t := ctx.Str("title"); t != "" {
			title = t
		}
	}
	height := "<沿用现有块 height>"
	if ctx.Changed("height") {
		if h := ctx.Int("height"); h > 0 {
			height = strconv.Itoa(h)
		}
	}

	uploadBody := docHTMLUploadBody(docID, filePath)
	blockBody := map[string]any{
		"markdown": fmt.Sprintf(":::htmlblock{fileId=%q src=%q title=%q height=%q}\n:::",
			"<上传后回填>", "<上传后回填>", title, height),
	}
	return cmdutil.NewDryRunPlan().
		Desc("读现有 HTML 块 → 上传新 HTML 文件到 OSS → PATCH 块为新的 :::htmlblock{...}（三步编排；未传 --title/--height 时沿用现有块的值）").
		Step("GET", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID).
		Step("POST", "/oss/upload", uploadBody).File(filePath).
		Step("PATCH", "/api/tabdoc/documents/"+docID+"/blocks/"+blockID, blockBody)
}

// ── 编排步骤 helper ───────────────────────────────────────────

// docHTMLUpload 执行第一步上传：POST /oss/upload，返回 file_id + 空 src。
// ：私有 HTML 不再把永久 URL 写入块；渲染走授权端点。
func docHTMLUpload(ctx *cmdutil.RunContext, tr transport.Transport, docID, filePath string) (fileID, src string, err error) {
	uploadBody := docHTMLUploadBody(docID, filePath)
	docHTMLInjectScope(ctx, uploadBody)

	resp, reqErr := tr.Request(ctx.ReqContext, "POST", "/oss/upload", uploadBody, nil)
	if reqErr != nil {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NetworkError),
			fmt.Sprintf("上传 HTML 文件时网络错误：%s", reqErr.Error()),
			"检查 daemon / 桌面端是否在运行、网络是否可达后重试",
			output.ExitNetwork,
		))
	}
	if resp.Status >= 400 {
		return "", "", docHTMLPlainRespError(resp, "上传 HTML 文件")
	}
	data, _ := docHTMLDataField(resp.Data).(map[string]any)
	fileID, _ = data["file_id"].(string)
	if fileID == "" {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			"上传成功但未返回 file_id",
			"检查 OSS 配置后重试上传",
			output.ExitGeneral,
		))
	}
	// 持久化 src 置空：阅读时由客户端按 documentId+fileId 调授权端点。
	return fileID, "", nil
}

// docHTMLReadBlock 执行 update-html 第一步：GET 现有块，返回 block_type + markdown。
func docHTMLReadBlock(ctx *cmdutil.RunContext, tr transport.Transport, docID, blockID string) (blockType, markdown string, err error) {
	readPath := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/blocks/" + url.PathEscape(blockID)
	// 与声明式 read-block 一致：space_id / organization_id 作为 query 透传（后端按 document_id + 鉴权解析，多传无害）。
	q := url.Values{}
	if ctx.SpaceID != "" {
		q.Set("space_id", ctx.SpaceID)
	}
	if ctx.OrganizationID != "" {
		q.Set("organization_id", ctx.OrganizationID)
	}
	if len(q) > 0 {
		readPath += "?" + q.Encode()
	}

	resp, reqErr := tr.Request(ctx.ReqContext, "GET", readPath, nil, nil)
	if reqErr != nil {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NetworkError),
			fmt.Sprintf("读取现有 block 时网络错误：%s", reqErr.Error()),
			"检查 daemon / 桌面端是否在运行后重试",
			output.ExitNetwork,
		))
	}
	if resp.Status >= 400 {
		return "", "", docHTMLPlainRespError(resp, "读取现有 block")
	}
	data, _ := docHTMLDataField(resp.Data).(map[string]any)
	blockType, _ = data["block_type"].(string)
	markdown, _ = data["markdown"].(string)
	return blockType, markdown, nil
}

// ── markdown 构造与解析（三方契约的 Go 镜像）───────────────────

// buildHTMLBlockMarkdown 拼 :::htmlblock{...} markdown，与 doc-editor pmJsonToMarkdown /
// Django markdown_exchange 的序列化严格对齐：属性顺序 fileId, src, title, height；
// fileId/src/title 走 \\ + \" 转义；title 额外把换行折成空格；height 为正整数（≤0 回退 480）。
func buildHTMLBlockMarkdown(fileID, src, title string, height int) string {
	if title == "" {
		title = docHTMLDefaultTitle
	}
	if height <= 0 {
		height = docHTMLDefaultHeight
	}
	safeTitle := strings.NewReplacer("\n", " ", "\r", " ").Replace(docHTMLEscapeAttr(title))
	return fmt.Sprintf(":::htmlblock{fileId=\"%s\" src=\"%s\" title=\"%s\" height=\"%d\"}\n:::",
		docHTMLEscapeAttr(fileID),
		docHTMLEscapeAttr(src),
		safeTitle,
		height,
	)
}

// docHTMLPlaceholderMarkdown 是 insert-html dry-run 用的 markdown 预览：fileId/src 是
// "上传后回填"占位符（真实值由第 1 步上传结果决定），title/height 已定。
func docHTMLPlaceholderMarkdown(title string, height int) string {
	if title == "" {
		title = docHTMLDefaultTitle
	}
	if height <= 0 {
		height = docHTMLDefaultHeight
	}
	safeTitle := strings.NewReplacer("\n", " ", "\r", " ").Replace(docHTMLEscapeAttr(title))
	return fmt.Sprintf(":::htmlblock{fileId=\"%s\" src=\"%s\" title=\"%s\" height=\"%d\"}\n:::",
		"<上传后回填>", "<上传后回填>", safeTitle, height)
}

// docHTMLEscapeAttr 转义 directive 属性值：\\ 与 \"。与 TS escapeAttr / Django _esc_attr 一致。
func docHTMLEscapeAttr(s string) string {
	s = strings.ReplaceAll(s, `\`, `\\`)
	s = strings.ReplaceAll(s, `"`, `\"`)
	return s
}

// parseHTMLBlockTitleHeight 从现有块 markdown 里解析 title / height（update-html 缺省沿用）。
// 解析逻辑与 doc-editor parseQuotedAttr / markdownToPmJson 对齐：title 处理反斜杠转义、
// 停在未转义引号；height 只认纯数字，非法/缺省回退 480、title 回退"未命名 HTML"。
func parseHTMLBlockTitleHeight(md string) (title string, height int) {
	title = docHTMLDefaultTitle
	height = docHTMLDefaultHeight
	m := htmlBlockOpenRe.FindStringSubmatch(md)
	if m == nil {
		return title, height
	}
	attrs := m[1]
	title = parseHTMLBlockAttr(attrs, "title", docHTMLDefaultTitle)
	if hm := htmlBlockHeightRe.FindStringSubmatch(attrs); hm != nil {
		if h, convErr := strconv.Atoi(hm[1]); convErr == nil && h > 0 {
			height = h
		}
	}
	return title, height
}

// parseHTMLBlockAttr 是 doc-editor parseQuotedAttr 的 Go 镜像：从属性串里抓 name="..."，
// 支持反斜杠转义（\X → X），停在未转义的 "。按字节扫描——多字节 UTF-8（如中文）的字节
// 都 ≥0x80，不会误命中 ASCII 的 \ 或 "，故字节级安全且保留原字符。
func parseHTMLBlockAttr(attrsStr, name, def string) string {
	prefix := name + `="`
	idx := strings.Index(attrsStr, prefix)
	if idx == -1 {
		return def
	}
	var b strings.Builder
	for i := idx + len(prefix); i < len(attrsStr); i++ {
		c := attrsStr[i]
		if c == '\\' && i+1 < len(attrsStr) {
			b.WriteByte(attrsStr[i+1])
			i++
			continue
		}
		if c == '"' {
			break
		}
		b.WriteByte(c)
	}
	if b.Len() == 0 {
		return def
	}
	return b.String()
}

// ── 小工具 ───────────────────────────────────────────────────

// docHTMLUploadBody 构造 /oss/upload 请求体（不含 scope；scope 由 docHTMLInjectScope 补）。
// 有真实 docID 时带上 context_id（文件归属追踪）+ context_type='document'：后者让
// cli-server 把 FileUsage 登记为 document 语义，从而纳入 TabDoc 归档/永久删除的
// FileUsage 清理路径（DocumentService._deactivate_document_file_usages 只认
// context_type in ['document','document_cover']）→ 文档删除后引用释放、孤儿文件可回收。
// 修复 ：旧口径 cli-server 固定 'present'，永远不被 TabDoc 清理路径覆盖 → 永不回收。
// context_type 白名单见 packages/cli-routes/src/routes/oss.ts 的 resolveUploadContextType。
func docHTMLUploadBody(docID, filePath string) map[string]any {
	body := map[string]any{
		"file_path": filePath,
		"folder":    docHTMLUploadFolder,
		"module":    docHTMLUploadModule,
		"mime_type": docHTMLMimeType,
		// ：HTML artifact 跟随文档权限，禁止公开直链。
		"is_public": false,
	}
	if docID != "" && !strings.HasPrefix(docID, "<") {
		body["context_id"] = docID
		body["context_type"] = docHTMLUploadContextType
	}
	return body
}

// docHTMLInjectScope 把 space_id / organization_id 注入请求体，镜像声明式 buildRequestBody
// 的全局注入（/oss/upload 用 organization_id 定位上传归属；block 端点忽略多余字段）。
func docHTMLInjectScope(ctx *cmdutil.RunContext, body map[string]any) {
	if ctx.SpaceID != "" {
		body["space_id"] = ctx.SpaceID
	}
	if ctx.OrganizationID != "" {
		body["organization_id"] = ctx.OrganizationID
	}
}

// docHTMLTitleFromFile 从文件路径取缺省标题：文件名去扩展名；空则回退"未命名 HTML"。
func docHTMLTitleFromFile(filePath string) string {
	if filePath == "" {
		return docHTMLDefaultTitle
	}
	base := filepath.Base(filePath)
	name := strings.TrimSuffix(base, filepath.Ext(base))
	if name == "" {
		return docHTMLDefaultTitle
	}
	return name
}

// docHTMLResolveTitle：用户显式传 --title（非空）优先，否则用 def（缺省来源），再兜底默认。
func docHTMLResolveTitle(ctx *cmdutil.RunContext, def string) string {
	if ctx.Changed("title") {
		if t := ctx.Str("title"); t != "" {
			return t
		}
	}
	if def == "" {
		return docHTMLDefaultTitle
	}
	return def
}

// docHTMLResolveHeight：用户显式传 --height（>0）优先，否则用 def（缺省来源），再兜底 480。
func docHTMLResolveHeight(ctx *cmdutil.RunContext, def int) int {
	if ctx.Changed("height") {
		if h := ctx.Int("height"); h > 0 {
			return h
		}
	}
	if def > 0 {
		return def
	}
	return docHTMLDefaultHeight
}

// docHTMLRequireArg 取第 idx 个位置参数，缺失/空白则打 VALIDATION_ERROR 退出。
func docHTMLRequireArg(ctx *cmdutil.RunContext, idx int, name, usage string) (string, error) {
	if idx >= len(ctx.Args) || strings.TrimSpace(ctx.Args[idx]) == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("缺少必填参数 <%s>", name),
			"用法："+usage,
			output.ExitValidation,
		))
	}
	return ctx.Args[idx], nil
}

// docHTMLArgOr 取第 idx 个位置参数，缺失则返回 fallback（给 dry-run 占位用）。
func docHTMLArgOr(ctx *cmdutil.RunContext, idx int, fallback string) string {
	if idx < len(ctx.Args) && strings.TrimSpace(ctx.Args[idx]) != "" {
		return ctx.Args[idx]
	}
	return fallback
}

// docHTMLValidationExit 打一条 VALIDATION_ERROR 退出。
func docHTMLValidationExit(msg, usage string) error {
	return output.PrintErrorAndExit(output.ErrorEnvelope(
		string(errcode.ValidationError), msg, "用法："+usage, output.ExitValidation,
	))
}

// docHTMLDisplayType 给块类型一个人类可读展示（空/unknown 兜底）。
func docHTMLDisplayType(blockType string) string {
	if blockType == "" || blockType == "unknown" {
		return "未知/空"
	}
	return blockType
}

// docHTMLDataField 从 CLI envelope（{ok:true, data:{...}} 或 Django {success, data:{...}}）
// 取出 data 层；无 data 键则原样返回顶层。
func docHTMLDataField(raw []byte) any {
	var top any
	if json.Unmarshal(raw, &top) != nil {
		return nil
	}
	if m, ok := top.(map[string]any); ok {
		if d, ok2 := m["data"]; ok2 {
			return d
		}
	}
	return top
}

// docHTMLPlainRespError 把 4xx/5xx transport 响应转成 error envelope（无 recovery detail）。
// 镜像 printTransportResponse 的错误分支：优先解 envelope error 的 code/message/hint。
func docHTMLPlainRespError(resp *transport.Response, stage string) error {
	exitCode := cmdutil.MapHTTPToExitCode(resp.Status)
	code := cmdutil.HTTPStatusToErrorCode(resp.Status)
	message := fmt.Sprintf("%s失败 (HTTP %d)", stage, resp.Status)
	hint := ""
	var errData map[string]any
	if json.Unmarshal(resp.Data, &errData) == nil {
		if c, m, h := cmdutil.ExtractAPIError(errData); c != "" || m != "" {
			if c != "" {
				code = c
			}
			if m != "" {
				message = fmt.Sprintf("%s失败：%s", stage, m)
			}
			hint = h
		}
	}
	return output.PrintErrorAndExit(output.ErrorEnvelope(code, message, hint, exitCode))
}

// docHTMLStepFailed 处理"上传已成功、后续写块步骤失败"：error envelope 带 recovery detail，
// 让 Agent 无需重新上传就能补写块。既处理网络错误（reqErr != nil）也处理 4xx/5xx。
func docHTMLStepFailed(resp *transport.Response, reqErr error, stage string, detail map[string]any) error {
	hint := docHTMLRecoveryHint(detail)
	if reqErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelopeWith(
			string(errcode.NetworkError),
			fmt.Sprintf("%s时网络错误：%s", stage, reqErr.Error()),
			hint,
			output.ExitNetwork,
			output.ErrorEnvelopeOpts{Detail: detail},
		))
	}
	exitCode := cmdutil.MapHTTPToExitCode(resp.Status)
	code := cmdutil.HTTPStatusToErrorCode(resp.Status)
	message := fmt.Sprintf("%s失败 (HTTP %d)", stage, resp.Status)
	var errData map[string]any
	if json.Unmarshal(resp.Data, &errData) == nil {
		if c, m, h := cmdutil.ExtractAPIError(errData); c != "" || m != "" {
			if c != "" {
				code = c
			}
			if m != "" {
				message = fmt.Sprintf("%s失败：%s", stage, m)
			}
			if h != "" {
				hint = h + "；" + hint
			}
		}
	}
	return output.PrintErrorAndExit(output.ErrorEnvelopeWith(
		code, message, hint, exitCode, output.ErrorEnvelopeOpts{Detail: detail},
	))
}

// docHTMLRecoveryDetail 打包上传成功后写块失败的可恢复信息。
func docHTMLRecoveryDetail(fileID, src, markdown, recoveryCmd string) map[string]any {
	return map[string]any{
		"file_id":          fileID,
		"url":              src,
		"markdown":         markdown,
		"recovery_command": recoveryCmd,
		"retryable":        true,
	}
}

// docHTMLRecoveryHint 生成"文件已上传成功、用这条命令补写块"的人类可读提示。
func docHTMLRecoveryHint(detail map[string]any) string {
	fileID, _ := detail["file_id"].(string)
	cmd, _ := detail["recovery_command"].(string)
	return fmt.Sprintf("HTML 文件已上传成功（file_id=%s），无需重新上传；用以下命令重试写块：%s", fileID, cmd)
}

// docHTMLInsertRecoveryCmd / docHTMLUpdateRecoveryCmd 生成可直接重跑的 block 命令，
// 让 Agent 在写块失败后不必重传文件即可补齐（markdown 已含上传好的 fileId/src）。
func docHTMLInsertRecoveryCmd(docID, markdown, after string, atStart bool) string {
	cmd := fmt.Sprintf("tabtin doc insert-block %s --markdown %s", docID, docHTMLShellQuote(markdown))
	if after != "" {
		cmd += " --after " + after
	} else if atStart {
		cmd += " --at-start"
	}
	return cmd
}

func docHTMLUpdateRecoveryCmd(docID, blockID, markdown string) string {
	return fmt.Sprintf("tabtin doc update-block %s %s --markdown %s", docID, blockID, docHTMLShellQuote(markdown))
}

// docHTMLShellQuote 把 markdown 包成单引号 shell 字面量（内部单引号用 '\” 转义），
// 便于用户/Agent 从 hint 里直接复制重跑。
func docHTMLShellQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}
