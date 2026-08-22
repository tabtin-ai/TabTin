package table

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TabData 能力总览分组 id 闭集——前端 / CI / 生成脚本共用同一份顺序与中文 label。
const (
	tableShowcaseGroupTables         = "tables"
	tableShowcaseGroupRecords        = "records"
	tableShowcaseGroupFields         = "fields"
	tableShowcaseGroupViews          = "views"
	tableShowcaseGroupSQL            = "sql"
	tableShowcaseGroupRelations      = "relations"
	tableShowcaseGroupImportExport   = "import_export"
	tableShowcaseGroupVersionHistory = "version_history"
	tableShowcaseGroupOrganize       = "organize"
	tableShowcaseGroupShare          = "share"
	tableShowcaseGroupDataShare      = "data_share"
)

var tableShowcaseGroupOrder = []string{
	tableShowcaseGroupTables,
	tableShowcaseGroupRecords,
	tableShowcaseGroupFields,
	tableShowcaseGroupViews,
	tableShowcaseGroupSQL,
	tableShowcaseGroupRelations,
	tableShowcaseGroupImportExport,
	tableShowcaseGroupVersionHistory,
	tableShowcaseGroupOrganize,
	tableShowcaseGroupShare,
	tableShowcaseGroupDataShare,
}

var tableShowcaseGroupLabels = map[string]string{
	tableShowcaseGroupTables:         "表管理",
	tableShowcaseGroupRecords:        "记录",
	tableShowcaseGroupFields:         "字段",
	tableShowcaseGroupViews:          "视图",
	tableShowcaseGroupSQL:            "数据查询",
	tableShowcaseGroupRelations:      "关联与层级",
	tableShowcaseGroupImportExport:   "导入与导出",
	tableShowcaseGroupVersionHistory: "版本与历史",
	tableShowcaseGroupOrganize:       "组织与回收站",
	tableShowcaseGroupShare:          "表单分享",
	tableShowcaseGroupDataShare:      "数据分享",
}

