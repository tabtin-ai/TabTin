/**
 * clearOrphanSubagentTabs.test.ts — PRD §4.13 / P1-E 回归
 *
 * 锁定父 session 删除后的 orphan 清理契约：
 *   1. clearOrphanSubagentTabs(spaceId, sessionId) 只清「meta.parentSessionId === sessionId」
 *      且 type === 'subagent_session' 的 tab
 *   2. 不动其他 type 的 tab（哪怕 meta.parentSessionId 同名）
 *   3. 不动其他 session 的 subagent tab（兄弟 session 不被牵连）
 *   4. orphan 同时是 active → 自动 fallback 到剩余的第一个 tab
 *   5. spaceId / sessionId 缺失 / 空 → 安静 noop（防御性）
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { useSpaceContextTabsStore } from '../useSpaceContextTabsStore'

const SPACE = 'space-clean'
const SESSION_A = 'sess-a'
const SESSION_B = 'sess-b'

function resetStore() {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
  })
}

function openSubagentTab(id: string, parentSessionId: string) {
  useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
    type: 'subagent_session',
    id,
    title: `Subagent ${id}`,
    meta: { kind: 'subagent_session', parentSessionId },
  })
}

beforeEach(() => resetStore())

describe('clearOrphanSubagentTabs', () => {
  it('清掉 parentSessionId 命中的 subagent tab、保留其他 tab', () => {
    openSubagentTab('run-a1', SESSION_A)
    openSubagentTab('run-a2', SESSION_A)
    openSubagentTab('run-b1', SESSION_B)
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, { type: 'tabdata', id: 't1' })

    useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(SPACE, SESSION_A)

    const s = useSpaceContextTabsStore.getState()
    const order = s.tabOrderBySpace[SPACE] ?? []
    expect(order).not.toContain('subagent_session:run-a1')
    expect(order).not.toContain('subagent_session:run-a2')
    expect(order).toContain('subagent_session:run-b1')
    expect(order).toContain('tabdata:t1')
    expect(s.itemsBySpace[SPACE]?.['subagent_session:run-a1']).toBeUndefined()
    expect(s.itemsBySpace[SPACE]?.['subagent_session:run-b1']).toBeDefined()
  })

  it('当 orphan 是 active：fallback 到剩余 tab（active 不再指向 orphan）', () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, { type: 'tabdata', id: 'first' })
    openSubagentTab('run-active', SESSION_A)
    // 接着打开后让 active 自然指向最后打开的 subagent
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe('subagent_session:run-active')

    useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(SPACE, SESSION_A)

    const s = useSpaceContextTabsStore.getState()
    expect(s.activeKeyBySpace[SPACE]).not.toBe('subagent_session:run-active')
    expect(s.activeKeyBySpace[SPACE]).toBe('tabdata:first')
  })

  it('其他 session 的 subagent tab 不被牵连', () => {
    openSubagentTab('keep-1', SESSION_B)
    openSubagentTab('clear-1', SESSION_A)

    useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(SPACE, SESSION_A)

    const order = useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE] ?? []
    expect(order).toContain('subagent_session:keep-1')
    expect(order).not.toContain('subagent_session:clear-1')
  })

  it('空 spaceId / 空 sessionId / 不存在的 space → noop 不抛', () => {
    openSubagentTab('run-1', SESSION_A)

    expect(() => useSpaceContextTabsStore.getState().clearOrphanSubagentTabs('', SESSION_A)).not.toThrow()
    expect(() => useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(SPACE, '')).not.toThrow()
    expect(() => useSpaceContextTabsStore.getState().clearOrphanSubagentTabs('non-existent', SESSION_A)).not.toThrow()

    expect(useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]).toContain('subagent_session:run-1')
  })

  it('非 subagent_session type 的 tab 即便 meta.parentSessionId 同名也不清', () => {
    // 极端边角：另一个 type 的 tab 也带了同名 parentSessionId（理论上不该有，防御断言）
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'tabdata',
      id: 'fake',
      meta: { parentSessionId: SESSION_A } as Record<string, unknown>,
    })

    useSpaceContextTabsStore.getState().clearOrphanSubagentTabs(SPACE, SESSION_A)

    expect(useSpaceContextTabsStore.getState().tabOrderBySpace[SPACE]).toContain('tabdata:fake')
  })
})
