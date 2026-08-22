import type { KnowledgeTreeNode, KnowledgeTreeNodeType, SpaceContextItem } from '@/services/spaceApi'

export const KNOWLEDGE_ITEM_REORDER_MIME = 'application/x-knowledge-item-reorder'

/**
 * 知识树最大嵌套层数（根=第 1 层）。
 * 前端行 depth 从 0 起算：depth=3 即第 4 层，不可再建子节点。
 */
export const KNOWLEDGE_TREE_MAX_NESTING_DEPTH = 4

/** `depth` 为侧栏 0-based 层级；true 表示该节点下还可「+」建子 / 拖入子资源 */
export function canCreateKnowledgeTreeChild(depth: number): boolean {
  return depth >= 0 && depth + 1 < KNOWLEDGE_TREE_MAX_NESTING_DEPTH
}

export interface KnowledgeItemReorderPayload {
  contextItemId: string
  siblingGroupKey: string
  collectionId: string | null
  resourceId: string | null
  nodeType: KnowledgeTreeNodeType
}

export type CloudDocsTreeTypeFilter = 'all' | 'tabdoc' | 'tabdata'

export function filterKnowledgeTreeRoots(
  roots: KnowledgeTreeNode[],
  typeFilter: CloudDocsTreeTypeFilter,
): KnowledgeTreeNode[] {
  if (typeFilter === 'all') return roots
  return filterNodesByType(roots, typeFilter)
}

function filterNodesByType(
  nodes: KnowledgeTreeNode[],
  typeFilter: Exclude<CloudDocsTreeTypeFilter, 'all'>,
): KnowledgeTreeNode[] {
  const result: KnowledgeTreeNode[] = []
  for (const node of nodes) {
    if (node.node_type === typeFilter) {
      // ：tabdoc / tabdata 均可挂子节点
      // 保留后端 child_count（depth 截断时 children 可能为空，不能用 length 覆盖）
      const children = filterNodesByType(node.children ?? [], typeFilter)
      result.push({
        ...node,
        children,
        child_count: Math.max(node.child_count ?? 0, children.length),
      })
    }
  }
  return result
}

export interface FlatKnowledgeTreeMatch {
  node: KnowledgeTreeNode
  path: string[]
}

export function flattenKnowledgeTreeSearchMatches(
  roots: KnowledgeTreeNode[],
  query: string,
): FlatKnowledgeTreeMatch[] {
  const normalized = query.trim().toLowerCase()
  if (!normalized) return []

  const matches: FlatKnowledgeTreeMatch[] = []

  const walk = (nodes: KnowledgeTreeNode[], path: string[]) => {
    for (const node of nodes) {
      const nextPath = [...path, node.title || node.id]
      const title = (node.title || '').toLowerCase()
      if (title.includes(normalized)) {
        matches.push({ node, path: nextPath })
      }
      if (node.children?.length) {
        walk(node.children, nextPath)
      }
    }
  }

  walk(roots, [])
  return matches
}

export function collectAncestorNodeIds(
  roots: KnowledgeTreeNode[],
  targetNodeId: string,
): string[] {
  const ancestors: string[] = []

  const walk = (nodes: KnowledgeTreeNode[], chain: string[]): boolean => {
    for (const node of nodes) {
      const nextChain = [...chain, node.id]
      if (node.id === targetNodeId) {
        ancestors.push(...chain)
        return true
      }
      if (node.children?.length && walk(node.children, nextChain)) {
        return true
      }
    }
    return false
  }

  walk(roots, [])
  return ancestors
}

export function resolveActiveTreeNodeId(
  activeTabKey: string | null | undefined,
): { nodeType: KnowledgeTreeNodeType; nodeId: string } | null {
  if (!activeTabKey) return null
  if (activeTabKey.startsWith('tabdoc:')) {
    return { nodeType: 'tabdoc', nodeId: activeTabKey.slice('tabdoc:'.length) }
  }
  if (activeTabKey.startsWith('tabdata:')) {
    return { nodeType: 'tabdata', nodeId: activeTabKey.slice('tabdata:'.length) }
  }
  return null
}

