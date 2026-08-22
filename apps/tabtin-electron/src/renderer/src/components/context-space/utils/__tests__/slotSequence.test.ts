/**
 * slotSequence 纯函数单测
 *
 * 覆盖场景：
 *   1. 无 group → 全部 item slot
 *   2. 单 group 2 pane → group 只出现一次
 *   3. 多 group → 各自出现一次
 *   4. canvas-only group（pane tabKey 不在 tabOrder 里）→ 追加到末尾
 *   5. 混合：普通 tab + group + 普通 tab → 位置正确
 *   6. 空 tabOrder → 仅 canvas-only group
 *   7. collectTabKeysFromSlots 收集完整
 */
import { describe, it, expect } from 'vitest'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { computeSlotsFromTabOrder, collectTabKeysFromSlots } from '../slotSequence'

function makeGroup(
  id: string,
  tabKeys: string[],
  spaceId = 'sp-1',
): CanvasLayoutGroup {
  return {
    id,
    spaceId,
    panes: tabKeys.map((tk, i) => ({
      id: `pane-${id}-${i}`,
      content: { tabKey: tk },
    })),
    layout: null,
    activePaneId: null,
    anchorTabKey: tabKeys[0] ?? null,
  } as unknown as CanvasLayoutGroup
}

describe('computeSlotsFromTabOrder', () => {
  it('无 group 时全部为 item slot', () => {
    const slots = computeSlotsFromTabOrder({
      tabOrder: ['a', 'b', 'c'],
      groupedTabKeys: new Set(),
      canvasGroups: [],
    })
    expect(slots).toEqual([
      { kind: 'item', tabKey: 'a' },
      { kind: 'item', tabKey: 'b' },
      { kind: 'item', tabKey: 'c' },
    ])
  })

  it('单 group 2 pane → group 仅出现一次，位置在第一个 pane tabKey 处', () => {
    const g = makeGroup('g1', ['tabweb:a', 'tabweb:b'])
    const grouped = new Set(['tabweb:a', 'tabweb:b'])
    const slots = computeSlotsFromTabOrder({
      tabOrder: ['tabweb:a', 'tabweb:b', 'tabdoc:c'],
      groupedTabKeys: grouped,
      canvasGroups: [g],
    })
    expect(slots).toHaveLength(2)
    expect(slots[0]).toEqual({
      kind: 'group',
      groupId: 'g1',
      tabKeys: ['tabweb:a', 'tabweb:b'],
    })
    expect(slots[1]).toEqual({ kind: 'item', tabKey: 'tabdoc:c' })
  })

  it('多 group 各自出现一次', () => {
    const g1 = makeGroup('g1', ['a', 'b'])
    const g2 = makeGroup('g2', ['c', 'd'])
    const grouped = new Set(['a', 'b', 'c', 'd'])
    const slots = computeSlotsFromTabOrder({
      tabOrder: ['a', 'b', 'x', 'c', 'd'],
      groupedTabKeys: grouped,
      canvasGroups: [g1, g2],
    })
    expect(slots).toHaveLength(3)
    expect(slots[0]).toMatchObject({ kind: 'group', groupId: 'g1' })
    expect(slots[1]).toMatchObject({ kind: 'item', tabKey: 'x' })
    expect(slots[2]).toMatchObject({ kind: 'group', groupId: 'g2' })
  })

  it('canvas-only group（tabKey 不在 tabOrder 里）追加到末尾', () => {
    const g = makeGroup('g-only', ['orphan:1'])
    const slots = computeSlotsFromTabOrder({
      tabOrder: ['a', 'b'],
      groupedTabKeys: new Set(),
      canvasGroups: [g],
    })
    expect(slots).toHaveLength(3)
    expect(slots[2]).toMatchObject({ kind: 'group', groupId: 'g-only' })
  })

  it('混合场景：普通 tab + group + 普通 tab 位置正确', () => {
    const g = makeGroup('g1', ['b', 'c'])
    const grouped = new Set(['b', 'c'])
    const slots = computeSlotsFromTabOrder({
      tabOrder: ['a', 'b', 'c', 'd'],
      groupedTabKeys: grouped,
      canvasGroups: [g],
    })
    expect(slots.map(s => s.kind === 'item' ? s.tabKey : `group:${s.groupId}`))
      .toEqual(['a', 'group:g1', 'd'])
  })

  it('空 tabOrder → 仅 canvas-only group', () => {
    const g = makeGroup('g1', ['x'])
    const slots = computeSlotsFromTabOrder({
      tabOrder: [],
      groupedTabKeys: new Set(),
      canvasGroups: [g],
    })
    expect(slots).toHaveLength(1)
    expect(slots[0]).toMatchObject({ kind: 'group', groupId: 'g1' })
  })

  it('group 中 pane content 为 null 的 pane 不包含在 tabKeys 里', () => {
    const g = {
      ...makeGroup('g1', ['a']),
      panes: [
        { id: 'p1', content: { tabKey: 'a' } },
        { id: 'p2', content: null },
      ],
    } as unknown as CanvasLayoutGroup
    const grouped = new Set(['a'])
    const slots = computeSlotsFromTabOrder({
      tabOrder: ['a'],
      groupedTabKeys: grouped,
      canvasGroups: [g],
    })
    expect(slots).toHaveLength(1)
    expect(slots[0]).toMatchObject({ kind: 'group', tabKeys: ['a'] })
  })
})

describe('collectTabKeysFromSlots', () => {
  it('收集所有 slot 的 tabKeys', () => {
    const g = makeGroup('g1', ['b', 'c'])
    const grouped = new Set(['b', 'c'])
    const slots = computeSlotsFromTabOrder({
      tabOrder: ['a', 'b', 'c', 'd'],
      groupedTabKeys: grouped,
      canvasGroups: [g],
    })
    const keys = collectTabKeysFromSlots(slots)
    expect(keys).toEqual(['a', 'b', 'c', 'd'])
  })
})
