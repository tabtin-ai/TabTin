/**
 * 对话模块多模态类型定义
 */

import {
  UPLOAD_PRESETS,
  ACCEPTED_IMAGE_MIMES,
  ACCEPTED_DOCUMENT_MIMES,
  ACCEPTED_MEDIA_MIMES,
  isImageMime,
  isMediaMime,
  validateUploadFile,
  formatFileSize as _formatFileSize,
} from '@/constants/upload'
import type { ReplyToPreview } from '@tabtin/chat-client'

/** 附件状态 */
export type AttachmentStatus = 'pending' | 'uploading' | 'ready' | 'error'

/** 附件基础结构 */
export interface ChatAttachment {
  /** 前端临时 ID */
  id: string
  /** 原始文件对象 */
  file: File
  /** 文件名 */
  filename: string
  /** MIME 类型 */
  mimeType: string
  /** 文件大小（字节） */
  size: number
  /** 附件类型 */
  type: 'image' | 'file' | 'video'
  /** 上传状态 */
  status: AttachmentStatus
  /** 本地预览 URL（图片用） */
  previewUrl?: string
  /** 上传后的服务端文件 ID */
  fileId?: string
  /** 上传后的远程 URL */
  remoteUrl?: string
  /** 添加即上传时的实时进度（0-1），仅 status='uploading' 期间有意义 */
  uploadProgress?: number
  /** 错误信息 */
  error?: string
  /** Composer Preset 槽位标识（upload 字段的 key，如 'first_frame'） */
  presetSlotKey?: string
  /** Composer Preset 实例 ID */
  presetInstanceId?: string
}

/** 文件大小限制 — getter 保证始终读到最新（远程配置更新后）值 */
export const FILE_LIMITS = {
  get MAX_IMAGE_SIZE() { return UPLOAD_PRESETS.IMAGE.maxSize },
  get MAX_FILE_SIZE() { return UPLOAD_PRESETS.FILE.maxSize },
  get MAX_MEDIA_SIZE() { return UPLOAD_PRESETS.MEDIA.maxSize },
  MAX_ATTACHMENTS: 10,
} as const

/** 支持的图片 MIME 类型 — 实时从 Set 读取，远程配置更新后自动生效 */
export function getAcceptedImageTypes(): string[] {
  return Array.from(ACCEPTED_IMAGE_MIMES)
}

/** 支持的文档 MIME 类型 — 实时从 Set 读取 */
export function getAcceptedFileTypes(): string[] {
  return Array.from(ACCEPTED_DOCUMENT_MIMES)
}

/** 支持的媒体 MIME 类型（视频/音频）— 实时从 Set 读取 */
export function getAcceptedMediaTypes(): string[] {
  return Array.from(ACCEPTED_MEDIA_MIMES)
}

/** 判断是否为图片类型 */
export function isImageType(mimeType: string): boolean {
  return isImageMime(mimeType)
}

/** 判断是否为媒体类型（视频/音频） */
export function isMediaType(mimeType: string): boolean {
  return isMediaMime(mimeType)
}

/** 判断是否为视频类型（ 原生 video_url 直传） */
export function isVideoType(mimeType: string): boolean {
  return (mimeType || '').toLowerCase().startsWith('video/')
}

/** 判断文件是否超过大小限制 */
export function isFileTooLarge(file: File): boolean {
  const preset = isImageMime(file.type) ? 'IMAGE' : isMediaMime(file.type) ? 'MEDIA' : 'FILE'
  return !validateUploadFile(file, preset).valid
}

/** 人类可读的文件大小 */
export const formatFileSize = _formatFileSize

