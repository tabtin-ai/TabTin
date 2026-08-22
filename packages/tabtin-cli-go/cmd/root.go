package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/cmd/agent"
	"github.com/TabTin/tabtin-cli/cmd/auth"
	"github.com/TabTin/tabtin-cli/cmd/browser"
	configcmd "github.com/TabTin/tabtin-cli/cmd/configcmd"
	"github.com/TabTin/tabtin-cli/cmd/profile"
	"github.com/TabTin/tabtin-cli/cmd/table"
	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/extension"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
	"github.com/TabTin/tabtin-cli/internal/version"
)

var timeNow = time.Now

// registerPkgContentTypeFetcher 在生产 Execute() 入口注入 content_type SSoT fetcher。
// W5-修1:把 W4 半交付补完 — fetcher hook 真正接入 cobra 入口,使 pkg publish 优先用
// 后端权威字典。fetch 失败时 pkgGuessContentType 内部 fallback 到内置兜底,生产不破。
func registerPkgContentTypeFetcher(f *cmdutil.Factory) {
	pkgSetContentTypeFetchOverride(func(fetchCtx context.Context) (map[string]string, string, error) {
		// 容忍 profile 加载失败：TABTIN_API_URL 环境变量已能驱动 baseURL，
		// profile 缺失时（首次启动 / 测试场景）应继续走 env-only 路径，
		// 而不是直接返回错误把整个 fetcher 拉死。
		profile, _ := f.Profile()
		baseURL := config.ResolveBaseURL(profile)
		if baseURL == "" {
			return nil, "", fmt.Errorf("no baseURL configured")
		}
		return pkgFetchContentTypesViaURL(fetchCtx, baseURL)
	})
}

