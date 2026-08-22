package cmd

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/url"
	"os"
	"strings"
	"time"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/config"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// apps_feishu.go — `tabtin feishu`：飞书 OAuth 连接 + 同通道导入（多维表→TabData / Docx→TabDoc）。
// 全部打 /api/integrations/feishu/*，与 Electron 云盘「外部资源 → 飞书」共用 Django runner。
// 禁止教 Agent 用外部 lark-cli 当迁入通道。

const feishuAPIBase = "/api/integrations/feishu"

func newCmdFeishu(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "feishu",
		Short: "飞书连接与导入（多维表 / 云文档 → 组织）",
		Long: `把飞书多维表格与新版云文档（Docx）一次性导入当前 Organization 云盘。

走 TabTin 自有 OAuth + OpenAPI 管线（/api/integrations/feishu），与 Electron
「新建 → 外部资源 → 飞书」同一套 runner。不要用外部 lark-cli / Cursor lark-doc
代替迁入。

OAuth 必须由用户在浏览器完成；CLI 只打印 authorize_url。`,
		Example: `  tabtin feishu connection get
  tabtin feishu oauth start
  tabtin feishu resolve --url https://xxx.feishu.cn/wiki/WikiNode
  tabtin feishu wiki nodes --space-id <space> --parent-node-token <node>
  tabtin feishu import start --space-id <space> --documents @docs.json
  tabtin feishu import wait <task_id>`,
	}

	registerFeishuConnection(cmd, f)
	registerFeishuProvider(cmd, f)
	registerFeishuOAuth(cmd, f)
	registerFeishuResources(cmd, f)
	registerFeishuBitable(cmd, f)
	registerFeishuWiki(cmd, f)
	registerFeishuResolve(cmd, f)
	registerFeishuFlow(cmd, f)
	registerFeishuImport(cmd, f)

	return cmd
}

const maxFeishuProviderSecretBytes = 16 * 1024

func readFeishuProviderSecret(reader io.Reader) (string, error) {
	if reader == nil {
		return "", fmt.Errorf("缺少标准输入")
	}
	raw, err := io.ReadAll(io.LimitReader(reader, maxFeishuProviderSecretBytes+1))
	if err != nil {
		return "", fmt.Errorf("读取 App Secret 失败: %w", err)
	}
	if len(raw) > maxFeishuProviderSecretBytes {
		return "", fmt.Errorf("App Secret 超过 %d 字节限制", maxFeishuProviderSecretBytes)
	}
	secret := strings.TrimSpace(string(raw))
	if secret == "" {
		return "", fmt.Errorf("标准输入中的 App Secret 不能为空")
	}
	return secret, nil
}

func feishuOrgID(f *cmdutil.Factory, ctx *cmdutil.RunContext) string {
	if ctx != nil && strings.TrimSpace(ctx.OrganizationID) != "" {
		return strings.TrimSpace(ctx.OrganizationID)
	}
	if cfg, err := f.Config(); err == nil {
		return strings.TrimSpace(config.ResolveOrganizationID(cfg.CurrentProfileConfig()))
	}
	return ""
}

func feishuSpaceID(f *cmdutil.Factory, ctx *cmdutil.RunContext) string {
	if ctx != nil {
		if v := strings.TrimSpace(ctx.Str("space-id")); v != "" {
			return v
		}
		if strings.TrimSpace(ctx.SpaceID) != "" {
			return strings.TrimSpace(ctx.SpaceID)
		}
	}
	if cfg, err := f.Config(); err == nil {
		return strings.TrimSpace(config.ResolveSpaceID(cfg.CurrentProfileConfig()))
	}
	return ""
}

func feishuReqContext(ctx *cmdutil.RunContext) context.Context {
	if ctx != nil && ctx.ReqContext != nil {
		return ctx.ReqContext
	}
	return context.Background()
}

func printFeishuResponse(resp *transport.Response, format output.Format, schema []cmdutil.FieldSchema) error {
	if resp.Status >= 400 {
		code, message, hint := agentMemoryErrorFields(resp.Data, resp.Status)
		return output.PrintErrorAndExit(output.ErrorEnvelope(code, message, hint, cmdutil.MapHTTPToExitCode(resp.Status)))
	}
	var data any
	_ = json.Unmarshal(resp.Data, &data)
	output.PrintResultWithSchema(output.UnwrapDjangoEnvelope(data), format, schema)
	return nil
}

func requireFeishuOrg(f *cmdutil.Factory, ctx *cmdutil.RunContext) (string, error) {
	orgID := feishuOrgID(f, ctx)
	if orgID == "" {
		return "", output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			"缺少 organization_id",
			"用全局 --organization-id，或 tabtin config set defaultOrganization <id>",
			output.ExitValidation,
		))
	}
	return orgID, nil
}

// ── connection ────────────────────────────────────────────

