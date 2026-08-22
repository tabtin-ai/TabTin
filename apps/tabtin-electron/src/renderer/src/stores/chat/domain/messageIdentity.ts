/**
 * messageIdentity — 聊天消息身份键的唯一正典。
 *
 * 跨乐观 id / client id / 落库 UUID / runtime `local-*` 壳判断「是不是同一条消息」。
 * 所有匹配路径必须 import 这里，禁止再手写 metadata 分支。
 */

import type { ChatMessage } from '@tabtin/chat-client'

/** runtime 本机 emit 的 message_id 前缀（EnvelopeEmitter）。 */
export const RUNTIME_LOCAL_ID_PREFIX = 'local-'

/** 从消息上取客户端关联 id（发送态 / truncate / ACK 匹配优先序）。 */
export function getClientMessageId(msg: ChatMessage): string | undefined {
  if (typeof msg.client_event_id === 'string' && msg.client_event_id) {
    return msg.client_event_id
  }
  const metadata = msg.metadata as Record<string, unknown> | null | undefined
  if (typeof metadata !== 'object' || metadata === null) return undefined
  const clientMessageId = metadata.client_message_id
  if (typeof clientMessageId === 'string' && clientMessageId) return clientMessageId
  const clientEventId = metadata.client_event_id
  return typeof clientEventId === 'string' && clientEventId ? clientEventId : undefined
}

/**
 * 一条消息的全部身份键：id + 顶层 client_event_id + metadata 上的
 * client_message_id / client_event_id / message_id。
 */
export function identityKeys(msg: ChatMessage): string[] {
  const keys = new Set<string>()
  if (msg.id) keys.add(msg.id)
  if (typeof msg.client_event_id === 'string' && msg.client_event_id) {
    keys.add(msg.client_event_id)
  }
  const metadata = msg.metadata as Record<string, unknown> | null | undefined
  if (typeof metadata === 'object' && metadata !== null) {
    for (const field of ['client_message_id', 'client_event_id', 'message_id'] as const) {
      const value = metadata[field]
      if (typeof value === 'string' && value) keys.add(value)
    }
  }
  return Array.from(keys)
}

export function sharesIdentity(a: ChatMessage, b: ChatMessage): boolean {
  const bKeys = new Set(identityKeys(b))
  return identityKeys(a).some((key) => bKeys.has(key))
}

/** 按身份键索引消息，供服务端 reconcile / enrich 匹配本地行。 */
export function buildIdentityIndex(
  messages: readonly ChatMessage[],
): Map<string, ChatMessage> {
  const index = new Map<string, ChatMessage>()
  for (const message of messages) {
    for (const key of identityKeys(message)) {
      if (!index.has(key)) index.set(key, message)
    }
  }
  return index
}

export function findByIdentity(
  index: Map<string, ChatMessage>,
  msg: ChatMessage,
): ChatMessage | undefined {
  for (const key of identityKeys(msg)) {
    const found = index.get(key)
    if (found) return found
  }
  return undefined
}

/** 列表中是否已有与 candidate 共享身份的消息。 */
export function listHasIdentity(
  messages: readonly ChatMessage[],
  candidate: ChatMessage,
): boolean {
  return messages.some((message) => sharesIdentity(message, candidate))
}

/**
 * runtime 起源：壳 id 仍是 `local-*`，或 ACK 重绑后 id 已是 UUID、
 * 但 `client_event_id` 仍以 `local-*` 回写（，与  user 保命对称）。
 */
export function isRuntimeOriginMessage(msg: ChatMessage): boolean {
  if (msg.id.startsWith(RUNTIME_LOCAL_ID_PREFIX)) return true
  const clientId = getClientMessageId(msg)
  return typeof clientId === 'string' && clientId.startsWith(RUNTIME_LOCAL_ID_PREFIX)
}
