package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/signal"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/conversation"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

func NewCmdAgent(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "agent",
		Short: "Agent 管理与对话",
		Long: `管理 Agent、切换上下文、发起对话。

典型工作流：
  tabtin agent list                       # 列出 Agent
  tabtin agent use <id>                   # 选择 Agent
  tabtin agent run "帮我分析数据"          # 对话
  tabtin agent run                        # 交互模式
  tabtin agent history                    # 查看历史`,
	}

	cmd.AddCommand(newCmdRun(f))
	cmd.AddCommand(newCmdList(f))
	cmd.AddCommand(newCmdUse(f))
	cmd.AddCommand(newCmdCurrent(f))
	cmd.AddCommand(newCmdCreate(f))
	cmd.AddCommand(newCmdInfo(f))
	cmd.AddCommand(newCmdUpdate(f))
	cmd.AddCommand(newCmdDelete(f))
	cmd.AddCommand(newCmdHistory(f))
	cmd.AddCommand(newCmdModels(f))
	cmd.AddCommand(newCmdDB(f))
	cmd.AddCommand(newCmdConfig(f))

	return cmd
}

func resolveCurrentAgentID(f *cmdutil.Factory, args []string) (string, error) {
	if len(args) > 0 {
		return args[0], nil
	}
	cfg, err := f.Config()
	if err != nil {
		return "", err
	}
	// 只认真实 Agent 身份（TABTIN_AGENT_ID / DefaultAgent）；**不回落 Space ID**。
	// 回落 Space ID 会让 `/api/agents/{id}` 收到 space id（ 同源混用）。
	if id := config.ResolveAgentID(cfg.CurrentProfileConfig()); id != "" {
		return id, nil
	}
	return "", fmt.Errorf("需要指定 Agent ID。使用 'tabtin agent use <id>'、传入参数，或 'tabtin agent list' 查看可用 Agent")
}

func subscribeAndSend(ctx context.Context, st transport.StreamTransport, client *conversation.SessionClient, spaceID, message, sessionID, modelID string, handler conversation.EventHandler) (string, error) {
	var threadID string

	if sessionID == "" {
		info, err := client.CreateSession(ctx, spaceID, modelID)
		if err != nil {
			return "", err
		}
		sessionID = info.SessionID
		threadID = info.ThreadID
	} else {
		info, err := client.GetSession(ctx, sessionID)
		if err != nil {
			return sessionID, err
		}
		threadID = info.ThreadID
	}

	if threadID == "" {
		return sessionID, fmt.Errorf("会话已创建但未获得 thread_id，无法建立 SSE 连接")
	}

	subscribed := make(chan struct{}, 1)
	sseDone := make(chan error, 1)

	wrappedHandler := func(event conversation.AgentEvent) {
		if event.Type == "status" && event.Message == "subscribed" {
			select {
			case subscribed <- struct{}{}:
			default:
			}
		}
		handler(event)
	}

	go func() {
		sseDone <- conversation.ConnectSSE(ctx, st, threadID, sessionID, wrappedHandler)
	}()

	select {
	case <-subscribed:
	case err := <-sseDone:
		if err != nil {
			return sessionID, fmt.Errorf("SSE 连接失败: %w", err)
		}
		return sessionID, fmt.Errorf("SSE 连接在订阅前关闭")
	case <-ctx.Done():
		return sessionID, ctx.Err()
	}

	if _, err := client.SendMessage(ctx, spaceID, message, sessionID, modelID); err != nil {
		return sessionID, err
	}

	select {
	case err := <-sseDone:
		return sessionID, err
	case <-ctx.Done():
		return sessionID, nil
	}
}

