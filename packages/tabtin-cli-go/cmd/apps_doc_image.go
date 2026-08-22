// apps_doc_image.go — TabDoc 图片插入编排命令（doc insert-image）。
//
// 为什么要这条命令
// ------------------
// TabDoc 正文里的图片走标准 CommonMark `![alt](url)` 语法（见 apps_doc.go
// docMarkdownWarnings 雷区 6：正文手写 `<img>` 会被前端 sanitize 吃掉）。这跟
// insert-html 的 :::htmlblock{...} 不一样——图片不是自定义 directive，
// doc-editor markdownToPmJson / Django markdown_exchange 天然认识标准图片
// 语法，无需注册新 directive、无需沙箱 iframe。
//
// Agent 本地生成/下载了一张图片后要放进文档正文，端到端仍是两步：先把本地
// 图片作为私有对象传到 OSS，拿回稳定 file_id 和一次性 url，再把二者一起交给
// 文档块链路。后端只持久化 file_id，读取时按文档权限换签。声明式 CommandDef
// （单 Method+Path）喂不了这种"上传→绑定"两步编排，
// 走 Execute 自定义钩子——与 apps_doc_html.go 的 insert-html 同一套路，
// 复用其中的通用编排 helper（docHTMLRequireArg / docHTMLInjectScope /
// docHTMLStepFailed / docHTMLRecoveryDetail / docHTMLDataField /
// docHTMLPlainRespError / docHTMLInsertRecoveryCmd 等——这些 helper 名带
// "HTML" 前缀是历史命名，语义其实通用于"上传→拼块"两步编排，不重复定义）。
//
// 文件生命周期（ 同款口径）：上传时把 context_type 声明为 'document'，
// 让 cli-server 把 FileUsage 登记为 document 语义，纳入 TabDoc 归档/删除的
// FileUsage 清理路径，文档删除后引用释放、孤儿文件可回收。
//
// 容错设计：上传是第一步、插块是第二步。上传成功但插块失败时，file_id 已
// 产生（OSS 里有对象），错误 envelope 的 detail 里保留 file_id / url / 已拼
// 好的 markdown / 一条可直接重跑的 recovery 命令——Agent 无需重新上传就能
// 补写块。
package cmd

import (
	"fmt"
	"net/url"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

const (
	// 上传参数：图片的 OSS 归类。folder 与 insert-html 的 tabdoc/html 平级。
	docImageUploadFolder = "tabdoc/images"
	docImageUploadModule = "tabdoc"
	// 图片对象保持私有；第二步通过 image_file_id 把稳定 FileRecord 绑定到
	// image node，渲染时按文档成员/分享权限换取短期地址。
	docImageUploadIsPublic = false

	// context_type='document'：见 apps_doc_html.go docHTMLUploadContextType 头注释。
	docImageUploadContextType = "document"

	// 默认替代文本——缺 --alt 且文件名也取不到时的兜底。
	docImageDefaultAlt = "图片"
)

// mdEscapeCharsRe 转义 Markdown 行内元字符，与 Django markdown_exchange.py
// 的 _escape_md_chars（_MD_ESCAPE_RE = r"([*_~`\[\]\\<>])"）保持一致，防止
// alt 文本里的 `]`、`*` 等字符把 `![alt](url)` 拆坏或被误解析成强调/代码。
var mdEscapeCharsRe = regexp.MustCompile("([*_~`\\[\\]\\\\<>])")

// escapeMarkdownInline 转义 alt 文本：先把换行/回车折成空格（图片 alt 是单行
// 属性，多行会破坏 `![...]` 的行内语法），再转义 Markdown 元字符。
func escapeMarkdownInline(s string) string {
	s = strings.NewReplacer("\n", " ", "\r", " ").Replace(s)
	return mdEscapeCharsRe.ReplaceAllString(s, `\$1`)
}

// registerDocImageCommands 挂载 `doc insert-image` 编排命令。
//
// 与 insert-html 同类：doc 顶层叶子命令，与 insert-block 平级，归块级编辑
// 一类。不走声明式 Method+Path，用 Execute 钩子做"上传→拼块"两步编排；
// DryRun 钩子输出完整多步 plan，与其它写命令的 --dry-run 行为一致。
func registerDocImageCommands(parent *cobra.Command, f *cmdutil.Factory) {
	// Layer: L2
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use: "insert-image <document-id>", Short: "上传私有图片并绑定到文档正文（上传→绑定两步编排）",
		Long: `把一张本地图片作为私有对象上传到 OSS，并绑定到文档正文——一条命令完成"上传→绑定"两步。
适合 Agent 把本地生成 / 下载的图片（截图、图表、照片）放进正文：编辑时仍走标准 ` + "`![alt](url)`" + ` 解析，但文档只持久化 file_id，成员或分享访问时再按权限换取短期地址。
--file 是本地图片路径（须在 $HOME 或 /tmp 下，支持 png/jpg/jpeg/gif/webp/svg，单文件上限 100MB）；--alt 缺省用文件名（去扩展名）；--at-start 插到文档顶部，--after 插到某 block 之后，二者都不传则追加末尾。
底层先 POST /oss/upload 拿 file_id + 临时 url，再通过 image_file_id 走 insert-block 链路绑定；上传成功但插块失败时，错误里保留 file_id 以便重试（无需重新上传）。
已有现成的公开图片 URL（不需要上传本地文件）时，直接在 --markdown 里写 ![alt](url) 走 insert-block / append 即可，不必用这条命令。`,
		Example: "  tabtin doc insert-image doc_xxx --file ./chart.png\n" +
			"  tabtin doc insert-image doc_xxx --file /tmp/screenshot.png --alt \"架构截图\"\n" +
			"  tabtin doc insert-image doc_xxx --file ./cover.png --at-start\n" +
			"  tabtin doc insert-image doc_xxx --file ./diagram.svg --after blk_yyy\n" +
			"  tabtin doc insert-image doc_xxx --file ./photo.jpg --dry-run --format json",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		RequiresAuth: true,
		HasFormat:    true,
		Flags: []cmdutil.FlagDef{
			{Name: "file", Type: cmdutil.FlagFile, Required: true, Desc: "本地图片路径（须在 $HOME 或 /tmp 下；png/jpg/jpeg/gif/webp/svg；单文件 ≤100MB）"},
			{Name: "alt", Type: cmdutil.FlagString, NoFileInput: true, Desc: "图片替代文本（缺省用文件名去扩展名）"},
			{Name: "after", Type: cmdutil.FlagString, Desc: "插到此 block 之后（block-id，取自 doc list-blocks）；缺省追加末尾"},
			{Name: "at-start", Type: cmdutil.FlagBool, Desc: "插到文档顶部（与 --after 互斥）"},
		},
		Conflicts: map[string][]string{
			"after":    {"at-start"},
			"at-start": {"after"},
		},
		Execute: docInsertImageExecute(f),
		DryRun:  docInsertImageDryRun,
	})
}

