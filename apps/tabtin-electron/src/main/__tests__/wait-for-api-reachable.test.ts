import { describe, expect, it, vi } from 'vitest'
import { waitForApiReachable } from '../network/wait-for-api-reachable'

describe('waitForApiReachable', () => {
  it('retries transient network failures until the health endpoint is reachable', async () => {
    let now = 0
    const probe = vi
      .fn()
      .mockRejectedValueOnce(new Error('getaddrinfo ENOTFOUND api-test.example.com'))
      .mockRejectedValueOnce(new Error('Client network socket disconnected before secure TLS connection was established'))
      .mockResolvedValueOnce(undefined)

    const result = await waitForApiReachable({
      baseUrl: 'https://api-test.example.com',
      maxWaitMs: 10_000,
      timeoutMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms },
      probe,
    })

    expect(result).toEqual({
      ok: true,
      attempts: 3,
      elapsedMs: 1_500,
    })
    expect(probe).toHaveBeenCalledTimes(3)
    expect(probe.mock.calls[0][0].toString()).toBe('https://api-test.example.com/health')
  })

  it('returns a bounded failure when the API never becomes reachable', async () => {
    let now = 0
    const probe = vi.fn().mockRejectedValue(new Error('health probe timeout after 100ms'))

    const result = await waitForApiReachable({
      baseUrl: 'https://api-test.example.com/api',
      maxWaitMs: 1_200,
      timeoutMs: 100,
      now: () => now,
      sleep: async (ms) => { now += ms },
      probe,
    })

    expect(result.ok).toBe(false)
    expect(result.attempts).toBe(3)
    expect(result.elapsedMs).toBe(1_200)
    expect(result.lastError).toBe('health probe timeout after 100ms')
  })
})