// tableShowcaseRegistry 以 `table <子路径>` 为 key（不含 `tabtin` 前缀），声明用户向展示分组。
// 未出现在 registry 也未出现在 hidden 的叶子命令 → CI 报漏登记。
// 精选取向（与用户拍板的「curated」一致）：运维向（webhook/token/policy）、纯前端交互
// （reorder/undo-stack）、Agent 内部辅助查询（link helper、sub-record 父字段管理）、
// 不可逆运维（permanent / snapshot 迁移）放 hidden；高频「你能做什么」留 showcase。
var tableShowcaseRegistry = map[string]string{
	// 表管理
	"list":   tableShowcaseGroupTables,
	"create": tableShowcaseGroupTables,
	"info":   tableShowcaseGroupTables,
	"update": tableShowcaseGroupTables,
	"stats":  tableShowcaseGroupTables,
	"search": tableShowcaseGroupTables,
	// 记录
	"record list":                       tableShowcaseGroupRecords,
	"record detail":                     tableShowcaseGroupRecords,
	"record insert":                     tableShowcaseGroupRecords,
	"record update":                     tableShowcaseGroupRecords,
	"record update-by-filter preflight": tableShowcaseGroupRecords,
	"record update-by-filter commit":    tableShowcaseGroupRecords,
	"record delete":                     tableShowcaseGroupRecords,
	"record comment list":               tableShowcaseGroupRecords,
	"record comment create":             tableShowcaseGroupRecords,
	"record comment reply":              tableShowcaseGroupRecords,
	"record comment resolve":            tableShowcaseGroupRecords,
	"record comment reopen":             tableShowcaseGroupRecords,
	"record comment rm":                 tableShowcaseGroupRecords,
	"record upsert":                     tableShowcaseGroupRecords,
	"record bulk-insert":                tableShowcaseGroupRecords,
	// 字段
	"field list":     tableShowcaseGroupFields,
	"field detail":   tableShowcaseGroupFields,
	"field add":      tableShowcaseGroupFields,
	"field update":   tableShowcaseGroupFields,
	"field delete":   tableShowcaseGroupFields,
	"field convert":  tableShowcaseGroupFields,
	"field bulk-add": tableShowcaseGroupFields,
	// 视图
	"view list":        tableShowcaseGroupViews,
	"view detail":      tableShowcaseGroupViews,
	"view create":      tableShowcaseGroupViews,
	"view update":      tableShowcaseGroupViews,
	"view delete":      tableShowcaseGroupViews,
	"view records":     tableShowcaseGroupViews,
	"view set-default": tableShowcaseGroupViews,
	"view statistics":  tableShowcaseGroupViews,
	// 数据查询
	"query":   tableShowcaseGroupSQL,
	"execute": tableShowcaseGroupSQL,
	// 关联与层级
	"link create":           tableShowcaseGroupRelations,
	"link set":              tableShowcaseGroupRelations,
	"link add":              tableShowcaseGroupRelations,
	"link remove":           tableShowcaseGroupRelations,
	"link list":             tableShowcaseGroupRelations,
	"link populate-choices": tableShowcaseGroupRelations,
	"sub-record create":     tableShowcaseGroupRelations,
	"sub-record move":       tableShowcaseGroupRelations,
	// 导入与导出
	"import csv":      tableShowcaseGroupImportExport,
	"import json":     tableShowcaseGroupImportExport,
	"import excel":    tableShowcaseGroupImportExport,
	"import file":     tableShowcaseGroupImportExport,
	"import preview":  tableShowcaseGroupImportExport,
	"import template": tableShowcaseGroupImportExport,
	"export csv":      tableShowcaseGroupImportExport,
	"export json":     tableShowcaseGroupImportExport,
	"export excel":    tableShowcaseGroupImportExport,
	"export pdf":      tableShowcaseGroupImportExport,
	// 异步导出闭环：wait / download 是用户拿到产物必经的两步，进 showcase；
	// stats 只是"要不要走 --async"的内部决策辅助，放 hidden。
	"export wait":     tableShowcaseGroupImportExport,
	"export download": tableShowcaseGroupImportExport,
	// 版本与历史
	"record history":   tableShowcaseGroupVersionHistory,
	"version list":     tableShowcaseGroupVersionHistory,
	"version create":   tableShowcaseGroupVersionHistory,
	"version rename":   tableShowcaseGroupVersionHistory,
	"history list":     tableShowcaseGroupVersionHistory,
	"history snapshot": tableShowcaseGroupVersionHistory,
	"history restore":  tableShowcaseGroupVersionHistory,
	"history undo":     tableShowcaseGroupVersionHistory,
	"history redo":     tableShowcaseGroupVersionHistory,
	// 组织与回收站
	"move":          tableShowcaseGroupOrganize,
	"delete":        tableShowcaseGroupOrganize,
	"archive":       tableShowcaseGroupOrganize,
	"restore":       tableShowcaseGroupOrganize,
	"trash list":    tableShowcaseGroupOrganize,
	"trash restore": tableShowcaseGroupOrganize,
	// 表单分享
	"view form-share-enable":  tableShowcaseGroupShare,
	"view form-share-disable": tableShowcaseGroupShare,
	"view form-share-rotate":  tableShowcaseGroupShare,
	// 数据分享（只读外链，与上面的表单分享是两套独立系统）
	"share set":            tableShowcaseGroupDataShare,
	"share get":            tableShowcaseGroupDataShare,
	"share off":            tableShowcaseGroupDataShare,
	"share shared-with-me": tableShowcaseGroupDataShare,
}

