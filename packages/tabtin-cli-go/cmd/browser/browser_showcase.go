package browser

import (
	"encoding/json"
	"sort"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// TabWeb 能力总览分组 id 闭集——前端 / CI / 生成脚本共用同一份顺序与中文 label。
// 设计取向：按「回归一个浏览器能力时用户脑子里的动作」分组，而不是按 CLI 子命令树
// （tab/resource/stream/session/cookies/record/replay）机械拆——后者是实现视角，
// 前者是「我想干嘛」的用户视角。
const (
	browserShowcaseGroupNavigate = "navigate"
	browserShowcaseGroupRead     = "read"
	browserShowcaseGroupCapture  = "capture"
	browserShowcaseGroupInteract = "interact"
	browserShowcaseGroupTab      = "tab"
	browserShowcaseGroupSession  = "session"
	browserShowcaseGroupResource = "resource"
	browserShowcaseGroupRecord   = "record"
)

var browserShowcaseGroupOrder = []string{
	browserShowcaseGroupNavigate,
	browserShowcaseGroupRead,
	browserShowcaseGroupCapture,
	browserShowcaseGroupInteract,
	browserShowcaseGroupTab,
	browserShowcaseGroupSession,
	browserShowcaseGroupResource,
	browserShowcaseGroupRecord,
}

var browserShowcaseGroupLabels = map[string]string{
	browserShowcaseGroupNavigate: "打开与导航",
	browserShowcaseGroupRead:     "读取页面",
	browserShowcaseGroupCapture:  "截图与导出",
	browserShowcaseGroupInteract: "页面操作",
	browserShowcaseGroupTab:      "标签管理",
	browserShowcaseGroupSession:  "会话与 Cookie",
	browserShowcaseGroupResource: "资源与媒体",
	browserShowcaseGroupRecord:   "录制与回放",
}

// browserShowcaseRegistry 以 `browser <子路径>` 为 key（不含 `tabtin` 前缀），声明用户向展示分组。
// 未出现在 registry 也未出现在 hidden 的叶子命令 → CI 报漏登记（防 banner 与 CLI 全集脱节）。
//
// 取向：浏览器的价值是「回归所有能力」，因此默认全部进总览——所有叶子命令悉数登记，
// hidden 留空（保留机制，未来真有运维向命令再放）。
var browserShowcaseRegistry = map[string]string{
	// 打开与导航
	"open": browserShowcaseGroupNavigate,
	"home": browserShowcaseGroupNavigate,
	"nav":  browserShowcaseGroupNavigate,
	"wait": browserShowcaseGroupNavigate,
	// 读取页面（诊断）
	"network": browserShowcaseGroupRead,
	"console": browserShowcaseGroupRead,
	// 截图与导出（print = 导出页面内容）
	"print": browserShowcaseGroupCapture,
	// 页面操作（glance = 看交互，为 act/open 服务）
	"glance":        browserShowcaseGroupInteract,
	"act":           browserShowcaseGroupInteract,
	"batch":         browserShowcaseGroupInteract,
	"eval":          browserShowcaseGroupInteract,
	"clear-session": browserShowcaseGroupInteract,
	"random-ua":     browserShowcaseGroupInteract,
	"route":         browserShowcaseGroupInteract,
	"route-list":    browserShowcaseGroupInteract,
	"unroute":       browserShowcaseGroupInteract,
	// 标签管理
	"tab list":   browserShowcaseGroupTab,
	"tab switch": browserShowcaseGroupTab,
	"tab close":  browserShowcaseGroupTab,
	"tab state":  browserShowcaseGroupTab,
	// 会话与 Cookie
	"session list":      browserShowcaseGroupSession,
	"session create":    browserShowcaseGroupSession,
	"session switch":    browserShowcaseGroupSession,
	"session close":     browserShowcaseGroupSession,
	"session close-all": browserShowcaseGroupSession,
	"session save":      browserShowcaseGroupSession,
	"session load":      browserShowcaseGroupSession,
	"cookies get":       browserShowcaseGroupSession,
	"cookies set":       browserShowcaseGroupSession,
	"cookies clear":     browserShowcaseGroupSession,
	// 资源与媒体
	"resource list":               browserShowcaseGroupResource,
	"resource inspect":            browserShowcaseGroupResource,
	"resource capture":            browserShowcaseGroupResource,
	"resource download":           browserShowcaseGroupResource,
	"resource probe":              browserShowcaseGroupResource,
	"resource smart-download": browserShowcaseGroupResource,
	"stream parse":                browserShowcaseGroupResource,
	"stream download":             browserShowcaseGroupResource,
	"stream info":                 browserShowcaseGroupResource,
	// 录制与回放
	"record start":  browserShowcaseGroupRecord,
	"record stop":   browserShowcaseGroupRecord,
	"record status": browserShowcaseGroupRecord,
	"replay run":    browserShowcaseGroupRecord,
	"replay list":   browserShowcaseGroupRecord,
}

// browserShowcaseHidden 明确不进用户向总览的 browser 叶子命令。
// 浏览器场景下「回归所有能力」是核心诉求，绝大多数命令都该可见可点；
// 这里只放「面向 Agent 的自描述 / 内省」命令——它们是 Agent「开工前查一眼」的
// 元能力，不是用户向的浏览功能卡，故不进 banner 总览（但仍是一等 CLI 命令）。
var browserShowcaseHidden = map[string]struct{}{
	"context":        {}, // BR-5：当前 runtime / 活跃 tab / workspace 自省
	"capabilities":   {}, // BR-6：当前运行时 action 支持矩阵自省
	"doctor":         {}, // BW-8：本地健康自检，属于诊断入口，不是用户向浏览功能卡
	"job status":     {}, // BR-10：异步长任务进度 / 结果查询（Agent 控制原语，非浏览功能卡）
	"job cancel":     {}, // BR-10：异步长任务取消（同上）
	"network to-api": {}, // BW-3：Agent 离线分析器入口，先不放用户向浏览功能卡
}

// BrowserFeaturedScenario 是首页 curated 示例卡：NL prompt 交给 Agent，commands 仅用于 CI 绑定真实 CLI。
type BrowserFeaturedScenario struct {
	Key         string   `json:"key"`
	Commands    []string `json:"commands"`
	Title       string   `json:"title"`
	Description string   `json:"description"`
	Prompt      string   `json:"prompt"`
}

var browserFeaturedScenarios = []BrowserFeaturedScenario{
	{
		Key:         "open",
		Commands:    []string{"browser open"},
		Title:       "打开一个网页",
		Description: "给网址或搜索词，让 AI 打开它",
		Prompt:      "帮我用浏览器打开一个网页。我给你网址或搜索关键词，你用 `tabtin browser open` 打开它，打开后告诉我页面标题和大致内容。",
	},
	{
		Key:         "read",
		Commands:    []string{"browser print"},
		Title:       "读取页面内容",
		Description: "把当前页面导出成 Markdown / 结构化文本",
		Prompt:      "帮我把当前浏览器页面的正文内容导出成 Markdown 文件并整理要点给我。先看看现在打开了哪些标签页，再导出我要的那个。",
	},
	{
		Key:         "observe",
		Commands:    []string{"browser glance"},
		Title:       "看页面能做什么",
		Description: "观察页面可交互元素（可点击 / 可填写）",
		Prompt:      "帮我看看当前浏览器页面上能做哪些操作。观察页面的可交互元素（可点击 / 可填写），告诉我它们分别是什么。",
	},
	{
		Key:         "download",
		Commands:    []string{"browser resource smart-download"},
		Title:       "下载页面里的媒体",
		Description: "自动发现并下载视频 / 图片 / 音频",
		Prompt:      "帮我把当前浏览器页面里的媒体资源（视频 / 图片 / 音频）找出来并下载。先探测页面上有哪些资源，再下载主要的那个。",
	},
}

type browserShowcaseGroupJSON struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Order int    `json:"order"`
}

