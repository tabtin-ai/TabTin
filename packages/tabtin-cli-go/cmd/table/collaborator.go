package table

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func registerCollaboratorCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "列出表协作者（含 owner）",
			Long: `返回表上全部协作者及其权限级别，包含 owner。
设计理由：invite/update/remove 前先 list 确认当前协作者集，避免重复邀请
或误删还需要权限的人。
常见陷阱：owner 通常不能被 remove/降级，具体约束以后端返回错误为准；
list 不区分协作者来自哪个 Organization，只反映表级权限关系。`,
			Example: "  tabtin table collaborator list --table-id <table_id>\n" +
				"  tabtin table collaborator list --table-id <table_id> --format json\n" +
				"  tabtin table collaborator list --table-id <table_id> --jq '.[].permission'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/collaborator-list",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "invite", Short: "邀请协作者（批量）",
			Long: `批量邀请用户成为表协作者，赋予统一的权限级别。
设计理由：批量传 user-ids 数组一次邀请多人，比逐个调用更适合团队协作场景；
所有被邀请者拿到相同 permission，需要不同权限请分批调用或事后用 update 调整。
常见陷阱：user-ids 必须是平台已有用户 ID，不接受邮箱/手机号；已是协作者的
用户再次邀请行为以后端实现为准（可能报错或幂等更新）。`,
			Example: "  tabtin table collaborator invite --table-id <table_id> --user-ids '[\"u_1\",\"u_2\"]' --permission viewer\n" +
				"  tabtin table collaborator invite --table-id <table_id> --user-ids '[\"u_3\"]' --permission editor\n" +
				"  tabtin table collaborator invite --table-id <table_id> --user-ids '[\"u_1\"]' --permission viewer --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/collaborator-invite",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "user-ids", Type: cmdutil.FlagString, Required: true, Desc: "用户 ID JSON 数组"},
				{Name: "permission", Type: cmdutil.FlagString, Required: true, Desc: "权限级别（viewer/editor/...）"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("邀请协作者 permission="+ctx.Str("permission")).
					Step("POST", "/table/collaborator-invite", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"user_ids":   ctx.Str("user-ids"),
						"permission": ctx.Str("permission"),
					})
			},
		},
		{
			Use: "update", Short: "更新协作者权限",
			Long: `修改单个协作者在该表上的权限级别（如 viewer 升级为 editor）。
设计理由：与 invite 分工——invite 是新增，本命令是对已有协作者调整权限，
一次只改一人，避免批量误改。
常见陷阱：user-id 必须已是该表协作者，非协作者调用会报错；owner 的权限
一般不能通过本命令降级，需走转移 owner 的专门流程（如有）。`,
			Example: "  tabtin table collaborator update --table-id <table_id> --user-id u_1 --permission editor\n" +
				"  tabtin table collaborator update --table-id <table_id> --user-id u_2 --permission viewer\n" +
				"  tabtin table collaborator update --table-id <table_id> --user-id u_1 --permission editor --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/collaborator-update",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "user-id", Type: cmdutil.FlagString, Required: true, Desc: "目标用户 ID"},
				{Name: "permission", Type: cmdutil.FlagString, Required: true, Desc: "新权限级别"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新协作者权限 user-id="+ctx.Str("user-id")).
					Step("POST", "/table/collaborator-update", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"user_id":    ctx.Str("user-id"),
						"permission": ctx.Str("permission"),
					})
			},
		},
		{
			Use: "remove", Short: "移除协作者（不可撤销）",
			Long: `将某用户从表协作者列表中移除，其访问该表的权限立即失效。
设计理由：与 update 分工明确——降权用 update，完全移除用 remove；移除后
若要恢复需要重新 invite，不是简单的"撤销"。
常见陷阱：owner 一般不能被移除；移除后该用户此前创建的记录/评论等历史
数据不受影响，只是失去当前访问权限。`,
			Example: "  tabtin table collaborator remove --table-id <table_id> --user-id u_1 --yes\n" +
				"  tabtin table collaborator remove --table-id <table_id> --user-id u_1 --dry-run\n" +
				"  tabtin table collaborator list --table-id <table_id>  # 移除前先确认协作者列表",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/collaborator-remove",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "user-id", Type: cmdutil.FlagString, Required: true, Desc: "目标用户 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("移除协作者（不可撤销）user-id="+ctx.Str("user-id")).
					Step("POST", "/table/collaborator-remove", map[string]any{
						"table_id": ctx.Str("table-id"),
						"user_id":  ctx.Str("user-id"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}