func newCmdRun(f *cmdutil.Factory) *cobra.Command {
	var (
		flagModel        string
		flagSessionID    string
		flagContinue     bool
		flagPipe         bool
		flagOutputFmt    string
		flagMaxTurns     int
		flagSystemPrompt string
	)

	cmd := &cobra.Command{
		Use:   "run [message]",
		Short: "与 Agent 对话",
		Long: `发送消息给当前 Agent。省略消息则进入交互模式。

模式：
  tabtin agent run "msg"              单次对话
  tabtin agent run -p "msg"           管道模式（纯输出，无交互）
  echo "msg" | tabtin agent run       管道输入
  tabtin agent run -c                 继续上次对话
  tabtin agent run                    交互模式

输出格式（v10.12 起推荐用全局 --format）：
  --format pretty              终端渲染（默认 TTY；text 通道）
  --format json                整轮结束后输出完整 envelope JSON（含 --jq/--output/--quiet）
  --output-format stream-json  每个事件一行 NDJSON（agent run 独有，全局 --format 无对应）
  --output-format json         已 deprecated；改用 --format json
  --output-format text         agent run 默认形式，无需显式传`,
		Example: `  tabtin agent run "帮我分析这个数据"
  tabtin agent run -p "查询所有表格"
  tabtin agent run --format json "生成报告" > report.json
  tabtin agent run --format json --jq '.response' "生成报告"        # jq 提取字段
  tabtin agent run --output-format stream-json -p "msg" | jq .       # NDJSON 流处理
  echo "分析这段代码" | tabtin agent run -p
  tabtin agent run -c "继续上次的话题"
  tabtin agent run --system-prompt "你是数据分析师" "分析销售数据"
  tabtin agent run                                                   # 交互模式`,
		RunE: func(cmd *cobra.Command, args []string) error {
			// v10.7 P1 / v10.8 P1 / v10.11 P1：flag 协议校验在 RunE 入口
			// （早于 transport/profile），避免用户拼错 flag 看到 UNAVAILABLE (exit 8)
			// 被误导。完整决策矩阵抽到 resolveOutputFormat（output_format.go）让
			// output_format_test.go 直接覆盖所有组合，不依赖 cobra/transport。
			outputFormatExplicit := cmd.Flags().Changed("output-format")
			rootFmtFlag := cmd.Root().PersistentFlags().Lookup("format")
			// v10.11 P1：用 Changed 判定"全局 --format 是否显式传入"——
			// f.Format 在 root PersistentPreRunE 会被 jq/agent env/config/terminal
			// 默认改写（root.go:96-105 / :129），单看 f.Format 区分不出"用户显式
			// 传了 --format" vs "环境/默认填充"。
			rootFmtExplicit := rootFmtFlag != nil && rootFmtFlag.Changed
			rootOutputFlag := cmd.Root().PersistentFlags().Lookup("output")
			hasGlobalOutput := rootOutputFlag != nil && rootOutputFlag.Changed

			outFmt, env := resolveOutputFormat(
				flagOutputFmt, outputFormatExplicit,
				f.Format, rootFmtExplicit,
				f.JQExpr != "", hasGlobalOutput,
			)
			if env != nil {
				return output.PrintErrorAndExit(env)
			}
			// v10.8 P1：raw stream + --quiet **不拒绝**——quiet 应抑制 stdout（语义一致），
			// 由下游 NewRendererWithQuiet / StreamJSONHandler.Quiet 实施。

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail))
			}

			if tr.Type() == transport.TypeDjango {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable),
					"'agent run' 需要 TabTin 桌面端或 Daemon 运行。当前为 API 直连模式。",
					"tabtin daemon start",
					output.ExitServiceUnavail,
				))
			}

			st, err := f.StreamTransport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "tabtin daemon start", output.ExitServiceUnavail))
			}

			pst, _ := tr.(transport.PostStreamTransport)

			reqCtx := cmd.Context()

			cfg, err := f.Config()
			if err != nil {
				return err
			}
			profile := cfg.CurrentProfileConfig()
			spaceID := config.ResolveSpaceID(profile)
			if spaceID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "需要指定 Agent。请先运行 'tabtin agent use <id>'。", "tabtin agent list", output.ExitValidation))
			}

			client := conversation.NewSessionClient(tr)
			verbose, _ := cmd.Flags().GetBool("verbose")
			// Deprecated: --output-format json 已被全局 --format json 替代（Sprint 1.C）；
			// 仅 stream-json 是 agent run 独有保留；text 仍是命令默认（无须替代）。
			//
			// v10.2 P2：quiet 模式抑制弃用提示
			// v10.8 P1：去掉 --output-format text 的弃用提示（root --format 没有 text，
			// text 是 agent run 默认 raw stream 形式——无替代选项）；
			// 弃用 message 只对显式传 json 的用户打。
			if outputFormatExplicit && flagOutputFmt == "json" && !output.IsQuietMode() {
				fmt.Fprintln(os.Stderr, "⚠ --output-format json 已弃用，未来版本将移除。请改用全局 --format json。stream-json 与 text 仍保留作为本命令独有形式。")
			}
			// outFmt 已在 RunE 入口构造（与 isRawStream 互斥校验同时进行）——这里直接复用

			if flagContinue {
				threads, err := client.ListThreads(reqCtx, spaceID, 1)
				if err != nil {
					return fmt.Errorf("获取历史失败: %w", err)
				}
				if len(threads) > 0 {
					flagSessionID = threads[0].ID
					if !flagPipe {
						fmt.Fprintf(os.Stderr, "  继续会话: %s\n", threads[0].Title)
					}
				}
			}

			var message string
			if len(args) > 0 {
				message = strings.Join(args, " ")
			} else if !isInteractive() || flagPipe {
				scanner := bufio.NewScanner(os.Stdin)
				scanner.Buffer(make([]byte, 0), 10*1024*1024)
				var lines []string
				for scanner.Scan() {
					lines = append(lines, scanner.Text())
				}
				if len(lines) > 0 {
					message = strings.Join(lines, "\n")
				}
			}

			if flagSystemPrompt != "" && message != "" {
				message = flagSystemPrompt + "\n\n---\n\n" + message
			}

			if message != "" {
				return runSingleMessage(reqCtx, st, pst, client, spaceID, message, flagSessionID, flagModel, outFmt, verbose, flagMaxTurns)
			}

			if !isInteractive() || flagPipe {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "管道模式需要消息输入", "tabtin agent run -p \"消息\" 或 echo \"消息\" | tabtin agent run", output.ExitValidation))
			}

			return runInteractive(reqCtx, st, pst, client, spaceID, flagSessionID, flagModel, outFmt, verbose, flagMaxTurns)
		},
	}

	cmd.Flags().StringVar(&flagModel, "model", "", "指定模型")
	cmd.Flags().StringVar(&flagSessionID, "session-id", "", "指定会话 ID")
	cmd.Flags().BoolVarP(&flagContinue, "continue", "c", false, "继续上次对话")
	cmd.Flags().BoolVarP(&flagPipe, "pipe", "p", false, "管道模式（非交互，纯输出）")
	cmd.Flags().StringVarP(&flagOutputFmt, "output-format", "o", "text", "输出格式: text | json | stream-json")
	cmd.Flags().IntVar(&flagMaxTurns, "max-turns", 0, "最大轮次（0=无限制）")
	cmd.Flags().StringVar(&flagSystemPrompt, "system-prompt", "", "系统提示词（追加到消息前）")

	return cmd
}