func Execute() int {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	f := cmdutil.NewFactory()

	// W5-修1: content_type SSoT 接入生产入口。
	// W4 半交付遗留:fetcher hook 已就位但 Execute() 未注入 — pkg publish 实际仍走
	// 内置兜底 map。生产入口注入一个 lazy fetcher,真正调用时才从 profile 解析
	// baseURL 并 fetch /utils/content-types。fetch 失败时 pkgGuessContentType 内部
	// 已 fallback 到 pkgBuiltinContentTypeMap,生产链路不破。
	registerPkgContentTypeFetcher(f)

	rootCmd := &cobra.Command{
		Use:   "tabtin [message]",
		Short: "TabTin — Agent-Native CLI",
		Long: `TabTin CLI — 人与 AI Agent 团队协作的统一平台。

直接输入消息即可与当前 Agent 对话：
  tabtin "帮我分析这个数据"
  tabtin -p "查询所有表格"

使用子命令管理 Agent、数据和应用。`,
		Version:       version.Full(),
		SilenceUsage:  true,
		SilenceErrors: true,
		// PersistentPreRunE：用 E 后缀以便 --jq + --output 互斥返回 error；error 会让 cobra 在
		// SilenceUsage=true / SilenceErrors=true 下交给上层 Execute 处理。
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			profileFlag, _ := cmd.Flags().GetString("profile")
			if profileFlag != "" {
				os.Setenv("TABTIN_PROFILE", profileFlag)
				f.ResetTransport()
			}
			agentID, _ := cmd.Flags().GetString("agent-id")
			if agentID != "" {
				os.Setenv("TABTIN_AGENT_ID", agentID)
			}
			//  Space 终态退役：--workspace-id 是终态 flag；--space-id 是过渡期
			// 别名。两者均把值写入 TABTIN_WORKSPACE_ID + TABTIN_SPACE_ID，让还未
			// 迁移的代码路径继续读老 env。同时给 --space-id 一条 stderr 提示。
			workspaceID, _ := cmd.Flags().GetString("workspace-id")
			if workspaceID != "" {
				os.Setenv("TABTIN_WORKSPACE_ID", workspaceID)
				os.Setenv("TABTIN_SPACE_ID", workspaceID)
			}
			spaceID, _ := cmd.Flags().GetString("space-id")
			if spaceID != "" {
				fmt.Fprintln(os.Stderr, "warning: --space-id 已改名为 --workspace-id。旧 flag 将在后续版本移除。")
				os.Setenv("TABTIN_SPACE_ID", spaceID)
				if workspaceID == "" {
					os.Setenv("TABTIN_WORKSPACE_ID", spaceID)
				}
			}
			organizationID, _ := cmd.Flags().GetString("organization-id")
			if organizationID != "" {
				os.Setenv("TABTIN_ORGANIZATION_ID", organizationID)
			}
			formatFlag, _ := cmd.Flags().GetString("format")
			if formatFlag != "" {
				// v10.12 P1：显式 --format 走 strict 校验，非法值直接 exit 2，
				// 不再 ParseFormat 静默回退 FormatJSON（"silent accept" 漏洞）。
				// 配置默认值 (cfg.Defaults.Format) 仍用 lenient ParseFormat——
				// 历史脏配置不该让 CLI 启动直接挂。
				parsed, err := output.ParseFormatStrict(formatFlag)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						string(errcode.ValidationError),
						err.Error(),
						"--format 只接受 "+strings.Join(output.ValidFormats, " | "),
						output.ExitValidation,
					))
				}
				f.Format = parsed
			} else if os.Getenv("TABTIN_AGENT") == "1" {
				f.Format = output.FormatAgent
			} else if cfg, err := f.Config(); err == nil && cfg.Defaults.Format != "" {
				f.Format = output.ParseFormat(cfg.Defaults.Format)
			} else if cmdutil.IsTerminal() {
				f.Format = output.FormatPretty
			}
			verbose, _ := cmd.Flags().GetBool("verbose")
			if verbose {
				os.Setenv("TABTIN_VERBOSE", "1")
			}
			debug, _ := cmd.Flags().GetBool("debug")
			if debug {
				os.Setenv("TABTIN_DEBUG", "1")
			}
			noColor, _ := cmd.Flags().GetBool("no-color")
			if noColor {
				os.Setenv("NO_COLOR", "1")
				output.SetNoColor(true)
			}
			timeout, _ := cmd.Flags().GetDuration("timeout")
			if timeout > 0 {
				f.GlobalTimeout = timeout
			}
			// --jq 仍从 merged flag 取（jq 没有 child shadow 风险，root 独有）
			// v10.3 P0：同时设 output 包全局变量，让手写命令 / dry-run / 任何走
			// PrintResultWithSchema/Force 的路径都能正确应用 jq。
			jqExpr, _ := cmd.Flags().GetString("jq")
			if jqExpr != "" {
				f.JQExpr = jqExpr
				f.Format = output.FormatJSON
				output.SetGlobalJQ(jqExpr)
			}
			// --quiet / -Q / TABTIN_QUIET=1 (Sprint 1.C)
			quiet, _ := cmd.Flags().GetBool("quiet")
			if quiet || os.Getenv("TABTIN_QUIET") == "1" {
				f.Quiet = true
				output.SetQuietMode(true)
			}

			// --inline：禁用大输出自动落盘兜底，超限也直接内联 stdout。
			inline, _ := cmd.Flags().GetBool("inline")
			if inline {
				output.SetGlobalInline(true)
			}

			// --output（long only）(Sprint 1.C / v10 P0 修复)
			//
			// 关键：必须用 cmd.Root().PersistentFlags().Lookup("output") 而不是
			// cmd.Flags().GetString("output")——后者会读到 child 命令同名 -o 的 shadow
			// 值（cobra inherit），导致 `table export csv -o /tmp/x.csv` 时 root 误以为
			// 全局 --output=/tmp/x.csv 触发双重写盘。
			//
			// 用 Lookup(...).Changed 判定 root persistent --output 自己是否被设。
			rootOutFlag := cmd.Root().PersistentFlags().Lookup("output")
			if rootOutFlag != nil && rootOutFlag.Changed {
				outPath := rootOutFlag.Value.String()

				// v10 P1：--output + --jq 全局互斥——pipeline / 手写命令都拦
				if f.JQExpr != "" {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						"VALIDATION_ERROR",
						"--output 与 --jq 不能同时使用",
						"先写盘后用 jq 处理文件：tabtin <cmd> --output out.json && jq '...' out.json",
						output.ExitValidation,
					))
				}

				// 同时设 Factory 字段（pipeline 旧路径仍读 f.OutputPath）和 output
				// 包全局变量（手写命令 PrintResult 入口走全局写盘）。
				f.OutputPath = outPath
				output.SetGlobalOutputPath(outPath)
			}
			output.SetActiveFormat(f.Format)
			return nil
		},
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			if len(args) == 0 {
				return cmd.Help()
			}
			agentCmd, _, _ := cmd.Find([]string{"agent", "run"})
			if agentCmd == nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.InternalError), "agent run 命令未找到", "", output.ExitGeneral,
				))
			}
			agentCmd.SetArgs(append([]string{"--"}, args...))
			err := agentCmd.Execute()
			if err != nil {
				fmt.Fprintln(os.Stderr, "提示：如需使用更多选项（如 -c/--continue、-m/--model、-p/--pipe），请使用完整命令 `tabtin agent run`")
			}
			return err
		}),
	}

	rootCmd.PersistentFlags().String("profile", "", "使用指定 Profile")
	rootCmd.PersistentFlags().String("agent-id", "", "指定 Agent ID")
	//  --workspace-id 是终态；--space-id 保留为过渡期别名（隐藏，仍生效）。
	rootCmd.PersistentFlags().String("workspace-id", "", "指定 Workspace ID")
	rootCmd.PersistentFlags().String("space-id", "", "[已改名] 指定 Workspace ID（请使用 --workspace-id）")
	if flag := rootCmd.PersistentFlags().Lookup("space-id"); flag != nil {
		flag.Hidden = true
		flag.Deprecated = "改用 --workspace-id"
	}
	rootCmd.PersistentFlags().String("organization-id", "", "指定 Organization ID")
	rootCmd.PersistentFlags().String("format", "", "输出格式: json | table | csv | pretty | agent")
	rootCmd.PersistentFlags().BoolP("verbose", "v", false, "详细输出")
	rootCmd.PersistentFlags().Bool("debug", false, "调试模式")
	rootCmd.PersistentFlags().Bool("yes", false, "跳过确认提示")
	rootCmd.PersistentFlags().Bool("dry-run", false, "显示将执行的操作但不执行")
	rootCmd.PersistentFlags().Bool("no-color", false, "禁用颜色输出")
	rootCmd.PersistentFlags().Duration("timeout", 0, "请求超时")
	rootCmd.PersistentFlags().String("jq", "", "jq 表达式过滤输出")
	rootCmd.PersistentFlags().String("batch", "", "批量操作：JSONL 文件路径（- 表示 stdin），每行一个操作")
	// --quiet：成功路径 stdout 抑制；失败 envelope 仍走 stderr（Sprint 1.C）
	rootCmd.PersistentFlags().BoolP("quiet", "Q", false, "静默模式：成功 stdout 抑制，错误 envelope 仍走 stderr")
	// --inline：禁用大输出自动落盘兜底——超过 64KB 也直接内联 stdout（人用管道场景）
	rootCmd.PersistentFlags().Bool("inline", false, "禁用大输出自动落盘：即使超过体量上限也直接输出到 stdout")
	// --output：long flag only，**不能加 -o**（与 agent run / api / table export 的 -o 冲突会 panic）
	//
	// v10.2 P1 修复文案：实际行为是"按 --format 渲染后写盘"，不是 raw envelope JSON。
	//   - 默认 --format json → 文件是 envelope JSON
	//   - --format csv → 文件是 CSV
	//   - --format table → 文件是表格文本
	//   - 二进制响应（PDF/Excel）：base64 解码后写原始 bytes
	//   - 与 --jq 互斥（VALIDATION_ERROR）
	rootCmd.PersistentFlags().String("output", "", "把成功响应写到文件（按 --format 渲染：json→envelope JSON / csv→CSV / table→表格；二进制响应自动 base64 解码；与 --jq 互斥）")

	rootCmd.AddCommand(agent.NewCmdAgent(f))
	// ：Agent 记忆治理挂到 agent 下（tabtin agent memory ...）。
	if agentCmd, _, findErr := rootCmd.Find([]string{"agent"}); findErr == nil && agentCmd != nil && agentCmd.Name() == "agent" {
		agentCmd.AddCommand(newCmdAgentMemory(f))
	}
	rootCmd.AddCommand(auth.NewCmdAuth(f))
	rootCmd.AddCommand(browser.NewCmdBrowser(f))
	rootCmd.AddCommand(configcmd.NewCmdConfig(f))
	rootCmd.AddCommand(profile.NewCmdProfile(f))
	rootCmd.AddCommand(table.NewCmdTable(f))

	rootCmd.AddCommand(newCmdSlide(f))
	rootCmd.AddCommand(newCmdSite(f))
	rootCmd.AddCommand(newCmdEvent(f))
	rootCmd.AddCommand(newCmdTracker(f))
	rootCmd.AddCommand(newCmdMedia(f))
	rootCmd.AddCommand(newCmdAudio(f))
	rootCmd.AddCommand(newCmdCode(f))
	rootCmd.AddCommand(newCmdFile(f))
	rootCmd.AddCommand(newCmdDoc(f))
	rootCmd.AddCommand(newCmdMemo(f))
	rootCmd.AddCommand(newCmdDaemon(f))
	rootCmd.AddCommand(newCmdMcp(f))
	rootCmd.AddCommand(newCmdPlugin(f))
	rootCmd.AddCommand(newCmdSkill(f))
	rootCmd.AddCommand(newCmdSkills(f))
	rootCmd.AddCommand(newCmdCapabilities(f))
	rootCmd.AddCommand(newCmdTask(f))
	rootCmd.AddCommand(newCmdDevice(f))
	rootCmd.AddCommand(newCmdDesktop(f))
	rootCmd.AddCommand(newCmdTerminal(f))
	rootCmd.AddCommand(newCmdReach(f))
	rootCmd.AddCommand(newCmdFetch(f))
	rootCmd.AddCommand(newCmdOSS(f))
	rootCmd.AddCommand(newCmdDrive(f))
	rootCmd.AddCommand(newCmdStorage(f))
	rootCmd.AddCommand(newCmdFeishu(f))

	// App Market H1 · G1 — marketplace App 平台子命令（薄 shim fork Python tabtin_cli）
	// v3.1 方向锚：connect 命令族整体删除（Connect 模型作废），只剩 install
	// uninstall / upgrade 将在 Step H 补齐
	rootCmd.AddCommand(newCmdInstall(f))
	rootCmd.AddCommand(newCmdProject(f))

	//  终态命令 `tabtin workspace`；`tabtin space` 是过渡期兼容别名（hidden）。
	workspaceCmd := newCmdWorkspace(f)
	rootCmd.AddCommand(workspaceCmd)
	spaceCmd := newCmdSpace(f)
	rootCmd.AddCommand(spaceCmd)
	contextCmd := newCmdContext(f)
	rootCmd.AddCommand(contextCmd)
	rootCmd.AddCommand(newCmdContextItem(f))
	organizationCmd := newCmdOrganization(f)
	rootCmd.AddCommand(organizationCmd)
	searchCmd := newCmdSearch(f)
	rootCmd.AddCommand(searchCmd)
	pkgCmd := newCmdPkg(f)
	rootCmd.AddCommand(pkgCmd)
	apiCmd := newCmdAPI(f)
	rootCmd.AddCommand(apiCmd)
	aboutCmd := newCmdAbout(f)
	rootCmd.AddCommand(aboutCmd)
	doctorCmd := newCmdDoctor(f)
	rootCmd.AddCommand(doctorCmd)
	pingCmd := newCmdPing(f)
	rootCmd.AddCommand(pingCmd)
	statusCmd := newCmdStatus(f)
	rootCmd.AddCommand(statusCmd)
	completionCmd := newCmdCompletionInstall(f)
	rootCmd.AddCommand(completionCmd)
	commandsCmd := newCmdCommands(f)
	rootCmd.AddCommand(commandsCmd)
	// L31：commands 自身的 stdout schema 注册——`tabtin commands --format json`
	// 输出顶层 array of CommandSchema，UI cli_output_table 渲染器（W4）+ schema
	// 命中（L31）后能直接展示成"命令名 + 描述 + 风险"表格。
	cmdutil.RegisterCommandSchema(commandsCmd, cmdutil.CommandDef{
		Use: "commands", Short: "列出所有可用命令及其 Schema",
		HasFormat: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "name", Label: "命令", Type: "string"},
			{Key: "description", Label: "描述", Type: "string"},
			{Key: "method", Label: "方法", Type: "string"},
			{Key: "path", Label: "路径", Type: "string"},
			{Key: "risk", Label: "风险", Type: "string"},
			{Key: "source", Label: "来源", Type: "string"},
		},
	})
	historyCmd := newCmdHistory(f)
	rootCmd.AddCommand(historyCmd)
	invokeCmd := newCmdInvoke(f)
	rootCmd.AddCommand(invokeCmd)

	// ─── Schema 注册：手写 cobra 命令需要显式 RegisterCommandSchema ──
	// 已走 RegisterCommand 的命令自动注册，这里只补手写命令。

	// search
	cmdutil.RegisterCommandSchema(searchCmd, searchCommandSchema())

	// invoke
	cmdutil.RegisterCommandSchema(invokeCmd, invokeCommandSchema())

	// workspace 手写子命令（终态）
	for _, child := range workspaceCmd.Commands() {
		switch child.Name() {
		case "use":
			cmdutil.RegisterCommandSchema(child, workspaceUseCommandSchema())
		case "current":
			cmdutil.RegisterCommandSchema(child, workspaceCurrentCommandSchema())
		}
	}

	// space 过渡期别名（会打 stderr 弃用提示；schema 保留以便 `tabtin commands` 探测）
	for _, child := range spaceCmd.Commands() {
		switch child.Name() {
		case "use":
			cmdutil.RegisterCommandSchema(child, spaceUseCommandSchema())
		case "current":
			cmdutil.RegisterCommandSchema(child, spaceCurrentCommandSchema())
		}
	}

	// context
	cmdutil.RegisterCommandSchema(contextCmd, contextCommandSchema())

	// organization 全部子命令
	organizationSchemas := organizationCommandSchemas()
	for _, child := range organizationCmd.Commands() {
		if schema, ok := organizationSchemas[child.Name()]; ok {
			cmdutil.RegisterCommandSchema(child, schema)
		}
	}

	// auth 子命令（引用来自顶部 rootCmd.AddCommand(auth.NewCmdAuth(f))）
	authCmd, _, _ := rootCmd.Find([]string{"auth"})
	if authCmd != nil && authCmd.Name() == "auth" {
		authSchemas := auth.AuthCommandSchemas()
		for _, child := range authCmd.Commands() {
			if schema, ok := authSchemas[child.Name()]; ok {
				cmdutil.RegisterCommandSchema(child, schema)
			}
		}
	}

	// profile 子命令
	profileCmdRef, _, _ := rootCmd.Find([]string{"profile"})
	if profileCmdRef != nil && profileCmdRef.Name() == "profile" {
		profileSchemas := profile.ProfileCommandSchemas()
		for _, child := range profileCmdRef.Commands() {
			if schema, ok := profileSchemas[child.Name()]; ok {
				cmdutil.RegisterCommandSchema(child, schema)
			}
		}
	}

	// config 子命令
	configCmdRef, _, _ := rootCmd.Find([]string{"config"})
	if configCmdRef != nil && configCmdRef.Name() == "config" {
		configSchemas := configcmd.ConfigCommandSchemas()
		for _, child := range configCmdRef.Commands() {
			if schema, ok := configSchemas[child.Name()]; ok {
				cmdutil.RegisterCommandSchema(child, schema)
			}
		}
	}

	// agent 手写子命令
	agentCmdRef, _, _ := rootCmd.Find([]string{"agent"})
	if agentCmdRef != nil && agentCmdRef.Name() == "agent" {
		agentSchemas := agent.AgentCommandSchemas()
		for _, child := range agentCmdRef.Commands() {
			if schema, ok := agentSchemas[child.Name()]; ok {
				cmdutil.RegisterCommandSchema(child, schema)
			}
			if child.Name() == "config" {
				configSchemas := agent.AgentConfigCommandSchemas()
				for _, configChild := range child.Commands() {
					if schema, ok := configSchemas[configChild.Name()]; ok {
						cmdutil.RegisterCommandSchema(configChild, schema)
					}
				}
			}
		}
	}

	// desktop 手写子命令
	desktopCmdRef, _, _ := rootCmd.Find([]string{"desktop"})
	if desktopCmdRef != nil && desktopCmdRef.Name() == "desktop" {
		for _, child := range desktopCmdRef.Commands() {
			switch child.Name() {
			case "screenshot":
				cmdutil.RegisterCommandSchema(child, desktopScreenshotCommandSchema())
			case "hotkey":
				cmdutil.RegisterCommandSchema(child, desktopHotkeyCommandSchema())
			case "drag":
				cmdutil.RegisterCommandSchema(child, desktopDragCommandSchema())
			case "batch":
				cmdutil.RegisterCommandSchema(child, desktopBatchCommandSchema())
			case "accessibility-tree":
				cmdutil.RegisterCommandSchema(child, desktopAccessibilityTreeCommandSchema())
			case "click-element":
				cmdutil.RegisterCommandSchema(child, desktopClickElementCommandSchema())
			case "type-into-element":
				cmdutil.RegisterCommandSchema(child, desktopTypeIntoElementCommandSchema())
			}
			if child.Name() == "session" {
				for _, sessionChild := range child.Commands() {
					if sessionChild.Name() == "extend-allowlist" {
						cmdutil.RegisterCommandSchema(sessionChild, desktopExtendAllowlistCommandSchema())
					}
				}
			}
		}
	}

	// api
	cmdutil.RegisterCommandSchema(apiCmd, cmdutil.CommandDef{
		Use: "api <method> <path>", Short: "通用 API 调用",
		Example:     "  tabtin api GET /health\n  tabtin api POST /table/list --data '{\"space_id\":\"xxx\"}'",
		ArgsMapping: []string{"method", "path"},
		HasFormat:   true,
		Flags: []cmdutil.FlagDef{
			{Name: "data", Short: "d", Type: cmdutil.FlagString, Desc: "请求体 JSON"},
			{Name: "params", Type: cmdutil.FlagString, Desc: "查询参数"},
			{Name: "output", Short: "o", Type: cmdutil.FlagString, Desc: "输出到文件"},
		},
	})

	// completion-install
	cmdutil.RegisterCommandSchema(completionCmd, cmdutil.CommandDef{
		Use: "completion-install", Short: "安装 Shell 补全到当前 Shell",
		Example: "  tabtin completion-install",
		Route:   cmdutil.RouteDirect,
		Risk:    cmdutil.RiskWrite, RiskDeclared: true, // ：写补全文件、可能改 shell rc
	})

	// about / doctor / ping / status / history
	cmdutil.RegisterCommandSchema(aboutCmd, cmdutil.CommandDef{
		Use: "about", Short: "显示 CLI 版本与环境信息", Example: "  tabtin about",
		Route: cmdutil.RouteDirect, HasFormat: true, Idempotent: true,
	})
	cmdutil.RegisterCommandSchema(doctorCmd, cmdutil.CommandDef{
		Use: "doctor", Short: "CLI 环境诊断", Example: "  tabtin doctor\n  tabtin doctor --strict",
		HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{{Name: "strict", Type: cmdutil.FlagBool, Desc: "把条件性降级项（如直连模式 cli_server 缺失）升为 ❌ 并计入退出码"}},
	})
	cmdutil.RegisterCommandSchema(pingCmd, cmdutil.CommandDef{
		Use: "ping", Short: "连接探测", Example: "  tabtin ping",
		HasFormat: true, Idempotent: true,
	})
	cmdutil.RegisterCommandSchema(statusCmd, cmdutil.CommandDef{
		Use: "status", Short: "总览状态", Example: "  tabtin status",
		HasFormat: true, Idempotent: true,
	})
	cmdutil.RegisterCommandSchema(historyCmd, cmdutil.CommandDef{
		Use: "history", Short: "CLI 操作历史", Example: "  tabtin history\n  tabtin history --last 10",
		Route: cmdutil.RouteDirect, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{{Name: "last", Type: cmdutil.FlagInt, Desc: "只显示最近 N 条记录"}},
	})

	// install
	installCmdRef, _, _ := rootCmd.Find([]string{"install"})
	if installCmdRef != nil && installCmdRef.Name() == "install" {
		cmdutil.RegisterCommandSchema(installCmdRef, cmdutil.CommandDef{
			Use: "install <app_id>", Short: "安装 marketplace App",
			Example:     "  tabtin install my-app\n  tabtin install my-app --auto-install",
			Route:       cmdutil.RouteDirect,
			ArgsMapping: []string{"app_id"},
			Risk:        cmdutil.RiskWrite,
			Flags: []cmdutil.FlagDef{
				{Name: "manifest", Type: cmdutil.FlagString, Desc: "显式指定 app.json 路径"},
				{Name: "registry-dir", Type: cmdutil.FlagString, Desc: "覆盖 marketplace App 安装目录"},
				{Name: "json", Type: cmdutil.FlagBool, Desc: "JSON 输出格式"},
				{Name: "auto-install", Type: cmdutil.FlagBool, Desc: "npm-global 类型 App 未装时代跑安装"},
			},
		})
	}

	registerHiddenAliases(rootCmd, f)

	if !shouldSkipStartupTransportDiscovery(os.Args[1:]) {
		if tr, err := f.Transport(); err == nil {
			extension.RegisterDynamicCommands(rootCmd, tr)
		}
	}
	registerFlagErrorHandler(rootCmd)

	executedCmd, err := rootCmd.ExecuteContextC(ctx)
	if err != nil {
		if executedCmd == nil {
			executedCmd = rootCmd
		}
		return handleCommandExecutionError(executedCmd, err)
	}
	return output.ExitOK
}

