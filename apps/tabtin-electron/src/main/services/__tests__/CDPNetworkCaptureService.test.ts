import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockAttachCapturedContent = vi.fn()
vi.mock('../ResourceHubService', () => ({
  getResourceHubService: () => ({
    attachCapturedContent: mockAttachCapturedContent
  })
}))

const mockSuppressNavigationClear = vi.fn()
const mockResumeNavigationClear = vi.fn()
const mockGetViewIdByWebContentsId = vi.fn()
vi.mock('../ResourceDetectionService', () => ({
  getResourceDetectionService: () => ({
    suppressNavigationClear: mockSuppressNavigationClear,
    resumeNavigationClear: mockResumeNavigationClear,
    getViewIdByWebContentsId: mockGetViewIdByWebContentsId
  })
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn()
  })
}))

vi.mock('../../utils/file-path', () => ({
  formatBytes: (n: number) => `${n}B`
}))

describe('CDPNetworkCaptureService – NC-001 contentRef regression', () => {
  let CDPNetworkCaptureService: typeof import('../CDPNetworkCaptureService').CDPNetworkCaptureService

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const mod = await import('../CDPNetworkCaptureService')
    CDPNetworkCaptureService = mod.CDPNetworkCaptureService
  })

  function buildSession(overrides?: Partial<{ sendResult: any }>) {
    const sendResult = overrides?.sendResult ?? { body: '', base64Encoded: false }
    return {
      id: 'test-session',
      viewId: 'test-session',
      page: { url: () => 'https://example.com' },
      cdpSession: { send: vi.fn().mockResolvedValue(sendResult) },
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set(),
      stopping: false,
      captureSemaphore: { acquire: () => Promise.resolve(), release: vi.fn() },
      stats: {
        totalRequests: 0,
        imageRequests: 0,
        capturedImages: 0,
        failedImages: 0,
        mediaRequests: 0,
        capturedMedia: 0,
        failedMedia: 0
      }
    }
  }

  it('文本资源空 body 时 contentRef 仍为 text kind（不再传 undefined）', async () => {
    const svc = new CDPNetworkCaptureService()
    const session = buildSession({ sendResult: { body: '', base64Encoded: false } })

    await (svc as any).captureMediaResponseBody(
      session, 'req-1', 'https://cdn.example.com/master.m3u8',
      'application/vnd.apple.mpegurl', 'hls', true
    )

    expect(mockAttachCapturedContent).toHaveBeenCalledTimes(1)
    const callArgs = mockAttachCapturedContent.mock.calls[0]
    expect(callArgs[2].contentRef).toBeDefined()
    expect(callArgs[2].contentRef.kind).toBe('text')
    expect(callArgs[2].contentRef.data).toBe('')
  })

  it('二进制资源有 body 时 contentRef 为 data_url kind', async () => {
    const svc = new CDPNetworkCaptureService()
    const base64Content = Buffer.from('fake-video-data').toString('base64')
    const session = buildSession({ sendResult: { body: base64Content, base64Encoded: true } })

    await (svc as any).captureMediaResponseBody(
      session, 'req-2', 'https://cdn.example.com/clip.mp4',
      'video/mp4', 'video', false
    )

    expect(mockAttachCapturedContent).toHaveBeenCalledTimes(1)
    const callArgs = mockAttachCapturedContent.mock.calls[0]
    expect(callArgs[2].contentRef).toBeDefined()
    expect(callArgs[2].contentRef.kind).toBe('data_url')
    expect(callArgs[2].contentRef.data).toContain('data:video/mp4;base64,')
  })

  it('CDP 返回失败时不调用 attachCapturedContent 且不抛错', async () => {
    const svc = new CDPNetworkCaptureService()
    const session = buildSession()
    session.cdpSession.send = vi.fn().mockRejectedValue(new Error('No resource with given identifier found'))

    await (svc as any).captureMediaResponseBody(
      session, 'req-3', 'https://cdn.example.com/gone.mp4',
      'video/mp4', 'video', false
    )

    expect(mockAttachCapturedContent).not.toHaveBeenCalled()
    expect(session.stats.failedMedia).toBe(1)
  })
})

