import { beforeEach, describe, expect, it, vi } from 'vitest'

const raw = vi.fn()

vi.mock('./tabtin-client', () => ({
  getApiClient: () => ({ raw }),
}))

import { agentDebugApi } from './agent-debug'

describe('agentDebugApi.getThreadTraces', () => {
  beforeEach(() => {
    raw.mockReset()
    raw.mockResolvedValue({ items: [], next_cursor: null })
  })

  it('使用会话专属路径，避免 thread_id 查询参数丢失', async () => {
    await agentDebugApi.getThreadTraces('chat-session-current')

    expect(raw).toHaveBeenCalledWith(
      'GET',
      '/orchestration/debug/threads/chat-session-current/traces'
    )
  })
})
