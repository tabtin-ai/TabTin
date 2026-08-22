package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func newCmdConfig(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "Agent 能力与安全配置",
		Long: `查看和修改 Agent 的能力配置（agent_config）。

对应 Electron 中 Space 设置面板的以下模块：
  - 安全预设 (authorization_preset)
  - 终端模式 (terminal_mode)
  - 操作开关 (operation_switches)
  - 沙箱设置 (sandbox)
  - 执行限制 (execution_limits)
  - Agent 后端 (agent_backend)
  - 记忆系统 (memory)
  - SQL 模式 (sql_mode)

示例：
  tabtin agent config show
  tabtin agent config set authorization_preset collaborative
  tabtin agent config set terminal_mode sandboxed
  tabtin agent config set agent_backend.type codex`,
	}

	cmd.AddCommand(newCmdConfigShow(f))
	cmd.AddCommand(newCmdConfigSet(f))
	cmd.AddCommand(newCmdConfigPreset(f))

	return cmd
}

func fetchAgentConfig(ctx context.Context, f *cmdutil.Factory, agentID string) (map[string]any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	tr, err := f.Transport()
	if err != nil {
		return nil, err
	}

	resp, err := tr.Request(ctx, "GET", fmt.Sprintf("/api/agents/%s", url.PathEscape(agentID)), nil, nil)
	if err != nil {
		return nil, err
	}

	var body map[string]any
	if err := json.Unmarshal(resp.Data, &body); err != nil {
		return nil, fmt.Errorf("解析响应失败: %w", err)
	}

	data, _ := body["data"].(map[string]any)
	if data == nil {
		data = body
	}

	agentConfig, _ := data["agent_config"].(map[string]any)
	if agentConfig == nil {
		agentConfig = map[string]any{}
	}
	return agentConfig, nil
}

func updateAgentConfig(ctx context.Context, f *cmdutil.Factory, agentID string, agentConfig map[string]any) error {
	if ctx == nil {
		ctx = context.Background()
	}
	tr, err := f.Transport()
	if err != nil {
		return err
	}

	body := map[string]any{
		"agent_config": agentConfig,
	}

	resp, err := tr.Request(ctx, "PUT", fmt.Sprintf("/api/agents/%s", url.PathEscape(agentID)), body, nil)
	if err != nil {
		return err
	}
	if resp.Status >= 400 {
		return fmt.Errorf("更新失败 (status %d)", resp.Status)
	}
	return nil
}

func newCmdConfigShow(f *cmdutil.Factory) *cobra.Command {
	var flagKey string

	cmd := &cobra.Command{
		Use:     "show [agent-id]",
		Short:   "查看 Agent 配置",
		Example: "  tabtin agent config show\n  tabtin agent config show --key authorization_preset\n  tabtin agent config show --key sandbox",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			agentID, err := resolveCurrentAgentID(f, args)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "tabtin agent use <id>", output.ExitValidation))
			}

			reqCtx := cmd.Context()

			agentConfig, err := fetchAgentConfig(reqCtx, f, agentID)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			if flagKey != "" {
				parts := strings.Split(flagKey, ".")
				var current any = agentConfig
				for _, part := range parts {
					m, ok := current.(map[string]any)
					if !ok {
						output.PrintResult(nil, f.Format)
						return nil
					}
					current = m[part]
				}
				output.PrintResult(current, f.Format)
				return nil
			}

			output.PrintResult(agentConfig, f.Format)
			return nil
		}),
	}

	cmd.Flags().StringVar(&flagKey, "key", "", "查看指定配置项（支持 . 分隔的路径，如 sandbox.command_execution）")
	return cmd
}

func newCmdConfigSet(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "set <key> <value>",
		Short: "修改 Agent 配置项",
		Long: `修改 agent_config 中的配置项。

常用配置项：
  authorization_preset    安全预设: cautious | collaborative | full_auto
  terminal_mode          终端模式: tabtin_only | sandboxed | regular | blocked
  sql_mode               SQL 模式: read_only | read_write | blocked
  execution_env          执行环境: local | cloud | remote
  agent_backend.type     Agent 后端: builtin | claude-code | codex | gemini | opencode
  memory.enabled         记忆系统: true | false
  sandbox.command_execution  沙箱命令: sandboxed | regular | blocked
  execution_limits.max_iterations_per_run  最大迭代次数

操作开关（operation_switches.*）:
  git_read | git_push | git_destructive | rm | mv | db_write | db_schema |
  package_install | curl_read | curl_mutate | docker | kubectl | ssh
  值: allow | confirm | block`,
		Args:    cobra.ExactArgs(2),
		Example: "  tabtin agent config set authorization_preset collaborative\n  tabtin agent config set terminal_mode sandboxed\n  tabtin agent config set agent_backend.type codex\n  tabtin agent config set memory.enabled true\n  tabtin agent config set operation_switches.git_push confirm",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			key, rawValue := args[0], args[1]

			agentID, err := resolveCurrentAgentID(f, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "tabtin agent use <id>", output.ExitValidation))
			}

			reqCtx := cmd.Context()

			agentConfig, err := fetchAgentConfig(reqCtx, f, agentID)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			var value any
			switch rawValue {
			case "true":
				value = true
			case "false":
				value = false
			default:
				var jsonVal any
				if err := json.Unmarshal([]byte(rawValue), &jsonVal); err == nil {
					value = jsonVal
				} else {
					value = rawValue
				}
			}

			parts := strings.Split(key, ".")
			setNestedValue(agentConfig, parts, value)

			if err := updateAgentConfig(reqCtx, f, agentID, agentConfig); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}

			fmt.Fprintf(os.Stderr, "✓ %s = %v\n", key, value)
			return nil
		}),
	}
}

func setNestedValue(m map[string]any, keys []string, value any) {
	for i := 0; i < len(keys)-1; i++ {
		next, ok := m[keys[i]].(map[string]any)
		if !ok {
			next = map[string]any{}
			m[keys[i]] = next
		}
		m = next
	}
	m[keys[len(keys)-1]] = value
}

func newCmdConfigPreset(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "preset <preset>",
		Short: "快速切换安全预设",
		Long: `切换 authorization_preset，可选值：
  cautious       谨慎模式 — 高风险操作需确认
  collaborative  协作模式 — 常规操作自动执行（默认）
  full_auto      全自动模式 — 所有操作自动执行`,
		Args:    cobra.ExactArgs(1),
		Example: "  tabtin agent config preset collaborative\n  tabtin agent config preset cautious",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			preset := args[0]
			validPresets := []string{"cautious", "collaborative", "full_auto"}
			valid := false
			for _, v := range validPresets {
				if preset == v {
					valid = true
					break
				}
			}
			if !valid {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError),
					fmt.Sprintf("无效的预设 '%s'，可选: %s", preset, strings.Join(validPresets, " | ")),
					"tabtin agent config preset collaborative", output.ExitValidation))
			}

			agentID, err := resolveCurrentAgentID(f, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "tabtin agent use <id>", output.ExitValidation))
			}

			reqCtx := cmd.Context()

			agentConfig, err := fetchAgentConfig(reqCtx, f, agentID)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			agentConfig["authorization_preset"] = preset

			if err := updateAgentConfig(reqCtx, f, agentID, agentConfig); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}

			presetLabels := map[string]string{
				"cautious":      "谨慎模式",
				"collaborative": "协作模式",
				"full_auto":     "全自动模式",
			}
			fmt.Fprintf(os.Stderr, "✓ 安全预设已切换为: %s (%s)\n", preset, presetLabels[preset])
			return nil
		}),
	}
}
