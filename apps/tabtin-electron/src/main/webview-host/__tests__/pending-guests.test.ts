/**
 * pending-guests 配对注册表测试
 *
 * 覆盖 review 关注的竞态：announce 未到 attach 先到、同 partition 多候选、
 * 同 tabId 重复 attach/bind、串号防护、guest 销毁后换绑。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { PendingGuestRegistry, type AnnouncedGuestConfig } from '../pending-guests'

const noopLog = (): void => {}

function makeAnnounce(overrides: Partial<AnnouncedGuestConfig> = {}): AnnouncedGuestConfig {
  return {
    tabId: 'tab-1',
    effectivePartition: 'persist:tabtin:env:default',
    expectedSession: { partition: 'persist:tabtin:env:default' },
    url: 'https://example.com',
    finalConfig: {},
    announcedAt: Date.now(),
    ...overrides,
  }
}

describe('PendingGuestRegistry', () => {
  let registry: PendingGuestRegistry

  beforeEach(() => {
    registry = new PendingGuestRegistry()
  })

  it('did-attach 配对：唯一 session 候选才取出', () => {
    const sessionA = { name: 'A' }
    registry.announce(makeAnnounce({ tabId: 't1', expectedSession: sessionA }), noopLog)

    // 不同 session 的 attach → 不配对（Tin guest / 未 announce 的 guest）
    expect(registry.takeSolePendingBySession({ name: 'other' })).toBeNull()
    // pending 仍在
    expect(registry.getPending('t1')).toBeDefined()

    // 相同 session 且唯一 → 取出
    const sole = registry.takeSolePendingBySession(sessionA)
    expect(sole?.tabId).toBe('t1')
    expect(registry.getPending('t1')).toBeUndefined()
  })

  it('did-attach 配对：同 session 多候选时不猜（防串号），留给 bind 兜底', () => {
    const shared = { name: 'shared' }
    registry.announce(makeAnnounce({ tabId: 't1', expectedSession: shared }), noopLog)
    registry.announce(makeAnnounce({ tabId: 't2', expectedSession: shared }), noopLog)

    expect(registry.takeSolePendingBySession(shared)).toBeNull()
    // 双双留存，等 renderer 按 tabId↔webContentsId 权威绑定
    expect(registry.getPending('t1')).toBeDefined()
    expect(registry.getPending('t2')).toBeDefined()

    const t1 = registry.takePendingByTabId('t1')
    expect(t1?.tabId).toBe('t1')
    expect(registry.getPending('t1')).toBeUndefined()
    expect(registry.getPending('t2')).toBeDefined()
  })

  it('attach 先到、announce 未到：无候选，不产生任何绑定', () => {
    expect(registry.takeSolePendingBySession({ name: 'x' })).toBeNull()
  })

  it('重复 announce：覆盖旧 pending 并告警', () => {
    const warnings: string[] = []
    registry.announce(makeAnnounce({ tabId: 't1', url: 'https://a.com' }), (m) => warnings.push(m))
    registry.announce(makeAnnounce({ tabId: 't1', url: 'https://b.com' }), (m) => warnings.push(m))
    expect(warnings.length).toBe(1)
    expect(registry.getPending('t1')?.url).toBe('https://b.com')
  })

  it('同 tabId 重复绑定：旧绑定未释放时拒绝', () => {
    const s = { name: 's' }
    expect(registry.registerBinding({ tabId: 't1', webContentsId: 100, session: s }).ok).toBe(true)
    const second = registry.registerBinding({ tabId: 't1', webContentsId: 200, session: s })
    expect(second.ok).toBe(false)
  })

  it('同 guest 绑到第二个 tab：拒绝（webContentsId 已被占用）', () => {
    const s = { name: 's' }
    expect(registry.registerBinding({ tabId: 't1', webContentsId: 100, session: s }).ok).toBe(true)
    const second = registry.registerBinding({ tabId: 't2', webContentsId: 100, session: s })
    expect(second.ok).toBe(false)
  })

  it('guest 销毁释放绑定后允许换绑（crash 重建元素场景）', () => {
    const s = { name: 's' }
    expect(registry.registerBinding({ tabId: 't1', webContentsId: 100, session: s }).ok).toBe(true)
    registry.releaseBinding('t1')
    expect(registry.getBinding('t1')).toBeUndefined()
    expect(registry.getTabIdByWebContentsId(100)).toBeUndefined()
    expect(registry.registerBinding({ tabId: 't1', webContentsId: 200, session: s }).ok).toBe(true)
  })

  it('discardPending：renderer 放弃创建时清理登记', () => {
    registry.announce(makeAnnounce({ tabId: 't1' }), noopLog)
    registry.discardPending('t1')
    expect(registry.getPending('t1')).toBeUndefined()
  })

  describe('getAllPendingLocalPreviewRoots', () => {
    it('仅收集带 localPreviewRoot 的 pending，去重且不含空值', () => {
      registry.announce(makeAnnounce({ tabId: 't1', localPreviewRoot: '/work/space-a' }), noopLog)
      registry.announce(makeAnnounce({ tabId: 't2', localPreviewRoot: '/work/space-a' }), noopLog)
      registry.announce(makeAnnounce({ tabId: 't3', localPreviewRoot: '/work/space-b' }), noopLog)
      registry.announce(makeAnnounce({ tabId: 't4' }), noopLog) // 普通网页 guest，无 root
      expect(registry.getAllPendingLocalPreviewRoots().sort()).toEqual(['/work/space-a', '/work/space-b'])
    })

    it('配对取走后不再计入（did-attach / bind 后 pending 已删除）', () => {
      const s = { name: 's' }
      registry.announce(makeAnnounce({ tabId: 't1', expectedSession: s, localPreviewRoot: '/work/space-a' }), noopLog)
      expect(registry.getAllPendingLocalPreviewRoots()).toEqual(['/work/space-a'])
      registry.takeSolePendingBySession(s)
      expect(registry.getAllPendingLocalPreviewRoots()).toEqual([])
    })

    it('无 pending 时返回空数组', () => {
      expect(registry.getAllPendingLocalPreviewRoots()).toEqual([])
    })
  })
})
