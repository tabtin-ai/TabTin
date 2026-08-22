package cmd

import (
	"net/url"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// ─── Skill ───────────────────────────────────────────────────────

func newCmdSkill(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "skill", Short: "Skill 市场与管理"}
	defs := []cmdutil.CommandDef{
		{Use: "list", Short: "已安装 Skill（注册表）", Example: "  tabtin skill list\n  tabtin skill list --category data --include-disabled", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/skills/registry",
			Flags: []cmdutil.FlagDef{
				{Name: "include-disabled", Type: cmdutil.FlagBool, Desc: "包含已禁用的 Skill"},
				{Name: "category", Short: "c", Type: cmdutil.FlagString, Desc: "按分类过滤"},
			}, HasFormat: true},
		{Use: "market", Short: "Skill 市场", Example: "  tabtin skill market", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/skills/market", HasFormat: true},
		// Wave 1：managed 端点已下线；改指 visible（当前 Space 可见技能，含启用态）。
		{Use: "managed", Short: "当前 Space 可见 Skill（原托管列表，已对齐 Wave 1 visible）", Example: "  tabtin skill managed", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/skills/visible", HasFormat: true},
		{Use: "search <query>", Short: "搜索 Skill", Example: "  tabtin skill search data-analysis", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/skills/market",
			ArgsMapping: []string{"q"}, HasFormat: true},
		// Wave 1：安装 = enable + 设备端物化。install 是 enable 的别名。
		// ：npm:<pkg> 走 /skills/install-npm（npx skills add → ~/.agents/skills）。
		{Use: "install [key]", Short: "安装并启用 Skill；npm:<pkg> / --from-npm 则装到本机 ~/.agents/skills", Example: "  tabtin skill install user:web-search\n  tabtin skill install app:tabtin-office-skills-pack/meeting-notes-to-actions\n  tabtin skill install npm:@scope/foo\n  tabtin skill install --from-npm @scope/foo --import-to-space", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/skills/{skill_key}/enable",
			ArgsMapping: []string{"skill_key"},
			Flags: []cmdutil.FlagDef{
				{Name: "import-to-space", Type: cmdutil.FlagBool, Desc: "仅 npm: 安装：装完后导入到当前 Space（变成「我的」）"},
				{Name: "from-npm", Type: cmdutil.FlagString, Desc: "从 npm 包安装到 ~/.agents/skills（等价于 npm:<pkg>）"},
			},
			HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
			Validate: validateSkillInstall,
			RunFunc:  skillInstallFunc(f)},
		// ：本地路径 / zip / HTTPS → POST /skills/import
		{Use: "import <source>", Short: "从本地目录/SKILL.md/zip 或 HTTPS URL 导入到当前 Space", Example: "  tabtin skill import ./my-skill\n  tabtin skill import ./pack.zip\n  tabtin skill import https://example.com/skill.zip\n  tabtin skill import ./my-skill --no-enable", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/skills/import",
			ArgsMapping: []string{"source"},
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Desc: "导入后的展示名（默认取目录名）"},
				{Name: "no-enable", Type: cmdutil.FlagBool, Desc: "只导入不启用"},
			},
			HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
			Validate: validateSkillImport,
			RunFunc:  skillImportFunc(f)},
		// 卸载 = disable + remove=true（删 enablement 行；设备端清理本地文件）。
		{Use: "remove <key>", Short: "卸载 Skill（Wave 1：disable + remove）", Example: "  tabtin skill remove user:web-search", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/skills/{skill_key}/disable",
			ArgsMapping: []string{"skill_key"}, FixedFields: map[string]any{"remove": true}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
		{Use: "update <key>", Short: "更新 Skill 到最新已发布版本", Example: "  tabtin skill update user:web-search", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/skills/{skill_key}/enable",
			ArgsMapping: []string{"skill_key"}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
		{Use: "info <key>", Short: "Skill 包元数据", Example: "  tabtin skill info user:web-search", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/skills/{skill_key}/package",
			ArgsMapping: []string{"skill_key"}, HasFormat: true},
		{Use: "enable <key>", Short: "启用 Skill", Example: "  tabtin skill enable user:web-search\n  tabtin skill enable app:tabtin-office-skills-pack/meeting-notes-to-actions", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/skills/{skill_key}/enable",
			ArgsMapping: []string{"skill_key"}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
		{Use: "disable <key>", Short: "禁用 Skill（保留安装记录）", Example: "  tabtin skill disable user:web-search", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/skills/{skill_key}/disable",
			ArgsMapping: []string{"skill_key"}, HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	return cmd
}

func skillInstallKey(ctx *cmdutil.RunContext) string {
	if len(ctx.Args) > 0 {
		return strings.TrimSpace(ctx.Args[0])
	}
	return strings.TrimSpace(ctx.Str("skill-key"))
}

func resolveNpmPackage(ctx *cmdutil.RunContext) string {
	if from := strings.TrimSpace(ctx.Str("from-npm")); from != "" {
		return strings.TrimPrefix(from, "npm:")
	}
	key := skillInstallKey(ctx)
	if strings.HasPrefix(strings.ToLower(key), "npm:") {
		return strings.TrimSpace(key[4:])
	}
	return ""
}

func validateSkillInstall(ctx *cmdutil.RunContext) error {
	npmPkg := resolveNpmPackage(ctx)
	key := skillInstallKey(ctx)
	if npmPkg == "" && key == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"请提供 Skill canonical key，或 npm:<pkg> / --from-npm <pkg>",
			"用法: tabtin skill install user:web-search | tabtin skill install npm:@scope/foo",
			output.ExitValidation,
		))
	}
	if npmPkg != "" && ctx.Bool("import-to-space") && ctx.SpaceID == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"--import-to-space 需要当前 Space 上下文（--space-id 或 Agent 会话）",
			"tabtin skill install npm:@scope/foo --import-to-space --space-id <id>",
			output.ExitValidation,
		))
	}
	return nil
}

func skillInstallFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		tr, err := requireCliServerTransport(f, "skill install")
		if err != nil {
			return err
		}

		if npmPkg := resolveNpmPackage(ctx); npmPkg != "" {
			body := map[string]any{
				"package": npmPkg,
			}
			if ctx.SpaceID != "" {
				body["space_id"] = ctx.SpaceID
			}
			if ctx.OrganizationID != "" {
				body["organization_id"] = ctx.OrganizationID
			}
			if ctx.Bool("import-to-space") {
				body["import_to_space"] = true
			}
			opts := &transport.RequestOptions{Timeout: 3 * time.Minute}
			resp, reqErr := tr.Request(ctx.ReqContext, "POST", "/skills/install-npm", body, opts)
			if reqErr != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope("NETWORK_ERROR", reqErr.Error(), "", output.ExitNetwork))
			}
			return printTransportResponse(resp, f.Format)
		}

		key := skillInstallKey(ctx)
		body := map[string]any{}
		if ctx.SpaceID != "" {
			body["space_id"] = ctx.SpaceID
		}
		if ctx.OrganizationID != "" {
			body["organization_id"] = ctx.OrganizationID
		}
		path := "/skills/" + url.PathEscape(key) + "/enable"
		resp, reqErr := tr.Request(ctx.ReqContext, "POST", path, body, nil)
		if reqErr != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope("NETWORK_ERROR", reqErr.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

func validateSkillImport(ctx *cmdutil.RunContext) error {
	source := ""
	if len(ctx.Args) > 0 {
		source = strings.TrimSpace(ctx.Args[0])
	}
	if source == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"请提供本地路径、zip 或 HTTPS URL",
			"用法: tabtin skill import ./my-skill | tabtin skill import https://example.com/skill.zip",
			output.ExitValidation,
		))
	}
	if ctx.SpaceID == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"导入需要当前 Space 上下文（--space-id 或 Agent 会话）",
			"tabtin skill import ./my-skill --space-id <id>",
			output.ExitValidation,
		))
	}
	lower := strings.ToLower(source)
	if strings.HasPrefix(lower, "http://") {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"仅支持 HTTPS URL（不允许 http://）",
			"请改用 https:// 链接",
			output.ExitValidation,
		))
	}
	return nil
}

func skillImportFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		tr, err := requireCliServerTransport(f, "skill import")
		if err != nil {
			return err
		}
		source := strings.TrimSpace(ctx.Args[0])
		body := map[string]any{
			"space_id": ctx.SpaceID,
			"enable":   !ctx.Bool("no-enable"),
		}
		if ctx.OrganizationID != "" {
			body["organization_id"] = ctx.OrganizationID
		}
		if name := strings.TrimSpace(ctx.Str("name")); name != "" {
			body["name"] = name
		}
		if strings.HasPrefix(strings.ToLower(source), "https://") {
			body["url"] = source
		} else {
			body["path"] = source
		}
		opts := &transport.RequestOptions{Timeout: 3 * time.Minute}
		resp, reqErr := tr.Request(ctx.ReqContext, "POST", "/skills/import", body, opts)
		if reqErr != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope("NETWORK_ERROR", reqErr.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

// ─── Capabilities ────────────────────────────────────────────────

func newCmdCapabilities(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "capabilities", Short: "能力发现"}
	defs := []cmdutil.CommandDef{
		{Use: "list", Short: "所有可用工具", Example: "  tabtin capabilities list", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/capabilities/tools", HasFormat: true},
		{Use: "show <name>", Short: "工具详情", Example: "  tabtin capabilities show code_read", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/capabilities/tools/{name}", HasFormat: true, ArgsMapping: []string{"name"}},
		{Use: "categories", Short: "分类", Example: "  tabtin capabilities categories", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/capabilities/categories", HasFormat: true},
		{Use: "providers", Short: "提供者", Example: "  tabtin capabilities providers", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/capabilities/providers", HasFormat: true},
		{Use: "discover <query>", Short: "语义发现：按自然语言描述找能做某件事的工具 / 能力", Example: "  tabtin capabilities discover \"how to read files\"", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/capabilities/discover", HasFormat: true, ArgsMapping: []string{"query"}},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	return cmd
}

// ─── Task ────────────────────────────────────────────────────────

func newCmdTask(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "task", Short: "异步任务管理"}
	defs := []cmdutil.CommandDef{
		{Use: "list", Short: "任务列表", Example: "  tabtin task list", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/media/tasks", HasFormat: true},
		{Use: "status <id>", Short: "任务状态", Example: "  tabtin task status task_xxx", Route: cmdutil.RouteCliServer, Method: "GET", Path: "/media/tasks/{id}", HasFormat: true, ArgsMapping: []string{"id"}},
		{Use: "cancel <id>", Short: "取消任务", Example: "  tabtin task cancel task_xxx", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/media/tasks/{id}/cancel", Risk: cmdutil.RiskWrite, RiskDeclared: true, HasFormat: true, ArgsMapping: []string{"id"}},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	return cmd
}

// ─── Device ──────────────────────────────────────────────────────

func newCmdDevice(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{Use: "device", Short: "设备管理"}
	defs := []cmdutil.CommandDef{
		{Use: "info", Short: "设备信息（手机 / 电脑的电量、网络等状态）", Example: "  tabtin device info", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/device/info", HasFormat: true},
		{Use: "battery", Short: "电池状态", Example: "  tabtin device battery", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/device/battery", HasFormat: true},
		{Use: "network", Short: "网络状态", Example: "  tabtin device network", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/device/network", HasFormat: true},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}
	return cmd
}

// ─── Space (backward compat with Node CLI) ───────────────────────
