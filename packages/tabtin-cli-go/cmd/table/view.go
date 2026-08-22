package table

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func registerViewCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "视图列表",
			Long: `列出表格下的全部视图（grid/kanban/calendar/gallery/list/flashcard/form）。
设计理由：视图承载筛选/排序/分组/可见字段等展示配置，先 list 确认 view-id 和
view-type 再操作 view records / view update，避免误改错视图。
常见陷阱：不同 view-type 支持的 config 字段不同（如 kanban 需要分组字段），
--view-type 过滤只是缩小列表范围，不改变已有视图的类型。`,
			Example: "  tabtin table view list --table-id <table_id>\n" +
				"  tabtin table view list --table-id <table_id> --view-type kanban\n" +
				"  tabtin table view list --table-id <table_id> --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/views",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "view-type", Type: cmdutil.FlagString, Desc: "按类型筛选 (grid/kanban/calendar/gallery/list/flashcard/form)"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "detail", Short: "视图详情",
			Long: `取单个视图的完整配置——筛选条件、排序、分组、可见字段、config。
设计理由：view list 只给概览字段，filters/sorts/groups 等结构化配置需要 detail
才能拿全，是 view update 增量修改前的必要读取步骤。
常见陷阱：filters/sorts 的 JSON 结构随字段类型变化（如 select 字段的
operator 集合和 text 不同），改前先读一遍现有结构再改，别凭空拼。`,
			Example: "  tabtin table view detail --view-id <view_id>\n" +
				"  tabtin table view detail --view-id <view_id> --format json\n" +
				"  tabtin table view detail --view-id <view_id> --jq '.filters'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/view-detail",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "视图 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "create", Short: "创建视图",
			Long: `在表格下新建一个视图，可选带初始筛选/排序/分组/可见字段/config。
设计理由：视图是独立于表格数据的展示配置对象，创建后不影响已有记录；
--view-type 决定后续 config 的可选字段。看板（kanban）必须指定分组字段，
否则界面只有空壳、不会按列分卡——优先用 --group-by-field-id；复杂多级分组再用 --groups。
常见陷阱：不传 --filters/--sorts 时新视图默认无筛选、按创建顺序展示；
只传 --view-type kanban 而不传分组，创建会成功但看板不可用——先 field list
取单选字段 ID，再带 --group-by-field-id 创建，最后用 view detail 确认 group_by_field。
Windows：结构化 JSON 请先写 UTF-8 无 BOM 文件，再用带引号的 @file（如 --groups '@groups.json'），
不要依赖 PowerShell 内联 JSON 引号；PowerShell 5.x 勿用 Set-Content -Encoding utf8（会写 BOM）。`,
			Example: "  tabtin table view create --table-id xxx --name \"跟进看板\" --view-type kanban --group-by-field-id <select_field_id>\n" +
				"  # 复杂分组（Windows 安全写法，无 BOM）：\n" +
				"  #   python -c \"import json; json.dump([{'field_id':'<id>','direction':'asc'}], open('groups.json','w',encoding='utf-8'))\"\n" +
				"  #   tabtin table view create --table-id xxx --name \"跟进看板\" --view-type kanban --groups '@groups.json'\n" +
				"  tabtin table view create --table-id xxx --name \"本月订单\" --view-type grid --filters '[{\"field\":\"日期\",\"operator\":\"gte\",\"value\":\"2026-07-01\"}]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/create-view",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "视图名称"},
				{Name: "view-type", Type: cmdutil.FlagString, Default: "grid", Desc: "视图类型 (grid/kanban/calendar/gallery/list/flashcard/form)"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "描述"},
				{Name: "filters", Type: cmdutil.FlagString, Desc: "筛选条件 JSON"},
				{Name: "sorts", Type: cmdutil.FlagString, Desc: "排序规则 JSON"},
				{Name: "group-by-field-id", Type: cmdutil.FlagString, CliOnly: true,
					Desc: "看板一等分组字段 ID（自动生成标准 groups；与 --groups 互斥）"},
				{Name: "groups", Type: cmdutil.FlagString, Desc: "分组规则 JSON（复杂分组逃生口；看板也可用 --group-by-field-id）"},
				{Name: "visible-fields", Type: cmdutil.FlagString, Desc: "可见字段 JSON"},
				{Name: "config", Type: cmdutil.FlagString, Desc: "视图配置 JSON（看板可用 {\"group_by_field\":\"<id>\"}）"},
			},
			Conflicts: map[string][]string{
				"group-by-field-id": {"groups"},
				"groups":            {"group-by-field-id"},
			},
			HasFormat: true, RequiresAgent: true,
			Validate: validateViewCreateGroupBy,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				// dry-run 跳过命令级 Validate；此处先展开 --group-by-field-id，保证 plan 含真实 groups。
				_ = validateViewCreateGroupBy(ctx)
				return cmdutil.NewDryRunPlan().
					Desc("创建视图 "+ctx.Str("name")+"（类型："+ctx.Str("view-type")+"）").
					Step("POST", "/table/create-view", map[string]any{
						"table_id":  ctx.Str("table-id"),
						"name":      ctx.Str("name"),
						"view_type": ctx.Str("view-type"),
						"filters":   ctx.Str("filters"),
						"groups":    ctx.FlagValues["groups"],
					})
			},
		},
		{
			Use: "update", Short: "更新视图",
			Long: `增量更新视图的名称/描述/筛选/排序/分组/可见字段/共享与锁定状态。
设计理由：只传要改的字段即可，未传字段保持原值；--is-locked 锁定后其它协作者
在 UI 上不能改视图配置（CLI 调用不受此限制）。
常见陷阱：--filters/--sorts/--groups 都是整体覆盖而非增量合并——想加一条筛选
条件，需要先 view detail 取出现有 filters 再拼接新条件一起传。`,
			Example: "  tabtin table view update --view-id <view_id> --name \"新视图名\"\n" +
				"  tabtin table view update --view-id <view_id> --groups '[{\"field_id\":\"<select_field_id>\",\"direction\":\"asc\"}]'\n" +
				"  tabtin table view update --view-id <view_id> --filters '[{\"field\":\"status\",\"operator\":\"equals\",\"value\":\"open\"}]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/update-view",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "视图 ID"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "名称"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "描述"},
				{Name: "filters", Type: cmdutil.FlagString, Desc: "筛选条件 JSON"},
				{Name: "sorts", Type: cmdutil.FlagString, Desc: "排序规则 JSON"},
				{Name: "groups", Type: cmdutil.FlagString, Desc: "分组规则 JSON"},
				{Name: "visible-fields", Type: cmdutil.FlagString, Desc: "可见字段 JSON"},
				{Name: "config", Type: cmdutil.FlagString, Desc: "视图配置 JSON"},
				{Name: "is-shared", Type: cmdutil.FlagBool, Desc: "是否共享"},
				{Name: "is-locked", Type: cmdutil.FlagBool, Desc: "是否锁定"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新视图配置（整体覆盖 filters/sorts/groups，非增量合并）").
					Step("POST", "/table/update-view", map[string]any{
						"view_id": ctx.Str("view-id"),
						"name":    ctx.Str("name"),
						"filters": ctx.Str("filters"),
					})
			},
		},
		{
			Use: "delete", Short: "删除视图（不可恢复）",
			Long: `硬删除一个视图配置——没有回收站层，仅删配置，不影响表格记录本身。
设计理由：视图是纯展示层对象，删除不会丢数据，但会丢失已保存的筛选/排序/
分组配置和分享链接（表单视图的 share_id 会一并失效）。
常见陷阱：删除表单视图（view_type=form）会连带使已发出的分享链接失效——
删前确认没有依赖该分享链接的下游流程（如自动化表单收集）。`,
			Example: "  tabtin table view delete --view-id <view_id> --yes\n" +
				"  tabtin table view delete --view-id <view_id> --dry-run\n" +
				"  tabtin table view detail --view-id <view_id>  # 删前先确认没有依赖的分享链接",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/delete-view",
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "视图 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("永久删除视图配置（不影响表格记录，不可恢复）").
					Step("POST", "/table/delete-view", map[string]any{
						"view_id": ctx.Str("view-id"),
					})
			},
		},
		{
			Use: "records", Short: "视图内记录",
			Long: `按视图已保存的筛选/排序读取记录，也可用 --filters/--sorts 做临时覆盖（不落库）。
设计理由：与 record list（忽略视图配置的全表分页）不同，本命令复用视图已保存
的筛选/排序逻辑，是 UI「打开某视图看到的数据」的 CLI 等价物。
常见陷阱：临时传的 --filters/--sorts 只影响本次查询，不会写回视图配置；
想固化下来要用 view update。`,
			Example: "  tabtin table view records --view-id <view_id>\n" +
				"  tabtin table view records --view-id <view_id> --page-size 20 --search \"关键词\"\n" +
				"  tabtin table view records --view-id <view_id> --filters '[{\"field\":\"status\",\"operator\":\"equals\",\"value\":\"open\"}]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/view-records",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "视图 ID"},
				{Name: "page", Type: cmdutil.FlagInt, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Desc: "每页大小"},
				{Name: "search", Type: cmdutil.FlagString, Desc: "搜索"},
				{Name: "fields", Type: cmdutil.FlagString, Desc: "返回字段"},
				{Name: "filters", Type: cmdutil.FlagString, Desc: "临时筛选 JSON"},
				{Name: "sorts", Type: cmdutil.FlagString, Desc: "临时排序 JSON"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "set-default", Short: "设为默认视图",
			Long: `把指定视图设为该表格打开时的默认展示视图。
设计理由：默认视图只是一个指针字段（table.default_view_id），切换不影响
任何视图本身的配置或记录数据，随时可再切换。
常见陷阱：--view-id 必须属于 --table-id 指定的表，跨表设置会被后端拒绝；
删除当前默认视图后表格会退回到某个兜底视图（通常是最早创建的）。`,
			Example: "  tabtin table view set-default --table-id <table_id> --view-id <view_id>\n" +
				"  tabtin table view set-default --table-id <table_id> --view-id <view_id> --dry-run\n" +
				"  tabtin table view list --table-id <table_id>  # 先确认 view-id 属于该表",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/set-default-view",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "视图 ID"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("切换表格默认视图指针（不影响任何视图配置）").
					Step("POST", "/table/set-default-view", map[string]any{
						"table_id": ctx.Str("table-id"),
						"view_id":  ctx.Str("view-id"),
					})
			},
		},
		{
			Use: "reorder", Short: "视图排序",
			Long: `调整视图标签在表格顶部的展示顺序（不影响视图配置或表格数据）。
设计理由：纯展示层排序，和 field reorder / record reorder 是同一类操作，
风险等级 write（可通过再次 reorder 撤销，不会丢数据）。
常见陷阱：--view-orders 需要覆盖你想固定顺序的全部视图；漏传的视图顺序
由后端决定，不保证保持调用前的相对位置。`,
			Example: "  tabtin table view reorder --table-id <table_id> --view-orders '[{\"view_id\":\"view_1\",\"order\":1}]'\n" +
				"  tabtin table view reorder --table-id <table_id> --view-orders '[{\"view_id\":\"view_1\",\"order\":1},{\"view_id\":\"view_2\",\"order\":2}]'\n" +
				"  tabtin table view reorder --table-id <table_id> --view-orders '[{\"view_id\":\"view_1\",\"order\":1}]' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/reorder-views",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "view-orders", Type: cmdutil.FlagString, Required: true, Desc: "排序 JSON"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("调整视图标签展示顺序（不改变视图配置或数据）").
					Step("POST", "/table/reorder-views", map[string]any{
						"table_id":    ctx.Str("table-id"),
						"view_orders": ctx.Str("view-orders"),
					})
			},
		},
		{
			Use: "statistics", Short: "视图统计",
			Long: `按视图当前生效的筛选范围，统计各列的汇总值（求和/平均/计数等，取决于字段类型）。
设计理由：统计范围跟随视图已保存的 filters，不需要额外传参——想看不同筛选下
的统计，先 view update 改 filters 再调本命令，或直接看 view records 自行聚合。
常见陷阱：文本类字段通常只有 count，数值类字段才有 sum/avg/min/max——
返回结构随列的字段类型变化，不要假设所有列都有相同的统计维度。`,
			Example: "  tabtin table view statistics --view-id <view_id>\n" +
				"  tabtin table view statistics --view-id <view_id> --format json\n" +
				"  tabtin table view statistics --view-id <view_id> --jq '.columns'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/view-column-statistics",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "视图 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "form-share-enable", Short: "为表单视图创建/获取分享链接",
			Long: `为 view_type=form 的视图开启公开填写分享，返回 share_id 供匿名访问。
设计理由：已存在未过期分享时直接返回同一个 share_id（幂等），不会生成多个
并行有效的链接，避免旧链接失效但用户不知道。
常见陷阱：仅对 view_type=form 的视图有效——对其它类型视图调用会被后端拒绝；
分享开启后任何持有链接的人都能提交数据，敏感表单请配合权限/字段可见性控制。`,
			Example: "  tabtin table view form-share-enable --view-id <view_id>\n" +
				"  tabtin table view form-share-enable --view-id <view_id> --dry-run\n" +
				"  tabtin table view detail --view-id <view_id>  # 确认 view-type 是 form",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-share-enable",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "表单视图 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("开启表单分享（已有未过期分享时幂等返回同一链接）").
					Step("POST", "/table/form-share-enable", map[string]any{
						"view_id": ctx.Str("view-id"),
					})
			},
		},
		{
			Use: "form-share-disable", Short: "关闭表单分享链接",
			Long: `关闭 view_type=form 视图当前生效的公开分享链接，旧链接立即失效。
设计理由：与 form-share-enable 对称——关闭后持有旧链接的人无法再提交数据；
再次 enable 会生成新的 share_id，不是恢复旧链接。
常见陷阱：关闭前确认没有依赖该链接的进行中收集流程——旧链接失效是立即的，
没有宽限期，正在填写中的用户会提交失败。`,
			Example: "  tabtin table view form-share-disable --view-id <view_id>\n" +
				"  tabtin table view form-share-disable --view-id <view_id> --dry-run\n" +
				"  tabtin table view detail --view-id <view_id>  # 关前确认是否还有依赖方",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-share-disable",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "表单视图 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("关闭表单分享，旧链接立即失效").
					Step("POST", "/table/form-share-disable", map[string]any{
						"view_id": ctx.Str("view-id"),
					})
			},
		},
		{
			Use: "form-share-rotate", Short: "轮换分享链接（生成新 share_id，旧链接失效）",
			Long: `生成新的 share_id 并使旧链接立即失效——用于怀疑链接泄露时的应急轮换。
设计理由：与 disable 后再 enable 的效果类似（旧链接失效 + 生成新链接），
但 rotate 是单步原子操作，避免中间状态（分享完全关闭）造成的短暂不可用。
常见陷阱：轮换后所有已分发的旧链接会同时失效——需要同步通知所有正在使用
该链接的下游方更新到新链接，否则他们会遇到提交失败。`,
			Example: "  tabtin table view form-share-rotate --view-id <view_id>\n" +
				"  tabtin table view form-share-rotate --view-id <view_id> --dry-run\n" +
				"  tabtin table view detail --view-id <view_id>  # 轮换前先确认当前分享状态",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-share-rotate",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "表单视图 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("轮换分享链接（旧链接立即失效，生成新 share_id）").
					Step("POST", "/table/form-share-rotate", map[string]any{
						"view_id": ctx.Str("view-id"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

// validateViewCreateGroupBy 把一等参数 --group-by-field-id 展开为标准 groups JSON。
// 与 --groups 的互斥由 CommandDef.Conflicts 在更早阶段拦截。
func validateViewCreateGroupBy(ctx *cmdutil.RunContext) error {
	fieldID := strings.TrimSpace(ctx.Str("group-by-field-id"))
	if fieldID == "" {
		return nil
	}
	groups := []map[string]any{{
		"field_id":  fieldID,
		"direction": "asc",
	}}
	raw, err := json.Marshal(groups)
	if err != nil {
		return fmt.Errorf("生成 groups 失败: %w", err)
	}
	ctx.FlagValues["groups"] = string(raw)
	delete(ctx.FlagValues, "group-by-field-id")
	return nil
}
