import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const apiRequest = vi.hoisted(() => vi.fn())
const unwrapData = vi.hoisted(() => vi.fn())
const authState = vi.hoisted(() => ({ userId: 'user-a' as string | null }))
const resetRegistration = vi.hoisted(() => ({
  action: undefined as (() => void) | undefined,
}))

vi.mock('@/services/apiBase', () => ({
  apiRequest: (...args: unknown[]) => apiRequest(...args),
  unwrapData: (...args: unknown[]) => unwrapData(...args),
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: {
    getState: () => ({ user: { id: authState.userId } }),
  },
}))

vi.mock('@/stores/sessionResetRegistry', () => ({
  registerResetAction: (
    _id: string,
    _phase: string,
    action: () => void,
  ) => {
    resetRegistration.action = action
  },
}))

import {
  _clearOssFileAccessUrlCache,
  resolveOssFileAccessUrl,
} from './resolveOssFileAccessUrl'

describe('resolveOssFileAccessUrl cache expiry', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-31T10:00:00.000Z'))
    vi.clearAllMocks()
    authState.userId = 'user-a'
    _clearOssFileAccessUrlCache()
    apiRequest.mockResolvedValue({})
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('reuses a signed URL before its refresh window', async () => {
    unwrapData.mockResolvedValue({
      file_id: 'file-1',
      file_name: 'demo.pdf',
      access_url: 'https://oss.example/signed-1',
      cdn_url: '',
      resolved_url: 'https://oss.example/signed-1',
      expires_at: '2026-07-31T16:00:00.000Z',
      expires_in: 21_600,
    })

    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/signed-1')
    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/signed-1')

    expect(apiRequest).toHaveBeenCalledTimes(1)
  })

  it('does not reuse a signed URL after the authenticated user changes', async () => {
    unwrapData
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/user-a',
        resolved_url: 'https://oss.example/user-a',
        expires_in: 21_600,
      })
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/user-b',
        resolved_url: 'https://oss.example/user-b',
        expires_in: 21_600,
      })

    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/user-a')
    authState.userId = 'user-b'
    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/user-b')

    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('does not cache file access URLs before the authenticated user is known', async () => {
    authState.userId = null
    unwrapData
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/anonymous-1',
        resolved_url: 'https://oss.example/anonymous-1',
        expires_in: 21_600,
      })
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/anonymous-2',
        resolved_url: 'https://oss.example/anonymous-2',
        expires_in: 21_600,
      })

    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/anonymous-1')
    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/anonymous-2')

    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('requests a fresh URL during the final minute before expiry', async () => {
    unwrapData
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/signed-1',
        cdn_url: '',
        resolved_url: 'https://oss.example/signed-1',
        expires_at: '2026-07-31T10:06:00.000Z',
        expires_in: 360,
      })
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/signed-2',
        cdn_url: '',
        resolved_url: 'https://oss.example/signed-2',
        expires_at: '2026-07-31T16:05:00.000Z',
        expires_in: 21_600,
      })

    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/signed-1')
    vi.setSystemTime(new Date('2026-07-31T10:05:00.000Z'))
    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/signed-2')

    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('can force a refresh after an OSS fetch failure', async () => {
    unwrapData
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/signed-1',
        cdn_url: '',
        resolved_url: 'https://oss.example/signed-1',
        expires_at: '2026-07-31T16:00:00.000Z',
        expires_in: 21_600,
      })
      .mockResolvedValueOnce({
        file_id: 'file-1',
        file_name: 'demo.pdf',
        access_url: 'https://oss.example/signed-2',
        cdn_url: '',
        resolved_url: 'https://oss.example/signed-2',
        expires_at: '2026-07-31T16:01:00.000Z',
        expires_in: 21_600,
      })

    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/signed-1')
    await expect(resolveOssFileAccessUrl('file-1', { forceRefresh: true }))
      .resolves.toBe('https://oss.example/signed-2')

    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('deduplicates concurrent forced refreshes for the same user and file', async () => {
    let resolveFresh!: (value: unknown) => void
    unwrapData.mockReturnValueOnce(new Promise(resolve => { resolveFresh = resolve }))

    const first = resolveOssFileAccessUrl('file-1', { forceRefresh: true })
    const second = resolveOssFileAccessUrl('file-1', { forceRefresh: true })
    await Promise.resolve()
    expect(apiRequest).toHaveBeenCalledTimes(1)

    resolveFresh({
      file_id: 'file-1',
      file_name: 'demo.pdf',
      access_url: 'https://oss.example/signed-1',
      resolved_url: 'https://oss.example/signed-1',
      expires_in: 21_600,
    })

    await expect(Promise.all([first, second])).resolves.toEqual([
      'https://oss.example/signed-1',
      'https://oss.example/signed-1',
    ])
  })

  it('prevents a pre-reset request from refilling cache or deleting the new request', async () => {
    let resolveOld!: (value: unknown) => void
    let resolveNew!: (value: unknown) => void
    unwrapData
      .mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve }))
      .mockReturnValueOnce(new Promise(resolve => { resolveNew = resolve }))

    const oldRequest = resolveOssFileAccessUrl('file-1')
    await Promise.resolve()
    resetRegistration.action?.()
    const newRequest = resolveOssFileAccessUrl('file-1')
    await Promise.resolve()

    resolveOld({
      file_id: 'file-1',
      file_name: 'old.pdf',
      access_url: 'https://oss.example/old',
      resolved_url: 'https://oss.example/old',
      expires_in: 21_600,
    })
    await expect(oldRequest).resolves.toBe('https://oss.example/old')

    const joinedNewRequest = resolveOssFileAccessUrl('file-1')
    expect(apiRequest).toHaveBeenCalledTimes(2)
    resolveNew({
      file_id: 'file-1',
      file_name: 'new.pdf',
      access_url: 'https://oss.example/new',
      resolved_url: 'https://oss.example/new',
      expires_in: 21_600,
    })

    await expect(Promise.all([newRequest, joinedNewRequest])).resolves.toEqual([
      'https://oss.example/new',
      'https://oss.example/new',
    ])
    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/new')
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })

  it('does not let an older in-flight request overwrite a forced refresh', async () => {
    let resolveOld!: (value: unknown) => void
    let resolveFresh!: (value: unknown) => void
    const oldDetail = new Promise(resolve => { resolveOld = resolve })
    const freshDetail = new Promise(resolve => { resolveFresh = resolve })
    unwrapData
      .mockReturnValueOnce(oldDetail)
      .mockReturnValueOnce(freshDetail)

    const oldRequest = resolveOssFileAccessUrl('file-1')
    await Promise.resolve()
    const forcedRequest = resolveOssFileAccessUrl('file-1', { forceRefresh: true })
    await Promise.resolve()

    resolveFresh({
      file_id: 'file-1',
      file_name: 'demo.pdf',
      access_url: 'https://oss.example/signed-2',
      cdn_url: '',
      resolved_url: 'https://oss.example/signed-2',
      expires_at: '2026-07-31T16:00:00.000Z',
      expires_in: 21_600,
    })
    await expect(forcedRequest).resolves.toBe('https://oss.example/signed-2')

    resolveOld({
      file_id: 'file-1',
      file_name: 'demo.pdf',
      access_url: 'https://oss.example/signed-1',
      cdn_url: '',
      resolved_url: 'https://oss.example/signed-1',
      expires_at: '2026-07-31T16:00:00.000Z',
      expires_in: 21_600,
    })
    await expect(oldRequest).resolves.toBe('https://oss.example/signed-1')
    await expect(resolveOssFileAccessUrl('file-1')).resolves.toBe('https://oss.example/signed-2')
    expect(apiRequest).toHaveBeenCalledTimes(2)
  })
})