func shouldSkipStartupTransportDiscovery(args []string) bool {
	filtered := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if arg == "--" {
			break
		}
		if strings.HasPrefix(arg, "--") {
			name := strings.TrimPrefix(arg, "--")
			if eq := strings.IndexByte(name, '='); eq >= 0 {
				name = name[:eq]
			}
			switch name {
			case "format", "profile", "agent-id", "workspace-id", "space-id", "organization-id", "timeout", "jq", "output":
				if !strings.Contains(arg, "=") && i+1 < len(args) {
					i++
				}
			}
			continue
		}
		if strings.HasPrefix(arg, "-") {
			// Short/global flags are uncommon before subcommands here; leave them out of command path.
			continue
		}
		filtered = append(filtered, arg)
		if len(filtered) >= 3 {
			break
		}
	}
	return len(filtered) >= 2 && filtered[0] == "browser" && filtered[1] == "doctor"
}

func newCmdAbout(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "about",
		Short: "显示 CLI 版本与环境信息",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			info := map[string]string{
				"version":    version.Full(),
				"go_version": fmt.Sprintf("%s", goVersion()),
				"os":         fmt.Sprintf("%s/%s", goos(), goarch()),
				"config_dir": config.Dir(),
			}
			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		}),
	}
}

// doctorSeverityRank 把退出码显式映射到「严重度排名」，doctorReport.fail 用它决定
// 最终退出码——而不是直接拿退出码数值比大小。
//
// 为什么不直接比数值：internal/output 的 ExitXxx 常量是按「错误类别 → 进程退出码」
// （类 sysexits）定的，不是按严重度。当前 doctor 只用 {1,3,4,6,8} 恰好单调，但若将来
// 谁 fail(ExitValidation=2) / fail(ExitTimeout=7)，纯数值比较会静默给出没人设计过的排序。
// 显式登记后，新增码漏登记 → rank 为 0 → 立刻在 TestDoctorReport 里暴露，而非悄悄进 max。
var doctorSeverityRank = map[int]int{
	output.ExitGeneral:        1, // config 异常
	output.ExitAuth:           2, // 未登录 / Token 过期
	output.ExitPermission:     3, // 后端 403
	output.ExitNetwork:        4, // backend 不可达
	output.ExitServiceUnavail: 5, // transport / cli_server 不可用
}

