package cmd

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TabDoc 能力总览分组 id 闭集——前端 / CI / 生成脚本共用同一份顺序与中文 label。
const (
	docShowcaseGroupBrowse       = "browse"
	docShowcaseGroupCreateEdit   = "create_edit"
	docShowcaseGroupBlocks       = "blocks"
	docShowcaseGroupOrganize     = "organize"
	docShowcaseGroupVersion      = "version"
	docShowcaseGroupCollab       = "collab"
	docShowcaseGroupShare        = "share"
	docShowcaseGroupImportExport = "import_export"
)

var docShowcaseGroupOrder = []string{
	docShowcaseGroupBrowse,
	docShowcaseGroupCreateEdit,
	docShowcaseGroupBlocks,
	docShowcaseGroupOrganize,
	docShowcaseGroupVersion,
	docShowcaseGroupCollab,
	docShowcaseGroupShare,
	docShowcaseGroupImportExport,
}

var docShowcaseGroupLabels = map[string]string{
	docShowcaseGroupBrowse:       "浏览与搜索",
	docShowcaseGroupCreateEdit:   "创建与整篇编辑",
	docShowcaseGroupBlocks:       "块级精准编辑",
	docShowcaseGroupOrganize:     "组织与生命周期",
	docShowcaseGroupVersion:      "版本历史",
	docShowcaseGroupCollab:       "协作者",
	docShowcaseGroupShare:        "分享",
	docShowcaseGroupImportExport: "导入与导出",
}

// docShowcaseRegistry 以 `doc <子路径>` 为 key（不含 `tabtin` 前缀），声明用户向展示分组。
// 未出现在 registry 的叶子命令 → CI 报漏登记；Destructive 命令默认不进总览。
var docShowcaseRegistry = map[string]string{
	"list":                docShowcaseGroupBrowse,
	"search":              docShowcaseGroupBrowse,
	"search-blocks":       docShowcaseGroupBlocks,
	"read":                docShowcaseGroupBrowse,
	"chunks":              docShowcaseGroupBrowse,
	"list-blocks":         docShowcaseGroupBlocks,
	"read-block":          docShowcaseGroupBlocks,
	"read-section":        docShowcaseGroupBlocks,
	"create":              docShowcaseGroupCreateEdit,
	"save-content":        docShowcaseGroupCreateEdit,
	"update-block":        docShowcaseGroupBlocks,
	"format-text":         docShowcaseGroupBlocks,
	"highlight-text":      docShowcaseGroupBlocks,
	"insert-block":        docShowcaseGroupBlocks,
	"delete-block":        docShowcaseGroupBlocks,
	"append":              docShowcaseGroupBlocks,
	"embed-table":         docShowcaseGroupBlocks,
	"insert-image":        docShowcaseGroupBlocks,
	"insert-html":         docShowcaseGroupBlocks,
	"update-html":         docShowcaseGroupBlocks,
	"move":                docShowcaseGroupOrganize,
	"update":              docShowcaseGroupOrganize,
	"delete":              docShowcaseGroupOrganize,
	"trash":               docShowcaseGroupOrganize,
	"restore":             docShowcaseGroupOrganize,
	"unarchive":           docShowcaseGroupOrganize,
	"export":              docShowcaseGroupImportExport,
	"import markdown":     docShowcaseGroupImportExport,
	"import file":         docShowcaseGroupImportExport,
	"import job status":   docShowcaseGroupImportExport,
	"import job result":   docShowcaseGroupImportExport,
	"import job retry":    docShowcaseGroupImportExport,
	"import job cancel":   docShowcaseGroupImportExport,
	"comment list":        docShowcaseGroupCollab,
	"comment add":         docShowcaseGroupCollab,
	"comment reply":       docShowcaseGroupCollab,
	"comment resolve":     docShowcaseGroupCollab,
	"comment reopen":      docShowcaseGroupCollab,
	"comment reanchor":    docShowcaseGroupCollab,
	"comment create":      docShowcaseGroupCollab,
	"comment rm":          docShowcaseGroupCollab,
	"version list":        docShowcaseGroupVersion,
	"version preview":     docShowcaseGroupVersion,
	"version restore":     docShowcaseGroupVersion,
	"version save":        docShowcaseGroupVersion,
	"version rename":      docShowcaseGroupVersion,
	"collaborator list":   docShowcaseGroupCollab,
	"collaborator invite": docShowcaseGroupCollab,
	"collaborator update": docShowcaseGroupCollab,
	"collaborator rm":     docShowcaseGroupCollab,
	"share set":           docShowcaseGroupShare,
	"share get":           docShowcaseGroupShare,
	"share off":           docShowcaseGroupShare,
	"share refresh":       docShowcaseGroupShare,
	"shared-with-me":      docShowcaseGroupShare,
}

// docShowcaseHidden 明确不进用户向总览的 doc 叶子命令（Destructive / 高阶运维）。
var docShowcaseHidden = map[string]struct{}{
	"permanent-delete": {},
	"version rm":       {},
	// 权限全量 replace：危险运维面，showcase 隐藏；命令仍可显式调用
	"perm get": {},
	"perm set": {},
}

