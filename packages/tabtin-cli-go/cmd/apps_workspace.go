package cmd

import (
	"fmt"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/cmd/table"
	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/output"
)

// newCmdWorkspace 提供 `tabtin workspace list/tables/use/current` 命令族。
//
//  Space 终态退役：这是 `tabtin space` 的终态替代——面向个人域 Workspace。
// 老命令 `tabtin space` 作为过渡期别名保留，但会打 stderr 弃用提示。
func newCmdWorkspace(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "workspace",
		Short: "Workspace 管理（个人域执行现场）",
	}
	defs := []cmdutil.CommandDef{
		{
			Use: "list", Short: "列出 Workspace", Example: "  tabtin workspace list",
			Route: cmdutil.RouteCliServer, Method: "POST", Path: "/workspace/list",
			Runtime: cmdutil.RuntimeHybrid, RemoteMethod: "GET", RemotePath: "/api/context/workspaces",
			HasFormat: true, RequiresAuth: true,
		},
		{
			Use: "tables", Short: "列出当前 Workspace 的表格", Example: "  tabtin workspace tables",
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
		Short:   "切换当前 Workspace",
		Example: "  tabtin workspace use <workspace-id>",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
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
		Short:   "显示当前 Workspace",
		Example: "  tabtin workspace current",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
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

// ─── Schema 定义（供 root.go RegisterCommandSchema 使用）──

func workspaceUseCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "use <id>", Short: "切换当前 Workspace",
		Example:     "  tabtin workspace use <workspace-id>",
		Route:       cmdutil.RouteDirect,
		ArgsMapping: []string{"workspace_id"},
		Risk:        cmdutil.RiskWrite,
	}
}

func workspaceCurrentCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use: "current", Short: "显示当前 Workspace",
		Example:    "  tabtin workspace current",
		Route:      cmdutil.RouteDirect,
		HasFormat:  true,
		Idempotent: true,
	}
}
