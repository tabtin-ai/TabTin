import { describe, expect, it } from 'vitest'
import { resolveIMCollapsibleMessageKey } from './imCollapsibleMessageKey'

function message(overrides: Record<string, unknown> = {}) {
  return {
    conversation_id: 'conversation-1',
    sender_id: 'user-1',
    id: 42,
    metadata: {},
    ...overrides,
  } as Parameters<typeof resolveIMCollapsibleMessageKey>[0]
}

describe('resolveIMCollapsibleMessageKey', () => {
  it('preserves an optimistic message expansion key after server confirmation', () => {
    const optimistic = message({ id: -1, _tempId: 'request-1' })
    const confirmed = message({
      id: 42,
      metadata: { client_request_id: 'request-1' },
    })

    expect(resolveIMCollapsibleMessageKey(optimistic)).toBe(
      resolveIMCollapsibleMessageKey(confirmed),
    )
  })

  it('isolates equal client request ids across conversations and senders', () => {
    const base = message({ id: -1, _tempId: 'request-1' })

    expect(resolveIMCollapsibleMessageKey(base)).not.toBe(
      resolveIMCollapsibleMessageKey(message({ id: -1, _tempId: 'request-1', conversation_id: 'conversation-2' })),
    )
    expect(resolveIMCollapsibleMessageKey(base)).not.toBe(
      resolveIMCollapsibleMessageKey(message({ id: -1, _tempId: 'request-1', sender_id: 'user-2' })),
    )
  })
})
