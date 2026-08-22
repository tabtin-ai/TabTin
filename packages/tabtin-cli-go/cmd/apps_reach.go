package cmd

// tabtin reach —— 平台化内容获取命令域（Platform Reach，P0.5 接线）。
//
// 平台适配 + 运行时路由 + 优雅降级，底层复用
// TabTin 自有浏览器栈（Electron WebContentsView + CDP），经 CLI-server `/reach/*`
// 路由桥接；能力本体在 packages/platform-reach 纯包 + Electron reach route。
// 需 Electron 桌面客户端运行；Daemon/headless 登录态桥是 P2，暂不可用。
//
// 合规默认：读动词一律**匿名优先**；登录态批量采集是阻塞性产品
// 决策，`--use-login` 暂被服务端拒绝并说明。写动词（publish 等）不在 P0.5 范围。
//
// 风险治理：读类动作 safe 直通。

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCmdReach(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "reach",
		Short: "平台化内容获取（小红书/抖音/B站/电商/财经等）：搜索 / 阅读 / 评论",
		Long: `按平台适配的内容获取。每个平台一个适配器，声明支持的动词（search/read/
comments…）、抽取策略与限频；运行时路由（reach doctor）判断哪个后端此刻能服务。

内置平台：xiaohongshu / douyin / bilibili / taobao / tmall / jd /
tonghuashun / eastmoney。需 Electron 桌面客户端运行。

⚠️ 小红书 xsec_token 两跳：不能用裸 note_id 直读。正确流程——
  1. tabtin reach search --platform xiaohongshu --query "关键词"
  2. 从结果里取带 xsec_token 的完整 URL
  3. tabtin reach read/comments --platform xiaohongshu --url "<完整URL>"

合规默认：匿名优先。登录态批量采集是阻塞性产品决策，暂不开放。

选路闸门：先看 doctor.searchConstraints。多数平台 sorts/filters 为空（仅默认序）；
有缺口时不要用默认 reach 交差，改 browser 带参 URL 或 browser-collect。
淘宝已声明 sort（sale/price_*/latest）与 filter（tmall/free_shipping）；
京东已声明 sort（sale→psort=3 / price_* / latest），见 --sort。

示例：
  tabtin reach doctor --platform taobao
  tabtin reach search --platform taobao --query "机械键盘" --sort sale --limit 5
  tabtin reach search --platform jd --query "机械键盘" --sort sale --limit 5
  tabtin reach search --platform bilibili --query "AI Agent" --limit 10
  tabtin reach read --platform bilibili --url "https://www.bilibili.com/video/BVxxxx"`,
	}

	platformFlag := cmdutil.FlagDef{
		Name: "platform", Type: cmdutil.FlagString, Required: true,
		Desc: "平台 id（如 xiaohongshu）",
	}

	defs := []cmdutil.CommandDef{
		{
			Use: "doctor", Short: "探测平台 reach 后端可用性（选路诊断）",
			Example: "  tabtin reach doctor --platform xiaohongshu\n  tabtin reach doctor --platform xiaohongshu --verb read",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/reach/doctor",
			Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				platformFlag,
				{Name: "verb", Type: cmdutil.FlagString, Desc: "针对某动词做选路诊断（search/read/comments…）"},
			},
			HasFormat: true, Idempotent: true,
		},
		{
			Use: "search", Short: "搜索平台内容（返回带签名 URL 的归一化条目）",
			Example: "  tabtin reach search --platform xiaohongshu --query \"AI Agent\" --limit 10\n  tabtin reach search --platform taobao --query \"机械键盘\" --sort sale --limit 5",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/reach/search",
			Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				platformFlag,
				{Name: "query", Type: cmdutil.FlagString, Required: true, Desc: "搜索关键词"},
				{Name: "limit", Type: cmdutil.FlagInt, Desc: "结果上限"},
				{Name: "sort", Type: cmdutil.FlagString, Desc: "排序（淘宝/京东：sale / price_asc / price_desc / latest；先看 doctor.searchConstraints）"},
				{Name: "min-price", Type: cmdutil.FlagString, Desc: "最低价（淘宝 start_price）"},
				{Name: "max-price", Type: cmdutil.FlagString, Desc: "最高价（淘宝 end_price）"},
				{Name: "page", Type: cmdutil.FlagInt, Desc: "页码，从 1 起（淘宝）"},
				{Name: "filter", Type: cmdutil.FlagString, Desc: "筛选，逗号分隔（淘宝：tmall / free_shipping）"},
				{Name: "tab-id", Type: cmdutil.FlagString, Desc: "复用已有标签页（同域续会话）"},
				{Name: "use-login", Type: cmdutil.FlagBool, Desc: "使用登录态采集（暂不开放，见 ）"},
			},
			HasFormat: true, Idempotent: true,
		},
		{
			Use: "read", Short: "读取单条内容（需带 xsec_token 的完整 URL，先 search 拿到）",
			Example: "  tabtin reach read --platform xiaohongshu --url \"https://www.xiaohongshu.com/search_result/<id>?xsec_token=...\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/reach/read",
			Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				platformFlag,
				{Name: "url", Type: cmdutil.FlagString, Required: true, Desc: "带签名的完整内容 URL"},
				{Name: "tab-id", Type: cmdutil.FlagString, Desc: "复用已有标签页（同域续会话）"},
				{Name: "use-login", Type: cmdutil.FlagBool, Desc: "使用登录态采集（暂不开放，见 ）"},
			},
			HasFormat: true, Idempotent: true,
		},
		{
			Use: "comments", Short: "读取单条内容的评论（需带 xsec_token 的完整 URL）",
			Example: "  tabtin reach comments --platform xiaohongshu --url \"https://www.xiaohongshu.com/search_result/<id>?xsec_token=...\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/reach/comments",
			Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				platformFlag,
				{Name: "url", Type: cmdutil.FlagString, Required: true, Desc: "带签名的完整内容 URL"},
				{Name: "tab-id", Type: cmdutil.FlagString, Desc: "复用已有标签页（同域续会话）"},
				{Name: "use-login", Type: cmdutil.FlagBool, Desc: "使用登录态采集（暂不开放，见 ）"},
			},
			HasFormat: true, Idempotent: true,
		},
	}

	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}

	return cmd
}
