package table

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// form 命令组：公开表单访问，基于 share_id，多数无需登录（RequiresAgent 不设）。
// 有密码保护的表单需带 --password；submit-direct 是登录用户跳过分享链接的直提通道。
func registerFormCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "get", Short: "获取公开表单元数据",
			Long: `通过 share_id 获取表单结构（字段、布局等），无需登录。
设计理由：Agent/前端渲染表单前先拿结构；有密码保护时仅返回 has_password=true
和标题，不泄露字段结构，需先 verify 密码才能拿到完整 schema。
常见陷阱：share-id 不是 table-id，是分享链接里的独立标识；表单被禁用或
删除后本命令会报错，不会静默返回空结构。`,
			Example: "  tabtin table form get --share-id <share_id>\n" +
				"  tabtin table form get --share-id <share_id> --format json\n" +
				"  tabtin table form get --share-id <share_id> --jq '.fields'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-get",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "share-id", Type: cmdutil.FlagString, Required: true, Desc: "表单分享 ID"}},
			HasFormat: true,
		},
		{
			Use: "verify", Short: "验证表单密码",
			Long: `验证有密码保护的表单密码，验证通过后返回完整表单元数据。
设计理由：与 get 分工——get 对无密码表单直接返回全部信息，有密码表单需先
本命令验证；验证通过的结果与 get 返回结构一致，可直接复用后续解析逻辑。
常见陷阱：错误次数过多会被限速（429），不要在脚本里对同一 share-id 暴力试密码；
密码错误不会返回字段结构，只报错。`,
			Example: "  tabtin table form verify --share-id <share_id> --password <pwd>\n" +
				"  tabtin table form verify --share-id <share_id> --password <pwd> --format json\n" +
				"  tabtin table form verify --share-id <share_id> --password <pwd> --jq '.fields'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-verify",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "share-id", Type: cmdutil.FlagString, Required: true, Desc: "表单分享 ID"},
				{Name: "password", Type: cmdutil.FlagString, Required: true, Desc: "密码"},
			},
			HasFormat: true,
		},
		{
			Use: "submit", Short: "提交公开表单",
			Long: `以匿名/公开身份提交表单数据，创建一条记录。
设计理由：与 submit-direct 分工——本命令走分享链接（share_id），面向未登录
提交者；服务端按表单 schema 校验 fields，不合法字段会被拒绝。
常见陷阱：fields 的 key 可用字段 ID 或字段名，两者混用需保证与表单 schema 一致；
表单有密码保护时必须带 --password，否则 403。`,
			Example: "  tabtin table form submit --share-id <share_id> --fields '{\"<field_id>\": \"<value>\"}'\n" +
				"  tabtin table form submit --share-id <share_id> --fields '{...}' --password <pwd>\n" +
				"  tabtin table form submit --share-id <share_id> --fields '{...}' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-submit",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "share-id", Type: cmdutil.FlagString, Required: true, Desc: "表单分享 ID"},
				{Name: "fields", Type: cmdutil.FlagString, Required: true, Desc: "字段值 JSON 对象"},
				{Name: "password", Type: cmdutil.FlagString, Desc: "表单密码（有密码保护时必填）"},
			},
			HasFormat: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("提交公开表单 share-id="+ctx.Str("share-id")).
					Step("POST", "/table/form-submit", map[string]any{
						"share_id": ctx.Str("share-id"),
						"fields":   ctx.Str("fields"),
					})
			},
		},
		{
			Use: "submit-direct", Short: "已登录用户直接提交表单（无需 share_id）",
			Long: `登录用户在表单视图中直接提交，跳过分享链接，要求 view_type=form。
设计理由：面向已在 Space 内的协作者填表场景，比公开链接更简单（不需
share_id/密码），权限走正常表协作者校验而非表单密码。
常见陷阱：view-id 必须是 view_type=form 的视图，传 grid/kanban 等其它类型
视图会被拒绝；与 submit 的匿名提交是两条独立通道，字段校验规则相同。`,
			Example: "  tabtin table form submit-direct --table-id <tid> --view-id <vid> --fields '{...}'\n" +
				"  tabtin table form submit-direct --table-id <tid> --view-id <vid> --fields '{\"标题\":\"测试\"}'\n" +
				"  tabtin table form submit-direct --table-id <tid> --view-id <vid> --fields '{...}' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-submit-direct",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "view-id", Type: cmdutil.FlagString, Required: true, Desc: "表单视图 ID"},
				{Name: "fields", Type: cmdutil.FlagString, Required: true, Desc: "字段值 JSON 对象"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("已登录直接提交表单 view-id="+ctx.Str("view-id")).
					Step("POST", "/table/form-submit-direct", map[string]any{
						"table_id": ctx.Str("table-id"),
						"view_id":  ctx.Str("view-id"),
						"fields":   ctx.Str("fields"),
					})
			},
		},
		{
			Use: "link-records", Short: "获取表单 link 字段候选关联记录",
			Long: `在公开表单场景下，为 link 字段查询候选目标记录（供填表人选择）。
设计理由：表单填写者未必有权限直接查目标表，需通过表单专用通道按 share_id
+ field-id 拿候选列表，行为上等价 table link linkable-records 的公开版。
常见陷阱：field-id 必须是本表单所在表的 link 字段；有密码表单同样要带 --password，
否则和 get 一样只返回受限信息。`,
			Example: "  tabtin table form link-records --share-id <share_id> --field-id <fid>\n" +
				"  tabtin table form link-records --share-id <share_id> --field-id <fid> --search 关键词\n" +
				"  tabtin table form link-records --share-id <share_id> --field-id <fid> --password <pwd>",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-link-records",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "share-id", Type: cmdutil.FlagString, Required: true, Desc: "表单分享 ID"},
				{Name: "field-id", Type: cmdutil.FlagString, Required: true, Desc: "link 字段 ID"},
				{Name: "search", Short: "q", Type: cmdutil.FlagString, Desc: "搜索关键词"},
				{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页大小（最大 200）"},
				{Name: "password", Type: cmdutil.FlagString, Desc: "表单密码（有密码保护时必填）"},
			},
			HasFormat: true,
		},
		{
			Use: "collaborators", Short: "获取表单 User 字段候选协作者列表",
			Long: `在公开表单场景下，为 User 类型字段查询候选协作者（供填表人选择负责人等）。
设计理由：表单里 User 字段的候选值来自表所在 Space 的协作者，本命令让
公开填表人能看到可选的用户列表，而不暴露全平台用户。
常见陷阱：候选列表范围受表协作者关系约束，不是全 Organization 成员；
有密码表单同样要带 --password。`,
			Example: "  tabtin table form collaborators --share-id <share_id>\n" +
				"  tabtin table form collaborators --share-id <share_id> --password <pwd>\n" +
				"  tabtin table form collaborators --share-id <share_id> --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/form-collaborators",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "share-id", Type: cmdutil.FlagString, Required: true, Desc: "表单分享 ID"},
				{Name: "password", Type: cmdutil.FlagString, Desc: "表单密码（有密码保护时必填）"},
			},
			HasFormat: true,
		},
	}
	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}
