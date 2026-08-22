/**
 * TabDoc 评论线程公共类型（comment_threads_v1）。
 * 与 Django DocumentCommentService 序列化字段对齐；旧 comments API 不受影响。
 */

export const COMMENT_THREADS_CAPABILITY = 'comment_threads_v1' as const

export type CommentThreadScope = 'document' | 'text_range' | 'block'
export type CommentThreadStatus = 'open' | 'resolved'
/** 后端存储：none | attached | orphaned；UI 亦接受 detached 同义 */
export type CommentAnchorStatus = 'none' | 'attached' | 'orphaned' | 'detached'
export type CommentMessageKind = 'root' | 'reply'
export type CommentAttachmentType = 'image' | 'file'

export type CommentThreadStatusFilter = 'open' | 'resolved' | 'all'

/**
 * Anchor V1：版本化 JSON，解析优先级见 editor/comments/anchor.ts
 * Yjs 相对位置 → blockId/offset → 上下文匹配 → detached
 */
export interface CommentAnchorV1 {
  version: 1
  /** Base64(Y.encodeRelativePosition) — 协作编辑器可用时优先 */
  yjs_from?: string
  yjs_to?: string
  /** UniqueID blockId 列表（起→止，跨块有序） */
  block_ids?: string[]
  /** 首块 textContent 内起始字符偏移（text_range） */
  start_offset?: number
  /** 末块 textContent 内结束字符偏移（text_range，exclusive） */
  end_offset?: number
  /** 选区原文快照（展示 + 上下文回退） */
  selected_text?: string
  /** 选区前缀/后缀（归一化空白后截断），用于模糊重匹配 */
  prefix_text?: string
  suffix_text?: string
  /** 整块锚点节点类型提示：image / table / tabdataBlock / tabwhiteboard / htmlBlock 等 */
  block_type?: string
  /** 行内节点相对所属顶层块起点的 ProseMirror 位置（例如段落中的图片） */
  node_offset?: number
  /** 行内节点创建锚点时的 nodeSize，用于精确恢复节点范围 */
  node_size?: number
  /** 行内节点自身的稳定标识；节点跨块移动后仍可定位 */
  node_id?: string
}

export interface CommentAttachment {
  id: string
  type: CommentAttachmentType
  file_id: string
  metadata: {
    file_name?: string
    file_size?: number
    mime_type?: string
    width?: number
    height?: number
    [key: string]: unknown
  }
  /** 鉴权预览路径（非永久 OSS 地址） */
  preview_url: string
}

export interface CommentMessage {
  id: string
  thread_id: string
  kind: CommentMessageKind
  author_name: string
  author_user_id?: string | null
  author_avatar?: string | null
  author_account_name?: string | null
  body: string
  mention_user_ids: string[]
  client_request_id?: string | null
  is_deleted: boolean
  attachments: CommentAttachment[]
  created_at: string | null
  updated_at: string | null
}

export interface CommentThread {
  id: string
  document_id: string
  scope: CommentThreadScope
  status: CommentThreadStatus
  anchor: CommentAnchorV1 | Record<string, unknown>
  anchor_status: CommentAnchorStatus
  /** 客户端便利字段：优先取 anchor.selected_text */
  selected_text?: string
  created_by_user_id?: string | null
  resolved_by_user_id?: string | null
  resolved_at?: string | null
  created_at: string | null
  updated_at: string | null
  messages: CommentMessage[]
}

export interface CommentAttachmentUploadCredential {
  upload_url: string
  upload_token: string
  method: string
  headers: Record<string, string>
  expires_in: number
}

export interface CommentAttachmentConfirmResult {
  file_id: string
  type: CommentAttachmentType
  metadata: CommentAttachment['metadata']
  preview_url: string
}

export interface CreateCommentThreadInput {
  body?: string
  attachment_ids?: string[]
  scope?: CommentThreadScope
  anchor?: CommentAnchorV1 | Record<string, unknown>
  selected_text?: string
  mention_user_ids?: string[]
  client_request_id?: string
  author_name?: string
}

export interface AddCommentMessageInput {
  body?: string
  attachment_ids?: string[]
  mention_user_ids?: string[]
  client_request_id?: string
  author_name?: string
}

export interface ReanchorCommentThreadInput {
  scope: 'text_range' | 'block'
  anchor: CommentAnchorV1 | Record<string, unknown>
}

export interface ListCommentThreadsResult {
  threads: CommentThread[]
  capabilities: string[]
}

export function hasCommentThreadsCapability(capabilities: readonly string[] | null | undefined): boolean {
  return Array.isArray(capabilities) && capabilities.includes(COMMENT_THREADS_CAPABILITY)
}

export function isAnchorDetached(status: CommentAnchorStatus | string | null | undefined): boolean {
  return status === 'orphaned' || status === 'detached'
}

export function threadSelectedText(thread: Pick<CommentThread, 'anchor' | 'selected_text'>): string {
  if (typeof thread.selected_text === 'string' && thread.selected_text.trim()) {
    return thread.selected_text
  }
  const anchor = thread.anchor as { selected_text?: unknown } | null | undefined
  const fromAnchor = typeof anchor?.selected_text === 'string' ? anchor.selected_text : ''
  return fromAnchor
}
