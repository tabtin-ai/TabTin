import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

interface BlockMenuTarget {
  nodePos: number
  node: ProseMirrorNode
}

const blockMenuTargets = new WeakMap<Element, BlockMenuTarget>()

export function setBlockMenuTarget(handle: Element, target: BlockMenuTarget | null): void {
  if (target) {
    blockMenuTargets.set(handle, target)
    handle.setAttribute('data-block-pos', String(target.nodePos))
    return
  }

  blockMenuTargets.delete(handle)
  handle.removeAttribute('data-block-pos')
}

export function captureBlockMenuTarget(handle: Element): BlockMenuTarget | null {
  return blockMenuTargets.get(handle) ?? null
}

export function resolveCapturedBlockMenuTarget(
  target: BlockMenuTarget,
  doc: ProseMirrorNode,
): number | null {
  if (!Number.isSafeInteger(target.nodePos) || target.nodePos < 0 || target.nodePos >= doc.content.size) {
    return null
  }

  return doc.nodeAt(target.nodePos) === target.node ? target.nodePos : null
}