func runSingleMessage(parentCtx context.Context, st transport.StreamTransport, pst transport.PostStreamTransport, client *conversation.SessionClient, spaceID, message, sessionID, modelID string, outFmt conversation.OutputFormat, verbose bool, maxTurns int) error {
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	ctx, cancel := context.WithCancel(parentCtx)
	defer cancel()

	var handler conversation.EventHandler
	var collector *conversation.JSONCollector

	switch outFmt {
	case conversation.OutputJSON:
		collector = conversation.NewJSONCollector(sessionID)
		handler = collector.Handle
	case conversation.OutputStreamJSON:
		// v10.8 P1：把 quiet 传给 handler 让流式输出服从 quiet 协议
		sh := &conversation.StreamJSONHandler{Quiet: output.IsQuietMode()}
		handler = sh.Handle
	default:
		// v10.8 P1：Renderer 也服从 quiet——抑成功 stdout (text_delta/chunk) +
		// stderr 工具调用进度提示；ask_user_required / error 仍出
		renderer := conversation.NewRendererWithQuiet(verbose, output.IsQuietMode())
		handler = renderer.Handle
	}

	if maxTurns > 0 {
		handler = wrapMaxTurns(handler, maxTurns, cancel)
	}

	var err error
	if pst != nil {
		_, err = conversation.ChatStream(ctx, pst, spaceID, message, sessionID, modelID, handler)
	} else {
		_, err = subscribeAndSend(ctx, st, client, spaceID, message, sessionID, modelID, handler)
	}

	// v10.9 P0/P1 + v10.10：决策抽到 emitRunResult 让 fake transport 单测可直接覆盖
	return emitRunResult(ctx, err, collector)
}

// emitRunResult 实施 runSingleMessage 的输出协议（v10.9 P0/P1）：
//
//   - ctx.Err() != nil（用户中断 Ctrl+C） → exit 130，不输出任何
//   - err != nil（stream 失败） → PrintErrorAndExit InternalError envelope，
//     不输出成功 envelope、不写盘
//   - 仅 err==nil && ctx==nil 才让 collector 输出 SuccessEnvelope
//
// 抽成独立函数让 v10.10 P2 的 fake transport 单测可以直接断言"失败时
// stdout 空 / --output 文件不存在 / stderr 是 error envelope"——
// 不再依赖"Daemon 不可达"这种环境敏感的 E2E。
func emitRunResult(ctx context.Context, err error, collector *conversation.JSONCollector) error {
	if ctx != nil && ctx.Err() != nil {
		return output.NewExitError(130)
	}
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.InternalError),
			fmt.Sprintf("agent run 执行失败: %s", err.Error()),
			"检查 Daemon 是否健康、网络是否可达；详细日志看 --debug",
			output.ExitGeneral,
		))
	}
	if collector != nil {
		output.PrintResultWithSchema(output.SuccessEnvelope(collector.Result()), output.FormatJSON, nil)
	}
	return nil
}

