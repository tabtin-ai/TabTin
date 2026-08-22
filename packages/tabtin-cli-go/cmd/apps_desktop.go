package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

func newCmdDesktop(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "desktop",
		Short: "桌面操控（截屏、鼠标、键盘、窗口管理）",
		Long: `AI Agent 操控 macOS / Windows 桌面应用。
需要 Electron 桌面客户端运行，Daemon 模式不可用。

标准操控循环：截屏 → 分析 → 操作 → 截屏验证。
首次使用需要用户审批和 macOS 辅助功能权限。

示例：
  tabtin desktop screenshot
  tabtin desktop click 640 400
  tabtin desktop type "Hello World"
  tabtin desktop hotkey cmd c
  tabtin desktop windows
  tabtin desktop activate "Google Chrome"`,
	}

	registerDesktopTopLevel(cmd, f)

	cmd.AddCommand(newDesktopHotkeyCmd(f))
	cmd.AddCommand(newDesktopDragCmd(f))
	cmd.AddCommand(newDesktopScreenshotCmd(f))
	cmd.AddCommand(newDesktopBatchCmd(f))
	cmd.AddCommand(newDesktopAccessibilityTreeCmd(f))
	cmd.AddCommand(newDesktopClickElementCmd(f))
	cmd.AddCommand(newDesktopTypeIntoElementCmd(f))

	sessionCmd := &cobra.Command{Use: "session", Short: "操控会话管理"}
	cmdutil.RegisterCommand(sessionCmd, f, cmdutil.CommandDef{
		Use: "start", Short: "启动桌面操控会话",
		Example: "  tabtin desktop session start\n  tabtin desktop session start --session-id <id>",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/session/start",
		// ：启动桌面操控会话开启对本机键鼠的控制通道，属状态变更。
		Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Flags: []cmdutil.FlagDef{
			{Name: "session-id", Type: cmdutil.FlagString, Desc: "会话 ID"},
		},
		HasFormat: true,
		Validate: func(ctx *cmdutil.RunContext) error {
			renameFlag(ctx, "session-id", "sessionId")
			return nil
		},
	})
	cmdutil.RegisterCommand(sessionCmd, f, cmdutil.CommandDef{
		Use: "end", Short: "结束桌面操控会话",
		Example: "  tabtin desktop session end",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/session/end",
		// ：结束会话改变操控通道状态。
		Risk: cmdutil.RiskWrite, RiskDeclared: true,
		HasFormat: true,
	})
	sessionCmd.AddCommand(newDesktopExtendAllowlistCmd(f))
	cmd.AddCommand(sessionCmd)

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "revoke-approval", Short: "撤销桌面操控授权",
		Long:    "撤销桌面操控的总是允许授权，下次使用需重新审批。",
		Example: "  tabtin desktop revoke-approval",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/revoke-approval",
		// ：撤销授权改变持久化的审批状态。
		Risk: cmdutil.RiskWrite, RiskDeclared: true,
		HasFormat: true,
	})

	return cmd
}

