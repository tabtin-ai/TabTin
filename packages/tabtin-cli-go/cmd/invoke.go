package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

// newCmdInvoke 创建通用 PlatformSurface 调用命令。
//
// 用法：tabtin invoke <module> <verb> [--input JSON | --input @file.json]
//
// 该命令是 PlatformSurface 框架（W3）的 CLI 侧入口。开发者和 Agent 无需为每个
// surface 手写 cobra command——只要 surface 在 CLI Server 注册了 HTTP handler，
// 就能通过 `tabtin invoke <module> <verb>` 直接调用。transport 层自动发现
// Electron/Daemon 的 Unix socket 或回退到 Django 直连。
//
// 设计决策对齐：
//   - D-5（module/verb 作为能力权威 ID）：路径直接拼 /<module>/<verb>
//   - D-8（第三方 App 不走 invoke）：invoke 仅面向平台内注册的 PlatformSurface
//   - CLI-first 哲学：能力先以 CLI 命令名存在，IPC/HTTP 只是 binding
func newCmdInvoke(f *cmdutil.Factory) *cobra.Command {
	var inputFlag string

	cmd := &cobra.Command{
		Use:   "invoke <module> <verb>",
		Short: "调用已注册的 PlatformSurface",
		Long: `通用 PlatformSurface 调用入口。

通过 transport 直接 POST /<module>/<verb> 到 CLI Server（Electron 或 Daemon），
返回 envelope 原样输出。适用于任何已通过 definePlatformSurface 注册的能力，
无需为每个 surface 手写 cobra command。

示例：
  tabtin invoke chat export-md --input '{"sessionId":"abc123"}'
  tabtin invoke chat export-md --input @request.json
  tabtin invoke workspace get-snapshot`,
		Args: cobra.ExactArgs(2),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			module := args[0]
			verb := args[1]

			// 解析 --input：复用 cmdutil.ParseDataOrFile，支持 inline JSON / @filepath / - (stdin) / @@literal
			body, err := cmdutil.ParseDataOrFile(inputFlag)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					fmt.Sprintf("--input 解析失败: %v", err),
					"传入合法 JSON 字符串、@filepath（读文件）/ - (stdin) / @@literal（首字符为 @ 时转义）",
					output.ExitValidation,
				))
			}

			// 从 factory 获取 transport（自动发现 socket/HTTP/Django）
			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable),
					err.Error(),
					"tabtin daemon start",
					output.ExitServiceUnavail,
				))
			}

			// invoke 专为 CLI Server 上的 PlatformSurface 设计——
			// Django 直连模式下 surface HTTP handler 不在 Django 侧注册
			if tr.Type() == transport.TypeDjango {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable),
					"invoke 需要 TabTin 桌面端或 Daemon 运行。当前为 API 直连模式。",
					"tabtin daemon start",
					output.ExitServiceUnavail,
				))
			}

			// 拼接路径：/<module>/<verb>
			path := "/" + module + "/" + verb

			// 尊重 --timeout 全局 flag（PersistentPreRun 已设 f.GlobalTimeout）
			var opts *transport.RequestOptions
			if f.GlobalTimeout > 0 {
				opts = &transport.RequestOptions{Timeout: f.GlobalTimeout}
			}

			reqCtx := cmd.Context()
			resp, err := tr.Request(reqCtx, "POST", path, body, opts)
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.Unavailable),
					fmt.Sprintf("请求 %s 失败: %v", path, err),
					"",
					output.ExitNetwork,
				))
			}

			// 解析响应 envelope 并按 ok/error 分流输出
			return handleInvokeResponse(resp, path, f.Format, f.JQExpr)
		}),
	}

	cmd.Flags().StringVar(&inputFlag, "input", "", `请求参数 JSON（inline / @filepath / - 读 stdin / @@literal 转义）`)

	return cmd
}

