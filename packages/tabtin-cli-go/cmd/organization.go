package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func newCmdOrganization(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:     "organization",
		Aliases: []string{"team"},
		Short:   "组织管理",
		Long: `管理 Organization（组织/租户）：成员、设置、用量、计费等。

对应 Electron 中的全局设置面板。`,
	}

	cmd.AddCommand(newCmdOrganizationList(f))
	cmd.AddCommand(newCmdOrganizationInfo(f))
	cmd.AddCommand(newCmdOrganizationUpdate(f))
	cmd.AddCommand(newCmdOrganizationMembers(f))
	cmd.AddCommand(newCmdOrganizationMembership(f))
	cmd.AddCommand(newCmdOrganizationUsage(f))
	cmd.AddCommand(newCmdOrganizationBilling(f))
	cmd.AddCommand(newCmdOrganizationWallet(f))

	return cmd
}

func resolveOrganizationID(f *cmdutil.Factory) (string, error) {
	if id := os.Getenv("TABTIN_ORGANIZATION_ID"); id != "" {
		return id, nil
	}
	cfg, err := f.Config()
	if err != nil {
		return "", err
	}
	p := cfg.CurrentProfileConfig()
	id := config.ResolveOrganizationID(p)
	if id == "" {
		return "", fmt.Errorf("需要 organization_id。使用 --organization-id 或在 config 中设置 defaultOrganization")
	}
	return id, nil
}

func apiGet(ctx context.Context, f *cmdutil.Factory, path string) (any, error) {
	if ctx == nil {
		ctx = context.Background()
	}
	tr, err := f.Transport()
	if err != nil {
		return nil, err
	}
	resp, err := tr.Request(ctx, "GET", path, nil, nil)
	if err != nil {
		return nil, err
	}
	if resp.Status >= 400 {
		var errBody map[string]any
		if json.Unmarshal(resp.Data, &errBody) == nil {
			if msg, ok := errBody["message"].(string); ok {
				return nil, fmt.Errorf("%s (status %d)", msg, resp.Status)
			}
		}
		return nil, fmt.Errorf("请求失败 (status %d)", resp.Status)
	}
	var result any
	if err := json.Unmarshal(resp.Data, &result); err != nil {
		return nil, fmt.Errorf("响应解析失败: %w", err)
	}
	return output.UnwrapDjangoEnvelope(result), nil
}

func newCmdOrganizationList(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "list",
		Short:   "列出我的组织",
		Example: "  tabtin organization list",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			result, err := apiGet(cmd.Context(), f, "/api/context/organizations")
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}
			output.PrintResult(result, f.Format)
			return nil
		}),
	}
}

func newCmdOrganizationInfo(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "info [organization-id]",
		Short:   "组织详情",
		Example: "  tabtin organization info\n  tabtin organization info <id>",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			} else {
				var err error
				id, err = resolveOrganizationID(f)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
				}
			}
			if err := cmdutil.ValidatePathParam(id, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}
			result, err := apiGet(cmd.Context(), f, fmt.Sprintf("/api/context/organizations/%s", url.PathEscape(id)))
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}
			output.PrintResult(result, f.Format)
			return nil
		}),
	}
}

func newCmdOrganizationUpdate(f *cmdutil.Factory) *cobra.Command {
	var (
		flagName string
		flagDesc string
		flagIcon string
	)

	cmd := &cobra.Command{
		Use:     "update [organization-id]",
		Short:   "更新组织设置",
		Example: "  tabtin organization update --name \"新组织名\"\n  tabtin organization update --icon 🚀",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			} else {
				var err error
				id, err = resolveOrganizationID(f)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
				}
			}

			if err := cmdutil.ValidatePathParam(id, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}

			body := map[string]any{}
			if flagName != "" {
				body["name"] = flagName
			}
			if flagDesc != "" {
				body["description"] = flagDesc
			}
			if flagIcon != "" {
				body["icon"] = flagIcon
			}

			if len(body) == 0 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), "请指定要更新的字段", "--name, --description, --icon", output.ExitValidation))
			}

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			resp, err := tr.Request(cmd.Context(), "PUT", fmt.Sprintf("/api/context/organizations/%s", url.PathEscape(id)), body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			if resp.Status >= 400 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), fmt.Sprintf("更新失败 (status %d)", resp.Status), "", output.ExitGeneral))
			}

			var result any
			_ = json.Unmarshal(resp.Data, &result)
			output.PrintResult(output.UnwrapDjangoEnvelope(result), f.Format)
			fmt.Fprintf(os.Stderr, "✓ 组织设置已更新\n")
			return nil
		}),
	}

	cmd.Flags().StringVar(&flagName, "name", "", "组织名称")
	cmd.Flags().StringVar(&flagDesc, "description", "", "组织描述")
	cmd.Flags().StringVar(&flagIcon, "icon", "", "组织图标 (emoji)")
	return cmd
}

