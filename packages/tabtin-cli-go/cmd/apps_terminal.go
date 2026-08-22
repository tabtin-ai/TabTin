package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

// ─── Terminal ────────────────────────────────────────────────────
// 打开 / 列出 TabTin 应用内可交互终端（xterm + node-pty）。
// 用户说「打开终端」应走这里，而不是 tabtin desktop open PowerShell。

func newCmdTerminal(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "terminal",
		Short: "打开 / 管理 TabTin 应用内终端",
		Long: `打开 TabTin 应用内的可交互终端 Tab（用户可手动打字输入）。

与 run_terminal_command 的区别：
  - tabtin terminal open     → 打开应用内可交互终端（给用户用）
  - run_terminal_command     → Agent 在后台跑命令，输出进只读 transcript

用户说「打开终端」时用本命令；不要用 tabtin desktop open 打开系统 PowerShell。

示例：
  tabtin terminal open
  tabtin terminal open --cwd ~/projects/foo --title "项目终端"
  tabtin terminal list
  tabtin terminal open --session-id <id>`,
	}

	defs := []cmdutil.CommandDef{
		{
			Use: "open", Short: "打开应用内可交互终端",
			Example: "  tabtin terminal open\n  tabtin terminal open --cwd ~/projects/foo --title \"项目终端\"\n  tabtin terminal open --session-id <id>",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/terminal/open",
			Risk: cmdutil.RiskWrite, RiskDeclared: true, // ：新建/聚焦交互终端 Tab，改客户端状态
			Flags: []cmdutil.FlagDef{
				{Name: "cwd", Type: cmdutil.FlagString, Desc: "终端起始工作目录"},
				{Name: "title", Type: cmdutil.FlagString, Desc: "终端 Tab 标题"},
				{Name: "session-id", Type: cmdutil.FlagString, Desc: "聚焦已有终端会话（不新建）"},
			},
			HasFormat: true,
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "sessionId", Label: "会话 ID", Type: "id"},
				{Key: "tabKey", Label: "Tab Key", Type: "string"},
				{Key: "created", Label: "是否新建", Type: "boolean"},
				{Key: "title", Label: "标题", Type: "string"},
				{Key: "cwd", Label: "工作目录", Type: "string"},
			},
		},
		{
			Use: "list", Short: "列出当前 Space 的终端会话",
			Example: "  tabtin terminal list\n  tabtin terminal list --format table",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/terminal/list",
			HasFormat: true,
			OutputSchema: []cmdutil.FieldSchema{
				{Key: "sessions", Label: "会话列表", Type: "array"},
			},
		},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}

	return cmd
}
