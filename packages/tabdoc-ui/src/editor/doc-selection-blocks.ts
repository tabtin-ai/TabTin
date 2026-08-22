import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

export function normalizeBlockText(node: ProseMirrorNode): string {
  return node.textContent.replace(/\s+/g, ' ').trim()
}

export function getNodeStringAttr(node: ProseMirrorNode, key: string): string | null {
  const value = (node.attrs as Record<string, unknown> | null | undefined)?.[key]
  return typeof value === 'string' && value.trim() ? value : null
}

export function getBlockId(node: ProseMirrorNode): string | null {
  return getNodeStringAttr(node, 'blockId') ?? getNodeStringAttr(node, 'id')
}

export function collectTopLevelBlockIdsInRange(
  doc: ProseMirrorNode,
  from: number,
  to: number,
): string[] {
  const ids: string[] = []
  const seen = new Set<string>()
  doc.nodesBetween(from, to, (node, _pos, parent) => {
    if (parent !== doc) return true
    const id = getBlockId(node)
    if (id && !seen.has(id)) {
      seen.add(id)
      ids.push(id)
    }
    return false
  })
  return ids
}
