/**
 * useCanvasLayoutStore.closePane 单 pane 保留回归测试
 *
 * W4 D-W4-1/D-W4-2 不变量：
 *   - 关闭后仍有内容 pane：group 保留（panes / layout / anchorTabKey / activePaneId 正确更新）
 *   - 关闭后不再有内容 pane：group 销毁（即使仍有空 pane）
 *   - 0-pane 销毁不影响其他 Space 的 spaceGroups
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { useCanvasLayoutStore } from '../useCanvasLayoutStore'
import { migrateCanvasLayout } from '../canvasLayout/migration'
import { buildCanvasLayoutSignature } from '../workbenchRestoreSignature'

function resetStore() {
  useCanvasLayoutStore.setState({ spaceGroups: {} })
}

function seedGroup(spaceId: string, groupId: string, panes: Array<{ id: string; tabKey: string | null }>, activePaneId?: string) {
  const panesToStore = panes.map(p => ({
    id: p.id,
    content: p.tabKey ? { tabKey: p.tabKey } : null,
  }))
  const group = {
    id: groupId,
    spaceId,
    anchorTabKey: panes.find(p => p.tabKey)?.tabKey ?? null,
    panes: panesToStore,
    layout: panes.length <= 1
      ? { type: 'leaf' as const, paneId: panes[0]?.id || 'x' }
      : {
          type: 'split' as const,
          id: 'split-test',
          direction: 'horizontal' as const,
          children: panesToStore.map(p => ({ type: 'leaf' as const, paneId: p.id })),
          sizes: panesToStore.map(() => 1 / panesToStore.length),
        },
    activePaneId: activePaneId ?? panes[0]?.id ?? null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  }
  useCanvasLayoutStore.setState(state => ({
    spaceGroups: {
      ...state.spaceGroups,
      [spaceId]: [...(state.spaceGroups[spaceId] ?? []), group],
    },
  }))
  return group
}

describe('useCanvasLayoutStore.closePane — W4 单 pane 保留', () => {
  beforeEach(resetStore)

  it('2→1：group 仍在，panes.length === 1', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
      { id: 'p2', tabKey: 'tabweb:b' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p1')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? []
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(1)
    expect(groups[0].panes[0].id).toBe('p2')
  })

  it('1→0：group 销毁', () => {
    seedGroup('sp-1', 'g1', [{ id: 'p1', tabKey: 'tabweb:a' }], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p1')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? []
    expect(groups).toHaveLength(0)
  })

  it('0-pane 销毁不影响其他 Space 的 spaceGroups', () => {
    seedGroup('sp-1', 'g1', [{ id: 'p1', tabKey: 'tabweb:a' }], 'p1')
    seedGroup('sp-2', 'g2', [
      { id: 'p3', tabKey: 'tabweb:c' },
      { id: 'p4', tabKey: 'tabweb:d' },
    ], 'p3')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p1')

    expect(useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? []).toHaveLength(0)
    expect(useCanvasLayoutStore.getState().spaceGroups['sp-2'] ?? []).toHaveLength(1)
    expect(useCanvasLayoutStore.getState().spaceGroups['sp-2']![0].panes).toHaveLength(2)
  })

  it('2→1 时 anchorTabKey 在关闭 anchor pane 后重新指向剩余 pane', () => {
    const group = seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:anchor' },
      { id: 'p2', tabKey: 'tabweb:other' },
    ], 'p1')
    expect(group.anchorTabKey).toBe('tabweb:anchor')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p1')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups[0].anchorTabKey).toBe('tabweb:other')
  })

  it('2→1 时关闭非 anchor pane，anchorTabKey 不变', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:anchor' },
      { id: 'p2', tabKey: 'tabweb:other' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p2')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups[0].anchorTabKey).toBe('tabweb:anchor')
  })

  it('2→1 时 activePaneId 在关闭 active pane 后 fallback 到剩余 pane', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
      { id: 'p2', tabKey: 'tabweb:b' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p1')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups[0].activePaneId).toBe('p2')
  })

  it('2→1 时关闭非 active pane，activePaneId 不变', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
      { id: 'p2', tabKey: 'tabweb:b' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p2')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups[0].activePaneId).toBe('p1')
  })

  it('2→1 时 layout 简化为 leaf 节点', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
      { id: 'p2', tabKey: 'tabweb:b' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p1')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups[0].layout).toEqual({ type: 'leaf', paneId: 'p2' })
  })

  it('3→2：group 保留，panes.length === 2', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
      { id: 'p2', tabKey: 'tabweb:b' },
      { id: 'p3', tabKey: 'tabweb:c' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p2')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(2)
    expect(groups[0].panes.map(p => p.id)).toEqual(['p1', 'p3'])
  })

  it('关闭不存在的 pane → state 不变', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
      { id: 'p2', tabKey: 'tabweb:b' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p-nonexistent')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(2)
  })

  it('关闭不存在的 group → state 不变', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
    ], 'p1')

    useCanvasLayoutStore.getState().closePane('sp-1', 'g-nonexistent', 'p1')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups).toHaveLength(1)
  })
})

describe('useCanvasLayoutStore.closeTabEverywhere', () => {
  beforeEach(resetStore)

  it('资源删除后清理所有 scope 的对应 pane 并保留分组内其他 pane', () => {
    const desktopScope = 'desktop:organization:org-1:user:user-1'
    const conversationScope = 'conversation:session-1'
    seedGroup(desktopScope, 'desktop-group', [
      { id: 'desktop-empty', tabKey: null },
      { id: 'desktop-doc-1', tabKey: 'tabdoc:doc-1' },
      { id: 'desktop-doc-2', tabKey: 'tabdoc:doc-2' },
    ], 'desktop-empty')
    seedGroup(conversationScope, 'conversation-group', [
      { id: 'conversation-empty', tabKey: null },
      { id: 'conversation-doc-1', tabKey: 'tabdoc:doc-1' },
    ], 'conversation-doc-1')
    seedGroup(desktopScope, 'unrelated-group', [
      { id: 'browser-pane', tabKey: 'tabweb:view-1' },
    ])

    useCanvasLayoutStore.getState().closeTabEverywhere('tabdoc:doc-1')

    const state = useCanvasLayoutStore.getState()
    const desktopGroups = state.spaceGroups[desktopScope] ?? []
    const desktopGroup = desktopGroups.find(group => group.id === 'desktop-group')
    expect(desktopGroup?.panes).toEqual([
      expect.objectContaining({ id: 'desktop-empty' }),
      expect.objectContaining({ id: 'desktop-doc-2' }),
    ])
    expect(desktopGroup?.activePaneId).toBe('desktop-doc-2')
    expect(desktopGroup?.anchorTabKey).toBe('tabdoc:doc-2')
    expect(desktopGroups.find(group => group.id === 'unrelated-group')).toBeDefined()
    expect(state.spaceGroups[conversationScope]).toEqual([])
  })
})

/**
 * persist merge / rehydrate / migration 回归测试
 *
 * W4-4 T6：验证 D-W4-8/A（单 pane group 持久化）+ 0 pane 防御 + migration v1 路径
 */
