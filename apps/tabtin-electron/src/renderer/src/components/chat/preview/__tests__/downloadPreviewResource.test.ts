/**
 * ：打包态远程下载不得走 renderer 裸 fetch。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  downloadPreviewResource,
  isRemoteHttpDownloadUrl,
  isRendererReadableDownloadUrl,
} from '../downloadPreviewResource'

const toastSuccess = vi.fn()
const toastError = vi.fn()
const toastCall = vi.fn()
const { resolveOssFileAccessUrl } = vi.hoisted(() => ({
  resolveOssFileAccessUrl: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(
    (...args: unknown[]) => toastCall(...args),
    {
      success: (...args: unknown[]) => toastSuccess(...args),
      error: (...args: unknown[]) => toastError(...args),
    },
  ),
  ToastAction: 'toast-action',
}))

vi.mock('@/services/tableCoreRuntime', () => ({
  saveExportBlob: vi.fn(),
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    warn: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../richContent/widget/svgCodeToPngBlob', () => ({
  svgCodeToPngBlob: vi.fn(),
}))

vi.mock('../resolveOssFileAccessUrl', () => ({
  resolveOssFileAccessUrl: (...args: unknown[]) => resolveOssFileAccessUrl(...args),
}))

describe('downloadPreviewResource URL helpers', () => {
  it('classifies renderer-readable vs remote http', () => {
    expect(isRendererReadableDownloadUrl('blob:abc')).toBe(true)
    expect(isRendererReadableDownloadUrl('data:image/png;base64,xx')).toBe(true)
    expect(isRendererReadableDownloadUrl('tabtin-file://local/a.svg')).toBe(true)
    expect(isRendererReadableDownloadUrl('https://oss.example.com/a.png')).toBe(false)
    expect(isRemoteHttpDownloadUrl('https://oss.example.com/a.png')).toBe(true)
    expect(isRemoteHttpDownloadUrl('tabtin-file://local/a.svg')).toBe(false)
  })
})

describe('downloadPreviewResource remote http', () => {
  const t = ((key: string, opts?: { defaultValue?: string; name?: string }) =>
    opts?.defaultValue?.replace('{{name}}', opts.name ?? '') ?? key) as never

  beforeEach(() => {
    toastSuccess.mockReset()
    toastError.mockReset()
    toastCall.mockReset()
    resolveOssFileAccessUrl.mockReset()
    Reflect.deleteProperty(window, 'tabtin')
  })

  it('uses main-process downloadResource for https and does not call fetch', async () => {
    const downloadResource = vi.fn().mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/Downloads/TabTin/widget.png' },
    })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        resourceDetection: { downloadResource },
        showItemInFolder: vi.fn(),
      },
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadPreviewResource({
      url: 'https://cdn.example.com/widget.png',
      fileName: 'widget.png',
      t,
    })

    expect(result).toBe('saved')
    expect(downloadResource).toHaveBeenCalledWith({
      url: 'https://cdn.example.com/widget.png',
      filename: 'widget.png',
    })
    expect(fetchMock).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('does not fall back to renderer fetch when main-process https download fails', async () => {
    const downloadResource = vi.fn().mockResolvedValue({
      success: false,
      error: 'HTTP 403',
    })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: { resourceDetection: { downloadResource } },
    })
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadPreviewResource({
      url: 'https://cdn.example.com/widget.png',
      fileName: 'widget.png',
      t,
    })

    expect(result).toBe('failed')
    expect(fetchMock).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })

  it('refreshes an OSS file URL once when the current download URL is rejected', async () => {
    const downloadResource = vi.fn()
      .mockResolvedValueOnce({ success: false, error: 'HTTP 403' })
      .mockResolvedValueOnce({
        success: true,
        data: { filePath: '/tmp/Downloads/TabTin/widget.png' },
      })
    resolveOssFileAccessUrl.mockResolvedValue('https://oss.example.com/fresh.png')
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        resourceDetection: { downloadResource },
        showItemInFolder: vi.fn(),
      },
    })

    const result = await downloadPreviewResource({
      url: 'https://oss.example.com/expired.png',
      fileName: 'widget.png',
      fileId: 'file-1',
      t,
    })

    expect(result).toBe('saved')
    expect(resolveOssFileAccessUrl).toHaveBeenCalledWith('file-1', { forceRefresh: true })
    expect(downloadResource).toHaveBeenNthCalledWith(2, {
      url: 'https://oss.example.com/fresh.png',
      filename: 'widget.png',
    })
    expect(toastError).not.toHaveBeenCalled()
  })

  it('tabtin-file: renderer fetch then silent main-process data: save ', async () => {
    const { saveExportBlob } = await import('@/services/tableCoreRuntime')
    vi.mocked(saveExportBlob).mockResolvedValue({
      status: 'saved',
      path: '/tmp/out.svg',
    })

    const downloadResource = vi.fn().mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/Downloads/TabTin/diagram.svg' },
    })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        resourceDetection: { downloadResource },
        showItemInFolder: vi.fn(),
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob(['<svg/>'], { type: 'image/svg+xml' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadPreviewResource({
      url: 'tabtin-file://local/diagram.svg',
      fileName: 'diagram.svg',
      t,
    })

    expect(result).toBe('saved')
    expect(fetchMock).toHaveBeenCalledWith('tabtin-file://local/diagram.svg')
    expect(downloadResource).toHaveBeenCalled()
    expect(downloadResource.mock.calls[0][0].filename).toBe('diagram.svg')
    expect(String(downloadResource.mock.calls[0][0].url)).toMatch(/^data:/)
    expect(saveExportBlob).not.toHaveBeenCalled()
  })

  it('blob URL: silent main-process save without save dialog', async () => {
    const { saveExportBlob } = await import('@/services/tableCoreRuntime')
    vi.mocked(saveExportBlob).mockClear()

    const downloadResource = vi.fn().mockResolvedValue({
      success: true,
      data: { filePath: '/tmp/Downloads/TabTin/image.png' },
    })
    Object.defineProperty(window, 'tabtin', {
      configurable: true,
      value: {
        resourceDetection: { downloadResource },
        showItemInFolder: vi.fn(),
      },
    })
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      blob: async () => new Blob([new Uint8Array([1, 2, 3])], { type: 'image/png' }),
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await downloadPreviewResource({
      url: 'blob:http://localhost/preview-image',
      fileName: 'image.png',
      t,
    })

    expect(result).toBe('saved')
    expect(downloadResource).toHaveBeenCalled()
    expect(String(downloadResource.mock.calls[0][0].url)).toMatch(/^data:image\/png/)
    expect(saveExportBlob).not.toHaveBeenCalled()
    expect(toastSuccess).toHaveBeenCalled()
  })

  it('rejects empty blob payloads instead of writing 0KB files ', async () => {
    const { downloadPreviewBlob } = await import('../downloadPreviewResource')
    const { saveExportBlob } = await import('@/services/tableCoreRuntime')
    vi.mocked(saveExportBlob).mockClear()

    const result = await downloadPreviewBlob({
      blob: new Blob([]),
      fileName: 'empty.pdf',
      t,
    })

    expect(result).toBe('failed')
    expect(saveExportBlob).not.toHaveBeenCalled()
    expect(toastError).toHaveBeenCalled()
  })
})
