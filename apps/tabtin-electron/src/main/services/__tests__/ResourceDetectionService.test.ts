import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const defaultSession = {
    webRequest: {
      onCompleted: vi.fn(),
    },
  }
  return {
    defaultSession,
  }
})

vi.mock('electron', () => ({
  session: {
    defaultSession: mocks.defaultSession,
  },
  webContents: {
    fromId: () => null,
  },
}))

import { resetResourceHubService } from '../ResourceHubService'
import { ResourceDetectionService } from '../ResourceDetectionService'

describe('ResourceDetectionService', () => {
  beforeEach(() => {
    resetResourceHubService()
    mocks.defaultSession.webRequest.onCompleted.mockReset()
  })

  afterEach(() => {
    resetResourceHubService()
  })

  it('为持久化 crawlspace session 记录带 persist 前缀的 partition', () => {
    const service = new ResourceDetectionService()
    const partition = (service as any).resolveSessionPartition(
      {
        storagePath: '/Users/developer/Library/Application Support/tabtin-electron/Partitions/tabtin%3Acrawlspace%3Acs-1',
      },
      'tabtin:crawlspace:cs-1'
    )

    expect(partition).toBe('persist:tabtin:crawlspace:cs-1')
  })

  it('网络事件会补全 probe 资源的请求头与认证上下文', () => {
    const service = new ResourceDetectionService()
    const mockSession = {
      storagePath: '/Users/developer/Library/Application Support/tabtin-electron/Partitions/tabtin%3Acrawlspace%3Acs-1',
      webRequest: {
        onCompleted: vi.fn(),
      },
    }

    const view = {
      webContents: {
        id: 7,
        session: mockSession,
        isDestroyed: () => false,
        getURL: () => 'https://example.com/page',
        on: vi.fn(),
        once: vi.fn(),
      },
    } as any

    // : registerView 已收窄为直接收 WebContents
    service.registerView('view-1', view.webContents, {
      partition: 'tabtin:crawlspace:cs-1',
    })

    service.addExternalResource('view-1', {
      url: 'https://cdn.example.com/video.mp4',
      category: 'video',
      statusCode: 200,
      method: 'GET',
      source: 'dom_probe',
      mediaElementInfo: {
        tagName: 'video',
      } as any,
    })

    service.handleDefaultSessionRequest({
      url: 'https://cdn.example.com/video.mp4',
      statusCode: 200,
      method: 'GET',
      responseHeaders: {
        'content-type': ['video/mp4'],
      },
      requestHeaders: {
        Referer: 'https://example.com/page',
        Origin: 'https://example.com',
        Cookie: 'sid=123',
      },
      webContentsId: 7,
    } as any)

    const [resource] = service.getResources('view-1')
    expect(resource.source).toBe('network')
    expect(resource.requestHeaders).toMatchObject({
      Referer: 'https://example.com/page',
      Origin: 'https://example.com',
    })
    expect(resource.authContextRef).toMatchObject({
      sessionPartition: 'persist:tabtin:crawlspace:cs-1',
      requiresHeaders: true,
    })
    expect(resource.authContextRef?.headerNames).toEqual(
      expect.arrayContaining(['Referer', 'Origin'])
    )

    service.cleanup()
  })

  describe('NC-006 – suppressNavigationClear 防止 reload 丢失检测数据', () => {
    function createServiceWithView() {
      const service = new ResourceDetectionService()
      const mockSession = {
        storagePath: '/tmp/partitions/persist%3Atest',
        webRequest: { onCompleted: vi.fn() },
      }
      const view = {
        webContents: {
          id: 42,
          session: mockSession,
          isDestroyed: () => false,
          getURL: () => 'https://example.com/page',
          on: vi.fn(),
          once: vi.fn(),
        },
      } as any

      service.registerView('view-reload', view.webContents, { partition: 'test' })

      service.addExternalResource('view-reload', {
        url: 'https://cdn.example.com/video.mp4',
        category: 'video',
        statusCode: 200,
        method: 'GET',
        source: 'dom_probe',
      })
      service.addExternalResource('view-reload', {
        url: 'https://cdn.example.com/doc.pdf',
        category: 'document',
        statusCode: 200,
        method: 'GET',
        source: 'network',
      })

      return { service, view }
    }

    it('suppressNavigationClear 后导航不清空资源', () => {
      const { service } = createServiceWithView()

      const beforeResources = service.getResources('view-reload')
      expect(beforeResources.length).toBe(2)

      service.suppressNavigationClear('view-reload')
      ;(service as any).handleNavigation('view-reload', 'https://example.com/page?reload=1')

      const afterResources = service.getResources('view-reload')
      expect(afterResources.length).toBe(2)

      service.cleanup()
    })

    it('resumeNavigationClear 后导航正常清空资源', () => {
      const { service } = createServiceWithView()

      service.suppressNavigationClear('view-reload')
      ;(service as any).handleNavigation('view-reload', 'https://example.com/page?r=1')

      expect(service.getResources('view-reload').length).toBe(2)

      service.resumeNavigationClear('view-reload')
      ;(service as any).handleNavigation('view-reload', 'https://other.com/new-page')

      expect(service.getResources('view-reload').length).toBe(0)

      service.cleanup()
    })

    it('未调用 suppress 时导航正常清空', () => {
      const { service } = createServiceWithView()

      expect(service.getResources('view-reload').length).toBe(2)
      ;(service as any).handleNavigation('view-reload', 'https://other.com/new')

      expect(service.getResources('view-reload').length).toBe(0)

      service.cleanup()
    })

    it('cleanup 清理 navigationSuppressed 集合', () => {
      const { service } = createServiceWithView()

      service.suppressNavigationClear('view-reload')
      expect((service as any).navigationSuppressed.size).toBe(1)

      service.cleanup()
      expect((service as any).navigationSuppressed.size).toBe(0)
    })

    it('getViewIdByWebContentsId 正确返回映射的 viewId', () => {
      const { service } = createServiceWithView()

      expect(service.getViewIdByWebContentsId(42)).toBe('view-reload')
      expect(service.getViewIdByWebContentsId(999)).toBeUndefined()

      service.cleanup()
    })
  })
})
