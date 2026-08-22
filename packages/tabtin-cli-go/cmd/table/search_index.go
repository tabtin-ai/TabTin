package table

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func registerSearchIndexCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "status", Short: "查询表的全文索引状态",
			Long: `返回表的全文索引是否启用、索引进度、最近更新时间等状态信息。
设计理由：table search 依赖索引已建好；本命令是排查"search 无结果"的第一步——
先确认索引本身是否启用/健康，再看查询关键词或字段是否正确。
常见陷阱：索引状态是异步维护的，刚写入记录后索引可能有短暂延迟，不代表 toggle 未生效。`,
			Example: "  tabtin table search-index status --table-id <table_id>\n" +
				"  tabtin table search-index status --table-id <table_id> --format json\n" +
				"  tabtin table search-index status --table-id <table_id> --jq '.enabled'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/search-index-status",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "toggle", Short: "启用/禁用表的全文索引",
			Long: `开关表的全文索引功能；关闭后 table search 会失效或返回空结果。
设计理由：全文索引有存储和维护开销，小表或不需要搜索的表可以关闭省资源；
重新开启后索引会重建，期间 search 结果可能不完整。
常见陷阱：关闭索引不会删除表数据，只影响 search-index / search 相关命令；
重新启用后建议配合 status 确认索引重建完成再依赖搜索结果。`,
			Example: "  tabtin table search-index toggle --table-id <table_id> --enabled true\n" +
				"  tabtin table search-index toggle --table-id <table_id> --enabled false\n" +
				"  tabtin table search-index toggle --table-id <table_id> --enabled true --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/search-index-toggle",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "enabled", Type: cmdutil.FlagBool, Required: true, Desc: "是否启用"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("切换全文索引开关 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/search-index-toggle", map[string]any{
						"table_id": ctx.Str("table-id"),
						"enabled":  ctx.Bool("enabled"),
					})
			},
		},
		{
			Use: "repair", Short: "重建/修复表的全文索引",
			Long: `强制重建当前表的全文索引，常用于排查搜索结果异常或索引漂移。
设计理由：数据大量写入/删除后索引可能与实际数据不同步；本命令是"重来一遍"
的兜底手段，不需要先关再开 toggle。
常见陷阱：大表重建耗时较长，重建期间 search 结果可能不完整；重建不会
改变索引的启用状态（enabled 保持不变），只是重新生成索引内容。`,
			Example: "  tabtin table search-index repair --table-id <table_id>\n" +
				"  tabtin table search-index repair --table-id <table_id> --format json\n" +
				"  tabtin table search-index repair --table-id <table_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/search-index-repair",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("重建全文索引 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/search-index-repair", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "query", Short: "直接查询全文索引（绕过普通 search）",
			Long: `直接命中索引层做查询，跳过业务层的 table search 封装，用于排障对比。
设计理由：当 table search 结果看起来不对时，用本命令直接查索引层，
判断问题出在索引本身还是业务层的过滤/排序逻辑。
常见陷阱：普通业务搜索请用 tabtin table search，不要在正常业务流程里
依赖本命令——字段/排序等业务语义在这里可能与 search 不完全一致。`,
			Example: "  tabtin table search-index query --table-id <table_id> --query \"关键词\"\n" +
				"  tabtin table search-index query --table-id <table_id> --query \"关键词\" --page-size 20\n" +
				"  tabtin table search-index query --table-id <table_id> --query \"关键词\" --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/search-index-query",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "query", Type: cmdutil.FlagString, Required: true, Desc: "查询字符串"},
				{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页大小"},
			},
			HasFormat: true, RequiresAgent: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}
