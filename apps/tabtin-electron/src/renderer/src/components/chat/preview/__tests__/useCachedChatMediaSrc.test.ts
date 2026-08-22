import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getCachedChatMediaObjectUrlMock = vi.fn()
const peekCachedChatMediaObjectUrlMock = vi.fn()
const shouldUseChatMediaHttpCacheMock = vi.fn()
const isAttachmentNegativeCachedMock = vi.fn()

vi.mock('../chatMediaHttpCache', () => ({
  getCachedChatMediaObjectUrl: (...args: unknown[]) =>
    getCachedChatMediaObjectUrlMock(...args),
  peekCachedChatMediaObjectUrl: (...args: unknown[]) =>
    peekCachedChatMediaObjectUrlMock(...args),
  shouldUseChatMediaHttpCache: (...args: unknown[]) =>
    shouldUseChatMediaHttpCacheMock(...args),
}))

vi.mock('../attachmentBlobCache', () => ({
  isAttachmentNegativeCached: (...args: unknown[]) =>
    isAttachmentNegativeCachedMock(...args),
}))

const { useCachedChatMediaSrc } = await import('../useCachedChatMediaSrc')

describe('useCachedChatMediaSrc', () => {
  beforeEach(() => {
    getCachedChatMediaObjectUrlMock.mockReset()
    peekCachedChatMediaObjectUrlMock.mockReset()
    shouldUseChatMediaHttpCacheMock.mockReset()
    isAttachmentNegativeCachedMock.mockReset()
    shouldUseChatMediaHttpCacheMock.mockReturnValue(true)
    isAttachmentNegativeCachedMock.mockReturnValue(false)
    peekCachedChatMediaObjectUrlMock.mockReturnValue(null)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('负缓存命中时不进入 resolving，也不再请求 object URL', async () => {
    isAttachmentNegativeCachedMock.mockReturnValue(true)

    const { result } = renderHook(() =>
      useCachedChatMediaSrc({ url: 'https://cdn.example/missing.png' }),
    )

    expect(result.current.resolving).toBe(false)
    expect(result.current.failed).toBe(true)
    expect(result.current.displaySrc).toBe('https://cdn.example/missing.png')
    expect(getCachedChatMediaObjectUrlMock).not.toHaveBeenCalled()
  })

  it('fetch 失败后 failed=true 且 resolving 尽快为 false', async () => {
    getCachedChatMediaObjectUrlMock.mockRejectedValue(new Error('HTTP 404'))

    const { result } = renderHook(() =>
      useCachedChatMediaSrc({ url: 'https://cdn.example/broken.png' }),
    )

    expect(result.current.resolving).toBe(true)

    await waitFor(() => {
      expect(result.current.resolving).toBe(false)
      expect(result.current.failed).toBe(true)
      expect(result.current.displaySrc).toBe('https://cdn.example/broken.png')
    })
  })

  it('成功后 displaySrc 切到 blob 且 failed=false', async () => {
    getCachedChatMediaObjectUrlMock.mockResolvedValue('blob:http://localhost/ok')

    const { result } = renderHook(() =>
      useCachedChatMediaSrc({ url: 'https://cdn.example/ok.png' }),
    )

    await waitFor(() => {
      expect(result.current.resolving).toBe(false)
      expect(result.current.failed).toBe(false)
      expect(result.current.displaySrc).toBe('blob:http://localhost/ok')
    })
  })

  it('effect 依赖不变且已负缓存时，不会反复 setResolving(true)', async () => {
    isAttachmentNegativeCachedMock.mockReturnValue(true)

    const { result, rerender } = renderHook(
      ({ url }) => useCachedChatMediaSrc({ url }),
      { initialProps: { url: 'https://cdn.example/missing.png' } },
    )

    expect(result.current.resolving).toBe(false)

    await act(async () => {
      rerender({ url: 'https://cdn.example/missing.png' })
    })

    expect(result.current.resolving).toBe(false)
    expect(result.current.failed).toBe(true)
    expect(getCachedChatMediaObjectUrlMock).not.toHaveBeenCalled()
  })

  it('LRU 已命中时同步 blob 起步，不进入 resolving', () => {
    peekCachedChatMediaObjectUrlMock.mockReturnValue('blob:http://localhost/cached')

    const { result } = renderHook(() =>
      useCachedChatMediaSrc({
        url: 'https://cdn.example/ok.png',
        fileId: 'fid-1',
      }),
    )

    expect(result.current.resolving).toBe(false)
    expect(result.current.displaySrc).toBe('blob:http://localhost/cached')
    expect(getCachedChatMediaObjectUrlMock).not.toHaveBeenCalled()
  })
})
