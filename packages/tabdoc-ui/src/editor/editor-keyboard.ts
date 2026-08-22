import type { Editor } from '@tiptap/core'
import type { EditorState } from '@tiptap/pm/state'

/** 正文绝对起点可返回标题的键盘动作。 */
export function isBodyStartTitleNavigationKey(event: KeyboardEvent): boolean {
  const key = event.key.toLowerCase()
  const isSupportedKey = key === 'backspace' || key === 'arrowup'
  const isSelectingWithArrow = key === 'arrowup' && event.shiftKey
  return isSupportedKey
    && !isSelectingWithArrow
    && !event.isComposing
    && !event.altKey
    && !event.ctrlKey
    && !event.metaKey
}

/**
 * 把正文绝对起点的退格导航到标题末尾。
 *
 * 只认折叠光标的 ProseMirror 位置 1；这样正文内删除、选区删除，以及列表等
 * 嵌套结构自己的退级行为仍由编辑器处理。
 */
export function focusTitleFromBodyStart(
  state: EditorState,
  titleInput: HTMLTextAreaElement | null,
  editable = true,
): boolean {
  const { selection } = state
  if (!editable || !titleInput || !selection.empty || selection.from !== 1) return false

  titleInput.focus()
  const titleEnd = titleInput.value.length
  titleInput.setSelectionRange(titleEnd, titleEnd)
  return true
}

/** 在代码块内消费 Tab 并插入一个制表缩进；其它节点继续交给浏览器处理。 */
export function insertCodeBlockTab(editor: Editor): boolean {
  if (!editor.isActive('codeBlock')) return false

  const { selection } = editor.state
  if (selection.empty) return editor.commands.insertContent('\t')

  const { $from, $to } = selection
  if ($from.parent !== $to.parent || $from.parent.type.name !== 'codeBlock') return false

  const blockText = $from.parent.textContent
  const firstLineStart = blockText.lastIndexOf('\n', Math.max(0, $from.parentOffset - 1)) + 1
  const selectedLineStarts = [firstLineStart]

  let newlineOffset = blockText.indexOf('\n', firstLineStart)
  while (newlineOffset >= 0 && newlineOffset + 1 < $to.parentOffset) {
    selectedLineStarts.push(newlineOffset + 1)
    newlineOffset = blockText.indexOf('\n', newlineOffset + 1)
  }

  const blockStart = $from.start()
  return editor.commands.command(({ tr, dispatch }) => {
    for (let index = selectedLineStarts.length - 1; index >= 0; index -= 1) {
      tr.insertText('\t', blockStart + selectedLineStarts[index])
    }
    dispatch?.(tr)
    return true
  })
}
