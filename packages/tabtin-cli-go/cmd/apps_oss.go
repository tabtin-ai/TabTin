package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCmdOSS(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "oss",
		Short: "OSS 文件管理",
		Long: `上传本地文件到 OSS 存储。JSON 响应同时给出 access URL（data.url，可直接
present_to_user 展示）和 OSS 文件引用 id（data.file_id）。

把 data.file_id 喂给 doc import file --file-record-id <id> 即可把已上传的
PDF/Word 转成文档草稿（PDF/Word 导入链路的第一步）。

示例：
  tabtin oss upload /tmp/chart.png
  tabtin oss upload ./report.pdf --folder reports
  FID=$(tabtin oss upload ./report.pdf --format json | jq -r '.data.file_id')`,
	}

	// Layer: L2
	cmdutil.MustRegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:   "upload <file_path>",
		Short: "上传本地文件到 OSS",
		Long: `把本地文件上传到 OSS 存储，返回访问 URL + OSS FileRecord id 引用。
路径必须在 $HOME 或 /tmp 下（cli-server 路径白名单，symlink 会被拒）；单文件上限 100MB。
返回的 file_id 可喂给 ` + "`doc import file --file-record-id`" + ` 把已上传的 PDF/Word
转成文档草稿；data.url 可直接 present_to_user 展示。
若目标是 Organization 云盘列表（团队可见、画布可打开），优先用 ` + "`drive upload`" + ` 一步挂载，不必再 attach。`,
		Example: `  tabtin oss upload /tmp/chart.png
  tabtin oss upload ./report.pdf --folder reports
  tabtin oss upload /tmp/screenshot.png --mime-type image/png`,
		Layer:        "L2",
		Risk:         cmdutil.RiskWrite,
		RiskDeclared: true,
		Route:        cmdutil.RouteCliServer,
		Method:       "POST",
		Path:         "/oss/upload",
		Flags: []cmdutil.FlagDef{
			{Name: "file-path", Type: cmdutil.FlagString, Desc: "文件路径（也可作为第一个位置参数）"},
			{Name: "folder", Type: cmdutil.FlagString, Desc: "OSS 目录（默认 agent/uploads）"},
			{Name: "module", Type: cmdutil.FlagString, Desc: "所属模块（默认 agent）"},
			{Name: "mime-type", Type: cmdutil.FlagString, Desc: "MIME 类型（默认自动检测）"},
		},
		ArgsMapping: []string{"file_path"},
		HasFormat:   true,
		// DryRun plan 展示 CLI 实际发出的 1 步 POST /oss/upload——这是客户端可见的
		// 调用形态。cli-server 内部会把这一次 POST 进一步走 presign-upload → PUT
		// 对象 → confirm-upload 三步直传（非中转），用 @tabtin/action-tools 的
		// oss-upload utility 实现（详见 packages/cli-routes/src/routes/oss.ts）。
		// 这层细节对 CLI 用户/Agent 是封装好的，dry-run 把它写在 description 里
		// 当上下文，plan 主体保持与真实请求形态一致——避免"plan 是 3 步，实际是
		// 1 步"的误导。
		DryRun: func(ctx *cmdutil.RunContext) *cmdutil.DryRunPlan {
			filePath := "<file_path>"
			if len(ctx.Args) > 0 && ctx.Args[0] != "" {
				filePath = ctx.Args[0]
			} else if v, ok := ctx.FlagValues["file-path"].(string); ok && v != "" {
				filePath = v
			}
			body := map[string]any{"file_path": filePath}
			if v, ok := ctx.FlagValues["folder"].(string); ok && v != "" {
				body["folder"] = v
			}
			if v, ok := ctx.FlagValues["module"].(string); ok && v != "" {
				body["module"] = v
			}
			if v, ok := ctx.FlagValues["mime-type"].(string); ok && v != "" {
				body["mime_type"] = v
			}
			return cmdutil.NewDryRunPlan().
				Desc("上传文件到 OSS（cli-server 内部走 presign-upload → PUT object → confirm-upload 三步直传）").
				Step("POST", "/oss/upload", body).File(filePath)
		},
	})

	if len(cmd.Commands()) == 1 {
		sub := cmd.Commands()[0]
		cmd.RunE = sub.RunE
		cmd.Flags().AddFlagSet(sub.Flags())
		cmd.Args = sub.Args
	}

	return cmd
}