func runInteractive(parentCtx context.Context, st transport.StreamTransport, pst transport.PostStreamTransport, client *conversation.SessionClient, spaceID, sessionID, modelID string, outFmt conversation.OutputFormat, verbose bool, maxTurns int) error {
	if parentCtx == nil {
		parentCtx = context.Background()
	}
	reader := bufio.NewReader(os.Stdin)
	// v10.8 P1：交互模式也服从 quiet（虽然交互场景下加 quiet 罕见，但协议一致）
	renderer := conversation.NewRendererWithQuiet(verbose, output.IsQuietMode())

	fmt.Fprintf(os.Stderr, "TabTin Agent 交互模式\n")
	fmt.Fprintf(os.Stderr, "  输入消息开始对话，/exit 退出，/help 查看帮助\n\n")

	signal.Reset(os.Interrupt)

	sigCtx, sigCancel := context.WithCancel(parentCtx)
	defer sigCancel()

	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, os.Interrupt)
	defer signal.Stop(sigCh)

	type readResult struct {
		line string
		err  error
	}

	for {
		select {
		case <-parentCtx.Done():
			return nil
		default:
		}

		fmt.Fprint(os.Stderr, ">>> ")

		inputCh := make(chan readResult, 1)
		go func() {
			line, err := reader.ReadString('\n')
			inputCh <- readResult{line, err}
		}()

		var input string
		select {
		case <-parentCtx.Done():
			return nil
		case <-sigCh:
			fmt.Fprintln(os.Stderr)
			return output.NewExitError(130)
		case r := <-inputCh:
			if r.err != nil {
				select {
				case <-sigCh:
					fmt.Fprintln(os.Stderr)
					return output.NewExitError(130)
				default:
				}
				goto exit
			}
			input = r.line
		}

		input = strings.TrimSpace(input)

		if input == "" {
			continue
		}

		switch {
		case input == "exit" || input == "quit" || input == "/exit" || input == "/quit":
			goto exit
		case input == "/help":
			fmt.Fprintf(os.Stderr, "  /exit     退出\n  /model    查看/切换模型\n  /history  对话历史\n  /clear    开始新对话\n  /help     显示此帮助\n\n")
			continue
		case input == "/clear":
			sessionID = ""
			fmt.Fprintf(os.Stderr, "  ✓ 已开始新对话\n\n")
			continue
		case input == "/history":
			threads, err := client.ListThreads(sigCtx, spaceID, 5)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  错误: %v\n", err)
			} else {
				for _, t := range threads {
					id := t.ID
					if len(id) > 8 {
						id = id[:8]
					}
					fmt.Fprintf(os.Stderr, "  %s  %s\n", id, t.Title)
				}
			}
			fmt.Fprintln(os.Stderr)
			continue
		case input == "/model" || input == "/models":
			models, err := client.ListModels(sigCtx, spaceID)
			if err != nil {
				fmt.Fprintf(os.Stderr, "  错误: %v\n", err)
			} else {
				for _, m := range models {
					marker := "  "
					if m.IsDefault {
						marker = "★ "
					}
					fmt.Fprintf(os.Stderr, "  %s%s (%s)\n", marker, m.Name, m.Provider)
				}
			}
			fmt.Fprintln(os.Stderr)
			continue
		case strings.HasPrefix(input, "/"):
			fmt.Fprintf(os.Stderr, "  未知命令: %s。输入 /help 查看可用命令\n\n", input)
			continue
		}

		roundCtx, roundCancel := context.WithCancel(sigCtx)

		var handler conversation.EventHandler = renderer.Handle
		if maxTurns > 0 {
			handler = wrapMaxTurns(handler, maxTurns, roundCancel)
		}

		go func() {
			select {
			case <-sigCh:
				roundCancel()
			case <-roundCtx.Done():
			}
		}()

		var sid string
		var err error
		if pst != nil {
			info, chatErr := conversation.ChatStream(roundCtx, pst, spaceID, input, sessionID, modelID, handler)
			if info != nil {
				sid = info.SessionID
			}
			err = chatErr
		} else {
			sid, err = subscribeAndSend(roundCtx, st, client, spaceID, input, sessionID, modelID, handler)
		}
		roundCancel()

		if sid != "" {
			sessionID = sid
		}

		if err != nil && err != context.Canceled {
			fmt.Fprintf(os.Stderr, "  错误: %v\n", err)
		}
		fmt.Fprintln(os.Stderr)
	}

exit:
	fmt.Fprintf(os.Stderr, "再见！\n")
	return nil
}

func wrapMaxTurns(inner conversation.EventHandler, maxTurns int, cancel context.CancelFunc) conversation.EventHandler {
	turns := 0
	return func(event conversation.AgentEvent) {
		inner(event)
		if event.Type == "tool_end" {
			turns++
			if turns >= maxTurns {
				fmt.Fprintf(os.Stderr, "\n⚠ 已达最大轮次 (%d)，自动停止\n", maxTurns)
				cancel()
			}
		}
	}
}

func newCmdList(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Short:   "列出我的 Agent",
		Aliases: []string{"ls"},
		Example: `  tabtin agent list
  tabtin agent list --organization-id <id>
  tabtin agent list --format table`,
		RunE: func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			reqCtx := cmd.Context()

			cfg, _ := f.Config()
			profile := cfg.CurrentProfileConfig()
			organizationID := config.ResolveOrganizationID(profile)

			if organizationID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "需要 organization_id", "tabtin config set defaultOrganization <id>", output.ExitValidation))
			}

			if err := cmdutil.ValidatePathParam(organizationID, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}

			path := fmt.Sprintf(
				"/api/agents?organization_id=%s",
				url.QueryEscape(organizationID),
			)
			resp, err := tr.Request(reqCtx, "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			var result any
			if err := json.Unmarshal(resp.Data, &result); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), "解析响应失败", "", output.ExitInternal))
			}
			output.PrintResult(output.UnwrapDjangoEnvelope(result), f.Format)
			return nil
		},
	}
}

