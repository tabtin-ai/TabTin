import type { Node as ProseMirrorNode } from '@tiptap/pm/model'

/**
 * TabDoc 的“初始空正文”只认编辑器默认生成的唯一空段落。
 *
 * 这和 Tiptap 的 editor.isEmpty 语义不同：后者会把多个空段落也视为空，
 * 但用户按下回车后已经主动创建了正文结构，不应继续显示新文档引导。
 */
export function isPristineEmptyDocumentBody(doc: ProseMirrorNode): boolean {
  if (doc.childCount !== 1) return false

  const onlyBlock = doc.firstChild
  return onlyBlock?.type.name === 'paragraph' && onlyBlock.childCount === 0
}