export function isTreeNodeActive(
  node: KnowledgeTreeNode,
  activeTabKey: string | null | undefined,
): boolean {
  const active = resolveActiveTreeNodeId(activeTabKey)
  if (!active || !node.resource_id) return false
  if (node.node_type === 'tabdoc' && active.nodeType === 'tabdoc') {
    return node.resource_id === active.nodeId
  }
  if (node.node_type === 'tabdata' && active.nodeType === 'tabdata') {
    return node.resource_id === active.nodeId
  }
  return false
}

export function nodeNeedsLazyChildren(node: KnowledgeTreeNode): boolean {
  if (node.child_count <= 0) return false
  return (node.children?.length ?? 0) < node.child_count
}

export function mergeChildrenIntoTree(
  roots: KnowledgeTreeNode[],
  nodeId: string,
  children: KnowledgeTreeNode[],
): KnowledgeTreeNode[] {
  const patch = (nodes: KnowledgeTreeNode[]): KnowledgeTreeNode[] => (
    nodes.map(node => {
      if (node.id === nodeId) {
        return { ...node, children }
      }
      if (node.children?.length) {
        return { ...node, children: patch(node.children) }
      }
      return node
    })
  )
  return patch(roots)
}

export function resolveCreateContextFromNode(node: KnowledgeTreeNode): {
  collectionId: string | null
  parentDocumentId: string | null
  /** ：挂到该节点 ContextItem 下 */
  parentItemId: string | null
} {
  // tabdoc / tabdata：子资源挂 ContextItem.parent（正典）；与云盘 collection_id 解耦
  return {
    collectionId: null,
    parentDocumentId: null,
    parentItemId: node.context_item_id ?? node.id,
  }
}

export function buildResourceSiblingGroupKey(parent: KnowledgeTreeNode | null): string {
  if (!parent) return 'root:resources'
  // ：tabdoc / tabdata 子树按 ContextItem.parent 分组
  return `item:${parent.context_item_id ?? parent.id}`
}

export function getResourceSiblings(
  parent: KnowledgeTreeNode | null,
  roots: KnowledgeTreeNode[],
): KnowledgeTreeNode[] {
  return parent?.children ?? roots
}

export function computeReorderedIds(
  currentIds: string[],
  draggedId: string,
  targetId: string,
  position: 'before' | 'after',
): string[] | null {
  if (draggedId === targetId) return null
  const filtered = currentIds.filter(id => id !== draggedId)
  const targetIdx = filtered.indexOf(targetId)
  if (targetIdx === -1) return null
  const insertIdx = position === 'after' ? targetIdx + 1 : targetIdx
  filtered.splice(insertIdx, 0, draggedId)
  return filtered
}

export function findKnowledgeTreeNodeByResourceId(
  roots: KnowledgeTreeNode[],
  resourceId: string,
): KnowledgeTreeNode | null {
  for (const node of roots) {
    if (node.resource_id === resourceId) return node
    if (node.children?.length) {
      const found = findKnowledgeTreeNodeByResourceId(node.children, resourceId)
      if (found) return found
    }
  }
  return null
}

export function findKnowledgeTreeNodeByContextItemId(
  roots: KnowledgeTreeNode[],
  contextItemId: string,
): KnowledgeTreeNode | null {
  for (const node of roots) {
    if (node.context_item_id === contextItemId) return node
    if (node.children?.length) {
      const found = findKnowledgeTreeNodeByContextItemId(node.children, contextItemId)
      if (found) return found
    }
  }
  return null
}

export function findKnowledgeTreeNodeDepth(
  roots: KnowledgeTreeNode[],
  nodeId: string,
  depth = 0,
): number | null {
  for (const node of roots) {
    if (node.id === nodeId) return depth
    if (node.children?.length) {
      const found = findKnowledgeTreeNodeDepth(node.children, nodeId, depth + 1)
      if (found != null) return found
    }
  }
  return null
}

export function collectDescendantResourceIds(node: KnowledgeTreeNode): Set<string> {
  const ids = new Set<string>()
  const walk = (current: KnowledgeTreeNode) => {
    if (current.resource_id) ids.add(current.resource_id)
    current.children?.forEach(walk)
  }
  node.children?.forEach(walk)
  return ids
}

