import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockAttachCapturedContent = vi.fn()
vi.mock('../ResourceHubService', () => ({
  getResourceHubService: () => ({
    attachCapturedContent: mockAttachCapturedContent
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

const mockSession = { id: 'mock-partition-session' }
const mockSetHeader = vi.fn()
const mockRequestEnd = vi.fn()
const mockNetRequest = vi.fn(() => {
  const listeners: Record<string, Function> = {}
  return {
    setHeader: mockSetHeader,
    end: () => {
      process.nextTick(() => listeners['error']?.({ code: 'ERR_ABORTED' }))
    },
    on: vi.fn((event: string, cb: Function) => { listeners[event] = cb }),
    abort: vi.fn()
  }
})

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getPath: vi.fn(() => '/tmp'),
  },
  session: {
    defaultSession: {
      webRequest: {
        onCompleted: vi.fn()
      }
    }
  },
  net: {
    request: mockNetRequest
  },
  webContents: {
    fromId: vi.fn((id: number) => id === 42 ? { session: mockSession } : undefined)
  }
}))

describe('NetworkCaptureService', () => {
  let NetworkCaptureService: typeof import('../NetworkCaptureService').NetworkCaptureService
  let service: InstanceType<typeof NetworkCaptureService>

  beforeEach(async () => {
    vi.resetModules()
    vi.clearAllMocks()
    const mod = await import('../NetworkCaptureService')
    NetworkCaptureService = mod.NetworkCaptureService
    service = new NetworkCaptureService()
  })

  describe('startSession', () => {
    it('创建会话并可通过 hasSession 检查', () => {
      service.startSession('s1')
      expect(service.hasSession('s1')).toBe(true)
    })

    it('多个会话互不干扰', () => {
      service.startSession('s1')
      service.startSession('s2')
      expect(service.hasSession('s1')).toBe(true)
      expect(service.hasSession('s2')).toBe(true)
    })

    it('初始统计均为零', () => {
      service.startSession('s1')
      const stats = service.getSessionStats('s1')
      expect(stats).toEqual({ totalCount: 0, imageCount: 0, totalSize: 0 })
    })
  })

  describe('stopSession', () => {
    it('不存在的会话返回空数组', async () => {
      const result = await service.stopSession('not-exist')
      expect(result).toEqual([])
    })

    it('停止后会话被删除', async () => {
      service.startSession('s1')
      await service.stopSession('s1')
      expect(service.hasSession('s1')).toBe(false)
    })

    it('停止后 getSessionStats 返回 null', async () => {
      service.startSession('s1')
      await service.stopSession('s1')
      expect(service.getSessionStats('s1')).toBeNull()
    })

    it('对已停止的会话重复调用不崩溃', async () => {
      service.startSession('s1')
      await service.stopSession('s1')
      const result = await service.stopSession('s1')
      expect(result).toEqual([])
    })
  })

  describe('getSessionStats', () => {
    it('不存在的会话返回 null', () => {
      expect(service.getSessionStats('nonexistent')).toBeNull()
    })

    it('活跃会话返回初始统计对象', () => {
      service.startSession('s1')
      const stats = service.getSessionStats('s1')
      expect(stats).toMatchObject({ totalCount: 0, imageCount: 0, totalSize: 0 })
    })
  })

  describe('cleanup', () => {
    it('清理后所有会话均消失', async () => {
      service.startSession('s1')
      service.startSession('s2')
      await service.cleanup()
      expect(service.hasSession('s1')).toBe(false)
      expect(service.hasSession('s2')).toBe(false)
    })
  })

  describe('NC-002 fetchResponseBody session/Referer 回归', () => {
    it('传入 webContentsId 时 net.request 携带对应 session', async () => {
      mockNetRequest.mockClear()
      mockSetHeader.mockClear()

      await (service as any).fetchResponseBody(
        'https://cdn.example.com/image.jpg',
        'image/jpeg',
        { webContentsId: 42, referrer: 'https://example.com/page' }
      )

      expect(mockNetRequest).toHaveBeenCalledTimes(1)
      const opts = mockNetRequest.mock.calls[0][0]
      expect(opts.session).toBe(mockSession)
      expect(opts.url).toBe('https://cdn.example.com/image.jpg')
      expect(mockSetHeader).toHaveBeenCalledWith('Referer', 'https://example.com/page')
    })

    it('webContentsId 无效时 net.request 不传 session（降级到无 Cookie 请求）', async () => {
      mockNetRequest.mockClear()

      await (service as any).fetchResponseBody(
        'https://cdn.example.com/image.jpg',
        'image/jpeg',
        { webContentsId: 9999 }
      )

      expect(mockNetRequest).toHaveBeenCalledTimes(1)
      const opts = mockNetRequest.mock.calls[0][0]
      expect(opts.session).toBeUndefined()
    })

    it('未传 requestContext 时行为与旧版一致（无 session、无 Referer）', async () => {
      mockNetRequest.mockClear()
      mockSetHeader.mockClear()

      await (service as any).fetchResponseBody(
        'https://cdn.example.com/image.jpg',
        'image/jpeg'
      )

      expect(mockNetRequest).toHaveBeenCalledTimes(1)
      const opts = mockNetRequest.mock.calls[0][0]
      expect(opts.session).toBeUndefined()
      expect(mockSetHeader).not.toHaveBeenCalled()
    })
  })

  describe('RP-001 – captureResponseAsync 写入 ResourceHub 回归', () => {
    it('startSession 接受 viewId 配置', () => {
      service.startSession('s1', { viewId: 'view-abc' })
      expect(service.hasSession('s1')).toBe(true)
    })
  })

  describe('RP-008/DI-026 – fetchResponseBody 并发控制回归', () => {
    it('并发 fetch 受 semaphore 控制，不超过限制', async () => {
      let activeCalls = 0
      let peakConcurrency = 0

      mockNetRequest.mockImplementation(() => {
        activeCalls++
        peakConcurrency = Math.max(peakConcurrency, activeCalls)
        const listeners: Record<string, Function> = {}
        return {
          setHeader: vi.fn(),
          end: () => {
            setTimeout(() => {
              activeCalls--
              listeners['error']?.({ code: 'ERR_ABORTED' })
            }, 10)
          },
          on: vi.fn((event: string, cb: Function) => { listeners[event] = cb }),
          abort: vi.fn()
        }
      })

      const promises = []
      for (let i = 0; i < 12; i++) {
        promises.push(
          (service as any).acquireFetchSlot().then(() =>
            (service as any).fetchResponseBody(`https://cdn.example.com/img${i}.jpg`, 'image/jpeg')
              .finally(() => (service as any).releaseFetchSlot())
          )
        )
      }

      await Promise.allSettled(promises)
      expect(peakConcurrency).toBeLessThanOrEqual(6)
    })
  })
})