// doctorReport 累积诊断结果并跟踪「最严重失败档位」，供退出码决策。
//
// 退出码契约（harness preflight 可直接 gate）：
//   - 0          全部检查通过（无 ❌；⚠️ 不计入失败）
//   - 非 0       存在 ❌，取严重度最高一项（见 doctorSeverityRank）：
//     8 ExitServiceUnavail  transport / cli_server 不可用
//     6 ExitNetwork         backend 不可达
//     4 ExitPermission      后端拒绝（403）
//     3 ExitAuth            未登录 / Token 过期
//     1 ExitGeneral         config 异常
//
// strict（--strict）：把「条件性降级项」（degraded）从 ⚠️ 升为 ❌ 并计入退出码。
// 目前唯一的 degraded 项是「API 直连模式下 cli_server 缺失」——对只用 auth/profile 等
// RouteDirect 命令的人，这是正常状态（默认 ⚠️ 退 0）；对要跑 doc/table/browser 的
// harness，这是阻断（--strict 下 ❌ 退 8）。preflight 调 `doctor --strict`。
type doctorReport struct {
	results   []map[string]string
	worstExit int
	strict    bool
}

func (r *doctorReport) ok(check, detail string) {
	r.results = append(r.results, map[string]string{"check": check, "status": "✅", "detail": detail})
}

