import { beforeEach, describe, expect, it, vi } from 'vitest'

const directUploadMock = vi.hoisted(() => vi.fn())

vi.mock('@/adapters/api-adapter-instance', () => ({
  getAuthToken: () => 'token',
}))

vi.mock('@/stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}))
vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: { getState: () => ({ user: null }) },
}))

vi.mock('@/services/oss-direct-uploader', () => ({
  directUpload: directUploadMock,
}))

vi.mock('@/constants/upload', () => ({
  validateUploadFile: () => ({ valid: true }),
  UPLOAD_PRESETS: { IMAGE: { maxSize: 20 * 1024 * 1024 } },
  formatFileSize: () => '20 MB',
}))

// html 识别断言在 tabdoc-ui 的 html-upload.test.ts 覆盖；此处 mock 成放行，专注验证 electron 直传插桩。
vi.mock('@tabtin/tabdoc-ui/editor', () => ({
  isHtmlUploadFile: (file: { name: string; type: string }) =>
    file.type === 'text/html' || /\.html?$/i.test(file.name),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}))

describe('electronImageUploadPort', () => {
  beforeEach(() => {
    directUploadMock.mockReset()
  })

  it('normalizes Windows path-like file names before direct upload', async () => {
    directUploadMock.mockResolvedValueOnce({
      accessUrl: 'https://cdn.example.com/cover.png?sig=short',
      fileId: 'file-cover-1',
    })
    const { electronImageUploadPort } = await import('./electronTabDocEditorConfig')
    const file = new File(['cover'], String.raw`C:\Users\me\Pictures\cover.png`, { type: 'image/png' })

    const result = await electronImageUploadPort.upload(file, {
      folder: 'tabdoc/covers',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
    })

    expect(result).toEqual({
      url: 'https://cdn.example.com/cover.png?sig=short',
      fileId: 'file-cover-1',
    })
    expect(directUploadMock).toHaveBeenCalledWith(
      file,
      'cover.png',
      expect.objectContaining({
        folder: 'tabdoc/covers',
        module: 'tabdoc',
        contextType: 'document',
        contextId: 'doc-1',
        isPublic: false,
      }),
    )
  })

  it('uploads document body images as private document-bound assets', async () => {
    directUploadMock.mockResolvedValueOnce({
      accessUrl: 'https://cdn.example.com/image.png?sig=short',
      fileId: 'file-image-1',
    })
    const { electronImageUploadPort } = await import('./electronTabDocEditorConfig')
    const file = new File(['image'], 'image.png', { type: 'image/png' })

    await electronImageUploadPort.upload(file, {
      folder: 'tabdoc/images',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
    })

    expect(directUploadMock).toHaveBeenCalledWith(
      file,
      'image.png',
      expect.objectContaining({
        folder: 'tabdoc/images',
        isPublic: false,
      }),
    )
  })

  it('uses the signed access URL and stable file id returned by private upload', async () => {
    directUploadMock.mockResolvedValueOnce({
      accessUrl: 'https://bucket.example.com/tabdoc/images/image.png',
      cdnUrl: 'https://assets.example.com/tabdoc/images/image.png',
      fileId: 'file-image-2',
    })
    const { electronImageUploadPort } = await import('./electronTabDocEditorConfig')
    const file = new File(['image'], 'image.png', { type: 'image/png' })

    const result = await electronImageUploadPort.upload(file, {
      folder: 'tabdoc/images',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
    })

    expect(result).toEqual({
      url: 'https://bucket.example.com/tabdoc/images/image.png',
      fileId: 'file-image-2',
    })
  })

  it('fails clearly when upload completes without a usable URL', async () => {
    directUploadMock.mockResolvedValueOnce({ accessUrl: '', cdnUrl: '' })
    const { electronImageUploadPort } = await import('./electronTabDocEditorConfig')
    const file = new File(['image'], 'image.png', { type: 'image/png' })

    await expect(electronImageUploadPort.upload(file, {
      folder: 'tabdoc/images',
      module: 'tabdoc',
      contextType: 'document',
      contextId: 'doc-1',
    })).rejects.toThrow('Image upload completed without a usable private file reference')
  })
})

describe('normalizeUploadFileName', () => {
  it('keeps regular basename unchanged', async () => {
    const { normalizeUploadFileName } = await import('./electronTabDocEditorConfig')
    expect(normalizeUploadFileName('cover.jfif')).toBe('cover.jfif')
  })
})

describe('electronHtmlUploadPort', () => {
  it('uploads .html files privately and returns fileId with empty src url ', async () => {
    directUploadMock.mockResolvedValueOnce({
      accessUrl: 'https://cdn.example.com/proto.html',
      fileId: 'file-html-1',
    })
    const { electronHtmlUploadPort } = await import('./electronTabDocEditorConfig')
    const file = new File(['<html></html>'], 'proto.html', { type: 'text/html' })

    const result = await electronHtmlUploadPort.upload(file, { documentId: 'doc-9' })

    expect(result).toEqual({ url: '', fileId: 'file-html-1' })
    expect(directUploadMock).toHaveBeenCalledWith(
      file,
      'proto.html',
      expect.objectContaining({
        folder: 'tabdoc/html',
        module: 'tabdoc',
        contextType: 'document',
        contextId: 'doc-9',
        isPublic: false,
      }),
    )
  })

  it('rejects non-html files before hitting direct upload', async () => {
    directUploadMock.mockClear()
    const { electronHtmlUploadPort } = await import('./electronTabDocEditorConfig')
    const file = new File(['x'], 'notes.txt', { type: 'text/plain' })

    await expect(electronHtmlUploadPort.upload(file, {})).rejects.toThrow()
    expect(directUploadMock).not.toHaveBeenCalled()
  })

  it('validate flags oversized html files with a fileTooLarge reason', async () => {
    const { electronHtmlUploadPort } = await import('./electronTabDocEditorConfig')
    const oversized = new File([new Uint8Array(11 * 1024 * 1024)], 'big.html', { type: 'text/html' })

    const result = electronHtmlUploadPort.validate!(oversized)

    expect(result.valid).toBe(false)
    expect(result.reason?.startsWith('fileTooLarge')).toBe(true)
  })
})
