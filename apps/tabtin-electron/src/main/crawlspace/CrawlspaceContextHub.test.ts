import { describe, expect, it, vi } from 'vitest'
import { getCrawlspaceContextHub } from './CrawlspaceContextHub'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'

describe('CrawlspaceContextHub', () => {
  it('updateViewMeta 会同步 themeColor，并支持显式清空', () => {
    const hub = getCrawlspaceContextHub()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId = 'view-1'

    hub.registerView(crawlspaceId, viewId, {
      title: 'Old title',
      url: 'https://old.example',
      favicon: 'old.ico',
      themeColor: '#ffffff',
    })

    hub.updateViewMeta(crawlspaceId, viewId, {
      title: 'New title',
      themeColor: '#123456',
    })

    let snapshot = hub.getSnapshot(crawlspaceId)
    expect(snapshot.views[0]).toMatchObject({
      viewId,
      title: 'New title',
      themeColor: '#123456',
      favicon: 'old.ico',
    })

    hub.updateViewMeta(crawlspaceId, viewId, {
      favicon: null,
      themeColor: null,
    })

    snapshot = hub.getSnapshot(crawlspaceId)
    expect(snapshot.views[0]?.favicon).toBeUndefined()
    expect(snapshot.views[0]?.themeColor).toBeUndefined()
  })

  it('themeColor 变化会进入 context-diff 字段集', () => {
    const hub = getCrawlspaceContextHub()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId = 'view-2'
    const listener = vi.fn()
    hub.on('context-diff', listener)

    try {
      hub.registerView(crawlspaceId, viewId, {
        title: 'View 2',
        url: 'https://example.com',
      })
      listener.mockClear()

      hub.updateViewMeta(crawlspaceId, viewId, {
        themeColor: '#654321',
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0]?.[0]).toMatchObject({
        crawlspaceId,
        views: [
          {
            viewId,
            fields: {
              themeColor: '#654321',
            },
          },
        ],
      })
    } finally {
      hub.off('context-diff', listener)
    }
  })

  it('updateViewMeta 在字段未变化时不会重复发出 diff', () => {
    const hub = getCrawlspaceContextHub()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId = 'view-3'
    const listener = vi.fn()
    hub.on('context-diff', listener)

    try {
      hub.registerView(crawlspaceId, viewId, {
        title: 'Stable title',
        url: 'https://stable.example',
        themeColor: '#101010',
      })
      listener.mockClear()

      hub.updateViewMeta(crawlspaceId, viewId, {
        title: 'Stable title',
        themeColor: '#101010',
      })

      expect(listener).not.toHaveBeenCalled()
    } finally {
      hub.off('context-diff', listener)
    }
  })

  it('setViewError 会把 hasError 和 errorDescription 放进 context-diff，并对重复错误保持幂等', () => {
    const hub = getCrawlspaceContextHub()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId = 'view-4'
    const listener = vi.fn()
    hub.on('context-diff', listener)

    try {
      hub.registerView(crawlspaceId, viewId, {
        title: 'Broken view',
        url: 'https://broken.example',
      })
      listener.mockClear()

      hub.setViewError(crawlspaceId, viewId, {
        errorDescription: 'Page failed to load',
      })

      expect(listener).toHaveBeenCalledTimes(1)
      expect(listener.mock.calls[0]?.[0]).toMatchObject({
        crawlspaceId,
        views: [
          {
            viewId,
            fields: {
              hasError: true,
              errorDescription: 'Page failed to load',
            },
          },
        ],
      })

      listener.mockClear()
      hub.setViewError(crawlspaceId, viewId, {
        errorDescription: 'Page failed to load',
      })

      expect(listener).not.toHaveBeenCalled()
    } finally {
      hub.off('context-diff', listener)
    }
  })

  it('setViewLoading 在状态未变化且没有额外清理动作时不会重复发出 diff', () => {
    const hub = getCrawlspaceContextHub()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId = 'view-5'
    const listener = vi.fn()
    hub.on('context-diff', listener)

    try {
      hub.registerView(crawlspaceId, viewId, {
        title: 'Loading view',
        url: 'https://loading.example',
      })

      hub.setViewLoading(crawlspaceId, viewId, true)
      listener.mockClear()

      hub.setViewLoading(crawlspaceId, viewId, true)

      expect(listener).not.toHaveBeenCalled()
    } finally {
      hub.off('context-diff', listener)
    }
  })

  it('CR-016 回归: setViewError 在 isClosing 时不更新', () => {
    const hub = getCrawlspaceContextHub()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId = 'view-cr016-err'
    const listener = vi.fn()
    hub.on('context-diff', listener)

    try {
      hub.registerView(crawlspaceId, viewId, {
        title: 'Error view',
        url: 'https://error.example',
      })

      hub.markViewClosing(crawlspaceId, viewId)
      listener.mockClear()

      hub.setViewError(crawlspaceId, viewId, {
        errorDescription: 'Page crashed',
      })

      expect(listener).not.toHaveBeenCalled()
      const snapshot = hub.getSnapshot(crawlspaceId)
      expect(snapshot.views[0]?.hasError).toBeFalsy()
    } finally {
      hub.off('context-diff', listener)
    }
  })

  it('CR-016 回归: updateViewResourceSummary 在 isClosing 时不更新', () => {
    const hub = getCrawlspaceContextHub()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId = 'view-cr016'
    const listener = vi.fn()
    hub.on('context-diff', listener)

    try {
      hub.registerView(crawlspaceId, viewId, {
        title: 'Resource view',
        url: 'https://resource.example',
      })

      hub.updateViewResourceSummary(crawlspaceId, viewId, {
        totalResources: 5,
        imageCount: 2,
        scriptCount: 3,
      } as any)

      let snapshot = hub.getSnapshot(crawlspaceId)
      expect(snapshot.views[0]?.resourceSummary).toMatchObject({ totalResources: 5 })

      hub.markViewClosing(crawlspaceId, viewId)
      listener.mockClear()

      hub.updateViewResourceSummary(crawlspaceId, viewId, {
        totalResources: 10,
        imageCount: 5,
        scriptCount: 5,
      } as any)

      expect(listener).not.toHaveBeenCalled()
      snapshot = hub.getSnapshot(crawlspaceId)
      expect(snapshot.views[0]?.resourceSummary).toMatchObject({ totalResources: 5 })
    } finally {
      hub.off('context-diff', listener)
    }
  })

  it('VL-004 回归：removeContext 联动 WTM clearTab，清除残留映射数据', () => {
    const hub = getCrawlspaceContextHub()
    const wtm = getOrganizationTabManager()
    const crawlspaceId = `cs-${Date.now()}-${Math.random()}`
    const viewId1 = 'view-vl004-a'
    const viewId2 = 'view-vl004-b'

    wtm.registerView(crawlspaceId, viewId1, { title: 'A', url: 'https://a.com', createdAt: 1 })
    wtm.registerView(crawlspaceId, viewId2, { title: 'B', url: 'https://b.com', createdAt: 2 })
    hub.registerView(crawlspaceId, viewId1, { title: 'A', url: 'https://a.com' })
    hub.registerView(crawlspaceId, viewId2, { title: 'B', url: 'https://b.com' })

    expect(wtm.getViewsByTab(crawlspaceId)).toHaveLength(2)
    expect(wtm.getTabByView(viewId1)).toBe(crawlspaceId)

    hub.removeContext(crawlspaceId)

    expect(wtm.getViewsByTab(crawlspaceId)).toEqual([])
    expect(wtm.getTabByView(viewId1)).toBeNull()
    expect(wtm.getTabByView(viewId2)).toBeNull()
    expect(wtm.getViewMetadata(viewId1)).toBeNull()
    expect(wtm.getViewMetadata(viewId2)).toBeNull()
  })
})
