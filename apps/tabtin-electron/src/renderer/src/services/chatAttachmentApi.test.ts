import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatAttachment } from '../components/chat/types'

const { mockDirectUpload, mockPrimeAttachmentBuffer } = vi.hoisted(() => ({
  mockDirectUpload: vi.fn(),
  mockPrimeAttachmentBuffer: vi.fn(),
}))

vi.mock('./oss-direct-uploader', () => ({
  directUpload: mockDirectUpload,
  UploadAbortedError: class UploadAbortedError extends Error {},
}))

vi.mock('../components/chat/preview/attachmentBlobCache', () => ({
  primeAttachmentBuffer: mockPrimeAttachmentBuffer,
}))

vi.mock('@/utils/logger', () => ({
  logger: {
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
  createLogger: () => ({
    log: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

import { uploadChatAttachment } from './chatAttachmentApi'

const MB = 1024 * 1024

function makeFile(name: string, type: string, size: number): File {
  return new File([new Uint8Array(size)], name, { type, lastModified: 123 })
}

function makeImageAttachment(file: File): ChatAttachment {
  return {
    id: 'att-1',
    file,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    type: 'image',
    status: 'pending',
  }
}

function installCanvasMocks(options: {
  width?: number
  height?: number
  outputSize?: number
  failDecode?: boolean
}) {
  vi.stubGlobal('createImageBitmap', vi.fn(async () => {
    if (options.failDecode) throw new Error('decode failed')
    return {
      width: options.width ?? 4000,
      height: options.height ?? 2000,
      close: vi.fn(),
    }
  }))

  class MockOffscreenCanvas {
    width: number
    height: number

    constructor(width: number, height: number) {
      this.width = width
      this.height = height
    }

    getContext() {
      return { drawImage: vi.fn() }
    }

    async convertToBlob(encodeOptions?: ImageEncodeOptions) {
      return new Blob([new Uint8Array(options.outputSize ?? 512 * 1024)], {
        type: encodeOptions?.type ?? 'image/jpeg',
      })
    }
  }

  vi.stubGlobal('OffscreenCanvas', MockOffscreenCanvas)
}

describe('uploadChatAttachment', () => {
  beforeEach(() => {
    vi.unstubAllGlobals()
    vi.clearAllMocks()
    mockDirectUpload.mockImplementation(async (file: File, fileName: string) => ({
      fileId: 'file-1',
      fileName,
      fileKey: `chat/attachments/${fileName}`,
      fileSize: file.size,
      accessUrl: 'https://oss.example/access',
      cdnUrl: 'https://cdn.example/file',
    }))
  })

  it('图片上传到 OSS 前会先使用压缩后的 File', async () => {
    installCanvasMocks({ width: 4000, height: 2000, outputSize: 512 * 1024 })
    const original = makeFile('huge.jpg', 'image/jpeg', 8 * MB)

    const result = await uploadChatAttachment(makeImageAttachment(original))

    expect(mockDirectUpload).toHaveBeenCalledTimes(1)
    const [uploadedFile, uploadedName] = mockDirectUpload.mock.calls[0] as [File, string]
    expect(uploadedFile).toBeInstanceOf(File)
    expect(uploadedFile).not.toBe(original)
    expect(uploadedFile.size).toBe(512 * 1024)
    expect(uploadedFile.type).toBe('image/jpeg')
    expect(uploadedName).toBe('huge.jpg')
    expect(result).toMatchObject({
      file_name: 'huge.jpg',
      file_size: 512 * 1024,
      file_type: 'image/jpeg',
    })
  })
})
