/**
 * view-quota-summary 纯函数单元测试
 */

import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  powerMonitor: { getSystemIdleTime: vi.fn() },
  webContents: { fromId: vi.fn() },
}))

import {
  buildViewQuotaSummary,
  type ViewQuotaSnapshotItem,
} from '../view-quota-summary'

function item(
  overrides: ViewQuotaSnapshotItem & { viewId: string; profile: string },
): ViewQuotaSnapshotItem {
  return overrides
}

describe('buildViewQuotaSummary', () => {
  it('counts used and by_profile across mixed profiles', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'u1', profile: 'user-tab' }),
      item({ viewId: 'u2', profile: 'user-tab' }),
      item({ viewId: 'a1', profile: 'agent-workspace' }),
      item({ viewId: 'p1', profile: 'temporary-preview' }),
      item({ viewId: 'b1', profile: 'background-task' }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 2,
      items,
      currentCrawlspaceId: 'space-a',
    })

    expect(summary.limit).toBe(50)
    expect(summary.cleaned).toBe(2)
    expect(summary.used).toBe(5)
    expect(summary.by_profile).toEqual({
      'user-tab': 2,
      'agent-workspace': 1,
      'temporary-preview': 1,
      'background-task': 1,
    })
  })

  it('does not count discarded items in used or by_profile', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'active', profile: 'user-tab' }),
      item({ viewId: 'gone', profile: 'user-tab', discarded: true }),
      item({ viewId: 'gone-agent', profile: 'agent-workspace', discarded: true }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
    })

    expect(summary.used).toBe(1)
    expect(summary.by_profile).toEqual({ 'user-tab': 1 })
  })

  it('prioritizes non user-tab reclaimable profiles before user-tab', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'u1', profile: 'user-tab', title: 'User 1' }),
      item({ viewId: 'a1', profile: 'agent-workspace', title: 'Agent 1' }),
      item({ viewId: 'u2', profile: 'user-tab', title: 'User 2' }),
      item({ viewId: 'p1', profile: 'temporary-preview', title: 'Preview 1' }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
      reclaimableLimit: 10,
    })

    expect(summary.reclaimable.map(r => r.viewId)).toEqual(['a1', 'p1', 'u1', 'u2'])
    expect(summary.reclaimable[0].profile).toBe('agent-workspace')
    expect(summary.reclaimable[1].profile).toBe('temporary-preview')
  })

  it('caps reclaimable at default limit of 10', () => {
    const items: ViewQuotaSnapshotItem[] = [
      ...Array.from({ length: 12 }, (_, i) =>
        item({ viewId: `a${i}`, profile: 'agent-workspace' }),
      ),
      ...Array.from({ length: 5 }, (_, i) =>
        item({ viewId: `u${i}`, profile: 'user-tab' }),
      ),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
    })

    expect(summary.reclaimable).toHaveLength(10)
    expect(summary.reclaimable.every(r => r.profile !== 'user-tab')).toBe(true)
    expect(summary.reclaimable.map(r => r.viewId)).toEqual([
      'a0', 'a1', 'a2', 'a3', 'a4', 'a5', 'a6', 'a7', 'a8', 'a9',
    ])
  })

  it('fills with user-tab when reclaimable profiles are fewer than limit', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'a1', profile: 'agent-workspace' }),
      item({ viewId: 'u1', profile: 'user-tab' }),
      item({ viewId: 'u2', profile: 'user-tab' }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
      reclaimableLimit: 3,
    })

    expect(summary.reclaimable.map(r => r.viewId)).toEqual(['a1', 'u1', 'u2'])
  })

  it('respects custom reclaimableLimit', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'a1', profile: 'agent-workspace' }),
      item({ viewId: 'a2', profile: 'background-task' }),
      item({ viewId: 'u1', profile: 'user-tab' }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
      reclaimableLimit: 2,
    })

    expect(summary.reclaimable).toHaveLength(2)
    expect(summary.reclaimable.map(r => r.viewId)).toEqual(['a1', 'a2'])
  })

  it('sets in_current_space from crawlspaceId match', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({
        viewId: 'in-space',
        profile: 'agent-workspace',
        crawlspaceId: 'space-a',
      }),
      item({
        viewId: 'other-space',
        profile: 'agent-workspace',
        crawlspaceId: 'space-b',
      }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
      currentCrawlspaceId: 'space-a',
    })

    const inSpace = summary.reclaimable.find(r => r.viewId === 'in-space')
    const otherSpace = summary.reclaimable.find(r => r.viewId === 'other-space')

    expect(inSpace?.in_current_space).toBe(true)
    expect(otherSpace?.in_current_space).toBe(false)
  })

  it('excludes discarded items from reclaimable', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'active', profile: 'agent-workspace' }),
      item({ viewId: 'discarded', profile: 'agent-workspace', discarded: true }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
    })

    expect(summary.reclaimable.map(r => r.viewId)).toEqual(['active'])
  })

  it('does not list unknown profiles in reclaimable', () => {
    const items: ViewQuotaSnapshotItem[] = [
      item({ viewId: 'custom', profile: 'custom-profile' }),
      item({ viewId: 'u1', profile: 'user-tab' }),
    ]

    const summary = buildViewQuotaSummary({
      limit: 50,
      cleaned: 0,
      items,
    })

    expect(summary.reclaimable.map(r => r.viewId)).toEqual(['u1'])
    expect(summary.by_profile['custom-profile']).toBe(1)
  })
})
