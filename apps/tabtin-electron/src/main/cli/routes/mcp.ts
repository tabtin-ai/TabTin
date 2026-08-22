/**
 * MCP route handler for CLI Server.
 *
 * Delegates MCP discovery and invocation requests from the `tabtin mcp` CLI
 * to the LocalMcpService singleton. Requires an explicit Agent context.
 *
 * Go CLI sends GET requests with parameters in query string (not body),
 * so we merge query params into the effective params for selector resolution.
 */

import type http from 'node:http'
import { getLocalMcpService } from '../../services/LocalMcpService.js'

type SendJSON = (res: http.ServerResponse, status: number, body: unknown) => void

function ok(data: unknown) {
  return { ok: true, data }
}

function errResp(code: string, message: string) {
  return { ok: false, error: { code, message } }
}

export async function handleMcpRoute(
  url: string,
  _method: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): Promise<void> {
  const mcpService = getLocalMcpService()

  const qIdx = url.indexOf('?')
  const pathname = qIdx >= 0 ? url.slice(0, qIdx) : url
  const route = pathname.replace(/^\/mcp/, '')

  const queryParams = qIdx >= 0 ? Object.fromEntries(new URLSearchParams(url.slice(qIdx))) : {}
  const params = { ...queryParams, ...(body ?? {}) }
  const agentId = typeof params.agent_id === 'string' ? params.agent_id.trim() : ''
  if (!agentId) {
    sendJSON(res, 400, errResp('NO_AGENT_CONTEXT', '当前无 Agent 上下文。请先选择 Agent，或传入 --agent-id。'))
    return
  }

  try {
    const selector = selectorFromParams(params)

    if (route === '/servers') {
      const servers = mcpService.listAttachedServers(agentId)
      sendJSON(res, 200, ok({ servers }))
      return
    }

    if (route === '/tools') {
      const servers = await mcpService.listAttachedTools(agentId, selector)
      sendJSON(res, 200, ok({ servers }))
      return
    }

    if (route === '/resources') {
      const servers = await mcpService.listAttachedResources(agentId, selector)
      sendJSON(res, 200, ok({ servers }))
      return
    }

    if (route === '/prompts') {
      const servers = await mcpService.listAttachedPrompts(agentId, selector)
      sendJSON(res, 200, ok({ servers }))
      return
    }

    if (route === '/read-resource') {
      const uri = params.uri
      if (!uri || typeof uri !== 'string') {
        sendJSON(res, 400, errResp('VALIDATION_ERROR', '必须提供 uri 参数'))
        return
      }
      const result = await mcpService.readResource(agentId, selector ?? {}, uri)
      sendJSON(res, 200, ok(result))
      return
    }

    if (route === '/get-prompt') {
      const promptName = params.prompt_name
      if (!promptName || typeof promptName !== 'string') {
        sendJSON(res, 400, errResp('VALIDATION_ERROR', '必须提供 prompt_name 参数'))
        return
      }
      let args: Record<string, string> | undefined
      if (typeof params.arguments === 'string') {
        try {
          args = JSON.parse(params.arguments) as Record<string, string>
        } catch {
          sendJSON(res, 400, errResp('VALIDATION_ERROR', 'arguments 不是合法的 JSON 字符串'))
          return
        }
      } else {
        args = params.arguments as Record<string, string> | undefined
      }
      const result = await mcpService.getPrompt(
        agentId,
        selector ?? {},
        promptName,
        args,
      )
      sendJSON(res, 200, ok(result))
      return
    }

    if (route === '/call') {
      const toolName = params.tool_name
      if (!toolName || typeof toolName !== 'string') {
        sendJSON(res, 400, errResp('VALIDATION_ERROR', '必须提供 tool_name 参数'))
        return
      }
      // L7：mcp_call_tool FC schema 接受 server_name OR connection_id 二选一，
      // CLI route 用同一 selectorFromParams 提取（已优先 connection_id），
      // 二者都缺时按"未指定 server"拒绝，与 LocalMcpService.callTool 的契约对齐。
      const callSelector = selectorFromParams(params)
      if (!callSelector) {
        sendJSON(res, 400, errResp('VALIDATION_ERROR', '必须提供 server_name 或 connection_id 之一'))
        return
      }
      let args: Record<string, unknown> | undefined
      if (typeof params.arguments === 'string') {
        try {
          args = JSON.parse(params.arguments) as Record<string, unknown>
        } catch {
          sendJSON(res, 400, errResp('VALIDATION_ERROR', 'arguments 不是合法的 JSON 字符串'))
          return
        }
      } else {
        args = params.arguments as Record<string, unknown> | undefined
      }
      const result = await mcpService.callTool(
        agentId,
        callSelector,
        toolName,
        args,
      )
      sendJSON(res, 200, ok(result))
      return
    }

    sendJSON(res, 404, errResp('UNKNOWN_ROUTE', `未知的 mcp 命令: /mcp${route}`))
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error)
    sendJSON(res, 500, errResp('MCP_ERROR', msg))
  }
}

function selectorFromParams(
  params: Record<string, unknown>,
): { serverName?: string; connectionId?: string } | undefined {
  const connId = params.connection_id
  if (connId && typeof connId === 'string') return { connectionId: connId }
  const srvName = params.server_name
  if (srvName && typeof srvName === 'string') return { serverName: srvName }
  return undefined
}
