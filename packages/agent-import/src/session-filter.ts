/**
 * 导入预览 / 落档：无正文会话一律过滤（不展示、不写入空档案）。
 */

import type { ContentLayer, SessionRef } from './types.js'

/** Cursor / Claude 仅有索引头、无 transcript 时标为 header_only。 */
export function isHeaderOnlyLayer(layer: ContentLayer | string | undefined): boolean {
  return layer === 'header_only'
}

/**
 * scan 阶段可判定为「没内容」：
 * - header_only（无 jsonl / 正文已被清理）
 * - 无标题且无源路径（Codex 空壳线程等）
 */
export function isContentlessSessionRef(
  ref: Pick<SessionRef, 'layer' | 'title' | 'sourcePath'>,
): boolean {
  if (isHeaderOnlyLayer(ref.layer)) return true
  const title = ref.title?.trim() ?? ''
  const path = ref.sourcePath?.trim() ?? ''
  if (!title && !path) return true
  return false
}
