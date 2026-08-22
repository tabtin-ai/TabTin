import type { EditorInstance } from 'novel'
import {
  pmJsonToMarkdown,
  repairLeakedHtmlBlockInPmJson,
} from '@tabtin/doc-editor'
import { unescapeLatexInMath } from '../utils/markdown'

export interface EditorContentSnapshot {
  pmJson: Record<string, unknown>
  markdown: string
  repaired: boolean
}

export function pmJsonContainsStableImageAssets(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.some(pmJsonContainsStableImageAssets)
  }
  if (!value || typeof value !== 'object') return false
  const node = value as Record<string, unknown>
  if (node.type === 'image') {
    const attrs = node.attrs
    if (attrs && typeof attrs === 'object') {
      const fileId = (attrs as Record<string, unknown>).fileId
      if (typeof fileId === 'string' && fileId.trim()) return true
    }
  }
  return pmJsonContainsStableImageAssets(node.content)
}

/**
 * 从编辑器取出 pmJson + markdown，并在检测到 htmlBlock 泄漏时原地修回节点。
 *
 * repair 后 markdown 改走 pmJsonToMarkdown（与 Django/cli 契约一致），
 * 避免 tiptap-markdown 段落路径再次写坏单行 `:::htmlblock{...} :::`。
 */
export function snapshotEditorContentWithRepair(editor: EditorInstance): EditorContentSnapshot {
  const rawPmJson = editor.getJSON() as Record<string, unknown>
  const { pmJson, repaired } = repairLeakedHtmlBlockInPmJson(rawPmJson)

  if (repaired) {
    editor.commands.setContent(pmJson as never, false)
  }

  const hasMarkdownStorage = typeof editor.storage.markdown?.getMarkdown === 'function'
  const markdown = repaired || !hasMarkdownStorage || pmJsonContainsStableImageAssets(pmJson)
    ? pmJsonToMarkdown(pmJson)
    : unescapeLatexInMath((editor.storage.markdown?.getMarkdown?.() as string) ?? '')

  return {
    pmJson: pmJson as Record<string, unknown>,
    markdown,
    repaired,
  }
}

/** 协作/首次挂载：Yjs 里可能已是泄漏段落，进编辑器后立刻修一次。 */
export function repairLeakedHtmlBlocksInEditor(editor: EditorInstance): boolean {
  const { repaired } = snapshotEditorContentWithRepair(editor)
  return repaired
}
