import { describe, expect, it, vi } from 'vitest'
import { createLoginRelayPreloadApi } from '../login-relay'

describe('login relay preload API', () => {
  it('exposes only start, complete, and cancel on fixed IPC channels', async () => {
    const invoke = vi.fn().mockResolvedValue({ success: true })
    const api = createLoginRelayPreloadApi(invoke)

    expect(Object.keys(api)).toEqual(['start', 'complete', 'cancel'])
    await api.start({
      spaceId: 'space-1',
      organizationId: 'org-1',
      domain: 'example.com',
    })
    await api.complete({ relayId: 'relay-1', threadId: 'thread_login_relay_1' })
    await api.cancel({ relayId: 'relay-1' })

    expect(invoke.mock.calls).toEqual([
      ['login-relay:start', {
        spaceId: 'space-1',
        organizationId: 'org-1',
        domain: 'example.com',
      }],
      ['login-relay:complete', { relayId: 'relay-1', threadId: 'thread_login_relay_1' }],
      ['login-relay:cancel', { relayId: 'relay-1' }],
    ])
  })
})