func registerFeishuConnection(parent *cobra.Command, f *cmdutil.Factory) {
	connCmd := &cobra.Command{
		Use:   "connection",
		Short: "飞书 OAuth 连接状态",
	}

	cmdutil.MustRegisterCommand(connCmd, f, cmdutil.CommandDef{
		Use:   "get",
		Short: "查看当前组织是否已连接飞书",
		Long: `查看当前 Organization 是否已连接飞书 OAuth（返回 connected / display_name / open_id，不含 token）。
设计理由：导入前必须确认连接；未连时 Agent 应先 oauth start 并停下等人，不能假装已导入。
常见陷阱：换组织后连接不共享；权限变更后须 disconnect 再重新授权才会带上新 scope。`,
		Example: "  tabtin feishu connection get\n" +
			"  tabtin feishu connection get --organization-id <org>\n" +
			"  tabtin feishu connection get --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "GET",
		Path:         feishuAPIBase + "/connection",
		RequiresAuth: true, HasFormat: true, Idempotent: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "connected", Label: "已连接", Type: "boolean"},
			{Key: "display_name", Label: "显示名", Type: "string"},
			{Key: "open_id", Label: "Open ID", Type: "string"},
			{Key: "provider_configured", Label: "企业应用已配置", Type: "boolean"},
			{Key: "provider_status", Label: "企业应用状态", Type: "string"},
			{Key: "can_manage_provider", Label: "可管理企业应用", Type: "boolean"},
			{Key: "provider_app_id", Label: "企业应用 App ID", Type: "string"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			path := feishuAPIBase + "/connection?" + url.Values{"organization_id": {orgID}}.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	cmdutil.MustRegisterCommand(connCmd, f, cmdutil.CommandDef{
		Use:   "disconnect",
		Short: "断开当前组织的飞书连接",
		Long: `断开当前 Organization 下当前用户的飞书 OAuth 绑定（已导入的表/文档不会删除）。
设计理由：换号或 scope 变更时必须先清绑定再授权；高风险操作须 --yes。
常见陷阱：忘加 --yes 会被拒；断开后列表/导入全部 403，须重新 oauth start。`,
		Example: "  tabtin feishu connection disconnect --yes\n" +
			"  tabtin feishu connection disconnect --organization-id <org> --yes\n" +
			"  tabtin feishu connection disconnect --yes --dry-run",
		Layer: "L2", Risk: cmdutil.RiskHigh, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "DELETE",
		Path:         feishuAPIBase + "/connection",
		RequiresAuth: true, HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "yes", Type: cmdutil.FlagBool, Desc: "确认断开（必填）"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			orgID := feishuOrgID(f, ctx)
			if orgID == "" {
				orgID = "<organization-id>"
			}
			return cmdutil.NewDryRunPlan().
				Desc("断开飞书 OAuth 连接（不删已导入资产）").
				Step("DELETE", feishuAPIBase+"/connection?organization_id="+orgID, nil)
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			if !ctx.Bool("yes") {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"断开连接需 --yes 确认",
					"确认后执行：tabtin feishu connection disconnect --yes",
					output.ExitValidation,
				))
			}
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			path := feishuAPIBase + "/connection?" + url.Values{"organization_id": {orgID}}.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "DELETE", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, nil)
		},
	})

	parent.AddCommand(connCmd)
}

// ── oauth ─────────────────────────────────────────────────

