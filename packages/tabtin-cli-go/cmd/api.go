package cmd

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/errcode"
	"github.com/TabTin/tabtin-cli/internal/output"
	"github.com/TabTin/tabtin-cli/internal/transport"
)

func newCmdAPI(f *cmdutil.Factory) *cobra.Command {
	var (
		flagData   string
		flagParams string
		flagOutput string
	)

	cmd := &cobra.Command{
		Use:   "api <method> <path>",
		Short: "通用 API 调用",
		Long: `原始 API 调用——L2 命令缺失时的逃生口（cli-philosophy: "L1 是逃生门，Agent 不应日常用"）。

适用场景：①Agent 在 L2 命令缺失时兜底调用某 endpoint；②人类调试 raw envelope；
③一次性脚本（如清理测试残留）。日常工作应优先用 tabtin <app> <verb> 形式（L2）——
频繁使用 tabtin api 说明 L2 该有的命令缺了，应反馈给该 App owner 补 L2，
而不是教 Agent 长期用 tabtin api。

--data 支持四种输入：
  字面 JSON：     --data '{"key":"value"}'
  从文件读：      --data @./payload.json
  从 stdin 读：   --data -
  首字符 @ 转义： --data '@@literal' （等价字面 "@literal"）

示例：
  tabtin api GET /health
  tabtin api POST /table/list --data '{"space_id":"xxx"}'
  tabtin api GET "/agent/models?space_id=xxx"
  tabtin api POST /api/tabdoc/documents --data '{"organization_id":"xxx","space_id":"xxx","title":"test"}'
  tabtin api POST /api/tabslide/parse-pptx --data @/tmp/payload.json`,
		Args: cobra.ExactArgs(2),
		RunE: cmdutil.SafeRunE(func(cmd *cobra.Command, args []string) error {
			// v10.6 P1：手写命令也必须遵守全局协议——命令级 -o/--output 与全局 --jq 互斥。
			// 与 pipeline.go 早期互斥拦同语义（VALIDATION_ERROR + ExitValidation）。
			// 之前 api 直接 os.WriteFile 绕过了 v10.5 的 pipeline 拦点。
			if flagOutput != "" && f.JQExpr != "" {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					string(errcode.ValidationError),
					"命令级 --output 与全局 --jq 不能同时使用",
					"二选一：写 raw response 到文件用 -o/--output；过滤后输出用 --jq（拿掉一个）",
					output.ExitValidation,
				))
			}

			method := strings.ToUpper(args[0])
			path := args[1]

			tr, err := f.Transport()
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitServiceUnavail))
			}

			var body map[string]any
			if flagData != "" {
				body, err = cmdutil.ParseDataOrFile(flagData)
				if err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						string(errcode.ValidationError),
						fmt.Sprintf("--data 解析失败: %v", err),
						"传入合法 JSON 字符串、@filepath（读文件）/ - (stdin) / @@literal（首字符为 @ 时转义）",
						output.ExitValidation,
					))
				}
			}

			if flagParams != "" {
				if !strings.Contains(path, "?") {
					path += "?" + flagParams
				} else {
					path += "&" + flagParams
				}
			}

			reqCtx := cmd.Context()
			resp, err := tr.Request(reqCtx, method, path, body, &transport.RequestOptions{})
			if err != nil {
				return output.PrintErrorAndExit(output.ErrorEnvelope(string(errcode.Unavailable), err.Error(), "", output.ExitNetwork))
			}

			if flagOutput != "" {
				// v10.6 P1：写盘失败走统一 IO_ERROR envelope（与 output.writeResultToFile 一致），
				// 不再 return fmt.Errorf（之前会被外层包装成 ExitGeneral 而非 IO_ERROR）
				if err := os.WriteFile(flagOutput, resp.Data, 0644); err != nil {
					return output.PrintErrorAndExit(output.ErrorEnvelope(
						"IO_ERROR",
						fmt.Sprintf("--output 写盘失败：%s", err.Error()),
						fmt.Sprintf("检查路径是否可写：%s（目录需存在 + 有写权限）", flagOutput),
						output.ExitGeneral,
					))
				}
				// v10.6 P1：quiet 模式抑制成功提示（"✓ 响应已写入"是成功路径 stderr 提示，
				// 与 pipeline 的"已写入"提示同等待遇）
				if !output.IsQuietMode() {
					fmt.Fprintf(os.Stderr, "✓ 响应已写入 %s (%d bytes)\n", flagOutput, len(resp.Data))
				}
				return nil
			}

			if resp.Status >= 400 {
				return output.PrintErrorAndExit(output.ErrorEnvelope(
					cmdutil.HTTPStatusToErrorCode(resp.Status),
					fmt.Sprintf("API request failed (HTTP %d)", resp.Status),
					string(resp.Data),
					cmdutil.MapHTTPToExitCode(resp.Status),
				))
			}

			// 走 PrintResultWithSchema 让全局 jq/quiet/output 生效（之前 PrintResult 也走但显式传 schema 更清晰）
			var pretty any
			if err := json.Unmarshal(resp.Data, &pretty); err == nil {
				output.PrintResultWithSchema(output.SuccessEnvelope(output.UnwrapDjangoEnvelope(pretty)), f.Format, nil)
			} else {
				output.PrintResultWithSchema(output.SuccessEnvelope(map[string]any{
					"raw": string(resp.Data),
				}), f.Format, nil)
			}

			return nil
		}),
	}

	cmd.Flags().StringVarP(&flagData, "data", "d", "", "请求体 JSON（inline / @filepath / - 读 stdin / @@literal 转义）")
	cmd.Flags().StringVar(&flagParams, "params", "", "查询参数 (key=value&key2=value2)")
	cmd.Flags().StringVarP(&flagOutput, "output", "o", "", "输出到文件（用于二进制响应）")

	return cmd
}