type browserShowcaseCommandJSON struct {
	Name       string `json:"name"`
	Short      string `json:"short"`
	Long       string `json:"long"`
	Risk       string `json:"risk,omitempty"`
	Group      string `json:"group"`
	GroupLabel string `json:"group_label"`
}

// BrowserShowcaseManifest 供前端消费的能力总览 JSON（由 scripts/generate-tabweb-capabilities.py 生成落盘）。
type BrowserShowcaseManifest struct {
	Version  int                          `json:"version"`
	Groups   []browserShowcaseGroupJSON   `json:"groups"`
	Commands []browserShowcaseCommandJSON `json:"commands"`
	Featured []BrowserFeaturedScenario    `json:"featured"`
}

func browserRelativePath(leaf *cobra.Command) string {
	path := leaf.CommandPath()
	path = strings.TrimPrefix(path, "tabtin browser ")
	path = strings.TrimPrefix(path, "browser ")
	return strings.TrimSpace(path)
}

func walkLeafBrowserCommands(root *cobra.Command) []*cobra.Command {
	var leaves []*cobra.Command
	var walk func(c *cobra.Command)
	walk = func(c *cobra.Command) {
		if cmdutil.GetCommandDef(c) != nil {
			leaves = append(leaves, c)
		}
		children := c.Commands()
		if len(children) == 0 {
			return
		}
		for _, sub := range children {
			walk(sub)
		}
	}
	walk(root)
	return leaves
}