func registerDesktopTopLevel(parent *cobra.Command, f *cmdutil.Factory) {
	defs := []cmdutil.CommandDef{
		{
			Use: "click <x> <y>", Short: "鼠标点击",
			Example: "  tabtin desktop click 640 400\n  tabtin desktop click 640 400 --button right\n  tabtin desktop click 640 400 --count 2",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/click",
			// ：真实操控本机鼠标，属设备写。
			Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"x", "y"},
			Flags: []cmdutil.FlagDef{
				{Name: "button", Type: cmdutil.FlagString, Desc: "按钮 (left/right/middle)", Default: "left", Enum: []string{"left", "right", "middle"}},
				{Name: "count", Type: cmdutil.FlagInt, Desc: "点击次数（2=双击）"},
			},
			HasFormat: true,
		},
		{
			Use: "scroll <x> <y>", Short: "鼠标滚动",
			Example: "  tabtin desktop scroll 640 400 --dy -3\n  tabtin desktop scroll 640 400 --dy 5",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/scroll",
			Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"x", "y"},
			Flags: []cmdutil.FlagDef{
				{Name: "dx", Type: cmdutil.FlagInt, Desc: "水平滚动量（正=右，负=左）"},
				{Name: "dy", Type: cmdutil.FlagInt, Desc: "垂直滚动量（正=下，负=上）"},
			},
			HasFormat: true,
		},
		{
			Use: "move <x> <y>", Short: "移动鼠标（不点击）",
			Example: "  tabtin desktop move 640 400",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/move",
			Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"x", "y"},
			HasFormat:   true,
		},
		{
			Use: "type <text>", Short: "键盘输入文字",
			Example: "  tabtin desktop type \"Hello World\"\n  tabtin desktop type \"你好世界\" --clipboard",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/type",
			Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"text"},
			Flags: []cmdutil.FlagDef{
				{Name: "clipboard", Type: cmdutil.FlagBool, Desc: "通过剪贴板粘贴（中文/emoji 必用）"},
			},
			HasFormat: true,
		},
		{
			Use: "key <key>", Short: "按键",
			Example: "  tabtin desktop key Enter\n  tabtin desktop key Backspace --repeat 5\n  tabtin desktop key c --modifiers cmd",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/key",
			Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"key"},
			Flags: []cmdutil.FlagDef{
				{Name: "modifiers", Type: cmdutil.FlagString, Desc: "修饰键（逗号分隔，如 cmd,shift）"},
				{Name: "repeat", Type: cmdutil.FlagInt, Desc: "重复次数"},
			},
			HasFormat: true,
			Validate: func(ctx *cmdutil.RunContext) error {
				if mods, ok := ctx.FlagValues["modifiers"].(string); ok && mods != "" {
					parts := strings.Split(mods, ",")
					trimmed := make([]string, 0, len(parts))
					for _, p := range parts {
						s := strings.TrimSpace(p)
						if s != "" {
							trimmed = append(trimmed, s)
						}
					}
					ctx.FlagValues["modifiers"] = trimmed
				}
				return nil
			},
		},
		{
			Use: "windows", Short: "列出所有窗口",
			Example: "  tabtin desktop windows\n  tabtin desktop windows --format table",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/windows",
			// ：只读枚举窗口（POST 仅因走 cli-server，无副作用）。
			Risk: cmdutil.RiskRead, RiskDeclared: true,
			HasFormat: true,
		},
		{
			Use: "activate <target>", Short: "激活窗口到前台",
			Example: "  tabtin desktop activate \"Google Chrome\"",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/activate",
			// ：把窗口拉到前台，改变桌面焦点状态。
			Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"target"},
			HasFormat:   true,
		},
		{
			Use: "open <name>", Short: "打开应用",
			Example: "  tabtin desktop open \"Slack\"\n  tabtin desktop open \"/Applications/Visual Studio Code.app\"\n  tabtin desktop open \"PowerShell\" --external",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/open",
			// ：启动本机应用，属系统状态变更。
			Risk: cmdutil.RiskWrite, RiskDeclared: true,
			ArgsMapping: []string{"name"},
			Flags: []cmdutil.FlagDef{
				{Name: "external", Type: cmdutil.FlagBool, Desc: "显式允许打开系统终端（PowerShell/cmd/Windows Terminal 等）；默认拦截并提示改用 tabtin terminal open"},
			},
			HasFormat: true,
		},
		{
			Use: "accessibility", Short: "检查辅助功能权限",
			Example: "  tabtin desktop accessibility\n  tabtin desktop accessibility --prompt",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/accessibility",
			// ：查询权限状态为只读（--prompt 仅唤起系统对话框，不改我方状态）。
			Risk: cmdutil.RiskRead, RiskDeclared: true,
			Flags: []cmdutil.FlagDef{
				{Name: "prompt", Type: cmdutil.FlagBool, Desc: "弹出系统引导对话框"},
			},
			HasFormat: true,
		},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(parent, f, def)
	}
}

