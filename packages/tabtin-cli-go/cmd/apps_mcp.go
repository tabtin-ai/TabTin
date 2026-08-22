package cmd

import (
	"encoding/json"
	"fmt"

	"github.com/spf13/cobra"

	"github.com/TabTin/tabtin-cli/internal/cmdutil"
	"github.com/TabTin/tabtin-cli/internal/output"
)

func newCmdMcp(f *cmdutil.Factory) *cobra.Command {
	cmd := &cobra.Command{
		Use:   "mcp",
		Short: "MCP (Model Context Protocol) 服务管理",
		Long: `管理当前 Agent 已启用的 MCP Server：发现工具、读取资源、获取 Prompt。

示例：
  tabtin mcp list-servers
  tabtin mcp list-tools --server-name github
  tabtin mcp list-resources
  tabtin mcp read-resource --uri "file:///readme.md"
  tabtin mcp list-prompts
  tabtin mcp get-prompt --prompt-name summarize
  tabtin mcp call --server-name github --tool-name create_issue --arguments '{"title":"bug"}'`,
	}

	defs := []cmdutil.CommandDef{
		{
			Use: "list-servers", Short: "列出已接入的 MCP Server",
			Route: cmdutil.RouteCliServer, Method: "GET", Path: "/mcp/servers",
			HasFormat: true, RequiresAgent: true, IncludeAgentID: true,
		},
		{
			Use: "list-tools", Short: "列出 MCP 工具及 schema",
			Route: cmdutil.RouteCliServer, Method: "GET", Path: "/mcp/tools",
			Flags: []cmdutil.FlagDef{
				{Name: "server-name", Type: cmdutil.FlagString, Desc: "限定 MCP Server 名称"},
			},
			HasFormat: true, RequiresAgent: true, IncludeAgentID: true,
		},
		{
			Use: "list-resources", Short: "列出 MCP 资源",
			Route: cmdutil.RouteCliServer, Method: "GET", Path: "/mcp/resources",
			Flags: []cmdutil.FlagDef{
				{Name: "server-name", Type: cmdutil.FlagString, Desc: "限定 MCP Server 名称"},
			},
			HasFormat: true, RequiresAgent: true, IncludeAgentID: true,
		},
		{
			Use: "list-prompts", Short: "列出 MCP Prompts",
			Route: cmdutil.RouteCliServer, Method: "GET", Path: "/mcp/prompts",
			Flags: []cmdutil.FlagDef{
				{Name: "server-name", Type: cmdutil.FlagString, Desc: "限定 MCP Server 名称"},
			},
			HasFormat: true, RequiresAgent: true, IncludeAgentID: true,
		},
	}
	for _, def := range defs {
		cmdutil.RegisterCommand(cmd, f, def)
	}

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "read-resource", Short: "读取 MCP 资源内容",
		Route:         cmdutil.RouteCliServer,
		HasFormat:     true,
		RequiresAgent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "uri", Type: cmdutil.FlagString, Required: true, Desc: "资源 URI（从 list-resources 获取）"},
			{Name: "server-name", Type: cmdutil.FlagString, Desc: "限定 MCP Server 名称"},
		},
		RunFunc: mcpReadResourceFunc(f),
	})

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "get-prompt", Short: "获取 MCP Prompt 内容",
		Route:         cmdutil.RouteCliServer,
		HasFormat:     true,
		RequiresAgent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "prompt-name", Type: cmdutil.FlagString, Required: true, Desc: "Prompt 名称（从 list-prompts 获取）"},
			{Name: "arguments", Type: cmdutil.FlagString, Desc: "JSON 格式的参数对象"},
			{Name: "server-name", Type: cmdutil.FlagString, Desc: "限定 MCP Server 名称"},
		},
		RunFunc: mcpGetPromptFunc(f),
	})

	cmdutil.RegisterCommand(cmd, f, cmdutil.CommandDef{
		Use: "call", Short: "调用 MCP 工具（debug 用）",
		Long: `直接调用一个 MCP 工具。主要用于调试和测试。
正常 Agent 工作流中应通过 mcp_call_tool FC 调用。

server-name 与 connection-id 二选一即可（与 mcp_call_tool FC 的 schema 对齐）：
  --server-name 适用于 MCP Server 名字唯一的场景；
  --connection-id 在同一个 server name 有多个 connection 时精确定位。`,
		Route:         cmdutil.RouteCliServer,
		HasFormat:     true,
		Risk:          cmdutil.RiskWrite,
		RequiresAgent: true,
		Flags: []cmdutil.FlagDef{
			{Name: "server-name", Type: cmdutil.FlagString, Desc: "MCP Server 名称（与 --connection-id 二选一）"},
			{Name: "connection-id", Type: cmdutil.FlagString, Desc: "MCP connection_id（与 --server-name 二选一，适合多 connection 场景）"},
			{Name: "tool-name", Type: cmdutil.FlagString, Required: true, Desc: "工具名称（从 list-tools 获取）"},
			{Name: "arguments", Type: cmdutil.FlagString, Desc: "JSON 格式的参数对象"},
		},
		RunFunc: mcpCallFunc(f),
	})

	return cmd
}

func mcpReadResourceFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		uri, _ := ctx.FlagValues["uri"].(string)
		if uri == "" {
			return fmt.Errorf("必须提供 --uri 参数，用法：tabtin mcp read-resource --uri <uri>")
		}

		body := map[string]any{"uri": uri, "agent_id": ctx.AgentID}
		if serverName, ok := ctx.FlagValues["server-name"].(string); ok && serverName != "" {
			body["server_name"] = serverName
		}

		tr, err := requireCliServerTransport(f, "mcp read-resource")
		if err != nil {
			return err
		}
		resp, err := tr.Request(ctx.ReqContext, "POST", "/mcp/read-resource", body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope("NETWORK_ERROR", err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

func mcpGetPromptFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		promptName, _ := ctx.FlagValues["prompt-name"].(string)
		if promptName == "" {
			return fmt.Errorf("必须提供 --prompt-name 参数，用法：tabtin mcp get-prompt --prompt-name <name>")
		}

		body := map[string]any{"prompt_name": promptName, "agent_id": ctx.AgentID}
		if serverName, ok := ctx.FlagValues["server-name"].(string); ok && serverName != "" {
			body["server_name"] = serverName
		}
		if argsStr, ok := ctx.FlagValues["arguments"].(string); ok && argsStr != "" {
			var args map[string]string
			if err := json.Unmarshal([]byte(argsStr), &args); err != nil {
				return fmt.Errorf("--arguments 必须是合法 JSON: %w", err)
			}
			body["arguments"] = args
		}

		tr, err := requireCliServerTransport(f, "mcp get-prompt")
		if err != nil {
			return err
		}
		resp, err := tr.Request(ctx.ReqContext, "POST", "/mcp/get-prompt", body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope("NETWORK_ERROR", err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}

func mcpCallFunc(f *cmdutil.Factory) func(ctx *cmdutil.RunContext) error {
	return func(ctx *cmdutil.RunContext) error {
		serverName, _ := ctx.FlagValues["server-name"].(string)
		connectionID, _ := ctx.FlagValues["connection-id"].(string)
		toolName, _ := ctx.FlagValues["tool-name"].(string)
		if toolName == "" {
			return fmt.Errorf("必须提供 --tool-name，用法：tabtin mcp call --server-name X --tool-name Y")
		}
		if serverName == "" && connectionID == "" {
			return fmt.Errorf("必须提供 --server-name 或 --connection-id 之一，用法：tabtin mcp call --server-name X --tool-name Y")
		}

		body := map[string]any{
			"tool_name": toolName,
			"agent_id":  ctx.AgentID,
		}
		if connectionID != "" {
			body["connection_id"] = connectionID
		}
		if serverName != "" {
			body["server_name"] = serverName
		}
		if argsStr, ok := ctx.FlagValues["arguments"].(string); ok && argsStr != "" {
			var args map[string]any
			if err := json.Unmarshal([]byte(argsStr), &args); err != nil {
				return fmt.Errorf("--arguments 必须是合法 JSON: %w", err)
			}
			body["arguments"] = args
		}

		tr, err := requireCliServerTransport(f, "mcp call")
		if err != nil {
			return err
		}
		resp, err := tr.Request(ctx.ReqContext, "POST", "/mcp/call", body, nil)
		if err != nil {
			return output.PrintErrorAndExit(output.ErrorEnvelope("NETWORK_ERROR", err.Error(), "", output.ExitNetwork))
		}
		return printTransportResponse(resp, f.Format)
	}
}
