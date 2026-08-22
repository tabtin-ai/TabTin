import { describe, expect, it } from 'vitest'
import type { CanvasLayoutGroup } from '@stores/useCanvasLayoutStore'
import { hasHiddenPersistentCanvasPanes } from '../../utils/contextVisibleCanvasGroups'

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

describe('hasHiddenPersistentCanvasPanes', () => {
  it('识别 mixed group 中仍存在 hidden persistent pane', () => {
    const persistedGroup = makeGroup(['tabdoc:doc-1', 'tabdata:table-1', 'subagent_session:hidden'])

    expect(hasHiddenPersistentCanvasPanes(persistedGroup, 2)).toBe(true)
  })

  it('完整可见 group restore 不应被跳过', () => {
    const persistedGroup = makeGroup(['tabdoc:doc-1', 'tabdata:table-1'])

    expect(hasHiddenPersistentCanvasPanes(persistedGroup, 2)).toBe(false)
  })
})
