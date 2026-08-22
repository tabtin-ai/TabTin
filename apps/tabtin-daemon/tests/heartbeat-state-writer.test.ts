import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { HeartbeatService } from '../src/transport/gateway/heartbeat.js'

const originalFetch = globalThis.fetch

describe('Heartbeat state writer integration', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ data: {} }),
    }) as any
  })

  it('fires onHeartbeatSuccess after a successful heartbeat response', async () => {
    const mockGateway = {
      getAccessToken: vi.fn(() => 'token'),
    } as any
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
    const hb = new HeartbeatService(
      {
        server_url: 'http://127.0.0.1:7070',
        organization_id: 'wt-1',
        fingerprint: 'daemon-fp',
      } as any,
      mockGateway,
      {} as any,
      mockLogger as any,
    )
    const onHeartbeatSuccess = vi.fn()
    hb.onHeartbeatSuccess = onHeartbeatSuccess

    await (hb as any).sendHeartbeat()

    expect(onHeartbeatSuccess).toHaveBeenCalledTimes(1)
  })

  it('does not fire onHeartbeatSuccess when heartbeat fails', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
    }) as any
    const mockGateway = {
      getAccessToken: vi.fn(() => 'token'),
    } as any
    const mockLogger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    }
    const hb = new HeartbeatService(
      {
        server_url: 'http://127.0.0.1:7070',
        organization_id: 'wt-1',
        fingerprint: 'daemon-fp',
      } as any,
      mockGateway,
      {} as any,
      mockLogger as any,
    )
    const onHeartbeatSuccess = vi.fn()
    hb.onHeartbeatSuccess = onHeartbeatSuccess

    await (hb as any).sendHeartbeat()

    expect(onHeartbeatSuccess).not.toHaveBeenCalled()
  })
})

afterAll(() => {
  globalThis.fetch = originalFetch
})
