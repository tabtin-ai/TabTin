import { describe, expect, it } from 'vitest'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { deriveContextVisibleCanvasGroups } from '../contextVisibleCanvasGroups'

function makeGroup(tabKeys: string[]): CanvasLayoutGroup {
  return {
    id: 'group-1',
    spaceId: 'space-1',
    anchorTabKey: tabKeys[0] as `${string}:${string}`,
    activePaneId: 'pane-0',
    panes: tabKeys.map((tabKey, index) => ({
      id: `pane-${index}`,
      content: { tabKey: tabKey as `${string}:${string}` },
    })),
    layout: {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: tabKeys.map((_, index) => ({
        type: 'leaf' as const,
        paneId: `pane-${index}`,
      })),
      sizes: tabKeys.map(() => 1 / tabKeys.length),
    },
    createdAt: 1,
    updatedAt: 1,
  }
}

describe('deriveContextVisibleCanvasGroups', () => {
  it('只用当前上下文可见 panes 生成 canvas group', () => {
    const result = deriveContextVisibleCanvasGroups(
      [makeGroup(['tabdoc:doc-1', 'tabdata:table-1', 'subagent_session:hidden'])],
      ['tabdoc:doc-1', 'tabdata:table-1'],
    )

    expect(result.visibleGroups).toHaveLength(1)
    expect(result.visibleGroups[0].panes.map(pane => pane.content?.tabKey)).toEqual([
      'tabdoc:doc-1',
      'tabdata:table-1',
    ])
    expect(result.visibleGroupedTabKeys).toEqual(new Set(['tabdoc:doc-1', 'tabdata:table-1']))
  })

  it('只剩一个可见 pane 时不再生成有效 group', () => {
    const result = deriveContextVisibleCanvasGroups(
      [makeGroup(['tabdoc:doc-1', 'subagent_session:hidden'])],
      ['tabdoc:doc-1'],
    )

    expect(result.visibleGroups).toEqual([])
    expect(result.visibleGroupedTabKeys).toEqual(new Set())
  })
})
