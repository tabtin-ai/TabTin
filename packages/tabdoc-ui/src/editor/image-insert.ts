import type { EditorView } from '@tiptap/pm/view'

/** Shared attrs for inserting an image into TabDoc (paste / drop / toolbar / file-ref). */
export type TabDocImageInsertAttrs = {
  src: string
  fileId?: string | null
  alt?: string | null
  /** Only pin width; avoid baking height so CSS height:auto is not overridden. */
  width?: number
}

/**
 * Insert an inline image at an exact document position.
 * Single insert path for paste, local drop, slash, toolbar import, and chat file-ref.
 * When `pos` is not inside inline content, wrap the image in a paragraph.
 */
export function insertUploadedImage(
  view: Pick<EditorView, 'state' | 'dispatch'>,
  pos: number,
  srcOrAttrs: string | TabDocImageInsertAttrs,
): number {
  const { state } = view
  const imageType = state.schema.nodes.image
  if (!imageType) return pos

  const attrs = normalizeImageInsertAttrs(srcOrAttrs)
  const imageNode = imageType.create(attrs)
  const docSize = state.doc.content.size
  const insertPos = Math.max(0, Math.min(pos, docSize))
  const $pos = state.doc.resolve(insertPos)

  if ($pos.parent.inlineContent) {
    view.dispatch(state.tr.insert(insertPos, imageNode).scrollIntoView())
    return insertPos + imageNode.nodeSize
  }

  const paragraphType = state.schema.nodes.paragraph
  const node = paragraphType ? paragraphType.create(null, imageNode) : imageNode
  view.dispatch(state.tr.insert(insertPos, node).scrollIntoView())
  return insertPos + node.nodeSize
}

function normalizeImageInsertAttrs(
  srcOrAttrs: string | TabDocImageInsertAttrs,
): Record<string, unknown> {
  if (typeof srcOrAttrs === 'string') {
    return { src: srcOrAttrs }
  }
  const attrs: Record<string, unknown> = { src: srcOrAttrs.src }
  if (srcOrAttrs.fileId !== undefined) {
    attrs.fileId = srcOrAttrs.fileId
  }
  if (srcOrAttrs.alt !== undefined) {
    attrs.alt = srcOrAttrs.alt
  }
  if (typeof srcOrAttrs.width === 'number' && srcOrAttrs.width > 0) {
    attrs.width = srcOrAttrs.width
  }
  return attrs
}