export function collectDescendantContextItemIds(node: KnowledgeTreeNode): Set<string> {
  const ids = new Set<string>()
  const walk = (current: KnowledgeTreeNode) => {
    if (current.context_item_id) ids.add(current.context_item_id)
    current.children?.forEach(walk)
  }
  node.children?.forEach(walk)
  return ids
}

const NESTABLE_RESOURCE_TYPES = new Set<KnowledgeTreeNodeType>(['tabdoc', 'tabdata'])

/**
 * 可否把 payload 拖进 target 下成为子资源（ ContextItem.parent）。
 * `targetDepth` 为侧栏 0-based 层级，与「+」建子同一上限。
 */
export function canNestItemUnderTarget(
  payload: KnowledgeItemReorderPayload,
  target: KnowledgeTreeNode,
  roots: KnowledgeTreeNode[],
  targetDepth: number,
): boolean {
  if (!NESTABLE_RESOURCE_TYPES.has(target.node_type)) return false
  if (!NESTABLE_RESOURCE_TYPES.has(payload.nodeType)) return false
  if (!target.context_item_id || !payload.contextItemId) return false
  if (payload.contextItemId === target.context_item_id) return false
  if (!canCreateKnowledgeTreeChild(targetDepth)) return false

  const draggedNode = findKnowledgeTreeNodeByContextItemId(roots, payload.contextItemId)
  if (
    draggedNode
    && collectDescendantContextItemIds(draggedNode).has(target.context_item_id)
  ) {
    return false
  }
  return true
}

/** @deprecated 使用 canNestItemUnderTarget；保留别名避免外部残留引用 */
export function canNestDocumentUnderTarget(
  payload: KnowledgeItemReorderPayload,
  target: KnowledgeTreeNode,
  roots: KnowledgeTreeNode[],
  targetDepth = 0,
): boolean {
  return canNestItemUnderTarget(payload, target, roots, targetDepth)
}

export function resolveResourceDragDropZone(
  relY: number,
  canReorder: boolean,
  canNest: boolean,
): 'before' | 'after' | 'nest' | null {
  if (canNest && canReorder) {
    if (relY < 0.25) return 'before'
    if (relY > 0.75) return 'after'
    return 'nest'
  }
  if (canNest) return 'nest'
  if (canReorder) return relY < 0.5 ? 'before' : 'after'
  return null
}

export function knowledgeTreeNodeToContextItem(
  node: KnowledgeTreeNode,
  hostSpaceId: string,
  organizationId: string,
): SpaceContextItem {
  return {
    id: node.context_item_id ?? node.id,
    item_type: node.node_type,
    title: node.title,
    preview: '',
    resource_id: node.resource_id ?? '',
    space_id: hostSpaceId,
    organization_id: organizationId,
    collection_id: node.collection_id,
    is_pinned: node.is_pinned,
    pinned_at: null,
    order: node.order,
    is_archived: false,
    updated_at: node.updated_at,
    created_at: node.updated_at,
  }
}

export function resolveContextItemForMenu(
  node: KnowledgeTreeNode,
  hostSpaceId: string,
  organizationId: string,
  resourceBuckets: Record<string, SpaceContextItem[]>,
): SpaceContextItem {
  if (!node.context_item_id) {
    return knowledgeTreeNodeToContextItem(node, hostSpaceId, organizationId)
  }

  // 优先 organization bucket（云盘主列表），再扫其它 space/scope bucket，
  // 避免知识树右键拿不到 can_trash 等能力位。
  const preferredKeys = [
    `${hostSpaceId}:organization`,
    `${hostSpaceId}:space`,
    hostSpaceId,
  ]
  const match = (resource: SpaceContextItem) => (
    resource.id === node.context_item_id
    || (Boolean(node.resource_id) && resource.resource_id === node.resource_id)
  )

  for (const key of preferredKeys) {
    const cached = resourceBuckets[key]?.find(match)
    if (cached) return cached
  }
  for (const [key, list] of Object.entries(resourceBuckets)) {
    if (preferredKeys.includes(key)) continue
    const cached = list?.find(match)
    if (cached) return cached
  }

  return knowledgeTreeNodeToContextItem(node, hostSpaceId, organizationId)
}
