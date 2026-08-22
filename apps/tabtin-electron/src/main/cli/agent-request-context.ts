import type { IncomingMessage } from 'node:http'
import { AsyncLocalStorage } from 'node:async_hooks'

export type AgentRequestContextHeaders = Readonly<Record<string, string>>

const agentRequestContext = new AsyncLocalStorage<AgentRequestContextHeaders>()

export function readHeaderString(
  req: IncomingMessage,
  name: string,
): string | undefined {
  const value = req.headers[name.toLowerCase()]
  if (typeof value === 'string' && value.trim()) return value.trim()
  if (Array.isArray(value)) {
    const first = value.find((item) => typeof item === 'string' && item.trim())
    if (first) return first.trim()
  }
  return undefined
}

export function runWithAgentRequestContext<T>(
  headers: AgentRequestContextHeaders,
  callback: () => T,
): T {
  return agentRequestContext.run(headers, callback)
}

export function getAgentRequestContextHeaders(): AgentRequestContextHeaders {
  return agentRequestContext.getStore() ?? {}
}

export function extractAgentThreadId(req: IncomingMessage): string | undefined {
  return readHeaderString(req, 'x-tabtin-session-id')
    || readHeaderString(req, 'x-tabtin-thread-id')
}

export function enrichCodeBodyWithAgentContext(
  body: unknown,
  req: IncomingMessage,
): Record<string, unknown> {
  const record = body && typeof body === 'object' && !Array.isArray(body)
    ? body as Record<string, unknown>
    : {}
  const { _agent_context: _ignoredAgentContext, ...rest } = record
  const sessionId = extractAgentThreadId(req)
  const runId = readHeaderString(req, 'x-tabtin-agent-run-id')
  const toolUseId = readHeaderString(req, 'x-tabtin-tool-use-id')

  return {
    ...rest,
    ...(sessionId && runId && toolUseId
      ? {
          _agent_context: {
            session_id: sessionId,
            run_id: runId,
            tool_use_id: toolUseId,
          },
        }
      : {}),
  }
}
