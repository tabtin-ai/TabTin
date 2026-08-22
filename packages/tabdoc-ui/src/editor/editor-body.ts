import type { EditorInstance } from 'novel'
import {
  markdownToPmJson,
  normalizeMathPmJson,
  repairLeakedHtmlBlockInPmJson,
} from '@tabtin/doc-editor'

import { normalizeMathForEditor } from '../utils/markdown'

export type TabDocInitialEditorContent = string | Record<string, unknown>

function isProseMirrorDocument(
  value: Record<string, unknown> | null | undefined,
): boolean {
  return value?.type === 'doc' && Array.isArray(value.content)
}

/**
 * 初始化编辑器内容：优先 PM JSON；否则把 Markdown（含 :::tabdata 等平台指令）
 * 转成 PM JSON，避免断线/legacy 回拉时把指令当纯文本泄漏。
 *
 * PM JSON 路径会归一历史公式节点：`math` → `mathematics`，
 * 顶层 `mathematics{display:true}` → `mathematicsBlock`。
 */
export function resolveInitialEditorContent(
  initialPmJson: Record<string, unknown> | null | undefined,
  initialMarkdown: string,
): TabDocInitialEditorContent {
  if (isProseMirrorDocument(initialPmJson)) {
    const normalized = normalizeMathPmJson(initialPmJson as Record<string, unknown>)
    return repairLeakedHtmlBlockInPmJson(normalized).pmJson
  }
  if (!initialMarkdown) return ''
  const normalized = normalizeMathForEditor(initialMarkdown)
  try {
    return normalizeMathPmJson(
      markdownToPmJson(normalized) as Record<string, unknown>,
    )
  } catch {
    return normalized
  }
}

/**
 * 标题 Enter 的产品语义：正文第一行必须是可输入的空段落。
 * 已有空段落时只聚焦，避免重复操作不断堆积空行；否则在同一事务里插入并聚焦。
 */
export function focusEditorBodyFromTitle(
  editor: EditorInstance | null,
): boolean {
  if (!editor?.isEditable) return false

  const firstBlock = editor.state.doc.firstChild
  const hasLeadingEmptyParagraph =
    firstBlock?.type.name === 'paragraph' && firstBlock.content.size === 0
  const chain = editor.chain().focus('start')

  return hasLeadingEmptyParagraph
    ? chain.run()
    : chain.insertContentAt(0, { type: 'paragraph' }).run()
}

/** 标题末尾按向下键时进入既有正文开头，不插入或改写正文。 */
export function focusEditorBodyFromTitleArrowDown(
  editor: EditorInstance | null,
  titleInput: HTMLTextAreaElement,
): boolean {
  const titleEnd = titleInput.value.length
  const caretIsAtEnd = titleInput.selectionStart === titleEnd
    && titleInput.selectionEnd === titleEnd
  if (!editor?.isEditable || !caretIsAtEnd) return false

  return editor.chain().focus('start').run()
}
