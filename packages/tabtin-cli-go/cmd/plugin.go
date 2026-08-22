package cmd

import (
	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
)

func newCmdPlugin(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "plugin",
		Short: "Personal Plugin 操作",
		Long:  "启动和管理当前宿主中的 Personal Plugin runtime。",
	}

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use:            "launch <plugin-id>",
		Short:          "启动 Personal Plugin runtime",
		Example:        "  tabtin plugin launch cowart --service-id canvas --require-mcp --open-browser",
		Route:          cmdutil.RouteCliServer,
		Method:         "POST",
		Path:           "/plugin/launch",
		HasFormat:      true,
		RequiresAgent:  true,
		IncludeAgentID: true,
		ArgsMapping:    []string{"plugin_id"},
		Layer:          "L2",
		Risk:           cmdutil.RiskWrite,
		RiskDeclared:   true,
		Flags: []cmdutil.FlagDef{
			{Name: "service-id", Type: cmdutil.FlagString, Desc: "要启动的插件服务 ID"},
			{Name: "title", Type: cmdutil.FlagString, Desc: "打开浏览器窗口时使用的标题"},
			{Name: "open-browser", Type: cmdutil.FlagBool, Desc: "启动后打开插件浏览器窗口"},
			{Name: "require-mcp", Type: cmdutil.FlagBool, Desc: "要求插件 MCP 服务成功 attach"},
		},
		OutputSchema: []cmdutil.FieldSchema{
			{Key: "state", Label: "状态", Type: "string"},
			{Key: "pluginId", Label: "插件", Type: "string"},
			{Key: "serviceId", Label: "服务", Type: "string"},
			{Key: "url", Label: "URL", Type: "string"},
		},
	})

	return cmd
}
