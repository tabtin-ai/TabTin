/**
 * 用户消息里「切会话 / sync 覆盖时必须保留」的 block 判定。
 *
 * 反向白名单：text / 上传附件 / ContextRef codec 已登记类型 / 气泡直接渲染的特例。
 * 不按 20+ 类型枚举追赶——新 context 类型进 `BLOCK_TYPE_TO_REF` 即自动覆盖。
 */

import { BLOCK_TYPE_TO_REF } from './contextRefCodec'

/** codec 未登记但气泡 / 落库已在用的 user 块类型 */
const EXTRA_PRESERVED_USER_BLOCK_TYPES = new Set([
  'text',
  'image',
  'file',
  'video',
  'document',
  'table',
  'plan',
  'composer_preset',
])

export function isUserPreservedBlock(block: unknown): block is Record<string, unknown> {
  if (!block || typeof block !== 'object') return false
  const type = (block as { type?: unknown }).type
  if (typeof type !== 'string' || type.length === 0) return false
  if (EXTRA_PRESERVED_USER_BLOCK_TYPES.has(type)) return true
  return Object.prototype.hasOwnProperty.call(BLOCK_TYPE_TO_REF, type)
}

export function isUserMediaBlock(block: unknown): block is Record<string, unknown> {
  if (!block || typeof block !== 'object') return false
  const type = (block as { type?: unknown }).type
  return type === 'image' || type === 'file' || type === 'video'
}

/** 聊天附件卡投影范围（含 document；不含 ContextRef / composer_preset）。 */
export function isUserAttachmentMediaBlock(
  block: unknown,
): block is Record<string, unknown> {
  if (!block || typeof block !== 'object') return false
  const type = (block as { type?: unknown }).type
  return (
    type === 'image'
    || type === 'file'
    || type === 'video'
    || type === 'document'
  )
}

export function userPreservedBlockKey(block: Record<string, unknown>): string | null {
  const type = typeof block.type === 'string' ? block.type : ''
  if (!type) return null

  if (type === 'image' || type === 'file' || type === 'video') {
    const fileId = typeof block.file_id === 'string' ? block.file_id : ''
    if (fileId) return `${type}:fid:${fileId}`
    const url = typeof block.url === 'string' ? block.url : ''
    if (url) return `${type}:url:${url}`
    const source = block.source as { url?: unknown } | undefined
    if (source && typeof source.url === 'string' && source.url) return `${type}:url:${source.url}`
    return null
  }

  // ContextRef：优先稳定资源 id 字段，否则 type+preview
  for (const key of [
    'table_id', 'document_id', 'file_id', 'field_id', 'memo_id', 'whiteboard_id',
    'connection_id', 'slide_id', 'video_id', 'site_id', 'folder_id', 'tracker_id',
    'phone_id', 'desktop_id', 'terminal_id', 'plan_id', 'resource_id', 'session_id',
  ] as const) {
    const value = block[key]
    if (typeof value === 'string' && value.length > 0) return `${type}:${key}:${value}`
  }
  const preview = typeof block.preview === 'string' ? block.preview : ''
  if (preview) return `${type}:preview:${preview}`
  return `${type}:raw:${JSON.stringify(block).slice(0, 120)}`
}
