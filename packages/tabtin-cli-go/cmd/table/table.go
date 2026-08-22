package table

import (
	"fmt"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/knowledgetree"
)

func NewCmdTable(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "table",
		Short: "数据表操作",
		Long: `管理表格、记录、字段、视图等 TabData 资源。

所有操作在当前 Agent 上下文中执行（tabtin agent use）。

示例：
  tabtin table list
  tabtin table query "SELECT * FROM users LIMIT 10"
  tabtin table record insert --table-id xxx --data '{"name":"test"}'
  tabtin table field list --table-id xxx
  tabtin table export --table-id xxx --format csv`,
	}

	registerTopLevel(cmd, f)

	recordCmd := &cobra.Command{Use: "record", Short: "记录操作"}
	registerRecordCommands(recordCmd, f)
	cmd.AddCommand(recordCmd)

	fieldCmd := &cobra.Command{Use: "field", Short: "字段操作"}
	registerFieldCommands(fieldCmd, f)
	cmd.AddCommand(fieldCmd)

	linkCmd := &cobra.Command{Use: "link", Short: "关联字段：创建 / 挂解绑 / 候选查询"}
	registerLinkCommands(linkCmd, f)
	cmd.AddCommand(linkCmd)

	subRecordCmd := &cobra.Command{Use: "sub-record", Short: "同表层级（父/子记录）操作"}
	registerSubRecordCommands(subRecordCmd, f)
	cmd.AddCommand(subRecordCmd)

	viewCmd := &cobra.Command{Use: "view", Short: "视图操作"}
	registerViewCommands(viewCmd, f)
	cmd.AddCommand(viewCmd)

	attachmentCmd := &cobra.Command{Use: "attachment", Short: "附件操作"}
	registerAttachmentCommands(attachmentCmd, f)
	cmd.AddCommand(attachmentCmd)

	webhookCmd := &cobra.Command{Use: "webhook", Short: "Webhook 管理"}
	registerWebhookCommands(webhookCmd, f)
	cmd.AddCommand(webhookCmd)

	versionCmd := &cobra.Command{Use: "version", Short: "命名版本"}
	registerVersionCommands(versionCmd, f)
	cmd.AddCommand(versionCmd)

	historyCmd := &cobra.Command{Use: "history", Short: "表历史与快照"}
	registerHistoryCommands(historyCmd, f)
	cmd.AddCommand(historyCmd)

	importCmd := &cobra.Command{Use: "import", Short: "导入数据"}
	registerImportCommands(importCmd, f)
	cmd.AddCommand(importCmd)

	exportCmd := &cobra.Command{Use: "export", Short: "导出数据"}
	registerExportCommands(exportCmd, f)
	cmd.AddCommand(exportCmd)

	tokenCmd := &cobra.Command{Use: "token", Short: "表级 API Token"}
	registerTokenCommands(tokenCmd, f)
	cmd.AddCommand(tokenCmd)

	trashCmd := &cobra.Command{Use: "trash", Short: "回收站（已软删的表）"}
	registerTrashCommands(trashCmd, f)
	cmd.AddCommand(trashCmd)

	formCmd := &cobra.Command{Use: "form", Short: "公开表单访问（基于 share_id，多数无需登录）"}
	registerFormCommands(formCmd, f)
	cmd.AddCommand(formCmd)

	collaboratorCmd := &cobra.Command{Use: "collaborator", Short: "表协作者管理"}
	registerCollaboratorCommands(collaboratorCmd, f)
	cmd.AddCommand(collaboratorCmd)

	// `table share <set|get|off|shared-with-me>`：表格数据只读分享（与
	// `view form-share-*` 表单分享是两套独立系统，命名严格分离，见 share.go 顶部注释）。
	registerShareCommands(cmd, f)

	policyCmd := &cobra.Command{Use: "policy", Short: "行级安全策略（RLS）"}
	registerPolicyCommands(policyCmd, f)
	cmd.AddCommand(policyCmd)

	searchIndexCmd := &cobra.Command{Use: "search-index", Short: "全文索引管理"}
	registerSearchIndexCommands(searchIndexCmd, f)
	cmd.AddCommand(searchIndexCmd)

	// Wave 4a (2026-05-01)：`tabtin table skill *` 命令组已下架——后端
	// `field_executor.py` 已 DEPRECATED 卸载（field_executor / skill_field
	// 字段执行链整体退役），Go CLI 仍注册会形成 404 死链。
	// `registerSkillCommands` 函数与 `/table/skill-execute` 等 5 段路由（Go CLI
	// + cli-server Electron + Daemon）一并删除。

	// 命令树建完后 overlay 用户向能力总览元数据（Showcase / ShowcaseGroup），
	// 供 scripts/generate-tabdata-capabilities.py 导出前端 banner JSON。
	applyTableShowcaseRegistry(cmd)

	return cmd
}

