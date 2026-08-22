package cmd

import (
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// ─── Site ────────────────────────────────────────────────────────

func newCmdSite(f *cmdutil.Factory) *cobra.Command {
	// #5353：临时不向 `tabtin --help` / 默认 `tabtin commands` 暴露；显式调用仍可用。
	cmd := &cobra.Command{Use: "site", Short: "网站管理（TabSite）", Hidden: true}
	defs := []cmdutil.CommandDef{
		{Use: "create", Short: "创建站点", Example: "  tabtin site create --name my-blog\n  tabtin site create --name landing --framework vue", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/site/create", Flags: []cmdutil.FlagDef{{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "站点名称"}, {Name: "description", Type: cmdutil.FlagString, Desc: "描述"}, {Name: "framework", Type: cmdutil.FlagString, Default: "react", Desc: "框架 (react/vue/...)"}, {Name: "template", Type: cmdutil.FlagString, Default: "blank", Desc: "模板"}}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
		{Use: "list", Short: "列出站点", Example: "  tabtin site list\n  tabtin site list --status published", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/site/list", Flags: []cmdutil.FlagDef{{Name: "status", Type: cmdutil.FlagString, Desc: "状态筛选"}, {Name: "page", Type: cmdutil.FlagInt, Desc: "页码"}, {Name: "page-size", Type: cmdutil.FlagInt, Desc: "每页大小"}}, HasFormat: true, RequiresAgent: true},
		{Use: "info <id>", Short: "站点详情", Example: "  tabtin site info --id site_xxx", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/site/info", Flags: []cmdutil.FlagDef{{Name: "id", Type: cmdutil.FlagString, Required: true, Desc: "站点 ID"}}, HasFormat: true, RequiresAgent: true},
		{Use: "update <id>", Short: "更新站点", Example: "  tabtin site update --id site_xxx --name new-name", Route: cmdutil.RouteCliServer, Method: "PATCH", Path: "/site/update", Flags: []cmdutil.FlagDef{{Name: "id", Type: cmdutil.FlagString, Required: true, Desc: "站点 ID"}, {Name: "name", Type: cmdutil.FlagString, Desc: "名称"}, {Name: "description", Type: cmdutil.FlagString, Desc: "描述"}}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
		{Use: "publish <id>", Short: "发布", Example: "  tabtin site publish --id site_xxx --dist-url https://cdn.example.com/dist.tar.gz", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/site/publish", Flags: []cmdutil.FlagDef{{Name: "id", Type: cmdutil.FlagString, Required: true, Desc: "站点 ID"}, {Name: "dist-url", Type: cmdutil.FlagString, Required: true, Desc: "构建产物 URL"}, {Name: "message", Type: cmdutil.FlagString, Desc: "发布说明"}}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
		{Use: "rollback <id> <version>", Short: "回滚", Example: "  tabtin site rollback --id site_xxx --version 3 --yes", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/site/rollback", Flags: []cmdutil.FlagDef{{Name: "id", Type: cmdutil.FlagString, Required: true, Desc: "站点 ID"}, {Name: "version", Type: cmdutil.FlagInt, Required: true, Desc: "版本号"}}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskHigh},
		{Use: "build-info <id>", Short: "构建信息", Example: "  tabtin site build-info --id site_xxx", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/site/build-info", Flags: []cmdutil.FlagDef{{Name: "id", Type: cmdutil.FlagString, Required: true, Desc: "站点 ID"}}, HasFormat: true, RequiresAgent: true},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	hideCommandTree(cmd)
	return cmd
}

// ─── Media ───────────────────────────────────────────────────────

func newCmdMedia(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "media", Short: "AI 媒体生成"}

	imageCmd := &cobra.Command{Use: "image", Short: "文生图"}
	cmdutil.RegisterCommand(imageCmd, f, cmdutil.CommandDef{
		Use: "generate", Short: "生成图片",
		Example: "  tabtin media image generate --prompt \"一只可爱的猫咪\"",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/media/generate/image",
		Flags: []cmdutil.FlagDef{
			{Name: "prompt", Type: cmdutil.FlagString, Required: true, Desc: "提示词"},
			{Name: "model", Type: cmdutil.FlagString, Desc: "模型"},
			{Name: "size", Type: cmdutil.FlagString, Desc: "尺寸"},
			{Name: "negative-prompt", Type: cmdutil.FlagString, Desc: "负向提示词"},
			{Name: "n", Type: cmdutil.FlagInt, Desc: "生成数量"},
			{Name: "seed", Type: cmdutil.FlagInt, Desc: "随机种子"},
		},
		HasFormat: true, Risk: cmdutil.RiskWrite, Timeout: 5 * time.Minute,
		WaitTaskPath: "/media/tasks/{task_id}", WaitForPermanentStorage: true,
		StorageWaitTimeout: 90 * time.Second,
	})
	cmdutil.RegisterCommand(imageCmd, f, cmdutil.CommandDef{Use: "status <id>", Short: "任务状态", Example: "  tabtin media image status task_xxx", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/media/tasks/{id}", HasFormat: true, ArgsMapping: []string{"id"}})
	cmdutil.RegisterCommand(imageCmd, f, cmdutil.CommandDef{Use: "models", Short: "可用模型", Example: "  tabtin media image models", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/media/catalog?task_type=text2image", HasFormat: true})
	cmdutil.RegisterCommand(imageCmd, f, cmdutil.CommandDef{Use: "cancel <id>", Short: "取消任务", Example: "  tabtin media image cancel task_xxx", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/media/tasks/{id}/cancel", Risk: cmdutil.RiskWrite, RiskDeclared: true, HasFormat: true, ArgsMapping: []string{"id"}})
	cmd.AddCommand(imageCmd)

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{Use: "list", Short: "全部任务列表", Example: "  tabtin media list", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/media/tasks", HasFormat: true})
	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{Use: "catalog", Short: "模型目录", Example: "  tabtin media catalog", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/media/catalog", HasFormat: true})

	return cmd
}

// ─── Audio ───────────────────────────────────────────────────────

func newCmdAudio(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "audio", Short: "语音识别/合成"}
	defs := []cmdutil.CommandDef{
		{Use: "recognize", Short: "语音识别", Example: "  tabtin audio recognize\n  echo audio_data | tabtin audio recognize", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/speech/recognize", HasFormat: true},
		{Use: "submit <url>", Short: "异步长音频任务", Example: "  tabtin audio submit https://example.com/audio.wav", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/speech/submit", HasFormat: true, ArgsMapping: []string{"audio_url"}},
		{Use: "query <task_id>", Short: "查询任务", Example: "  tabtin audio query task_xxx", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/speech/query", HasFormat: true, ArgsMapping: []string{"task_id"}},
		{Use: "providers", Short: "提供商列表", Example: "  tabtin audio providers", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/speech/providers", HasFormat: true},
		{
			Use: "tts", Short: "文字转语音",
			Example: "  tabtin audio tts --text \"你好世界\"\n  tabtin audio tts --text \"Hello\" --speaker en_female --audio-format mp3",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/speech/tts/synthesize",
			Flags: []cmdutil.FlagDef{
				{Name: "text", Type: cmdutil.FlagString, Required: true, Desc: "要合成的文本"},
				{Name: "speaker", Type: cmdutil.FlagString, Desc: "发音人"},
				{Name: "language", Type: cmdutil.FlagString, Desc: "语言"},
				{Name: "audio-format", Type: cmdutil.FlagString, Desc: "音频输出格式 (mp3/wav)"},
			},
			HasFormat: true,
		},
		{Use: "voices", Short: "可用音色", Example: "  tabtin audio voices", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/speech/tts/voices", HasFormat: true},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	return cmd
}

// ─── Daemon ──────────────────────────────────────────────────────