func registerFeishuProvider(parent *cobra.Command, f *cmdutil.Factory) {
	providerCmd := &cobra.Command{
		Use:   "provider",
		Short: "组织级飞书企业自建应用",
		Long: `管理当前 Organization 用于飞书数据源授权的企业自建应用。
Owner/Admin 配置一次 App ID 与 App Secret；每位成员仍需通过 oauth start 完成自己的飞书授权。
App Secret 只从标准输入读取，不接受命令行参数，也不会出现在输出中。`,
	}

	cmdutil.MustRegisterCommand(providerCmd, f, cmdutil.CommandDef{
		Use:   "get",
		Short: "查看企业应用配置状态",
		Long: `查看当前 Organization 是否已配置飞书企业自建应用，以及当前用户是否可以管理。
设计理由：企业应用属于组织，个人 OAuth 连接属于成员，两层状态必须分别可观测。
常见陷阱：普通成员只能看到配置状态，App ID 仅向 Owner/Admin 返回，App Secret 永不返回。`,
		Example: "  tabtin feishu provider get\n" +
			"  tabtin feishu provider get --organization-id <org> --format json\n" +
			"  tabtin feishu provider get --organization-id <org> --quiet",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "GET", Path: feishuAPIBase + "/oauth/provider",
		RequiresAuth: true, HasFormat: true, Idempotent: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "configured", Label: "已配置", Type: "boolean"},
			{Key: "status", Label: "状态", Type: "string"},
			{Key: "app_id", Label: "App ID", Type: "string"},
			{Key: "can_manage", Label: "可管理", Type: "boolean"},
			{Key: "verified_at", Label: "校验时间", Type: "datetime"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			path := feishuAPIBase + "/oauth/provider?" + url.Values{"organization_id": {orgID}}.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	cmdutil.MustRegisterCommand(providerCmd, f, cmdutil.CommandDef{
		Use:   "set",
		Short: "校验并保存企业应用凭证（Secret 从 stdin 读取）",
		Long: `校验并保存当前 Organization 的企业自建应用凭证，仅 Owner/Admin 可执行。
App Secret 必须经标准输入传入，例如 printf '%s' "$FEISHU_APP_SECRET" | tabtin feishu provider set --app-id cli_xxx。
更新 App ID 或 App Secret 都会让组织成员重新授权；重复提交完全相同的凭证不会影响连接。`,
		Example: "  printf '%s' \"$FEISHU_APP_SECRET\" | tabtin feishu provider set --app-id cli_xxx\n" +
			"  Get-Content -Raw .\\app-secret.txt | tabtin feishu provider set --app-id cli_xxx\n" +
			"  tabtin feishu provider set --app-id cli_xxx --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "PUT", Path: feishuAPIBase + "/oauth/provider",
		RequiresAuth: true, HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "app-id", Type: cmdutil.FlagString, Required: true, Desc: "飞书企业自建应用 App ID"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			orgID := feishuOrgID(f, ctx)
			if orgID == "" {
				orgID = "<organization-id>"
			}
			return cmdutil.NewDryRunPlan().
				Desc("校验并保存组织级飞书企业应用；App Secret 仅从 stdin 读取且不会展示").
				Step("PUT", feishuAPIBase+"/oauth/provider", map[string]any{
					"organization_id": orgID,
					"app_id":          ctx.Str("app-id"),
					"app_secret":      "[REDACTED]",
				})
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			secret, err := readFeishuProviderSecret(ctx.Stdin)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError), err.Error(),
					"通过管道或重定向把 App Secret 写入标准输入；不要放在命令行参数中",
					output.ExitValidation,
				))
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			body := map[string]any{
				"organization_id": orgID,
				"app_id":          strings.TrimSpace(ctx.Str("app-id")),
				"app_secret":      secret,
			}
			resp, err := tr.Request(feishuReqContext(ctx), "PUT", feishuAPIBase+"/oauth/provider", body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	cmdutil.MustRegisterCommand(providerCmd, f, cmdutil.CommandDef{
		Use:   "delete",
		Short: "删除企业应用配置并使组织成员连接失效",
		Long: `删除当前 Organization 的飞书企业自建应用配置，仅 Owner/Admin 可执行。
设计理由：删除 Provider 后既有个人令牌不能再安全刷新，因此组织内连接会一并失效。
常见陷阱：运行中的导入任务会阻止删除；这是高风险操作，必须由用户明确传入 --yes。`,
		Example: "  tabtin feishu provider delete --yes\n" +
			"  tabtin feishu provider delete --organization-id <org> --yes\n" +
			"  tabtin feishu provider delete --organization-id <org> --dry-run",
		Layer: "L2", Risk: cmdutil.RiskDestructive, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "DELETE", Path: feishuAPIBase + "/oauth/provider",
		RequiresAuth: true, HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "yes", Type: cmdutil.FlagBool, Desc: "确认删除（必填）"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			orgID := feishuOrgID(f, ctx)
			if orgID == "" {
				orgID = "<organization-id>"
			}
			path := feishuAPIBase + "/oauth/provider?" + url.Values{"organization_id": {orgID}}.Encode()
			return cmdutil.NewDryRunPlan().
				Desc("删除组织级飞书企业应用配置，并使该组织下所有飞书个人连接失效").
				Step("DELETE", path, nil)
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			path := feishuAPIBase + "/oauth/provider?" + url.Values{"organization_id": {orgID}}.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "DELETE", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, nil)
		},
	})

	parent.AddCommand(providerCmd)
}