describe('useCanvasLayoutStore persist merge — W4-4 rehydrate', () => {
  const getMerge = () => useCanvasLayoutStore.persist.getOptions().merge!

  const baseState = () => useCanvasLayoutStore.getState()

  function makePersistedGroup(
    overrides: Partial<{
      id: string; spaceId: string; anchorTabKey: string
      panes: Array<{ id: string; content: { tabKey: string } | null }>
      layout: unknown; activePaneId: string | null
    }>,
  ) {
    const panes = overrides.panes ?? [{ id: 'p1', content: { tabKey: 'tabweb:a' } }]
    return {
      id: overrides.id ?? 'g1',
      spaceId: overrides.spaceId ?? 'sp-1',
      anchorTabKey: overrides.anchorTabKey ?? 'tabweb:a',
      panes,
      layout: overrides.layout ?? (panes.length <= 1
        ? { type: 'leaf', paneId: panes[0]?.id || 'x' }
        : {
            type: 'split', id: 'split-persist',
            direction: 'horizontal',
            children: panes.map(p => ({ type: 'leaf', paneId: p.id })),
            sizes: panes.map(() => 1 / panes.length),
          }),
      activePaneId: overrides.activePaneId ?? panes[0]?.id ?? null,
      createdAt: 1000, updatedAt: 1000,
    }
  }

  beforeEach(resetStore)

  it('单 pane group 持久化 → rehydrate 后 group 保留 + layout 是 leaf', () => {
    const singlePaneGroup = makePersistedGroup({
      panes: [{ id: 'p1', content: { tabKey: 'tabweb:solo' } }],
      anchorTabKey: 'tabweb:solo',
    })
    const persisted = { spaceGroups: { 'sp-1': [singlePaneGroup] } }

    const merged = getMerge()(persisted, baseState())

    const groups = merged.spaceGroups['sp-1']!
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(1)
    expect(groups[0].panes[0].content?.tabKey).toBe('tabweb:solo')
    expect(groups[0].layout).toEqual({ type: 'leaf', paneId: 'p1' })
  })

  it('多 pane group rehydrate → closePane 关到 1 pane → group 保留', () => {
    const multiPaneGroup = makePersistedGroup({
      panes: [
        { id: 'p1', content: { tabKey: 'tabweb:a' } },
        { id: 'p2', content: { tabKey: 'tabweb:b' } },
      ],
    })
    const persisted = { spaceGroups: { 'sp-1': [multiPaneGroup] } }

    const merged = getMerge()(persisted, baseState())
    useCanvasLayoutStore.setState(merged)

    useCanvasLayoutStore.getState().closePane('sp-1', 'g1', 'p1')

    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1']!
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(1)
    expect(groups[0].panes[0].id).toBe('p2')
  })

  it('0 pane group（崩溃窗口产物）→ rehydrate 后被丢弃', () => {
    const zeroPaneGroup = makePersistedGroup({ panes: [], activePaneId: null })
    const validGroup = makePersistedGroup({
      id: 'g2',
      panes: [{ id: 'p2', content: { tabKey: 'tabweb:valid' } }],
      anchorTabKey: 'tabweb:valid',
    })
    const persisted = { spaceGroups: { 'sp-1': [zeroPaneGroup, validGroup] } }

    const merged = getMerge()(persisted, baseState())

    const groups = merged.spaceGroups['sp-1']!
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('g2')
  })

  it('panes 非数组的畸形 group → rehydrate 后被丢弃', () => {
    const badGroup = { ...makePersistedGroup({}), panes: 'not-an-array' }
    const persisted = { spaceGroups: { 'sp-1': [badGroup] } }

    const merged = getMerge()(persisted, baseState())

    const groups = merged.spaceGroups['sp-1']!
    expect(groups).toHaveLength(0)
  })

  it('migration v1：旧格式 projectGroups + 单 pane → layout 是 leaf', () => {
    const oldState = {
      projectGroups: {
        'sp-1': [{
          id: 'g1', projectId: 'sp-1', anchorTabKey: 'tabweb:migrated',
          panes: [{ id: 'p1', content: { tabKey: 'tabweb:migrated' } }],
          activePaneId: 'p1', createdAt: 1, updatedAt: 1,
          direction: 'horizontal',
        }],
      },
    }

    const migrated = migrateCanvasLayout(oldState, 0)

    expect(migrated.spaceGroups).toBeDefined()
    const groups = migrated.spaceGroups['sp-1'] as Record<string, unknown>[]
    expect(groups).toHaveLength(1)
    expect(groups[0].layout).toEqual({ type: 'leaf', paneId: 'p1' })
    expect(groups[0].spaceId).toBe('sp-1')
    expect(groups[0].projectId).toBeUndefined()
    expect(groups[0].direction).toBeUndefined()
  })

  it('migration v1 后经 merge → 单 pane group 完整可用', () => {
    const oldState = {
      projectGroups: {
        'sp-1': [{
          id: 'g1', projectId: 'sp-1', anchorTabKey: 'tabweb:x',
          panes: [{ id: 'p1', content: { tabKey: 'tabweb:x' } }],
          activePaneId: 'p1', createdAt: 1, updatedAt: 1,
          direction: 'horizontal',
        }],
      },
    }

    const migrated = migrateCanvasLayout(oldState, 0)
    const merged = getMerge()(migrated, baseState())

    const groups = merged.spaceGroups['sp-1']!
    expect(groups).toHaveLength(1)
    expect(groups[0].panes).toHaveLength(1)
    expect(groups[0].layout.type).toBe('leaf')
    expect(groups[0].spaceId).toBe('sp-1')
  })
})