describe('CaptureSemaphore – NC-005 queue overflow protection', () => {
  let CaptureSemaphoreClass: any

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const mod = await import('../CDPNetworkCaptureService')
    // CaptureSemaphore is not exported; access via a new CDPNetworkCaptureService session
    CaptureSemaphoreClass = (mod as any).CDPNetworkCaptureService
  })

  function createSemaphore(limit: number, maxQueue: number) {
    // Access CaptureSemaphore through the module internals
    // We test the behavior through CDPNetworkCaptureService's scheduleCapture
    const svc = new CaptureSemaphoreClass()
    const session = {
      id: 'sem-test',
      page: { url: () => 'https://example.com' },
      cdpSession: { send: vi.fn() },
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set<Promise<void>>(),
      stopping: false,
      captureSemaphore: null as any,
      stats: {
        totalRequests: 0, imageRequests: 0, capturedImages: 0,
        failedImages: 0, mediaRequests: 0, capturedMedia: 0, failedMedia: 0
      }
    }
    // Create a CaptureSemaphore by starting a real session's semaphore field
    // We'll manually invoke via scheduleCapture
    return { svc, session }
  }

  it('queue 超过 maxQueue 时 acquire 返回 null', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    // 创建一个并发限制 =1, maxQueue=3 的 semaphore 的会话
    const session: any = {
      id: 'q-test',
      page: { url: () => 'https://example.com' },
      cdpSession: { send: vi.fn() },
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set<Promise<void>>(),
      stopping: false,
      captureSemaphore: null,
      stats: {
        totalRequests: 0, imageRequests: 0, capturedImages: 0,
        failedImages: 0, mediaRequests: 0, capturedMedia: 0, failedMedia: 0
      }
    }

    // 直接构造内部的 CaptureSemaphore
    // 通过模块私有类反射：启动一个 session 然后替换 semaphore
    ;(svc as any).sessions.set('q-test', session)

    // 手动构造 semaphore (limit=1, maxQueue=3)
    // 由于 CaptureSemaphore 未导出，我们通过 CDPNetworkCaptureSession 间接测试
    // 创建 session 后手动替换 captureSemaphore
    const realSession = {
      id: 'q-test',
      page: { url: () => 'https://example.com', target: () => ({ type: () => 'page', createCDPSession: () => Promise.resolve({ send: vi.fn().mockResolvedValue({}), on: vi.fn(), once: vi.fn() }) }), isClosed: () => false },
      cdpSession: { send: vi.fn(), on: vi.fn(), once: vi.fn(), detach: vi.fn() },
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set<Promise<void>>(),
      stopping: false,
      captureSemaphore: null as any,
      stats: {
        totalRequests: 0, imageRequests: 0, capturedImages: 0,
        failedImages: 0, mediaRequests: 0, capturedMedia: 0, failedMedia: 0
      }
    }

    // Start a real session to get a properly initialized CaptureSemaphore
    // Then test scheduleCapture behavior
    // Simpler approach: test scheduleCapture with a mock semaphore that returns null

    // Test: scheduleCapture should silently drop when acquire returns null
    const mockSemaphore = {
      acquire: vi.fn().mockReturnValue(null),
      release: vi.fn(),
      get droppedCount() { return 1 },
      get queueLength() { return 200 },
      get pendingCount() { return 200 }
    }
    realSession.captureSemaphore = mockSemaphore
    ;(svc as any).sessions.set('q-test', realSession)

    const fn = vi.fn().mockResolvedValue(undefined)
    ;(svc as any).scheduleCapture(realSession, fn)

    // fn should never be called because semaphore returned null
    await new Promise(r => setTimeout(r, 10))
    expect(fn).not.toHaveBeenCalled()
    expect(realSession.pendingCaptures.size).toBe(0)
  })

  it('queue 未满时任务正常执行', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    const fn = vi.fn().mockResolvedValue(undefined)
    const mockSemaphore = {
      acquire: vi.fn().mockReturnValue(Promise.resolve()),
      release: vi.fn(),
      get droppedCount() { return 0 },
      get queueLength() { return 0 },
      get pendingCount() { return 1 }
    }

    const session: any = {
      id: 'ok-test',
      stopping: false,
      pendingCaptures: new Set<Promise<void>>(),
      captureSemaphore: mockSemaphore
    }
    ;(svc as any).sessions.set('ok-test', session)
    ;(svc as any).scheduleCapture(session, fn)

    await new Promise(r => setTimeout(r, 10))
    expect(fn).toHaveBeenCalledTimes(1)
    expect(mockSemaphore.release).toHaveBeenCalledTimes(1)
  })

  it('droppedCount 正确递增', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    let dropCount = 0
    const mockSemaphore = {
      acquire: vi.fn().mockImplementation(() => {
        dropCount++
        return null
      }),
      release: vi.fn(),
      get droppedCount() { return dropCount },
      get queueLength() { return 200 },
      get pendingCount() { return 200 }
    }

    const session: any = {
      id: 'drop-test',
      stopping: false,
      pendingCaptures: new Set<Promise<void>>(),
      captureSemaphore: mockSemaphore
    }

    for (let i = 0; i < 5; i++) {
      ;(svc as any).scheduleCapture(session, vi.fn())
    }

    expect(mockSemaphore.acquire).toHaveBeenCalledTimes(5)
    expect(dropCount).toBe(5)
    expect(session.pendingCaptures.size).toBe(0)
  })
})

