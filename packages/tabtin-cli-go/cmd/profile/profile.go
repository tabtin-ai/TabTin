package profile

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func ProfileCommandSchemas() map[string]cmdutil.CommandDef {
	return map[string]cmdutil.CommandDef{
		"list":    {Use: "list", Short: "列出所有 Profile", Example: "  tabtin profile list", Route: cmdutil.RouteDirect, HasFormat: true, Idempotent: true},
		"add":     {Use: "add <name>", Short: "添加 Profile", Example: "  tabtin profile add staging", Route: cmdutil.RouteDirect, ArgsMapping: []string{"name"}, Risk: cmdutil.RiskWrite},
		"use":     {Use: "use <name>", Short: "切换当前 Profile", Example: "  tabtin profile use staging", Route: cmdutil.RouteDirect, ArgsMapping: []string{"name"}, Risk: cmdutil.RiskWrite},
		"current": {Use: "current", Short: "当前 Profile", Example: "  tabtin profile current", Route: cmdutil.RouteDirect, HasFormat: true, Idempotent: true},
		"remove": {
			Use: "remove <name>", Short: "删除 Profile", Example: "  tabtin profile remove staging",
			Route: cmdutil.RouteDirect, ArgsMapping: []string{"name"}, Risk: cmdutil.RiskHigh,
			Flags: []cmdutil.FlagDef{{Name: "force", Type: cmdutil.FlagBool, Desc: "强制删除当前 Profile"}},
		},
	}
}

func NewCmdProfile(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "profile",
		Short: "Profile 管理",
		Long:  "管理多个环境配置（Profile）。",
	}

	cmd.AddCommand(newCmdList(f))
	cmd.AddCommand(newCmdAdd(f))
	cmd.AddCommand(newCmdUse(f))
	cmd.AddCommand(newCmdCurrent(f))
	cmd.AddCommand(newCmdRemove(f))

	return cmd
}

func newCmdList(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Short:   "列出所有 Profile",
		Aliases: []string{"ls"},
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			current := config.ResolveProfileName(cfg)
			items := make([]map[string]any, 0)
			for name, p := range cfg.Profiles {
				item := map[string]any{
					"name":    name,
					"current": name == current,
					"label":   p.Label,
				}
				if p.BaseURL != "" {
					item["base_url"] = p.BaseURL
				}
				if p.Token != "" {
					item["authenticated"] = true
				}
				items = append(items, item)
			}

			output.PrintResult(output.SuccessEnvelope(items), f.Format)
			return nil
		}),
	}
}

func newCmdAdd(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "add <name>",
		Short: "添加 Profile",
		Args:  cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			name := args[0]
			if err := config.ValidateProfileName(name); err != nil {
				return err
			}

			cfg, err := f.Config()
			if err != nil {
				return err
			}

			if _, exists := cfg.Profiles[name]; exists {
				return fmt.Errorf("Profile '%s' 已存在", name)
			}

			cfg.Profiles[name] = &config.ProfileConfig{}
			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("保存失败: %w", err)
			}

			fmt.Fprintf(os.Stderr, "✓ 已创建 Profile '%s'\n", name)
			return nil
		}),
	}
}

func newCmdUse(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "use <name>",
		Short: "切换当前 Profile",
		Args:  cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			name := args[0]
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			if _, ok := cfg.Profiles[name]; !ok {
				return fmt.Errorf("Profile '%s' 不存在", name)
			}

			cfg.CurrentProfile = name
			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("保存失败: %w", err)
			}

			f.ResetTransport()
			fmt.Fprintf(os.Stderr, "✓ 已切换到 Profile '%s'\n", name)
			return nil
		}),
	}
}

func newCmdCurrent(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "current",
		Short: "当前 Profile",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			name := config.ResolveProfileName(cfg)
			p := cfg.CurrentProfileConfig()

			info := map[string]any{
				"name":     name,
				"base_url": p.BaseURL,
				"label":    p.Label,
			}
			if p.Token != "" {
				info["token"] = config.MaskToken(p.Token)
			}

			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		}),
	}
}

func newCmdRemove(f *cmdutil.Factory) *cobra.Command {
	var flagForce bool

	cmd := &cobra.Command{
		Use:   "remove <name>",
		Short: "删除 Profile",
		Args:  cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			name := args[0]
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			if _, ok := cfg.Profiles[name]; !ok {
				return fmt.Errorf("Profile '%s' 不存在", name)
			}

			current := config.ResolveProfileName(cfg)
			if name == current && !flagForce {
				return fmt.Errorf("不能删除当前活跃的 Profile '%s'（使用 --force 强制）", name)
			}

			delete(cfg.Profiles, name)

			if name == current {
				for k := range cfg.Profiles {
					cfg.CurrentProfile = k
					break
				}
				if len(cfg.Profiles) == 0 {
					cfg.Profiles["default"] = &config.ProfileConfig{}
					cfg.CurrentProfile = "default"
				}
			}

			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("保存失败: %w", err)
			}

			fmt.Fprintf(os.Stderr, "✓ 已删除 Profile '%s'\n", name)
			return nil
		}),
	}

	cmd.Flags().BoolVar(&flagForce, "force", false, "强制删除当前 Profile")
	return cmd
}
