import { describe, expect, it } from 'vitest'
import type { CanvasLayoutGroup, CanvasTabKey } from '@stores/useCanvasLayoutStore'
import { reorderTabOrderBySlot } from '../useTabSync'

function group(id: string, tabKeys: string[]): CanvasLayoutGroup {
  return {
    id,
    spaceId: 'space-1',
    anchorTabKey: tabKeys[0] as CanvasTabKey,
    activePaneId: `${id}-pane-0`,
    panes: tabKeys.map((tabKey, index) => ({
      id: `${id}-pane-${index}`,
      content: { tabKey: tabKey as CanvasTabKey },
    })),
    layout: null,
    createdAt: 1,
    updatedAt: 1,
  } as unknown as CanvasLayoutGroup
}

describe('reorderTabOrderBySlot', () => {
  it('拖动组标签时把组成员作为一个连续块移动', () => {
    const groups = [group('group-1', ['tabdoc:b', 'tabdata:c'])]

    expect(
      reorderTabOrderBySlot(
        ['tabweb:a', 'tabdoc:b', 'tabdata:c', 'tabweb:d'],
        groups,
        'tabdoc:b',
        'tabweb:d',
        'after',
      ),
    ).toEqual(['tabweb:a', 'tabweb:d', 'tabdoc:b', 'tabdata:c'])
  })

  it('组成员原本不连续时，排序后也会收拢为一个视觉槽位', () => {
    const groups = [group('group-1', ['tabdoc:b', 'tabdata:c'])]

    expect(
      reorderTabOrderBySlot(
        ['tabweb:a', 'tabdoc:b', 'tabweb:d', 'tabdata:c'],
        groups,
        'tabdata:c',
        'tabweb:a',
        'before',
      ),
    ).toEqual(['tabdoc:b', 'tabdata:c', 'tabweb:a', 'tabweb:d'])
  })

  it('普通标签落到组前后时以整组为边界', () => {
    const groups = [group('group-1', ['tabdoc:b', 'tabdata:c'])]

    expect(
      reorderTabOrderBySlot(
        ['tabweb:a', 'tabdoc:b', 'tabdata:c', 'tabweb:d'],
        groups,
        'tabweb:d',
        'tabdata:c',
        'before',
      ),
    ).toEqual(['tabweb:a', 'tabweb:d', 'tabdoc:b', 'tabdata:c'])
  })

  it('普通标签落到组后时插入整个组块之后', () => {
    const groups = [group('group-1', ['tabdoc:b', 'tabdata:c'])]

    expect(
      reorderTabOrderBySlot(
        ['tabweb:a', 'tabdoc:b', 'tabdata:c', 'tabweb:d'],
        groups,
        'tabweb:a',
        'tabdoc:b',
        'after',
      ),
    ).toEqual(['tabdoc:b', 'tabdata:c', 'tabweb:a', 'tabweb:d'])
  })

  it('同一组内部没有独立槽位，不产生无效排序', () => {
    const groups = [group('group-1', ['tabdoc:b', 'tabdata:c'])]

    expect(
      reorderTabOrderBySlot(
        ['tabweb:a', 'tabdoc:b', 'tabdata:c'],
        groups,
        'tabdoc:b',
        'tabdata:c',
        'after',
      ),
    ).toBeNull()
  })
})
