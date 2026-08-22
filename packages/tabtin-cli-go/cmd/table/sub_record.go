package table

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// sub-record 命令组：同一张表内的树形结构（父/子记录，自引用 link）。
//
// 典型场景：
//   - 任务 / 子任务、产品 / 子 SKU、部门 / 子部门 等层级数据。
//   - 必须先确保"父字段"（自引用 link 字段）存在，再创建子记录。
//
// 形态对比：
//   - nested_list 字段：子行是主记录的附属 JSON，不能跨主记录复用
//   - 双表 link：两张不同的表互相关联（见 tabtin table link）
//   - sub-record：同一张表内的自引用，父子都是正式记录、可独立查询
//
// HTTP 路由在 cli-server table-crud.ts，6 条命令与 HTTP 一一对应。
func registerSubRecordCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "create", Short: "创建子记录（挂到指定父记录）",
			Long: `在表内创建一条记录，并通过自引用 link 字段挂到指定的父记录。
设计理由：树形数据（任务/子任务等）需要子记录本身也是可独立查询的正式记录，
与 nested_list 字段的附属子行不同；parent-field-id 可省略，用表上默认父字段。
常见陷阱：调用前表上必须已有父字段，没有先用 ensure-parent-field 建一个；
data 的字段值格式与 record insert 完全一致。`,
			Example: "  tabtin table sub-record create --table-id <表 UUID> --parent-record-id <父记录 UUID> --data '{\"名称\":\"子任务1\"}'\n" +
				"  tabtin table sub-record create --table-id <表 UUID> --parent-record-id <父记录 UUID> --data '{\"名称\":\"子任务2\",\"负责人\":\"张三\"}'\n" +
				"  tabtin table sub-record create --table-id <表 UUID> --parent-record-id <父记录 UUID> --data '{...}' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/sub-record-create",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "parent-record-id", Type: cmdutil.FlagString, Required: true, Desc: "父记录 ID"},
				{Name: "parent-field-id", Type: cmdutil.FlagString,
					Desc: "父字段 ID（自引用 link 字段）；省略则用表上默认的父字段"},
				{Name: "data", Type: cmdutil.FlagString,
					Desc: "子记录数据 JSON（字段值格式与 record insert 一致；详见 `record insert --help`）"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("创建子记录，挂到父记录 "+ctx.Str("parent-record-id")).
					Step("POST", "/table/sub-record-create", map[string]any{
						"table_id":         ctx.Str("table-id"),
						"parent_record_id": ctx.Str("parent-record-id"),
						"data":             ctx.Str("data"),
					})
			},
		},
		{
			Use: "move", Short: "移动记录到新父（或升级为根）",
			Long: `改变记录在树中的父节点，用于重新组织层级关系。
设计理由：--new-parent-id 传空字符串或不传，等价于把记录从子树中摘出升为根节点；
移动只改父子关系，不改记录本身的其它字段值。
常见陷阱：移动到的新父不能是该记录自身的子孙节点，否则会形成环，后端会拒绝；
parent-field-id 省略时用表上默认父字段，多父字段场景需显式指定。`,
			Example: "  tabtin table sub-record move --table-id <UUID> --record-id <rec-C UUID> --new-parent-id <rec-A UUID>\n" +
				"  tabtin table sub-record move --table-id <UUID> --record-id <rec-C UUID> --new-parent-id \"\"  # 升根\n" +
				"  tabtin table sub-record move --table-id <UUID> --record-id <rec-C UUID> --new-parent-id <rec-A UUID> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/sub-record-move",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "要移动的记录 ID"},
				{Name: "new-parent-id", Type: cmdutil.FlagString,
					Desc: "新父记录 ID；传空字符串或省略 = 升级为根节点"},
				{Name: "parent-field-id", Type: cmdutil.FlagString,
					Desc: "父字段 ID（自引用 link）；省略则用表上默认父字段"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("移动记录 "+ctx.Str("record-id")+" 到新父 "+ctx.Str("new-parent-id")).
					Step("POST", "/table/sub-record-move", map[string]any{
						"table_id":      ctx.Str("table-id"),
						"record_id":     ctx.Str("record-id"),
						"new_parent_id": ctx.Str("new-parent-id"),
					})
			},
		},
		{
			Use: "parent-field", Short: "查询表上的父字段信息",
			Long: `返回表上被标记为父字段的自引用 link 字段元信息（字段 ID、关系类型等）。
设计理由：sub-record create/move 依赖父字段存在，操作前先查一下当前是哪个字段；
若表没有父字段，返回 null，需先调 ensure-parent-field 建一个。
常见陷阱：一张表理论上可能有多个自引用 link 字段（见 self-link-fields），
本命令只返回被标记为"父字段"的那一个，不是全部候选。`,
			Example: "  tabtin table sub-record parent-field --table-id <UUID>\n" +
				"  tabtin table sub-record parent-field --table-id <UUID> --format json\n" +
				"  tabtin table sub-record parent-field --table-id <UUID> --jq '.field_id'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/parent-field",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "ensure-parent-field", Short: "确保父字段存在（幂等）",
			Long: `表没有父字段时自动创建一个自引用 link（ManyOne，isOneWay=false）；已存在则原样返回。
设计理由：sub-record create/move 依赖父字段，幂等设计让 Agent 可以无脑先调
本命令再建子记录，不需要先判断字段是否存在。
常见陷阱：自动创建的字段名和位置由后端决定，不可自定义；已有多个自引用
link 字段时，本命令不会新建第二个"父字段"，只认第一次创建的那个。`,
			Example: "  tabtin table sub-record ensure-parent-field --table-id <UUID>\n" +
				"  tabtin table sub-record ensure-parent-field --table-id <UUID> --format json\n" +
				"  tabtin table sub-record ensure-parent-field --table-id <UUID> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/ensure-parent-field",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("确保父字段存在（幂等）table-id="+ctx.Str("table-id")).
					Step("POST", "/table/ensure-parent-field", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "self-link-fields", Short: "列出所有可用作父字段的自引用 link 字段",
			Long: `返回表内全部自引用 link 字段（指向自身的 link），供在多个候选中选一个。
设计理由：ensure-parent-field 会自动挑一个当父字段，但表上可能已有多个
自引用字段，本命令让 Agent/用户在建父字段前先看清楚候选集。
常见陷阱：返回列表不代表这些字段已被标记为"父字段"——真正的父字段用
parent-field 查询，本命令只是列候选。`,
			Example: "  tabtin table sub-record self-link-fields --table-id <UUID>\n" +
				"  tabtin table sub-record self-link-fields --table-id <UUID> --format json\n" +
				"  tabtin table sub-record self-link-fields --table-id <UUID> --jq '.[].name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/self-link-fields",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "reorder-tree", Short: "树形拖拽批量原子提交",
			Long: `把若干记录的 parent / order 变更打包成一个事务提交，主要服务前端树视图拖拽。
设计理由：树形结构的多节点移动/排序如果逐条调 move 容易中途失败留下不一致状态，
本命令把整批变更包进单个事务，全成功或全回滚。
常见陷阱：Agent 通常不需要直接调本命令（move 单条移动已够用），批量编排脚本
才用得上；operations 里每项至少要有 record_id，缺失字段用原值。`,
			Example: "  tabtin table sub-record reorder-tree --table-id <UUID> --operations '[{\"record_id\":\"r1\",\"new_parent_id\":\"r0\",\"new_order\":1}]'\n" +
				"  tabtin table sub-record reorder-tree --table-id <UUID> --operations '[{\"record_id\":\"r1\",\"new_order\":2}]'\n" +
				"  tabtin table sub-record reorder-tree --table-id <UUID> --operations '[...]' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/reorder-tree",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "operations", Type: cmdutil.FlagString, Required: true,
					Desc: "操作列表 JSON 数组；每项至少含 record_id，可选 new_parent_id / new_order"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("树形拖拽批量原子提交 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/reorder-tree", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"operations": ctx.Str("operations"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}
