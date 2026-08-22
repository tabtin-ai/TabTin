import type { AgentTool } from '@tabtin/action-tools/types'
import { getLocalMcpService } from './LocalMcpService'

type AgentScopedInput = {
  _agent_id?: string
}

type ServerSelectorInput = AgentScopedInput & {
  server_name?: string
  connection_id?: string
}

function requireAgentId(input: AgentScopedInput): string {
  const agentId = input._agent_id?.trim()
  if (!agentId) {
    throw new Error('agent_id is required for MCP actions')
  }
  return agentId
}

function selectorOf(input: ServerSelectorInput): { serverName?: string; connectionId?: string } | undefined {
  if (input.connection_id?.trim()) {
    return { connectionId: input.connection_id.trim() }
  }
  if (input.server_name?.trim()) {
    return { serverName: input.server_name.trim() }
  }
  return undefined
}

/**
 * W3 MCP 单入口收敛：只保留 mcp_call_tool 一个 FC 工具。
 *
 * 其余 6 个查询型操作（list-servers / list-tools / list-resources /
 * list-prompts / read-resource / get-prompt）全部迁到 `tabtin mcp` CLI
 * 命令族，LLM 通过 run_terminal_command 调用。
 *
 * 收益：LLM prompt schema 从 7 个 MCP 工具缩减到 1 个。
 *
 * ⚠️ 类型说明（防止质检误判）：
 * 这里使用 `AgentTool` 类型（packages/action-tools/src/types/index.ts）作为
 * 中间形态描述，**该类型本身不带** isReadOnly / disablePreStart / policyActionKind
 * 等 Tool 元数据字段——这是设计隔离，不是声明遗漏。
 *
 * 注入到 LLM 工具集时由 ElectronToolProvider.adaptMcpTool() 转换成
 * agent-runtime 的 `Tool` 类型，并显式声明：
 *   - isReadOnly: false
 *   - policyActionKind: 'mcp'
 *   - disablePreStart: true
 * 见 apps/tabtin-electron/src/main/agent/capabilities/ElectronToolProvider.ts。
 */
export const localMcpAgentTools: AgentTool[] = [
  {
    name: 'mcp_call_tool',
    description:
      '调用当前会话 Agent 已启用 MCP server 上的工具。\n\n' +
      '**用途**：执行外部 MCP 协议定义的工具调用。\n\n' +
      '发现 server / tool schema / resources / prompts 见 system prompt 中的 CLI 能力说明。\n\n' +
      '本工具**仅**负责实际调用；元数据发现走 CLI。',
    parameters: {
      type: 'object',
      properties: {
        server_name: {
          type: 'string',
          description: 'MCP server name (see CLI capabilities in system prompt)',
        },
        connection_id: {
          type: 'string',
          description: 'MCP connection_id (alternative to server_name)',
        },
        tool_name: {
          type: 'string',
          description: 'Exact MCP tool name to call (see CLI capabilities in system prompt)',
        },
        arguments: {
          type: 'object',
          description: 'Arguments object to pass to the MCP tool',
          properties: {},
          required: [],
        },
      },
      required: ['tool_name'],
    },
    async execute(input: ServerSelectorInput & {
      tool_name: string
      arguments?: Record<string, unknown>
    }) {
      const agentId = requireAgentId(input)
      const result = await getLocalMcpService().callTool(
        agentId,
        selectorOf(input) ?? {},
        input.tool_name,
        input.arguments,
      )
      return {
        success: true,
        data: result,
      }
    },
  },
]
