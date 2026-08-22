/**
 * sharedSessionMessages — 共享会话 Pane 的纯函数（ 文档协同式，拆出便于单测）。
 *
 * 三件事：
 * 1. merge：REST 历史与 chat store 观察流切片按 id 合并、(created_at, id) 升序——
 *    同 id 以 REST 为准；流上独有壳在 refetch 对齐前保留。SharedSessionPane 将
 *    merge 结果经 `applyLoadedMessages` 写入 store（ /  hydrate blocks）。
 * 2. 发言人名牌：user 消息按 `metadata.shared_chat_by` → `sender_user_id` →
 *    owner 归因发送者；非本人视角的消息补 `sender_display_name`（气泡自带名牌
 *    渲染挂点）与 `sender_user_id`（触发左气泡 inbound 判定）。
 * 3. 发送结果分类：shared-chat 同步响应的 `error_category` → ok / device_offline
 *    / error 三态，Pane 据此渲染离线提示条或错误 toast。
 * 4. 时间线过滤：设备不可达类 error_envelope 不进共享侧栏（底部 banner 已覆盖）。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { isContextInjectionMessage } from '@stores/chat/messages/utils/semanticMessageCount'

export const SHARED_SESSION_PAGE_SIZE = 50

interface SharedMessagePage {
  messages: ChatMessage[]
  total: number
  has_more: boolean
  oldest_id: string | null
  newest_id: string | null
}

type SharedMessageList = (
  sessionId: string,
  params?: { limit?: number; offset?: number; before?: string },
) => Promise<SharedMessagePage>

export interface SharedTimelinePage {
  messages: ChatMessage[]
  hasEarlier: boolean
  oldestId: string | null
}

/**
 * offset 模式默认从最早消息开始。共享任务首次打开必须二次定位到末页，否则长任务
 * 的最终回复和 tool_artifact 会被截在首 50 条之外。短任务只发一次请求。
 */
export async function loadLatestSharedTimelinePage(
  list: SharedMessageList,
  sessionId: string,
  limit = SHARED_SESSION_PAGE_SIZE,
): Promise<SharedTimelinePage> {
  const firstPage = await list(sessionId, { limit })
  if (!firstPage.has_more) {
    return {
      messages: firstPage.messages,
      hasEarlier: false,
      oldestId: firstPage.oldest_id,
    }
  }

  const latestOffset = Math.max(0, firstPage.total - limit)
  const latestPage = await list(sessionId, { limit, offset: latestOffset })
  return {
    messages: latestPage.messages,
    hasEarlier: latestOffset > 0,
    oldestId: latestPage.oldest_id,
  }
}

/** 与后端 `_DEVICE_UNAVAILABLE_ERROR_CATEGORIES` 对齐的设备不可达分类。 */
const DEVICE_UNAVAILABLE_CATEGORIES = new Set([
  'device_offline',
  'device_busy',
  'device_unreachable',
  'device_dropped',
  'owner_execution_device_unavailable',
])

/** (created_at, id) 元组升序：分开比较，避免拼串在时间戳互为前缀时排错。 */
function compareMessages(a: ChatMessage, b: ChatMessage): number {
  const ta = a.created_at ?? ''
  const tb = b.created_at ?? ''
  if (ta !== tb) return ta < tb ? -1 : 1
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
}

/**
 * 合并 REST 历史与观察流实时切片：同 id 以 REST 为准（字段最全，blocks 已在
 * Pane 侧反序列化；流式增量块经 MessageBubble 的 runtimeBlocks 订阅优先生效，
 * 不依赖此处的壳），流侧独有的（新 turn 尚未 refetch）追加补位。
 */
export function mergeSharedTimelineMessages(
  restMessages: ChatMessage[],
  liveMessages: ChatMessage[],
): ChatMessage[] {
  if (liveMessages.length === 0) return [...restMessages].sort(compareMessages)
  const byId = new Map<string, ChatMessage>()
  for (const message of liveMessages) byId.set(message.id, message)
  for (const message of restMessages) byId.set(message.id, message)
  return [...byId.values()].sort(compareMessages)
}

/**
 * 解析 user 消息的发送者归因：`metadata.shared_chat_by`（shared-chat 发言驱动
 * 落库标记）优先，其次 `sender_user_id`，都缺省视为 owner 本人发言。
 * 非 user 消息返回 null（assistant / system 不做名牌）。
 */
export function resolveSharedSenderId(
  message: Pick<ChatMessage, 'role' | 'sender_user_id' | 'metadata'>,
  ownerUserId: string | null | undefined,
): string | null {
  if (message.role !== 'user') return null
  const meta = message.metadata as Record<string, unknown> | null | undefined
  const sharedChatBy = typeof meta?.shared_chat_by === 'string' ? meta.shared_chat_by.trim() : ''
  if (sharedChatBy) return sharedChatBy
  const senderUserId = typeof message.sender_user_id === 'string' ? message.sender_user_id.trim() : ''
  if (senderUserId) return senderUserId
  return ownerUserId?.trim() || null
}

