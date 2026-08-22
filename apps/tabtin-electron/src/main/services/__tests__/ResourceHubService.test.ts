import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { ResourceHubService } from '../ResourceHubService'

describe('ResourceHubService', () => {
  let hub: ResourceHubService

  beforeEach(() => {
    hub = new ResourceHubService()
    hub.registerView('view-1', 'https://example.com/page')
  })

  it('应推断资源分类、能力位并记录会话上下文', () => {
    const resource = hub.upsertResource({
      viewId: 'view-1',
      pageUrl: 'https://example.com/page',
      sessionPartition: 'persist:space-1',
      url: 'https://cdn.example.com/assets/photo.png',
      mimeType: 'image/png',
      requestHeaders: {
        Referer: 'https://example.com/page',
        Cookie: 'sid=123',
      },
    })

    expect(resource.category).toBe('image')
    expect(resource.captureStatus).toBe('metadata_only')
    expect(resource.capabilities).toEqual(
      expect.arrayContaining(['preview', 'download', 'import', 'sendToAgent'])
    )
    expect(resource.authContextRef).toMatchObject({
      viewId: 'view-1',
      pageUrl: 'https://example.com/page',
      sessionPartition: 'persist:space-1',
      requiresSession: true,
      requiresHeaders: true,
    })
    expect(resource.authContextRef?.headerNames).toEqual(
      expect.arrayContaining(['Referer', 'Cookie'])
    )
  })

  it('应将页面绑定 blob 资源升级为可缓存内容', () => {
    const blobResource = hub.upsertResource({
      viewId: 'view-1',
      url: 'blob:https://example.com/4f32f9',
      mediaElementInfo: {
        tagName: 'video',
        usesMediaSource: true,
      },
    })

    expect(blobResource.captureStatus).toBe('page_bound_blob')
    expect(blobResource.capabilities).toEqual(
      expect.arrayContaining(['preview', 'download', 'import', 'sendToAgent'])
    )

    const captured = hub.attachCapturedContent('view-1', blobResource.url, {
      mimeType: 'video/mp4',
      category: 'video',
      contentRef: {
        kind: 'data_url',
        data: 'data:video/mp4;base64,AAAA',
        mimeType: 'video/mp4',
        size: 4,
        capturedAt: Date.now(),
      },
    })

    expect(captured.resourceId).toBe(blobResource.resourceId)
    expect(captured.captureStatus).toBe('content_cached')
    expect(captured.contentRef?.kind).toBe('data_url')
  })

  it('应在流媒体解析后更新 stream 状态与能力位', () => {
    const stream = hub.upsertResource({
      viewId: 'view-1',
      url: 'https://cdn.example.com/master.m3u8',
      mimeType: 'application/vnd.apple.mpegurl',
    })

    expect(stream.category).toBe('hls')
    expect(stream.capabilities).toEqual(
      expect.arrayContaining(['preview', 'download', 'parse', 'streamDownload'])
    )

    const updated = hub.updateStreamInfo(
      'view-1',
      { resourceId: stream.resourceId },
      {
        isMasterPlaylist: true,
        variants: [
          {
            bandwidth: 1200000,
            resolution: '1280x720',
            url: 'https://cdn.example.com/720p.m3u8',
          },
        ],
        isLive: false,
        duration: 42,
        segmentCount: 8,
      }
    )

    expect(updated?.captureStatus).toBe('stream_manifest')
    expect(updated?.streamInfo?.variants).toHaveLength(1)

    const summary = hub.getSummary('view-1')
    expect(summary.byCategory.hls).toBe(1)
    expect(summary.byCaptureStatus.stream_manifest).toBe(1)
  })

  it('应将 DASH 资源标记为可见且可解释', () => {
    const dash = hub.upsertResource({
      viewId: 'view-1',
      url: 'https://cdn.example.com/manifest.mpd',
      mimeType: 'application/dash+xml',
    })

    expect(dash.category).toBe('dash')
    expect(dash.captureStatus).toBe('metadata_only')
    expect(dash.capabilities).toEqual(
      expect.arrayContaining(['preview', 'download', 'import', 'sendToAgent', 'parse', 'streamDownload'])
    )
  })

  it('应按 hideSegments 隐藏流媒体分片资源', () => {
    const manifest = hub.upsertResource({
      viewId: 'view-1',
      url: 'https://cdn.example.com/master.m3u8',
      mimeType: 'application/vnd.apple.mpegurl',
    })
    const segment = hub.upsertResource({
      viewId: 'view-1',
      url: 'https://cdn.example.com/seg-1.ts',
      mimeType: 'video/mp2t',
    })

    expect(segment.isSegment).toBe(true)
    expect(segment.parentManifestUrl).toBe(manifest.url)

    const visible = hub.getResources('view-1', { hideSegments: true })
    expect(visible.map(resource => resource.resourceId)).toContain(manifest.resourceId)
    expect(visible.map(resource => resource.resourceId)).not.toContain(segment.resourceId)
    expect(hub.getSummary('view-1', { hideSegments: true }).total).toBe(1)
    expect(hub.getSummary('view-1', { hideSegments: true }).byCategory.video).toBeUndefined()
  })

  it('应在下载和失败态之间正确切换', () => {
    const resource = hub.upsertResource({
      viewId: 'view-1',
      url: 'https://cdn.example.com/archive.pdf',
      mimeType: 'application/pdf',
    })

    const downloaded = hub.markDownloaded('view-1', { resourceId: resource.resourceId }, {
      filePath: '/tmp/archive.pdf',
      size: 1024,
      mimeType: 'application/pdf',
    })

    expect(downloaded?.captureStatus).toBe('downloaded')
    expect(downloaded?.contentRef).toMatchObject({
      kind: 'file_path',
      filePath: '/tmp/archive.pdf',
    })

    const failed = hub.setError('view-1', { resourceId: resource.resourceId }, {
      code: 'DOWNLOAD_FAILED',
      message: 'network timeout',
      retryable: true,
    })

    expect(failed?.captureStatus).toBe('failed')
    expect(failed?.lastError?.message).toBe('network timeout')
  })

  describe('NC-003: summary-changed throttle', () => {
    afterEach(() => {
      vi.useRealTimers()
    })

    it('应将快速连续 upsert 的 summary-changed 合并为单次 emit', () => {
      vi.useFakeTimers()
      const listener = vi.fn()
      hub.on('summary-changed', listener)

      for (let i = 0; i < 50; i++) {
        hub.upsertResource({
          viewId: 'view-1',
          url: `https://cdn.example.com/img-${i}.png`,
          mimeType: 'image/png',
        })
      }

      expect(listener).not.toHaveBeenCalled()

      vi.advanceTimersByTime(150)

      expect(listener).toHaveBeenCalledTimes(1)
      const [viewId, summary] = listener.mock.calls[0]
      expect(viewId).toBe('view-1')
      expect(summary.total).toBe(50)
    })

    it('resource-upserted 仍应对每次 upsert 同步触发', () => {
      const listener = vi.fn()
      hub.on('resource-upserted', listener)

      hub.upsertResource({ viewId: 'view-1', url: 'https://cdn.example.com/a.png', mimeType: 'image/png' })
      hub.upsertResource({ viewId: 'view-1', url: 'https://cdn.example.com/b.png', mimeType: 'image/png' })

      expect(listener).toHaveBeenCalledTimes(2)
    })

    it('clearView 应同步 emit summary-changed 并取消 pending throttle', () => {
      vi.useFakeTimers()
      const listener = vi.fn()
      hub.on('summary-changed', listener)

      hub.upsertResource({ viewId: 'view-1', url: 'https://cdn.example.com/x.png', mimeType: 'image/png' })
      expect(listener).not.toHaveBeenCalled()

      hub.clearView('view-1')

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0][1].total).toBe(0)

      vi.advanceTimersByTime(200)
      expect(listener).toHaveBeenCalledTimes(1)
    })

    it('不同 viewId 的 throttle 应互不影响', () => {
      vi.useFakeTimers()
      hub.registerView('view-2', 'https://example.com/other')
      const listener = vi.fn()
      hub.on('summary-changed', listener)

      hub.upsertResource({ viewId: 'view-1', url: 'https://cdn.example.com/1.png', mimeType: 'image/png' })
      hub.upsertResource({ viewId: 'view-2', url: 'https://cdn.example.com/2.png', mimeType: 'image/png' })

      vi.advanceTimersByTime(150)

      expect(listener).toHaveBeenCalledTimes(2)
      const viewIds = listener.mock.calls.map((c: unknown[]) => c[0])
      expect(viewIds).toContain('view-1')
      expect(viewIds).toContain('view-2')
    })
  })

  describe('分片识别启发式', () => {
    it('应将 seg_N.mp4 标记为分片', () => {
      const resource = hub.upsertResource({
        viewId: 'view-1',
        url: 'https://cdn.example.com/video/seg_12.mp4',
        mimeType: 'video/mp4',
      })
      expect(resource.isSegment).toBe(true)
    })

    it('应将 init.mp4 标记为分片', () => {
      const resource = hub.upsertResource({
        viewId: 'view-1',
        url: 'https://cdn.example.com/video/init.mp4',
        mimeType: 'video/mp4',
      })
      expect(resource.isSegment).toBe(true)
    })

    it('不应将普通 video.mp4 标记为分片', () => {
      const resource = hub.upsertResource({
        viewId: 'view-1',
        url: 'https://cdn.example.com/video/my-video.mp4',
        mimeType: 'video/mp4',
      })
      expect(resource.isSegment).toBeUndefined()
    })

    it('应关联分片到同域的 manifest', () => {
      hub.upsertResource({
        viewId: 'view-1',
        url: 'https://cdn.example.com/video/manifest.mpd',
        mimeType: 'application/dash+xml',
      })

      const segment = hub.upsertResource({
        viewId: 'view-1',
        url: 'https://cdn.example.com/video/seg_1.m4s',
        mimeType: 'video/mp4',
      })

      expect(segment.isSegment).toBe(true)
      expect(segment.parentManifestUrl).toBe('https://cdn.example.com/video/manifest.mpd')
    })
  })
})