func newCmdCreate(f *cmdutil.Factory) *cobra.Command {
	var (
		flagName  string
		flagRules string
		flagGoal  string
	)

	cmd := &cobra.Command{
		Use:   "create",
		Short: "创建新 Agent",
		Example: `  tabtin agent create --name "数据分析助手"
  tabtin agent create --name "代码助手" --rules "你是一个代码专家，回复用中文" --goal "帮助用户编写高质量代码"`,
		RunE: func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			reqCtx := cmd.Context()

			cfg, _ := f.Config()
			profile := cfg.CurrentProfileConfig()
			organizationID := config.ResolveOrganizationID(profile)

			if organizationID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "需要 organization_id", "tabtin config set defaultOrganization <id>", output.ExitValidation))
			}

			body := map[string]any{
				"organization_id": organizationID,
				"name":            flagName,
				"type":            "bot",
			}
			if flagRules != "" {
				body["custom_rules"] = flagRules
			}
			if flagGoal != "" {
				body["goal"] = flagGoal
			}

			resp, err := tr.Request(reqCtx, "POST", "/api/agents", body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			if resp.Status >= 400 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(cmdutil.HTTPStatusToErrorCode(resp.Status), fmt.Sprintf("创建失败 (status %d)", resp.Status), "", output.ExitGeneral))
			}

			var result any
			_ = json.Unmarshal(resp.Data, &result)
			output.PrintResult(output.UnwrapDjangoEnvelope(result), f.Format)
			fmt.Fprintf(os.Stderr, "✓ Agent 已创建\n")
			return nil
		},
	}

	cmd.Flags().StringVar(&flagName, "name", "", "Agent 名称（必填）")
	cmd.Flags().StringVar(&flagRules, "rules", "", "自定义规则（身份、语气、行为规则）")
	cmd.Flags().StringVar(&flagGoal, "goal", "", "Agent 目标")
	_ = cmd.MarkFlagRequired("name")

	return cmd
}

func newCmdInfo(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "info [agent-id]",
		Short:   "Agent 详情",
		Example: "  tabtin agent info\n  tabtin agent info <agent-id>",
		RunE: func(cmd *cobra.Command, args []string) error {
			agentID, err := resolveCurrentAgentID(f, args)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "tabtin agent use <id>", output.ExitValidation))
			}

			if err := cmdutil.ValidatePathParam(agentID, "agent ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			reqCtx := cmd.Context()
			resp, err := tr.Request(reqCtx, "GET", fmt.Sprintf("/api/agents/%s", url.PathEscape(agentID)), nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			var result any
			_ = json.Unmarshal(resp.Data, &result)
			output.PrintResult(output.UnwrapDjangoEnvelope(result), f.Format)
			return nil
		},
	}
}

func newCmdUpdate(f *cmdutil.Factory) *cobra.Command {
	var (
		flagName         string
		flagRules        string
		flagGoal         string
		flagPreset       string
		flagTerminalMode string
		flagSQLMode      string
		flagBackend      string
	)

	cmd := &cobra.Command{
		Use:   "update [agent-id]",
		Short: "更新 Agent 配置",
		Long: `更新 Agent 的基础信息和能力配置。

基础字段：--name, --rules, --goal
能力配置：--preset, --terminal-mode, --sql-mode, --backend

更复杂的配置修改请使用 tabtin agent config set <key> <value>`,
		Example: `  tabtin agent update --name "新名字"
  tabtin agent update --preset collaborative
  tabtin agent update --terminal-mode sandboxed --sql-mode read_write
  tabtin agent update --backend codex`,
		RunE: func(cmd *cobra.Command, args []string) error {
			agentID, err := resolveCurrentAgentID(f, args)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "tabtin agent use <id>", output.ExitValidation))
			}

			if err := cmdutil.ValidatePathParam(agentID, "agent ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}

			body := map[string]any{}
			if flagName != "" {
				body["name"] = flagName
			}
			if flagRules != "" {
				body["custom_rules"] = flagRules
			}
			if flagGoal != "" {
				body["goal"] = flagGoal
			}

			agentConfig := map[string]any{}
			if flagPreset != "" {
				agentConfig["authorization_preset"] = flagPreset
			}
			if flagTerminalMode != "" {
				agentConfig["terminal_mode"] = flagTerminalMode
			}
			if flagSQLMode != "" {
				agentConfig["sql_mode"] = flagSQLMode
			}
			reqCtx := cmd.Context()

			if flagBackend != "" {
				currentConfig, fetchErr := fetchAgentConfig(reqCtx, f, agentID)
				if fetchErr == nil {
					if existing, ok := currentConfig["agent_backend"].(map[string]any); ok {
						existing["type"] = flagBackend
						agentConfig["agent_backend"] = existing
					} else {
						agentConfig["agent_backend"] = map[string]any{"type": flagBackend}
					}
				} else {
					agentConfig["agent_backend"] = map[string]any{"type": flagBackend}
				}
			}

			if len(agentConfig) > 0 {
				body["agent_config"] = agentConfig
			}

			if len(body) == 0 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "请指定要更新的字段",
					"--name, --rules, --goal, --preset, --terminal-mode, --sql-mode, --backend",
					output.ExitValidation))
			}

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			resp, err := tr.Request(reqCtx, "PUT", fmt.Sprintf("/api/agents/%s", url.PathEscape(agentID)), body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			var result any
			_ = json.Unmarshal(resp.Data, &result)
			output.PrintResult(output.UnwrapDjangoEnvelope(result), f.Format)
			fmt.Fprintf(os.Stderr, "✓ Agent 已更新\n")
			return nil
		},
	}

	cmd.Flags().StringVar(&flagName, "name", "", "Agent 名称")
	cmd.Flags().StringVar(&flagRules, "rules", "", "自定义规则（身份、语气、行为规则）")
	cmd.Flags().StringVar(&flagGoal, "goal", "", "Agent 目标")
	cmd.Flags().StringVar(&flagPreset, "preset", "", "安全预设: cautious | collaborative | full_auto")
	cmd.Flags().StringVar(&flagTerminalMode, "terminal-mode", "", "终端模式: tabtin_only | sandboxed | regular | blocked")
	cmd.Flags().StringVar(&flagSQLMode, "sql-mode", "", "SQL 模式: read_only | read_write | blocked")
	cmd.Flags().StringVar(&flagBackend, "backend", "", "Agent 后端: builtin | claude-code | codex | gemini | opencode")

	return cmd
}

