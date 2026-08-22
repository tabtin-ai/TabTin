/**
 * openResourceTab.silent.test.ts — PRD §4.14 / 红线 #10 回归
 *
 * 锁定 silent 参数契约：
 *   1. silent=false（默认）：写 activeKey + displayKey
 *   2. silent=true：tabOrder + items 仍写入，但 active/displayKey 不变
 *   3. silent=true + dedup 命中：现有实现里之前 dedup 路径会强行更新 active，
 *      v3 改成 silent=true 时即便命中 dedup 也不改 active（场景：聚合视图连点 3 行
 *      只第一次抢焦点，后续 silent 跳过）
 *
 * 测试用例覆盖 PRD §7.2-bis「决策 13」+「silent + dedup」验收条目。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}))

import { useSpaceContextTabsStore } from '../useSpaceContextTabsStore'

const SPACE = 'space-silent'

function resetStore() {
  useSpaceContextTabsStore.setState({
    activeKeyBySpace: {},
    displayKeyBySpace: {},
    tabOrderBySpace: {},
    itemsBySpace: {},
  })
}

beforeEach(() => resetStore())

describe('openResourceTab silent 参数', () => {
  it('silent=false 默认行为：写 active + 入 tabOrder', () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-1',
      title: 'first',
      meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
    })

    const s = useSpaceContextTabsStore.getState()
    expect(s.tabOrderBySpace[SPACE]).toContain('subagent_session:run-1')
    expect(s.activeKeyBySpace[SPACE]).toBe('subagent_session:run-1')
    // displayKey 仅在 tabweb:* 时同步（deriveDisplayKey 规则），subagent_session 不写入
    expect(s.displayKeyBySpace[SPACE] ?? null).toBeNull()
  })

  it('silent=true 新 tab：写 tabOrder + items，但不动 active', () => {
    // 预设当前 active 在另一个 tab 上
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'tabdata',
      id: 'table-1',
    })
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe('tabdata:table-1')

    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-silent',
      title: 'silent tab',
      meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
      silent: true,
    })

    const s = useSpaceContextTabsStore.getState()
    expect(s.tabOrderBySpace[SPACE]).toContain('subagent_session:run-silent')
    expect(s.itemsBySpace[SPACE]?.['subagent_session:run-silent']).toBeDefined()
    // active 仍指向原来那个 tab，不被 silent 抢走
    expect(s.activeKeyBySpace[SPACE]).toBe('tabdata:table-1')
  })

  it('silent=true + dedup 命中：item 已存在，仍不改 active（红线 #10）', () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-x',
      title: 'first open',
      meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
    })
    // 接着打开另一个 tab 把 active 切走
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'tabdata',
      id: 'other-table',
    })
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe('tabdata:other-table')

    // silent re-open 已存在的 subagent tab → active 应仍指向 tabdata
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-x',
      title: 'first open',
      meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
      silent: true,
    })

    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe('tabdata:other-table')
  })

  it('silent=false + dedup 命中且当前不是 active：active 切回该 tab', () => {
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-y',
      title: 'first',
      meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
    })
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'tabdata',
      id: 'table-2',
    })
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe('tabdata:table-2')

    // 非 silent 再次打开 → active 抢回 subagent tab
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-y',
      title: 'first',
      meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
    })
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe('subagent_session:run-y')
  })

  it('silent=true 连续打开多个：active 始终保持在最初 tab（聚合视图 silent 行为）', () => {
    // 模拟"第一次 drill-in 抢焦点"
    useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
      type: 'subagent_session',
      id: 'run-first',
      title: 'first',
      meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
    })
    expect(useSpaceContextTabsStore.getState().activeKeyBySpace[SPACE]).toBe('subagent_session:run-first')

    // 后续连开 3 个 silent —— active 不变
    for (const id of ['run-2', 'run-3', 'run-4']) {
      useSpaceContextTabsStore.getState().openResourceTab(SPACE, {
        type: 'subagent_session',
        id,
        title: id,
        meta: { kind: 'subagent_session', parentSessionId: 'sess-a' },
        silent: true,
      })
    }

    const s = useSpaceContextTabsStore.getState()
    expect(s.activeKeyBySpace[SPACE]).toBe('subagent_session:run-first')
    expect(s.tabOrderBySpace[SPACE]).toContain('subagent_session:run-2')
    expect(s.tabOrderBySpace[SPACE]).toContain('subagent_session:run-3')
    expect(s.tabOrderBySpace[SPACE]).toContain('subagent_session:run-4')
  })
})
