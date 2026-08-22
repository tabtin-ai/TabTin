import { describe, expect, it, vi } from 'vitest'
import { resolveCrawlViewTabScope } from '../crawlViewTabScope'

describe('resolveCrawlViewTabScope', () => {
  it('优先使用 browserScopeKey，避免 desktop browser focus 写回 execution space', () => {
    const findSpaceByTabKey = vi.fn(() => 'space-execution')

    const scopeKey = resolveCrawlViewTabScope({
      tabKey: 'tabweb:view-1',
      config: {
        browserScopeKey: 'desktop:organization:wt-1:user:u-1',
        spaceId: 'space-execution',
      },
      tabsState: { findSpaceByTabKey },
    })

    expect(scopeKey).toBe('desktop:organization:wt-1:user:u-1')
    expect(findSpaceByTabKey).not.toHaveBeenCalled()
  })

  it('旧配置没有 browserScopeKey 时，通过 tabOrder 反查真实 tab scope', () => {
    const scopeKey = resolveCrawlViewTabScope({
      tabKey: 'tabweb:view-legacy',
      config: { spaceId: 'space-execution' },
      tabsState: {
        findSpaceByTabKey: vi.fn(() => 'desktop:organization:wt-1:user:u-1'),
      },
    })

    expect(scopeKey).toBe('desktop:organization:wt-1:user:u-1')
  })

  it('没有 scope 索引时回退到执行 Space，兼容旧 per-space browser', () => {
    const scopeKey = resolveCrawlViewTabScope({
      tabKey: 'tabweb:view-space',
      config: { spaceId: 'space-execution' },
      tabsState: {
        findSpaceByTabKey: vi.fn(() => null),
      },
    })

    expect(scopeKey).toBe('space-execution')
  })
})
