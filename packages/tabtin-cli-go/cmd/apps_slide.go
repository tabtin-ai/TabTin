package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// ─── Slide ───────────────────────────────────────────────────────

func newCmdSlide(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "slide", Short: "演示文稿（TabSlide）"}
	defs := []cmdutil.CommandDef{
		{
			Use: "create", Short: "创建可编辑云演示项目（进阶；做 PPT 请用 render 直出本地 .pptx）",
			Example: "  tabtin slide create --name \"Q4 Review\"\n" +
				"  tabtin slide create --name \"Landing\" --html \"@./landing.html\"",
			AIHelp: "创建**可编辑云演示项目**（当前版本 TabSlide 编辑器界面未开放，一般不需要）。用户要「做 PPT / 幻灯片 / 演示文稿」交付本地文件时，用 `slide render` 一步直出本地 .pptx，不要用本命令建云项目。",
			// ：当前版本对 Agent 隐藏 create（云项目进阶命令），只暴露 render 直出本地
			// pptx。命令仍注册可用（render 走的是 /slide/create 路由，不受影响）。
			Hidden: true,
			Route:  cmdutil.RouteCliServer, Method: "POST", Path: "/slide/create",
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Desc: "名称"},
				{Name: "file", Type: cmdutil.FlagFile, CliOnly: true, Desc: "HTML 文件路径"},
				{Name: "html", Type: cmdutil.FlagString, Desc: "HTML 内容（支持 @file 或 - 从 stdin 读取）"},
				{Name: "title", Type: cmdutil.FlagString, Desc: "生成页标题"},
				{Name: "preset", Type: cmdutil.FlagString, Default: "ppt", Desc: "预设 (ppt)"},
				{Name: "canvas-width", Type: cmdutil.FlagInt, Default: 1280, Desc: "画布宽度（与 html-spec 一致）"},
				{Name: "canvas-height", Type: cmdutil.FlagInt, Default: 720, Desc: "画布高度（与 html-spec 一致）"},
				{Name: "mode", Type: cmdutil.FlagString, Default: "direct", Desc: "HTML 生成模式"},
			},
			FileField: "html",
			Conflicts: map[string][]string{
				"file": {"html"},
				"html": {"file"},
			},
			HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "id", Label: "ID", Type: "id"},
				{Key: "name", Label: "名称", Type: "string"},
				{Key: "preset", Label: "预设", Type: "string"},
				{Key: "page_count", Label: "页数", Type: "number"},
				{Key: "latest_version", Label: "版本", Type: "number"},
				{Key: "updated_at", Label: "更新时间", Type: "datetime"},
			},
		},
		// 合并：保留远端 Example + 我方 OutputSchema（L31）
		{
			Use: "list", Short: "列出演示文稿", Example: "  tabtin slide list",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/list",
			HasFormat: true, RequiresAgent: true,
			// L31：projects 数组中每条记录字段（与 _serialize_project_summary 对齐）。
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "id", Label: "ID", Type: "id"},
				{Key: "name", Label: "名称", Type: "string"},
				{Key: "preset", Label: "预设", Type: "string"},
				{Key: "page_count", Label: "页数", Type: "number"},
				{Key: "latest_version", Label: "版本", Type: "number"},
				{Key: "created_at", Label: "创建时间", Type: "datetime"},
				{Key: "updated_at", Label: "更新时间", Type: "datetime"},
			},
		},
		{Use: "outline", Short: "大纲", Example: "  tabtin slide outline --project-id xxx", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/outline", Flags: []cmdutil.FlagDef{{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"}}, HasFormat: true, RequiresAgent: true},
		{
			Use: "page", Short: "查看单页详情",
			Example: "  tabtin slide page --project-id xxx --page-id pg_001",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/slide/page",
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "page-id", Type: cmdutil.FlagString, Required: true, Desc: "页面 ID"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "generate", Short: "AI 生成",
			Example: "  # 覆盖整个项目页面集（危险操作，非追加）：\n" +
				"  tabtin slide generate --project-id xxx --replace --html \"<h1>Title</h1>\"\n" +
				"  tabtin slide generate --project-id xxx --replace --html \"@./deck.html\"",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/generate",
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "html", Type: cmdutil.FlagString, Desc: "HTML 内容（也支持 stdin 管道）"},
				{Name: "title", Type: cmdutil.FlagString, Desc: "标题"},
				{Name: "mode", Type: cmdutil.FlagString, Default: "direct", Desc: "模式"},
				{Name: "replace", Type: cmdutil.FlagBool, Desc: "允许覆盖当前项目的全部页面；不传时非空项目会拒绝执行"},
			},
			StdinField: "html",
			HasFormat:  true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "update", Short: "更新元素",
			// patch schema: 顶层只允许 PPTElement 结构字段（id/type/x/y/width/height/rotate/opacity/locked/...）+ props。
			// 内容字段（content/src/fill/color/fontSize/...）必须嵌入 props 内。
			// 顶层写错字段会返回 400 + 迁移提示，不会静默吞掉。
			Example: "  # 改文字内容（content 嵌 props 内）：\n" +
				"  tabtin slide update --project-id xxx --page-id pg_001 --element-id el_001 \\\n" +
				"    --patch '{\"props\":{\"content\":\"<p><span style=\\\"color:#FFF;font-size:48pt\\\">新标题</span></p>\"}}'\n" +
				"  # 改位置/尺寸（顶层结构字段，直接写）：\n" +
				"  tabtin slide update --project-id xxx --page-id pg_001 --element-id el_001 --patch '{\"x\":100,\"y\":200,\"width\":800}'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/update",
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "page-id", Type: cmdutil.FlagString, Required: true, Desc: "页面 ID"},
				{Name: "element-id", Type: cmdutil.FlagString, Required: true, Desc: "元素 ID"},
				{Name: "patch", Type: cmdutil.FlagString, Required: true,
					Desc: "更新数据 JSON。顶层仅允许 PPTElement 结构字段（x/y/width/height/rotate/opacity/locked/...）+ props；内容字段（content/src/fill/...）必须嵌入 props 内"},
				{Name: "base-version", Type: cmdutil.FlagInt, Desc: "基础版本"},
			},
			HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "add-page", Short: "添加页面",
			Example: "  tabtin slide add-page --project-id xxx                            # 末尾新增一页\n" +
				"  tabtin slide add-page --project-id xxx --after-page page-3       # 插到 page-3 之后\n" +
				"  tabtin slide add-page --project-id xxx --html \"@./slide.html\"   # 从 HTML 追加新页",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/add-page",
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "page-id", Type: cmdutil.FlagString, Desc: "新页 ID（默认自动生成）"},
				{Name: "file", Type: cmdutil.FlagFile, CliOnly: true, Desc: "HTML 文件路径"},
				{Name: "html", Type: cmdutil.FlagString, Desc: "HTML 内容（支持 @file 或 - 从 stdin 读取）"},
				{Name: "title", Type: cmdutil.FlagString, Desc: "生成页标题"},
				{Name: "mode", Type: cmdutil.FlagString, Default: "direct", Desc: "HTML 生成模式"},
				{Name: "background", Type: cmdutil.FlagString, Desc: "背景 CSS"},
				{Name: "after-page", Type: cmdutil.FlagString, Desc: "插入到该 page-id 之后（不传则末尾新增）"},
				// 高级用法：直接传完整顺序 JSON 数组，会覆盖 after-page
				{Name: "page-order", Type: cmdutil.FlagString, Desc: "（高级）完整页面顺序 JSON 数组，如 '[\"p1\",\"p2\",\"p3\"]'"},
			},
			FileField:  "html",
			StdinField: "html",
			Conflicts: map[string][]string{
				"file": {"html"},
				"html": {"file"},
			},
			HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
		},
		{Use: "delete-page", Short: "删除页面", Example: "  tabtin slide delete-page --project-id xxx --page-id pg_001 --yes", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/delete-page", Flags: []cmdutil.FlagDef{{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"}, {Name: "page-id", Type: cmdutil.FlagString, Required: true, Desc: "页面 ID"}}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskHigh},
		{Use: "reorder [page-ids...]", Short: "页面排序",
			Example: "  tabtin slide reorder --project-id xxx --page-order '[\"id1\",\"id2\"]'\n  tabtin slide reorder --project-id xxx id1 id2 id3",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/slide/reorder",
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "page-order", Type: cmdutil.FlagString, Desc: "页面顺序 JSON 数组（也可作为位置参数）"},
			}, ArgsMapping: []string{"page_order"}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
		{Use: "preview", Short: "预览", Example: "  tabtin slide preview --project-id xxx", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/preview", Flags: []cmdutil.FlagDef{{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"}, {Name: "page-id", Type: cmdutil.FlagString, Desc: "页面 ID"}, {Name: "response-format", Type: cmdutil.FlagString, Default: "url", Desc: "响应格式"}}, HasFormat: true, RequiresAgent: true},
		{Use: "lint", Short: "检查", Example: "  tabtin slide lint --project-id xxx\n  tabtin slide lint --project-id xxx --problems-only\n  tabtin slide lint --project-id xxx --min-severity warning  # 只看 warning 及以上\n  tabtin slide lint --project-id xxx --skip-visual          # 只跑 structural（毫秒级）", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/lint", Flags: []cmdutil.FlagDef{{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"}, {Name: "page-id", Type: cmdutil.FlagString, Desc: "页面 ID"}, {Name: "problems-only", Type: cmdutil.FlagBool, Desc: "仅显示 error/warning 级问题"}, {Name: "min-severity", Type: cmdutil.FlagString, Desc: "最低严重级别：error | warning | info"}, {Name: "skip-visual", Type: cmdutil.FlagBool, Desc: "跳过 Playwright 视觉 lint（只跑 structural，毫秒级）"}}, HasFormat: true, RequiresAgent: true},
		{
			Use: "grep", Short: "全文本搜索",
			Example: "  tabtin slide grep --project-id xxx --query \"季度营收\"\n" +
				"  tabtin slide grep --project-id xxx --query \"Lumio\" --page-id page-3\n" +
				"  tabtin slide grep --project-id xxx --query \"Primary\" --element-types text",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/grep",
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "query", Type: cmdutil.FlagString, Required: true,
					Desc: "要搜索的子串（不区分大小写、不需正则）"},
				{Name: "page-id", Type: cmdutil.FlagString, Desc: "限制搜索单页（不传则全 PPT）"},
				{Name: "element-types", Type: cmdutil.FlagString,
					Desc: "限制元素类型，逗号分隔或 JSON 数组（默认 text,shape）"},
				{Name: "max-results", Type: cmdutil.FlagInt, Default: 50,
					Desc: "最多返回多少条匹配（达上限即停）"},
			},
			HasFormat: true, RequiresAgent: true,
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "page_id", Label: "页面 ID", Type: "string"},
				{Key: "page_index", Label: "页序号", Type: "number"},
				{Key: "element_id", Label: "元素 ID", Type: "id"},
				{Key: "element_type", Label: "类型", Type: "string"},
				{Key: "content_excerpt", Label: "匹配上下文", Type: "string"},
			},
		},
		{
			Use: "batch-update", Short: "批量修改元素",
			// 跟 update 同样的 patch schema：内容字段必须嵌入 props。
			// 任何一条 patch schema 不合法 → 整批拒绝并返回每条错误清单。
			Example: "  tabtin slide batch-update --project-id xxx --updates '[\n" +
				"    {\"page_id\":\"pg_001\",\"element_id\":\"el_001\",\"patch\":{\"props\":{\"content\":\"<p>新标题</p>\"}}},\n" +
				"    {\"page_id\":\"pg_001\",\"element_id\":\"el_002\",\"patch\":{\"x\":100,\"y\":200,\"width\":800}},\n" +
				"    {\"page_id\":\"pg_001\",\"element_id\":\"el_003\",\"patch\":{\"props\":{\"fill\":\"#FF0000\"}}}\n" +
				"  ]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/slide/batch-update",
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "updates", Type: cmdutil.FlagString, Required: true,
					Desc: "更新数组 JSON：[{page_id, element_id, patch}, ...]。每条 patch 同 update 命令的 schema"},
				{Name: "base-version", Type: cmdutil.FlagInt, Desc: "基线版本号（CAS）"},
			},
			HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use:   "render",
			Short: "生成 PPT / 幻灯片 / 演示文稿：直出本地 .pptx 文件（首选，不留云项目）",
			Long: `用户要「做 / 生成一份 PPT / 幻灯片 / 演示文稿」时的**默认命令**：从 HTML 一步
生成本地 PPTX 文件——内部完成 创建临时渲染项目 → 导出 → 下载落盘 → 删除临时项目，
全程不产生用户可见的云演示文稿（云项目只是瞬时渲染介质）。当前版本 TabSlide 编辑器
界面未开放，交付物就是工作目录里的本地 .pptx 文件，不要引导用户去应用里打开/编辑。

生成 ≠ 发布：文件落地后仍需调 present_to_user 的 local_file item 才会在聊天里出现卡片。
HTML 规范先读 app:tabslide/html-spec。`,
			Example: "  tabtin slide render --html \"@./deck.html\" --save-to ./季度汇报.pptx\n" +
				"  tabtin slide render --html \"@./季度汇报.html\" -o 汇报.pptx\n" +
				"  # 调试用：允许 HTML 撑破画布仍导出（交付勿用）\n" +
				"  tabtin slide render --html \"@./deck.html\" -o ./out.pptx --allow-html-overflow",
			Route: cmdutil.RouteCliServer,
			// canvas 默认 1280×720：与 html-spec 的 .ppt-slide 尺寸、PPTX 页面
			// （12192000 EMU = 1280×9525）三层完全对齐——HTML→JSON→PPT 全程
			// scale=1，量到什么导出什么，消除中间缩放层的取整/换算误差。
			Flags: []cmdutil.FlagDef{
				{Name: "html", Type: cmdutil.FlagString, Required: true,
					Desc: "HTML 内容（支持 @file 或 - 从 stdin 读取）"},
				{Name: "save-to", Short: "o", Type: cmdutil.FlagString, Required: true, CliOnly: true, NoFileInput: true,
					Desc: "输出 PPTX 文件路径（推荐 workspace 相对路径，如 artifacts/deck.pptx）"},
				{Name: "name", Type: cmdutil.FlagString,
					Desc: "演示名称（写入 PPTX 元数据；默认取 --save-to 文件名）"},
				{Name: "canvas-width", Type: cmdutil.FlagInt, Default: 1280,
					Desc: "画布宽度（与 html-spec .ppt-slide 一致，勿随意改）"},
				{Name: "canvas-height", Type: cmdutil.FlagInt, Default: 720,
					Desc: "画布高度（与 html-spec .ppt-slide 一致，勿随意改）"},
				{Name: "allow-html-overflow", Type: cmdutil.FlagBool, Default: false,
					Desc: "允许 HTML 撑破 1280×720 仍导出 PPTX（默认拒绝；交付请改 HTML/拆页）"},
			},
			StdinField: "html",
			HasFormat:  true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
			AIHelp: "用户要做 PPT / 幻灯片 / 演示文稿时的默认命令：写好 HTML 后一步生成本地 .pptx（内部渲染→导出→删除临时项目，不留云项目），再调 present_to_user 的 local_file item 发布成卡片。不要用 slide create 建云项目。",
			Execute: func(ctx *cmdutil.RunContext) error {
				return runSlideRender(ctx, f)
			},
		},
		{
			Use:   "export",
			Short: "导出 PPTX",
			Long: `导出演示文稿为 PPTX 文件。

默认只返回 OSS 下载链接（download_url）；带 --save-to 时由 CLI 把 PPTX 直接下载到
本地文件路径（推荐 workspace 相对路径），之后可用 present_to_user 的 local_file item 发布成聊天文件卡片。
后端当前仅支持 pptx 格式（不再暴露 --format，避免 shadow 全局输出 --format）。`,
			Example: "  tabtin slide export --project-id xxx\n" +
				"  tabtin slide export --project-id xxx --save-to 季度汇报.pptx",
			Route: cmdutil.RouteCliServer,
			Flags: []cmdutil.FlagDef{
				{Name: "project-id", Type: cmdutil.FlagString, Required: true, Desc: "项目 ID"},
				{Name: "save-to", Short: "o", Type: cmdutil.FlagString, CliOnly: true, NoFileInput: true,
					Desc: "把导出的 PPTX 下载到本地文件路径；省略则只返回 download_url"},
			},
			HasFormat: true, RequiresAgent: true,
			Execute: func(ctx *cmdutil.RunContext) error {
				return runSlideExport(ctx, f)
			},
		},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	return cmd
}

