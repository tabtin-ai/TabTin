package cmd

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/cmd/table"
	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// newCmdSpace 是 `tabtin workspace` 的过渡期兼容别名。
//
//  Space 终态退役：终态命令为 `tabtin workspace`；本命令仅保留旧脚本兼容路径，
// 每次执行都会在 stderr 打弃用提示（不影响 stdout envelope）。等下游脚本迁移完成后
// 从 root.go 摘除本命令即可彻底退役。
func newCmdSpace(f *cmdutil.Factory) *cobra.Command {
	deprecationNotice := func(subcommand string) {
		fmt.Fprintf(
			os.Stderr,
			"warning: `tabtin space %s` 已改名为 `tabtin workspace %s`。旧命令将在后续版本移除。\n",
			subcommand, subcommand,
		)
	}

	cmd := &cobra.Command{
		Use:        "space",
		Short:      "[已改名] Workspace 管理 — 请使用 `tabtin workspace`",
		Deprecated: "改用 `tabtin workspace`",
		Hidden:     true,
	}
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "[已改名] 列出 Workspace", Example: "  tabtin workspace list",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/workspace/list",
			Runtime: cmdutil.RuntimeHybrid, RemoteMethod: "GET", RemotePath: "/api/context/workspaces",
			HasFormat: true, RequiresAuth: true,
		},
		{
			Use: "tables", Short: "[已改名] 列出当前 Workspace 的表格", Example: "  tabtin workspace tables",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/table/list",
			Runtime: cmdutil.RuntimeHybrid, AdaptRequest: table.AdaptTableList,
			HasFormat: true, RequiresAgent: true, RequiresAuth: true,
		},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}

	useCmd := &cobra.Command{
		Use:     "use <id>",
		Short:   "[已改名] 切换当前 Workspace",
		Example: "  tabtin workspace use <workspace-id>",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			deprecationNotice("use")
			if len(args) == 0 {
				return fmt.Errorf("请指定 Workspace ID")
			}
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			p := cfg.CurrentProfileConfig()
			p.DefaultSpace = args[0]
			cfg.Profiles[cfg.CurrentProfile] = p
			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("保存配置失败: %w", err)
			}
			info := map[string]string{
				"workspace_id": args[0],
				"message":      fmt.Sprintf("已切换到 Workspace %s", args[0]),
			}
			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		}),
	}
	cmd.AddCommand(useCmd)

	currentCmd := &cobra.Command{
		Use:     "current",
		Short:   "[已改名] 显示当前 Workspace",
		Example: "  tabtin workspace current",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			deprecationNotice("current")
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			p := cfg.CurrentProfileConfig()
			info := map[string]string{
				"workspace_id":    p.DefaultSpace,
				"organization_id": p.DefaultOrganization,
				"profile":         cfg.CurrentProfile,
			}
			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		}),
	}
	cmd.AddCommand(currentCmd)
	return cmd
}

func newCmdContext(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "context",
		Short:   "显示当前运行上下文",
		Example: "  tabtin context",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}
			p := cfg.CurrentProfileConfig()
			info := map[string]string{
				"profile":         cfg.CurrentProfile,
				"workspace_id":    p.DefaultSpace,
				"organization_id": p.DefaultOrganization,
				"base_url":        p.BaseURL,
				"label":           p.Label,
			}
			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		}),
	}
}

// ─── Schema 定义（供 root.go RegisterCommandSchema 使用）——旧命令保留但打
// 弃用标记，避免出现在 `tabtin commands` 默认目录里。

func spaceUseCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "use <id>", Short: "[已改名] 切换当前 Workspace（请使用 `tabtin workspace use`）",
		Example:     "  tabtin workspace use <workspace-id>",
		Route:       cmdutil.RouteDirect,
		ArgsMapping: []string{"workspace_id"},
		Risk:        cmdutil.RiskWrite,
	}
}

func spaceCurrentCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "current", Short: "[已改名] 显示当前 Workspace（请使用 `tabtin workspace current`）",
		Example:    "  tabtin workspace current",
		Route:      cmdutil.RouteDirect,
		HasFormat:  true,
		Idempotent: true,
	}
}

func contextCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "context", Short: "显示当前运行上下文",
		Example:    "  tabtin context",
		Route:      cmdutil.RouteDirect,
		HasFormat:  true,
		Idempotent: true,
	}
}