func newCmdDelete(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "delete <agent-id>",
		Short:   "删除 Agent",
		Example: "  tabtin agent delete <agent-id> --yes",
		Args:    cobra.ExactArgs(1),
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := cmdutil.ValidatePathParam(args[0], "agent ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}

			yes, _ := cmd.Flags().GetBool("yes")
			if !yes {
				fmt.Fprintf(os.Stderr, "⚠️  此操作将永久删除 Agent '%s'，使用 --yes 确认\n", args[0])
				return nil
			}

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			resp, err := tr.Request(cmd.Context(), "DELETE", fmt.Sprintf("/api/agents/%s", url.PathEscape(args[0])), nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			if resp.Status >= 400 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(cmdutil.HTTPStatusToErrorCode(resp.Status), fmt.Sprintf("删除失败 (status %d)", resp.Status), "", output.ExitGeneral))
			}

			fmt.Fprintf(os.Stderr, "✓ Agent '%s' 已删除\n", args[0])
			return nil
		},
	}
}

func newCmdUse(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "use <agent-id>",
		Short:   "切换当前 Agent",
		Args:    cobra.ExactArgs(1),
		Example: "  tabtin agent use <agent-id>",
		RunE: func(cmd *cobra.Command, args []string) error {
			if err := cmdutil.ValidatePathParam(args[0], "agent ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}
			agentID := args[0]

			cfg, err := f.Config()
			if err != nil {
				return err
			}

			p := cfg.CurrentProfileConfig()
			// 只设置 Agent 身份，不再污染 DefaultSpace / TABTIN_SPACE_ID——
			// Agent 与 Space 是独立实体（ 根因：曾把 agent id 写进 space 槽）。
			// 切换工作 Space 用 'tabtin space use <space-id>'。
			p.DefaultAgent = agentID

			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("保存失败: %w", err)
			}

			os.Setenv("TABTIN_AGENT_ID", agentID)

			fmt.Fprintf(os.Stderr, "✓ 已切换到 Agent '%s'\n", agentID)
			return nil
		},
	}
}

func newCmdCurrent(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "current",
		Short:   "显示当前 Agent",
		Example: "  tabtin agent current",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			profile := cfg.CurrentProfileConfig()

			// 显式 Agent 身份（--agent-id / TABTIN_AGENT_ID / DefaultAgent）优先，
			// 直接返回，无需回后端解析。
			if agentID := config.ResolveAgentID(profile); agentID != "" {
				output.PrintResult(output.SuccessEnvelope(map[string]any{"agent_id": agentID}), f.Format)
				return nil
			}

			spaceID := config.ResolveSpaceID(profile)
			if spaceID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"未确定当前 Agent：既无 Agent 身份也无 Space 上下文",
					"用 'tabtin agent list' 选择一个 agent id，或 'tabtin agent use <id>'",
					output.ExitValidation,
				))
			}

			// 关键修复：不再把 Space ID 冒充 agent_id，改为向后端解析
			// 当前 Space 的真实执行 Agent（execution_agent_id）。
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			resp, err := tr.Request(cmd.Context(), "GET", fmt.Sprintf("/api/context/workspaces/%s", url.PathEscape(spaceID)), nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			if resp.Status >= 400 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					cmdutil.HTTPStatusToErrorCode(resp.Status),
					fmt.Sprintf("解析当前 Space 执行 Agent 失败 (status %d)", resp.Status),
					"用 'tabtin agent list' 选择一个 agent id",
					output.ExitGeneral,
				))
			}

			agentID, bindingSource, err := parseSpaceExecutionAgent(resp.Data)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitInternal))
			}
			if agentID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.NotFound),
					"当前 Space 未绑定执行 Agent",
					"用 'tabtin agent list' 选择一个 agent id 后加 --agent <agent-id>",
					output.ExitGeneral,
				))
			}

			info := map[string]any{"agent_id": agentID, "space_id": spaceID}
			if bindingSource != "" {
				info["execution_binding_source"] = bindingSource
			}
			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		},
	}
}

// parseSpaceExecutionAgent 从 `GET /api/context/workspaces/{id}` 的响应体里解出
// 当前 Space 的执行 Agent ID 与绑定来源。兼容 Django 信封（{"success",..,"data"}）
// 与已解包的裸 data 两种形态。agentID 为空表示 Space 未绑定执行 Agent（非错误）。
//
// 抽成纯函数让  回归可直接单测：验证「不再把 Space ID 当 agent_id」——
// 即只认 execution_agent_id 字段，缺失时返回空而不是回落到其它 id。
func parseSpaceExecutionAgent(respData []byte) (agentID, bindingSource string, err error) {
	var raw any
	if e := json.Unmarshal(respData, &raw); e != nil {
		return "", "", fmt.Errorf("解析响应失败")
	}
	data, ok := output.UnwrapDjangoEnvelope(raw).(map[string]any)
	if !ok {
		return "", "", nil
	}
	agentID, _ = data["execution_agent_id"].(string)
	bindingSource, _ = data["execution_binding_source"].(string)
	return agentID, bindingSource, nil
}

