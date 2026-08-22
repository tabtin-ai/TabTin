package cmd

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// Tracker / 自动化 能力总览分组 id 闭集——前端 / CI / 生成脚本共用同一份顺序与中文 label。
// 设计取向：镜像 browser_showcase.go——按「用户脑子里要干的事」分组（创建 / 查看 / 控制 /
// 验证与删除），而不是按 CLI 子命令树机械拆。前者是「我想干嘛」的用户视角。
const (
	trackerShowcaseGroupCreate  = "create"
	trackerShowcaseGroupInspect = "inspect"
	trackerShowcaseGroupControl = "control"
	trackerShowcaseGroupVerify  = "verify"
)

var trackerShowcaseGroupOrder = []string{
	trackerShowcaseGroupCreate,
	trackerShowcaseGroupInspect,
	trackerShowcaseGroupControl,
	trackerShowcaseGroupVerify,
}

var trackerShowcaseGroupLabels = map[string]string{
	trackerShowcaseGroupCreate:  "创建自动化任务",
	trackerShowcaseGroupInspect: "查看与执行记录",
	trackerShowcaseGroupControl: "启停与触发",
	trackerShowcaseGroupVerify:  "试运行与删除",
}

// trackerShowcaseRegistry 以 `tracker <子路径>` 为 key（不含 `tabtin` 前缀），声明用户向展示分组。
// 未出现在 registry 也未出现在 hidden 的叶子命令 → CI 报漏登记（防 banner 与 CLI 全集脱节）。
//
// 取向：自动化的价值是「派活给 Agent + 全程可控」，因此创建 / 查看 / 控制 / 试运行
// 全部进总览——所有叶子命令悉数登记，hidden 留空（保留机制，未来真有内省向命令再放）。
var trackerShowcaseRegistry = map[string]string{
	// 创建自动化任务
	"new": trackerShowcaseGroupCreate,
	// 查看与执行记录
	"list":     trackerShowcaseGroupInspect,
	"show":     trackerShowcaseGroupInspect,
	"runs":     trackerShowcaseGroupInspect,
	"run-show": trackerShowcaseGroupInspect,
	// 启停与触发
	"activate":   trackerShowcaseGroupControl,
	"pause":      trackerShowcaseGroupControl,
	"resume":     trackerShowcaseGroupControl,
	"trigger":    trackerShowcaseGroupControl,
	"cancel-run": trackerShowcaseGroupControl,
	// 试运行与删除
	"dry-run": trackerShowcaseGroupVerify,
	"delete":  trackerShowcaseGroupVerify,
}

// trackerShowcaseHidden 明确不进用户向总览的 tracker 叶子命令。
// 当前 tracker 命令全部用户向、悉数登记，hidden 留空（保留机制）。
var trackerShowcaseHidden = map[string]struct{}{}

