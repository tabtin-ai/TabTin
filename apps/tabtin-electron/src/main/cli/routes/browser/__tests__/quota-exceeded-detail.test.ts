import { describe, expect, it } from 'vitest'
import {
  buildBrowserQuotaExceededOptions,
  MISLEADING_TAB_LIST_SUGGESTION,
} from '../quota-exceeded-payload'
import type { ViewQuotaSnapshotItem } from '../../../../view-factory/view-quota-summary'

function item(
  overrides: ViewQuotaSnapshotItem & { viewId: string; profile: string },
): ViewQuotaSnapshotItem {
  return overrides
}

describe('buildBrowserQuotaExceededOptions', () => {
  it('attaches quota detail with limit and tab close suggestions', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'a1', profile: 'agent-workspace', title: 'Agent tab' }),
      item({ viewId: 'u1', profile: 'user-tab', title: 'User tab' }),
    ]

    const opts = buildBrowserQuotaExceededOptions({
      limit: 50,
      cleaned: 0,
      items,
      currentCrawlspaceId: 'space-a',
    })

    expect(opts.detail.quota.limit).toBe(50)
    expect(opts.detail.quota.used).toBe(2)
    expect(opts.detail.quota.cleaned).toBe(0)
    expect(opts.detail.quota.by_profile).toEqual({
      'agent-workspace': 1,
      'user-tab': 1,
    })
    expect(opts.detail.quota.reclaimable.map(r => r.viewId)).toEqual(['a1', 'u1'])
    expect(opts.suggestions.some(s => s.includes('tab close --tab-id a1'))).toBe(true)
    expect(opts.suggestions.some(s => s.includes('tab list'))).toBe(true)
    expect(opts.suggestions.some(s => s.includes('open --tab-id'))).toBe(true)
  })

  it('does not include misleading tab list as sole fix for global quota', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'a1', profile: 'agent-workspace' }),
    ]

    const opts = buildBrowserQuotaExceededOptions({
      limit: 50,
      cleaned: 0,
      items,
    })

    expect(opts.suggestions).not.toContain(MISLEADING_TAB_LIST_SUGGESTION)
    expect(
      opts.suggestions.some(s => s.includes('查看已有标签并优先复用')),
    ).toBe(false)
  })

  it('omits tab close suggestion when nothing is reclaimable', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'x1', profile: 'custom-profile' }),
    ]

    const opts = buildBrowserQuotaExceededOptions({
      limit: 50,
      cleaned: 0,
      items,
    })

    expect(opts.detail.quota.reclaimable).toHaveLength(0)
    expect(opts.suggestions.some(s => s.includes('tab close'))).toBe(false)
    expect(opts.suggestions).toHaveLength(1)
    expect(opts.suggestions[0]).toContain('tab list')
  })

  it('mentions up to three reclaimable viewIds in close suggestion', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'a1', profile: 'agent-workspace' }),
      item({ viewId: 'a2', profile: 'background-task' }),
      item({ viewId: 'a3', profile: 'temporary-preview' }),
      item({ viewId: 'a4', profile: 'agent-workspace' }),
    ]

    const opts = buildBrowserQuotaExceededOptions({
      limit: 50,
      cleaned: 0,
      items,
    })

    const closeSuggestion = opts.suggestions.find(s => s.includes('tab close'))
    expect(closeSuggestion).toBeDefined()
    expect(closeSuggestion).toContain('a1')
    expect(closeSuggestion).toContain('a2')
    expect(closeSuggestion).toContain('a3')
    expect(closeSuggestion).not.toContain('a4')
  })
})
