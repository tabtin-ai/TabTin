package browser

import (
	"fmt"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func NewCmdBrowser(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "browser",
		Short: "浏览器自动化、网页交互、内容读取与数据抓取",
		Long: `控制浏览器完成网页打开、导航、交互、内容读取、数据抓取、截图与录制回放。

支持 Electron（内置浏览器）和 Daemon（Patchright + 系统 Chrome）两种运行时。
部分高级功能仅在 Electron 端可用。

示例：
  tabtin browser open --url https://example.com
  tabtin browser glance
  tabtin browser act --actions '[{"type":"click","ref":"e1"}]'
  tabtin browser eval --expression "document.title"
  tabtin browser print --save /tmp/page.md`,
	}

	registerTopLevel(cmd, f)
	cmdutil.RegisterCommand(cmd, f, browserDoctorCommandDef(f))

	tabCmd := &cobra.Command{Use: "tab", Short: "Tab 管理"}
	registerTabCommands(tabCmd, f)
	cmd.AddCommand(tabCmd)

	resourceCmd := &cobra.Command{Use: "resource", Short: "资源管理（仅 Electron）"}
	registerResourceCommands(resourceCmd, f)
	cmd.AddCommand(resourceCmd)

	streamCmd := &cobra.Command{Use: "stream", Short: "流媒体（仅 Electron）"}
	registerStreamCommands(streamCmd, f)
	cmd.AddCommand(streamCmd)

	sessionCmd := &cobra.Command{Use: "session", Short: "命名会话管理"}
	registerSessionCommands(sessionCmd, f)
	cmd.AddCommand(sessionCmd)

	cookiesCmd := &cobra.Command{Use: "cookies", Short: "Cookie 管理"}
	registerCookieCommands(cookiesCmd, f)
	cmd.AddCommand(cookiesCmd)

	recordCmd := &cobra.Command{Use: "record", Short: "录制（仅 Electron）"}
	registerRecordCommands(recordCmd, f)
	cmd.AddCommand(recordCmd)

	replayCmd := &cobra.Command{Use: "replay", Short: "回放（仅 Electron）"}
	registerReplayCommands(replayCmd, f)
	cmd.AddCommand(replayCmd)

	jobCmd := &cobra.Command{Use: "job", Short: "异步任务（长任务 job：查询进度 / 取消）"}
	registerJobCommands(jobCmd, f)
	cmd.AddCommand(jobCmd)

	// 命令树建完后 overlay 用户向能力总览元数据（Showcase / ShowcaseGroup），
	// 供 scripts/generate-tabweb-capabilities.py 导出前端 banner JSON。
	applyBrowserShowcaseRegistry(cmd)

	return cmd
}

var tabIDFlag = cmdutil.FlagDef{Name: "tab-id", Type: cmdutil.FlagString, Desc: "Tab ID（默认活跃 Tab）"}
var spaceIDFlag = cmdutil.FlagDef{Name: "space-id", Type: cmdutil.FlagString, Desc: "Space ID"}
var runIDFlag = cmdutil.FlagDef{Name: "run-id", Type: cmdutil.FlagString, Desc: "Run ID"}
var browserAsyncFlag = cmdutil.FlagDef{Name: "async", Type: cmdutil.FlagBool, Desc: "异步执行：立即返回 202 + jobId，用 tabtin browser job status/cancel 跟踪或取消"}
var browserWatchFlag = cmdutil.FlagDef{Name: "watch", Type: cmdutil.FlagBool, CliOnly: true, Desc: "等待异步 job 完成：stderr 显示进度，终态 JSON 输出到 stdout；Ctrl-C 时尽力取消"}

// compactFlag：browser 命令族统一的「轻量 / 全量」开关。默认 true=轻量视图（全条目 +
// 关键字段，去掉重的正文/属性/结构）；`--compact=false` 取全量。resource list 等产
// 大输出的命令共用同一套语义，Agent 学一次即通用。
var compactFlag = cmdutil.FlagDef{Name: "compact", Type: cmdutil.FlagBool, Default: true, Desc: "轻量视图（默认开，全条目+关键字段）；--compact=false 取全量"}

// includeFlag：内容类型白名单。逗号分隔白名单，只保留列出的类型；
// 不传=剥离全部可过滤类型（只留纯正文）；`all` = 全部保留。作用于 print 的文本类产物
// （text/markdown/html/json），不影响 glance 的可交互元素清单 / a11y 树（保 act 点链接）。
var includeFlag = cmdutil.FlagDef{Name: "include", Type: cmdutil.FlagString, Desc: "内容类型白名单（逗号分隔）: images,links,media,tables,forms；不传=全部剥离只留正文；all=全保留"}

// printValidate：print 的组合校验——--as json 必须带 --schema（服务端也会校验，这里提前拦
// 省一次 round-trip）。
func printValidate(ctx *cmdutil.RunContext) error {
	if as, _ := ctx.FlagValues["as"].(string); as == "json" {
		if schema, _ := ctx.FlagValues["schema"].(string); strings.TrimSpace(schema) == "" {
			return fmt.Errorf("--as json 需要 --schema（JSON Schema 对象）")
		}
	}
	return nil
}

// compactDefaultValidate：CLI 只下发 Changed 过的 flag，`Default:true` 的布尔永远不会进请求体，
// 服务端会把「没传」当 false（全量）。这里在用户没显式给 `--compact` 时注入 true，保证命令族默认
// 走轻量视图；`--compact=false` 显式取全量。所有产大输出的 browser 命令统一挂此 Validate。
func compactDefaultValidate(ctx *cmdutil.RunContext) error {
	if _, ok := ctx.FlagValues["compact"]; !ok {
		ctx.FlagValues["compact"] = true
	}
	return nil
}

const (
	browserActApprovalTimeout  = 120 * time.Second
	browserActExecutionTimeout = 25 * time.Second
	browserActTimeoutGrace     = 5 * time.Second
	browserActRequestTimeout   = browserActApprovalTimeout + browserActExecutionTimeout + browserActTimeoutGrace
)

// tabKeyPrefix 是 `tab list` 输出里兼容字段 tabKey/activeTabKey 的值前缀（tabweb:<viewId>）。
const tabKeyPrefix = "tabweb:"

