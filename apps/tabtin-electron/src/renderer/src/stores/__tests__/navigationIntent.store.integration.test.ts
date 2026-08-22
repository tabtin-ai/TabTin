import { beforeEach, describe, expect, it } from 'vitest'
import { useSpaceContextTabsStore } from '../useSpaceContextTabsStore'
import { buildContextTabsSignature } from '../workbenchRestoreSignature'

const SCOPE = 'desktop:organization:org-nav:user:u-nav'

describe('navigation intent store integration', () => {
  beforeEach(() => {
    useSpaceContextTabsStore.getState().clearSpaceTabs(SCOPE)
    useSpaceContextTabsStore.setState({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      lastActiveSubagentByParentSession: {},
    })
  })

  it('用户打开资源后 restore 不得把 active 打回 browser', () => {
    const store = useSpaceContextTabsStore.getState()
    store.openResourceTab(SCOPE, { type: 'tabdoc', id: 'doc-1', title: 'Doc' })
    expect(store.getActiveKey(SCOPE)).toBe('tabdoc:doc-1')
    const rev = store.getNavigationRevision(SCOPE)
    expect(rev).toBeGreaterThan(0)

    const s = useSpaceContextTabsStore.getState()
    const signature = buildContextTabsSignature({
      activeKey: s.activeKeyBySpace[SCOPE] ?? null,
      displayKey: s.displayKeyBySpace[SCOPE] ?? null,
      tabOrder: s.tabOrderBySpace[SCOPE] ?? [],
      items: s.itemsBySpace[SCOPE] ?? {},
    })

    const items = { ...(s.itemsBySpace[SCOPE] ?? {}) }
    items['tabweb:old'] = {
      tabKey: 'tabweb:old',
      type: 'tabweb',
      id: 'old',
      title: 'Old',
    }
    const applied = useSpaceContextTabsStore.getState().applyRestoreDecision(
      SCOPE,
      {
        tabOrder: ['tabweb:old', 'tabdoc:doc-1'],
        items: {
          ...items,
          'tabdoc:doc-1': items['tabdoc:doc-1'],
        },
        activeKey: 'tabweb:old',
        displayKey: 'tabweb:old',
      },
      signature,
    )
    expect(applied).toBe(true)
    expect(useSpaceContextTabsStore.getState().getActiveKey(SCOPE)).toBe('tabdoc:doc-1')
    expect(useSpaceContextTabsStore.getState().getNavigationRevision(SCOPE)).toBe(rev)
  })

  it('openHome 后 restore 不得把 null 打回 first_restorable_tab', () => {
    const store = useSpaceContextTabsStore.getState()
    store.openResourceTab(SCOPE, { type: 'tabdoc', id: 'doc-a', title: 'A' })
    store.openResourceTab(SCOPE, { type: 'tabdata', id: 'table-b', title: 'B' })
    expect(store.getActiveKey(SCOPE)).toBe('tabdata:table-b')

    const homeApplied = useSpaceContextTabsStore.getState().setActiveKey(
      SCOPE,
      null,
      { writer: 'user', reason: 'openHome' },
    )
    expect(homeApplied).toBe(true)
    expect(useSpaceContextTabsStore.getState().getActiveKey(SCOPE)).toBeNull()

    const s = useSpaceContextTabsStore.getState()
    const signature = buildContextTabsSignature({
      activeKey: s.activeKeyBySpace[SCOPE] ?? null,
      displayKey: s.displayKeyBySpace[SCOPE] ?? null,
      tabOrder: s.tabOrderBySpace[SCOPE] ?? [],
      items: s.itemsBySpace[SCOPE] ?? {},
    })
    const items = { ...(s.itemsBySpace[SCOPE] ?? {}) }
    const order = [...(s.tabOrderBySpace[SCOPE] ?? [])]

    const applied = useSpaceContextTabsStore.getState().applyRestoreDecision(
      SCOPE,
      {
        tabOrder: order,
        items,
        activeKey: 'tabdoc:doc-a',
        displayKey: null,
      },
      signature,
    )

    expect(applied).toBe(true)
    expect(useSpaceContextTabsStore.getState().getActiveKey(SCOPE)).toBeNull()
    expect(useSpaceContextTabsStore.getState().tabOrderBySpace[SCOPE]).toEqual(order)
  })

  it('async_completion 在 revision 过期后拒绝抢焦点', () => {
    const store = useSpaceContextTabsStore.getState()
    store.openTableTab(SCOPE, 'table-1', true)
    const revAtStart = store.getNavigationRevision(SCOPE)
    store.openResourceTab(SCOPE, { type: 'tabdoc', id: 'doc-2', title: 'D2' })
    const blocked = useSpaceContextTabsStore.getState().setActiveKey(
      SCOPE,
      'tabweb:v1',
      {
        writer: 'async_completion',
        reason: 'stale-browser',
        expectedRevision: revAtStart,
      },
    )
    expect(blocked).toBe(false)
    expect(useSpaceContextTabsStore.getState().getActiveKey(SCOPE)).toBe('tabdoc:doc-2')
  })

  it('self-heal 不因 items 瞬时缺失删除用户目标 order', () => {
    const store = useSpaceContextTabsStore.getState()
    store.openResourceTab(SCOPE, { type: 'tabdoc', id: 'doc-3', title: 'D3' })
    useSpaceContextTabsStore.setState((s) => ({
      itemsBySpace: {
        ...s.itemsBySpace,
        [SCOPE]: {},
      },
      tabOrderBySpace: {
        ...s.tabOrderBySpace,
        [SCOPE]: ['tabdoc:doc-3'],
      },
      activeKeyBySpace: {
        ...s.activeKeyBySpace,
        [SCOPE]: 'tabdoc:doc-3',
      },
    }))
    // 触发 assertTripleConsistency（另一资源 silent open）
    useSpaceContextTabsStore.getState().openResourceTab(SCOPE, {
      type: 'tabdata',
      id: 't-probe',
      title: 'probe',
      silent: true,
    })
    const order = useSpaceContextTabsStore.getState().tabOrderBySpace[SCOPE] ?? []
    expect(order).toContain('tabdoc:doc-3')
    expect(useSpaceContextTabsStore.getState().getActiveKey(SCOPE)).toBe('tabdoc:doc-3')
  })
})
