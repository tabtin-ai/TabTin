import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { getAttachmentBufferMock } = vi.hoisted(() => ({
  getAttachmentBufferMock: vi.fn(),
}))

vi.mock('../attachmentBlobCache', () => ({
  getAttachmentBuffer: (...args: unknown[]) => getAttachmentBufferMock(...args),
}))

vi.mock('../resolveOssFileAccessUrl', () => ({
  resolveOssFileAccessUrl: vi.fn(async (fileId: string) => `https://oss.example/fresh/${fileId}`),
}))

describe('copyImageToClipboard', () => {
  const originalTabtin = window.tabtin

  beforeEach(() => {
    getAttachmentBufferMock.mockReset()
    vi.unstubAllGlobals()
  })

  afterEach(() => {
    Object.defineProperty(window, 'tabtin', { configurable: true, value: originalTabtin })
  })

  it('writes downloaded image bytes through Electron native clipboard', async () => {
    const pngBytes = new Uint8Array([137, 80, 78, 71]).buffer
    getAttachmentBufferMock.mockResolvedValue(pngBytes)

    const writeMock = vi.fn(async () => ({ success: true }))
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { clipboard: { writeImage: writeMock } },
    })

    const { copyImageToClipboard } = await import('../copyImageToClipboard')
    await copyImageToClipboard({
      url: 'https://oss.example.com/im/photo.png',
      fileId: 'fid-1',
    })

    expect(getAttachmentBufferMock).toHaveBeenCalledWith({
      fileId: 'fid-1',
      url: 'https://oss.example.com/im/photo.png',
      resolveFreshUrl: expect.any(Function),
    })
    expect(writeMock).toHaveBeenCalledWith(pngBytes)
  })
})