// tabKeyFlag 是 --tab-id 的隐藏兼容别名（BR-11）。
//
// 背景：`tabtin browser tab list` 的输出历史上把 tabKey（值形如 tabweb:<viewId>）/
// activeTabKey 作为主字段，但选 Tab 的输入 flag 只有 --tab-id；Agent 据输出字段名误推
// --tab-key、甚至误带 tabweb: 前缀，报错后才查 --help 自纠（多耗 token）。本次已把输出
// 主字段改成 tabId/activeTabId 引导正名，这个隐藏别名 + coalesceTabRef 是兜底：Agent
// 万一仍用 --tab-key / 带前缀的值也照常工作。
//
// Hidden：--help 只展示规范名 --tab-id，引导 Agent 用正名；别名仅作运行期兜底。
var tabKeyFlag = cmdutil.FlagDef{
	Name:   "tab-key",
	Type:   cmdutil.FlagString,
	Hidden: true,
	Desc:   "[兼容别名] 等价于 --tab-id；接受 tab list 输出的 tabKey（含 tabweb: 前缀）。优先用 --tab-id",
}

// normalizeTabRef 剥掉 tab list 输出 tabKey 可能误带的 `tabweb:` 前缀，还原成 route 端
// 期望的纯 viewId；`auto` 等无前缀值原样返回。
func normalizeTabRef(v string) string {
	return strings.TrimPrefix(strings.TrimSpace(v), tabKeyPrefix)
}

// coalesceTabRef 在 pipeline 的 Validate 阶段（含 batch 每行）统一 tab 引用：
//  1. 把 --tab-key 折叠进 tab 引用（仅在没传 --tab-id 时生效）；
//  2. 剥掉 tabweb: 前缀；
//  3. 以 camelCase body 键 tabId 下发——这是 Electron/Daemon 两端 browser route 实际读取的
//     键（route 普遍读 body.tabId）。通用 pipeline 默认 kebab→snake 会发 tab_id，与 route
//     的读取键不一致，导致 --tab-id 被静默丢弃、回退到活跃 tab；这里在 CLI 侧对齐 route 契约。
//     同时保留 snake 键 tab_id（旧行为），兼容任何仍读 tab_id 的消费方。
func coalesceTabRef(ctx *cmdutil.RunContext) {
	ref := ""
	if v, ok := ctx.FlagValues["tab-id"].(string); ok && strings.TrimSpace(v) != "" {
		ref = v
	} else if v, ok := ctx.FlagValues["tab-key"].(string); ok && strings.TrimSpace(v) != "" {
		ref = v
	}
	// 原始/别名 flag 都移除——避免 buildRequestBody 再发 tab_id / tab_key 干扰。
	delete(ctx.FlagValues, "tab-id")
	delete(ctx.FlagValues, "tab-key")
	if ref == "" {
		return
	}
	norm := normalizeTabRef(ref)
	ctx.FlagValues["tabId"] = norm  // route 实际读取键（camelCase）
	ctx.FlagValues["tab_id"] = norm // 保留旧 snake 键，向后兼容
}

// withTabIDAlias 给所有带 --tab-id 的 browser 命令补 BR-11 兜底（见 tabKeyFlag / coalesceTabRef）：
// 注入隐藏别名 --tab-key + Validate 阶段折叠/规范化/对齐下发键。对 --tab-id 必填的命令
// （tab switch/close、session save/load），把 Required 降级为 RequiresOneOf{tab-id, tab-key}，
// 让别名也能满足必填校验。无 --tab-id 的命令原样返回，不受影响。
func withTabIDAlias(def cmdutil.CommandDef) cmdutil.CommandDef {
	hasTabID := false
	tabIDRequired := false
	flags := make([]cmdutil.FlagDef, 0, len(def.Flags)+1)
	for _, fl := range def.Flags {
		if fl.Name == "tab-id" {
			hasTabID = true
			if fl.Required {
				tabIDRequired = true
				fl.Required = false
			}
		}
		flags = append(flags, fl)
	}
	if !hasTabID {
		return def
	}
	flags = append(flags, tabKeyFlag)
	def.Flags = flags

	if tabIDRequired {
		groups := make([][]string, 0, len(def.RequiresOneOf)+1)
		groups = append(groups, def.RequiresOneOf...)
		groups = append(groups, []string{"tab-id", "tab-key"})
		def.RequiresOneOf = groups
	}

	prev := def.Validate
	def.Validate = func(ctx *cmdutil.RunContext) error {
		coalesceTabRef(ctx)
		if prev != nil {
			return prev(ctx)
		}
		return nil
	}
	return def
}

// registerBrowserDefs 注册一组 browser 命令，统一套上 BR-11 的 --tab-key 兜底
// 与 BR-13 的 flag 大小写归一（顺序无关——二者处理的 flag 互斥）。
func registerBrowserDefs(parent *cobra.Command, f *cmdutil.Factory, defs []cmdutil.CommandDef) {
	for _, def := range defs {
		cmdutil.RegisterCommand(parent, f, withBrowserJobWatch(withBrowserFlagCasing(withTabIDAlias(def))))
	}
}

// kebabToCamel 把 kebab flag 名转成 route 实际读取的 camelCase body 键：
// space-id → spaceId、run-id → runId、url-pattern → urlPattern。无连字符原样返回。
func kebabToCamel(s string) string {
	parts := strings.Split(s, "-")
	for i := 1; i < len(parts); i++ {
		if parts[i] == "" {
			continue
		}
		parts[i] = strings.ToUpper(parts[i][:1]) + parts[i][1:]
	}
	return strings.Join(parts, "")
}

// coalesceBrowserFlagCasing 在 pipeline 的 Validate 阶段（含 batch 每行）把"多词"
// browser flag（kebab）同时下发为 camelCase + snake 两种 body 键（BR-13）。
//
// 根因：两端 browser route 读 body 键的大小写不统一——多数读 camelCase
// （body.spaceId / body.runId / body.resourceId），少数读 snake，个别两者都读。
// 通用 CLI pipeline 的 buildRequestBody 默认只把 kebab 转 snake（space-id→space_id），
// 于是凡是 route 只读 camelCase 的 flag 都被静默丢弃：多数命令回退默认值（活跃 tab /
// 当前 space），resource inspect/capture/download 则直接报"缺少 resourceId"。
//
// 修法镜像 BR-11 的 coalesceTabRef：CLI 侧对每个多词 flag 同时发 camelCase（route 的
// 事实读取键）+ snake（向后兼容）。两键同值——无论某条 route 读哪种大小写都拿得到用户
// 传的值；route 没读到的那个键被忽略、无副作用（已确认两端 route 不遍历 body 键、不按
// 键"是否存在"翻转分支——daemon snapshot 的 include_* 存在性判断只读 snake 键、由本函数
// 原样保留——且 browser 命令无 CliOnly flag 会因改名而泄漏进 body）。
//
// coalesceable 由 withBrowserFlagCasing 在注册期从 def.Flags 算出（kebab → camelCase），
// 已排除 tab-id/tab-key（归 coalesceTabRef 处理）与 CliOnly flag。
func coalesceBrowserFlagCasing(ctx *cmdutil.RunContext, coalesceable map[string]string) {
	for kebab, camel := range coalesceable {
		v, ok := ctx.FlagValues[kebab]
		if !ok {
			continue
		}
		// 空串当"未设置"：移除 kebab 键，别发空值覆盖 route 默认 / 触发必填回退。
		if s, isStr := v.(string); isStr && strings.TrimSpace(s) == "" {
			delete(ctx.FlagValues, kebab)
			continue
		}
		delete(ctx.FlagValues, kebab)
		ctx.FlagValues[camel] = v                               // route 实际读取键（camelCase）
		ctx.FlagValues[strings.ReplaceAll(kebab, "-", "_")] = v // snake 向后兼容
	}
}