func applyBrowserShowcaseRegistry(root *cobra.Command) {
	for _, leaf := range walkLeafBrowserCommands(root) {
		rel := browserRelativePath(leaf)
		if _, hidden := browserShowcaseHidden[rel]; hidden {
			continue
		}
		group, ok := browserShowcaseRegistry[rel]
		if !ok {
			continue
		}
		cmdutil.SetCommandShowcase(leaf, true, group)
	}
}

func buildBrowserShowcaseManifest() BrowserShowcaseManifest {
	groups := make([]browserShowcaseGroupJSON, 0, len(browserShowcaseGroupOrder))
	for i, id := range browserShowcaseGroupOrder {
		groups = append(groups, browserShowcaseGroupJSON{
			ID:    id,
			Label: browserShowcaseGroupLabels[id],
			Order: i + 1,
		})
	}

	byName := map[string]cmdutil.CommandSchema{}
	for _, schema := range cmdutil.GetRegisteredCommands() {
		byName[schema.Name] = schema
	}

	commands := make([]browserShowcaseCommandJSON, 0, len(browserShowcaseRegistry))
	for rel, group := range browserShowcaseRegistry {
		fullName := "browser " + rel
		schema, ok := byName[fullName]
		if !ok {
			continue
		}
		commands = append(commands, browserShowcaseCommandJSON{
			Name:       fullName,
			Short:      schema.Description,
			Long:       schema.Long,
			Risk:       schema.Risk,
			Group:      group,
			GroupLabel: browserShowcaseGroupLabels[group],
		})
	}
	sort.Slice(commands, func(i, j int) bool {
		gi, gj := commands[i].Group, commands[j].Group
		if gi != gj {
			return indexOfBrowserGroup(gi) < indexOfBrowserGroup(gj)
		}
		return commands[i].Name < commands[j].Name
	})

	featured := make([]BrowserFeaturedScenario, len(browserFeaturedScenarios))
	copy(featured, browserFeaturedScenarios)

	return BrowserShowcaseManifest{
		Version:  1,
		Groups:   groups,
		Commands: commands,
		Featured: featured,
	}
}

func indexOfBrowserGroup(group string) int {
	for i, id := range browserShowcaseGroupOrder {
		if id == group {
			return i
		}
	}
	return len(browserShowcaseGroupOrder)
}

func marshalBrowserShowcaseManifest(m BrowserShowcaseManifest) ([]byte, error) {
	return json.MarshalIndent(m, "", "  ")
}