func newDesktopScreenshotCmd(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "screenshot",
		Short: "截取屏幕",
		Example: `  tabtin desktop screenshot
  tabtin desktop screenshot --display 1
  tabtin desktop screenshot --max-dim 1920
  tabtin desktop screenshot --region 100,200,800,600
  tabtin desktop screenshot --save ~/screenshots/check.jpg`,
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}

			body := map[string]any{}

			if display, _ := cmd.Flags().GetInt("display"); display != 0 {
				body["displayId"] = display
			}
			if maxDim, _ := cmd.Flags().GetInt("max-dim"); maxDim != 0 {
				body["maxDimension"] = maxDim
			}
			if savePath, _ := cmd.Flags().GetString("save"); savePath != "" {
				body["savePath"] = savePath
			}
			if sessionID, _ := cmd.Flags().GetString("session-id"); sessionID != "" {
				body["sessionId"] = sessionID
			}
			if region, _ := cmd.Flags().GetString("region"); region != "" {
				parts := strings.Split(region, ",")
				if len(parts) != 4 {
					return fmt.Errorf("--region 格式错误，应为 x,y,w,h（如 100,200,800,600）")
				}
				vals := make([]int, 4)
				for i, p := range parts {
					v, parseErr := strconv.Atoi(strings.TrimSpace(p))
					if parseErr != nil {
						return fmt.Errorf("--region 参数含非数字值: %s", p)
					}
					vals[i] = v
				}
				body["region"] = map[string]int{
					"x": vals[0], "y": vals[1],
					"width": vals[2], "height": vals[3],
				}
			}

			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/screenshot", body, f.Format)
		}),
	}
	cmd.Flags().Int("display", 0, "显示器 ID")
	cmd.Flags().Int("max-dim", 0, "截图最大边长（默认 1280）")
	cmd.Flags().String("save", "", "保存路径")
	cmd.Flags().String("region", "", "截取区域 x,y,w,h")
	cmd.Flags().String("session-id", "", "会话 ID")
	return cmd
}

func newDesktopHotkeyCmd(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "hotkey <key1> <key2> ...",
		Short: "组合键",
		Long:  "按下组合键。参数为空格分隔的键名序列。",
		Example: `  tabtin desktop hotkey cmd c
  tabtin desktop hotkey cmd shift s
  tabtin desktop hotkey alt Tab`,
		Args: cobra.MinimumNArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}
			body := map[string]any{"keys": args}
			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/hotkey", body, f.Format)
		}),
	}
}

// newDesktopExtendAllowlistCmd 实现 `tabtin desktop session extend-allowlist <app>...`
// （规范 § 6.12）。session 进行中 Agent 发现需要新应用时主动请求扩权，
// 扩权必过新审批（弹窗），通过则 append 去重合并到 session.allowedApps。
func newDesktopExtendAllowlistCmd(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "extend-allowlist <app_name> [<app_name>...]",
		Short: "扩展当前 session 的允许应用列表（需用户重新审批）",
		Long: `扩展当前桌面操控 session 的 allowedApps 白名单。

场景：首次 screenshot 时声明了 allowedApps（如 [Figma, VS Code]），
session 进行中 Agent 发现需要额外的应用（如打开 Chrome 查规范文档）。

行为（规范 § 6.12）：
  1. 弹出新的审批窗，展示 "从 [原列表] 扩到 [合并后列表]" + 可选 --reason
  2. 用户选"允许"  → session.allowedApps append 去重合并
  3. 用户选"拒绝"  → 原白名单保持不变，当前 session 继续可用

与 /session/start 的区别：扩权**不提供"总是允许"**——每次扩都要弹，
确保第一次审批的边界意义不被架空。`,
		Example: `  tabtin desktop session extend-allowlist "Google Chrome"
  tabtin desktop session extend-allowlist "Google Chrome" --reason "需要在浏览器里查规范文档"
  tabtin desktop session extend-allowlist "Finder" "Preview"`,
		Args: cobra.MinimumNArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}

			apps := make([]string, 0, len(args))
			for _, a := range args {
				trimmed := strings.TrimSpace(a)
				if trimmed != "" {
					apps = append(apps, trimmed)
				}
			}
			if len(apps) == 0 {
				return fmt.Errorf("至少需要提供一个应用名")
			}

			sessionID, _ := cmd.Flags().GetString("session-id")
			if strings.TrimSpace(sessionID) == "" {
				return fmt.Errorf(
					"缺少 --session-id：扩权必须指定当前 active session 的 id（可从 tabtin desktop screenshot 首次返回获取）",
				)
			}

			body := map[string]any{
				"sessionId": strings.TrimSpace(sessionID),
				"apps":      apps,
			}
			if reason, _ := cmd.Flags().GetString("reason"); strings.TrimSpace(reason) != "" {
				body["reason"] = strings.TrimSpace(reason)
			}

			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/session/extend-allowlist", body, f.Format)
		}),
	}
	cmd.Flags().String("session-id", "", "当前 active session 的 id（必填）")
	cmd.Flags().String("reason", "", "扩权意图说明，展示在审批弹窗中")
	return cmd
}