// slideRenderTimeout 覆盖「服务端 HTML→PPTElement 渲染 + 按需生成 PPTX + 上传 OSS」链路
// （Playwright / OSS），比默认 30s 长。
const slideRenderTimeout = 120 * time.Second

// runSlideRender 执行 `tabtin slide render`：HTML → 本地 PPTX 一步直达。
//
// 编排：POST /slide/create（HTML→PPTElement）→ POST /slide/export（拿 download_url）
// → 下载写盘 → POST /slide/delete-project（删除临时项目）。
// 云项目仅作瞬时渲染介质：成功与失败路径都会清理，不留用户可见的云演示文稿——
// 这正是「Agent 做 PPT 不再在演示 App 里留下项目」的关键。
func runSlideRender(ctx *cmdutil.RunContext, f *cmdutil.Factory) error {
	saveTo := strings.TrimSpace(ctx.Str("save-to"))
	if saveTo == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), "--save-to 不能为空或纯空白",
			"传入目标文件路径，例如 --save-to 季度汇报.pptx", output.ExitValidation))
	}
	html := ctx.Str("html")
	if strings.TrimSpace(html) == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), "html 内容不能为空",
			"用 --html @./deck.html 或 stdin 管道传入", output.ExitValidation))
	}

	tr, err := f.Transport()
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail))
	}
	if tr.Type() == transport.TypeDjango {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			"'render' 需要 TabTin 桌面端或 Daemon 运行。当前为 API 直连模式。",
			"tabtin daemon start", output.ExitServiceUnavail))
	}

	reqCtx := ctx.ReqContext
	if reqCtx == nil {
		reqCtx = context.Background()
	}

	name := strings.TrimSpace(ctx.Str("name"))
	if name == "" {
		base := filepath.Base(saveTo)
		name = strings.TrimSuffix(base, filepath.Ext(base))
	}
	createBody := map[string]any{
		"name": name,
		"html": html,
		// render 是用完即删的临时项目：图片 data:base64 内嵌、不上传 OSS，
		// 导出 pptx 全程自包含（不依赖 OSS 可达性 / 不留孤儿对象）
		"inline_images": true,
	}
	// FlagValues 只含用户显式传过的 flag——默认值必须在这里显式带上，
	// 否则 cli-server create 路由会回退到编辑器口径的 1920×1080，破坏
	// HTML(1280×720)→JSON→PPT(12192000 EMU) 的 1:1 坐标统一
	canvasW := ctx.Int("canvas-width")
	if canvasW <= 0 {
		canvasW = 1280
	}
	canvasH := ctx.Int("canvas-height")
	if canvasH <= 0 {
		canvasH = 720
	}
	createBody["canvas_width"] = canvasW
	createBody["canvas_height"] = canvasH
	// Execute 钩子不走声明式 buildRequestBody；create 路由需要 organization_id / space_id
	// （cli-server 侧对 Agent PTY 有 env 兜底），ctx 有值时显式透传更稳。
	if ctx.OrganizationID != "" {
		createBody["organization_id"] = ctx.OrganizationID
	}
	if ctx.SpaceID != "" {
		createBody["space_id"] = ctx.SpaceID
	}

	createResp, err := tr.Request(reqCtx, "POST", "/slide/create", createBody,
		&transport.RequestOptions{Timeout: slideRenderTimeout})
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
	}
	if createResp.Status >= 400 {
		// create 失败：cli-server 的 create 路由自带失败回滚，无需额外清理
		return printTransportResponse(createResp, f.Format)
	}

	projectID, pageCount, createLayoutProblems := slideRenderProjectInfo(createResp.Data)
	if projectID == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), "创建临时渲染项目成功但未返回 project id", "", output.ExitInternal))
	}

	// 无论成败都清理临时项目；清理失败只 stderr 提示，不影响主流程结果。
	cleanup := func() {
		resp, cerr := tr.Request(reqCtx, "POST", "/slide/delete-project",
			map[string]any{"project_id": projectID}, nil)
		if cerr != nil || resp.Status >= 400 {
			fmt.Fprintf(os.Stderr, "⚠ 临时渲染项目清理失败（project_id=%s），可手动删除\n", projectID)
		}
	}

	// structural lint（毫秒级）+ create 阶段 HTML 布局 lint 合并。
	// 默认：html_overflow 撑破画布则拒绝导出，逼 Agent 拆页/精简（可用 --allow-html-overflow 绕过）。
	lintProblems, lintSummary := slideRenderLint(reqCtx, tr, projectID)
	lintProblems = slideMergeLintProblems(createLayoutProblems, lintProblems)
	allowOverflow := ctx.Bool("allow-html-overflow")
	if blocking := slideHTMLOverflowProblems(lintProblems); len(blocking) > 0 && !allowOverflow {
		cleanup()
		hint := "修改 HTML 消除 html_overflow（severity=error）后重跑 render；调试可用 --allow-html-overflow"
		for _, p := range blocking {
			if m, ok := p.(map[string]any); ok {
				fmt.Fprintf(os.Stderr, "✗ [%v] page=%v %v\n",
					m["type"], m["page_id"], m["message"])
			}
		}
		return output.PrintErrorAndExit(output.ErrorEnvelopeWith(
			string(errcode.ValidationError),
			"HTML 内容超出 1280×720 画布，已拒绝导出 PPTX",
			hint,
			output.ExitValidation,
			output.ErrorEnvelopeOpts{Detail: map[string]any{
				"lint_problems": lintProblems,
				"blocked_by":    blocking,
				"lint_summary":  lintSummary,
			}},
		))
	}

	exportResp, err := tr.Request(reqCtx, "POST", "/slide/export",
		map[string]any{"project_id": projectID, "format": "pptx"},
		&transport.RequestOptions{Timeout: slideRenderTimeout})
	if err != nil {
		cleanup()
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
	}
	if exportResp.Status >= 400 {
		cleanup()
		return printTransportResponse(exportResp, f.Format)
	}

	downloadURL, _ := slideExportInfo(exportResp.Data)
	if downloadURL == "" {
		cleanup()
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), "导出成功但响应缺少 download_url，无法下载到本地", "", output.ExitInternal))
	}

	if dir := filepath.Dir(saveTo); dir != "" && dir != "." {
		if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
			cleanup()
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), fmt.Sprintf("创建输出目录失败: %v", mkErr), "", output.ExitGeneral))
		}
	}
	if dlErr := pkgGetFile(reqCtx, downloadURL, saveTo); dlErr != nil {
		cleanup()
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), fmt.Sprintf("下载 PPTX 失败: %v", dlErr), "", output.ExitGeneral))
	}
	cleanup()

	result := map[string]any{"path": saveTo}
	if pageCount > 0 {
		result["page_count"] = pageCount
	}
	if info, statErr := os.Stat(saveTo); statErr == nil {
		result["size_bytes"] = info.Size()
	}
	if lintSummary != nil {
		result["lint_summary"] = lintSummary
	}
	if len(lintProblems) > 0 {
		result["lint_problems"] = lintProblems
		result["lint_hint"] = "存在布局/结构问题。html_overflow=HTML 撑破画布（默认已拦截）；out_of_canvas=抽取后元素越界。修改 HTML 后重新 render。"
	}
	result["next_step"] = fileCreateNextStep(saveTo)
	output.PrintResult(output.SuccessEnvelope(result), f.Format)
	if f.Format != output.FormatJSON {
		fmt.Fprintf(os.Stdout, "NEXT_STEP: %s\n", result["next_step"])
	}
	return nil
}

