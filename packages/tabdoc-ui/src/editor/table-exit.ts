/**
 * TabDoc 原生表格：保证表后可续写 + 键盘跳出表格。
 *
 * 与标题 Enter「文首必有空段」对称——结构块后面永远有可输入段落。
 */
import { Extension } from '@tiptap/core'
import type { Editor } from '@tiptap/core'
import type { Node as PMNode, ResolvedPos } from '@tiptap/pm/model'

export type TableLocation = {
  depth: number
  pos: number
  node: PMNode
}

export function findTableLocation($pos: ResolvedPos): TableLocation | null {
  for (let depth = $pos.depth; depth > 0; depth -= 1) {
    const node = $pos.node(depth)
    if (node.type.name === 'table') {
      return { depth, pos: $pos.before(depth), node }
    }
  }
  return null
}

export function isInLastTableRow($pos: ResolvedPos, tableDepth: number): boolean {
  const table = $pos.node(tableDepth)
  return $pos.index(tableDepth) === table.childCount - 1
}

export function isInLastTableCell($pos: ResolvedPos, tableDepth: number): boolean {
  const rowDepth = tableDepth + 1
  const row = $pos.node(rowDepth)
  return $pos.index(rowDepth) === row.childCount - 1
}

/** 光标是否在单元格最后一个 textblock 的底部（便于 ArrowDown 出表）。 */
export function isAtBottomOfCell($pos: ResolvedPos, tableDepth: number): boolean {
  const cellDepth = tableDepth + 2
  if ($pos.depth < cellDepth) return false
  const cell = $pos.node(cellDepth)
  if ($pos.index(cellDepth) !== cell.childCount - 1) return false
  return $pos.parentOffset === $pos.parent.content.size
}

/**
 * 若当前选区所在表格后方没有段落，则插入空段落。
 * 默认保持表内选区（插在表后，表内 pos 不变）。
 */
export function ensureParagraphAfterCurrentTable(
  editor: Editor,
  options: { keepSelection?: boolean } = { keepSelection: true },
): boolean {
  const { state } = editor
  const table = findTableLocation(state.selection.$from)
  if (!table) return false

  const afterPos = table.pos + table.node.nodeSize
  if (afterPos < state.doc.content.size) {
    const following = state.doc.nodeAt(afterPos)
    if (following?.type.name === 'paragraph') return true
  }

  const { from, to } = state.selection
  const chain = editor.chain().insertContentAt(afterPos, { type: 'paragraph' })
  if (options.keepSelection !== false) {
    chain.setTextSelection({ from, to })
  }
  return chain.run()
}

/** 光标移到表后段落开头；若无段落则先创建。 */
export function exitTableForward(editor: Editor): boolean {
  if (!findTableLocation(editor.state.selection.$from)) return false
  ensureParagraphAfterCurrentTable(editor, { keepSelection: true })

  const table = findTableLocation(editor.state.selection.$from)
  if (!table) return false

  const afterPos = table.pos + table.node.nodeSize
  return editor.chain().focus().setTextSelection(afterPos + 1).run()
}

export const TableExit = Extension.create({
  name: 'tableExit',

  addKeyboardShortcuts() {
    return {
      ArrowDown: () => {
        const { $from } = this.editor.state.selection
        const table = findTableLocation($from)
        if (!table) return false
        if (!isInLastTableRow($from, table.depth)) return false
        if (!isAtBottomOfCell($from, table.depth)) return false
        return exitTableForward(this.editor)
      },
      Enter: () => {
        const { $from } = this.editor.state.selection
        const table = findTableLocation($from)
        if (!table) return false
        if (!isInLastTableRow($from, table.depth)) return false
        if (!isInLastTableCell($from, table.depth)) return false
        if ($from.parent.type.name !== 'paragraph') return false
        if ($from.parent.content.size > 0) return false
        const cellDepth = table.depth + 2
        const cell = $from.node(cellDepth)
        if ($from.index(cellDepth) !== cell.childCount - 1) return false
        return exitTableForward(this.editor)
      },
    }
  },
})