// handleInvokeResponse 处理 CLI Server 返回的 envelope 响应。
//
// 响应形态（与 PlatformSurface HTTP adapter 约定一致）：
//   - {ok: true, data: ..., trace_id: ...} → stdout 输出完整 envelope
//   - {ok: false, error: {code, message, ...}, trace_id: ...} → stderr 输出错误 envelope
//   - HTTP 4xx/5xx 但响应体非 envelope → 包装为标准错误 envelope
func handleInvokeResponse(resp *transport.Response, path string, format output.Format, jqExpr string) error {
	// HTTP 层错误（4xx/5xx）
	if resp.Status >= 400 {
		// 尝试从响应体提取结构化错误信息
		var envelope map[string]any
		if json.Unmarshal(resp.Data, &envelope) == nil {
			// 响应体本身是 envelope（ok:false）→ 直接输出到 stderr
			if ok, exists := envelope["ok"]; exists {
				if okBool, isBool := ok.(bool); isBool && !okBool {
					output.PrintError(envelopeFromMap(envelope))
					return output.NewExitError(httpStatusToExitCode(resp.Status))
				}
			}
			// 非 envelope 形态但有 message/detail
			if msg := extractErrorMessage(envelope); msg != "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					cmdutil.HTTPStatusToErrorCode(resp.Status), msg, "", httpStatusToExitCode(resp.Status),
				))
			}
		}
		return output.PrintErrorAndExit(output.ErrorEnvelope(
			cmdutil.HTTPStatusToErrorCode(resp.Status),
			fmt.Sprintf("请求 %s 失败 (HTTP %d): %s", path, resp.Status, string(resp.Data)),
			"",
			httpStatusToExitCode(resp.Status),
		))
	}

	// HTTP 2xx — 尝试识别 envelope 形态
	var envelope map[string]any
	if json.Unmarshal(resp.Data, &envelope) == nil {
		// envelope ok:false（业务错误，HTTP 200 但逻辑失败）
		if ok, exists := envelope["ok"]; exists {
			if okBool, isBool := ok.(bool); isBool && !okBool {
				output.PrintError(envelopeFromMap(envelope))
				return output.NewExitError(output.ExitGeneral)
			}
		}
	}

	// 成功路径 → 原样输出完整 envelope 到 stdout
	var data any
	_ = json.Unmarshal(resp.Data, &data)

	// 支持 --jq 过滤（PersistentPreRun 已设 f.JQExpr）
	if jqExpr != "" {
		jqData := output.UnwrapDjangoEnvelope(data)
		if err := output.PrintJQResult(jqData, jqExpr); err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope(
				string(errcode.ValidationError), err.Error(), "", output.ExitGeneral,
			))
		}
		return nil
	}

	output.PrintResult(data, format)
	return nil
}

// envelopeFromMap 从 map 构建 output.Envelope（用于已识别为 ok:false 的响应体）。
func envelopeFromMap(m map[string]any) *output.Envelope {
	env := &output.Envelope{OK: false}

	if errObj, ok := m["error"].(map[string]any); ok {
		env.Error = &output.ErrorDetail{}
		if code, ok := errObj["code"].(string); ok {
			env.Error.Code = code
		}
		if msg, ok := errObj["message"].(string); ok {
			env.Error.Message = msg
		}
	}

	return env
}

// extractErrorMessage 从非 envelope 错误响应中尝试提取可读错误信息。
func extractErrorMessage(m map[string]any) string {
	if msg, ok := m["message"].(string); ok {
		return msg
	}
	if detail, ok := m["detail"].(string); ok {
		return detail
	}
	return ""
}

// httpStatusToExitCode 将 HTTP 状态码映射到 CLI 退出码。
func httpStatusToExitCode(status int) int {
	switch {
	case status == 401:
		return output.ExitAuth
	case status == 403:
		return output.ExitPermission
	case status == 404:
		return output.ExitNotFound
	case status == 408 || status == 504:
		return output.ExitTimeout
	case status == 503:
		return output.ExitServiceUnavail
	default:
		return output.ExitGeneral
	}
}

// invokeCommandSchema 返回 invoke 命令的 CommandDef，供 RegisterCommandSchema
// 注册到 `tabtin commands` 输出——让 Agent 能自动发现 invoke 命令及其参数定义。
func invokeCommandSchema() cmdutil.CommandDef {
	return cmdutil.CommandDef{
		Use:   "invoke <module> <verb>",
		Short: "调用已注册的 PlatformSurface",
		Long: `通用 PlatformSurface 调用入口。通过 transport 直接 POST /<module>/<verb>
到 CLI Server（Electron 或 Daemon），返回 envelope 原样输出。`,
		Example: `tabtin invoke chat export-md --input '{"sessionId":"abc123"}'
tabtin invoke chat export-md --input @request.json
tabtin invoke workspace get-snapshot`,
		ArgsMapping: []string{"module", "verb"},
		Method:      "POST",
		Route:       cmdutil.RouteCliServer,
		Idempotent:  false,
		Flags: []cmdutil.FlagDef{
			{
				Name: "input",
				Type: cmdutil.FlagString,
				Desc: "请求参数 JSON（inline / @filepath / - 读 stdin / @@literal 转义）",
			},
		},
	}
}
