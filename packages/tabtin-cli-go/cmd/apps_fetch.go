package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCmdFetch(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "fetch",
		Short: "获取网页内容",
		Long: `获取指定 URL 的网页内容并转换为 Markdown 格式。

请求从本地设备发出，代理/VPN 天然兼容。

示例：
  tabtin fetch "https://example.com"
  tabtin fetch "https://docs.python.org/3/" --include-images`,
	}

	defs := []cmdutil.CommandDef{
		{
			Use: "fetch <url>", Short: "获取网页内容并转为 Markdown",
			Example: "  tabtin fetch \"https://example.com\"\n  tabtin fetch \"https://docs.python.org/3/\" --include-images",
			Route:   cmdutil.RouteCliServer, Method: "POST", Path: "/fetch",
			Flags: []cmdutil.FlagDef{
				{Name: "url", Type: cmdutil.FlagString, Desc: "目标 URL（也可作为第一个位置参数）"},
				{Name: "include-images", Type: cmdutil.FlagBool, Desc: "包含图片"},
				{Name: "include-links", Type: cmdutil.FlagBool, Default: true, Desc: "包含链接"},
				{Name: "max-length", Type: cmdutil.FlagInt, Desc: "正文最大字符数（默认 50000，超出截断）。截断时完整正文落盘，响应含 full_content_path 供 read_file 分段读回"},
			},
			ArgsMapping: []string{"url"},
			HasFormat:   true,
		},
	}

	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}

	if len(cmd.Commands()) == 1 {
		sub := cmd.Commands()[0]
		cmd.RunE = sub.RunE
		cmd.Flags().AddFlagSet(sub.Flags())
		cmd.Args = sub.Args
	}

	return cmd
}
