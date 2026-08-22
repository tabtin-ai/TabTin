/**
 * ：按 ContextItem.parent_id 在前端建树（纯函数，供侧栏 / 测试复用）。
 */
export interface ContextItemTreeInput {
  id: string
  parent_id?: string | null
  item_type: string
  title?: string
  order?: number
  is_pinned?: boolean
  updated_at?: string | null
}

export interface ContextItemTreeNode<T extends ContextItemTreeInput = ContextItemTreeInput> {
  item: T
  children: ContextItemTreeNode<T>[]
}

export function buildContextItemTree<T extends ContextItemTreeInput>(
  items: T[],
  options?: { allowedTypes?: Set<string> },
): ContextItemTreeNode<T>[] {
  const allowed = options?.allowedTypes
  const filtered = allowed
    ? items.filter(item => allowed.has(item.item_type))
    : items

  const byId = new Map<string, ContextItemTreeNode<T>>()
  for (const item of filtered) {
    byId.set(item.id, { item, children: [] })
  }

  const roots: ContextItemTreeNode<T>[] = []
  for (const node of byId.values()) {
    const parentId = node.item.parent_id ?? null
    if (parentId && byId.has(parentId)) {
      byId.get(parentId)!.children.push(node)
    } else {
      roots.push(node)
    }
  }

  const sortNodes = (nodes: ContextItemTreeNode<T>[]) => {
    nodes.sort((a, b) => {
      const pinA = a.item.is_pinned ? 0 : 1
      const pinB = b.item.is_pinned ? 0 : 1
      if (pinA !== pinB) return pinA - pinB
      const orderA = a.item.order ?? 0
      const orderB = b.item.order ?? 0
      if (orderA !== orderB) return orderA - orderB
      return (b.item.updated_at || '').localeCompare(a.item.updated_at || '')
    })
    for (const node of nodes) sortNodes(node.children)
  }
  sortNodes(roots)
  return roots
}
