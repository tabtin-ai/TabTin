/**
 * TabChat 前端常量
 *
 * 集中管理 IM 模块中使用的配置常量，避免散布在各组件中。
 */

import { ACCEPTED_IMAGE_MIMES } from '@/constants/upload'

// ── 消息行为 ──
export const MESSAGE_RECALL_WINDOW_MS = 120_000

// ── 文件上传（基于统一预设） ──
export const ALLOWED_IMAGE_TYPES = ACCEPTED_IMAGE_MIMES

// ── API 分页 ──
export const MESSAGES_PAGE_SIZE = 50
export const SEARCH_PAGE_SIZE = 20

// ── 缓存与节流 ──
export const MAX_CACHED_CONVERSATIONS = 10
export const NOTIFICATION_DEBOUNCE_MS = 5_000
export const SEARCH_DEBOUNCE_MS = 300
export const ONE_DAY_MS = 86_400_000

// ── 会话类型 ──
export const CONVERSATION_TYPE_DM = 1
export const CONVERSATION_TYPE_GROUP = 2

// ── 消息类型 ──
export const MESSAGE_TYPE_TEXT = 1
export const MESSAGE_TYPE_SYSTEM = 2
export const MESSAGE_TYPE_FILE = 3
export const MESSAGE_TYPE_IMAGE = 4

// ── 标题栏历史内容筛选 ──
export const CHAT_CONTENT_FILTER_MESSAGE = 'message'
export const CHAT_CONTENT_FILTER_DOCUMENT = 'document'
export const CHAT_CONTENT_FILTER_FILE = 'file'
export const CHAT_CONTENT_FILTERS = [
  CHAT_CONTENT_FILTER_MESSAGE,
  CHAT_CONTENT_FILTER_DOCUMENT,
  CHAT_CONTENT_FILTER_FILE,
] as const
export type ChatContentFilter = typeof CHAT_CONTENT_FILTERS[number]

// ── 成员角色 ──
export const MEMBER_ROLE_MEMBER = 1
export const MEMBER_ROLE_ADMIN = 2
export const MEMBER_ROLE_OWNER = 3