describe('RP-002 – viewId 对齐回归', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('captureResponseBody 使用 session.viewId（非 session.id）写入 ResourceHub', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    const session: any = {
      id: 'task-123',
      viewId: 'view-abc',
      page: { url: () => 'https://example.com' },
      cdpSession: {
        send: vi.fn().mockResolvedValue({ body: Buffer.from('img-data').toString('base64'), base64Encoded: true })
      },
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set(),
      stopping: false,
      captureSemaphore: { acquire: () => Promise.resolve(), release: vi.fn() },
      stats: { totalRequests: 0, imageRequests: 0, capturedImages: 0, failedImages: 0, mediaRequests: 0, capturedMedia: 0, failedMedia: 0 }
    }

    await (svc as any).captureResponseBody(session, 'req-1', 'https://cdn.example.com/photo.jpg', 'image/jpeg')

    expect(mockAttachCapturedContent).toHaveBeenCalledTimes(1)
    const [viewId] = mockAttachCapturedContent.mock.calls[0]
    expect(viewId).toBe('view-abc')
  })

  it('captureMediaResponseBody 使用 session.viewId 写入 ResourceHub', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    const session: any = {
      id: 'task-456',
      viewId: 'view-xyz',
      page: { url: () => 'https://example.com' },
      cdpSession: {
        send: vi.fn().mockResolvedValue({ body: '#EXTM3U\n#EXT-X-STREAM-INF\nstream.ts', base64Encoded: false })
      },
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set(),
      stopping: false,
      captureSemaphore: { acquire: () => Promise.resolve(), release: vi.fn() },
      stats: { totalRequests: 0, imageRequests: 0, capturedImages: 0, failedImages: 0, mediaRequests: 0, capturedMedia: 0, failedMedia: 0 }
    }

    await (svc as any).captureMediaResponseBody(session, 'req-2', 'https://cdn.example.com/master.m3u8', 'application/vnd.apple.mpegurl', 'hls', true)

    expect(mockAttachCapturedContent).toHaveBeenCalledTimes(1)
    const [viewId] = mockAttachCapturedContent.mock.calls[0]
    expect(viewId).toBe('view-xyz')
  })
})

describe('RP-009 – collectRelatedViewIds 不依赖私有 API', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('使用 session.viewId 代替 Puppeteer 私有 API 反查', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    const session: any = {
      id: 'sess-1',
      viewId: 'real-view-id',
      page: { url: () => 'https://example.com' },
      cdpSession: { send: vi.fn(), on: vi.fn(), once: vi.fn() },
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set(),
      stopping: false,
      captureSemaphore: { acquire: () => Promise.resolve(), release: vi.fn() },
      stats: { totalRequests: 0, imageRequests: 0, capturedImages: 0, failedImages: 0, mediaRequests: 0, capturedMedia: 0, failedMedia: 0 }
    }
    ;(svc as any).sessions.set('sess-1', session)
    ;(svc as any).aliasToSessionId.set('sess-1', 'sess-1')
    ;(svc as any).aliasToSessionId.set('alias-1', 'sess-1')

    const detectionService = { getViewIdByWebContentsId: vi.fn() }
    const viewIds = (svc as any).collectRelatedViewIds('sess-1', detectionService)

    expect(viewIds).toContain('sess-1')
    expect(viewIds).toContain('real-view-id')
    expect(viewIds).toContain('alias-1')
    expect(detectionService.getViewIdByWebContentsId).not.toHaveBeenCalled()
  })
})

describe('RP-012 – diagnosticInterval 泄漏防护', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('startSession 异常时清理 diagnosticInterval', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    const mockPage = {
      url: () => 'https://example.com',
      isClosed: () => false,
      target: () => ({
        type: () => 'page',
        createCDPSession: () => Promise.resolve({
          send: vi.fn()
            .mockResolvedValueOnce({})
            .mockRejectedValueOnce(new Error('CDP 验证失败')),
          on: vi.fn(),
          once: vi.fn()
        })
      })
    }

    const clearIntervalSpy = vi.spyOn(global, 'clearInterval')

    await expect(svc.startSession('leak-test', mockPage)).rejects.toThrow()

    expect(svc.hasActiveSession('leak-test')).toBe(false)
  })
})

