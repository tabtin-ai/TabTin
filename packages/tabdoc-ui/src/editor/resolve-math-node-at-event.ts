import type { Editor } from '@tiptap/core'

export interface ResolvedMathNode {
  pos: number
  latex: string
}

const MATH_NODE_NAMES = new Set(['mathematics', 'mathematicsBlock', 'math'])

function isMathTypeName(name: string | undefined): boolean {
  return !!name && MATH_NODE_NAMES.has(name)
}

/**
 * Resolve an inline/block math atom from a DOM click target.
 * Canonical nodes use `data-type="mathematics"` / `mathematicsBlock`；
 * 历史 Novel 节点仍为 `data-type="math"`。
 */
export function resolveMathNodeAtEvent(
  editor: Editor,
  event: MouseEvent,
): ResolvedMathNode | null {
  const target = event.target as HTMLElement | null
  const mathEl = target?.closest?.(
    '[data-type="mathematics"], [data-type="mathematicsBlock"], [data-type="math"]',
  ) as HTMLElement | null
  if (!mathEl || !editor.view) return null

  try {
    const pos = editor.view.posAtDOM(mathEl, 0)
    const nodeAt = editor.state.doc.nodeAt(pos)
    if (isMathTypeName(nodeAt?.type.name)) {
      return { pos, latex: String(nodeAt!.attrs.latex ?? '') }
    }

    const $pos = editor.state.doc.resolve(pos)
    if (isMathTypeName($pos.nodeAfter?.type.name)) {
      return {
        pos,
        latex: String($pos.nodeAfter!.attrs.latex ?? ''),
      }
    }
    if (isMathTypeName($pos.nodeBefore?.type.name)) {
      const before = $pos.nodeBefore!
      return {
        pos: pos - before.nodeSize,
        latex: String(before.attrs.latex ?? ''),
      }
    }
  } catch {
    return null
  }

  return null
}