// ── Execute 钩子 ──────────────────────────────────────────────

func docInsertImageExecute(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		docID, err := docHTMLRequireArg(ctx, 0, "document-id",
			"tabtin doc insert-image <document-id> --file <path.png>")
		if err != nil {
			return err
		}
		filePath := ctx.Str("file")
		if filePath == "" {
			return docHTMLValidationExit("必须提供 --file <path.png>",
				"tabtin doc insert-image "+docID+" --file ./chart.png")
		}
		alt := docImageResolveAlt(ctx, docImageAltFromFile(filePath))

		tr, err := requireCliServerTransport(f, "doc insert-image")
		if err != nil {
			return err
		}

		// 第一步：上传图片到 OSS。
		fileID, src, err := docImageUpload(ctx, tr, docID, filePath)
		if err != nil {
			return err
		}

		// 第二步：拼 markdown → 插块。失败时 file_id 已产生，保留到 detail。
		markdown := buildImageMarkdown(alt, src)
		after := ctx.Str("after")
		atStart := ctx.Bool("at-start")
		blockBody := docImageBlockBody(markdown, after, atStart)
		blockBody["image_file_id"] = fileID
		docHTMLInjectScope(ctx, blockBody)

		recovery := docImageInsertRecoveryCmd(docID, markdown, fileID, after, atStart)
		blockPath := "/api/tabdoc/documents/" + url.PathEscape(docID) + "/blocks"
		resp, reqErr := tr.Request(ctx.ReqContext, "POST", blockPath, blockBody, nil)
		if reqErr != nil || resp.Status >= 400 {
			return docHTMLStepFailed(resp, reqErr, "插入图片", docHTMLRecoveryDetail(fileID, src, markdown, recovery))
		}

		out := map[string]any{
			"file_id":  fileID,
			"url":      src,
			"alt":      alt,
			"markdown": markdown,
			"block":    docHTMLDataField(resp.Data),
		}
		output.PrintResult(output.SuccessEnvelope(out), f.Format)
		return nil
	}
}

// ── DryRun 钩子（两步 plan 预演，不发任何请求）───────────────────

func docInsertImageDryRun(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
	docID := docHTMLArgOr(ctx, 0, "<document-id>")
	filePath := ctx.Str("file")
	alt := docImageResolveAlt(ctx, docImageAltFromFile(filePath))

	uploadBody := docImageUploadBody(docID, filePath)
	blockBody := docImageBlockBody(docImagePlaceholderMarkdown(alt), ctx.Str("after"), ctx.Bool("at-start"))
	blockBody["image_file_id"] = "<上传后 file_id>"
	return cmdutil.NewDryRunPlan().
		Desc("上传图片到 OSS，再拼 ![alt](url) 插入文档块（两步编排；url 由第 1 步上传结果回填）").
		Step("POST", "/oss/upload", uploadBody).File(filePath).
		Step("POST", "/api/tabdoc/documents/"+docID+"/blocks", blockBody)
}

// ── 编排步骤 helper ───────────────────────────────────────────

