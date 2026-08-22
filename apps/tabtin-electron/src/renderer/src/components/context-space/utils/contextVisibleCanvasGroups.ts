import {
  type CanvasLayoutGroup,
  type CanvasLayoutNode,
  type CanvasPane,
} from '@stores/useCanvasLayoutStore'

export interface ContextVisibleCanvasGroups {
  visibleGroups: CanvasLayoutGroup[]
  visibleGroupedTabKeys: Set<string>
}

const normalizeLayoutSizes = (sizes: number[]): number[] => {
  const total = sizes.reduce((sum, size) => sum + size, 0)
  if (total > 0) return sizes.map(size => size / total)
  const fallback = 1 / Math.max(sizes.length, 1)
  return sizes.map(() => fallback)
}

function filterCanvasLayoutNode(
  node: CanvasLayoutNode | null,
  visiblePaneIds: Set<string>,
): CanvasLayoutNode | null {
  if (!node) return null
  if (node.type === 'leaf') {
    return visiblePaneIds.has(node.paneId) ? node : null
  }

  const children: CanvasLayoutNode[] = []
  const sizes: number[] = []
  node.children.forEach((child, index) => {
    const nextChild = filterCanvasLayoutNode(child, visiblePaneIds)
    if (!nextChild) return
    children.push(nextChild)
    sizes.push(node.sizes[index] ?? 0)
  })

  if (children.length === 0) return null
  if (children.length === 1) return children[0]
  return {
    ...node,
    children,
    sizes: normalizeLayoutSizes(sizes),
  }
}

export function deriveContextVisibleCanvasGroups(
  groups: readonly CanvasLayoutGroup[],
  contextVisibleTabKeys: readonly string[],
): ContextVisibleCanvasGroups {
  const visibleTabKeys = new Set(contextVisibleTabKeys)
  const visibleGroupedTabKeys = new Set<string>()
  const visibleGroups = groups.flatMap(group => {
    const visiblePanes = group.panes.filter(
      (pane): pane is CanvasPane & { content: NonNullable<CanvasPane['content']> } =>
        Boolean(pane.content?.tabKey && visibleTabKeys.has(pane.content.tabKey)),
    )
    if (visiblePanes.length <= 1) return []

    const visiblePaneIds = new Set(visiblePanes.map(pane => pane.id))
    const layout = filterCanvasLayoutNode(group.layout, visiblePaneIds)
    if (!layout) return []

    visiblePanes.forEach(pane => visibleGroupedTabKeys.add(pane.content.tabKey))
    const activePaneId = visiblePaneIds.has(group.activePaneId ?? '')
      ? group.activePaneId
      : visiblePanes[0]?.id ?? null
    const anchorTabKey = group.anchorTabKey && visibleTabKeys.has(group.anchorTabKey)
      ? group.anchorTabKey
      : visiblePanes[0].content.tabKey

    return [{
      ...group,
      panes: visiblePanes,
      layout,
      activePaneId,
      anchorTabKey,
    }]
  })

  return { visibleGroups, visibleGroupedTabKeys }
}

export function hasHiddenPersistentCanvasPanes(
  persistedGroup: CanvasLayoutGroup | null,
  visiblePaneCount: number,
): boolean {
  const persistedContentCount = persistedGroup?.panes.filter(pane => pane.content).length ?? visiblePaneCount
  return persistedContentCount > visiblePaneCount
}