// tableShowcaseHidden 明确不进用户向总览的 table 叶子命令。
// 分四类：运维向（webhook/token）、纯前端交互（reorder/undo-stack/reorder-tree）、
// Agent 内部辅助（link helper / sub-record 父字段管理 / field 转换预检）、
// 不可逆或工作区级迁移（permanent / snapshot / version delete）、公开表单访问（form *）。
var tableShowcaseHidden = map[string]struct{}{
	// 记录：UI 拖拽 / 撤销重做
	"record reorder": {},
	"record undo":    {},
	"record redo":    {},
	// 字段：排序 + 转换预检 / 影响分析（高阶辅助）
	"field reorder":               {},
	"field check":                 {},
	"field preview":               {},
	"field explain":               {},
	"field delete-references":     {},
	"field conversion-references": {},
	// 关联：候选查询 / update 偏 Agent 内部；create/set/add/remove/list 进 showcase
	"link linkable-records": {},
	"link linkable-fields":  {},
	"link update":           {},
	// sub-record：父字段管理（建模辅助）+ 树拖拽
	"sub-record parent-field":        {},
	"sub-record ensure-parent-field": {},
	"sub-record self-link-fields":    {},
	"sub-record reorder-tree":        {},
	// 视图：排序
	"view reorder": {},
	// 附件：niche / 运维
	"attachment list":   {},
	"attachment upload": {},
	"attachment reuse":  {},
	"attachment delete": {},
	// Webhook：运维
	"webhook list":   {},
	"webhook create": {},
	"webhook update": {},
	"webhook delete": {},
	"webhook test":   {},
	// 版本：不可逆删除
	"version delete": {},
	// 历史：撤销/重做栈（UI 内部）
	"history undo-stack": {},
	"history redo-stack": {},
	// 导入导出：工作区级快照迁移
	"import snapshot": {},
	"export snapshot": {},
	// 导出体积预检：决定要不要 --async 的辅助查询，不是用户目标本身
	"export stats": {},
	// Token：运维
	"token list":       {},
	"token create":     {},
	"token update":     {},
	"token delete":     {},
	"token regenerate": {},
	"token detail":     {},
	"token scopes":     {},
	// 公开表单访问（多数无需登录，非空间用户向）
	"form get":           {},
	"form verify":        {},
	"form submit":        {},
	"form submit-direct": {},
	"form link-records":  {},
	"form collaborators": {},
	// 回收站：永久删除（不可逆）
	"trash permanent": {},
	// 协作者：权限管理（运维向）
	"collaborator list":   {},
	"collaborator invite": {},
	"collaborator update": {},
	"collaborator remove": {},
	// 行级安全策略：运维向
	"policy list":       {},
	"policy create":     {},
	"policy update":     {},
	"policy delete":     {},
	"policy rls-toggle": {},
	// 全文索引：运维 / 排障向
	"search-index status": {},
	"search-index toggle": {},
	"search-index repair": {},
	"search-index query":  {},
}