func (r *doctorReport) warn(check, detail string) {
	r.results = append(r.results, map[string]string{"check": check, "status": "⚠️", "detail": detail})
}

// fail 记一条 ❌，并把退出码抬到至少 exitCode（按 doctorSeverityRank 取更严重者）。
func (r *doctorReport) fail(check, detail string, exitCode int) {
	r.results = append(r.results, map[string]string{"check": check, "status": "❌", "detail": detail})
	if doctorSeverityRank[exitCode] > doctorSeverityRank[r.worstExit] {
		r.worstExit = exitCode
	}
}

// degraded 记一条「条件性降级项」：非 strict 时是 ⚠️（不计退出码），strict 时升为
// ❌（计退出码）。detail 两种模式都保留，用户始终看得到原因和修复指引。
func (r *doctorReport) degraded(check, detail string, exitCode int) {
	if r.strict {
		r.fail(check, detail, exitCode)
		return
	}
	r.warn(check, detail)
}

func newCmdDoctor(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "doctor",
		Short: "CLI 环境诊断",
		Long: `检查 CLI 运行所需各组件健康度：config / transport / cli_server / backend / auth。

退出码（可用作 harness preflight 的 gate）：
  0     全部通过（无 ❌；⚠️ 不计失败）
  非 0  存在 ❌，取严重度最高一项 —— 8 service-unavailable / 6 network / 4 permission / 3 auth / 1 config

--strict：把「条件性降级项」从 ⚠️ 升为 ❌ 并计入退出码。当前唯一降级项是
「API 直连模式下 cli_server 缺失」：
  - 默认：记 ⚠️ 退 0 —— 直连模式对 auth/profile 等 RouteDirect 命令是正常状态。
  - --strict：记 ❌ 退 8 —— doc/table/browser 等 RouteCliServer 命令此模式下跑不了，
    要 gate 它们的 harness 用 --strict（preflight 已默认带）。`,
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			reqCtx := cmd.Context()
			strict, _ := cmd.Flags().GetBool("strict")
			rep := &doctorReport{worstExit: output.ExitOK, strict: strict}

			cfg, err := f.Config()
			if err != nil {
				rep.fail("config", err.Error(), output.ExitGeneral)
			} else {
				profileName := config.ResolveProfileName(cfg)
				p := cfg.CurrentProfileConfig()
				detail := fmt.Sprintf("Profile: %s", profileName)
				if p.Label != "" {
					detail += fmt.Sprintf(" (%s)", p.Label)
				}
				rep.ok("config", detail)
			}

			tr, err := f.Transport()
			switch {
			case err != nil:
				rep.fail("transport", err.Error(), output.ExitServiceUnavail)
			case tr.Type() == "django":
				// 直连模式：没有 CLI Server，RouteCliServer 命令整条链断在 pipeline gate。
				// 这是「条件性降级」：auth/profile 等 RouteDirect 命令照常可用，所以默认 ⚠️
				// 退 0；要跑 doc/table/browser 的 harness 用 --strict 把它升成 ❌ 退 8。
				rep.ok("transport", "Type: django（API 直连）")
				rep.degraded("cli_server",
					"未运行（API 直连模式）。auth/profile 等命令可用；但 doc/table/browser 等 RouteCliServer 命令不可用——要跑它们请先 `tabtin daemon start` 或启动桌面端",
					output.ExitServiceUnavail)
				doctorProbeBackend(reqCtx, tr, rep)
			default:
				rep.ok("transport", fmt.Sprintf("Type: %s", tr.Type()))

				start := timeNow()
				resp, reqErr := tr.Request(reqCtx, "GET", "/health", nil, nil)
				latency := timeNow().Sub(start).Milliseconds()
				switch {
				case reqErr != nil:
					rep.fail("cli_server", reqErr.Error(), output.ExitServiceUnavail)
				case resp.Status == 200:
					rep.ok("cli_server", fmt.Sprintf("连接正常 (%dms)", latency))
				default:
					// 进程在但 /health 非 200 = 不健康，RouteCliServer 命令大概率挂。
					// 计入退出码（与 ping 行为一致），别给 harness 留绿灯盲区。
					rep.fail("cli_server", fmt.Sprintf("不健康 (Status: %d)", resp.Status), output.ExitServiceUnavail)
				}

				doctorProbeBackend(reqCtx, tr, rep)
			}

			output.PrintResult(output.SuccessEnvelope(rep.results), f.Format)
			if rep.worstExit != output.ExitOK {
				return output.NewExitError(rep.worstExit)
			}
			return nil
		}),
	}
	cmd.Flags().Bool("strict", false, "把条件性降级项（如直连模式 cli_server 缺失）升为 ❌ 并计入退出码")
	return cmd
}