// newDesktopBatchCmd 实现 `tabtin desktop batch` —— Wave 3 · 规范 § 4.5.2。
//
// Agent 用 1 次 CLI 调用批量执行"点击 → 输入 → 回车"这类可预测序列，省掉
// 每步 200-1500ms 的 LLM RTT。actions 数组由 JSON 文件或 stdin 传入。
//
// Q5 硬性校验：actions[0].action 不能是 'screenshot'（冷启动先单独调
// `tabtin desktop screenshot` 建立 session）。CLI 只做"读进来原样转发"，
// 校验与执行由 Electron 侧 Executor + 路由层双重防线负责。
func newDesktopBatchCmd(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "batch [-|<file>]",
		Short: "批量执行多个桌面操控子动作（单次调用多步）",
		Long: `在一次 CLI 调用里按序执行一组子动作（规范 § 4.5.2 computer_batch）。

用途：
  Agent 遇到"点击输入框 → 输入文字 → 按 Return"这类可预测序列时，batch
  可把 3 次调用合并成 1 次，省 2 次 LLM RTT。

失败策略：
  stop-on-first-error——某一步失败后后续步骤不执行；不自动回滚（鼠标键盘
  本质不可逆，回滚决策归 Agent）。返回的 JSON 里 stepsCompleted + stepFailed
  让 Agent 知道从哪一步续跑。

硬性规则（Q5）：
  actions[0].action 不能是 "screenshot"——冷启动无 session 时先单独调
  tabtin desktop screenshot 建立 session 后再发 batch。非首项的 screenshot
  是正常子动作（中途刷新坐标系）。

子动作 action 枚举：
  click / scroll / drag / move / type / key / hotkey / screenshot / wait`,
		Example: `  # 文件输入
  tabtin desktop batch --file ops.json
  # 或
  tabtin desktop batch ops.json

  # stdin 输入（推荐）
  echo '[{"action":"click","x":640,"y":400},{"action":"type","text":"hi"},{"action":"key","key":"Enter"}]' \
    | tabtin desktop batch -

  # 中文输入必带 useClipboard=true
  cat <<'EOF' | tabtin desktop batch -
  [
    {"action":"click","x":100,"y":200},
    {"action":"type","text":"你好世界","useClipboard":true},
    {"action":"key","key":"Enter"}
  ]
  EOF`,
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}

			raw, readErr := readBatchActions(cmd, args)
			if readErr != nil {
				return readErr
			}

			// 仅结构校验——首项 screenshot 硬拦截在 Electron 路由层 + Executor
			// 入口（双重防线）；CLI 不做语义校验，避免拆分规则散在三处。
			var actions []any
			if err := json.Unmarshal(raw, &actions); err != nil {
				return fmt.Errorf("actions JSON 解析失败：%w；请确保是形如 "+
					`[{"action":"click","x":640,"y":400}, ...] 的数组`, err)
			}
			if len(actions) == 0 {
				return fmt.Errorf("actions 数组不能为空；至少提供一个子动作")
			}

			body := map[string]any{"actions": actions}
			if sessionID, _ := cmd.Flags().GetString("session-id"); sessionID != "" {
				body["sessionId"] = sessionID
			}
			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/batch", body, f.Format)
		}),
	}
	cmd.Flags().String("file", "", "从 JSON 文件读取 actions 数组（等价于位置参数指向文件路径）")
	cmd.Flags().String("session-id", "", "当前 session id（非必填；缺省用现有 session）")
	return cmd
}