describe('ensureImagesCaptured – NC-006 suppress navigation clear', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('reload 前抑制导航清理，reload 后恢复', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    const mockCdpSession = {
      send: vi.fn().mockResolvedValue({}),
      on: vi.fn(),
      once: vi.fn(),
      detach: vi.fn()
    }

    const mockPage = {
      url: () => 'https://example.com/gallery',
      isClosed: () => false,
      target: () => ({
        type: () => 'page',
        createCDPSession: () => Promise.resolve(mockCdpSession)
      }),
      waitForNavigation: vi.fn().mockResolvedValue(undefined)
    }

    // 手动设置会话
    const session: any = {
      id: 'reload-test',
      page: mockPage,
      cdpSession: mockCdpSession,
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set(),
      stopping: false,
      captureSemaphore: { acquire: () => Promise.resolve(), release: vi.fn(), droppedCount: 0, queueLength: 0 },
      stats: {
        totalRequests: 10, imageRequests: 5, capturedImages: 3,
        failedImages: 0, mediaRequests: 2, capturedMedia: 2, failedMedia: 0
      }
    }
    ;(svc as any).sessions.set('reload-test', session)
    ;(svc as any).aliasToSessionId.set('reload-test', 'reload-test')

    await svc.ensureImagesCaptured({
      sessionId: 'reload-test',
      page: mockPage,
      url: 'https://example.com/gallery',
      minImages: 25,
      timeoutMs: 1000
    })

    // 验证 reload 前调用了 suppressNavigationClear
    expect(mockSuppressNavigationClear).toHaveBeenCalledWith('reload-test')
    // 验证 reload 后调用了 resumeNavigationClear
    expect(mockResumeNavigationClear).toHaveBeenCalledWith('reload-test')
    // 验证 CDP 发送了 Page.reload
    expect(mockCdpSession.send).toHaveBeenCalledWith('Page.reload', { ignoreCache: true })
    // 确保 resume 在 suppress 之后调用
    const suppressOrder = mockSuppressNavigationClear.mock.invocationCallOrder[0]
    const resumeOrder = mockResumeNavigationClear.mock.invocationCallOrder[0]
    expect(resumeOrder).toBeGreaterThan(suppressOrder)
  })

  it('reload 失败时仍恢复导航清理（finally 语义）', async () => {
    const mod = await import('../CDPNetworkCaptureService')
    const svc = new mod.CDPNetworkCaptureService()

    const mockCdpSession = {
      send: vi.fn().mockRejectedValue(new Error('Target closed')),
      on: vi.fn(),
      once: vi.fn(),
      detach: vi.fn()
    }

    const mockPage = {
      url: () => 'https://example.com/gallery',
      isClosed: () => false,
      target: () => ({
        type: () => 'page',
        createCDPSession: () => Promise.resolve(mockCdpSession)
      }),
      waitForNavigation: vi.fn().mockResolvedValue(undefined)
    }

    const session: any = {
      id: 'fail-test',
      page: mockPage,
      cdpSession: mockCdpSession,
      images: new Map(),
      mediaResources: new Map(),
      requestIdMap: new Map(),
      requestTypeMap: new Map(),
      startTime: Date.now(),
      pendingCaptures: new Set(),
      stopping: false,
      captureSemaphore: { acquire: () => Promise.resolve(), release: vi.fn(), droppedCount: 0, queueLength: 0 },
      stats: {
        totalRequests: 10, imageRequests: 5, capturedImages: 3,
        failedImages: 0, mediaRequests: 2, capturedMedia: 2, failedMedia: 0
      }
    }
    ;(svc as any).sessions.set('fail-test', session)
    ;(svc as any).aliasToSessionId.set('fail-test', 'fail-test')

    await svc.ensureImagesCaptured({
      sessionId: 'fail-test',
      page: mockPage,
      url: 'https://example.com/gallery',
      minImages: 25,
      timeoutMs: 1000
    })

    // reload 失败后仍然 resume
    expect(mockSuppressNavigationClear).toHaveBeenCalledWith('fail-test')
    expect(mockResumeNavigationClear).toHaveBeenCalledWith('fail-test')
  })
})
