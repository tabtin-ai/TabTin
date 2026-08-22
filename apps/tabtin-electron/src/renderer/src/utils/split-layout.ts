/**
 * Shared tree-based split layout utilities.
 *
 * Used by both CanvasLayoutStore (context-space) and ChatSplitStore (chat panes).
 * All functions are pure – no store or React dependency.
 */

// ────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────

export type SplitDirection = 'horizontal' | 'vertical'
export type SplitSide = 'left' | 'right' | 'top' | 'bottom'

export type LayoutNode =
  | { type: 'leaf'; paneId: string }
  | {
      type: 'split'
      id: string
      direction: SplitDirection
      children: LayoutNode[]
      sizes: number[]
    }

// ────────────────────────────────────────────────────────────
// ID helpers
// ────────────────────────────────────────────────────────────

export const createSplitId = (prefix: string) =>
  `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

// ────────────────────────────────────────────────────────────
// Size helpers
// ────────────────────────────────────────────────────────────

export const buildSizes = (count: number): number[] => {
  if (count <= 0) return []
  const ratio = 1 / count
  return Array.from({ length: count }, () => ratio)
}

export const normalizeSizes = (sizes: number[], count: number): number[] => {
  if (count <= 0) return []
  if (sizes.length !== count || sizes.some(s => !Number.isFinite(s) || s <= 0)) {
    return buildSizes(count)
  }
  const total = sizes.reduce((sum, v) => sum + v, 0)
  if (!Number.isFinite(total) || !total) return buildSizes(count)
  return sizes.map(v => v / total)
}

// ────────────────────────────────────────────────────────────
// Tree traversal
// ────────────────────────────────────────────────────────────

/** Return the index-path from `node` to the leaf with `paneId`, or null. */
export const findLeafPath = (
  node: LayoutNode,
  paneId: string,
): number[] | null => {
  if (node.type === 'leaf') {
    return node.paneId === paneId ? [] : null
  }
  for (let i = 0; i < node.children.length; i += 1) {
    const childPath = findLeafPath(node.children[i], paneId)
    if (childPath !== null) return [i, ...childPath]
  }
  return null
}

/** Return the sub-tree at the given index-path. */
export const getNodeAtPath = (
  node: LayoutNode,
  path: number[],
): LayoutNode | null => {
  let current: LayoutNode = node
  for (const idx of path) {
    if (current.type !== 'split') return null
    const next = current.children[idx]
    if (!next) return null
    current = next
  }
  return current
}

/** Immutably replace the sub-tree at `path` with `updater(old)`. */
export const updateNodeAtPath = (
  node: LayoutNode,
  path: number[],
  updater: (target: LayoutNode) => LayoutNode,
): LayoutNode => {
  if (path.length === 0) return updater(node)
  if (node.type !== 'split') return node
  const [idx, ...rest] = path
  const child = node.children[idx]
  if (!child) return node
  const nextChild = updateNodeAtPath(child, rest, updater)
  if (nextChild === child) return node
  const nextChildren = node.children.slice()
  nextChildren[idx] = nextChild
  return { ...node, children: nextChildren }
}

// ────────────────────────────────────────────────────────────
// Mutations (immutable – return new trees)
// ────────────────────────────────────────────────────────────

/** Insert a new leaf next to the leaf at `leafPath`. */
export const insertLeafAtPath = (
  node: LayoutNode,
  leafPath: number[],
  newPaneId: string,
  direction: SplitDirection,
  side: SplitSide,
): LayoutNode => {
  const placeBefore = side === 'left' || side === 'top'

  if (leafPath.length === 0) {
    if (node.type !== 'leaf') return node
    const newLeaf: LayoutNode = { type: 'leaf', paneId: newPaneId }
    return {
      type: 'split',
      id: createSplitId('split'),
      direction,
      children: placeBefore ? [newLeaf, node] : [node, newLeaf],
      sizes: buildSizes(2),
    }
  }

  const parentPath = leafPath.slice(0, -1)
  const leafIndex = leafPath[leafPath.length - 1]
  const parent = getNodeAtPath(node, parentPath)

  if (parent && parent.type === 'split' && parent.direction === direction) {
    const insertIndex = placeBefore ? leafIndex : leafIndex + 1
    const nextChildren = parent.children.slice()
    nextChildren.splice(insertIndex, 0, { type: 'leaf', paneId: newPaneId })
    const nextParent: LayoutNode = {
      ...parent,
      children: nextChildren,
      sizes: buildSizes(nextChildren.length),
    }
    return updateNodeAtPath(node, parentPath, () => nextParent)
  }

  const targetLeaf = getNodeAtPath(node, leafPath)
  if (!targetLeaf || targetLeaf.type !== 'leaf') return node
  const newLeaf: LayoutNode = { type: 'leaf', paneId: newPaneId }
  const nextSplit: LayoutNode = {
    type: 'split',
    id: createSplitId('split'),
    direction,
    children: placeBefore ? [newLeaf, targetLeaf] : [targetLeaf, newLeaf],
    sizes: buildSizes(2),
  }
  return updateNodeAtPath(node, leafPath, () => nextSplit)
}

/** Remove a leaf and simplify the tree. */
export const removeLeafFromTree = (
  node: LayoutNode,
  paneId: string,
): LayoutNode => {
  const prune = (current: LayoutNode): LayoutNode | null => {
    if (current.type === 'leaf') {
      return current.paneId === paneId ? null : current
    }
    const nextChildren = current.children
      .map(c => prune(c))
      .filter((c): c is LayoutNode => c !== null)
    if (nextChildren.length === 0) return null
    if (nextChildren.length === 1) return nextChildren[0]
    return {
      ...current,
      children: nextChildren,
      sizes: buildSizes(nextChildren.length),
    }
  }
  return prune(node) || node
}

/** Collect all paneIds present in the tree. */
export const collectLeafIds = (node: LayoutNode): string[] => {
  if (node.type === 'leaf') return [node.paneId]
  return node.children.flatMap(collectLeafIds)
}

/** Derive the SplitDirection from a SplitSide. */
export const sideToDirection = (side: SplitSide): SplitDirection =>
  side === 'top' || side === 'bottom' ? 'vertical' : 'horizontal'