/** 创建附件对象 */
export function createAttachment(file: File): ChatAttachment {
  const isImage = isImageType(file.type)
  const isVideo = !isImage && isVideoType(file.type)
  const type: ChatAttachment['type'] = isImage ? 'image' : isVideo ? 'video' : 'file'
  return {
    id: `att-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    file,
    filename: file.name,
    mimeType: file.type,
    size: file.size,
    type,
    status: 'pending',
    // 视频不写 blob previewUrl（composer 用 ObjectURL 本地预览，避免短命 blob 落库）
    previewUrl: isImage ? URL.createObjectURL(file) : undefined,
  }
}

/** 释放附件预览 URL */
export function revokeAttachmentPreview(attachment: ChatAttachment): void {
  if (attachment.previewUrl) {
    URL.revokeObjectURL(attachment.previewUrl)
  }
}

/* ============================================================
 * P1: 上下文引用类型
 * ============================================================ */

/**
 * 上下文引用类型
 *
 * 历史背景：
 * - 'table' / 'document' / 'field' 等是早期 @ 引用类型，后端 resolver 会查询 schema + 采样数据
 *   （较"轻"但仍带数据库查询）
 * - 'table_selection' / 'doc_selection' / 'code_selection' / 'web_selection' 是片段引用，
 *   带具体选区信息
 * - 'web_annotation' 是网页注释引用，统一承载文字选区、DOM 命中与区域截图
 * - 'webpage' / 'memo' / 'whiteboard' / 'phone_device' / 'desktop_device' / 'terminal_session'
 *   / 'tracker' / 'agenda_event' 是「整个 tab 资源」引用，由 tab 右键 / 输入框 @ 选 tab 触发，
 *   纯轻量元数据，后端只渲染 ID + 标题给 Agent，由 Agent 自主决定调工具读详情
 */
export type ContextRefType =
  | 'table'
  | 'document'
  | 'field'
  | 'table_selection'
  | 'doc_selection'
  | 'code_file'
  | 'code_selection'
  | 'web_selection'
  | 'web_annotation'
  | 'slide'
  | 'video'
  | 'site'
  | 'folder'
  // 「Agent 产物在 Space 内的打开」W2 manifest opens 配套（RFC v1.0 §5.4 / §5.5）：
  // 'file' 是 tabfiles / tabfolder 兜底打开的资源轴；'email_thread' 是 tabmail mailto: 接管承载类型
  | 'file'
  | 'email_thread'
  // ─── 整个 tab 资源引用（轻量）─────────────────────────
  | 'webpage'
  | 'memo'
  | 'whiteboard'
  | 'phone_device'
  | 'desktop_device'
  | 'terminal_session'
  | 'tracker'
  | 'agenda_event'
  /** 单条消息选择的 MCP server focus；resourceId 是本机 connection_id。 */
  | 'mcp_server'
  /** 跨对话引用（粘贴「复制对话引用」产物） */
  | 'conversation_reference'

/** 上下文引用 */
export interface ContextRef {
  /** 前端临时 ID */
  id: string
  /** 引用类型 */
  type: ContextRefType
  /** 资源 ID（表格/文档 ID、网页 URL、设备 ID 等） */
  resourceId: string
  /** 显示名称 */
  label: string
  /**
   * 来源 tab 类型（如 'tabweb' / 'tabdata'），用于在用户消息和后端记录里
   * 还原"这条引用从哪个 App 来"；MentionPopover 走资源池入口时为 undefined。
   */
  tabType?: string
  /** 所属 Space ID */
  spaceId?: string
  /** 所属 Space 名称 */
  spaceName?: string
  /** 额外数据 */
  meta?: Record<string, unknown>
}

/** @提及搜索结果项 */
export interface MentionItem {
  id: string
  type: ContextRefType
  label: string
  /** 副标题（项目名/表格名） */
  subtitle?: string
  resourceId: string
  /** 字段所属表格ID（type=field 时） */
  tableId?: string
  /** 来源 tab 类型（"打开的标签"分类时填充） */
  tabType?: string
  spaceId?: string
  spaceName?: string
  icon?: string
  /** 额外元数据（用于 buildContextAttachment 的预填字段） */
  meta?: Record<string, unknown>
}

/* ============================================================
 * 发送阻断原因（submission guards 与历史队列 flush 共用枚举）
 * ============================================================ */

/**
 * 发送被阻断时的分类原因（产品域 submission guards 使用）。
 */
export type QueueFlushFailReason =
  | 'sending_lock'
  | 'restoring'
  | 'awaiting_approval'
  | 'awaiting_ask_user'
  | 'no_runtime'
  | 'no_model'
  | 'no_session'
  | 'attachment_failed'
  | 'attachment_aborted'
  | 'lock_wait_timeout'
  | 'project_task_run_required'
  | 'unknown_error'

/** 创建上下文引用 */
export function createContextRef(
  type: ContextRefType,
  resourceId: string,
  label: string,
  extra?: Partial<ContextRef>
): ContextRef {
  // 注：extra 里也可能携带 spaceId / spaceName / tabType / meta；
  // 用 ...extra 一次性展开，再用必填字段（type/resourceId/label）显式覆盖以防 extra 误传。
  return {
    ...extra,
    id: `ref-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type,
    resourceId,
    label,
  }
}
