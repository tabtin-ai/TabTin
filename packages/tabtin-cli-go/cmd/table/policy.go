package table

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func registerPolicyCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "列出行级安全策略（RLS）",
			Long: `列出表上配置的全部行级安全（RLS）策略。
设计理由：改策略前先 list 确认现有策略集，避免重复建同类条件；策略按
PERMISSIVE(OR)/RESTRICTIVE(AND) 组合生效，多条策略共存时顺序不影响结果但语义要清楚。
常见陷阱：list 不反映 RLS 总开关状态——总开关用 rls-toggle 单独查/改。`,
			Example: "  tabtin table policy list --table-id <table_id>\n" +
				"  tabtin table policy list --table-id <table_id> --format json\n" +
				"  tabtin table policy list --table-id <table_id> --jq '.policies[].name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/policy-list",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "create", Short: "创建 RLS 策略",
			Long: `新建一条行级安全策略，condition 用 Filter DSL 表达"哪些行可见/可写"。
设计理由：支持 $token.user_id / $current_user_id 运行时变量，实现"仅本人数据"
之类的按用户隔离；apply-to-tokens/apply-to-jwt 分别控制 API Token 和登录用户是否受约束。
常见陷阱：默认只对 API Token 生效（apply-to-jwt=false）——只想约束脚本调用、
不想影响界面操作时保持默认；要同时约束界面登录用户需显式 --apply-to-jwt=true。`,
			Example: "  tabtin table policy create --table-id <table_id> --name only-mine --condition '{\"$current_user_id\": {\"$eq\": \"owner_id\"}}'\n" +
				"  tabtin table policy create --table-id <table_id> --name read-only --operation SELECT --policy-type PERMISSIVE --condition '{...}'\n" +
				"  tabtin table policy create --table-id <table_id> --name test --condition '{...}' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/policy-create",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "策略名称"},
				{Name: "condition", Type: cmdutil.FlagString, Required: true, Desc: "策略条件 JSON（Filter DSL）"},
				{Name: "operation", Type: cmdutil.FlagString, Default: "ALL", Desc: "SELECT/INSERT/UPDATE/DELETE/ALL", Enum: []string{"SELECT", "INSERT", "UPDATE", "DELETE", "ALL"}},
				{Name: "policy-type", Type: cmdutil.FlagString, Default: "PERMISSIVE", Desc: "PERMISSIVE(OR) / RESTRICTIVE(AND)", Enum: []string{"PERMISSIVE", "RESTRICTIVE"}},
				{Name: "apply-to-tokens", Type: cmdutil.FlagBool, Default: true, Desc: "API Token 访问时生效"},
				{Name: "apply-to-jwt", Type: cmdutil.FlagBool, Default: false, Desc: "JWT 用户访问时生效"},
				{Name: "is-active", Type: cmdutil.FlagBool, Default: true, Desc: "是否启用"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("创建 RLS 策略 "+ctx.Str("name")).
					Step("POST", "/table/policy-create", map[string]any{
						"table_id":  ctx.Str("table-id"),
						"name":      ctx.Str("name"),
						"condition": ctx.Str("condition"),
						"operation": ctx.Str("operation"),
					})
			},
		},
		{
			Use: "update", Short: "更新 RLS 策略",
			Long: `增量更新已有 RLS 策略的名称/条件/操作类型/启用状态等字段。
设计理由：策略调整通常是收紧或放宽某个条件，而非整条重建；只传要改的字段，
未传字段保持原值。
常见陷阱：--policy-id 必须是已存在策略；改 condition 时格式仍是 Filter DSL，
建议先 policy list 读现有 condition 再增量改，避免破坏运行时变量语法。`,
			Example: "  tabtin table policy update --table-id <table_id> --policy-id <pid> --is-active false\n" +
				"  tabtin table policy update --table-id <table_id> --policy-id <pid> --name renamed\n" +
				"  tabtin table policy update --table-id <table_id> --policy-id <pid> --is-active false --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/policy-update",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "policy-id", Type: cmdutil.FlagString, Required: true, Desc: "策略 ID"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "新名称"},
				{Name: "condition", Type: cmdutil.FlagString, Desc: "新条件 JSON"},
				{Name: "operation", Type: cmdutil.FlagString, Desc: "新操作类型", Enum: []string{"SELECT", "INSERT", "UPDATE", "DELETE", "ALL"}},
				{Name: "policy-type", Type: cmdutil.FlagString, Desc: "新策略类型", Enum: []string{"PERMISSIVE", "RESTRICTIVE"}},
				{Name: "apply-to-tokens", Type: cmdutil.FlagBool, Desc: "API Token 访问时生效"},
				{Name: "apply-to-jwt", Type: cmdutil.FlagBool, Desc: "JWT 用户访问时生效"},
				{Name: "is-active", Type: cmdutil.FlagBool, Desc: "是否启用"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新 RLS 策略 policy-id="+ctx.Str("policy-id")).
					Step("POST", "/table/policy-update", map[string]any{
						"table_id":  ctx.Str("table-id"),
						"policy_id": ctx.Str("policy-id"),
					})
			},
		},
		{
			Use: "delete", Short: "删除 RLS 策略（不可恢复）",
			Long: `永久删除一条行级安全策略——删除后该策略的约束条件立即失效。
设计理由：与其它策略正交，删除单条不影响同表其它策略；删除是唯一移除方式，
没有软删/回收站，需要谨慎。
常见陷阱：删除后如果该表没有其它策略且 RLS 总开关仍开着，行为等价于无策略
放行全部（视后端具体实现），删前先确认业务是否依赖该策略兜底。`,
			Example: "  tabtin table policy delete --table-id <table_id> --policy-id <pid> --yes\n" +
				"  tabtin table policy delete --table-id <table_id> --policy-id <pid> --dry-run\n" +
				"  tabtin table policy list --table-id <table_id>  # 删前先确认还有哪些策略",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/policy-delete",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "policy-id", Type: cmdutil.FlagString, Required: true, Desc: "策略 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("删除 RLS 策略（不可恢复）policy-id="+ctx.Str("policy-id")).
					Step("POST", "/table/policy-delete", map[string]any{
						"table_id":  ctx.Str("table-id"),
						"policy_id": ctx.Str("policy-id"),
					})
			},
		},
		{
			Use: "rls-toggle", Short: "启用/关闭表的 RLS 总开关",
			Long: `控制表级行级安全的总开关，与单条策略的 is-active 是两个维度。
设计理由：总开关关闭时全部策略不生效（即使单条策略 is-active=true）；
rls-force 决定是否对登录用户（JWT）也强制生效，默认只管 API Token。
常见陷阱：关闭总开关不会删除已配置的策略，重新打开后策略立即恢复生效；
--rls-force=true 影响面更大，会改变界面里登录用户看到的数据范围，务必确认。`,
			Example: "  tabtin table policy rls-toggle --table-id <table_id> --rls-enabled true\n" +
				"  tabtin table policy rls-toggle --table-id <table_id> --rls-enabled true --rls-force\n" +
				"  tabtin table policy rls-toggle --table-id <table_id> --rls-enabled false --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/policy-rls-toggle",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "rls-enabled", Type: cmdutil.FlagBool, Required: true, Desc: "是否启用行级安全"},
				{Name: "rls-force", Type: cmdutil.FlagBool, Default: false, Desc: "是否对 JWT 用户也强制生效"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("切换 RLS 总开关 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/policy-rls-toggle", map[string]any{
						"table_id":    ctx.Str("table-id"),
						"rls_enabled": ctx.Bool("rls-enabled"),
						"rls_force":   ctx.Bool("rls-force"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}