// doctorProbeBackend 探一次 /agent/models 判定 backend 可达性 + 认证态，结果写入 rep。
func doctorProbeBackend(reqCtx context.Context, tr transport.Transport, rep *doctorReport) {
	start := timeNow()
	authResp, authErr := tr.Request(reqCtx, "GET", "/agent/models", nil, nil)
	authLatency := timeNow().Sub(start).Milliseconds()
	switch {
	case authErr != nil:
		rep.fail("backend", authErr.Error(), output.ExitNetwork)
	case authResp.Status == 200:
		rep.ok("backend", fmt.Sprintf("正常 (%dms)", authLatency))
		rep.ok("auth", "已认证")
	case authResp.Status == 401:
		rep.ok("backend", fmt.Sprintf("可达 (%dms)", authLatency))
		rep.fail("auth", "未登录或 Token 已过期", output.ExitAuth)
	case authResp.Status == 403:
		// 可达但被拒：权限/上下文问题，不是「未认证」，单独归类。
		rep.ok("backend", fmt.Sprintf("可达 (%dms)", authLatency))
		rep.fail("auth", "已认证但被拒绝（403，缺权限或 Space/Organization 上下文）", output.ExitPermission)
	case authResp.Status >= 500:
		// 5xx：backend 真不健康（如 502 = 上游 Django 挂），硬失败、计退出码。
		rep.fail("backend", fmt.Sprintf("不健康 (Status: %d, %dms)", authResp.Status, authLatency), output.ExitServiceUnavail)
	default:
		// 其余非 200（典型 404）：可达但探针端点异常。直连模式下 /agent/models 的路径
		// 与经 CLI Server 代理时不一致、会 404——这是探针局限而非 backend 故障，记 ⚠️
		// 不 gate（否则直连模式永远退非零，破坏 D-1「直连健康环境退 0」的本意）。
		rep.warn("backend", fmt.Sprintf("可达但探针响应 %d（直连模式此探针可能不适用），%dms", authResp.Status, authLatency))
	}
}

func newCmdPing(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "ping",
		Short: "连接探测",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			reqCtx := cmd.Context()

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail))
			}
			resp, err := tr.Request(reqCtx, "GET", "/health", nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			if resp.Status == 200 {
				output.PrintResult(output.SuccessEnvelope("pong"), f.Format)
			} else {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable),
					fmt.Sprintf("unhealthy (status %d)", resp.Status),
					"",
					output.ExitServiceUnavail,
				))
			}
			return nil
		}),
	}
}

func newCmdStatus(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "status",
		Short: "总览状态",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			reqCtx := cmd.Context()

			info := map[string]any{}

			info["cli_version"] = version.Full()
			info["go_version"] = goVersion()
			info["os"] = fmt.Sprintf("%s/%s", goos(), goarch())
			info["config_dir"] = config.Dir()

			cfg, err := f.Config()
			if err == nil {
				profileName := config.ResolveProfileName(cfg)
				p := cfg.CurrentProfileConfig()
				info["profile"] = profileName
				if p.Label != "" {
					info["label"] = p.Label
				}
				info["base_url"] = config.ResolveBaseURL(p)
				//  终态：字段展示名切到 workspace 语义；键位保留 default_space
				// 以兼容存量脚本，同时暴露 default_workspace 让 agent 用新语义读。
				info["default_space"] = p.DefaultSpace
				info["default_workspace"] = p.DefaultSpace
				if p.DefaultAgent != "" {
					info["default_agent"] = p.DefaultAgent
				}
				info["organization"] = p.DefaultOrganization
				if p.Token != "" {
					info["authenticated"] = true
					info["token"] = config.MaskToken(p.Token)
				} else {
					info["authenticated"] = false
				}
			}

			tr, err := f.Transport()
			if err != nil {
				info["transport"] = "disconnected"
			} else {
				info["transport"] = tr.Type()
				if tr.Type() == transport.TypeDjango {
					info["cli_server"] = "unavailable (API direct mode)"
					start := timeNow()
					resp, reqErr := tr.Request(reqCtx, "GET", "/health", nil, nil)
					latency := timeNow().Sub(start).Milliseconds()
					if reqErr != nil {
						info["backend"] = "unreachable"
					} else if resp.Status == 200 {
						info["backend"] = fmt.Sprintf("connected (%dms)", latency)
					} else {
						info["backend"] = fmt.Sprintf("error (status %d)", resp.Status)
					}
				} else {
					start := timeNow()
					resp, reqErr := tr.Request(reqCtx, "GET", "/health", nil, nil)
					latency := timeNow().Sub(start).Milliseconds()
					if reqErr != nil {
						info["cli_server"] = "unreachable"
					} else if resp.Status == 200 {
						info["cli_server"] = fmt.Sprintf("connected (%dms)", latency)
						healthData := parseHealthData(resp.Data)
						if healthData != nil {
							if src, ok := healthData["source"]; ok {
								info["server_type"] = src
							}
							if v, ok := healthData["version"]; ok {
								info["server_version"] = v
							}
							if pid, ok := healthData["pid"]; ok {
								info["server_pid"] = pid
							}
						}
					} else {
						info["cli_server"] = fmt.Sprintf("error (status %d)", resp.Status)
					}
				}
			}

			daemonState := readDaemonStateFile()
			if daemonState != nil {
				info["daemon_pid"] = daemonState["pid"]
				info["daemon_ws"] = daemonState["ws_status"]
				if caps, ok := daemonState["capabilities"]; ok {
					info["daemon_capabilities"] = caps
				}
			}

			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		}),
	}
}