// DocFeaturedScenario 是首页 curated 示例卡：NL prompt 交给 Agent，commands 仅用于 CI 绑定真实 CLI。
type DocFeaturedScenario struct {
	Key         string   `json:"key"`
	Commands    []string `json:"commands"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Prompt      string   `json:"prompt"`
}

var docFeaturedScenarios = []DocFeaturedScenario{
	{
		Key:         "create",
		Commands:    []string{"doc create", "doc save-content"},
		Title:       "搭一篇新文档",
		Description: "说个主题，让 AI 先搭好结构和大纲",
		Prompt:      "帮我新建一篇文档。我给你主题，你先搭好整体结构、列出大纲，再逐节把内容写出来。",
	},
	{
		Key:         "summarize",
		Commands:    []string{"doc search", "doc read"},
		Title:       "汇总多篇文档",
		Description: "把相关文档整理成一篇综述",
		Prompt:      "把这个空间里相关的几篇文档梳理、汇总成一篇结构清晰的综述文档。先搜一下有哪些相关文档，再告诉我你的整合思路。",
	},
	{
		Key:         "report",
		Commands:    []string{"doc create", "doc save-content"},
		Title:       "用数据生成报告",
		Description: "根据多维表数据写一份分析文档",
		Prompt:      "根据这个空间里的多维表数据，生成一份分析报告文档，并把关键数据表嵌进文档里。先看看有哪些表可用。",
	},
	{
		Key:         "polish",
		Commands:    []string{"doc list", "doc search-blocks", "doc read-block", "doc update-block"},
		Title:       "润色与校对",
		Description: "找出表达不清、错漏处并改好",
		Prompt:      "帮我检查并润色一篇现有文档：找出表达不清、啰嗦或有错漏的地方，逐处改好并说明改动理由。先列一下空间里的文档让我选。",
	},
}

type docShowcaseGroupJSON struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Order int    `json:"order"`
}

type docShowcaseCommandJSON struct {
	Name       string `json:"name"`
	Short      string `json:"short"`
	Long       string `json:"long"`
	Risk       string `json:"risk,omitempty"`
	Group      string `json:"group"`
	GroupLabel string `json:"group_label"`
}

// DocShowcaseManifest 供前端消费的能力总览 JSON（由 scripts/generate-tabdoc-capabilities.py 生成落盘）。
type DocShowcaseManifest struct {
	Version  int                      `json:"version"`
	Groups   []docShowcaseGroupJSON   `json:"groups"`
	Commands []docShowcaseCommandJSON `json:"commands"`
	Featured []DocFeaturedScenario    `json:"featured"`
}

func docRelativePath(leaf *cobra.Command) string {
	path := leaf.CommandPath()
	path = strings.TrimPrefix(path, "tabtin doc ")
	path = strings.TrimPrefix(path, "doc ")
	return strings.TrimSpace(path)
}

func walkLeafDocCommands(root *cobra.Command) []*cobra.Command {
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

func applyDocShowcaseRegistry(root *cobra.Command) {
	for _, leaf := range walkLeafDocCommands(root) {
		rel := docRelativePath(leaf)
		if _, hidden := docShowcaseHidden[rel]; hidden {
			continue
		}
		group, ok := docShowcaseRegistry[rel]
		if !ok {
			continue
		}
		cmdutil.SetCommandShowcase(leaf, true, group)
	}
}

func buildDocShowcaseManifest() DocShowcaseManifest {
	groups := make([]docShowcaseGroupJSON, 0, len(docShowcaseGroupOrder))
	for i, id := range docShowcaseGroupOrder {
		groups = append(groups, docShowcaseGroupJSON{
			ID:    id,
			Label: docShowcaseGroupLabels[id],
			Order: i + 1,
		})
	}

	byName := map[string]cmdutil.CommandSchema{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		byName[schema.Name] = schema
	}

	commands := make([]docShowcaseCommandJSON, 0, len(docShowcaseRegistry))
	for rel, group := range docShowcaseRegistry {
		fullName := "doc " + rel
		schema, ok := byName[fullName]
		if !ok {
			continue
		}
		commands = append(commands, docShowcaseCommandJSON{
			Name:       fullName,
			Short:      schema.Description,
			Long:       schema.Long,
			Risk:       schema.Risk,
			Group:      group,
			GroupLabel: docShowcaseGroupLabels[group],
		})
	}
	sort.Slice(commands, func(i, j int) bool {
		gi, gj := commands[i].Group, commands[j].Group
		if gi != gj {
			return indexOfGroup(gi) < indexOfGroup(gj)
		}
		return commands[i].Name < commands[j].Name
	})

	featured := make([]DocFeaturedScenario, len(docFeaturedScenarios))
	copy(featured, docFeaturedScenarios)

	return DocShowcaseManifest{
		Version:  1,
		Groups:   groups,
		Commands: commands,
		Featured: featured,
	}
}

func indexOfGroup(group string) int {
	for i, id := range docShowcaseGroupOrder {
		if id == group {
			return i
		}
	}
	return len(docShowcaseGroupOrder)
}

func marshalDocShowcaseManifest(m DocShowcaseManifest) ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}