func newCmdOrganizationMembers(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "members [organization-id]",
		Short: "组织成员列表",
		Example: "  tabtin organization members\n" +
			"  tabtin organization members <id>\n" +
			"  tabtin organization members --search zhang@example.com",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			} else {
				var err error
				id, err = resolveOrganizationID(f)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
				}
			}
			if err := cmdutil.ValidatePathParam(id, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}
			search, _ := cmd.Flags().GetString("search")
			path := fmt.Sprintf("/api/context/organizations/%s/members", url.PathEscape(id))
			if search != "" {
				path += "?search=" + url.QueryEscape(search)
			}
			// 手写 RunFunc 不走 pipeline.executePipeline 的 dry-run gate——
			// 这里自己处理 --dry-run，让 agent 能验证 --search 的 query 拼接
			// （其他 organization 子命令未实现 dry-run；它们是纯 RiskRead 一次 GET，
			// 没有副作用，pre-existing 行为不在本次 scope 内）。
			if dryRun, _ := cmd.Flags().GetBool("dry-run"); dryRun {
				output.PrintResultForce(output.SuccessEnvelope(map[string]any{
					"dry_run":     true,
					"description": "organization members 列表查询（可选 search 过滤）",
					"plan": []map[string]any{
						{"step": 1, "method": "GET", "url": path},
					},
				}), f.Format)
				return nil
			}
			result, err := apiGet(cmd.Context(), f, path)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}
			output.PrintResult(result, f.Format)
			return nil
		}),
	}
	cmd.Flags().String("search", "",
		"按 email/phone/nickname/username 模糊匹配过滤成员（后端 list_members.search；用于 agent 反查 user-id 不必拉全成员）")
	return cmd
}

func newCmdOrganizationMembership(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "membership [organization-id]",
		Short:   "会员/套餐信息",
		Example: "  tabtin organization membership",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			} else {
				var err error
				id, err = resolveOrganizationID(f)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
				}
			}
			if err := cmdutil.ValidatePathParam(id, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}
			result, err := apiGet(cmd.Context(), f, fmt.Sprintf("/api/membership/organizations/%s/membership", url.PathEscape(id)))
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}
			output.PrintResult(result, f.Format)
			return nil
		}),
	}
}

func newCmdOrganizationUsage(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "usage [organization-id]",
		Short:   "用量统计",
		Example: "  tabtin organization usage",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			} else {
				var err error
				id, err = resolveOrganizationID(f)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
				}
			}
			if err := cmdutil.ValidatePathParam(id, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}
			result, err := apiGet(cmd.Context(), f, fmt.Sprintf("/api/services/billing/organizations/%s/summary", url.PathEscape(id)))
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}
			output.PrintResult(result, f.Format)
			return nil
		}),
	}
}

func newCmdOrganizationBilling(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "billing [organization-id]",
		Short:   "计费与权益",
		Example: "  tabtin organization billing",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			} else {
				var err error
				id, err = resolveOrganizationID(f)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
				}
			}
			if err := cmdutil.ValidatePathParam(id, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}
			result, err := apiGet(cmd.Context(), f, fmt.Sprintf("/api/services/billing/organizations/%s/entitlement", url.PathEscape(id)))
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}
			output.PrintResult(result, f.Format)
			return nil
		}),
	}
}

