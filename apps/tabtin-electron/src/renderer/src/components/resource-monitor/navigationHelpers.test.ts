import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ResourceMonitorTrackedItem } from './model'
import { resolveCrawlspaceIdForItem } from './navigationHelpers'

vi.mock('@stores/useCrawlTabStore', () => ({
  useCrawlTabStore: {
    getState: vi.fn(),
  },
}))

import { useCrawlTabStore } from '@stores/useCrawlTabStore'

function createBrowserItem(overrides: Partial<ResourceMonitorTrackedItem> = {}): ResourceMonitorTrackedItem {
  return {
    kind: 'browser',
    contextType: 'tabweb',
    id: 'view-1',
    title: 'Example',
    subtitle: 'Browser',
    cpu: 1,
    memory: 1024,
    spaceId: 'space-1',
    crawlspaceId: null,
    runId: null,
    status: 'idle',
    active: false,
    sharedProcessCount: 1,
    badgeLabel: 'Browser',
    tabKey: 'tabweb:view-1',
    ...overrides,
  }
}

describe('resolveCrawlspaceIdForItem', () => {
  beforeEach(() => {
    vi.mocked(useCrawlTabStore.getState).mockReturnValue({
      getSpaceCrawlspace: vi.fn(() => ({ id: 'cs-from-space' })),
    } as ReturnType<typeof useCrawlTabStore.getState>)
  })

  it('优先使用监控条目自带的 crawlspaceId', () => {
    const item = createBrowserItem({ crawlspaceId: 'cs-snapshot' })
    expect(resolveCrawlspaceIdForItem(item)).toBe('cs-snapshot')
  })

  it('快照缺失时回退到 Space 的 crawlspace', () => {
    const item = createBrowserItem({ crawlspaceId: null })
    expect(resolveCrawlspaceIdForItem(item)).toBe('cs-from-space')
    expect(useCrawlTabStore.getState().getSpaceCrawlspace).toHaveBeenCalledWith('space-1')
  })

  it('无 spaceId 且无 crawlspaceId 时返回 null', () => {
    const item = createBrowserItem({ spaceId: null, crawlspaceId: null })
    expect(resolveCrawlspaceIdForItem(item)).toBeNull()
  })
})
