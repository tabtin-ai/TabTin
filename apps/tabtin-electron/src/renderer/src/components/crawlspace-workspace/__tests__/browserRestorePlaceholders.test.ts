import { describe, expect, it } from 'vitest'
import { reconcileBrowserRestorePlaceholders } from '../browserRestorePlaceholders'

describe('reconcileBrowserRestorePlaceholders', () => {
  it('不会把 restore 期间已经创建并激活的 B 再标回 deferred', () => {
    const result = reconcileBrowserRestorePlaceholders({
      deferredTargets: [
        { viewId: 'view-b', url: 'https://b.example' },
        { viewId: 'view-c', url: 'https://c.example' },
      ],
      latestMainViews: [{
        viewId: 'view-b',
        title: 'B',
        url: 'https://b.example',
        isActive: true,
        updatedAt: 10,
      }],
      latestMainActiveViewId: 'view-b',
      currentCacheViews: [],
      currentCacheActiveViewId: 'view-a',
      resolvedActiveViewId: 'view-a',
      now: 20,
    })

    expect(result.activeViewId).toBe('view-b')
    expect(result.pendingDeferredTargets.map(view => view.viewId)).toEqual(['view-c'])
    expect(result.views.map(view => view.viewId)).toEqual(['view-b', 'view-c'])
    expect(result.views.filter(view => view.viewId === 'view-b')).toHaveLength(1)
  })

  it('main 明确无 active view 时不使用 renderer 的过时 active 值', () => {
    const result = reconcileBrowserRestorePlaceholders({
      deferredTargets: [],
      latestMainViews: [],
      latestMainActiveViewId: null,
      currentCacheViews: [],
      currentCacheActiveViewId: 'view-stale',
      resolvedActiveViewId: 'view-a',
      now: 20,
    })

    expect(result.activeViewId).toBeNull()
  })

  it('main 快照刷新失败时才回退到 renderer cache', () => {
    const result = reconcileBrowserRestorePlaceholders({
      deferredTargets: [{ viewId: 'view-c', url: 'https://c.example' }],
      latestMainViews: null,
      currentCacheViews: [{
        viewId: 'view-a',
        title: 'A',
        url: 'https://a.example',
        createdAt: 1,
      }],
      currentCacheActiveViewId: 'view-a',
      resolvedActiveViewId: 'view-stale',
      now: 20,
    })

    expect(result.activeViewId).toBe('view-a')
    expect(result.views.map(view => view.viewId)).toEqual(['view-a', 'view-c'])
  })
})