// docImageUpload 执行第一步上传：POST /oss/upload，返回 file_id + url。
// 不固定 mime_type——图片扩展名多样（png/jpg/gif/webp/svg），交给 cli-server
// 的 guessMimeType 按扩展名自动识别（见 packages/cli-routes/src/routes/
// local-file-guard.ts MIME_MAP），比 insert-html 固定 text/html 更合适。
func docImageUpload(ctx *cmdutil.RunContext, tr transport.Transport, docID, filePath string) (fileID, src string, err error) {
	uploadBody := docImageUploadBody(docID, filePath)
	docHTMLInjectScope(ctx, uploadBody)

	resp, reqErr := tr.Request(ctx.ReqContext, "POST", "/oss/upload", uploadBody, nil)
	if reqErr != nil {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.NetworkError),
			fmt.Sprintf("上传图片时网络错误：%s", reqErr.Error()),
			"检查 daemon / 桌面端是否在运行、网络是否可达后重试",
			output.ExitNetwork,
		))
	}
	if resp.Status >= 400 {
		return "", "", docHTMLPlainRespError(resp, "上传图片")
	}
	data, _ := docHTMLDataField(resp.Data).(map[string]any)
	fileID, _ = data["file_id"].(string)
	src, _ = data["url"].(string)
	if fileID == "" || src == "" {
		return "", "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			"上传成功但未返回 file_id 或临时访问 URL",
			"检查 OSS 配置后重试上传",
			output.ExitGeneral,
		))
	}
	return fileID, src, nil
}

// docImageInsertRecoveryCmd 保留私有图片的稳定 file_id。临时 URL 即使过期也只用于
// Markdown 解析；后端验证 FileUsage 后会清空 src，并把 file_id 写进图片节点。
func docImageInsertRecoveryCmd(docID, markdown, fileID, after string, atStart bool) string {
	cmd := docHTMLInsertRecoveryCmd(docID, markdown, after, atStart)
	if fileID != "" {
		cmd += " --image-file-id " + docHTMLShellQuote(fileID)
	}
	return cmd
}

// ── markdown 构造（三方契约的 Go 镜像）─────────────────────────

// buildImageMarkdown 拼 ![alt](url) 标准 Markdown 图片语法。alt 走
// escapeMarkdownInline 转义（与 Django markdown_exchange._escape_md_chars /
// _render_image_markdown 对齐），src 是本命令自己上传拿到的 OSS URL，
// 不需要再转义。alt 为空时回退默认替代文本。
func buildImageMarkdown(alt, src string) string {
	if alt == "" {
		alt = docImageDefaultAlt
	}
	return fmt.Sprintf("![%s](%s)", escapeMarkdownInline(alt), src)
}

// docImagePlaceholderMarkdown 是 insert-image dry-run 用的 markdown 预览：
// url 是"上传后回填"占位符（真实值由第 1 步上传结果决定），alt 已定。
func docImagePlaceholderMarkdown(alt string) string {
	if alt == "" {
		alt = docImageDefaultAlt
	}
	return fmt.Sprintf("![%s](%s)", escapeMarkdownInline(alt), "<上传后回填>")
}

// ── 小工具 ───────────────────────────────────────────────────

// docImageUploadBody 构造 /oss/upload 请求体（不含 scope；scope 由
// docHTMLInjectScope 补）。语义同 apps_doc_html.go 的 docHTMLUploadBody，
// 只是 folder/module 换成图片分类、且不固定 mime_type（见 docImageUpload）。
func docImageUploadBody(docID, filePath string) map[string]any {
	body := map[string]any{
		"file_path": filePath,
		"folder":    docImageUploadFolder,
		"module":    docImageUploadModule,
		"is_public": docImageUploadIsPublic,
	}
	if docID != "" && !strings.HasPrefix(docID, "<") {
		body["context_id"] = docID
		body["context_type"] = docImageUploadContextType
	}
	return body
}

// docImageBlockBody 把 CLI 的位置参数归一成后端 BlockInsertRequest。
// at_start=false 时不发送该字段，保持旧后端请求形状与缺省末尾追加语义。
func docImageBlockBody(markdown, after string, atStart bool) map[string]any {
	body := map[string]any{"markdown": markdown}
	if after != "" {
		body["after_block_id"] = after
	}
	if atStart {
		body["at_start"] = true
	}
	return body
}

// docImageAltFromFile 从文件路径取缺省 alt：文件名去扩展名；空则回退默认替代文本。
func docImageAltFromFile(filePath string) string {
	if filePath == "" {
		return docImageDefaultAlt
	}
	base := filepath.Base(filePath)
	name := strings.TrimSuffix(base, filepath.Ext(base))
	if name == "" {
		return docImageDefaultAlt
	}
	return name
}

// docImageResolveAlt：用户显式传 --alt（非空）优先，否则用 def（缺省来源），再兜底默认。
func docImageResolveAlt(ctx *cmdutil.RunContext, def string) string {
	if ctx.Changed("alt") {
		if a := ctx.Str("alt"); a != "" {
			return a
		}
	}
	if def == "" {
		return docImageDefaultAlt
	}
	return def
}
