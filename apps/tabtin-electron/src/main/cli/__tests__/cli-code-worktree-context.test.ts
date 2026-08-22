import type http from 'node:http'
import { describe, expect, it } from 'vitest'
import { enrichCodeBodyWithAgentContext } from '../agent-request-context'

function request(headers: Record<string, string>): http.IncomingMessage {
  return { headers } as http.IncomingMessage
}

describe('CLI code worktree Agent context', () => {
  it('丢弃 body 伪造身份，只采用运行时注入的三个 header', () => {
    const result = enrichCodeBodyWithAgentContext(
      {
        path: '/repo/wt',
        _agent_context: {
          session_id: 'forged-session',
          run_id: 'forged-run',
          tool_use_id: 'forged-tool',
        },
      },
      request({
        'x-tabtin-session-id': 'session-1',
        'x-tabtin-agent-run-id': 'run-1',
        'x-tabtin-tool-use-id': 'tool-1',
      }),
    )

    expect(result).toEqual({
      path: '/repo/wt',
      _agent_context: {
        session_id: 'session-1',
        run_id: 'run-1',
        tool_use_id: 'tool-1',
      },
    })
  })

  it('任一可信 header 缺失时不构造 Agent context', () => {
    const result = enrichCodeBodyWithAgentContext(
      {
        path: '/repo/wt',
        _agent_context: { session_id: 'forged' },
      },
      request({
        'x-tabtin-session-id': 'session-1',
        'x-tabtin-agent-run-id': 'run-1',
      }),
    )

    expect(result).toEqual({ path: '/repo/wt' })
  })
})