// readBatchActions 按约定读取 batch actions JSON：
//   - 位置参数 "-" → 从 stdin 读
//   - 位置参数是路径 → 读文件
//   - --file <path> → 读文件（与位置参数等价；`--file` 优先）
//   - 都没有 → 错误
//
// 设计与 `kubectl apply -f` / `curl -d @-` 等工具的惯例一致——新手 Agent
// 看到 `-` 会自然联想到 stdin。
func readBatchActions(cmd *cobra.Command, args []string) ([]byte, error) {
	if filePath, _ := cmd.Flags().GetString("file"); strings.TrimSpace(filePath) != "" {
		return os.ReadFile(strings.TrimSpace(filePath))
	}
	if len(args) == 0 {
		return nil, fmt.Errorf("batch 需要指定 actions 源：--file <path>、" +
			"位置参数 <path>、或 `-` 表示从 stdin 读。" +
			`示例：echo '[{"action":"click","x":10,"y":20}]' | tabtin desktop batch -`)
	}
	src := strings.TrimSpace(args[0])
	if src == "-" {
		return io.ReadAll(os.Stdin)
	}
	return os.ReadFile(src)
}

func newDesktopDragCmd(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "drag <x1,y1> <x2,y2>",
		Short: "鼠标拖拽",
		Long:  "从 (x1,y1) 拖拽到 (x2,y2)。坐标用逗号分隔。",
		Example: `  tabtin desktop drag 100,200 500,200
  tabtin desktop drag 100,200 500,200 --duration 1000`,
		Args: cobra.ExactArgs(2),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			from := strings.Split(args[0], ",")
			to := strings.Split(args[1], ",")
			if len(from) != 2 || len(to) != 2 {
				return fmt.Errorf("坐标格式错误，应为 x,y（如 100,200 500,200）")
			}

			fromX, err1 := strconv.Atoi(strings.TrimSpace(from[0]))
			fromY, err2 := strconv.Atoi(strings.TrimSpace(from[1]))
			toX, err3 := strconv.Atoi(strings.TrimSpace(to[0]))
			toY, err4 := strconv.Atoi(strings.TrimSpace(to[1]))
			if err1 != nil || err2 != nil || err3 != nil || err4 != nil {
				return fmt.Errorf("坐标含非数字值")
			}

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}

			body := map[string]any{
				"fromX": fromX, "fromY": fromY,
				"toX": toX, "toY": toY,
			}
			if duration, _ := cmd.Flags().GetInt("duration"); duration > 0 {
				body["duration"] = duration
			}
			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/drag", body, f.Format)
		}),
	}
	cmd.Flags().Int("duration", 0, "拖拽持续时间（毫秒，默认 500）")
	return cmd
}

func doDesktopRequest(ctx context.Context, tr transport.Transport, method, path string, body map[string]any, format output.Format) error {
	if ctx == nil {
		ctx = context.Background()
	}
	resp, err := tr.Request(ctx, method, path, body, nil)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
	}
	if resp.Status >= 400 {
		exitCode := cmdutil.MapHTTPToExitCode(resp.Status)
		var errData map[string]any
		if json.Unmarshal(resp.Data, &errData) == nil {
			code, message, hint := cmdutil.ExtractAPIError(errData)
			if code != "" || message != "" {
				if code == "" {
					code = cmdutil.HTTPStatusToErrorCode(resp.Status)
				}
				if message == "" {
					message = fmt.Sprintf("请求失败 (status %d)", resp.Status)
				}
				return output.PrintErrorAndExit(output.ErrorEnvelope(code, message, hint, exitCode))
			}
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			cmdutil.HTTPStatusToErrorCode(resp.Status),
			fmt.Sprintf("请求失败 (status %d): %s", resp.Status, string(resp.Data)),
			"",
			exitCode,
		))
	}
	var data any
	_ = json.Unmarshal(resp.Data, &data)
	output.PrintResult(output.UnwrapDjangoEnvelope(data), format)
	return nil
}

