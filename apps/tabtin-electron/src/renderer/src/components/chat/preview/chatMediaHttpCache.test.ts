import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getAttachmentBufferMock = vi.fn()

vi.mock('./attachmentBlobCache', () => ({
  getAttachmentBuffer: (...args: unknown[]) => getAttachmentBufferMock(...args),
}))

vi.mock('./resolveOssFileAccessUrl', () => ({
  resolveOssFileAccessUrl: vi.fn(async (fileId: string) => `https://fresh.example/${fileId}`),
}))

const {
  getCachedChatMediaObjectUrl,
  shouldUseChatMediaHttpCache,
  _clearChatMediaHttpCache,
} = await import('./chatMediaHttpCache')

function fakeBuffer(text: string): ArrayBuffer {
  return new TextEncoder().encode(text).buffer
}

describe('chatMediaHttpCache', () => {
  beforeEach(() => {
    getAttachmentBufferMock.mockReset()
    _clearChatMediaHttpCache()
  })

  afterEach(() => {
    _clearChatMediaHttpCache()
  })

  it('data:/blob: 直通，不拉远程', async () => {
    expect(shouldUseChatMediaHttpCache('data:image/png;base64,AA')).toBe(false)
    const blobUrl = URL.createObjectURL(new Blob(['x']))
    expect(shouldUseChatMediaHttpCache(blobUrl)).toBe(false)
    await expect(getCachedChatMediaObjectUrl({ url: 'data:image/png;base64,AA' }))
      .resolves.toBe('data:image/png;base64,AA')
    expect(getAttachmentBufferMock).not.toHaveBeenCalled()
    URL.revokeObjectURL(blobUrl)
  })

  it('http URL 首次拉取并缓存 object URL', async () => {
    getAttachmentBufferMock.mockResolvedValue(fakeBuffer('img-bytes'))
    const url = 'https://cdn.example/chat/a.png'

    const first = await getCachedChatMediaObjectUrl({ url, fileId: 'fid-1', mimeType: 'image/png' })
    const second = await getCachedChatMediaObjectUrl({ url, fileId: 'fid-1', mimeType: 'image/png' })

    expect(first).toMatch(/^blob:/)
    expect(second).toBe(first)
    expect(getAttachmentBufferMock).toHaveBeenCalledTimes(1)
    expect(getAttachmentBufferMock).toHaveBeenCalledWith({
      fileId: 'fid-1',
      url,
      resolveFreshUrl: expect.any(Function),
    })
  })

  it('同一 file_id 换 URL 仍命中缓存', async () => {
    getAttachmentBufferMock.mockResolvedValue(fakeBuffer('same'))
    const first = await getCachedChatMediaObjectUrl({
      fileId: 'fid-stable',
      url: 'https://cdn.example/old?sig=1',
      mimeType: 'image/png',
    })
    const second = await getCachedChatMediaObjectUrl({
      fileId: 'fid-stable',
      url: 'https://cdn.example/new?sig=2',
      mimeType: 'image/png',
    })
    expect(second).toBe(first)
    expect(getAttachmentBufferMock).toHaveBeenCalledTimes(1)
  })
})