func registerFeishuOAuth(parent *cobra.Command, f *cmdutil.Factory) {
	oauthCmd := &cobra.Command{
		Use:   "oauth",
		Short: "飞书 OAuth 授权",
	}

	cmdutil.MustRegisterCommand(oauthCmd, f, cmdutil.CommandDef{
		Use:   "start",
		Short: "生成飞书授权 URL（须用户在浏览器打开）",
		Long: `生成飞书 OAuth authorize_url，供用户在系统浏览器完成授权。
设计理由：令牌落在服务端加密存储；CLI/Agent 不能无人代授，只能把 URL 交给人。
常见陷阱：授权后要用 connection get 确认；新增 scope 后须先 disconnect 再走本命令。`,
		Example: "  tabtin feishu oauth start\n" +
			"  tabtin feishu oauth start --organization-id <org>\n" +
			"  tabtin feishu oauth start --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "GET",
		Path:         feishuAPIBase + "/oauth/start",
		RequiresAuth: true, HasFormat: true, Idempotent: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "authorize_url", Label: "授权 URL", Type: "string"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			path := feishuAPIBase + "/oauth/start?" + url.Values{"organization_id": {orgID}}.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			if resp.Status < 400 && !output.IsQuietMode() {
				var envelope map[string]any
				if json.Unmarshal(resp.Data, &envelope) == nil {
					data := output.UnwrapDjangoEnvelope(envelope)
					if m, ok := data.(map[string]any); ok {
						if u, _ := m["authorize_url"].(string); u != "" {
							fmt.Fprintf(os.Stderr, "请在浏览器打开授权链接完成飞书登录：\n%s\n", u)
						}
					}
				}
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	parent.AddCommand(oauthCmd)
}

// ── resources / bitable ───────────────────────────────────

func registerFeishuResources(parent *cobra.Command, f *cmdutil.Factory) {
	resCmd := &cobra.Command{
		Use:   "resources",
		Short: "列出可导入的飞书资源（多维表 / Docx）",
	}
	cmdutil.MustRegisterCommand(resCmd, f, cmdutil.CommandDef{
		Use:   "list",
		Short: "列出 / 搜索可导入资源",
		Long: `列出当前账号可见的可导入资源（多维表 bitable / 云文档 docx）。
设计理由：与 Electron 同通道列表一致；深目录资源常需 --q 关键词搜索才能出现。
常见陷阱：空列表多半是缺 drive/docs 权限或未重授权，不是「没加入 Base」。`,
		Example: "  tabtin feishu resources list\n" +
			"  tabtin feishu resources list --q 项目 --kinds bitable\n" +
			"  tabtin feishu resources list --kinds docx --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "q", Type: cmdutil.FlagString, Desc: "搜索关键词"},
			{Name: "kinds", Type: cmdutil.FlagString, Default: "all", Desc: "bitable,docx 或 all"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "token", Label: "Token", Type: "string"},
			{Key: "name", Label: "名称", Type: "string"},
			{Key: "kind", Label: "类型", Type: "enum", Enum: []string{"bitable", "docx"}},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			q := url.Values{"organization_id": {orgID}}
			if v := ctx.Str("q"); v != "" {
				q.Set("q", v)
			}
			if v := ctx.Str("kinds"); v != "" {
				q.Set("kinds", v)
			}
			path := feishuAPIBase + "/resources?" + q.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
	parent.AddCommand(resCmd)
}

func registerFeishuBitable(parent *cobra.Command, f *cmdutil.Factory) {
	bitCmd := &cobra.Command{
		Use:   "bitable",
		Short: "飞书多维表 Base 下的数据表",
	}
	cmdutil.MustRegisterCommand(bitCmd, f, cmdutil.CommandDef{
		Use:   "tables",
		Short: "列出 Base 下的数据表",
		Long: `列出指定飞书 Base（app_token）下的数据表 table_id / name。
设计理由：resolve / resources 只给到 Base；导入前须展开表再 preview / start。
常见陷阱：app_token 不是 table_id；无权限时 502/403，先确认 connection 与可见性。`,
		Example: "  tabtin feishu bitable tables --app-token BaseXxx\n" +
			"  tabtin feishu bitable tables --app-token BaseXxx --organization-id <org>\n" +
			"  tabtin feishu bitable tables --app-token BaseXxx --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "app-token", Type: cmdutil.FlagString, Required: true, Desc: "飞书 Base app_token"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "table_id", Label: "Table ID", Type: "string"},
			{Key: "name", Label: "名称", Type: "string"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			appToken := strings.TrimSpace(ctx.Str("app-token"))
			if appToken == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError), "缺少 --app-token", "", output.ExitValidation,
				))
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			path := fmt.Sprintf(
				"%s/bitable/apps/%s/tables?%s",
				feishuAPIBase,
				url.PathEscape(appToken),
				url.Values{"organization_id": {orgID}}.Encode(),
			)
			resp, err := tr.Request(feishuReqContext(ctx), "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})
	parent.AddCommand(bitCmd)
}

// ── wiki ──────────────────────────────────────────────────

func registerFeishuWiki(parent *cobra.Command, f *cmdutil.Factory) {
	wikiCmd := &cobra.Command{
		Use:   "wiki",
		Short: "飞书知识库浏览（spaces / nodes）",
	}

	cmdutil.MustRegisterCommand(wikiCmd, f, cmdutil.CommandDef{
		Use:   "spaces",
		Short: "列出知识空间",
		Long: `列出当前账号可见的飞书知识空间；首页含合成入口「我的文档库」(space_id=my_library)。
设计理由：贴 /wiki/ 链接 resolve 得到 wiki_node 后，需 space_id 才能展开子节点。
常见陷阱：缺 wiki:space:retrieve 时会 403，须断开后重新 oauth；禁止用 browser 打开飞书网页代替。`,
		Example: "  tabtin feishu wiki spaces\n" +
			"  tabtin feishu wiki spaces --format json\n" +
			"  tabtin feishu wiki spaces --page-token <token>",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "page-token", Type: cmdutil.FlagString, Desc: "分页 token"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "items.name", Label: "名称", Type: "string"},
			{Key: "items.space_id", Label: "Space ID", Type: "string"},
			{Key: "items.node_kind", Label: "类型", Type: "string"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			q := url.Values{"organization_id": {orgID}}
			if v := ctx.Str("page-token"); v != "" {
				q.Set("page_token", v)
			}
			path := feishuAPIBase + "/wiki/spaces?" + q.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	cmdutil.MustRegisterCommand(wikiCmd, f, cmdutil.CommandDef{
		Use:   "nodes",
		Short: "列出知识库节点（可展开目录 / 可导入叶子）",
		Long: `列出知识空间下的节点。docx/bitable 叶子 selectable=true，可直接纳入 import；
目录节点 expandable=true，用返回的 node_token 作为下一层 --parent-node-token。
设计理由：与 Electron 知识库树同通道；resolve /wiki/ 得到 wiki_node 后的标准展开路径。
常见陷阱：不要用 browser/fetch 打开飞书网页；缺 wiki:node:retrieve 须重授权；
父节点为空则列空间根。`,
		Example: "  tabtin feishu wiki nodes --space-id my_library\n" +
			"  tabtin feishu wiki nodes --space-id <space> --parent-node-token <node>\n" +
			"  tabtin feishu wiki nodes --space-id <space> --parent-node-token <node> --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "space-id", Type: cmdutil.FlagString, Required: true, Desc: "知识空间 ID（resolve 返回或 wiki spaces）"},
			{Name: "parent-node-token", Type: cmdutil.FlagString, Desc: "父节点 token；空则列空间根"},
			{Name: "page-token", Type: cmdutil.FlagString, Desc: "分页 token"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "items.name", Label: "名称", Type: "string"},
			{Key: "items.node_token", Label: "节点", Type: "string"},
			{Key: "items.import_kind", Label: "导入类型", Type: "string"},
			{Key: "items.selectable", Label: "可导入", Type: "boolean"},
			{Key: "items.expandable", Label: "可展开", Type: "boolean"},
			{Key: "items.token", Label: "Obj Token", Type: "string"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			spaceID := strings.TrimSpace(ctx.Str("space-id"))
			if spaceID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError), "缺少 --space-id",
					"示例：tabtin feishu wiki nodes --space-id my_library",
					output.ExitValidation,
				))
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			q := url.Values{
				"organization_id": {orgID},
				"space_id":        {spaceID},
			}
			if v := ctx.Str("parent-node-token"); v != "" {
				q.Set("parent_node_token", v)
			}
			if v := ctx.Str("page-token"); v != "" {
				q.Set("page_token", v)
			}
			path := feishuAPIBase + "/wiki/nodes?" + q.Encode()
			resp, err := tr.Request(feishuReqContext(ctx), "GET", path, nil, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	parent.AddCommand(wikiCmd)
}

// ── resolve ───────────────────────────────────────────────

func registerFeishuResolve(parent *cobra.Command, f *cmdutil.Factory) {
	cmdutil.MustRegisterCommand(parent, f, cmdutil.CommandDef{
		Use:   "resolve",
		Short: "解析飞书链接为 kind / token（并探测可见性）",
		Long: `把飞书链接解析为 kind（bitable|docx|wiki_node|unsupported）与 token，并用当前连接探测 accessible。
设计理由：Agent「贴链接导入」依赖服务端权威解析；/wiki/ 会先 get_node，叶子变 docx/bitable，目录返回 wiki_node + space_id 供展开。
常见陷阱：wiki_node 须再 wiki nodes，禁止 browser；Sheets/旧 Doc 仍 unsupported；须已 oauth 且含 wiki 权限。`,
		Example: "  tabtin feishu resolve --url https://xxx.feishu.cn/base/BaseToken\n" +
			"  tabtin feishu resolve --url https://xxx.feishu.cn/wiki/WikiNode --format json\n" +
			"  tabtin feishu resolve --url https://xxx.feishu.cn/docx/DocToken --url https://xxx.feishu.cn/base/Base2\n" +
			"  tabtin feishu resolve --urls '[\"https://xxx.feishu.cn/docx/Doc1\"]' --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "url", Type: cmdutil.FlagStringArray, Desc: "飞书链接（可重复）"},
			{Name: "urls", Type: cmdutil.FlagString, Desc: "飞书链接 JSON 数组（支持 @file）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "items.kind", Label: "类型", Type: "string"},
			{Key: "items.token", Label: "Token", Type: "string"},
			{Key: "items.name", Label: "名称", Type: "string"},
			{Key: "items.accessible", Label: "可访问", Type: "boolean"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			urls := collectFeishuURLs(ctx)
			if len(urls) == 0 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"请提供 --url 或 --urls",
					"示例：tabtin feishu resolve --url https://xxx.feishu.cn/docx/DocToken",
					output.ExitValidation,
				))
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			body := map[string]any{
				"organization_id": orgID,
				"urls":            urls,
			}
			resp, err := tr.Request(feishuReqContext(ctx), "POST", feishuAPIBase+"/resolve", body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, nil)
		},
	})
}

func collectFeishuURLs(ctx *cmdutil.RunContext) []string {
	var out []string
	if arr, ok := ctx.FlagValues["url"].([]string); ok {
		for _, u := range arr {
			u = strings.TrimSpace(u)
			if u != "" {
				out = append(out, u)
			}
		}
	}
	raw := strings.TrimSpace(ctx.Str("urls"))
	if raw != "" {
		var parsed []string
		if json.Unmarshal([]byte(raw), &parsed) == nil {
			for _, u := range parsed {
				u = strings.TrimSpace(u)
				if u != "" {
					out = append(out, u)
				}
			}
		} else {
			out = append(out, raw)
		}
	}
	return out
}

// ── flow ──────────────────────────────────────────────────

func registerFeishuFlow(parent *cobra.Command, f *cmdutil.Factory) {
	flowCmd := &cobra.Command{
		Use:   "flow",
		Short: "检查飞书画板到 TabDoc 静态文本树的降级结果",
	}

	cmdutil.MustRegisterCommand(flowCmd, f, cmdutil.CommandDef{
		Use:   "parse",
		Short: "解析 Wiki/Docx 内嵌画板的流程关系",
		Long: `读取飞书 Wiki 或 Docx 中的首个内嵌画板，将节点与有向连线解析为供 TabDoc 导入兼容的层级数据。
TabDoc 导入链路会把层级渲染为 Markdown 静态文本树；本命令不创建聊天富内容或 TabWhiteboard，也不承诺画布样式和坐标保真。
常见陷阱：需要 board:whiteboard:node:read；新增权限后，旧连接须 disconnect 并重新 OAuth 授权。`,
		Example: "  tabtin feishu flow parse --url https://xxx.feishu.cn/wiki/WikiNode --format json\n" +
			"  tabtin feishu flow parse --url https://xxx.feishu.cn/docx/DocToken --format json\n" +
			"  tabtin --organization-id <org> feishu flow parse --url https://xxx.feishu.cn/wiki/WikiNode",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "POST",
		Path:         feishuAPIBase + "/flow/parse",
		RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "url", Type: cmdutil.FlagString, Desc: "飞书 Wiki 或 Docx 链接（必填）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "title", Label: "标题", Type: "string"},
			{Key: "summary", Label: "摘要", Type: "string"},
			{Key: "nodes", Label: "流程节点", Type: "array"},
			{Key: "warnings", Label: "降级提示", Type: "array"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			resourceURL := strings.TrimSpace(ctx.Str("url"))
			if resourceURL == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"请提供 --url",
					"示例：tabtin feishu flow parse --url https://xxx.feishu.cn/wiki/WikiNode",
					output.ExitValidation,
				))
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			body := map[string]any{
				"organization_id": orgID,
				"url":             resourceURL,
			}
			resp, err := tr.Request(feishuReqContext(ctx), "POST", feishuAPIBase+"/flow/parse", body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	parent.AddCommand(flowCmd)
}

// ── import ────────────────────────────────────────────────

func registerFeishuImport(parent *cobra.Command, f *cmdutil.Factory) {
	importCmd := &cobra.Command{
		Use:   "import",
		Short: "飞书导入任务（preview / start / status / wait）",
	}

	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use:   "preview",
		Short: "导入前审查同 Base Link 闭包",
		Long: `分析所选多维表的同 Base Link 闭包，返回 tables / edges / warnings / has_attachments。
设计理由：关联表会自动纳入；确认闭包与跨 Base 警告后再 start，避免导入半套关联。
常见陷阱：纯文档导入可跳过本步；关联闭包可能扩大导入范围，确认后再继续。`,
		Example: "  tabtin feishu import preview --tables '[{\"app_token\":\"Base1\",\"table_id\":\"tbl1\"}]'\n" +
			"  tabtin feishu import preview --tables @tables.json\n" +
			"  tabtin feishu import preview --tables @tables.json --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "tables", Type: cmdutil.FlagString, Required: true, Desc: "表选择 JSON 数组（支持 @file）"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			tables, err := parseFeishuJSONArray(ctx.Str("tables"), "tables")
			if err != nil {
				return err
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			body := map[string]any{
				"organization_id": orgID,
				"tables":          tables,
			}
			resp, err := tr.Request(feishuReqContext(ctx), "POST", feishuAPIBase+"/import/preview", body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, nil)
		},
	})

	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use:   "start",
		Short: "提交飞书导入任务",
		Long: `提交飞书导入 Job（表 Phase A–D，再导入 Docx），返回 task_id。
设计理由：与 Electron 共用 runner；产物落 Organization 下 space_id 云盘，可选 collection_id。
常见陷阱：tables/documents 至少一项；附件默认关；须先 preview（有表时）并确认 space-id。`,
		Example: "  tabtin feishu import start --space-id <space> --tables @tables.json\n" +
			"  tabtin feishu import start --space-id <space> --documents '[{\"doc_token\":\"Doc1\",\"name\":\"周报\"}]'\n" +
			"  tabtin feishu import start --space-id <space> --tables @t.json --documents @d.json --include-attachments",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true,
		Flags: []cmdutil.FlagDef{
			{Name: "space-id", Type: cmdutil.FlagString, Desc: "目标 Space ID（可用上下文默认）"},
			{Name: "collection-id", Type: cmdutil.FlagString, Desc: "目标云盘文件夹 ID（可选）"},
			{Name: "tables", Type: cmdutil.FlagString, Desc: "表选择 JSON 数组（支持 @file）"},
			{Name: "documents", Type: cmdutil.FlagString, Desc: "文档选择 JSON 数组（支持 @file）"},
			{Name: "include-attachments", Type: cmdutil.FlagBool, Desc: "同步多维表附件实体（默认关）"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "task_id", Label: "Task ID", Type: "id"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			orgID := feishuOrgID(f, ctx)
			if orgID == "" {
				orgID = "<organization-id>"
			}
			spaceID := feishuSpaceID(f, ctx)
			if spaceID == "" {
				spaceID = "<space-id>"
			}
			body := map[string]any{
				"organization_id":     orgID,
				"space_id":            spaceID,
				"include_attachments": ctx.Bool("include-attachments"),
				"tables":              "<tables>",
				"documents":           "<documents>",
			}
			if v := ctx.Str("collection-id"); v != "" {
				body["collection_id"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("提交飞书导入 Job（表 A–D 后再 docs）").
				Step("POST", feishuAPIBase+"/import", body)
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			orgID, err := requireFeishuOrg(f, ctx)
			if err != nil {
				return err
			}
			spaceID := feishuSpaceID(f, ctx)
			if spaceID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"缺少 --space-id",
					"用 --space-id，或 tabtin config set defaultSpace <id> / 全局 --space-id",
					output.ExitValidation,
				))
			}
			// 必须用空切片而非 nil：json.Marshal(nil slice) → null，Pydantic List 拒收。
			tables := []any{}
			documents := []any{}
			if raw := strings.TrimSpace(ctx.Str("tables")); raw != "" {
				tables, err = parseFeishuJSONArray(raw, "tables")
				if err != nil {
					return err
				}
			}
			if raw := strings.TrimSpace(ctx.Str("documents")); raw != "" {
				documents, err = parseFeishuJSONArray(raw, "documents")
				if err != nil {
					return err
				}
			}
			if len(tables) == 0 && len(documents) == 0 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"请至少提供 --tables 或 --documents",
					"",
					output.ExitValidation,
				))
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			body := map[string]any{
				"organization_id":     orgID,
				"space_id":            spaceID,
				"tables":              tables,
				"documents":           documents,
				"include_attachments": ctx.Bool("include-attachments"),
			}
			if v := strings.TrimSpace(ctx.Str("collection-id")); v != "" {
				body["collection_id"] = v
			}
			resp, err := tr.Request(feishuReqContext(ctx), "POST", feishuAPIBase+"/import", body, nil)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			return printFeishuResponse(resp, f.Format, ctx.OutputSchema)
		},
	})

	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use:   "status <task_id>",
		Short: "查询导入任务状态",
		Long: `查询飞书导入任务状态：pending / running / success / failed，附带 result 与 error。
设计理由：异步 Job 的单次观测入口；Agent 也可用 import wait 阻塞到终态。
常见陷阱：task_id 是 Job UUID（import start 返回），不是 celery_task_id。`,
		Example: "  tabtin feishu import status <task_id>\n" +
			"  tabtin feishu import status <task_id> --format json\n" +
			"  tabtin feishu import status <task_id> --jq '.status'",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, Method: "GET",
		Path:         feishuAPIBase + "/import/{task_id}",
		ArgsMapping:  []string{"task_id"},
		RequiresAuth: true, HasFormat: true, Idempotent: true,
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "task_id", Label: "Task", Type: "id"},
			{Key: "status", Label: "Status", Type: "string"},
			{Key: "error", Label: "Error", Type: "string"},
		},
	})

	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use:   "wait <task_id>",
		Short: "轮询直到导入任务结束",
		Long: `阻塞轮询导入任务，直到 status 为 success 或 failed，并打印最终结果。
设计理由：Agent 编排需要同步等到产物；failed 时非 0 退出并带上 error。
常见陷阱：默认 timeout 30m；大表/附件导入可能更久，按需加大 --timeout。`,
		Example: "  tabtin feishu import wait <task_id>\n" +
			"  tabtin feishu import wait <task_id> --interval 3s --timeout 30m\n" +
			"  tabtin feishu import wait <task_id> --format json",
		Layer: "L2", Risk: cmdutil.RiskRead, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true, Idempotent: true,
		ArgsMapping: []string{"task_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "interval", Type: cmdutil.FlagDuration, Default: 2 * time.Second, Desc: "轮询间隔"},
			{Name: "timeout", Type: cmdutil.FlagDuration, Default: 30 * time.Minute, Desc: "总超时"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "task_id", Label: "Task", Type: "id"},
			{Key: "status", Label: "Status", Type: "string"},
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			taskID := ""
			if len(ctx.Args) > 0 {
				taskID = strings.TrimSpace(ctx.Args[0])
			}
			if taskID == "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError), "缺少 task_id", "", output.ExitValidation,
				))
			}
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}
			interval, _ := ctx.FlagValues["interval"].(time.Duration)
			if interval <= 0 {
				interval = 2 * time.Second
			}
			timeout, _ := ctx.FlagValues["timeout"].(time.Duration)
			if timeout <= 0 {
				timeout = 30 * time.Minute
			}
			deadline := time.Now().Add(timeout)
			path := feishuAPIBase + "/import/" + url.PathEscape(taskID)
			reqCtx := feishuReqContext(ctx)
			for {
				if time.Now().After(deadline) {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						string(errcode.Timeout),
						fmt.Sprintf("导入任务超时（%v），task_id=%s", timeout, taskID),
						"用 feishu import status 继续查看，或加大 --timeout",
						output.ExitTimeout,
					))
				}
				resp, err := tr.Request(reqCtx, "GET", path, nil, nil)
				if err != nil {
					select {
					case <-reqCtx.Done():
						return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), reqCtx.Err().Error(), "", output.ExitNetwork))
					case <-time.After(interval):
						continue
					}
				}
				if resp.Status >= 400 {
					return printFeishuResponse(resp, f.Format, nil)
				}
				var envelope map[string]any
				_ = json.Unmarshal(resp.Data, &envelope)
				data, _ := output.UnwrapDjangoEnvelope(envelope).(map[string]any)
				status, _ := data["status"].(string)
				switch status {
				case "success", "failed":
					if !output.IsQuietMode() {
						if status == "success" {
							fmt.Fprintf(os.Stderr, "✅ 飞书导入完成 task_id=%s\n", taskID)
						} else {
							errMsg, _ := data["error"].(string)
							fmt.Fprintf(os.Stderr, "❌ 飞书导入失败 task_id=%s %s\n", taskID, errMsg)
						}
					}
					output.PrintResultWithSchema(data, f.Format, ctx.OutputSchema)
					if status == "failed" {
						return output.PrintErrorAndExit(output.ErrorEnvelope(
							string(errcode.InternalError),
							fmt.Sprintf("导入失败: %v", data["error"]),
							"",
							output.ExitGeneral,
						))
					}
					return nil
				default:
					if !output.IsQuietMode() {
						fmt.Fprintf(os.Stderr, "… 导入进行中 status=%s\n", status)
					}
					select {
					case <-reqCtx.Done():
						return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), reqCtx.Err().Error(), "", output.ExitNetwork))
					case <-time.After(interval):
					}
				}
			}
		},
	})

	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use:   "cancel-table <task_id>",
		Short: "取消尚未开始的单表导入",
		Long: `取消导入任务中尚未开始的一张表（已开始的表请用 skip-table）。
设计理由：长任务止损，避免关联闭包里不需要的表继续占额度。
常见陷阱：已在写入中的表 cancel 会失败，应改 skip-table。`,
		Example: "  tabtin feishu import cancel-table <task_id> --app-token Base1 --table-id tbl1\n" +
			"  tabtin feishu import cancel-table <task_id> --app-token Base1 --table-id tbl1 --format json\n" +
			"  tabtin feishu import cancel-table <task_id> --app-token Base1 --table-id tbl1 --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true,
		ArgsMapping: []string{"task_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "app-token", Type: cmdutil.FlagString, Required: true, Desc: "Base app_token"},
			{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "table_id"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			taskID := "<task_id>"
			if len(ctx.Args) > 0 {
				taskID = ctx.Args[0]
			}
			body := map[string]any{
				"app_token": ctx.Str("app-token"),
				"table_id":  ctx.Str("table-id"),
			}
			return cmdutil.NewDryRunPlan().
				Desc("取消尚未开始的单表").
				Step("POST", feishuAPIBase+"/import/"+taskID+"/cancel-table", body)
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			return feishuImportTableAction(f, ctx, "cancel-table")
		},
	})

	cmdutil.MustRegisterCommand(importCmd, f, cmdutil.CommandDef{
		Use:   "skip-table <task_id>",
		Short: "跳过当前正在导入的表",
		Long: `跳过导入任务中当前正在写入的一张表（停止后续行），任务其余表继续。
设计理由：单表卡住或超限时止损，不必取消整个 Job。
常见陷阱：尚未开始的表请用 cancel-table；skip 后关联回填可能不完整。`,
		Example: "  tabtin feishu import skip-table <task_id> --app-token Base1 --table-id tbl1\n" +
			"  tabtin feishu import skip-table <task_id> --app-token Base1 --table-id tbl1 --format json\n" +
			"  tabtin feishu import skip-table <task_id> --app-token Base1 --table-id tbl1 --dry-run",
		Layer: "L2", Risk: cmdutil.RiskWrite, RiskDeclared: true,
		Route: cmdutil.RouteCliServer, RequiresAuth: true, HasFormat: true,
		ArgsMapping: []string{"task_id"},
		Flags: []cmdutil.FlagDef{
			{Name: "app-token", Type: cmdutil.FlagString, Required: true, Desc: "Base app_token"},
			{Name: "table-id", Type: cmdutil.FlagString, Required: true, Desc: "table_id"},
		},
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			taskID := "<task_id>"
			if len(ctx.Args) > 0 {
				taskID = ctx.Args[0]
			}
			body := map[string]any{
				"app_token": ctx.Str("app-token"),
				"table_id":  ctx.Str("table-id"),
			}
			return cmdutil.NewDryRunPlan().
				Desc("跳过进行中的单表").
				Step("POST", feishuAPIBase+"/import/"+taskID+"/skip-table", body)
		},
		RunFunc: func(ctx *cmdutil.RunContext) error {
			return feishuImportTableAction(f, ctx, "skip-table")
		},
	})

	parent.AddCommand(importCmd)
}

