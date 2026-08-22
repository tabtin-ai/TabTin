package configcmd

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func ConfigCommandSchemas() map[string]cmdutil.CommandDef {
	return map[string]cmdutil.CommandDef{
		"show": {Use: "show", Short: "显示当前配置", Example: "  tabtin config show", Route: cmdutil.RouteDirect, HasFormat: true, Idempotent: true},
		"get": {
			Use: "get <key>", Short: "读取配置项", Example: "  tabtin config get baseURL",
			Route: cmdutil.RouteDirect, ArgsMapping: []string{"key"}, HasFormat: true, Idempotent: true,
			Flags: []cmdutil.FlagDef{{Name: "global", Type: cmdutil.FlagBool, Desc: "操作全局配置"}},
		},
		"set": {
			Use: "set <key> <value>", Short: "写入配置项", Example: "  tabtin config set baseURL https://api.example.com",
			Route: cmdutil.RouteDirect, ArgsMapping: []string{"key", "value"}, HasFormat: true, Risk: cmdutil.RiskWrite,
			Flags: []cmdutil.FlagDef{{Name: "global", Type: cmdutil.FlagBool, Desc: "操作全局配置"}},
		},
		"path": {Use: "path", Short: "配置文件路径", Example: "  tabtin config path", Route: cmdutil.RouteDirect, HasFormat: true, Idempotent: true},
		"purge": {
			Use: "purge", Short: "清除本地配置、登录凭证与缓存（不影响 Space 工作目录）",
			Example: "  tabtin config purge --yes",
			Route:   cmdutil.RouteDirect, HasFormat: true,
			Risk: cmdutil.RiskDestructive, RiskDeclared: true, // ：整目录删除，不可逆
			Flags: []cmdutil.FlagDef{{Name: "yes", Type: cmdutil.FlagBool, Desc: "跳过交互确认，直接清除"}},
		},
	}
}

func NewCmdConfig(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "config",
		Short: "配置管理",
	}

	cmd.AddCommand(newCmdConfigShow(f))
	cmd.AddCommand(newCmdConfigGet(f))
	cmd.AddCommand(newCmdConfigSet(f))
	cmd.AddCommand(newCmdConfigPath(f))
	cmd.AddCommand(newCmdConfigPurge(f))

	return cmd
}

func newCmdConfigShow(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "show",
		Short: "显示当前配置",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			profileName := config.ResolveProfileName(cfg)
			p := cfg.CurrentProfileConfig()

			info := map[string]any{
				"profile":          profileName,
				"base_url":         p.BaseURL,
				"default_space":    p.DefaultSpace,
				"default_agent":    p.DefaultAgent,
				"default_organization": p.DefaultOrganization,
				"label":            p.Label,
			}
			if p.Token != "" {
				info["token"] = config.MaskToken(p.Token)
			}
			if cfg.Defaults.Format != "" {
				info["default_format"] = cfg.Defaults.Format
			}

			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		}),
	}
}

func newCmdConfigGet(f *cmdutil.Factory) *cobra.Command {
	var flagGlobal bool

	cmd := &cobra.Command{
		Use:   "get <key>",
		Short: "读取配置项",
		Args:  cobra.ExactArgs(1),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			key := args[0]
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			var value any
			if flagGlobal {
				switch key {
				case "format":
					value = cfg.Defaults.Format
				default:
					return fmt.Errorf("未知全局配置项: %s", key)
				}
			} else {
				p := cfg.CurrentProfileConfig()
				switch key {
				case "baseURL":
					value = p.BaseURL
				case "defaultSpace":
					value = p.DefaultSpace
				case "defaultAgent":
					value = p.DefaultAgent
				case "defaultOrganization":
					value = p.DefaultOrganization
				case "label":
					value = p.Label
				case "token":
					if p.Token != "" {
						value = config.MaskToken(p.Token)
					} else {
						value = ""
					}
				default:
					return fmt.Errorf("未知配置项: %s（可用: baseURL, defaultSpace, defaultAgent, defaultOrganization, label, token）", key)
				}
			}
			output.PrintResult(output.SuccessEnvelope(map[string]any{
				"key":   key,
				"value": value,
			}), f.Format)
			return nil
		}),
	}

	cmd.Flags().BoolVar(&flagGlobal, "global", false, "操作全局配置")
	return cmd
}

func newCmdConfigSet(f *cmdutil.Factory) *cobra.Command {
	var flagGlobal bool

	cmd := &cobra.Command{
		Use:   "set <key> <value>",
		Short: "写入配置项",
		Args:  cobra.ExactArgs(2),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			key, value := args[0], args[1]
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			if flagGlobal {
				switch key {
				case "format":
					cfg.Defaults.Format = value
				default:
					return fmt.Errorf("未知全局配置项: %s", key)
				}
			} else {
				p := cfg.CurrentProfileConfig()
				switch key {
				case "baseURL":
					p.BaseURL = value
				case "defaultSpace":
					p.DefaultSpace = value
				case "defaultAgent":
					p.DefaultAgent = value
				case "defaultOrganization":
					p.DefaultOrganization = value
				case "label":
					p.Label = value
				case "token":
					return fmt.Errorf("token 不可直接设置，请使用 'tabtin auth login'")
				default:
					return fmt.Errorf("未知配置项: %s", key)
				}
			}

			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("保存配置失败: %w", err)
			}
			output.PrintResult(output.SuccessEnvelope(map[string]any{
				"key":    key,
				"value":  value,
				"global": flagGlobal,
			}), f.Format)
			return nil
		}),
	}

	cmd.Flags().BoolVar(&flagGlobal, "global", false, "操作全局配置")
	return cmd
}