func parseHealthData(raw json.RawMessage) map[string]any {
	var outer map[string]any
	if err := json.Unmarshal(raw, &outer); err != nil {
		return nil
	}
	if data, ok := outer["data"].(map[string]any); ok {
		return data
	}
	return outer
}

func readDaemonStateFile() map[string]any {
	paths := []string{
		filepath.Join(homedir(), ".tabtin-daemon", "state.json"),
		filepath.Join(homedir(), ".tabtin", "daemon", "state.json"),
	}
	for _, p := range paths {
		data, err := os.ReadFile(p)
		if err != nil {
			continue
		}
		var state map[string]any
		if err := json.Unmarshal(data, &state); err != nil {
			continue
		}
		return state
	}
	return nil
}

func homedir() string {
	h, err := os.UserHomeDir()
	if err != nil || h == "" {
		return os.TempDir()
	}
	return h
}

func goVersion() string {
	return runtime.Version()
}

func goos() string {
	return runtime.GOOS
}

func goarch() string {
	return runtime.GOARCH
}

func newCmdHistory(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "history",
		Short: "CLI 操作历史",
		Long:  "显示最近执行的 CLI 命令及其结果。Agent 可用此 review 操作历史。",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			entries := output.LoadHistory()
			last, _ := cmd.Flags().GetInt("last")
			if last > 0 && last < len(entries) {
				entries = entries[len(entries)-last:]
			}
			output.PrintResult(output.SuccessEnvelope(entries), f.Format)
			return nil
		}),
	}
	cmd.Flags().Int("last", 0, "只显示最近 N 条记录")
	return cmd
}

func newCmdCommands(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "commands [domain]",
		Short: "列出所有可用命令及其 Schema",
		Long:  "输出所有注册命令的 JSON Schema，供 Agent 动态发现可用能力和参数定义。\n\n可选 domain 前缀过滤（如 doc / table / browser），只返回该领域命令，避免吞下全量目录。\n\n当 Daemon / Electron 可达时，自动合并 PlatformSurface 注册表和 extension/marketplace 命令，Agent 无需额外调用即可发现所有平台能力。",
		Example: `  tabtin commands --format json
  tabtin commands doc --format json
  tabtin commands table --format json`,
		Args: cobra.MaximumNArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			if asJSON, _ := cmd.Flags().GetBool("json"); asJSON {
				f.Format = output.FormatJSON
				output.SetActiveFormat(output.FormatJSON)
			}

			includeHidden, _ := cmd.Flags().GetBool("include-hidden")

			// ── 1. 收集原生 cobra 注册命令 ──
			schemas := cmdutil.GetRegisteredCommands()

			// ── 1b. 补 pure group 入口命令──
			// `doc` / `mcp` / `browser` 等 group 顶层无 CommandDef，不在
			// registeredCommands 里；从 cobra 树合成（IsGroup=true），
			// 让 relevant-cli 召回池含入口命令。
			schemas = append(schemas, cmdutil.CollectGroupSchemas(cmd.Root())...)

			// ── 2. 尝试从 CLI Server 拉取 PlatformSurface 清单 ──
			surfaceSchemas := fetchSurfaceSchemas(f)
			if len(surfaceSchemas) > 0 {
				schemas = append(schemas, surfaceSchemas...)
			}

			// ── 3. 尝试从 CLI Server 拉取 extension + marketplace 命令 ──
			extSchemas := fetchExtensionSchemas(f)
			if len(extSchemas) > 0 {
				schemas = append(schemas, extSchemas...)
			}

			// 默认发现面剔除 Hidden；受限模式 risk map 走 --include-hidden。
			if !includeHidden {
				schemas = cmdutil.FilterVisibleCommandSchemas(schemas)
			}

			domain := ""
			if len(args) > 0 {
				domain = strings.TrimSpace(args[0])
			}
			if domain != "" {
				schemas = filterCommandSchemasByDomain(schemas, domain)
			}

			result := map[string]any{
				"commands":     schemas,
				"global_flags": globalFlagSchemas(),
			}
			if domain != "" {
				result["domain"] = domain
			}
			// v10 P2：commands 注册了 OutputSchema (commands 字段)，必须走 PrintResultWithSchema
			// 才能让 --format table/agent 触发 schema-aware 渲染（启发式：data 是
			// {commands:[...]} 容器，schema key 与数组元素 key 交集 ≥ 50% 即命中）。
			// ：commands 是命令目录自描述协议输出（供 agent-runtime 子进程解析能力矩阵），
			// 体量常 > 64KB 但必须完整内联——走 Inline 变体跳过大输出落盘兜底。
			output.PrintResultWithSchemaInline(output.SuccessEnvelope(result), f.Format, cmdutil.LookupOutputSchema(cmd))
			return nil
		}),
	}
	cmd.Flags().Bool("json", false, "以 JSON 格式输出（等价于 --format json）")
	cmd.Flags().Bool("include-hidden", false, "包含 Hidden 命令（供受限模式 risk map；默认发现面不输出）")
	return cmd
}

// filterCommandSchemasByDomain 按命令名首段 / 前缀过滤。
// 匹配：name == domain、name 以 "domain " 开头、或以 "domain." 开头（surface）。
func filterCommandSchemasByDomain(schemas []cmdutil.CommandSchema, domain string) []cmdutil.CommandSchema {
	domain = strings.ToLower(strings.TrimSpace(domain))
	if domain == "" {
		return schemas
	}
	out := make([]cmdutil.CommandSchema, 0, len(schemas))
	prefixSpace := domain + " "
	prefixDot := domain + "."
	for _, s := range schemas {
		name := strings.ToLower(strings.TrimSpace(s.Name))
		if name == domain || strings.HasPrefix(name, prefixSpace) || strings.HasPrefix(name, prefixDot) {
			out = append(out, s)
		}
	}
	return out
}

func globalFlagSchemas() []cmdutil.FlagSchema {
	return []cmdutil.FlagSchema{
		{Name: "format", Type: "string", Desc: "Output format", Enum: []string{"json", "pretty", "table", "csv", "agent"}},
		{Name: "verbose", Type: "bool", Desc: "Enable verbose output"},
		{Name: "yes", Type: "bool", Desc: "Skip confirmation prompts"},
		{Name: "dry-run", Type: "bool", Desc: "Show what would be executed without executing"},
		{Name: "timeout", Type: "string", Desc: "Request timeout duration (for example 30s, 2m)"},
		{Name: "jq", Type: "string", Desc: "jq expression to filter output"},
		{Name: "profile", Type: "string", Desc: "Use specified profile"},
		{Name: "workspace-id", Type: "string", Desc: "Specify Workspace ID"},
		{Name: "space-id", Type: "string", Desc: "[Deprecated] alias of --workspace-id (removed in a future release)"},
		{Name: "organization-id", Type: "string", Desc: "Specify Organization ID"},
		{Name: "batch", Type: "string", Desc: "Batch operation: JSONL file path (- for stdin)"},
		{Name: "no-color", Type: "bool", Desc: "Disable colored output"},
		{Name: "debug", Type: "bool", Desc: "Debug mode"},
		{Name: "agent-id", Type: "string", Desc: "Specify Agent ID"},
		// v10.1 P2 修复：Sprint 1.C 新增的全局 flag 必须暴露给 agent discovery，
		// 否则 `tabtin commands | jq '.data.global_flags'` 拿不到新能力，
		// CLI-first 取向下 agent 无法动态发现 --quiet / --output。
		{Name: "quiet", Type: "bool", Desc: "Suppress success stdout (error envelope still on stderr); also TABTIN_QUIET=1"},
		{Name: "output", Type: "string", Desc: "Write success response to file (long flag only; takes precedence over stdout; conflicts with --jq)"},
	}
}