// withBrowserFlagCasing 给一条 browser 命令套上 BR-13 的 flag 大小写归一：从 def.Flags
// 收集所有"多词" flag（含连字符、非 CliOnly、非 tab-id/tab-key），在 Validate 阶段调
// coalesceBrowserFlagCasing 同时下发 camelCase + snake 键。无多词 flag 的命令原样返回。
//
// 与 withTabIDAlias 组合使用（registerBrowserDefs 内）：tab-id/tab-key 的折叠（含
// tabweb: 前缀剥离）仍由 withTabIDAlias→coalesceTabRef 专管，本函数刻意跳过这两个键，
// 二者处理的 flag 集合互斥、组合顺序无关。
func withBrowserFlagCasing(def cmdutil.CommandDef) cmdutil.CommandDef {
	coalesceable := make(map[string]string)
	for _, fl := range def.Flags {
		if !strings.Contains(fl.Name, "-") {
			continue
		}
		if fl.Name == "tab-id" || fl.Name == "tab-key" {
			continue // 归 coalesceTabRef 专门处理（含 tabweb: 前缀剥离）
		}
		if fl.CliOnly {
			continue // CliOnly flag 不进 body，改名会让 buildRequestBody 的 CliOnly 过滤失效、反而泄漏
		}
		coalesceable[fl.Name] = kebabToCamel(fl.Name)
	}
	if len(coalesceable) == 0 {
		return def
	}
	prev := def.Validate
	def.Validate = func(ctx *cmdutil.RunContext) error {
		coalesceBrowserFlagCasing(ctx, coalesceable)
		if prev != nil {
			return prev(ctx)
		}
		return nil
	}
	return def
}

func withBrowserJobWatch(def cmdutil.CommandDef) cmdutil.CommandDef {
	hasWatch := false
	for _, fl := range def.Flags {
		if fl.Name == "watch" {
			hasWatch = true
			break
		}
	}
	if !hasWatch {
		return def
	}
	def.WaitJobPath = "/browser/job/status"
	def.CancelJobPath = "/browser/job/cancel"
	prev := def.Validate
	def.Validate = func(ctx *cmdutil.RunContext) error {
		if ctx.Bool("watch") {
			ctx.FlagValues["async"] = true
		}
		if prev != nil {
			return prev(ctx)
		}
		return nil
	}
	return def
}

