/**
 * List conversion helpers for TabDoc.
 *
 * TipTap/ProseMirror treat hardBreak as an inline node inside one paragraph.
 * Wrapping that paragraph in a list yields a single listItem with soft line
 * breaks — only the first line shows a marker. Mainstream docs (e.g. Feishu)
 * split on those breaks so each line becomes its own list item.
 */
import type { CommandProps, Editor } from '@tiptap/core'
import { TextSelection, type Transaction } from '@tiptap/pm/state'
import { canSplit } from '@tiptap/pm/transform'

export type ListConversionKind = 'bulletList' | 'orderedList' | 'taskList'

/**
 * Split hardBreaks inside the (possibly collapsed) selection into sibling
 * textblocks. Mutates `tr` in place for use inside a TipTap command chain.
 */
export function splitHardBreaksInSelectionTr(tr: Transaction): boolean {
  if (tr.selection.empty) {
    const { $from } = tr.selection
    for (let depth = $from.depth; depth > 0; depth -= 1) {
      if ($from.node(depth).isTextblock) {
        tr.setSelection(
          TextSelection.create(tr.doc, $from.start(depth), $from.end(depth)),
        )
        break
      }
    }
  }

  const { from, to } = tr.selection
  const hardBreakPositions: number[] = []
  tr.doc.nodesBetween(from, to, (node, pos) => {
    if (node.type.name === 'hardBreak') {
      hardBreakPositions.push(pos)
    }
  })

  if (hardBreakPositions.length === 0) {
    return true
  }

  const selectionFrom = from
  const selectionTo = to

  for (let index = hardBreakPositions.length - 1; index >= 0; index -= 1) {
    const pos = tr.mapping.map(hardBreakPositions[index]!)
    const node = tr.doc.nodeAt(pos)
    if (!node || node.type.name !== 'hardBreak') continue

    tr.delete(pos, pos + node.nodeSize)
    if (canSplit(tr.doc, pos)) {
      tr.split(pos)
    }
  }

  const nextFrom = tr.mapping.map(selectionFrom, -1)
  const nextTo = tr.mapping.map(selectionTo, 1)
  const left = Math.min(nextFrom, nextTo)
  const right = Math.max(nextFrom, nextTo)
  const maxPos = tr.doc.content.size
  const safeFrom = Math.max(0, Math.min(left, maxPos))
  const safeTo = Math.max(0, Math.min(right, maxPos))
  tr.setSelection(TextSelection.between(tr.doc.resolve(safeFrom), tr.doc.resolve(safeTo)))
  return true
}

function splitHardBreaksCommand({ tr }: CommandProps): boolean {
  return splitHardBreaksInSelectionTr(tr)
}

/**
 * Clear node wrappers, split hardBreaks into paragraphs, then toggle the
 * requested list type — single undo step.
 */
export function turnSelectionIntoList(
  editor: Editor,
  kind: ListConversionKind,
): boolean {
  const chain = editor.chain().focus().clearNodes().command(splitHardBreaksCommand)

  if (kind === 'bulletList') {
    return chain.toggleBulletList().run()
  }
  if (kind === 'orderedList') {
    return chain.toggleOrderedList().run()
  }
  return chain.toggleTaskList().run()
}