describe('useCanvasLayoutStore.applyRestoreDecision', () => {
  beforeEach(resetStore)

  it('baseSignature 匹配时一次替换当前 space groups', () => {
    seedGroup('sp-1', 'g1', [{ id: 'p1', tabKey: 'tabweb:a' }], 'p1')
    const baseSignature = buildCanvasLayoutSignature(useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? [])
    const nextGroup = seedGroup('tmp', 'g2', [{ id: 'p2', tabKey: 'tabweb:b' }], 'p2')
    useCanvasLayoutStore.setState({ spaceGroups: { 'sp-1': useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? [] } })

    const applied = useCanvasLayoutStore.getState().applyRestoreDecision('sp-1', [{
      ...nextGroup,
      spaceId: 'sp-1',
    }], baseSignature)

    expect(applied).toBe(true)
    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? []
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('g2')
    expect(groups[0].panes[0].content?.tabKey).toBe('tabweb:b')
  })

  it('baseSignature 不匹配时丢弃旧 decision', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabweb:a' },
      { id: 'p2', tabKey: 'tabweb:b' },
    ], 'p1')
    const baseSignature = buildCanvasLayoutSignature(useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? [])
    useCanvasLayoutStore.getState().setActivePane('sp-1', 'g1', 'p2')

    const applied = useCanvasLayoutStore.getState().applyRestoreDecision('sp-1', [], baseSignature)

    expect(applied).toBe(false)
    const groups = useCanvasLayoutStore.getState().spaceGroups['sp-1'] ?? []
    expect(groups).toHaveLength(1)
    expect(groups[0].activePaneId).toBe('p2')
  })
})