// TrackerFeaturedScenario 是首页 curated 示例卡：NL prompt 交给 Agent，commands 仅用于 CI 绑定真实 CLI。
type TrackerFeaturedScenario struct {
	Key         string   `json:"key"`
	Commands    []string `json:"commands"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Prompt      string   `json:"prompt"`
}

var trackerFeaturedScenarios = []TrackerFeaturedScenario{
	{
		Key:         "create",
		Commands:    []string{"tracker new"},
		Title:       "建一个自动化任务",
		Description: "说清多久跑一次、做什么，让 AI 帮你建好",
		Prompt:      "帮我创建一个自动化任务。",
	},
	{
		Key:         "inspect",
		Commands:    []string{"tracker list", "tracker runs"},
		Title:       "看任务跑得怎么样",
		Description: "汇总当前自动化任务和它们的执行记录",
		Prompt:      "帮我看看当前 Space 下都有哪些自动化任务、各自跑得怎么样。先用 `tabtin tracker list` 列出来，挑出最近有执行的，再用 `tabtin tracker runs` 看它们的执行记录，把状态和结果整理成一份简报给我。",
	},
	{
		Key:         "control",
		Commands:    []string{"tracker pause", "tracker resume"},
		Title:       "暂停 / 恢复某个任务",
		Description: "先确认是哪一个，再启停它",
		Prompt:      "帮我暂停或恢复一个自动化任务。先用 `tabtin tracker list` 列出来让我确认是哪一个，再用 `tabtin tracker pause` 暂停或 `tabtin tracker resume` 恢复，操作完告诉我它现在的状态。",
	},
	{
		Key:         "verify",
		Commands:    []string{"tracker dry-run"},
		Title:       "试运行验证触发",
		Description: "回放最近事件看触发条件是否命中（不真执行）",
		Prompt:      "帮我试运行一个事件触发型的自动化任务，确认它的触发条件是否符合预期（不要真的执行 Skill）。先用 `tabtin tracker list` 确认是哪一个，再用 `tabtin tracker dry-run` 回放最近几个事件，把命中情况讲给我听。",
	},
}

type trackerShowcaseGroupJSON struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Order int    `json:"order"`
}

type trackerShowcaseCommandJSON struct {
	Name       string `json:"name"`
	Short      string `json:"short"`
	Long       string `json:"long"`
	Risk       string `json:"risk,omitempty"`
	Group      string `json:"group"`
	GroupLabel string `json:"group_label"`
}

// TrackerShowcaseManifest 供前端消费的能力总览 JSON（由 scripts/generate-tracker-capabilities.py 生成落盘）。
type TrackerShowcaseManifest struct {
	Version  int                          `json:"version"`
	Groups   []trackerShowcaseGroupJSON   `json:"groups"`
	Commands []trackerShowcaseCommandJSON `json:"commands"`
	Featured []TrackerFeaturedScenario    `json:"featured"`
}

func trackerRelativePath(leaf *cobra.Command) string {
	path := leaf.CommandPath()
	path = strings.TrimPrefix(path, "tabtin tracker ")
	path = strings.TrimPrefix(path, "tracker ")
	return strings.TrimSpace(path)
}

func walkLeafTrackerCommands(root *cobra.Command) []*cobra.Command {
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

func applyTrackerShowcaseRegistry(root *cobra.Command) {
	for _, leaf := range walkLeafTrackerCommands(root) {
		rel := trackerRelativePath(leaf)
		if _, hidden := trackerShowcaseHidden[rel]; hidden {
			continue
		}
		group, ok := trackerShowcaseRegistry[rel]
		if !ok {
			continue
		}
		cmdutil.SetCommandShowcase(leaf, true, group)
	}
}

func buildTrackerShowcaseManifest() TrackerShowcaseManifest {
	groups := make([]trackerShowcaseGroupJSON, 0, len(trackerShowcaseGroupOrder))
	for i, id := range trackerShowcaseGroupOrder {
		groups = append(groups, trackerShowcaseGroupJSON{
			ID:    id,
			Label: trackerShowcaseGroupLabels[id],
			Order: i + 1,
		})
	}

	byName := map[string]cmdutil.CommandSchema{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		byName[schema.Name] = schema
	}

	commands := make([]trackerShowcaseCommandJSON, 0, len(trackerShowcaseRegistry))
	for rel, group := range trackerShowcaseRegistry {
		fullName := "tracker " + rel
		schema, ok := byName[fullName]
		if !ok {
			continue
		}
		commands = append(commands, trackerShowcaseCommandJSON{
			Name:       fullName,
			Short:      schema.Description,
			Long:       schema.Long,
			Risk:       schema.Risk,
			Group:      group,
			GroupLabel: trackerShowcaseGroupLabels[group],
		})
	}
	sort.Slice(commands, func(i, j int) bool {
		gi, gj := commands[i].Group, commands[j].Group
		if gi != gj {
			return indexOfTrackerGroup(gi) < indexOfTrackerGroup(gj)
		}
		return commands[i].Name < commands[j].Name
	})

	featured := make([]TrackerFeaturedScenario, len(trackerFeaturedScenarios))
	copy(featured, trackerFeaturedScenarios)

	return TrackerShowcaseManifest{
		Version:  1,
		Groups:   groups,
		Commands: commands,
		Featured: featured,
	}
}

func indexOfTrackerGroup(group string) int {
	for i, id := range trackerShowcaseGroupOrder {
		if id == group {
			return i
		}
	}
	return len(trackerShowcaseGroupOrder)
}

func marshalTrackerShowcaseManifest(m TrackerShowcaseManifest) ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}
