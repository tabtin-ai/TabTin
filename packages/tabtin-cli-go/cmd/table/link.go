package table

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// link 命令组：关联字段的结构创建 + 边上的挂/解绑 + 候选查询。
//
// Agent 标准编排（日常挂靠，不涉及「建几张表」决策）：
//  1. tabtin table link create ...                 # 建 link 字段（一等 flag，免手写 JSON）
//  2. tabtin table link linkable-records --search  # 搜目标 record UUID
//  3. tabtin table link add/set/remove ...         # 增量或整格写边
//  4. tabtin table link list ...                   # 核对当前关联
//
// 「该不该建双表 / nested_list」形态决策仍走 skills_read("app:tabdata/table-modeling")；
// 本命令组只管运行时关联操作。详见 skills_read("app:tabdata/table-association")。
func registerLinkCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "create", Short: "创建关联（link）字段",
			Long: `在本表创建指向目标表的 link 字段，用一等 flag 代替手写 options JSON。
设计理由：Agent 最常踩的坑是漏 foreignTableId / 写错 relationship 大小写 / 误造 is_multi；
本命令把必填项提升为 flag，并在 help 里写清单/多关联与 relationship 的对照。
常见陷阱：单/多不是 is_multi——ManyOne/OneOne=单值，ManyMany/OneMany=多值；
双向（默认）会在目标表自动建对称字段，别再手建反向 link；先建目标表再 create。`,
			Example: "  # 多对多双向（电影→演员）\n" +
				"  tabtin table link create --table-id <本表> --name \"演职员\" \\\n" +
				"    --foreign-table-id <演员表> --relationship ManyMany\n" +
				"  # 多对一单关联（任务→分类）\n" +
				"  tabtin table link create --table-id <任务表> --name \"分类\" \\\n" +
				"    --foreign-table-id <分类表> --relationship ManyOne\n" +
				"  # 单向，不在目标表建对称字段\n" +
				"  tabtin table link create --table-id <本表> --name \"标签\" \\\n" +
				"    --foreign-table-id <标签表> --relationship ManyMany --one-way",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/link-create",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkCreate,
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "本表（持有 link 字段）ID"},
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "字段显示名"},
				{Name: "foreign-table-id", Type: cmdutil.FlagString, Required: true, Desc: "目标表 UUID"},
				{Name: "relationship", Type: cmdutil.FlagEnum,
					Enum:    []string{"OneOne", "OneMany", "ManyOne", "ManyMany"},
					Default: "ManyOne",
					Desc:    "关系基数：ManyOne/OneOne=单关联；ManyMany/OneMany=多关联（默认 ManyOne）"},
				{Name: "one-way", Type: cmdutil.FlagBool, Desc: "单向（不在目标表建对称字段；默认双向）"},
				{Name: "lookup-field-id", Type: cmdutil.FlagString, Desc: "目标表主显字段 UUID（省略则用目标表 Label/主字段）"},
				{Name: "filter-by-view-id", Type: cmdutil.FlagString, Desc: "候选选择器限定视图"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "字段说明"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			Tips: []string{
				"单关联用 ManyOne（本表多行可指向同一目标）或 OneOne；多关联用 ManyMany / OneMany",
				"建完后用 linkable-records 搜目标 UUID，再 link add / set 写边",
				"形态决策（几张表）请先 skills_read(\"app:tabdata/table-modeling\")",
			},
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc(fmt.Sprintf("创建 link 字段 %q → %s (%s)", ctx.Str("name"), ctx.Str("foreign-table-id"), ctx.Str("relationship"))).
					Step("POST", "/table/link-create", map[string]any{
						"table_id":          ctx.Str("table-id"),
						"name":              ctx.Str("name"),
						"foreign_table_id":  ctx.Str("foreign-table-id"),
						"relationship":      ctx.Str("relationship"),
						"one_way":           ctx.Bool("one-way"),
						"lookup_field_id":   ctx.Str("lookup-field-id"),
						"filter_by_view_id": ctx.Str("filter-by-view-id"),
					})
			},
		},
		{
			Use: "update", Short: "更新关联字段配置",
			Long: `更新已有 link 字段的 relationship / 单向双向 / 主显字段等 options（合并写入，不整表覆盖未知键）。
设计理由：field update --options 需要 Agent 先 detail 再拼完整 JSON，易丢 isOneWay / symmetricFieldId；
本命令按 flag 增量合并。
常见陷阱：改 relationship 可能影响已有单元格的单/多语义；双向改单向不会自动删对称字段（以后端为准）；
改类型以外的 name/description 也可一并传。`,
			Example: "  tabtin table link update --field-id <link字段> --relationship ManyMany\n" +
				"  tabtin table link update --field-id <link字段> --one-way\n" +
				"  tabtin table link update --field-id <link字段> --two-way --lookup-field-id <目标字段>",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/link-update",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkUpdate,
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "本表 link 字段 ID"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "新字段名"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "新描述"},
				{Name: "relationship", Type: cmdutil.FlagEnum,
					Enum: []string{"OneOne", "OneMany", "ManyOne", "ManyMany"},
					Desc: "新的关系基数"},
				{Name: "one-way", Type: cmdutil.FlagBool, Desc: "设为单向"},
				{Name: "two-way", Type: cmdutil.FlagBool, Desc: "设为双向（与 --one-way 互斥）"},
				{Name: "lookup-field-id", Type: cmdutil.FlagString, Desc: "目标表主显字段"},
				{Name: "filter-by-view-id", Type: cmdutil.FlagString, Desc: "候选选择器视图"},
			},
			Conflicts: map[string][]string{
				"one-way": {"two-way"},
				"two-way": {"one-way"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新 link 字段 options（合并） field-id="+ctx.Str("field-id")).
					Step("POST", "/table/link-update", map[string]any{
						"field_id":        ctx.Str("field-id"),
						"relationship":    ctx.Str("relationship"),
						"one_way":         ctx.Bool("one-way"),
						"two_way":         ctx.Bool("two-way"),
						"lookup_field_id": ctx.Str("lookup-field-id"),
					})
			},
		},
		{
			Use: "set", Short: "整格覆盖关联目标",
			Long: `把某条记录的 link 单元格设为给定目标 id 列表（整格覆盖，不是增量）。
设计理由：后端 set_link_cell 语义就是整格 diff；需要「只留这些」时用 set，避免 add/remove 来回。
常见陷阱：必须显式传 --targets / --target-ids（漏参会校验失败，不会静默清空）；清空请传 --targets '[]' 或改用 remove --all；
值必须是目标表 record UUID，禁止写显示名。`,
			Example: "  tabtin table link set --table-id <本表> --field-id <link字段> --record-id <行> \\\n" +
				"    --targets '[\"<目标uuid1>\",\"<目标uuid2>\"]'\n" +
				"  tabtin table link set --table-id <本表> --field-id <link字段> --record-id <行> \\\n" +
				"    --target-ids <uuid1>,<uuid2>\n" +
				"  # 清空关联（必须显式空数组）\n" +
				"  tabtin table link set --table-id <本表> --field-id <link字段> --record-id <行> --targets '[]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/link-set",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkSet,
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     linkEdgeFlags(true),
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("整格覆盖 link 单元格").
					Step("POST", "/table/link-set", linkEdgeBody(ctx))
			},
		},
		{
			Use: "add", Short: "增量挂上关联目标",
			Long: `在现有关联上合并新的目标 id（读-改-写）。多关联去重合并；单关联（ManyOne/OneOne）则覆盖为传入的最后一个 id。
设计理由：Agent 最常见需求是「再挂一个演员 / 再挂一个标签」，不应要求先 list 再手拼整格 JSON。
常见陷阱：增量合并在 Desktop/Daemon（cli-server）下完整支持；纯 API 直连请改用 link set；
目标 id 用 linkable-records 查，不要把姓名当 id。`,
			Example: "  tabtin table link add --table-id <本表> --field-id <link字段> --record-id <行> \\\n" +
				"    --target-ids <演员uuid>\n" +
				"  tabtin table link add --table-id <本表> --field-id <link字段> --record-id <行> \\\n" +
				"    --targets '[\"<uuid1>\",\"<uuid2>\"]'\n" +
				"  tabtin table link add --table-id <本表> --field-id <link字段> --record-id <行> \\\n" +
				"    --target-ids <uuid> --format json",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/table/link-add",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkAddRemoveDjangoHint("add"),
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     linkEdgeFlags(false),
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("增量合并 link 目标（单关联则覆盖）").
					Step("POST", "/table/link-add", linkEdgeBody(ctx))
			},
		},
		{
			Use: "remove", Short: "解绑关联目标",
			Long: `从现有关联中去掉指定目标 id，或 --all 清空。内部读-改-写后整格写回。
设计理由：与 add 对称，避免 Agent 为了解绑一条去拼完整剩余列表。
常见陷阱：没传 --target-ids 又没 --all 会校验失败；清空也可用 link set --targets '[]'；
双向 link 解绑会同步对称边（后端保证）。`,
			Example: "  tabtin table link remove --table-id <本表> --field-id <link字段> --record-id <行> \\\n" +
				"    --target-ids <uuid>\n" +
				"  tabtin table link remove --table-id <本表> --field-id <link字段> --record-id <行> --all\n" +
				"  tabtin table link remove --table-id <本表> --field-id <link字段> --record-id <行> \\\n" +
				"    --targets '[\"<uuid1>\"]' --dry-run",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/table/link-remove",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkAddRemoveDjangoHint("remove"),
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: append(linkEdgeFlags(false), cmdutil.FlagDef{
				Name: "all", Type: cmdutil.FlagBool, Desc: "清空该单元格全部关联（与 --target-ids 二选一）",
			}),
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("解绑 link 目标").
					Step("POST", "/table/link-remove", linkEdgeBody(ctx))
			},
		},
		{
			Use: "list", Short: "列出记录当前关联目标",
			Long: `读取某条记录在指定 link 字段上的当前目标 id（及 title，若后端有缓存）。
设计理由：比 record detail 再 jq 抠字段更稳，返回结构对 Agent 友好（target_ids / count）。
常见陷阱：--field-id 是本表 link 字段；空关联返回 count=0 而不是错误。`,
			Example: "  tabtin table link list --table-id <本表> --field-id <link字段> --record-id <行>\n" +
				"  tabtin table link list --table-id <本表> --field-id <link字段> --record-id <行> --format json\n" +
				"  tabtin table link list --table-id <本表> --field-id <link字段> --record-id <行> --jq '.target_ids'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/link-list",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkList,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "本表 ID"},
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "本表 link 字段 ID"},
				{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "本表记录 ID"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
		},
		{
			Use: "linkable-records", Short: "查询 link 字段的候选目标记录",
			Long: `按 --search 关键词在 link 字段的目标表里搜候选记录，支持分页与已选过滤。
设计理由：Agent 在写 link 字段值前，通常需要先查到目标 record 的 UUID——
本命令是 link add/set 或 record insert/update 写 link 前的标准前置查询。
常见陷阱：--field-id 是本表的 link 字段 ID，不是目标表字段；默认传 selected_record_ids
会排除已选（方便选择器「还没选的」）；要只看已选请加 --only-selected。`,
			Example: "  tabtin table link linkable-records --table-id <本表> --field-id <link字段> --search 梁朝伟\n" +
				"  tabtin table link linkable-records --table-id <本表> --field-id <link字段> --search 梁朝伟 --page 1 --page-size 20\n" +
				"  tabtin table link linkable-records --table-id <本表> --field-id <link字段> --only-selected --selected-record-ids <id1>,<id2>",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/linkable-records",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkableRecords,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "本表（持有 link 字段的那张表）ID"},
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "本表的 link 字段 ID"},
				{Name: "search", Type: cmdutil.FlagString, Desc: "搜索关键词（在目标表的 Label / 主字段上模糊匹配）"},
				{Name: "search-field-id", Type: cmdutil.FlagString, Desc: "限定在目标表某字段上搜索"},
				{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页大小（上限 500）"},
				{Name: "exclude-record-id", Type: cmdutil.FlagString, Desc: "排除某条本表记录（自链接场景）"},
				{Name: "selected-record-ids", Type: cmdutil.FlagString,
					Desc: "已选目标 id（逗号分隔）。默认从结果中排除这些 id；配合 --only-selected 则只返回它们"},
				{Name: "only-selected", Type: cmdutil.FlagBool, Desc: "只返回 selected-record-ids 中的记录"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "linkable-fields", Short: "查询 link 字段的目标表所有字段",
			Long: `列出 link 字段所指向的目标表里全部字段。
设计理由：建 lookup 字段（取 lookupFieldId）或 rollup 字段（取聚合目标字段）
前，需要先知道目标表有哪些字段及其类型——本命令提供这份清单。
常见陷阱：返回的是目标表字段，不是本表字段；field-id 仍传本表 link 字段 ID
用于定位关联关系，不要传目标表字段 ID。`,
			Example: "  tabtin table link linkable-fields --table-id <本表 UUID> --field-id <本表 link 字段 UUID>\n" +
				"  tabtin table link linkable-fields --table-id <本表 UUID> --field-id <本表 link 字段 UUID> --format json\n" +
				"  tabtin table link linkable-fields --table-id <本表 UUID> --field-id <本表 link 字段 UUID> --jq '.fields[].name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/linkable-fields",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptLinkableFields,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "本表（持有 link 字段的那张表）ID"},
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "本表的 link 字段 ID"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "populate-choices", Short: "根据样本数据自动填充 select 选项",
			Long: `给 select / multi_select 字段从样本值中提取唯一值、生成 choices。
设计理由：数据导入后 select 字段的 options 往往是空的，逐个手填选项很繁琐；
本命令扫现有记录值自动补全，或直接传 --values 指定候选集。
常见陷阱：仅对 select / multi_select 字段有效，其它类型调用会被后端拒绝；
与 link 边操作无关——别用它处理关联字段；--values 传入时会覆盖式合并。`,
			Example: "  tabtin table link populate-choices --field-id <select 字段 UUID>\n" +
				"  tabtin table link populate-choices --field-id <UUID> --values '[\"A\",\"B\",\"C\"]'\n" +
				"  tabtin table link populate-choices --field-id <UUID> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/populate-choices",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "field-id", Type: cmdutil.FlagString, Required: true,
					Desc: "字段 ID（select / multi_select；其它类型无效）"},
				{Name: "values", Type: cmdutil.FlagString,
					Desc: "可选：预制候选值 JSON 数组，例如 [\"A\",\"B\",\"C\"]；省略则由后端从现有数据提取"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("自动填充 select 选项 field-id="+ctx.Str("field-id")).
					Step("POST", "/table/populate-choices", map[string]any{
						"field_id": ctx.Str("field-id"),
						"values":   ctx.Str("values"),
					})
			},
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}

func linkEdgeFlags(targetsOptionalForEmptySet bool) []cmdutil.FlagDef {
	_ = targetsOptionalForEmptySet
	return []cmdutil.FlagDef{
		{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "本表 ID"},
		{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "本表 link 字段 ID"},
		{Name: "record-id", Type: cmdutil.FlagString, Required: true, Desc: "本表记录 ID"},
		{Name: "targets", Type: cmdutil.FlagString,
			Desc: "目标 record UUID 的 JSON 数组，如 [\"uuid1\",\"uuid2\"]；也可用 --target-ids"},
		{Name: "target-ids", Type: cmdutil.FlagString,
			Desc: "目标 record UUID，逗号分隔（与 --targets 等价，更易在 shell 里拼）"},
	}
}

func linkEdgeBody(ctx *cmdutil.RunContext) map[string]any {
	body := map[string]any{
		"table_id":  ctx.Str("table-id"),
		"field_id":  ctx.Str("field-id"),
		"record_id": ctx.Str("record-id"),
	}
	if v := ctx.Str("targets"); v != "" {
		body["targets"] = v
	}
	if v := ctx.Str("target-ids"); v != "" {
		body["target_ids"] = v
	}
	if ctx.Bool("all") {
		body["all"] = true
	}
	return body
}