describe('useCanvasLayoutStore.purgeStaleEntries', () => {
  beforeEach(resetStore)

  it('保留 desktop/conversation workspace scopes', () => {
    seedGroup('desktop:organization:wt-1:user:user-1', 'desktop-group', [{ id: 'p1', tabKey: 'tabweb:desktop' }], 'p1')
    seedGroup('conversation:session-1', 'conversation-group', [{ id: 'p2', tabKey: 'tabweb:conversation' }], 'p2')
    seedGroup('deleted-space', 'deleted-group', [{ id: 'p3', tabKey: 'tabweb:deleted' }], 'p3')

    useCanvasLayoutStore.getState().purgeStaleEntries(new Set(['space-1']))

    expect(useCanvasLayoutStore.getState().spaceGroups['desktop:organization:wt-1:user:user-1']).toBeDefined()
    expect(useCanvasLayoutStore.getState().spaceGroups['conversation:session-1']).toBeDefined()
    expect(useCanvasLayoutStore.getState().spaceGroups['deleted-space']).toBeUndefined()
  })

  it('保留 cloud-docs 域布局', () => {
    seedGroup('cloud-docs:organization:org-1:user:user-1', 'cloud-group', [{ id: 'p1', tabKey: 'tabdoc:cloud' }], 'p1')
    seedGroup('deleted-space', 'deleted-group', [{ id: 'p2', tabKey: 'tabweb:deleted' }], 'p2')

    useCanvasLayoutStore.getState().purgeStaleEntries(new Set(['space-1']))

    expect(useCanvasLayoutStore.getState().spaceGroups['cloud-docs:organization:org-1:user:user-1']).toBeDefined()
    expect(useCanvasLayoutStore.getState().spaceGroups['deleted-space']).toBeUndefined()
  })
})

describe('useCanvasLayoutStore.splitPaneWithContent — 显式提交结果', () => {
  beforeEach(resetStore)

  it('拆分成功时返回 true，并写入第三个 pane', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabdoc:a' },
      { id: 'p2', tabKey: 'tabdata:b' },
    ], 'p1')

    const changed = useCanvasLayoutStore.getState().splitPaneWithContent(
      'sp-1',
      'g1',
      'p1',
      'horizontal',
      'right',
      { tabKey: 'tabdoc:c' },
    )

    expect(changed).toBe(true)
    const group = useCanvasLayoutStore.getState().spaceGroups['sp-1']![0]
    expect(group.panes).toHaveLength(3)
    expect(group.panes.some(pane => pane.content?.tabKey === 'tabdoc:c')).toBe(true)
  })

  it('相同标签已在组内时返回 false，布局保持不变', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabdoc:a' },
      { id: 'p2', tabKey: 'tabdata:b' },
    ], 'p1')

    const changed = useCanvasLayoutStore.getState().splitPaneWithContent(
      'sp-1',
      'g1',
      'p1',
      'horizontal',
      'right',
      { tabKey: 'tabdata:b' },
    )

    expect(changed).toBe(false)
    expect(useCanvasLayoutStore.getState().spaceGroups['sp-1']![0].panes).toHaveLength(2)
  })

  it('组内已有三个 pane 时返回 false，布局保持不变', () => {
    seedGroup('sp-1', 'g1', [
      { id: 'p1', tabKey: 'tabdoc:a' },
      { id: 'p2', tabKey: 'tabdata:b' },
      { id: 'p3', tabKey: 'tabweb:c' },
    ], 'p1')

    const changed = useCanvasLayoutStore.getState().splitPaneWithContent(
      'sp-1',
      'g1',
      'p1',
      'vertical',
      'bottom',
      { tabKey: 'tabdoc:d' },
    )

    expect(changed).toBe(false)
    expect(useCanvasLayoutStore.getState().spaceGroups['sp-1']![0].panes).toHaveLength(3)
  })
})