func feishuImportTableAction(f *cmdutil.Factory, ctx *cmdutil.RunContext, action string) error {
	taskID := ""
	if len(ctx.Args) > 0 {
		taskID = strings.TrimSpace(ctx.Args[0])
	}
	if taskID == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), "缺少 task_id", "", output.ExitValidation,
		))
	}
	appToken := strings.TrimSpace(ctx.Str("app-token"))
	tableID := strings.TrimSpace(ctx.Str("table-id"))
	if appToken == "" || tableID == "" {
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError), "需要 --app-token 与 --table-id", "", output.ExitValidation,
		))
	}
	tr, err := f.Transport()
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
	}
	path := feishuAPIBase + "/import/" + url.PathEscape(taskID) + "/" + action
	body := map[string]any{"app_token": appToken, "table_id": tableID}
	resp, err := tr.Request(feishuReqContext(ctx), "POST", path, body, nil)
	if err != nil {
		return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
	}
	return printFeishuResponse(resp, f.Format, nil)
}

func parseFeishuJSONArray(raw, flagName string) ([]any, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("--%s 不能为空", flagName),
			"",
			output.ExitValidation,
		))
	}
	var arr []any
	if err := json.Unmarshal([]byte(raw), &arr); err != nil {
		return nil, output.PrintErrorAndExit(output.ErrorEnvelope(
			string(errcode.ValidationError),
			fmt.Sprintf("--%s 必须是合法 JSON 数组", flagName),
			fmt.Sprintf(`示例：--%s '[{"app_token":"Base1","table_id":"tbl1"}]' 或 --%s @file.json`, flagName, flagName),
			output.ExitValidation,
		))
	}
	return arr, nil
}
