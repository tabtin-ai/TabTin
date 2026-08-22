package table

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// fieldTypeGroupsLong 是 CLI 可创建字段的产品契约，必须与 Electron
// FieldTypeSelector 展示的类型保持一致。后端仍保留其他类型，以便已有表读取、
// 渲染和迁移；CLI 不得创建或转换为那些 UI 未开放的类型。
const fieldTypeGroupsLong = `可创建字段类型清单（共 16 种，与 TabData UI 一致）：

基础文本: text / long_text
  - text              单行文本
  - long_text         多行文本（options 可选 {"format":"markdown"}）

数值: number / percent / currency / rating
  - number            数字（options: {"precision":2}）
  - percent           百分比（options: {"precision":2}；存储 0-100 或 0-1，按 precision）
  - currency          货币（options: {"symbol":"¥","precision":2}）
  - rating            评分（options: {"max":5,"icon":"star"}）

选择: select / multi_select / checkbox
  - select            单选（options: {"choices":["A","B"]} 或 {"choices":[{"value":"A","label":"A","color":"#4299E1"}]}）
  - multi_select      多选（options 同 select）
  - checkbox          复选框（无 options）

日期: date
  - date              日期（options: {"format":"YYYY-MM-DD"}）

链接联系: url / email / phone
  - url               URL 链接
  - email             电子邮箱
  - phone             手机号

用户: user
  - user              用户引用（options: {"allowMultiple":false}）

文件: attachment
  - attachment        附件（支持任意文件，值为 [{"file_id":"","name":"","url":""}]）

高级:
  - link              关联到另一张表
                      options: {"foreignTableId":"<目标表 UUID>",
                                "relationship":"ManyMany|OneMany|ManyOne|OneOne",
                                "isOneWay":false}
                      ⚠ 双向 link 会自动在目标表创建对称字段。`

func registerFieldCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "字段列表",
			Long: `列出表格的全部字段定义（名称、类型、options、是否必填/主字段）。
设计理由：新建 record 前先 field list 确认字段名与类型，能避免 record insert
的 --data key 或值格式对不上（如把 select 的字符串值传成了数组）。
常见陷阱：字段名可能重复被改名——长期跑的脚本建议缓存 field-id 而不是硬编码
字段名，或每次先 list 再按名称查 id。`,
			Example: "  tabtin table field list --table-id <table_id>\n" +
				"  tabtin table field list --table-id <table_id> --format json\n" +
				"  tabtin table field list --table-id <table_id> --jq '.fields[].name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/fields",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptFieldList,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
		},
		{
			Use: "detail", Short: "字段详情",
			Long: `取单个字段的完整定义，包括 options 里的 link 关联配置。
设计理由：field list 为列表浏览做了瘦身，完整 options 需要用 detail 单独取。
常见陷阱：link 字段的 options 存的是目标表和关联关系，不是关联记录的当前值；
取实际值请用 record detail。`,
			Example: "  tabtin table field detail --field-id <field_id>\n" +
				"  tabtin table field detail --field-id <field_id> --format json\n" +
				"  tabtin table field detail --field-id <field_id> --jq '.options'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/field-detail",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "add", Short: "添加字段",
			Long: "添加一个字段到表格。\n\n" + fieldTypeGroupsLong,
			Example: "  tabtin table field add --table-id xxx --name \"邮箱\" --field-type email\n" +
				"  tabtin table field add --table-id xxx --name \"评分\" --field-type rating --options '{\"max\":5}'\n" +
				"  tabtin table field add --table-id xxx --name \"演职员\" --field-type link \\\n" +
				"    --options '{\"foreignTableId\":\"<目标表 UUID>\",\"relationship\":\"ManyMany\",\"isOneWay\":false}'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/add-field",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptFieldAdd,
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "字段名"},
				{Name: "field-type", Type: cmdutil.FlagString, Required: true,
					Desc: "字段类型。16 种，与 TabData UI 保持一致；详见 --help 长描述。" +
						" 可用: text / long_text / number / percent / currency / rating / select / multi_select / checkbox / date / url / email / phone / user / attachment / link"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "字段说明"},
				{Name: "options", Type: cmdutil.FlagString,
					Desc: "类型选项 JSON。不同 --field-type 对应不同 shape（详见 --help 长描述）：" +
						" select→{\"choices\":[\"A\",\"B\"]}；" +
						" link→{\"foreignTableId\":\"...\",\"relationship\":\"ManyMany|OneMany|ManyOne|OneOne\",\"isOneWay\":false}"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("添加字段 "+ctx.Str("name")+"（类型："+ctx.Str("field-type")+"）").
					Step("POST", "/table/add-field", map[string]any{
						"table_id":   ctx.Str("table-id"),
						"name":       ctx.Str("name"),
						"field_type": ctx.Str("field-type"),
						"options":    ctx.Str("options"),
					})
			},
		},
		{
			Use: "update", Short: "更新字段",
			Long: "更新字段名称、描述、必填、options 等属性（不含字段类型变更）。\n" +
				"改类型请用 `field check` / `field preview` / `field convert`。\n\n" + fieldTypeGroupsLong,
			Example: "  tabtin table field update --field-id <field_id> --name \"新字段名\"\n" +
				"  tabtin table field update --field-id <field_id> --description \"客户来源\"\n" +
				"  tabtin table field update --field-id <field_id> --options '{\"choices\":[\"A\",\"B\"]}'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/update-field",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "新名称"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "新描述"},
				{Name: "options", Type: cmdutil.FlagString,
					Desc: "字段 options JSON（select/multi_select 只接受 {\"choices\":[...]}）"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新字段属性（不改变类型）").
					Step("POST", "/table/update-field", map[string]any{
						"field_id": ctx.Str("field-id"),
						"name":     ctx.Str("name"),
						"options":  ctx.Str("options"),
					})
			},
		},
		{
			Use: "delete", Short: "删除字段（不可恢复）",
			Long: `硬删除字段及其在全部记录里存储的值——没有回收站层。
设计理由：字段级删除后端不提供撤销端点；link 字段还会同时清理关联关系。
常见陷阱：删除后字段定义和历史记录值都不可恢复；建议先 field detail 确认目标。`,
			Example: "  tabtin table field delete --field-id <field_id> --yes\n" +
				"  tabtin table field delete --field-id <field_id> --dry-run\n" +
				"  tabtin table field detail --field-id <field_id>  # 删前确认目标字段",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/delete-field",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptFieldDelete,
			Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"}},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("永久删除字段及其全部记录值（无回收站，不可恢复）").
					Step("POST", "/table/delete-field", map[string]any{
						"field_id": ctx.Str("field-id"),
					})
			},
		},
		{
			Use: "reorder", Short: "字段排序",
			Long: `调整字段在表格中的展示列顺序（不影响字段值或类型）。
设计理由：只是纯展示层调整，风险等级为 write 而非 destructive；传入的顺序
是全量覆盖，不是相对移动。
常见陷阱：--field-orders 必须覆盖你想固定顺序的全部字段——漏传的字段顺序
行为由后端决定（通常追加到末尾），不保证和调用前一致。`,
			Example: "  tabtin table field reorder --table-id <table_id> --field-orders '[{\"field_id\":\"fld_1\",\"sort_order\":1}]'\n" +
				"  tabtin table field reorder --table-id <table_id> --field-orders '[{\"field_id\":\"fld_1\",\"sort_order\":1},{\"field_id\":\"fld_2\",\"sort_order\":2}]'\n" +
				"  tabtin table field reorder --table-id <table_id> --field-orders '[{\"field_id\":\"fld_1\",\"sort_order\":1}]' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/fields-reorder",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "field-orders", Type: cmdutil.FlagString, Required: true, Desc: "排序 JSON [{field_id, sort_order}]"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("调整字段展示列顺序（全量覆盖，不改变字段值）").
					Step("POST", "/table/fields-reorder", map[string]any{
						"table_id":     ctx.Str("table-id"),
						"field_orders": ctx.Str("field-orders"),
					})
			},
		},
		{
			Use: "check", Short: "类型转换检查",
			Long: `只读检查：判断把字段转换为 --target-type 是否安全、有无潜在数据丢失。
设计理由：是 field convert 的前置侦察步骤——先 check 看风险等级，再决定是否需要
field preview 抽样看转换后的样子，最后才 convert。
常见陷阱：check 通过不代表转换后数据「正确」，只代表转换本身不会报错；
精度/格式类损失（如 datetime → date 丢时间部分）建议进一步 preview 确认。`,
			Example: "  tabtin table field check --field-id <field_id> --target-type number\n" +
				"  tabtin table field check --field-id <field_id> --target-type select\n" +
				"  tabtin table field check --field-id <field_id> --target-type date",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/field-check-conversion",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"},
				{Name: "target-type", Type: cmdutil.FlagString, Required: true,
					Desc: "目标类型（16 种之一，与 TabData UI 一致；详见 `field add --help`）"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "preview", Short: "类型转换预览",
			Long: `只读抽样预览：展示按 --target-type / --target-options 转换后，部分记录的
字段值会变成什么样，不会真正修改数据。
设计理由：field check 只给风险等级，preview 给具体样本值——转换涉及格式/精度
损失时（如 currency→number 丢符号），肉眼看样本比看风险等级更直观。
常见陷阱：--sample-size 越大越准，但样本再多也不是全量校验；真正落地后仍需
field convert 后再抽查几条真实记录。`,
			Example: "  tabtin table field preview --field-id <field_id> --target-type select --target-options '{\"choices\":[\"A\",\"B\"]}'\n" +
				"  tabtin table field preview --field-id <field_id> --target-type number --sample-size 20\n" +
				"  tabtin table field preview --field-id <field_id> --target-type date",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/field-preview-conversion",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"},
				{Name: "target-type", Type: cmdutil.FlagString, Required: true,
					Desc: "目标类型（16 种之一，与 TabData UI 一致；详见 `field add --help`）"},
				{Name: "target-options", Type: cmdutil.FlagString,
					Desc: "目标类型选项 JSON（shape 随 target-type 变化，详见 `field add --help` 长描述）"},
				{Name: "sample-size", Type: cmdutil.FlagInt, Desc: "预览样本数"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "convert", Short: "类型转换",
			Long: "将字段原地转换为另一种类型。低风险转换直接生效，高风险（如丢精度、结构变更）" +
				"需 --force 或 --async。\n\n" + fieldTypeGroupsLong,
			Example: "  tabtin table field convert --field-id <field_id> --target-type number --force\n" +
				"  tabtin table field convert --field-id <field_id> --target-type select --target-options '{\"choices\":[\"A\",\"B\"]}'\n" +
				"  tabtin table field convert --field-id <field_id> --target-type long_text --async",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/field-convert",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "字段 ID"},
				{Name: "target-type", Type: cmdutil.FlagString, Required: true,
					Desc: "目标类型（16 种之一，与 TabData UI 一致；详见 --help 长描述）"},
				{Name: "target-options", Type: cmdutil.FlagString,
					Desc: "目标类型选项 JSON（shape 随 target-type 变化，详见 --help 长描述）"},
				{Name: "force", Type: cmdutil.FlagBool, Desc: "强制转换"},
				{Name: "async", Type: cmdutil.FlagBool, Desc: "异步模式"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("原地转换字段类型为 "+ctx.Str("target-type")+"（建议先 field check / field preview）").
					Step("POST", "/table/field-convert", map[string]any{
						"field_id":       ctx.Str("field-id"),
						"target_type":    ctx.Str("target-type"),
						"target_options": ctx.Str("target-options"),
						"force":          ctx.FlagValues["force"],
					})
			},
		},
		{
			Use: "bulk-add", Short: "批量添加字段",
			Long: "单次最多 50 个字段（MAX_BULK_FIELDS）。字段类型与 TabData UI 保持一致。\n\n" +
				fieldTypeGroupsLong,
			Example: "  tabtin table field bulk-add --table-id xxx --fields '[\n" +
				"    {\"name\":\"姓名\",\"field_type\":\"text\"},\n" +
				"    {\"name\":\"评分\",\"field_type\":\"number\"},\n" +
				"    {\"name\":\"演员\",\"field_type\":\"link\",\"options\":{\"foreignTableId\":\"<UUID>\",\"relationship\":\"ManyMany\"}}\n" +
				"  ]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/bulk-fields",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "fields", Type: cmdutil.FlagString, Required: true,
					Desc: "字段定义 JSON 数组，每项含 name / field_type / options? / description? / is_primary?；" +
						"单次上限 50。示例详见 --help 长描述。"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("批量添加字段（单次上限 50 个）").
					Step("POST", "/table/bulk-fields", map[string]any{
						"table_id": ctx.Str("table-id"),
						"fields":   ctx.Str("fields"),
					})
			},
		},
		//  W4：字段影响分析三件套（配合 check/preview/convert / delete）
		{
			Use: "explain <field-id>", Short: "字段操作影响 + 可撤销性 explain",
			Long: `统一 explain：返回指定 action 下的影响摘要与 undo_capability
（GET /fields/{field_id}/explain）。
设计理由：把「能不能 Ctrl+Z 回来」和「会砸到谁」合成一次只读查询，供删/转
字段前对话框与 Agent 决策；--action 默认 delete，也可 convert_to=<type>。
常见陷阱：explain 通过不代表转换后数据语义正确，高精度损失仍要 field preview；
warning_level 只是摘要，细节看 impact.dependent_fields。`,
			Example: "  tabtin table field explain fld_xxx\n" +
				"  tabtin table field explain fld_xxx --action delete\n" +
				"  tabtin table field explain fld_xxx --jq '.undo_capability'",
			Route: cmdutil.RouteCliServer, Method: "GET",
			Path: "/api/tabdata/fields/{field_id}/explain", ArgsMapping: []string{"field_id"},
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "action", Type: cmdutil.FlagString, Default: "delete", Desc: "操作类型（默认 delete；可 convert_to=<type>）"},
			},
			HasFormat: true, RequiresAuth: true, Idempotent: true,
		},
		{
			Use: "delete-references <field-id>", Short: "删除字段前的影响分析",
			Long: `分析删除该字段后受影响的依赖字段、视图与对称 Link
（GET /fields/{field_id}/delete-references）。
设计理由：field delete 不可逆地清掉列值；删前用本命令列清 lookup/rollup/
对称 link 与视图引用，避免静默打坏下游。
常见陷阱：本命令只读、不锁字段；分析后到真正 delete 之间别人可能又加依赖，
关键字段删前再跑一次。`,
			Example: "  tabtin table field delete-references fld_xxx\n" +
				"  tabtin table field delete-references fld_xxx --format json\n" +
				"  tabtin table field delete-references fld_xxx --jq '.dependent_fields'",
			Route: cmdutil.RouteCliServer, Method: "GET",
			Path: "/api/tabdata/fields/{field_id}/delete-references", ArgsMapping: []string{"field_id"},
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			HasFormat: true, RequiresAuth: true, Idempotent: true,
		},
		{
			Use: "conversion-references <field-id>", Short: "字段类型转换前的影响分析",
			Long: `分析转换该字段类型后的影响范围（GET /fields/{field_id}/conversion-references）。
设计理由：与 field check / preview / convert 组成完整四步链——本命令给影响面，
check 给风险等级，preview 给样本值，convert 才落地。
常见陷阱：warnings 可能为空但仍有精度损失；转 link/公式类务必先 check+preview。`,
			Example: "  tabtin table field conversion-references fld_xxx\n" +
				"  tabtin table field conversion-references fld_xxx --format json\n" +
				"  tabtin table field conversion-references fld_xxx --jq '.warnings'",
			Route: cmdutil.RouteCliServer, Method: "GET",
			Path: "/api/tabdata/fields/{field_id}/conversion-references", ArgsMapping: []string{"field_id"},
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			HasFormat: true, RequiresAuth: true, Idempotent: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}