// TableFeaturedScenario 是首页 curated 示例卡：NL prompt 交给 Agent，commands 仅用于 CI 绑定真实 CLI。
type TableFeaturedScenario struct {
	Key         string   `json:"key"`
	Commands    []string `json:"commands"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Prompt      string   `json:"prompt"`
}

var tableFeaturedScenarios = []TableFeaturedScenario{
	{
		Key:         "build",
		Commands:    []string{"table create", "table field bulk-add"},
		Title:       "搭一张新表",
		Description: "说用途，让 AI 设计字段结构并建好",
		Prompt:      "帮我建一张新的多维表。我给你说用途，你先设计好字段结构（字段名 + 类型）、把表建出来，再填几行示例数据让我看看效果。",
	},
	{
		Key:         "import",
		Commands:    []string{"table import preview", "table import csv"},
		Title:       "导入数据建表",
		Description: "把 CSV / Excel 数据导入成多维表",
		Prompt:      "我有一份数据要导入成多维表。先帮我预览一下字段和类型识别得对不对，确认没问题再正式导入。我待会儿把文件或内容给你。",
	},
	{
		Key:         "analyze",
		Commands:    []string{"table list", "table query"},
		Title:       "用 SQL 分析数据",
		Description: "查询、汇总表里的数据回答问题",
		Prompt:      "用 SQL 分析这个空间里的表数据来回答我的问题，并把关键结果整理清楚。先看看有哪些表和字段可用，再告诉我你的查询思路。",
	},
	{
		Key:         "model",
		Commands:    []string{"table link create", "table link add"},
		Title:       "关联两张表",
		Description: "用关联字段把相关的表连起来，并挂上目标行",
		Prompt:      "帮我把两张相关的表用关联字段连起来（比如电影↔演员、订单↔客户），并演示怎么搜索候选、挂上关联值。先看看现有的表结构再动手。",
	},
}

type tableShowcaseGroupJSON struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Order int    `json:"order"`
}

type tableShowcaseCommandJSON struct {
	Name       string `json:"name"`
	Short      string `json:"short"`
	Long       string `json:"long"`
	Risk       string `json:"risk,omitempty"`
	Group      string `json:"group"`
	GroupLabel string `json:"group_label"`
}

// TableShowcaseManifest 供前端消费的能力总览 JSON（由 scripts/generate-tabdata-capabilities.py 生成落盘）。
type TableShowcaseManifest struct {
	Version  int                        `json:"version"`
	Groups   []tableShowcaseGroupJSON   `json:"groups"`
	Commands []tableShowcaseCommandJSON `json:"commands"`
	Featured []TableFeaturedScenario    `json:"featured"`
}

func tableRelativePath(leaf *cobra.Command) string {
	path := leaf.CommandPath()
	path = strings.TrimPrefix(path, "tabtin table ")
	path = strings.TrimPrefix(path, "table ")
	return strings.TrimSpace(path)
}

func walkLeafTableCommands(root *cobra.Command) []*cobra.Command {
	var leaves []*cobra.Command
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		children := c.Commands()
		if len(children) == 0 {
			leaves = append(leaves, c)
			return
		}
		for _, sub := range children {
			walk(sub)
		}
	}
	walk(root)
	return leaves
}

func applyTableShowcaseRegistry(root *cobra.Command) {
	for _, leaf := range walkLeafTableCommands(root) {
		rel := tableRelativePath(leaf)
		if _, hidden := tableShowcaseHidden[rel]; hidden {
			continue
		}
		group, ok := tableShowcaseRegistry[rel]
		if !ok {
			continue
		}
		cmdutil.SetCommandShowcase(leaf, true, group)
	}
}

func buildTableShowcaseManifest() TableShowcaseManifest {
	groups := make([]tableShowcaseGroupJSON, 0, len(tableShowcaseGroupOrder))
	for i, id := range tableShowcaseGroupOrder {
		groups = append(groups, tableShowcaseGroupJSON{
			ID:    id,
			Label: tableShowcaseGroupLabels[id],
			Order: i + 1,
		})
	}

	byName := map[string]cmdutil.CommandSchema{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		byName[schema.Name] = schema
	}

	commands := make([]tableShowcaseCommandJSON, 0, len(tableShowcaseRegistry))
	for rel, group := range tableShowcaseRegistry {
		fullName := "table " + rel
		schema, ok := byName[fullName]
		if !ok {
			continue
		}
		commands = append(commands, tableShowcaseCommandJSON{
			Name:       fullName,
			Short:      schema.Description,
			Long:       schema.Long,
			Risk:       schema.Risk,
			Group:      group,
			GroupLabel: tableShowcaseGroupLabels[group],
		})
	}
	sort.Slice(commands, func(i, j int) bool {
		gi, gj := commands[i].Group, commands[j].Group
		if gi != gj {
			return indexOfTableGroup(gi) < indexOfTableGroup(gj)
		}
		return commands[i].Name < commands[j].Name
	})

	featured := make([]TableFeaturedScenario, len(tableFeaturedScenarios))
	copy(featured, tableFeaturedScenarios)

	return TableShowcaseManifest{
		Version:  1,
		Groups:   groups,
		Commands: commands,
		Featured: featured,
	}
}

func indexOfTableGroup(group string) int {
	for i, id := range tableShowcaseGroupOrder {
		if id == group {
			return i
		}
	}
	return len(tableShowcaseGroupOrder)
}

func marshalTableShowcaseManifest(m TableShowcaseManifest) ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}