// slideRenderLint 对临时渲染项目跑 structural lint（skip_visual，毫秒级），
// 返回 (problems, summary)。任何失败都静默返回 nil——lint 是增值信息，不阻断导出。
func slideRenderLint(reqCtx context.Context, tr transport.Transport, projectID string) ([]any, map[string]any) {
	resp, err := tr.Request(reqCtx, "POST", "/slide/lint", map[string]any{
		"project_id":    projectID,
		"skip_visual":   true,
		"problems_only": true,
	}, nil)
	if err != nil || resp.Status >= 400 {
		return nil, nil
	}
	var body map[string]any
	if json.Unmarshal(resp.Data, &body) != nil {
		return nil, nil
	}
	payload := body
	if data, ok := body["data"].(map[string]any); ok {
		payload = data
	}
	problems, _ := payload["problems"].([]any)
	summary, _ := payload["summary"].(map[string]any)
	return problems, summary
}

// runSlideExport 执行 `tabtin slide export`：
//   - 无 --save-to：透传后端响应（download_url + filename），行为不变。
//   - 带 --save-to：拿到 download_url 后由 CLI 直接下载写盘（复用 pkgGetFile），
//     输出本地路径 + present_to_user local_file 发布提示，与 `tabtin file create` 交付口径一致。
func runSlideExport(ctx *cmdutil.RunContext, f *cmdutil.Factory) error {
	saveTo := strings.TrimSpace(ctx.Str("save-to"))

	tr, err := f.Transport()
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail))
	}
	if tr.Type() == transport.TypeDjango {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable),
			"'export' 需要 TabTin 桌面端或 Daemon 运行。当前为 API 直连模式。",
			"tabtin daemon start", output.ExitServiceUnavail))
	}

	reqCtx := ctx.ReqContext
	if reqCtx == nil {
		reqCtx = context.Background()
	}
	resp, err := tr.Request(reqCtx, "POST", "/slide/export",
		map[string]any{"project_id": ctx.Str("project-id"), "format": "pptx"},
		&transport.RequestOptions{Timeout: slideRenderTimeout})
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
	}
	if saveTo == "" || resp.Status >= 400 {
		return printTransportResponse(resp, f.Format)
	}

	downloadURL, filename := slideExportInfo(resp.Data)
	if downloadURL == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), "导出成功但响应缺少 download_url，无法下载到本地",
			"去掉 --save-to 重试并检查原始响应", output.ExitInternal))
	}

	if dir := filepath.Dir(saveTo); dir != "" && dir != "." {
		if mkErr := os.MkdirAll(dir, 0o755); mkErr != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.InternalError), fmt.Sprintf("创建输出目录失败: %v", mkErr), "", output.ExitGeneral))
		}
	}
	if dlErr := pkgGetFile(reqCtx, downloadURL, saveTo); dlErr != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError), fmt.Sprintf("下载 PPTX 失败: %v", dlErr),
			"网络恢复后重试，或去掉 --save-to 拿 download_url 自行下载", output.ExitGeneral))
	}

	result := map[string]any{"path": saveTo, "filename": filename}
	if info, statErr := os.Stat(saveTo); statErr == nil {
		result["size_bytes"] = info.Size()
	}
	result["next_step"] = fileCreateNextStep(saveTo)
	output.PrintResult(output.SuccessEnvelope(result), f.Format)
	if f.Format != output.FormatJSON {
		fmt.Fprintf(os.Stdout, "NEXT_STEP: %s\n", result["next_step"])
	}
	return nil
}

