import { beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDirectUpload, mockBitmapClose } = vi.hoisted(() => ({
  mockDirectUpload: vi.fn(),
  mockBitmapClose: vi.fn(),
}))

vi.mock('./oss-direct-uploader', () => ({
  directUpload: mockDirectUpload,
}))

import { uploadIMAttachment } from './tabchatAttachmentApi'

describe('uploadIMAttachment', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('createImageBitmap', vi.fn(async () => ({
      width: 844,
      height: 1152,
      close: mockBitmapClose,
    })))
    mockDirectUpload.mockResolvedValue({
      fileId: 'file-1',
      fileName: 'photo.png',
      fileSize: 68,
      accessUrl: 'https://oss.example/access',
      cdnUrl: 'https://cdn.example/photo.png',
    })
  })

  it('returns intrinsic image dimensions with the upload result', async () => {
    const image = new File(['image'], 'photo.png', { type: 'image/png' })

    const result = await uploadIMAttachment(image)

    expect(result).toMatchObject({ image_width: 844, image_height: 1152 })
    expect(mockBitmapClose).toHaveBeenCalledOnce()
  })

  it('keeps uploading when the browser cannot decode image dimensions', async () => {
    vi.stubGlobal('createImageBitmap', vi.fn(async () => {
      throw new Error('decode failed')
    }))
    const image = new File(['image'], 'photo.png', { type: 'image/png' })

    const result = await uploadIMAttachment(image)

    expect(result).not.toHaveProperty('image_width')
    expect(result).not.toHaveProperty('image_height')
    expect(mockDirectUpload).toHaveBeenCalledOnce()
  })
})