func registerTopLevel(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "列出表格",
			Long: `分页列出当前 Space 下的表格，支持关键词搜索、归档过滤。
设计理由：list 是 TabData 入口——先拿 table-id 再调 record/field/view 子命令；
返回含 default_view_id / field_count，便于 Agent 判断表规模。
常见陷阱：软删表不在 list 里，需 ` + "`tabtin table trash list`" + `；` + "`restore`" + ` 是解归档、` + "`trash restore`" + ` 是从回收站恢复，动词不同。`,
			Example: "  tabtin table list\n" +
				"  tabtin table list --search 用户 --page-size 20\n" +
				"  tabtin table list --archived --format json",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/list",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: AdaptTableList,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "search", Short: "q", Type: cmdutil.FlagString, Desc: "搜索关键词"},
				{Name: "page", Type: cmdutil.FlagInt, Default: 1, Desc: "页码"},
				{Name: "page-size", Type: cmdutil.FlagInt, Default: 50, Desc: "每页数量"},
				{Name: "archived", Type: cmdutil.FlagBool, Desc: "显示已归档表格"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
		},
		{
			Use: "create", Short: "创建表格",
			Long: `在当前 Organization 新建一张表，可选自定义字段或使用默认「标题」字段。
设计理由：create 返回 table-id，是 smoke 主链第一步；--use-default-fields 适合
快速探针，--fields 适合建模时一次性声明 schema。
常见陷阱：create 只建表结构，不写记录——数据写入走 record insert；软删用 delete，
物理清除需 trash permanent + --yes。
要挂到知识库侧栏某父资源下时传 --parent-item-id（ContextItem ID）；不传则落在根级。`,
			Example: "  tabtin table create --name \"用户表\"\n" +
				"  tabtin table create --name \"子表\" --parent-item-id <context_item_id>\n" +
				"  tabtin table create --name \"订单表\" --description \"存储订单数据\" --use-default-fields\n" +
				"  tabtin table create --name \"融资\" --fields '[{\"name\":\"日期\",\"field_type\":\"date\"},{\"name\":\"公司\",\"field_type\":\"text\"}]' --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/create",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptTableCreate,
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "表名"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "描述"},
				{Name: "icon", Type: cmdutil.FlagString, Desc: "图标"},
				{Name: "parent-item-id", Type: cmdutil.FlagString, Desc: "知识库树父 ContextItem ID（写入 ContextItem.parent；侧栏挂子资源用这个）"},
				{Name: "fields", Type: cmdutil.FlagString, Desc: "字段定义 JSON 数组，如 [{\"name\":\"名称\",\"field_type\":\"text\"}]"},
				{Name: "use-default-fields", Type: cmdutil.FlagBool, Desc: "使用默认字段"},
			},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				body := map[string]any{
					"name":               ctx.Str("name"),
					"description":        ctx.Str("description"),
					"icon":               ctx.Str("icon"),
					"fields":             ctx.Str("fields"),
					"use_default_fields": ctx.Bool("use-default-fields"),
				}
				if v := ctx.Str("parent-item-id"); v != "" {
					body["parent_item_id"] = v
				}
				return cmdutil.NewDryRunPlan().
					Desc("创建表格 "+ctx.Str("name")).
					Step("POST", "/table/create", body)
			},
		},
		{
			Use: "move", Short: "在知识库树中移动表格",
			Long: `把已有表格挂到知识库侧栏的新父资源下，或移到根级。
设计理由：create --parent-item-id 只覆盖新建；改挂走 ContextItem.parent。
本命令用 --table-id 反查 ContextItem，免去 Agent 手查 item id。
常见陷阱：--parent-item-id 传父 ContextItem ID（不是 table-id）；落根用 --root。
需全局 --organization-id。`,
			Example: "  tabtin table move --table-id <table_id> --parent-item-id <context_item_id>\n" +
				"  tabtin table move --table-id <table_id> --root\n" +
				"  tabtin table move --table-id <table_id> --parent-item-id <context_item_id> --dry-run",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Route:        cmdutil.RouteCliServer,
			HasFormat:    true,
			RequiresAuth: true,
			Conflicts: map[string][]string{
				"parent-item-id": {"root"},
				"root":           {"parent-item-id"},
			},
			RequiresOneOf: [][]string{{"parent-item-id", "root"}},
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "parent-item-id", Type: cmdutil.FlagString, Desc: "新的父 ContextItem ID（知识库树）"},
				{Name: "root", Type: cmdutil.FlagBool, Desc: "移到知识库根级（parent_id=null）"},
			},
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				body := knowledgetree.ParentPatchBody(ctx.Str("parent-item-id"), ctx.Bool("root"))
				return cmdutil.NewDryRunPlan().
					Desc("移动表格在知识库树中的位置（先解析 ContextItem，再 PATCH parent）").
					Step("GET", "/api/context/organizations/{org}/context-items?item_type=tabdata", map[string]any{
						"resolve_resource_id": ctx.Str("table-id"),
					}).
					Step("PATCH", "/api/context/context-items/{resolved_item_id}", body)
			},
			RunFunc: tableMoveFunc(f),
		},
		{
			Use: "info", Short: "表格详情",
			Long: `取单张表的元数据（名称、描述、归档/回收状态、默认视图等）。
设计理由：info 比 list 字段更全，改表属性前或确认 trashed/archived 状态时先读。
常见陷阱：info 不返回记录行——记录数用 stats 或 record list。`,
			Example: "  tabtin table info --table-id <table_id>\n" +
				"  tabtin table info --table-id <table_id> --format json\n" +
				"  tabtin table info --table-id <table_id> --jq '.name'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/info",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: adaptTableInfo,
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
		},
		{
			Use: "update", Short: "更新表格属性",
			Long: `修改表级元数据（名称、描述、图标），不改字段 schema 与记录数据。
设计理由：与 field add/update 分工——本命令只动 Table 对象属性。
常见陷阱：改字段结构走 field 子命令；rename 表不影响 record-id 与 field-id。`,
			Example: "  tabtin table update --table-id <table_id> --name \"新表名\"\n" +
				"  tabtin table update --table-id <table_id> --description \"新的表格说明\"\n" +
				"  tabtin table update --table-id <table_id> --name \"新表名\" --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/update-table",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "name", Type: cmdutil.FlagString, Desc: "新名称"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "新描述"},
				{Name: "icon", Type: cmdutil.FlagString, Desc: "新图标"},
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("更新表格属性 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/update-table", map[string]any{
						"table_id":    ctx.Str("table-id"),
						"name":        ctx.Str("name"),
						"description": ctx.Str("description"),
						"icon":        ctx.Str("icon"),
					})
			},
		},
		{
			Use: "delete", Short: "删除表格（软删，移入回收站）",
			Long: `软删除表格——数据移入回收站，可用 trash restore 恢复。
设计理由：与 trash permanent（不可逆）形成两级删除；比硬删更安全，Agent 应优先本命令。
常见陷阱：delete 是进回收站，不是 record delete；解归档用 restore，回收站恢复用 trash restore。`,
			Example: "  tabtin table delete --table-id <table_id>\n" +
				"  # 找回：tabtin table trash restore --table-id <table_id>\n" +
				"  tabtin table delete --table-id <table_id> --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/delete-table",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("软删表格（移入回收站，可 trash restore）").
					Step("POST", "/table/delete-table", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "archive", Short: "归档表格",
			Long: `将表标记为已归档（is_archived），通常从默认 list 隐藏，与回收站正交。
设计理由：archive 适合「暂不用但保留」场景，不删数据；与 delete→trash 是不同维度。
常见陷阱：archive 不等于 delete；解归档用 restore（非 trash restore）。`,
			Example: "  tabtin table archive --table-id <table_id>\n" +
				"  tabtin table archive --table-id <table_id> --dry-run\n" +
				"  tabtin table list --archived  # 归档后在此查看",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/archive",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("归档表格 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/archive", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "restore", Short: "恢复表格（解归档）",
			Long: `解除表格归档状态（is_archived=false），不是从回收站恢复。
设计理由：与 trash restore 动词碰撞——本命令只处理 archive 维度；回收站表走 trash 子组。
常见陷阱：表在回收站时用 trash restore；仅归档时用本命令。`,
			Example: "  tabtin table restore --table-id <table_id>\n" +
				"  tabtin table restore --table-id <table_id> --dry-run\n" +
				"  # 回收站恢复：tabtin table trash restore --table-id <table_id>",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/restore",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				return cmdutil.NewDryRunPlan().
					Desc("解归档表格 table-id="+ctx.Str("table-id")).
					Step("POST", "/table/restore", map[string]any{
						"table_id": ctx.Str("table-id"),
					})
			},
		},
		{
			Use: "stats", Short: "表格统计",
			Long: `返回表的记录数、字段数等聚合统计，只读。
设计理由：大表操作前先 stats 评估规模，避免 record list 一次拉全表。
常见陷阱：stats 是快照，并发写入时数字可能略滞后。`,
			Example: "  tabtin table stats --table-id <table_id>\n" +
				"  tabtin table stats --table-id <table_id> --format json\n" +
				"  tabtin table stats --table-id <table_id> --jq '.record_count'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/stats",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags:     []cmdutil.FlagDef{{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"}},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "query [sql]", Short: "只读 SQL 查询",
			Long: `对 Space 内 TabData 表执行只读 SQL（SELECT），TabTin 特色能力。
设计理由：跨表只读分析、复杂筛选比多次 record list 更高效；与 execute 严格分工。
常见陷阱：query 拒绝写语句——UPDATE/DELETE 走 execute 并带确认 flag。`,
			Example: "  tabtin table query \"SELECT * FROM users LIMIT 10\"\n" +
				"  tabtin table query --sql \"SELECT count(*) FROM orders\"\n" +
				"  tabtin table query \"SELECT * FROM t WHERE id=$1\" --params '[\"uuid\"]'",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/query",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			ArgsMapping: []string{"sql"},
			Flags: []cmdutil.FlagDef{
				{Name: "sql", Type: cmdutil.FlagString, Desc: "SQL 语句（也可作为位置参数）"},
				{Name: "params", Type: cmdutil.FlagString, Desc: "SQL 参数 JSON"},
			},
			HasFormat: true, RequiresAgent: true,
		},
		{
			Use: "execute [sql]", Short: "执行写 SQL",
			Long: `执行 INSERT/UPDATE/DELETE 等写 SQL；DELETE 需 --allow-delete，DDL 需 --allow-ddl。
设计理由：批量改数/复杂条件更新时比逐条 record update 高效，但风险更高。
常见陷阱：--allow-ddl 是 CLI 侧门禁，后端仍可能拒绝 DDL；DELETE 不带 flag 会被 Validate 拦截。`,
			Example: "  tabtin table execute \"UPDATE orders SET status='done' WHERE id='ord_1'\"\n" +
				"  tabtin table execute \"DELETE FROM orders WHERE id='ord_1'\" --allow-delete\n" +
				"  tabtin table execute \"UPDATE orders SET status='done' WHERE id='ord_1'\" --dry-run",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/execute",
			Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"sql"},
			Flags: []cmdutil.FlagDef{
				{Name: "sql", Type: cmdutil.FlagString, Desc: "SQL 语句"},
				{Name: "params", Type: cmdutil.FlagString, Desc: "SQL 参数 JSON"},
				{Name: "allow-delete", Type: cmdutil.FlagBool, Desc: "允许 DELETE 操作"},
				{Name: "allow-ddl", Type: cmdutil.FlagBool, Desc: "允许执行 DDL 语句", CliOnly: true},
			},
			Validate: func(ctx *cmdutil.RunContext) error {
				sql, _ := ctx.FlagValues["sql"].(string)
				if sql == "" && len(ctx.Args) > 0 {
					sql = ctx.Args[0]
				}
				upper := strings.ToUpper(strings.TrimSpace(sql))
				ddlPatterns := []string{"DROP ", "TRUNCATE ", "ALTER TABLE"}
				for _, p := range ddlPatterns {
					if strings.Contains(upper, p) {
						if allow, _ := ctx.FlagValues["allow-ddl"].(bool); !allow {
							return fmt.Errorf("检测到破坏性 SQL (%s)，请使用 --allow-ddl 确认", strings.TrimSpace(p))
						}
						break
					}
				}
				if strings.HasPrefix(upper, "DELETE ") {
					if allow, _ := ctx.FlagValues["allow-delete"].(bool); !allow {
						return fmt.Errorf("检测到 DELETE 操作，请使用 --allow-delete 确认")
					}
				}
				return nil
			},
			HasFormat: true, RequiresAgent: true,
			DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
				sql := ctx.Str("sql")
				if sql == "" && len(ctx.Args) > 0 {
					sql = ctx.Args[0]
				}
				return cmdutil.NewDryRunPlan().
					Desc("执行写 SQL（预演不跑 Validate 门禁）").
					Step("POST", "/table/execute", map[string]any{
						"sql":          sql,
						"params":       ctx.Str("params"),
						"allow_delete": ctx.Bool("allow-delete"),
						"allow_ddl":    ctx.Bool("allow-ddl"),
					})
			},
		},
		{
			Use: "search", Short: "全文搜索",
			Long: `在单表全文索引中搜索关键词，可限定字段或视图。
设计理由：比 SQL LIKE 更适合中文分词/索引场景；与 search-index 子组（索引管理）分工。
常见陷阱：需表已建搜索索引；无索引时可能空结果或报错，先 search-index status 排查。`,
			Example: "  tabtin table search --table-id <table_id> --search \"关键词\"\n" +
				"  tabtin table search --table-id <table_id> --search \"关键词\" --field-id <field_id>\n" +
				"  tabtin table search --table-id <table_id> --search \"关键词\" --take 20",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/search",
			Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "表格 ID"},
				{Name: "search", Short: "q", Type: cmdutil.FlagString, Required: true, Desc: "搜索关键词"},
				{Name: "field-id", Type: cmdutil.FlagString, Desc: "限定搜索字段"},
				{Name: "view-id", Type: cmdutil.FlagString, Desc: "限定视图"},
				{Name: "take", Type: cmdutil.FlagInt, Default: 100, Desc: "返回数量"},
			},
			HasFormat: true, RequiresAgent: true,
		},
	}

	for _, def := range defs {
		cmdutil.MustRegisterCommand(parent, f, def)
	}
}