func newCmdOrganizationWallet(f *cmdutil.Factory) *cobra.Command {
	return &cobra.Command{
		Use:     "wallet [organization-id]",
		Short:   "钱包余额与流水",
		Example: "  tabtin organization wallet",
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			var id string
			if len(args) > 0 {
				id = args[0]
			} else {
				var err error
				id, err = resolveOrganizationID(f)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
				}
			}
			if err := cmdutil.ValidatePathParam(id, "organization ID"); err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.ValidationError), err.Error(), "", output.ExitValidation))
			}
			result, err := apiGet(cmd.Context(), f, fmt.Sprintf("/api/wallet/organizations/%s/wallet", url.PathEscape(id)))
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.InternalError), err.Error(), "", output.ExitGeneral))
			}
			output.PrintResult(result, f.Format)
			return nil
		}),
	}
}

// ─── Schema 定义（供 root.go RegisterCommandSchema 使用）──

func organizationCommandSchemas() map[string]cmdutil.CommandDef {
	return map[string]cmdutil.CommandDef{
		"list": {
			Use: "list", Short: "列出我的组织",
			Example: "  tabtin organization list",
			Method:  "GET", Path: "/api/context/organizations",
			HasFormat: true, RequiresAuth: true, Idempotent: true,
		},
		"info": {
			Use: "info [organization-id]", Short: "组织详情",
			Example: "  tabtin organization info\n  tabtin organization info <id>",
			Method:  "GET", Path: "/api/context/organizations/{organization_id}",
			ArgsMapping: []string{"organization_id"},
			HasFormat:   true, RequiresAuth: true, Idempotent: true,
		},
		"update": {
			Use: "update [organization-id]", Short: "更新组织设置",
			Example: "  tabtin organization update --name \"新组织名\"",
			Method:  "PUT", Path: "/api/context/organizations/{organization_id}",
			ArgsMapping: []string{"organization_id"},
			HasFormat:   true, RequiresAuth: true, Risk: cmdutil.RiskWrite,
			Flags: []cmdutil.FlagDef{
				{Name: "name", Type: cmdutil.FlagString, Desc: "组织名称"},
				{Name: "description", Type: cmdutil.FlagString, Desc: "组织描述"},
				{Name: "icon", Type: cmdutil.FlagString, Desc: "组织图标 (emoji)"},
			},
		},
		"members": {
			Use: "members [organization-id]", Short: "组织成员列表",
			Example: "  tabtin organization members\n" +
				"  tabtin organization members <id>\n" +
				"  tabtin organization members --search zhang@example.com",
			Method:      "GET", Path: "/api/context/organizations/{organization_id}/members",
			ArgsMapping: []string{"organization_id"},
			HasFormat:   true, RequiresAuth: true, Idempotent: true,
			Flags: []cmdutil.FlagDef{
				{Name: "search", Type: cmdutil.FlagString, Desc: "按 email/phone/nickname/username 模糊匹配过滤成员（后端 list_members.search）"},
			},
		},
		"membership": {
			Use: "membership [organization-id]", Short: "会员/套餐信息",
			Example: "  tabtin organization membership",
			Method:  "GET", Path: "/api/membership/organizations/{organization_id}/membership",
			ArgsMapping: []string{"organization_id"},
			HasFormat:   true, RequiresAuth: true, Idempotent: true,
		},
		"usage": {
			Use: "usage [organization-id]", Short: "用量统计",
			Example: "  tabtin organization usage",
			Method:  "GET", Path: "/api/services/billing/organizations/{organization_id}/summary",
			ArgsMapping: []string{"organization_id"},
			HasFormat:   true, RequiresAuth: true, Idempotent: true,
		},
		"billing": {
			Use: "billing [organization-id]", Short: "计费与权益",
			Example: "  tabtin organization billing",
			Method:  "GET", Path: "/api/services/billing/organizations/{organization_id}/entitlement",
			ArgsMapping: []string{"organization_id"},
			HasFormat:   true, RequiresAuth: true, Idempotent: true,
		},
		"wallet": {
			Use: "wallet [organization-id]", Short: "钱包余额与流水",
			Example: "  tabtin organization wallet",
			Method:  "GET", Path: "/api/wallet/organizations/{organization_id}/wallet",
			ArgsMapping: []string{"organization_id"},
			HasFormat:   true, RequiresAuth: true, Idempotent: true,
		},
	}
}
