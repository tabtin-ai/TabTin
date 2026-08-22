/**
 * Regression tests for useCollabVersionHistory
 *
 * E-14: auto-fetch on mount / enabled change
 * R-08: restoreFromHistory returns structured result for caller to gate collab reconnect
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useCollabVersionHistory } from '../useCollabVersionHistory'

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: { accessToken: string }) => unknown) =>
    selector({ accessToken: 'test-token' }),
}))

vi.mock('@/config/api', () => ({
  API_BASE_URL: 'https://api.test',
}))

const VERSIONS_RESPONSE = {
  status: 'ok',
  data: [
    { id: 'v1', is_snapshot: true, editor_type: 'user', editor_id: 'u1', created_at: '2025-01-01T00:00:00Z' },
    { id: 'v2', is_snapshot: false, editor_type: 'agent', editor_id: 'a1', created_at: '2025-01-02T00:00:00Z' },
  ],
}

let fetchMock: ReturnType<typeof vi.fn>

beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(VERSIONS_RESPONSE),
    text: () => Promise.resolve(''),
  })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('E-14: auto-fetch on mount when enabled', () => {
  it('fetches version history automatically when resourceId and enabled are truthy', async () => {
    const { result } = renderHook(() =>
      useCollabVersionHistory({ resourceType: 'canvas', resourceId: 'c-123', enabled: true }),
    )

    await waitFor(() => {
      expect(result.current.histories).toHaveLength(2)
    })

    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/collab/v1/canvas/c-123/versions?limit=50'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer test-token' }) }),
    )
  })

  it('does NOT auto-fetch when enabled is false', async () => {
    renderHook(() =>
      useCollabVersionHistory({ resourceType: 'canvas', resourceId: 'c-123', enabled: false }),
    )

    // Wait a tick to confirm no fetch is made
    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('does NOT auto-fetch when resourceId is null', async () => {
    renderHook(() =>
      useCollabVersionHistory({ resourceType: 'canvas', resourceId: null, enabled: true }),
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('auto-fetches when enabled transitions from false to true', async () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useCollabVersionHistory({ resourceType: 'canvas', resourceId: 'c-456', enabled }),
      { initialProps: { enabled: false } },
    )

    await new Promise((r) => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()

    rerender({ enabled: true })

    await waitFor(() => {
      expect(result.current.histories).toHaveLength(2)
    })
    expect(fetchMock).toHaveBeenCalled()
  })
})

describe('R-08: restoreFromHistory result structure', () => {
  it('returns { success: true } on successful restore', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/restore')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ status: 'ok' }),
          text: () => Promise.resolve(''),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(VERSIONS_RESPONSE),
        text: () => Promise.resolve(''),
      })
    })

    const { result } = renderHook(() =>
      useCollabVersionHistory({ resourceType: 'canvas', resourceId: 'c-123', enabled: true }),
    )

    let restoreResult: { success: boolean; error?: string } | undefined
    await act(async () => {
      restoreResult = await result.current.restoreFromHistory('v1')
    })

    expect(restoreResult?.success).toBe(true)
    expect(result.current.restoringVersion).toBeNull()
  })

  it('returns { success: false } on HTTP error', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/restore')) {
        return Promise.resolve({
          ok: false,
          status: 500,
          json: () => Promise.resolve({}),
          text: () => Promise.resolve('Internal Server Error'),
        })
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(VERSIONS_RESPONSE),
        text: () => Promise.resolve(''),
      })
    })

    const { result } = renderHook(() =>
      useCollabVersionHistory({ resourceType: 'canvas', resourceId: 'c-123', enabled: true }),
    )

    let restoreResult: { success: boolean; error?: string } | undefined
    await act(async () => {
      restoreResult = await result.current.restoreFromHistory('v1')
    })

    expect(restoreResult?.success).toBe(false)
    expect(restoreResult?.error).toBeTruthy()
    expect(result.current.restoringVersion).toBeNull()
  })

  it('returns { success: false } on network error', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.includes('/restore')) {
        return Promise.reject(new Error('Network failed'))
      }
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(VERSIONS_RESPONSE),
        text: () => Promise.resolve(''),
      })
    })

    const { result } = renderHook(() =>
      useCollabVersionHistory({ resourceType: 'canvas', resourceId: 'c-123', enabled: true }),
    )

    let restoreResult: { success: boolean; error?: string } | undefined
    await act(async () => {
      restoreResult = await result.current.restoreFromHistory('v1')
    })

    expect(restoreResult?.success).toBe(false)
    expect(restoreResult?.error).toBe('Network failed')
  })
})
