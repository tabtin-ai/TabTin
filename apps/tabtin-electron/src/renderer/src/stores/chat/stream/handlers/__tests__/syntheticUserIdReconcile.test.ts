import { beforeEach, describe, expect, it, vi } from 'vitest'

const messages: Array<{ id: string; role: string; metadata?: Record<string, unknown>; client_event_id?: string }> = []
const rebindMessageIds = vi.fn()
const linkServerMessageId = vi.fn()

vi.mock('@/services/agentService/sessionMessages', () => ({
  getSessionMessagesFacade: () => ({ getMessages: () => messages }),
}))

vi.mock('../../../shared/storeAccessRegistry', () => ({
  getChatStoreCallbacks: () => ({ rebindMessageIds, linkServerMessageId }),
}))

import { reconcilePersistedMessageIds } from '../syntheticUserIdReconcile'

const SID = 's1'

describe('reconcilePersistedMessageIds', () => {
  beforeEach(() => {
    messages.length = 0
    rebindMessageIds.mockClear()
    linkServerMessageId.mockClear()
  })

  it('synthetic user：client_event_id 收敛为 server_id（rebind）', () => {
    messages.push(
      { id: 'main-prompt', role: 'user', metadata: { client_event_id: 'main-1' } },
      { id: 'push-1', role: 'user', metadata: { client_event_id: 'push-1', triggered_by: 'push-notification' } },
    )
    reconcilePersistedMessageIds(SID, {
      type: 'agent.stream.message_persisted',
      payload: { message_ids: [{ client_event_id: 'push-1', server_id: 'server-1' }] },
    })
    // 只重绑命中 ACK 的 synthetic（push-1），不碰主 prompt。
    expect(rebindMessageIds).toHaveBeenCalledWith(SID, [['push-1', 'server-1']])
    expect(linkServerMessageId).not.toHaveBeenCalled()
  })

  it('runtime local-* assistant：只 link metadata.message_id，不改壳 id', () => {
    messages.push({
      id: 'local-abc-1',
      role: 'assistant',
      client_event_id: 'local-abc-1',
    })
    reconcilePersistedMessageIds(SID, {
      type: 'agent.stream.message_persisted',
      payload: { message_ids: [{ client_event_id: 'local-abc-1', server_id: 'server-uuid-2' }] },
    })
    expect(linkServerMessageId).toHaveBeenCalledWith(SID, 'local-abc-1', 'server-uuid-2')
    expect(rebindMessageIds).not.toHaveBeenCalled()
  })

  it('无 message_ids 时 no-op', () => {
    reconcilePersistedMessageIds(SID, { type: 'agent.stream.message_persisted', payload: {} })
    expect(rebindMessageIds).not.toHaveBeenCalled()
    expect(linkServerMessageId).not.toHaveBeenCalled()
  })

  it('id 已等于 server_id 时不产生重绑对', () => {
    messages.push({ id: 'server-1', role: 'user', metadata: { client_event_id: 'push-1', source: 'skill_invoke' } })
    reconcilePersistedMessageIds(SID, {
      type: 'agent.stream.message_persisted',
      payload: { message_ids: [{ client_event_id: 'push-1', server_id: 'server-1' }] },
    })
    expect(rebindMessageIds).not.toHaveBeenCalled()
    expect(linkServerMessageId).not.toHaveBeenCalled()
  })
})
