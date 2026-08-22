import { describe, expect, it, vi } from 'vitest'

const { handleSessionCollaborationEnvelope } = vi.hoisted(() => ({
  handleSessionCollaborationEnvelope: vi.fn(),
}))

vi.mock('./sessionCollaborationEventHandler', () => ({
  handleSessionCollaborationEnvelope,
}))

import { registerBackgroundEventRouter } from './chatApi'

describe('registerBackgroundEventRouter collaboration invalidation', () => {
  it('routes the user-level change envelope to the authoritative reload handler', async () => {
    let listener: ((envelope: Record<string, unknown>) => void) | null = null
    const client = {
      getGateway: () => ({
        addListener: (next: typeof listener) => {
          listener = next
        },
      }),
    }
    registerBackgroundEventRouter(client as never)
    const envelope = {
      type: 'session.collaboration.changed',
      payload: { object_id: 'share-1', version: 3 },
    }

    listener?.(envelope)

    await vi.waitFor(() => {
      expect(handleSessionCollaborationEnvelope).toHaveBeenCalledWith(envelope)
    })
  })
})