func registerTopLevel(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			// ：导航即观察——open 成功默认内嵌 glance 元素清单（observed_elements），
			// 返回后可直接 act --ref eN，不必再单独 glance 一轮。
			// ：open 会创建或切换浏览器上下文，CLI 声明为写操作；
			// Electron 审批策略通过 contract 的 policyRisk=read 自动放行，避免浏览链路反复确认。
			Use: "open", Short: "打开 URL（默认返回即含可交互元素清单，可直接 act）",
			Example: "  tabtin browser open --url https://example.com\n  tabtin browser open --url https://example.com --observe=false   # 只导航，不带元素清单",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/open",
			Flags: []cmdutil.FlagDef{
				{Name: "url", Type: cmdutil.FlagString, Required: true, Desc: "URL（须 http/https）"},
				{Name: "title", Type: cmdutil.FlagString, Desc: "Tab 标题"},
				{Name: "session", Type: cmdutil.FlagString, Desc: "命名会话"},
				{Name: "wait-until", Type: cmdutil.FlagString, Desc: "导航等待策略 (load/domcontentloaded/networkidle/settled，默认 settled 等 DOM 稳定)", Enum: []string{"load", "domcontentloaded", "networkidle", "settled"}},
				{Name: "timeout", Type: cmdutil.FlagInt, Desc: "导航超时毫秒（默认由 Browser 端决定）"},
				{Name: "wait-selector", Type: cmdutil.FlagString, Desc: "打开后等待 CSS 选择器出现"},
				{Name: "wait-for-timeout", Type: cmdutil.FlagInt, Desc: "等待选择器超时毫秒"},
				{Name: "observe", Type: cmdutil.FlagBool, Default: true, Desc: "打开成功后内嵌可交互元素清单（默认开；--observe=false 只导航）"},
				{Name: "new-tab", Type: cmdutil.FlagBool, Desc: "强制新建标签；Agent 同一 run 内默认复用已有页面以便重试"},
				tabIDFlag, spaceIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite, RiskDeclared: true, Timeout: 2 * time.Minute,
		},
		{
			Use:   "home",
			Short: "打开浏览器入口（自定义主页或 TabWeb 工作区）",
			Long: "打开用户的浏览器入口：已配置自定义主页时新建网页标签打开该网址；未配置时打开 TabWeb 工作区。\n\n仅用于用户要打开浏览器或浏览器主页、尚未指定具体网站或搜索内容的场景。\n指定 URL/网站、搜索词、浏览历史、书签或下载管理时，请使用对应浏览器命令。",
			Example: "  tabtin browser home\n  tabtin browser home --space-id <space_id>",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/home",
			Flags: []cmdutil.FlagDef{
				spaceIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskRead, RiskDeclared: true,
		},
		{
			// ：动作即观察——act 成功默认内嵌 glance 元素清单（observed_elements），
			// 返回后可直接继续 act --ref eN，不必再单独 glance 一轮。
			Use: "act", Short: "执行动作序列（默认返回即含可交互元素清单，可直接继续 act）",
			Long: "执行按顺序组成的页面动作。填写文本框时，value 是 fill 的正式字段；text 只是兼容别名，收到 compatibility_warnings 后应改用 value。选择下拉项也使用 value 传入选项值。",
			Example: "  tabtin browser act --actions '[{\"type\":\"fill\",\"ref\":\"e1\",\"value\":\"张三\"}]'\n  tabtin browser act --actions '[{\"type\":\"select\",\"ref\":\"e4\",\"value\":\"large\"}]'\n  tabtin browser act --actions '[{\"type\":\"click\",\"ref\":\"e6\"}]'\n  tabtin browser act --actions '[{\"type\":\"click\",\"selector\":\"p > a\"}]'\n  tabtin browser act --actions '[{\"type\":\"click\",\"ref\":\"e1\"}]' --observe=false   # 只返回动作结果，不带元素清单",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/act",
			Flags: []cmdutil.FlagDef{
				// ref 取自 glance 输出的元素 ref 字段（eN，如 e1）；也可直接用 selector。
				// glance 输出的 index 仅为展示序号（= eN 里的 N）。
				{Name: "actions", Type: cmdutil.FlagString, Required: true, Desc: "动作数组 JSON（ref 用 glance 的 eN，或用 selector）"},
				{Name: "stop-on-error", Type: cmdutil.FlagBool, Default: true, Desc: "遇错停止"},
				{Name: "observe", Type: cmdutil.FlagBool, Default: true, Desc: "动作成功后内嵌可交互元素清单（默认开；--observe=false 只返回动作结果）"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite, Timeout: browserActRequestTimeout,
		},
		{
			// glance = 原 observe + snapshot + capture + screenshot 的统一入口（命令面重设计）。
			// 「看交互」一个动词：观察页面**可交互元素**（每元素 ref(eN)/role/text/href，
			// 喂给 act；链接元素带真实 href 可直接 open），为操作服务；重返回显式加参。
			// 读/导出页面内容不归它管——那是 print（导出）的职责。
			// 命令族统一 --compact：默认轻量清单（ref/role/text/href…）；
			// CLI 必须挂 compactDefaultValidate，否则 Default:true 不会进请求体，
			// 服务端会把「没传」误判成全量（含超长 xpath selector → 易撞 64KB 落盘）。
			Use: "glance", Short: "看交互：观察页面可交互元素（默认轻量 ref/href；--tree 全量 a11y 树；--screenshot 截图）",
			Example: "  tabtin browser glance\n  tabtin browser glance --selector \"button\"   # 无损收窄范围\n  tabtin browser glance --compact=false         # 全字段（含 selector/tag/visible）\n  tabtin browser glance --tree                # 全量 a11y 树（重）\n  tabtin browser glance --screenshot --save /tmp/page.png\n  # 点击: tabtin browser act --actions '[{\"type\":\"click\",\"ref\":\"e1\"}]'\n  # 打开链接: 复制元素的 href 原样传给 tabtin browser open（勿自己拼 URL，会丢签名参）",
			Route:    cmdutil.RouteCliServer, Method: "POST", Path: "/browser/glance",
			Validate: compactDefaultValidate,
			Flags: []cmdutil.FlagDef{
				compactFlag,
				{Name: "tree", Type: cmdutil.FlagBool, Desc: "返回全量 a11y 树 + DOM index（重输出，看不懂默认清单时才用）"},
				{Name: "screenshot", Type: cmdutil.FlagBool, Desc: "截图（落盘，默认 ~/.tabtin/screenshots；配 --save 指定路径）"},
				{Name: "som", Type: cmdutil.FlagBool, Desc: "SoM 标注截图（隐含 --screenshot）"},
				{Name: "full-page", Type: cmdutil.FlagBool, Desc: "全页截图（配 --screenshot）"},
				{Name: "width", Type: cmdutil.FlagInt, Desc: "截图视口宽度"},
				{Name: "save", Type: cmdutil.FlagString, Desc: "截图保存路径（仅 --screenshot；允许 ~/.tabtin, /tmp）"},
				{Name: "selector", Type: cmdutil.FlagString, Desc: "CSS 选择器（无损收窄观察范围）"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true,
		},
		{
			// Risk=write: 任意 JS 求值等同写操作（fetch/click/setItem 都能跑）。
			// 受限模式必须拒绝；只读取 DOM 文本请改用 `tabtin browser glance` /
			// `tabtin browser print` 等带数据闸门的命令。
			Use: "eval", Short: "执行 JavaScript",
			Example: "  tabtin browser eval --expression \"document.title\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/eval",
			Flags: []cmdutil.FlagDef{
				{Name: "expression", Type: cmdutil.FlagString, Required: true, Desc: "JS 表达式"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "wait", Short: "等待",
			Example: "  tabtin browser wait --selector \".loaded\"\n  tabtin browser wait --timeout 3000",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/wait",
			Flags: []cmdutil.FlagDef{
				{Name: "selector", Type: cmdutil.FlagString, Desc: "等待元素出现"},
				{Name: "timeout", Type: cmdutil.FlagInt, Desc: "超时毫秒（默认: 有 selector 10000, 无 selector 2000）"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true,
		},
		{
			// print = 原 extract + markdown + pdf 的统一入口（命令面重设计）。
			// 「导出页面内容到文件」一个动词：始终落盘（--save 必填），响应只回路径 + 元信息，
			// 不把大块正文灌进上下文——要读用 grep/read 按需取文件片段。
			Use: "print", Short: "导出页面内容到文件（默认 markdown；--as text|markdown|html|json|pdf；--save 必填）",
			Example: "  tabtin browser print --save /tmp/page.md                   # 当前 tab → markdown\n  tabtin browser print --url https://example.com --save /tmp/page.md\n  tabtin browser print --as json --schema '{\"type\":\"object\",\"properties\":{\"title\":{\"type\":\"string\"}}}' --save /tmp/data.json\n  tabtin browser print --as pdf --save /tmp/page.pdf\n  tabtin browser print --include links,images --save /tmp/page.md   # 保留链接与图片",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/print",
			Validate: printValidate,
			Flags: []cmdutil.FlagDef{
				{Name: "as", Type: cmdutil.FlagString, Default: "markdown", Desc: "产物形态 (text/markdown/html/json/pdf)", Enum: []string{"text", "markdown", "html", "json", "pdf"}},
				{Name: "save", Type: cmdutil.FlagString, Required: true, Desc: "保存路径（允许 ~/.tabtin, /tmp；必填）"},
				{Name: "url", Type: cmdutil.FlagString, Desc: "URL（轨 B 临时抓取，无会话；缺省用当前 tab，共享会话）"},
				includeFlag,
				{Name: "schema", Type: cmdutil.FlagString, Desc: "JSON Schema（--as json 必填；输出 structured_json 投影）"},
				{Name: "wait-for-dynamic", Type: cmdutil.FlagBool, Default: true, Desc: "等待动态内容（仅 --url 模式生效）"},
				{Name: "timeout", Type: cmdutil.FlagInt, Default: 30000, Desc: "超时毫秒（仅 --url 模式生效）"},
				{Name: "landscape", Type: cmdutil.FlagBool, Desc: "横向（仅 --as pdf）"},
				{Name: "page-size", Type: cmdutil.FlagString, Default: "A4", Desc: "页面大小（仅 --as pdf）"},
				{Name: "print-background", Type: cmdutil.FlagBool, Default: true, Desc: "打印背景（仅 --as pdf）"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true, Timeout: 2 * time.Minute,
		},
		{
			Use: "nav", Short: "导航 (back/forward/reload/stop)",
			Example: "  tabtin browser nav --direction back\n  tabtin browser nav --direction reload --ignore-cache",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/nav",
			Flags: []cmdutil.FlagDef{
				{Name: "direction", Type: cmdutil.FlagString, Required: true, Desc: "方向 (back/forward/reload/stop)"},
				{Name: "ignore-cache", Type: cmdutil.FlagBool, Desc: "忽略缓存（reload 时）"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "network", Short: "网络日志（列出页面加载发出的请求 / XHR / fetch）",
			Example: "  tabtin browser network\n  tabtin browser network --filter xhr --tab-id <tab_id>",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/network",
			Flags: []cmdutil.FlagDef{
				{Name: "filter", Type: cmdutil.FlagString, Desc: "过滤条件"},
				{Name: "include-request-headers", Type: cmdutil.FlagBool, Desc: "包含请求头（敏感字段默认脱敏）"},
				{Name: "include-request-body", Type: cmdutil.FlagBool, Desc: "包含请求体（仅已捕获的小型文本/JSON）"},
				{Name: "include-response-headers", Type: cmdutil.FlagBool, Desc: "包含响应头"},
				{Name: "include-response-body", Type: cmdutil.FlagBool, Desc: "包含响应体（仅小型文本/JSON）"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true,
		},
		{
			Use: "console", Short: "控制台日志",
			Example: "  tabtin browser console\n  tabtin browser console --level error --tab-id <tab_id>",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/console",
			Flags: []cmdutil.FlagDef{
				{Name: "level", Type: cmdutil.FlagString, Desc: "日志级别过滤"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true,
		},
		{
			Use: "batch", Short: "批量操作",
			Example: "  tabtin browser batch --actions '[{\"type\":\"click\",\"ref\":\"e1\"},{\"type\":\"type\",\"text\":\"hello\"}]'",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/batch",
			Flags: []cmdutil.FlagDef{
				{Name: "actions", Type: cmdutil.FlagString, Required: true, Desc: "操作数组 JSON（每项含 type + 参数）"},
				{Name: "stop-on-error", Type: cmdutil.FlagBool, Default: true, Desc: "遇错停止"},
				tabIDFlag, runIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "clear-session", Short: "清除会话数据",
			Example: "  tabtin browser clear-session --tab-id <tab_id>\n  tabtin browser clear-session --clear-cache --clear-cookies",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/clear-session",
			Flags: []cmdutil.FlagDef{
				{Name: "clear-cookies", Type: cmdutil.FlagBool, Default: true, Desc: "清除 Cookie"},
				{Name: "clear-local-storage", Type: cmdutil.FlagBool, Default: true, Desc: "清除 LocalStorage"},
				{Name: "clear-cache", Type: cmdutil.FlagBool, Default: true, Desc: "清除缓存"},
				tabIDFlag, spaceIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			Use: "random-ua", Short: "随机 User-Agent",
			Example: "  tabtin browser random-ua\n  tabtin browser random-ua --platform mobile",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/random-ua",
			Flags:     []cmdutil.FlagDef{{Name: "platform", Type: cmdutil.FlagString, Default: "desktop", Desc: "平台 (desktop/mobile)"}},
			HasFormat: true,
		},
		// ── 自描述（BR-5 / BR-6）──────────────────────────────────
		// 纯只读、runtime-aware：让 Agent「开工前查一眼」而非「运行时踩一脚」。
		// 刻意不并进顶层 `tabtin capabilities`（那是平台静态工具清单）——这两个
		// 是 runtime 感知的 browser 自描述，语义不同，挂在 browser 子命令下。
		{
			Use: "context", Short: "当前浏览器上下文（runtime/活跃 tab/workspace）",
			Long: `查询「我现在站在哪」：当前运行时（electron/daemon）、活跃 tab（id/url/title）、
crawlspace / workspace 根、以及上下文来源 source。

Electron 从 CrawlspaceContextHub 取活跃 tab，Daemon 从 DaemonBrowserService 取。
纯只读，不改任何状态。`,
			Example: "  tabtin browser context\n  tabtin browser context --format json",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/context",
			Flags:      []cmdutil.FlagDef{spaceIDFlag},
			HasFormat:  true,
			Idempotent: true,
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "runtime", Label: "运行时", Type: "string"},
				{Key: "source", Label: "来源", Type: "string"},
				{Key: "spaceId", Label: "Space", Type: "id"},
				{Key: "crawlspaceId", Label: "Crawlspace", Type: "id"},
				{Key: "workspaceRoot", Label: "工作目录", Type: "string"},
				{Key: "tabCount", Label: "Tab 数", Type: "number"},
			},
		},
		{
			Use: "capabilities", Short: "当前运行时支持/降级的 browser action 矩阵",
			Long: `查询「我能用什么」：当前运行时下每个 browser action 的支持级别——
full（完整）/ degraded（功能裁剪）/ unsupported（不可用），degraded/unsupported 带原因。

数据源是 @tabtin/browser-core 的能力矩阵（双端同源），只投影「我这一端」那一列，
所以双端永不漂移。把双端差异从「踩坑」变「可查询契约」。

注意：这不同于顶层 tabtin capabilities（平台静态工具清单）——这条是 runtime 感知的
browser action 矩阵。`,
			Example: "  tabtin browser capabilities\n  tabtin browser capabilities --format json\n  tabtin browser capabilities --format json --jq '.actions[] | select(.level!=\"full\")'",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/capabilities",
			HasFormat:  true,
			Idempotent: true,
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "id", Label: "Action", Type: "string"},
				{Key: "summary", Label: "说明", Type: "string"},
				{Key: "level", Label: "支持级别", Type: "string"},
				{Key: "note", Label: "降级/不支持原因", Type: "string"},
			},
		},
		{
			// BR-2：双端 /route 都已实现（Electron 经 FC browser_route，Daemon 经 page.route），
			// 但此前没有对应 CLI 命令——Agent 只能经 FC 用、shell 路径完全摸不到。这里补上薄 facade。
			// 入参语义：缺省（不带 status/body/headers）= 直接 abort 命中请求；
			// 带 status/body/headers = 以伪造响应 fulfill。
			Use: "route", Short: "拦截 / 改写匹配的网络请求",
			Example: "  tabtin browser route --url-pattern \"**/*.png\"            # 直接拦截（abort）\n  tabtin browser route --url-pattern \"**/api/**\" --status 403 --body \"blocked\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/route",
			Flags: []cmdutil.FlagDef{
				{Name: "url-pattern", Type: cmdutil.FlagString, Required: true, Desc: "URL 匹配模式（glob，如 **/*.png）"},
				{Name: "status", Type: cmdutil.FlagInt, Desc: "命中时伪造的 HTTP 状态码（配合 body/headers 走 fulfill；缺省则 abort）"},
				{Name: "body", Type: cmdutil.FlagString, Desc: "命中时伪造的响应体（纯文本）"},
				{Name: "headers", Type: cmdutil.FlagString, Desc: "命中时伪造的响应头 JSON，如 '{\"content-type\":\"text/plain\"}'"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
		{
			// BR-2：列出已注册的拦截规则。仅 Electron 维护可查询规则列表；
			// Daemon 的 page.route 为 per-page、不持久，会诚实返回 501 NOT_IMPLEMENTED（不再假成功）。
			Use: "route-list", Short: "列出已注册的拦截规则（仅 Electron）",
			Example: "  tabtin browser route-list",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/route-list",
			Flags:     []cmdutil.FlagDef{tabIDFlag, spaceIDFlag, runIDFlag},
			HasFormat: true,
		},
		{
			// BR-2：取消请求拦截。双端取消依据不同——Electron 用 route-list 返回的 ruleId，
			// Daemon 用注册时的 url-pattern；两个 flag 都暴露，按运行时择一使用。
			Use: "unroute", Short: "取消请求拦截",
			Example: "  tabtin browser unroute --rule-id <rule_id>      # Electron：用 route-list 拿到的 ruleId\n  tabtin browser unroute --url-pattern \"**/*.png\"  # Daemon：用注册时的 url-pattern",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/unroute",
			Flags: []cmdutil.FlagDef{
				{Name: "rule-id", Type: cmdutil.FlagString, Desc: "规则 ID（Electron，来自 route-list）"},
				{Name: "url-pattern", Type: cmdutil.FlagString, Desc: "URL 匹配模式（Daemon，注册拦截时所用）"},
				tabIDFlag, spaceIDFlag, runIDFlag,
			},
			HasFormat: true, Risk: cmdutil.RiskWrite,
		},
	}
	registerBrowserDefs(parent, f, defs)
	for _, child := range parent.Commands() {
		if child.Name() == "network" {
			registerBrowserDefs(child, f, []cmdutil.CommandDef{
				{
					Use: "to-api", Short: "从网络日志生成 OpenAPI 3.1 草案",
					Example: "  tabtin browser network to-api --format json\n  tabtin browser network --include-request-body --include-response-body --format json > network.json\n  tabtin browser network to-api --input @network.json --title \"Observed API\" --format json",
					Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/browser/network/to-api",
					Flags: []cmdutil.FlagDef{
						{Name: "input", Type: cmdutil.FlagString, Desc: "离线 network JSON（支持 @file 或 stdin）；不传则读取当前 tab 的 network 缓冲"},
						{Name: "title", Type: cmdutil.FlagString, Desc: "OpenAPI info.title"},
						{Name: "version", Type: cmdutil.FlagString, Desc: "OpenAPI info.version"},
						{Name: "filter", Type: cmdutil.FlagString, Desc: "读取 runtime network 缓冲时的过滤条件"},
						tabIDFlag, spaceIDFlag, runIDFlag,
					},
					StdinField: "input",
					HasFormat:  true,
				},
			})
			break
		}
	}
}

func registerTabCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		// 合并：保留远端 Example（CLI 宪法 Wave 1）+ 我方 Risk/OutputSchema（W5.5/L31）
		{
			Use: "list", Short: "Tab 列表", Example: "  tabtin browser tab list\n  tabtin browser tab list --space-id <space_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/tabs",
			Flags:     []cmdutil.FlagDef{spaceIDFlag},
			HasFormat: true,
			// L31：tabs 数组中每条记录字段（与 Electron `BrowserTabSummary` 对齐）。
			// BR-11：tabId 作主字段（值=纯 viewId，名字与输入 flag --tab-id 一致），
			// 引导 Agent 据输出正名拼命令；id 保留兼容。
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "tabId", Label: "Tab ID", Type: "id"},
				{Key: "title", Label: "标题", Type: "string"},
				{Key: "url", Label: "URL", Type: "string"},
				{Key: "type", Label: "类型", Type: "string"},
			},
		},
		{Use: "switch", Short: "切换 Tab", Example: "  tabtin browser tab switch --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/tab-switch", Flags: []cmdutil.FlagDef{{Name: "tab-id", Type: cmdutil.FlagString, Required: true, Desc: "Tab ID"}, spaceIDFlag}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "close", Short: "关闭 Tab", Example: "  tabtin browser tab close --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/tab-close", Flags: []cmdutil.FlagDef{{Name: "tab-id", Type: cmdutil.FlagString, Required: true, Desc: "Tab ID"}, spaceIDFlag}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "state", Short: "Tab 状态", Example: "  tabtin browser tab state --tab-id <tab_id>\n  tabtin browser tab state --tab-id <tab_id> --include-history", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/tab-state", Flags: []cmdutil.FlagDef{tabIDFlag, spaceIDFlag, {Name: "include-history", Type: cmdutil.FlagBool, Desc: "包含浏览历史"}}, HasFormat: true},
	}
	registerBrowserDefs(parent, f, defs)
}

func registerResourceCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{Use: "list", Short: "资源列表", Example: "  tabtin browser resource list --tab-id <tab_id>\n  tabtin browser resource list --category video", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/resources",
			// 无 --limit：默认返回全部资源，不做有损截断。轻量/全量走命令族统一的 --compact：
			// 默认轻量（url+type+size）；--compact=false 加 status/mimeType/resourceId 等全字段。用 --category 收窄。
			Validate: compactDefaultValidate,
			Flags:    []cmdutil.FlagDef{compactFlag, tabIDFlag, spaceIDFlag, {Name: "category", Type: cmdutil.FlagString, Desc: "类别过滤（收窄结果，替代有损的数量截断）"}, {Name: "probe-media", Type: cmdutil.FlagBool, Desc: "探测媒体信息"}, {Name: "hide-segments", Type: cmdutil.FlagBool, Default: true, Desc: "隐藏流媒体分片（如 DASH/HLS 的小分片），默认 true"}}, HasFormat: true},
		{Use: "inspect", Short: "资源详情", Example: "  tabtin browser resource inspect --resource-id <resource_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/resource/inspect", Flags: []cmdutil.FlagDef{{Name: "resource-id", Type: cmdutil.FlagString, Required: true, Desc: "资源 ID"}, tabIDFlag, spaceIDFlag}, HasFormat: true},
		{Use: "capture", Short: "捕获资源", Example: "  tabtin browser resource capture --url https://example.com/video.mp4\n  tabtin browser resource capture --resource-id <resource_id> --force", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/resource/capture", Flags: []cmdutil.FlagDef{{Name: "resource-id", Type: cmdutil.FlagString, Desc: "资源 ID"}, {Name: "url", Type: cmdutil.FlagString, Desc: "URL"}, {Name: "force", Type: cmdutil.FlagBool, Desc: "强制重新捕获"}, tabIDFlag, spaceIDFlag}, HasFormat: true},
		{Use: "download", Short: "下载资源", Example: "  tabtin browser resource download --resource-id <resource_id> --filename media.mp4\n  tabtin browser resource download --url https://example.com/file.mp4", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/resource/download", Flags: []cmdutil.FlagDef{{Name: "resource-id", Type: cmdutil.FlagString, Desc: "资源 ID"}, {Name: "url", Type: cmdutil.FlagString, Desc: "URL"}, {Name: "filename", Type: cmdutil.FlagString, Desc: "文件名"}, tabIDFlag, spaceIDFlag}, HasFormat: true},
		{Use: "probe", Short: "主动探测页面中的媒体元素（video/audio/blob）", Example: "  tabtin browser resource probe --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/resource/probe", Flags: []cmdutil.FlagDef{tabIDFlag, spaceIDFlag}, HasFormat: true},
		{Use: "smart-download", Short: "智能下载页面上的主要媒体资源", Example: "  tabtin browser resource smart-download --tab-id <tab_id> --quality best\n  tabtin browser resource smart-download --category video\n  tabtin browser resource smart-download --watch", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/resource/smart-download", Flags: []cmdutil.FlagDef{tabIDFlag, spaceIDFlag, {Name: "quality", Type: cmdutil.FlagString, Desc: "画质选择: best/worst/720p/1080p 等"}, {Name: "category", Type: cmdutil.FlagString, Desc: "资源类别过滤: video/audio/image"}, browserAsyncFlag, browserWatchFlag}, HasFormat: true},
	}
	registerBrowserDefs(parent, f, defs)
}

func registerStreamCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{Use: "parse", Short: "解析流媒体", Example: "  tabtin browser stream parse --url https://example.com/index.m3u8\n  tabtin browser stream parse --resource-id <resource_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/stream/parse", Flags: []cmdutil.FlagDef{{Name: "url", Type: cmdutil.FlagString, Desc: "URL"}, {Name: "resource-id", Type: cmdutil.FlagString, Desc: "资源 ID"}, {Name: "headers", Type: cmdutil.FlagString, Desc: "请求头 JSON"}, tabIDFlag}, HasFormat: true},
		{Use: "download", Short: "下载流媒体", Example: "  tabtin browser stream download --url https://example.com/index.m3u8 --filename video.mp4\n  tabtin browser stream download --resource-id <resource_id> --quality 720p\n  tabtin browser stream download --url https://example.com/index.m3u8 --watch", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/stream/download", Flags: []cmdutil.FlagDef{{Name: "url", Type: cmdutil.FlagString, Desc: "URL"}, {Name: "resource-id", Type: cmdutil.FlagString, Desc: "资源 ID"}, {Name: "quality", Type: cmdutil.FlagString, Desc: "质量"}, {Name: "filename", Type: cmdutil.FlagString, Desc: "文件名"}, {Name: "concurrency", Type: cmdutil.FlagInt, Desc: "并发数"}, {Name: "output", Type: cmdutil.FlagString, Desc: "显式输出路径（Electron 仅允许系统下载目录内路径；日常优先用 --filename）"}, browserAsyncFlag, browserWatchFlag, tabIDFlag}, HasFormat: true},
		{Use: "info", Short: "查看流媒体详细信息（画质列表、时长、分片数）", Example: "  tabtin browser stream info --url https://example.com/index.m3u8\n  tabtin browser stream info --resource-id <resource_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/stream/info", Flags: []cmdutil.FlagDef{{Name: "url", Type: cmdutil.FlagString, Desc: "流媒体 URL (m3u8/mpd)"}, {Name: "resource-id", Type: cmdutil.FlagString, Desc: "资源 ID"}, tabIDFlag, {Name: "headers", Type: cmdutil.FlagString, Desc: "请求头 JSON"}}, HasFormat: true},
	}
	registerBrowserDefs(parent, f, defs)
}

func registerSessionCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		// 合并：保留远端 Example（CLI 宪法 Wave 1）+ 我方 Risk/OutputSchema（W5.5/L31）
		{Use: "list", Short: "列出会话", Example: "  tabtin browser session list", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/session/list", HasFormat: true},
		{Use: "create", Short: "创建会话", Example: "  tabtin browser session create --name research --title \"Research Session\"", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/session/create", Flags: []cmdutil.FlagDef{{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "会话名称"}, {Name: "title", Type: cmdutil.FlagString, Desc: "显示标题"}}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "switch", Short: "切换会话", Example: "  tabtin browser session switch --name research", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/session/switch", Flags: []cmdutil.FlagDef{{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "会话名称"}}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "close", Short: "关闭会话", Example: "  tabtin browser session close --name research", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/session/close", Flags: []cmdutil.FlagDef{{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "会话名称"}}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "close-all", Short: "关闭所有会话", Example: "  tabtin browser session close-all", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/session/close-all", HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "save", Short: "保存会话状态", Example: "  tabtin browser session save --name research\n  tabtin browser session save --name research --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/session/save", Flags: []cmdutil.FlagDef{{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "会话名称"}, {Name: "tab-id", Type: cmdutil.FlagString, Desc: "Tab ID（可选；指定普通 tab 或命名 session 中的某个页）"}}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "load", Short: "加载会话状态", Example: "  tabtin browser session load --name research --state '{\"cookies\":[],\"origins\":[]}'\n  tabtin browser session load --name research --tab-id <tab_id> --mode replace --state '{\"cookies\":[],\"origins\":[]}'", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/session/load", Flags: []cmdutil.FlagDef{{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "会话名称（name-only 存取目前仅 Daemon 支持；Electron 端仍需 --tab-id）"}, {Name: "state", Type: cmdutil.FlagString, Required: true, Desc: "storageState JSON"}, {Name: "tab-id", Type: cmdutil.FlagString, Desc: "Tab ID（可选；指定普通 tab 或命名 session 中的某个页）"}, {Name: "mode", Type: cmdutil.FlagString, Desc: "加载模式：merge(默认，保留旧 key) / replace(先清目标 cookies 与目标页 storage)", Enum: []string{"merge", "replace"}}, {Name: "open-missing-origins", Type: cmdutil.FlagBool, Desc: "缺少同 origin 页面时，允许打开 origin 页以恢复 sessionStorage（Daemon-only，默认 false）"}}, HasFormat: true, Risk: cmdutil.RiskWrite},
	}
	registerBrowserDefs(parent, f, defs)
}

func registerCookieCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		// 合并：保留远端 Example（CLI 宪法 Wave 1）+ 我方 Risk/OutputSchema（W5.5/L31）
		// 三命令共用 POST /browser/cookies，各自通过 FixedFields 钦定 action（双端动词统一为 get/set/clear），
		// 否则不发 action 会在 Electron 上 400、在 Daemon 上静默退化成 get（BR-1）。
		{Use: "get", Short: "获取 Cookie", Example: "  tabtin browser cookies get --domain example.com\n  tabtin browser cookies get --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/cookies", Flags: []cmdutil.FlagDef{{Name: "domain", Type: cmdutil.FlagString, Desc: "域名"}, tabIDFlag, spaceIDFlag}, FixedFields: map[string]any{"action": "get"}, HasFormat: true},
		{Use: "set", Short: "设置 Cookie", Example: "  tabtin browser cookies set --cookies '[{\"name\":\"sid\",\"value\":\"abc\",\"domain\":\"example.com\"}]'", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/cookies", Flags: []cmdutil.FlagDef{{Name: "cookies", Type: cmdutil.FlagString, Required: true, Desc: "Cookie JSON"}, tabIDFlag, spaceIDFlag}, FixedFields: map[string]any{"action": "set"}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "clear", Short: "清除 Cookie", Example: "  tabtin browser cookies clear --domain example.com\n  tabtin browser cookies clear --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/cookies", Flags: []cmdutil.FlagDef{{Name: "domain", Type: cmdutil.FlagString, Desc: "域名"}, tabIDFlag, spaceIDFlag}, FixedFields: map[string]any{"action": "clear"}, HasFormat: true, Risk: cmdutil.RiskWrite},
	}
	registerBrowserDefs(parent, f, defs)
}

func registerRecordCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		// 合并：保留远端 Example（CLI 宪法 Wave 1）+ 我方 Risk/OutputSchema（W5.5/L31）
		{Use: "start", Short: "开始录制", Example: "  tabtin browser record start --tab-id <tab_id> --fps 2", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/record/start", Flags: []cmdutil.FlagDef{tabIDFlag, spaceIDFlag, runIDFlag, {Name: "fps", Type: cmdutil.FlagInt, Default: 2, Desc: "帧率"}}, HasFormat: true, Risk: cmdutil.RiskWrite},
		// BR-19：补 runIDFlag，与 record start 对齐——同一录制生命周期三命令入参口径统一，消除
		// `record status --run-id <id>` 报 unknown flag 的误用障碍。--tab-id 保留可用（两者皆可）。
		// runId 经 BR-13 的 withBrowserFlagCasing 同时下发 runId(camel)+run_id(snake)；Daemon
		// 端 recordStop/recordStatus 读 body.runId 真用得上（status 凭 runId 查特定录制、stop 按
		// runId 选录制），Electron 端按活跃 tab 解析、runId 忽略不影响。
		{Use: "stop", Short: "停止录制", Example: "  tabtin browser record stop --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/record/stop", Flags: []cmdutil.FlagDef{tabIDFlag, spaceIDFlag, runIDFlag}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "status", Short: "录制状态", Example: "  tabtin browser record status --tab-id <tab_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/record/status", Flags: []cmdutil.FlagDef{tabIDFlag, spaceIDFlag, runIDFlag}, HasFormat: true},
	}
	registerBrowserDefs(parent, f, defs)
}

func registerReplayCommands(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		// 合并：保留远端 Example（CLI 宪法 Wave 1）+ 我方 Risk/OutputSchema（W5.5/L31）
		{Use: "run", Short: "运行回放", Example: "  tabtin browser replay run --run-id <run_id> --speed 2 --skip-waits\n  tabtin browser replay run --run-id <run_id> --watch", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/replay/run", Flags: []cmdutil.FlagDef{{Name: "run-id", Type: cmdutil.FlagString, Required: true, Desc: "Run ID"}, {Name: "speed", Type: cmdutil.FlagInt, Desc: "速度倍数"}, {Name: "skip-waits", Type: cmdutil.FlagBool, Desc: "跳过等待"}, {Name: "stop-on-error", Type: cmdutil.FlagBool, Desc: "遇错停止"}, browserAsyncFlag, browserWatchFlag}, HasFormat: true, Risk: cmdutil.RiskWrite},
		{Use: "list", Short: "录制列表", Example: "  tabtin browser replay list", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/replay/list", HasFormat: true},
	}
	registerBrowserDefs(parent, f, defs)
}

// registerJobCommands 注册长任务 job 控制命令（BR-10 P2）。
// 长任务（如 stream download）传 --async 起 job、立即返回 jobId；这两条用于轮询进度 / 取消。
// --job-id 经 withBrowserFlagCasing 同时下发 jobId(camel)+job_id(snake)，route 端 readJobId 读得到。
func registerJobCommands(parent *cobra.Command, f *cmdutil.Factory) {
	jobIDFlag := cmdutil.FlagDef{Name: "job-id", Type: cmdutil.FlagString, Required: true, Desc: "Job ID（异步任务 202 响应里的 jobId）"}
	defs := []cmdutil.CommandDef{
		{Use: "status", Short: "查询异步任务进度 / 结果", Example: "  tabtin browser job status --job-id <job_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/job/status", Flags: []cmdutil.FlagDef{jobIDFlag}, HasFormat: true},
		{Use: "cancel", Short: "取消异步任务", Example: "  tabtin browser job cancel --job-id <job_id>", Route: cmdutil.RouteCliServer, Method: "POST", Path: "/browser/job/cancel", Flags: []cmdutil.FlagDef{jobIDFlag}, HasFormat: true, Risk: cmdutil.RiskWrite},
	}
	registerBrowserDefs(parent, f, defs)
}