// ── PlatformSurface → CommandSchema 转换（W4 E2）───────────────────

// surfaceDescriptor 是 CLI Server GET /surfaces 返回的单个 surface 描述。
// 字段名与 TS 端 SurfaceDescriptor 接口一一对应（camelCase JSON）。
type surfaceDescriptor struct {
	Module     string   `json:"module"`
	Verb       string   `json:"verb"`
	Kind       string   `json:"kind"`
	ErrorCodes []string `json:"errorCodes"`
	HTTPPath   string   `json:"httpPath"`
	Aliases    []string `json:"aliases"`
	Channel    string   `json:"channel"`
	// L20e：Risk 标注，与 PlatformSurfaceDef.risk 对齐：
	//   '' / 'none' → RiskNone；'write' → RiskWrite；'high-risk-write' → RiskHigh。
	// 透传到 CommandSchema.Risk，让 LLM 受限模式 allowlist 决策也覆盖 surface 路径。
	Risk string `json:"risk,omitempty"`
}

// surfacesEnvelope 是 GET /surfaces 返回的 envelope 包装。
// 形状：{ok: true, data: [...SurfaceDescriptor]}
type surfacesEnvelope struct {
	OK   bool                `json:"ok"`
	Data []surfaceDescriptor `json:"data"`
}

// fetchSurfaceSchemas 通过 transport 拉取 /surfaces endpoint，
// 将 PlatformSurface 清单转换为 CommandSchema 数组。
//
// 任何环节失败（transport 不可用 / 网络错误 / 非 200 / 解析失败）
// 都静默返回 nil——不影响原生命令输出。
func fetchSurfaceSchemas(f *cmdutil.Factory) []cmdutil.CommandSchema {
	tr, err := f.Transport()
	if err != nil {
		return nil
	}

	// 用短超时避免离线时长时间阻塞用户
	resp, err := tr.Request(context.Background(), "GET", "/surfaces", nil, nil)
	if err != nil || resp.Status != 200 {
		return nil
	}

	var envelope surfacesEnvelope
	if json.Unmarshal(resp.Data, &envelope) != nil || !envelope.OK {
		return nil
	}

	schemas := make([]cmdutil.CommandSchema, 0, len(envelope.Data))
	for _, s := range envelope.Data {
		schemas = append(schemas, surfaceToCommandSchema(s))
	}
	return schemas
}

// surfaceToCommandSchema 将单个 SurfaceDescriptor 映射为 CommandSchema。
//
// 映射规则（与 harness 派发对齐）：
//   - Name = "tabtin invoke <module> <verb>"  → 告诉 Agent 怎么调
//   - Description = "<module>/<verb> (PlatformSurface)" → 一目了然的分类标签
//   - Method = "POST"  → surface HTTP binding 统一用 POST
//   - Path = httpPath  → 如 /chat/export-md
//   - Aliases = surface.aliases
//   - Source = "surface"  → Agent 区分来源
//   - ErrorCodes = surface.errorCodes  → 闭集，Agent 可据此做错误分支
//   - Kind = surface.kind  → "local" / "proxied"
func surfaceToCommandSchema(s surfaceDescriptor) cmdutil.CommandSchema {
	return cmdutil.CommandSchema{
		Name:        fmt.Sprintf("tabtin invoke %s %s", s.Module, s.Verb),
		Description: fmt.Sprintf("%s/%s (PlatformSurface)", s.Module, s.Verb),
		Method:      "POST",
		Path:        s.HTTPPath,
		Aliases:     s.Aliases,
		Source:      "surface",
		ErrorCodes:  s.ErrorCodes,
		Kind:        s.Kind,
		// L20e：透传 Risk 标注。surface 未声明 risk 时 s.Risk 为零值（""），
		// CommandSchema 消费方按 RiskNone 处理。
		Risk: s.Risk,
	}
}

// ── Extension + Marketplace → CommandSchema 转换（W7）──────────────

// fetchExtensionSchemas 通过 transport 拉取 /extensions/cli-commands，
// 将 Django 后端扩展 + marketplace App CLI 命令转换为 CommandSchema 数组。
//
// 返回值包含两类来源：
//   - source="extension:<id>"  → Django 后端扩展
//   - source="marketplace:<id>" → 本地 marketplace App（cli.binary 声明的命令）
//
// 任何环节失败静默返回 nil——不影响原生命令输出。
func fetchExtensionSchemas(f *cmdutil.Factory) []cmdutil.CommandSchema {
	tr, err := f.Transport()
	if err != nil {
		return nil
	}

	cmds := extension.FetchExtensionCatalog(tr)
	if len(cmds) == 0 {
		return nil
	}

	schemas := make([]cmdutil.CommandSchema, 0, len(cmds))
	for _, c := range cmds {
		schemas = append(schemas, extensionToCommandSchema(c))
	}
	return schemas
}

// extensionToCommandSchema 将单个 ExtensionCommand 映射为 CommandSchema。
//
// marketplace 命令带 source（如 "marketplace:tabtin-demo-app"），
// Django 后端扩展不带 source 字段——此时以 "extension:<id>" 补充。
func extensionToCommandSchema(c extension.ExtensionCommand) cmdutil.CommandSchema {
	source := c.Source
	if source == "" {
		source = "extension:" + c.ExtensionID
	}

	name := fmt.Sprintf("tabtin %s %s", c.ExtensionID, c.Name)
	desc := c.Description
	if desc == "" {
		desc = fmt.Sprintf("%s/%s", c.ExtensionID, c.Name)
	}

	risk := ""
	if c.RiskLevel != "" {
		risk = c.RiskLevel
	}

	return cmdutil.CommandSchema{
		Name:        name,
		Description: desc,
		Method:      c.Method,
		Path:        c.APIEndpoint,
		Source:      source,
		Risk:        risk,
	}
}