// newDesktopAccessibilityTreeCmd 实现 `tabtin desktop accessibility-tree`
// （模块四 · 规范 § 4.6.3）。获取前台/指定窗口的 AX 快照。
func newDesktopAccessibilityTreeCmd(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "accessibility-tree",
		Short: "获取窗口 Accessibility Tree（AX 快照）",
		Long: `获取当前前台应用（或指定窗口）的 Accessibility Tree 快照。

AX 快照以 JSON 形式返回元素树（name / role / bounds / enabled / visible / children），
Agent 可用 click-element / type-into-element 按元素名直接操作，不需要猜坐标。`,
		Example: `  tabtin desktop accessibility-tree
  tabtin desktop accessibility-tree --window 'Figma'
  tabtin desktop accessibility-tree --bundle-id com.apple.TextEdit
  tabtin desktop accessibility-tree --max-depth 6 --no-interactive-only`,
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}

			body := map[string]any{}
			if w, _ := cmd.Flags().GetString("window"); w != "" {
				body["window"] = w
			}
			if bid, _ := cmd.Flags().GetString("bundle-id"); bid != "" {
				body["bundleId"] = bid
			}
			if md, _ := cmd.Flags().GetInt("max-depth"); md > 0 {
				body["maxDepth"] = md
			}
			noInteractive, _ := cmd.Flags().GetBool("no-interactive-only")
			if noInteractive {
				body["interactiveOnly"] = false
			}
			if mn, _ := cmd.Flags().GetInt("max-nodes"); mn > 0 {
				body["maxNodes"] = mn
			}
			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/accessibility-tree", body, f.Format)
		}),
	}
	cmd.Flags().String("window", "", "按窗口标题子串匹配")
	cmd.Flags().String("bundle-id", "", "按 macOS bundle id 定位")
	cmd.Flags().Int("max-depth", 0, "递归深度上限（默认 4）")
	cmd.Flags().Bool("no-interactive-only", false, "返回全部节点（默认仅交互元素）")
	cmd.Flags().Int("max-nodes", 0, "返回节点数上限（默认 500），超出截断")
	return cmd
}

// newDesktopClickElementCmd 实现 `tabtin desktop click-element`
// （模块四 · 规范 § 4.6.3）。按元素名/角色点击。
func newDesktopClickElementCmd(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "click-element",
		Short: "按元素名点击（AX 精确定位）",
		Long: `按名字 + 角色（可选）定位并点击元素。底层先查 AX 拿 bounds，再走
现有 click 路径（含 pixelCompare 防护）。优先使用此命令代替坐标点击。`,
		Example: `  tabtin desktop click-element --name 'Share' --role Button
  tabtin desktop click-element --name 'A1' --role DataItem
  tabtin desktop click-element --name 'Save' --role Button --nth 1
  tabtin desktop click-element --name 'Submit' --button right`,
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}

			name, _ := cmd.Flags().GetString("name")
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("缺少 --name：click-element 需要指定要点击的元素名")
			}

			body := map[string]any{"name": name}
			if role, _ := cmd.Flags().GetString("role"); role != "" {
				body["role"] = role
			}
			if aid, _ := cmd.Flags().GetString("automation-id"); aid != "" {
				body["automationId"] = aid
			}
			if nth, _ := cmd.Flags().GetInt("nth"); nth > 0 {
				body["nth"] = nth
			}
			if btn, _ := cmd.Flags().GetString("button"); btn != "" {
				body["button"] = btn
			}
			if cnt, _ := cmd.Flags().GetInt("count"); cnt > 0 {
				body["count"] = cnt
			}
			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/click-element", body, f.Format)
		}),
	}
	cmd.Flags().String("name", "", "元素可见名（必填，大小写不敏感 partial match）")
	cmd.Flags().String("role", "", "限定角色（Button / Edit / MenuItem 等）")
	cmd.Flags().String("automation-id", "", "Windows UIA AutomationId")
	cmd.Flags().Int("nth", 0, "同名多元素取第 N 个（0-based）")
	cmd.Flags().String("button", "", "鼠标按钮 (left/right/middle)")
	cmd.Flags().Int("count", 0, "点击次数（2=双击）")
	return cmd
}

