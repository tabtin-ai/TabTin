import { describe, expect, it, vi } from 'vitest'
import {
  createApiClient,
  RefreshLock,
  RefreshTemporarilyUnavailableError,
} from '@tabtin/api-client'

describe('shared API client refresh semantics', () => {
  it('keeps the session when delegated refresh is temporarily unavailable', async () => {
    const onUnauthorized = vi.fn()
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetch as typeof globalThis.fetch,
      onUnauthorized,
      refresh: {
        getRefreshToken: () => ({ delegateToMain: true }),
        onRefreshToken: async () => {
          throw new RefreshTemporarilyUnavailableError()
        },
        onRefreshFailed: vi.fn(),
      },
    })

    await expect(client.raw('GET', '/private')).rejects.toMatchObject({ status: 401 })
    expect(onUnauthorized).not.toHaveBeenCalled()
  })

  it('invalidates the session when a refreshed request is still unauthorized', async () => {
    const onUnauthorized = vi.fn()
    const fetch = vi.fn(async () => new Response('{}', { status: 401 }))
    const client = createApiClient({
      baseUrl: 'https://api.example.test',
      fetch: fetch as typeof globalThis.fetch,
      onUnauthorized,
      refresh: {
        getRefreshToken: () => 'refresh-token',
        onRefreshToken: async () => ({ access_token: 'fresh-access', refresh_token: 'fresh-refresh' }),
        onRefreshFailed: vi.fn(),
      },
    })

    await expect(client.raw('GET', '/private')).rejects.toMatchObject({ status: 401 })
    expect(fetch).toHaveBeenCalledTimes(2)
    expect(onUnauthorized).toHaveBeenCalledTimes(1)
  })

  it('single-flights concurrent delegated refresh requests', async () => {
    let resolveRefresh!: (value: { access_token: string; refresh_token: string }) => void
    const refresh = vi.fn(() => new Promise<{ access_token: string; refresh_token: string }>((resolve) => {
      resolveRefresh = resolve
    }))
    const lock = new RefreshLock({
      getRefreshToken: () => ({ delegateToMain: true }),
      onRefreshToken: refresh,
    })

    const first = lock.acquire()
    const second = lock.acquire()
    await Promise.resolve()
    expect(refresh).toHaveBeenCalledTimes(1)
    resolveRefresh({ access_token: 'fresh-access', refresh_token: '' })
    await expect(Promise.all([first, second])).resolves.toEqual(['fresh-access', 'fresh-access'])
  })
})