export interface SharedSenderDecorateContext {
  /** 当前查看者（本人消息不做名牌、保持右气泡） */
  viewerUserId: string | null | undefined
  /** 会话 owner（无显式 sender 的 user 消息归因给他） */
  ownerUserId: string | null | undefined
  /** userId → 展示名；取不到名字时不显示名牌（不回落 uuid） */
  namesById: Record<string, string>
}

/**
 * 给共享时间线的 user 消息补发言人名牌：
 * - 发送者 ≠ 查看者 → 写 `sender_user_id`（触发气泡 inbound 左对齐）+
 *   `sender_display_name`（气泡顶部名牌）；
 * - 本人消息 / 非 user 消息原样返回（右气泡、无名牌）。
 * 全程不改入参对象（浅拷贝装饰），避免污染 store 内共享引用。
 */
export function decorateSharedSenderIdentity(
  messages: ChatMessage[],
  ctx: SharedSenderDecorateContext,
): ChatMessage[] {
  const viewerId = ctx.viewerUserId ? String(ctx.viewerUserId) : ''
  return messages.map((message) => {
    const senderId = resolveSharedSenderId(message, ctx.ownerUserId)
    if (!senderId || (viewerId && senderId === viewerId)) return message
    const displayName = ctx.namesById[senderId] ?? ''
    if (
      message.sender_user_id === senderId
      && (message.sender_display_name ?? '') === displayName
    ) {
      return message
    }
    return {
      ...message,
      sender_user_id: senderId,
      ...(displayName ? { sender_display_name: displayName } : {}),
    }
  })
}

/** 名牌所需的发送者 id 全集（profile 预热用）；本人也收（头像缓存复用无害）。 */
export function collectSharedSenderIds(
  messages: ChatMessage[],
  ownerUserId: string | null | undefined,
): string[] {
  const ids = new Set<string>()
  for (const message of messages) {
    const senderId = resolveSharedSenderId(message, ownerUserId)
    if (senderId) ids.add(senderId)
  }
  return [...ids]
}

// ── shared-chat 发送结果分类 ──────────────────────────────────────────

export type SharedChatSendOutcome = 'ok' | 'device_offline' | 'error'

/**
 * shared-chat 同步响应（HTTP 200）内的 `error_category` 分类：
 * - 空 → ok；
 * - 'device_offline' → 对方设备离线（提示条，不算失败——消息已被服务端受理）；
 * - 其余 → error（toast error_message）。
 */
export function classifySharedChatSendResult(result: {
  error_category?: string | null
}): SharedChatSendOutcome {
  const category = (result.error_category ?? '').trim()
  if (!category) return 'ok'
  if (DEVICE_UNAVAILABLE_CATEGORIES.has(category)) return 'device_offline'
  return 'error'
}

/**
 * 共享侧栏不展示设备不可达 error_envelope——产品定案为底部离线条，
 * 避免与「[device_offline]… / 出了点问题」气泡重复（历史脏数据一并滤掉）。
 */
export function shouldHideSharedTimelineMessage(
  message: ChatMessage,
): boolean {
  // 共享页是协作者可读的工作过程，不是 Runtime prompt 检视器。复用主时间线
  // 的 SSoT，同时兼容明确 message_kind、旧版 <context> wrapper 与 share 元数据。
  if (isContextInjectionMessage(message)) return true
  if (message.message_kind === 'compaction_summary') return true
  if (message.message_kind !== 'error_envelope') return false
  const info = message.error_info_json
  const category = typeof info?.category === 'string' ? info.category.trim() : ''
  if (category && DEVICE_UNAVAILABLE_CATEGORIES.has(category)) return true
  // 兼容旧脏数据：只有 text、无 category 的 [device_offline] 信封
  const text = `${message.content ?? ''}\n${message.text_summary ?? ''}`
  return /\[device_offline]|\[device_busy]|\[device_unreachable]|\[device_dropped]|\[owner_execution_device_unavailable]/.test(
    text,
  )
}

/** 过滤后供 MessageList 渲染的共享时间线。 */
export function filterSharedTimelineMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.filter((message) => !shouldHideSharedTimelineMessage(message))
}

/** MessageList 实时投影使用的稳定谓词，避免 WS 新消息绕过历史 hydrate 过滤。 */
export function isSharedTimelineMessageVisible(message: ChatMessage): boolean {
  return !shouldHideSharedTimelineMessage(message)
}