func newCmdHistory(f *cmdutil.Factory) *cobra.Command {
	var flagLimit int

	cmd := &cobra.Command{
		Use:     "history",
		Short:   "对话历史",
		Example: "  tabtin agent history\n  tabtin agent history --limit 5",
		RunE: func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			if tr.Type() == transport.TypeDjango {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable),
					"'agent history' 需要 TabTin 桌面端或 Daemon 运行。当前为 API 直连模式。",
					"tabtin daemon start",
					output.ExitServiceUnavail,
				))
			}

			cfg, _ := f.Config()
			profile := cfg.CurrentProfileConfig()
			spaceID := config.ResolveSpaceID(profile)
			if spaceID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "需要指定 Agent", "tabtin agent use <id>", output.ExitValidation))
			}

			client := conversation.NewSessionClient(tr)
			threads, err := client.ListThreads(cmd.Context(), spaceID, flagLimit)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			output.PrintResult(output.SuccessEnvelope(threads), f.Format)
			return nil
		},
	}

	cmd.Flags().IntVar(&flagLimit, "limit", 20, "最大返回数")
	return cmd
}

func newCmdModels(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "models",
		Short:   "可用模型列表",
		Example: "  tabtin agent models",
		RunE: func(cmd *cobra.Command, args []string) error {
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			if tr.Type() == transport.TypeDjango {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable),
					"'agent models' 需要 TabTin 桌面端或 Daemon 运行。当前为 API 直连模式。",
					"tabtin daemon start",
					output.ExitServiceUnavail,
				))
			}

			cfg, _ := f.Config()
			profile := cfg.CurrentProfileConfig()
			spaceID := config.ResolveSpaceID(profile)

			client := conversation.NewSessionClient(tr)
			models, err := client.ListModels(cmd.Context(), spaceID)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			output.PrintResult(output.SuccessEnvelope(models), f.Format)
			return nil
		},
	}
}

func newCmdDB(f *cmdutil.Factory) *cobra.Command {
	dbCmd := &cobra.Command{
		Use:   "db",
		Short: "Agent 数据库连接管理",
	}

	cmdutil.RegisterCommand(dbCmd, f, cmdutil.CommandDef{
		Use: "info", Short: "数据库连接信息", Example: "  tabtin agent db info",
		Route: cmdutil.RouteCliServer, Method: "POST", Path: "/space/db-info",
		HasFormat: true, RequiresAgent: true,
	})
	cmdutil.RegisterCommand(dbCmd, f, cmdutil.CommandDef{
		Use: "connection", Short: "列出连接", Example: "  tabtin agent db connection",
		Route: cmdutil.RouteCliServer, Method: "POST", Path: "/space/db-connection",
		HasFormat: true, RequiresAgent: true,
	})
	cmdutil.RegisterCommand(dbCmd, f, cmdutil.CommandDef{
		Use: "create", Short: "创建连接", Example: "  tabtin agent db create",
		Route: cmdutil.RouteCliServer, Method: "POST", Path: "/space/create-db-connection",
		HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskWrite,
	})
	cmdutil.RegisterCommand(dbCmd, f, cmdutil.CommandDef{
		Use: "delete <id>", Short: "删除连接", Example: "  tabtin agent db delete --id conn_xxx --yes",
		Route: cmdutil.RouteCliServer, Method: "POST", Path: "/space/delete-db-connection",
		Flags:     []cmdutil.FlagDef{{Name: "id", Type: cmdutil.FlagString, Required: true, Desc: "连接 ID"}},
		HasFormat: true, RequiresAgent: true, Risk: cmdutil.RiskHigh,
	})

	return dbCmd
}

func isInteractive() bool {
	fi, err := os.Stdin.Stat()
	if err != nil {
		return false
	}
	return (fi.Mode() & os.ModeCharDevice) != 0
}

// ─── Schema 定义（供 root.go RegisterCommandSchema 使用）──