func newCmdConfigPath(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "path",
		Short: "配置文件路径",
		Run: func(cmd *cobra.Command, args []string) {
			output.PrintResult(output.SuccessEnvelope(map[string]any{
				"path": config.FilePath(),
			}), f.Format)
		},
	}
}

// newCmdConfigPurge 删除整个 config.Dir()（默认 ~/.tabtin，可被 TABTIN_CONFIG_DIR 覆盖）：
// config.json（登录凭证）、cli-history.json、cli-outputs/、daemon 发现文件、已安装
// skill 包（~/.tabtin/packages）等本地状态与缓存。
//
// 不动 Space 工作目录/业务文件——这些不在 config.Dir() 之下（详见 internal/config.Dir）。
// `npm uninstall -g @tabtin/cli` 只删可执行文件，不会触达这里；purge 是唯一显式清配置的入口。
func newCmdConfigPurge(f *cmdutil.Factory) *cobra.Command {
	var flagYes bool

	cmd := &cobra.Command{
		Use:   "purge",
		Short: "清除本地配置、登录凭证与缓存",
		Long: "删除本地配置目录（默认 ~/.tabtin，含登录凭证/config.json、cli-history、\n" +
			"cli-outputs 缓存、daemon 发现文件、已安装 skill 包等）。\n\n" +
			"不会删除 Space 工作目录或任何业务文件——它们不在该配置目录之下。\n" +
			"此操作不可恢复，默认需要交互确认；非交互场景请传 --yes。",
		Example: "  tabtin config purge --yes",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			dir := config.Dir()
			if err := validatePurgeDir(dir); err != nil {
				return err
			}

			if _, err := os.Stat(dir); os.IsNotExist(err) {
				fmt.Fprintf(os.Stderr, "配置目录不存在，无需清理: %s\n", dir)
				output.PrintResult(output.SuccessEnvelope(map[string]any{
					"purged": false,
					"path":   dir,
					"reason": "not_exist",
				}), f.Format)
				return nil
			}

			if !flagYes {
				ok, err := confirmPurge(cmd, dir)
				if err != nil {
					return err
				}
				if !ok {
					return fmt.Errorf("已取消：未确认，不会清除 %s（非交互场景请加 --yes）", dir)
				}
			}

			if err := os.RemoveAll(dir); err != nil {
				return fmt.Errorf("清除配置目录失败: %w", err)
			}

			fmt.Fprintf(os.Stderr, "✓ 已清除本地配置/凭证/缓存: %s\n", dir)
			fmt.Fprintf(os.Stderr, "  Space 工作目录与业务文件不受影响。\n")

			output.PrintResult(output.SuccessEnvelope(map[string]any{
				"purged": true,
				"path":   dir,
			}), f.Format)
			return nil
		}),
	}

	cmd.Flags().BoolVar(&flagYes, "yes", false, "跳过交互确认，直接清除")
	return cmd
}

// validatePurgeDir 是删前的最后一道保险：只挡真正灾难性的路径（空串/家目录本身/
// 文件系统根），不限制目录名——TABTIN_CONFIG_DIR 本就允许用户/测试/CI 指向任意
// 自定义目录做隔离（见 internal/config.Dir），purge 不该比 config 其余命令更挑剔。
func validatePurgeDir(dir string) error {
	if strings.TrimSpace(dir) == "" {
		return fmt.Errorf("配置目录路径为空，拒绝清除")
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return fmt.Errorf("解析配置目录路径失败: %w", err)
	}
	if home, herr := os.UserHomeDir(); herr == nil && home != "" {
		if absHome, aerr := filepath.Abs(home); aerr == nil && abs == absHome {
			return fmt.Errorf("拒绝清除：配置目录解析为家目录本身 (%s)，请检查 TABTIN_CONFIG_DIR", abs)
		}
	}
	if parent := filepath.Dir(abs); parent == abs {
		return fmt.Errorf("拒绝清除：配置目录解析为文件系统根 (%s)", abs)
	}
	return nil
}

func confirmPurge(cmd *cobra.Command, dir string) (bool, error) {
	fmt.Fprintf(os.Stderr, "即将删除本地配置/凭证/缓存目录: %s\n", dir)
	fmt.Fprintf(os.Stderr, "此操作不可恢复，且不影响 Space 工作目录与业务文件。确认删除？输入 yes 继续: ")
	reader := bufio.NewReader(cmd.InOrStdin())
	line, err := reader.ReadString('\n')
	if err != nil && err != io.EOF {
		return false, fmt.Errorf("读取确认输入失败: %w", err)
	}
	answer := strings.TrimSpace(strings.ToLower(line))
	return answer == "yes" || answer == "y", nil
}