// newDesktopTypeIntoElementCmd 实现 `tabtin desktop type-into-element`
// （模块四 · 规范 § 4.6.3）。按元素名定位输入框并输入文本。
func newDesktopTypeIntoElementCmd(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "type-into-element <text>",
		Short: "按元素名定位输入框并输入文本",
		Long: `按名字 + 角色定位输入框并输入文本。底层先查 AX 拿 bounds，click 激活
元素后 type 输入文本。中文/emoji 走 --clipboard 模式。`,
		Example: `  tabtin desktop type-into-element --name 'Email' 'user@example.com'
  tabtin desktop type-into-element --name 'Password' 'my_pwd_123'
  tabtin desktop type-into-element --name 'Search' '规范文档' --clipboard`,
		Args: cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable), err.Error(),
					"tabtin daemon start", output.ExitServiceUnavail,
				))
			}

			name, _ := cmd.Flags().GetString("name")
			if strings.TrimSpace(name) == "" {
				return fmt.Errorf("缺少 --name：type-into-element 需要指定目标元素名")
			}

			body := map[string]any{
				"name": name,
				"text": args[0],
			}
			if role, _ := cmd.Flags().GetString("role"); role != "" {
				body["role"] = role
			}
			if aid, _ := cmd.Flags().GetString("automation-id"); aid != "" {
				body["automationId"] = aid
			}
			if clip, _ := cmd.Flags().GetBool("clipboard"); clip {
				body["clipboard"] = true
			}
			return doDesktopRequest(cmd.Context(), tr, "POST", "/desktop/type-into-element", body, f.Format)
		}),
	}
	cmd.Flags().String("name", "", "目标元素可见名（必填）")
	cmd.Flags().String("role", "", "限定角色（Edit / TextField 等）")
	cmd.Flags().String("automation-id", "", "Windows UIA AutomationId")
	cmd.Flags().Bool("clipboard", false, "中文/emoji 走剪贴板粘贴")
	return cmd
}

func renameFlag(ctx *cmdutil.RunContext, from, to string) {
	if v, ok := ctx.FlagValues[from]; ok && v != nil && v != "" {
		ctx.FlagValues[to] = v
		delete(ctx.FlagValues, from)
	}
}

// ─── Schema 定义（供 root.go RegisterCommandSchema 使用）──

func desktopScreenshotCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "screenshot", Short: "截取屏幕",
		Example: "  tabtin desktop screenshot\n  tabtin desktop screenshot --max-dim 1920\n  tabtin desktop screenshot --region 100,200,800,600",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/screenshot",
		Risk: cmdutil.RiskRead, RiskDeclared: true, // ：截屏只读
		HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "display", Type: cmdutil.FlagInt, Desc: "显示器 ID"},
			{Name: "max-dim", Type: cmdutil.FlagInt, Desc: "截图最大边长（默认 1280）"},
			{Name: "save", Type: cmdutil.FlagString, Desc: "保存路径"},
			{Name: "region", Type: cmdutil.FlagString, Desc: "截取区域 x,y,w,h"},
			{Name: "session-id", Type: cmdutil.FlagString, Desc: "会话 ID"},
		},
	}
}

func desktopHotkeyCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "hotkey <key1> <key2> ...", Short: "组合键",
		Example: "  tabtin desktop hotkey cmd c\n  tabtin desktop hotkey cmd shift s",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/hotkey",
		Risk: cmdutil.RiskWrite, RiskDeclared: true, // ：组合键操控
		HasFormat: true,
	}
}

func desktopDragCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "drag <x1,y1> <x2,y2>", Short: "鼠标拖拽",
		Example: "  tabtin desktop drag 100,200 500,200",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/drag",
		Risk: cmdutil.RiskWrite, RiskDeclared: true, // ：鼠标拖拽操控
		HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "duration", Type: cmdutil.FlagInt, Desc: "拖拽持续时间（毫秒，默认 500）"},
		},
	}
}

func desktopBatchCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "batch [-|<file>]", Short: "批量执行多个桌面操控子动作",
		Example: "  echo '[{\"action\":\"click\",\"x\":640,\"y\":400}]' | tabtin desktop batch -\n  tabtin desktop batch --file ops.json",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/batch",
		Risk: cmdutil.RiskWrite, RiskDeclared: true, // ：批量操控子动作
		HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "file", Type: cmdutil.FlagString, Desc: "从 JSON 文件读取 actions 数组"},
			{Name: "session-id", Type: cmdutil.FlagString, Desc: "当前 session id"},
		},
	}
}

func desktopAccessibilityTreeCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "accessibility-tree", Short: "获取窗口 Accessibility Tree（AX 快照）",
		Example: "  tabtin desktop accessibility-tree\n  tabtin desktop accessibility-tree --window 'Figma'",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/accessibility-tree",
		Risk: cmdutil.RiskRead, RiskDeclared: true, // ：AX 快照只读
		HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "window", Type: cmdutil.FlagString, Desc: "按窗口标题子串匹配"},
			{Name: "bundle-id", Type: cmdutil.FlagString, Desc: "按 macOS bundle id 定位"},
			{Name: "max-depth", Type: cmdutil.FlagInt, Desc: "递归深度上限（默认 4）"},
			{Name: "no-interactive-only", Type: cmdutil.FlagBool, Desc: "返回全部节点（默认仅交互元素）"},
			{Name: "max-nodes", Type: cmdutil.FlagInt, Desc: "返回节点数上限（默认 500）"},
		},
	}
}

func desktopClickElementCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "click-element", Short: "按元素名点击（AX 精确定位）",
		Example: "  tabtin desktop click-element --name 'Share' --role Button",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/click-element",
		Risk: cmdutil.RiskWrite, RiskDeclared: true, // ：AX 定位点击操控
		HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "元素可见名"},
			{Name: "role", Type: cmdutil.FlagString, Desc: "限定角色（Button / Edit / MenuItem 等）"},
			{Name: "automation-id", Type: cmdutil.FlagString, Desc: "Windows UIA AutomationId"},
			{Name: "nth", Type: cmdutil.FlagInt, Desc: "同名多元素取第 N 个（0-based）"},
			{Name: "button", Type: cmdutil.FlagString, Desc: "鼠标按钮 (left/right/middle)"},
			{Name: "count", Type: cmdutil.FlagInt, Desc: "点击次数（2=双击）"},
		},
	}
}

func desktopTypeIntoElementCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "type-into-element <text>", Short: "按元素名定位输入框并输入文本",
		Example: "  tabtin desktop type-into-element --name 'Email' 'user@example.com'",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/type-into-element",
		Risk: cmdutil.RiskWrite, RiskDeclared: true, // ：AX 定位输入操控
		HasFormat:   true,
		ArgsMapping: []string{"text"},
		Flags: []cmdutil.FlagDef{
			{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "目标元素可见名"},
			{Name: "role", Type: cmdutil.FlagString, Desc: "限定角色（Edit / TextField 等）"},
			{Name: "automation-id", Type: cmdutil.FlagString, Desc: "Windows UIA AutomationId"},
			{Name: "clipboard", Type: cmdutil.FlagBool, Desc: "中文/emoji 走剪贴板粘贴"},
		},
	}
}

func desktopExtendAllowlistCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "extend-allowlist <app_name> [<app_name>...]", Short: "扩展当前 session 的允许应用列表",
		Example: "  tabtin desktop session extend-allowlist \"Google Chrome\"",
		Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/desktop/session/extend-allowlist",
		Risk: cmdutil.RiskWrite, RiskDeclared: true, // ：改会话允许应用列表
		HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "session-id", Type: cmdutil.FlagString, Required: true, Desc: "当前 active session 的 id"},
			{Name: "reason", Type: cmdutil.FlagString, Desc: "扩权意图说明"},
		},
	}
}
