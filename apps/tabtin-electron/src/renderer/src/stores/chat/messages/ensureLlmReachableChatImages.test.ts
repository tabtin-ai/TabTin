import { afterEach, describe, expect, it, vi } from 'vitest'

const getAttachmentBufferMock = vi.fn()

vi.mock('@/components/chat/preview/attachmentBlobCache', () => ({
  getAttachmentBuffer: (...args: unknown[]) => getAttachmentBufferMock(...args),
}))

const { ensureLlmReachableChatImages } = await import('./ensureLlmReachableChatImages')

afterEach(() => {
  getAttachmentBufferMock.mockReset()
})

function makePngFile(bytes = new Uint8Array([1, 2, 3, 4])): File {
  const file = new File([bytes], 'a.png', { type: 'image/png' })
  // happy-dom / 部分 jsdom 的 File 没有 arrayBuffer，补齐与浏览器一致
  if (typeof file.arrayBuffer !== 'function') {
    Object.defineProperty(file, 'arrayBuffer', {
      configurable: true,
      value: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
    })
  }
  return file
}

function makeReadyImage(overrides: Partial<{
  remoteUrl: string
  file: File
  size: number
}> = {}) {
  const file = overrides.file ?? makePngFile()
  return {
    id: 'att-1',
    file,
    filename: 'a.png',
    mimeType: 'image/png',
    size: overrides.size ?? file.size,
    type: 'image' as const,
    status: 'ready' as const,
    remoteUrl: overrides.remoteUrl ?? 'http://127.0.0.1:6060/api/services/oss/local-object/x',
    previewUrl: undefined,
  }
}

describe('ensureLlmReachableChatImages', () => {
  it('公网 URL 原样保留', async () => {
    const att = makeReadyImage({ remoteUrl: 'https://cdn.example/a.png' })
    const out = await ensureLlmReachableChatImages([att])
    expect(out[0].remoteUrl).toBe('https://cdn.example/a.png')
    expect(getAttachmentBufferMock).not.toHaveBeenCalled()
  })

  it('受信本机 OSS URL 原样保留（交服务端直读转 base64，）', async () => {
    const att = makeReadyImage({ remoteUrl: 'http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png' })
    const out = await ensureLlmReachableChatImages([att])
    expect(out[0].remoteUrl).toBe('http://127.0.0.1:6060/api/services/oss/local-object?object_key=chat%2Fa.png')
    expect(getAttachmentBufferMock).not.toHaveBeenCalled()
  })

  it('非 OSS 的不可达本机 URL + 本地 File → data:（保留 File 兜底）', async () => {
    const att = makeReadyImage({ remoteUrl: 'http://127.0.0.1:9999/tmp/x.png' })
    const out = await ensureLlmReachableChatImages([att])
    expect(out[0].remoteUrl?.startsWith('data:image/png;base64,')).toBe(true)
    expect(out[0].remoteUrl).not.toContain('127.0.0.1')
    expect(getAttachmentBufferMock).not.toHaveBeenCalled()
  })

  it('data: 已就绪则不改', async () => {
    const att = makeReadyImage({ remoteUrl: 'data:image/png;base64,AAAA' })
    const out = await ensureLlmReachableChatImages([att])
    expect(out[0].remoteUrl).toBe('data:image/png;base64,AAAA')
  })
})
