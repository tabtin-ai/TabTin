/**
 *  回归测试：handleDownloadResource 成功路径必须登记 DownloadManager。
 *
 * 该函数是 UI（crawlspace/ipc 的 resourceDetection:downloadResource / downloadBatch）
 * 与 Agent 工具桥共用的下载核心——此前 ipc.ts 存在一份漏登记的本地拷贝，
 * 导致资源中心下载成功但「下载管理」无记录。本测试钉住共享实现的登记契约：
 * - net 直下成功 → trackExternalDownload 收到 filePath/size/mimeType/viewId
 * - 已捕获内容落盘成功 → 同样登记
 * - 下载失败 → 不登记
 * - 登记抛错 → 不影响下载结果（success: true）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const trackExternalDownload = vi.fn()
const download = vi.fn()
const saveCapturedContent = vi.fn()
const resolveResource = vi.fn()
const markDownloaded = vi.fn()

vi.mock('@tabtin/action-tools/runtime', () => ({
  setResourceDetectionAPI: vi.fn(),
}))

vi.mock('../../embedded-crawl-view', () => ({
  getView: vi.fn(() => null),
}))

vi.mock('../ResourceDetectionService', () => ({
  getResourceDetectionService: vi.fn(() => ({})),
}))

vi.mock('../ResourceHubService', () => ({
  getResourceHubService: vi.fn(() => ({
    resolveResource,
    markDownloaded,
    findResourceLocation: vi.fn(() => null),
  })),
}))

vi.mock('../MediaProbeService', () => ({
  getMediaProbeService: vi.fn(() => ({})),
}))

vi.mock('../M3U8Parser', () => ({
  getM3U8Parser: vi.fn(() => ({})),
}))

vi.mock('../MPDParser', () => ({
  getMPDParser: vi.fn(() => ({})),
}))

vi.mock('../StreamDownloadService', () => ({
  getStreamDownloadService: vi.fn(() => ({})),
}))

vi.mock('../ResourceDownloadService', () => ({
  getResourceDownloadService: vi.fn(() => ({
    download,
    saveCapturedContent,
  })),
}))

vi.mock('../resourceRequestContext', () => ({
  resolveResourceRequestSession: vi.fn(() => undefined),
}))

vi.mock('../../download-messages', () => ({
  DOWNLOAD_MESSAGES: { streamCompleted: '', streamErrors: {} },
}))

vi.mock('../../download-manager', () => ({
  getDownloadManager: vi.fn(() => ({ trackExternalDownload })),
}))

vi.mock('../notification', () => ({
  notificationService: { show: vi.fn() },
}))

vi.mock('../../logger', () => ({
  createLogger: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
}))

import { handleDownloadResource } from '../resource-actions'

describe('#4871 handleDownloadResource → trackExternalDownload 登记契约', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resolveResource.mockReturnValue(null)
    markDownloaded.mockReturnValue(null)
  })

  it('net 直下成功后登记（url 路径，无 viewId）', async () => {
    download.mockResolvedValue({
      filePath: '/tmp/TabTin/photo.jpg',
      size: 2048,
      mimeType: 'image/jpeg',
    })

    const result = await handleDownloadResource({ url: 'https://example.com/photo.jpg' })

    expect(result.success).toBe(true)
    expect(trackExternalDownload).toHaveBeenCalledTimes(1)
    expect(trackExternalDownload).toHaveBeenCalledWith({
      url: 'https://example.com/photo.jpg',
      savePath: '/tmp/TabTin/photo.jpg',
      size: 2048,
      mimeType: 'image/jpeg',
      viewId: undefined,
    })
  })

  it('data: URL 无 contentRef 时走 saveCapturedContent 静默落盘', async () => {
    saveCapturedContent.mockResolvedValue({
      filePath: '/tmp/TabTin/image.png',
      size: 12,
      mimeType: 'image/png',
    })

    const result = await handleDownloadResource({
      url: 'data:image/png;base64,AAAA',
      filename: 'image.png',
    })

    expect(result.success).toBe(true)
    expect(download).not.toHaveBeenCalled()
    expect(saveCapturedContent).toHaveBeenCalledWith(
      expect.objectContaining({
        filename: 'image.png',
        contentRef: { kind: 'data_url', data: 'data:image/png;base64,AAAA' },
      }),
    )
    expect(trackExternalDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        savePath: '/tmp/TabTin/image.png',
      }),
    )
  })

  it('已捕获内容（contentRef）落盘成功后登记，viewId 透传', async () => {
    resolveResource.mockReturnValue({
      resourceId: 'res-1',
      url: 'https://example.com/video.mp4',
      mimeType: 'video/mp4',
      contentRef: { kind: 'data_url', data: 'data:video/mp4;base64,AAAA' },
    })
    saveCapturedContent.mockResolvedValue({
      filePath: '/tmp/TabTin/video.mp4',
      size: 4096,
      mimeType: 'video/mp4',
    })

    const result = await handleDownloadResource({ resourceId: 'res-1', viewId: 'view-1' })

    expect(result.success).toBe(true)
    expect(download).not.toHaveBeenCalled()
    expect(trackExternalDownload).toHaveBeenCalledTimes(1)
    expect(trackExternalDownload).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://example.com/video.mp4',
        savePath: '/tmp/TabTin/video.mp4',
        viewId: 'view-1',
      }),
    )
  })

  it('下载失败时不登记', async () => {
    download.mockRejectedValue(new Error('HTTP 403'))

    const result = await handleDownloadResource({ url: 'https://example.com/blocked.jpg' })

    expect(result.success).toBe(false)
    expect(trackExternalDownload).not.toHaveBeenCalled()
  })

  it('登记抛错不影响下载结果', async () => {
    download.mockResolvedValue({
      filePath: '/tmp/TabTin/doc.pdf',
      size: 100,
      mimeType: 'application/pdf',
    })
    trackExternalDownload.mockImplementation(() => {
      throw new Error('persistence unavailable')
    })

    const result = await handleDownloadResource({ url: 'https://example.com/doc.pdf' })

    expect(result.success).toBe(true)
    expect(result.data?.filePath).toBe('/tmp/TabTin/doc.pdf')
  })
})
