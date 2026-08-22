import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ResourceDownloader } from '../downloader'

const createMockResourceCache = () => ({
  getStats: () => ({ totalCount: 0 }),
  get: vi.fn(() => null),
})

describe('ResourceDownloader resource bridge', () => {
  const originalTabtin = (window as any).tabtin
  const originalElectron = (window as any).electron

  let inspectResource: ReturnType<typeof vi.fn>
  let captureResource: ReturnType<typeof vi.fn>

  beforeEach(() => {
    inspectResource = vi.fn()
    captureResource = vi.fn()

    ;(window as any).tabtin = {
      resourceDetection: {
        inspectResource,
        captureResource,
      },
    }

    ;(window as any).electron = {
      ipcRenderer: {
        invoke: vi.fn().mockResolvedValue('Mozilla/5.0 Test UA'),
      },
    }
  })

  afterEach(() => {
    vi.restoreAllMocks()

    if (originalTabtin === undefined) {
      delete (window as any).tabtin
    } else {
      ;(window as any).tabtin = originalTabtin
    }

    if (originalElectron === undefined) {
      delete (window as any).electron
    } else {
      ;(window as any).electron = originalElectron
    }
  })

  it('优先使用 inspectResource 返回的 contentRef，不重复 capture', async () => {
    inspectResource.mockResolvedValue({
      success: true,
      data: {
        resource: {
          resourceId: 'res-1',
          viewId: 'view-1',
          captureStatus: 'content_cached',
          contentRef: {
            kind: 'text',
            data: 'hello-bridge',
            mimeType: 'text/plain',
          },
        },
      },
    })

    const downloader = new ResourceDownloader({
      resourceCache: createMockResourceCache() as any,
    })

    const [result] = await downloader.downloadBatch([
      {
        url: 'blob:https://example.com/file-1',
        fieldName: 'attachment',
        recordIndex: 0,
        resourceId: 'res-1',
        viewId: 'view-1',
        captureStatus: 'page_bound_blob',
      },
    ])

    expect(result.success).toBe(true)
    expect(result.resourceId).toBe('res-1')
    expect(result.blob).toBeTruthy()
    expect(result.fileSize).toBeGreaterThan(0)
    expect(result.mimeType).toBe('text/plain')
    expect(captureResource).not.toHaveBeenCalled()
  })

  it('page_bound_blob 在 inspect 无内容时会触发 captureResource', async () => {
    inspectResource.mockResolvedValue({
      success: true,
      data: {
        resource: {
          resourceId: 'res-2',
          viewId: 'view-2',
          captureStatus: 'page_bound_blob',
        },
      },
    })

    captureResource.mockResolvedValue({
      success: true,
      data: {
        resource: {
          resourceId: 'res-2',
          viewId: 'view-2',
          captureStatus: 'content_cached',
          contentRef: {
            kind: 'text',
            data: 'captured-blob',
            mimeType: 'text/plain',
          },
        },
      },
    })

    const downloader = new ResourceDownloader({
      resourceCache: createMockResourceCache() as any,
    })

    const [result] = await downloader.downloadBatch([
      {
        url: 'blob:https://example.com/file-2',
        fieldName: 'attachment',
        recordIndex: 1,
        resourceId: 'res-2',
        viewId: 'view-2',
        captureStatus: 'page_bound_blob',
      },
    ])

    expect(result.success).toBe(true)
    expect(result.blob).toBeTruthy()
    expect(result.fileSize).toBeGreaterThan(0)
    expect(result.mimeType).toBe('text/plain')
    expect(captureResource).toHaveBeenCalledWith({
      resourceId: 'res-2',
      viewId: 'view-2',
      force: true,
    })
  })

  it('page_bound_blob 捕获失败时会把失败原因返回给上层', async () => {
    inspectResource.mockResolvedValue({
      success: true,
      data: {
        resource: {
          resourceId: 'res-3',
          viewId: 'view-3',
          captureStatus: 'page_bound_blob',
        },
      },
    })

    captureResource.mockResolvedValue({
      success: false,
      error: '页面内 blob 已失效',
    })

    const downloader = new ResourceDownloader({
      resourceCache: createMockResourceCache() as any,
    })

    const [result] = await downloader.downloadBatch([
      {
        url: 'blob:https://example.com/file-3',
        fieldName: 'attachment',
        recordIndex: 2,
        resourceId: 'res-3',
        viewId: 'view-3',
        captureStatus: 'page_bound_blob',
      },
    ])

    expect(result.success).toBe(false)
    expect(result.error).toBe('页面内 blob 已失效')
    expect(captureResource).toHaveBeenCalledWith({
      resourceId: 'res-3',
      viewId: 'view-3',
      force: true,
    })
  })
})
