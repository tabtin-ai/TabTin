import { describe, expect, it, vi } from 'vitest'
import type { CanvasLayoutGroup, CanvasTabKey } from '@stores/useCanvasLayoutStore'
import { createDragIntentResolver } from '../createDragIntentResolver'

function rect(left: number, top: number, width: number, height: number): DOMRect {
  return {
    x: left,
    y: top,
    left,
    top,
    width,
    height,
    right: left + width,
    bottom: top + height,
    toJSON: () => ({}),
  } as DOMRect
}

function group(tabKeys: string[]): CanvasLayoutGroup {
  const panes = tabKeys.map((tabKey, index) => ({
    id: `pane-${index + 1}`,
    content: { tabKey: tabKey as CanvasTabKey },
  }))
  return {
    id: 'group-1',
    spaceId: 'scope-1',
    anchorTabKey: panes[0].content.tabKey,
    panes,
    layout: {
      type: 'split',
      id: 'split-1',
      direction: 'horizontal',
      children: panes.map(pane => ({ type: 'leaf', paneId: pane.id })),
      sizes: panes.map(() => 1 / panes.length),
    },
    activePaneId: panes[0].id,
    createdAt: 1,
    updatedAt: 1,
  }
}

function createResolver(options: {
  groups?: CanvasLayoutGroup[]
  showCanvas?: boolean
  draggedTabKey?: CanvasTabKey | null
  blockReason?: 'home' | 'self' | 'grouped' | 'unavailable' | null
}) {
  const contentRect = rect(0, 0, 1000, 700)
  const groups = options.groups ?? []
  return createDragIntentResolver({
    getCachedRects: () => ({
      contentRect,
      dragRootRect: contentRect,
      paneRects: groups.flatMap(item =>
        item.panes.map((pane, index) => ({
          paneId: pane.id,
          groupId: item.id,
          rect: rect(index * 300, 0, 300, 700),
        })),
      ),
    }),
    resolveGroupRect: () => contentRect,
    latestState: () => ({
      spaceGroups: groups,
      shouldShowCanvasGroup: options.showCanvas ?? false,
    }),
    dragTabKeyRef: {
      current: options.draggedTabKey ?? ('tabdoc:dragged' as CanvasTabKey),
    },
    panePayloadRef: { current: null },
    getCreateGroupBlockReason: vi.fn(() => options.blockReason ?? null),
  })
}

describe('createDragIntentResolver.resolveTabEvaluation', () => {
  it('独立内容区允许创建组，并返回明确方向', () => {
    const resolver = createResolver({})
    const result = resolver.resolveTabEvaluation(940, 350)

    expect(result.blockReason).toBeNull()
    expect(result.intent).toMatchObject({
      kind: 'create-group',
      side: 'right',
    })
  })

  it('拖入标签已经在目标组内时拒绝，不再显示错误 split 预览', () => {
    const existing = group(['tabdoc:dragged', 'tabdoc:other'])
    const resolver = createResolver({
      groups: [existing],
      showCanvas: true,
      draggedTabKey: 'tabdoc:dragged' as CanvasTabKey,
    })

    expect(resolver.resolveTabEvaluation(290, 350)).toEqual({
      intent: null,
      blockReason: 'duplicate',
    })
  })

  it('三窗格已满时返回 group-full', () => {
    const existing = group(['tabdoc:a', 'tabdoc:b', 'tabdoc:c'])
    const resolver = createResolver({
      groups: [existing],
      showCanvas: true,
    })

    expect(resolver.resolveTabEvaluation(10, 350)).toEqual({
      intent: null,
      blockReason: 'group-full',
    })
  })

  it('落在已有内容中央时提示移到边缘', () => {
    const existing = group(['tabdoc:a', 'tabdoc:b'])
    const resolver = createResolver({
      groups: [existing],
      showCanvas: true,
    })

    expect(resolver.resolveTabEvaluation(150, 350)).toEqual({
      intent: null,
      blockReason: 'move-to-edge',
    })
  })

  it('进入 pane 边缘时生成 split intent', () => {
    const existing = group(['tabdoc:a', 'tabdoc:b'])
    const resolver = createResolver({
      groups: [existing],
      showCanvas: true,
    })

    const result = resolver.resolveTabEvaluation(295, 350)
    expect(result.blockReason).toBeNull()
    expect(result.intent).toMatchObject({
      kind: 'split',
      groupId: 'group-1',
      paneId: 'pane-1',
      side: 'right',
    })
  })
})
