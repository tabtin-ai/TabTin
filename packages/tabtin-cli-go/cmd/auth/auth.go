package auth

import (
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func AuthCommandSchemas() map[string]cmdutil.CommandDef {
	return map[string]cmdutil.CommandDef{
		"login": {
			Use: "login", Short: "登录 TabTin",
			Example: "  tabtin auth login\n" +
				"  tabtin auth login --url https://api.example.com --token ttn_xxx",
			Route: cmdutil.RouteDirect,
			Risk:  cmdutil.RiskWrite, RiskDeclared: true, // ：写本地 profile 凭证
			Flags: []cmdutil.FlagDef{
				{Name: "url", Type: cmdutil.FlagString, Desc: "TabTin API 地址（默认 TABTIN_API_URL 或 https://api.example.com）"},
				{Name: "token", Type: cmdutil.FlagString, Desc: "API Token / UserApiKey（CI 非交互；与设备码二选一）"},
				{Name: "profile", Type: cmdutil.FlagString, Desc: "目标 Profile 名称"},
				{Name: "label", Type: cmdutil.FlagString, Desc: "Profile 标签"},
			},
		},
		"logout": {
			Use: "logout", Short: "退出登录",
			Example: "  tabtin auth logout",
			Route:   cmdutil.RouteDirect,
			Risk:    cmdutil.RiskWrite, RiskDeclared: true, // ：清本地凭证
			Flags: []cmdutil.FlagDef{
				{Name: "profile", Type: cmdutil.FlagString, Desc: "目标 Profile 名称"},
			},
		},
		"whoami": {
			Use: "whoami", Short: "当前身份信息",
			Example:    "  tabtin auth whoami",
			Route:      cmdutil.RouteDirect,
			HasFormat:  true,
			Idempotent: true,
		},
	}
}

func NewCmdAuth(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "auth",
		Short: "认证管理",
		Long:  "登录、登出和身份管理。",
	}

	cmd.AddCommand(newCmdLogin(f))
	cmd.AddCommand(newCmdLogout(f))
	cmd.AddCommand(newCmdWhoami(f))

	return cmd
}

func newCmdLogin(f *cmdutil.Factory) *cobra.Command {
	var (
		flagURL     string
		flagToken   string
		flagProfile string
		flagLabel   string
	)

	cmd := &cobra.Command{
		Use:   "login",
		Short: "登录 TabTin",
		Long: `默认使用浏览器/设备码完成用户授权（OAuth Device Flow）。
CI / 自动化可传 --url 与 --token（UserApiKey），或设置环境变量 TABTIN_API_URL + TABTIN_TOKEN。`,
		Example: `  tabtin auth login
  tabtin auth login --url https://api.example.com
  tabtin auth login --url https://api.example.com --token ttn_xxx
  tabtin auth login --profile staging --url https://staging.example.com --token ttn_xxx`,
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			profileName := flagProfile
			if profileName == "" {
				profileName = config.ResolveProfileName(cfg)
			}
			if err := config.ValidateProfileName(profileName); err != nil {
				return err
			}

			baseURL := strings.TrimSpace(flagURL)
			if baseURL == "" {
				baseURL = defaultAPIURL()
			}
			token := strings.TrimSpace(flagToken)
			if token == "" {
				token = strings.TrimSpace(os.Getenv("TABTIN_TOKEN"))
			}

			// --token / TABTIN_TOKEN：非交互 PAT 路径（CI）
			if token != "" {
				p, ok := cfg.Profiles[profileName]
				if !ok {
					p = &config.ProfileConfig{}
					cfg.Profiles[profileName] = p
				}
				p.BaseURL = baseURL
				p.Token = token
				p.RefreshToken = "" // PAT 无 refresh
				if flagLabel != "" {
					p.Label = flagLabel
				}
				if flagProfile == "" {
					cfg.CurrentProfile = profileName
				}
				if err := config.Save(cfg); err != nil {
					return fmt.Errorf("保存配置失败: %w", err)
				}
				f.ResetTransport()
				fmt.Fprintf(os.Stderr, "✓ 已登录 Profile '%s' (%s)\n", profileName, baseURL)
				verifyToken(cmd, f)
				return nil
			}

			// 默认：设备码 / 浏览器授权
			if err := runDeviceLogin(baseURL, profileName, flagLabel, cfg); err != nil {
				return err
			}
			f.ResetTransport()
			verifyToken(cmd, f)
			return nil
		},
	}

	cmd.Flags().StringVar(&flagURL, "url", "", "TabTin API 地址")
	cmd.Flags().StringVar(&flagToken, "token", "", "API Token / UserApiKey（CI 非交互）")
	cmd.Flags().StringVar(&flagProfile, "profile", "", "目标 Profile 名称")
	cmd.Flags().StringVar(&flagLabel, "label", "", "Profile 标签")

	return cmd
}

func verifyToken(cmd *cobra.Command, f *cmdutil.Factory) {
	if tr, trErr := f.Transport(); trErr == nil {
		reqCtx := cmd.Context()
		resp, reqErr := tr.Request(reqCtx, "GET", "/api/context/organizations", nil, nil)
		if reqErr == nil && resp.Status < 400 {
			fmt.Fprintf(os.Stderr, "✓ Token 验证通过\n")
			return
		}
		detail := ""
		if reqErr != nil {
			detail = reqErr.Error()
		} else {
			detail = fmt.Sprintf("HTTP %d", resp.Status)
		}
		fmt.Fprintf(os.Stderr, "⚠ Token 验证失败: %s，请检查 token 是否有效\n", detail)
	}
}

func newCmdLogout(f *cmdutil.Factory) *cobra.Command {
	var flagProfile string

	cmd := &cobra.Command{
		Use:   "logout",
		Short: "退出登录",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			profileName := flagProfile
			if profileName == "" {
				profileName = config.ResolveProfileName(cfg)
			}

			p, ok := cfg.Profiles[profileName]
			if !ok {
				return fmt.Errorf("Profile '%s' 不存在", profileName)
			}

			p.Token = ""
			p.RefreshToken = ""
			if err := config.Save(cfg); err != nil {
				return fmt.Errorf("保存配置失败: %w", err)
			}
			f.ResetTransport()

			fmt.Fprintf(os.Stderr, "✓ 已退出 Profile '%s'\n", profileName)
			return nil
		},
	}

	cmd.Flags().StringVar(&flagProfile, "profile", "", "目标 Profile 名称")
	return cmd
}

func newCmdWhoami(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:   "whoami",
		Short: "当前身份信息",
		RunE: func(cmd *cobra.Command, args []string) error {
			cfg, err := f.Config()
			if err != nil {
				return err
			}

			profileName := config.ResolveProfileName(cfg)
			p := cfg.CurrentProfileConfig()

			info := map[string]any{
				"profile":  profileName,
				"base_url": config.ResolveBaseURL(p),
			}

			token := config.ResolveToken(p)
			if token != "" {
				info["authenticated"] = true
				info["token"] = config.MaskToken(token)
				info["has_refresh_token"] = p.RefreshToken != ""
			} else {
				info["authenticated"] = false
			}

			if p.Label != "" {
				info["label"] = p.Label
			}
			if agentID := config.ResolveAgentID(p); agentID != "" {
				info["agent_id"] = agentID
			}
			if spaceID := config.ResolveSpaceID(p); spaceID != "" {
				info["space_id"] = spaceID
			}
			if organizationID := config.ResolveOrganizationID(p); organizationID != "" {
				info["organization_id"] = organizationID
			}

			output.PrintResult(output.SuccessEnvelope(info), f.Format)
			return nil
		},
	}
}