// slideRenderProjectInfo 从 create 响应中提取 project id、page_count、layout_problems。
// 兼容 Django envelope（{data:{...}}）与已解包对象两种形状。
func slideRenderProjectInfo(raw []byte) (projectID string, pageCount int, layoutProblems []any) {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return "", 0, nil
	}
	payload := body
	if data, ok := body["data"].(map[string]any); ok {
		payload = data
	}
	projectID, _ = payload["id"].(string)
	if n, ok := payload["page_count"].(float64); ok {
		pageCount = int(n)
	}
	if probs, ok := payload["layout_problems"].([]any); ok {
		layoutProblems = probs
	}
	return projectID, pageCount, layoutProblems
}

// slideMergeLintProblems 合并 create 阶段 HTML 布局问题与 /lint 结果（按 type+page_id 去重）。
func slideMergeLintProblems(chunks ...[]any) []any {
	seen := map[string]bool{}
	var out []any
	for _, chunk := range chunks {
		for _, p := range chunk {
			m, ok := p.(map[string]any)
			if !ok {
				out = append(out, p)
				continue
			}
			key := fmt.Sprintf("%v|%v|%v", m["type"], m["page_id"], m["message"])
			if seen[key] {
				continue
			}
			seen[key] = true
			out = append(out, p)
		}
	}
	return out
}

// slideHTMLOverflowProblems 返回会阻断导出的布局问题。
// 仅 severity=error 的 html_overflow / html_clipped_text 阻断（>24px 撑破或严重裁字）；
// warning（微量越界）仍附在 lint_problems 里提示，不拦交付。
func slideHTMLOverflowProblems(problems []any) []any {
	var blocking []any
	for _, p := range problems {
		m, ok := p.(map[string]any)
		if !ok {
			continue
		}
		typ, _ := m["type"].(string)
		sev, _ := m["severity"].(string)
		if sev != "error" {
			continue
		}
		switch typ {
		case "html_overflow", "html_clipped_text":
			blocking = append(blocking, p)
		}
	}
	return blocking
}

// slideExportInfo 从 export 响应中提取 download_url / filename。
// 兼容 Django envelope（{data:{...}}）与已解包对象两种形状。
func slideExportInfo(raw []byte) (downloadURL string, filename string) {
	var body map[string]any
	if json.Unmarshal(raw, &body) != nil {
		return "", ""
	}
	payload := body
	if data, ok := body["data"].(map[string]any); ok {
		payload = data
	}
	downloadURL, _ = payload["download_url"].(string)
	filename, _ = payload["filename"].(string)
	return downloadURL, filename
}
