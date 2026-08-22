import { beforeEach, describe, expect, it, vi } from 'vitest'

const validateUploadFile = vi.fn()
const presignCommentAttachmentUpload = vi.fn()
const confirmCommentAttachmentUpload = vi.fn()
const putPresignedObjectViaMainProcess = vi.fn()

vi.mock('@/constants/upload', () => ({
  validateUploadFile: (...args: unknown[]) => validateUploadFile(...args),
}))

vi.mock('@tabtin/tabdoc-ui/api-client', () => ({
  presignCommentAttachmentUpload: (...args: unknown[]) => presignCommentAttachmentUpload(...args),
  confirmCommentAttachmentUpload: (...args: unknown[]) => confirmCommentAttachmentUpload(...args),
  isSignedCommentPreviewUrl: (url: string | null | undefined) => /^https?:\/\//i.test(String(url || '')),
}))

vi.mock('@/services/mainProcessOssUploader', () => ({
  putPresignedObjectViaMainProcess: (...args: unknown[]) => putPresignedObjectViaMainProcess(...args),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

import { uploadCommentAttachmentImage } from './commentAttachmentUpload'

describe('uploadCommentAttachmentImage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    validateUploadFile.mockReturnValue({ valid: true })
    presignCommentAttachmentUpload.mockResolvedValue({
      upload_url: 'https://oss.example/put',
      upload_token: 'tok-1',
      method: 'PUT',
      headers: { 'Content-Type': 'image/png' },
      expires_in: 600,
    })
    putPresignedObjectViaMainProcess.mockResolvedValue({ status: 200, headers: {} })
    confirmCommentAttachmentUpload.mockResolvedValue({
      file_id: 'file-1',
      type: 'image',
      metadata: {},
      preview_url: '/tabdoc/documents/d1/comment-attachments/file-1/preview',
    })
  })

  it('presign → PUT → confirm 返回 fileId', async () => {
    const client = { request: vi.fn() } as any
    const file = new File([new Uint8Array([1, 2, 3])], 'a.png', { type: 'image/png' })
    const result = await uploadCommentAttachmentImage(client, 'd1', file)
    expect(validateUploadFile).toHaveBeenCalledWith(file, 'IMAGE')
    expect(presignCommentAttachmentUpload).toHaveBeenCalled()
    expect(putPresignedObjectViaMainProcess).toHaveBeenCalledWith(
      expect.objectContaining({
        presignedUrl: 'https://oss.example/put',
        contentType: 'image/png',
      }),
    )
    expect(confirmCommentAttachmentUpload).toHaveBeenCalledWith(client, 'd1', 'tok-1')
    // 鉴权 path 不能给 <img>，绑定前也不返回 previewUrl（保留 composer blob）
    expect(result).toEqual({
      fileId: 'file-1',
      previewUrl: undefined,
    })
  })

  it('校验失败时不发起上传', async () => {
    validateUploadFile.mockReturnValue({ valid: false, reason: 'fileTooLarge' })
    const client = { request: vi.fn() } as any
    const file = new File([new Uint8Array([1])], 'big.png', { type: 'image/png' })
    await expect(uploadCommentAttachmentImage(client, 'd1', file)).rejects.toThrow('fileTooLarge')
    expect(presignCommentAttachmentUpload).not.toHaveBeenCalled()
  })
})