func AgentCommandSchemas() map[string]cmdutil.CommandDef {
	return map[string]cmdutil.CommandDef{
		"run": {
			Use: "run [message]", Short: "与 Agent 对话",
			Example: "  tabtin agent run \"帮我分析这个数据\"\n  tabtin agent run -p \"查询所有表格\"\n  tabtin agent run --format json \"生成报告\" > report.json",
			Route:   cmdutil.RouteDirect,
			// ：启动 Agent 会话可间接触发任意写/操控，标 write 以在受限模式拒绝、Agent 模式审批。
			Risk:          cmdutil.RiskWrite,
			RiskDeclared:  true,
			RequiresAgent: true,
			Flags: []cmdutil.FlagDef{
				{Name: "model", Type: cmdutil.FlagString, Desc: "指定模型"},
				{Name: "session-id", Type: cmdutil.FlagString, Desc: "指定会话 ID"},
				{Name: "continue", Short: "c", Type: cmdutil.FlagBool, Desc: "继续上次对话"},
				{Name: "pipe", Short: "p", Type: cmdutil.FlagBool, Desc: "管道模式"},
				{Name: "output-format", Short: "o", Type: cmdutil.FlagString, Default: "text", Desc: "输出格式: text | json | stream-json"},
				{Name: "max-turns", Type: cmdutil.FlagInt, Desc: "最大轮次"},
				{Name: "system-prompt", Type: cmdutil.FlagString, Desc: "系统提示词"},
			},
		},
		"list": {
			Use: "list", Short: "列出我的 Agent",
			Example:      "  tabtin agent list\n  tabtin agent list --format table",
			Route:        cmdutil.RouteDirect,
			HasFormat:    true,
			RequiresAuth: true,
			Idempotent:   true,
		},
		"use": {
			Use: "use <agent-id>", Short: "切换当前 Agent",
			Example:     "  tabtin agent use <agent-id>",
			Route:       cmdutil.RouteDirect,
			ArgsMapping: []string{"agent_id"},
			Risk:        cmdutil.RiskWrite,
		},
		"current": {
			Use: "current", Short: "显示当前 Agent",
			Example:    "  tabtin agent current",
			Route:      cmdutil.RouteDirect,
			HasFormat:  true,
			Idempotent: true,
		},
		"create": {
			Use: "create", Short: "创建新 Agent",
			Example:      "  tabtin agent create --name \"数据分析助手\"\n  tabtin agent create --name \"代码助手\" --rules \"你是一个代码专家，回复用中文\"",
			Route:        cmdutil.RouteDirect,
			RequiresAuth: true,
			Risk:         cmdutil.RiskWrite,
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Required: true, Desc: "Agent 名称"},
				{Name: "rules", Type: cmdutil.FlagString, Desc: "自定义规则（身份、语气、行为规则）"},
				{Name: "goal", Type: cmdutil.FlagString, Desc: "Agent 目标"},
			},
		},
		"info": {
			Use: "info [agent-id]", Short: "Agent 详情",
			Example:     "  tabtin agent info\n  tabtin agent info <agent-id>",
			Route:       cmdutil.RouteDirect,
			HasFormat:   true,
			Idempotent:  true,
			ArgsMapping: []string{"agent_id"},
		},
		"update": {
			Use: "update [agent-id]", Short: "更新 Agent 配置",
			Example:      "  tabtin agent update --name \"新名字\"\n  tabtin agent update --preset collaborative",
			Route:        cmdutil.RouteDirect,
			RequiresAuth: true,
			Risk:         cmdutil.RiskWrite,
			ArgsMapping:  []string{"agent_id"},
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Desc: "Agent 名称"},
				{Name: "rules", Type: cmdutil.FlagString, Desc: "自定义规则（身份、语气、行为规则）"},
				{Name: "goal", Type: cmdutil.FlagString, Desc: "Agent 目标"},
				{Name: "preset", Type: cmdutil.FlagString, Desc: "安全预设"},
				{Name: "terminal-mode", Type: cmdutil.FlagString, Desc: "终端模式"},
				{Name: "sql-mode", Type: cmdutil.FlagString, Desc: "SQL 模式"},
				{Name: "backend", Type: cmdutil.FlagString, Desc: "Agent 后端"},
			},
		},
		"delete": {
			Use: "delete <agent-id>", Short: "删除 Agent",
			Example:     "  tabtin agent delete <agent-id> --yes",
			Route:       cmdutil.RouteDirect,
			ArgsMapping: []string{"agent_id"},
			Risk:        cmdutil.RiskHigh,
			Flags: []cmdutil.FlagDef{
				{Name: "yes", Type: cmdutil.FlagBool, Desc: "跳过确认提示"},
			},
		},
		"history": {
			Use: "history", Short: "对话历史",
			Example:    "  tabtin agent history\n  tabtin agent history --limit 5",
			Route:      cmdutil.RouteDirect,
			HasFormat:  true,
			Idempotent: true,
			Flags: []cmdutil.FlagDef{
				{Name: "limit", Type: cmdutil.FlagInt, Default: 20, Desc: "最大返回数"},
			},
		},
		"models": {
			Use: "models", Short: "可用模型列表",
			Example:    "  tabtin agent models",
			Route:      cmdutil.RouteDirect,
			HasFormat:  true,
			Idempotent: true,
		},
	}
}

func AgentConfigCommandSchemas() map[string]cmdutil.CommandDef {
	return map[string]cmdutil.CommandDef{
		"show": {
			Use: "show [agent-id]", Short: "查看 Agent 配置",
			Example:    "  tabtin agent config show\n  tabtin agent config show --key authorization_preset",
			Route:      cmdutil.RouteDirect,
			HasFormat:  true,
			Idempotent: true,
			Flags: []cmdutil.FlagDef{
				{Name: "key", Type: cmdutil.FlagString, Desc: "查看指定配置项"},
			},
		},
		"set": {
			Use: "set <key> <value>", Short: "修改 Agent 配置项",
			Example:     "  tabtin agent config set authorization_preset collaborative\n  tabtin agent config set terminal_mode sandboxed",
			Route:       cmdutil.RouteDirect,
			ArgsMapping: []string{"key", "value"},
			Risk:        cmdutil.RiskWrite,
		},
		"preset": {
			Use: "preset <preset>", Short: "快速切换安全预设",
			Example:     "  tabtin agent config preset collaborative\n  tabtin agent config preset cautious",
			Route:       cmdutil.RouteDirect,
			ArgsMapping: []string{"preset"},
			Risk:        cmdutil.RiskWrite,
		},
	}
}
