/**
 * mergeMessagesFromServer — 本地为底的身份 upsert（对账唯一 merge）。
 *
 * - 按身份键（id / client_event_id / message_id）缝合后更新
 * - 本地有、本页没有的行保留
 * - 服务端独有行追加（回退 summary 之前的旧行除外）
 */

import type { ChatMessage } from '@tabtin/chat-client'
import type { LocalChatMessage } from '@/stores/chat/shared/types'
import { sortMessagesForTimeline } from './messageTimelineOrder'
import { mergeMessageShellFillMissing, reconcileServerMessageBlocks } from './blockMergePolicy'
import {
  buildIdentityIndex,
  findByIdentity,
  getClientMessageId,
  isRuntimeOriginMessage,
  sharesIdentity,
} from './messageIdentity'
import {
  appendMissingUserAttachmentMediaBlocks,
  appendMissingUserMediaBlocks,
  attachmentBlocksFromLocalJson,
} from './userMediaMerge'
import { preferServerDisplayContent } from './preferServerDisplayContent'

export {
  buildIdentityIndex,
  findByIdentity,
  getClientMessageId,
  identityKeys,
  isRuntimeOriginMessage,
  listHasIdentity,
  RUNTIME_LOCAL_ID_PREFIX,
  sharesIdentity,
} from './messageIdentity'

export interface MergeResult {
  messages: ChatMessage[]
  changed: boolean
  newCount: number
}

const REWIND_SUMMARY_ID_PREFIX = 'rewind-summary-'

/** 从 content_blocks_json 拼接全部 text 块（不截断）。 */
function fullTextFromBlocks(blocks: unknown): string {
  if (!Array.isArray(blocks)) return ''
  const parts: string[] = []
  for (const block of blocks) {
    if (block && typeof block === 'object' && (block as { type?: string }).type === 'text') {
      const text = (block as { text?: unknown }).text
      if (typeof text === 'string' && text.length > 0) parts.push(text)
    }
  }
  return parts.join('\n')
}

/**
 * 用户消息壳以 local 为底，服务端只补缺。
 *
 * - 正文：本地更长则留本地（抵消 GET /messages 曾把 content 映射为 text_summary 前 200 字）；
 *   否则用服务端补缺。例外见 {@link preferServerDisplayContent}。
 * - content_blocks_json：以本地为底，补服务端独有 media；本地 attachments_json
 *   仍可补回缺失附件。prefer-server-display 时 text 块改用服务端。
 * - sendStatus：本地瞬态，服务端不携带，必须保留。
 */
function mergeUserContentForDisplay(local: ChatMessage, server: ChatMessage): ChatMessage {
  const fromServerBlocks = fullTextFromBlocks(server.content_blocks_json)
  const fromLocalBlocks = fullTextFromBlocks(local.content_blocks_json)
  const serverContent = fromServerBlocks || server.content || ''
  const localContent = local.content || fromLocalBlocks || ''
  const preferServerDisplay = preferServerDisplayContent(localContent, serverContent)
  // 取更长者：抵消 GET 曾把 content 映射为 text_summary（前 200 字）。
  const content = preferServerDisplay
    ? serverContent
    : (localContent.length >= serverContent.length ? localContent : serverContent)
  const sendStatus = (local as LocalChatMessage).sendStatus

  const localJson = Array.isArray(local.content_blocks_json)
    ? [...local.content_blocks_json]
    : []
  const serverJson = Array.isArray(server.content_blocks_json)
    ? [...server.content_blocks_json]
    : []

  // 块表：本地有则本地为底；本地无则用服务端整表补缺。再补对方独有 media / 本地 attachments。
  // ：display 正文以服务端为准时，text 基底也切到服务端，避免块表仍是完整模板。
  const baseBlocks: unknown[] = preferServerDisplay && serverJson.length > 0
    ? [...serverJson]
    : (localJson.length > 0 ? localJson : [...serverJson])
  const mediaCandidates: unknown[] = [
    ...attachmentBlocksFromLocalJson(local.attachments_json),
    ...(preferServerDisplay
      ? localJson
      : (localJson.length > 0 ? serverJson : localJson)),
  ]
  const { blocks: mergedBlocks } = appendMissingUserMediaBlocks(baseBlocks, mediaCandidates)
  // 仅附件 media 新增时清 blocks；ContextRef / preset 补缺不触发重灌。
  const { added: mediaAdded } = appendMissingUserAttachmentMediaBlocks(
    baseBlocks,
    mediaCandidates,
  )

  // 补到 image/file 后清掉残缺 runtime blocks，交给入口 hydrate 从 json 重灌，
  // 避免时间线物化继续用「只有 text 的 blocks」盖掉附件。
  const merged = mergeMessageShellFillMissing(local, server, {
    content,
    content_blocks_json: mergedBlocks as ChatMessage['content_blocks_json'],
    ...(mediaAdded ? { blocks: undefined } : {}),
  })
  return sendStatus ? { ...merged, sendStatus } as LocalChatMessage : merged
}

function isLocalPendingMessage(msg: ChatMessage): boolean {
  return msg.id.startsWith('temp-user-') || msg.id.startsWith('temp-ai-')
}

/**
 * 本地发起的用户消息（含 ACK 后已换成 server UUID 的行）。
 *
 * `message_persisted` 会把 `temp-user-*` 重绑成 UUID，此时 id 前缀保护失效，
 * 但 `client_message_id` / `client_event_id` 与本地瞬态 `sendStatus` 仍在。
 * 权威替换若 latest page 尚未含该行，必须保命——否则 UI 气泡消失而
 * runtime/LLM 仍在跑。
 *
 * 判定收窄为「有 client id + 本地 sendStatus」：纯服务端历史 user 也常带
 * client_event_id，不能单凭 client id 保命，否则会挡住「服务端故意去掉」的收敛。
 */
function isLocalOriginUserMessage(msg: ChatMessage): boolean {
  if (msg.role !== 'user') return false
  if (isLocalPendingMessage(msg)) return true
  if (!getClientMessageId(msg)) return false
  const sendStatus = (msg as LocalChatMessage).sendStatus
  return sendStatus === 'sending' || sendStatus === 'sent' || sendStatus === 'failed'
}

/**
 * 从整表权威替换中拣出必须保留的本地消息：
 * - 乐观占位（temp-*）恒保留
 * - 本地发起 user（ACK 后 UUID + client id + sendStatus）恒保留
 * - runtime 起源且服务端页无共享身份的消息恒保留
 *
 * 保护依据是消息内容态，不再依赖「本机会话 / 观察会话」来源标志。服务端一旦出现
 * 共享身份行，`sharesIdentity` 会让本地行自然退出保留集合并完成缝合。
 */
function collectPreservedLocalMessages(
  existing: ChatMessage[],
  fresh: ChatMessage[],
): ChatMessage[] {
  return existing.filter(local =>
    (
      isLocalPendingMessage(local)
      || isLocalOriginUserMessage(local)
      || isRuntimeOriginMessage(local)
    )
    && !fresh.some(server => sharesIdentity(server, local)),
  )
}

function isRewindSummaryMessage(msg: ChatMessage): boolean {
  return msg.role === 'system' && msg.id.startsWith(REWIND_SUMMARY_ID_PREFIX)
}

function getCreatedAtMs(msg: ChatMessage): number {
  const value = new Date(msg.created_at).getTime()
  return Number.isFinite(value) ? value : 0
}

/** 回退后禁止把 summary 之前的服务端行当「新消息」插回（同一 upsert 内的内容态守卫）。 */
function latestRewindSummaryMs(messages: readonly ChatMessage[]): number {
  return Math.max(
    0,
    ...messages.filter(isRewindSummaryMessage).map(getCreatedAtMs),
  )
}

/**
 * 结构性截断专用（回退）：以目标可见集为底，
 * 并按内容态保留未落库本地行。
 *
 * **不是对账**——对账一律走 `mergeMessagesFromServer` / `reconcileSessionMessages`。
 * 轮末 checkpoint 不得再走本函数写 store（ 方案 A）。
 */
export function mergeAuthoritativeServerReplace(
  serverMessages: ChatMessage[],
  localMessages: ChatMessage[],
): ChatMessage[] {
  const preserved = collectPreservedLocalMessages(localMessages, serverMessages)
  const localByIdentity = buildIdentityIndex(localMessages)
  const reconciled = serverMessages.map(server => {
    const local = findByIdentity(localByIdentity, server)
    if (server.role === 'user') {
      return local?.role === 'user' ? mergeUserContentForDisplay(local, server) : server
    }
    return local ? reconcileServerMessageBlocks(local, server) : server
  })
  return sortMessagesForTimeline([...reconciled, ...preserved])
}

function mergeMatchedMessage(local: ChatMessage, server: ChatMessage): ChatMessage {
  if (local.role === 'user' && server.role === 'user') {
    return mergeUserContentForDisplay(local, server)
  }
  return reconcileServerMessageBlocks(local, server)
}

function isFrozenOutgoingUser(msg: ChatMessage): boolean {
  if (msg.role !== 'user') return false
  const sendStatus = (msg as LocalChatMessage).sendStatus
  return Boolean(sendStatus && sendStatus !== 'sent')
}

export function mergeMessagesFromServer(
  existing: ChatMessage[],
  fresh: ChatMessage[],
): MergeResult {
  if (fresh.length === 0) {
    return { messages: existing, changed: false, newCount: 0 }
  }

  const localByIdentity = buildIdentityIndex(existing)
  const localIdToServer = new Map<string, ChatMessage>()
  const rewindMs = latestRewindSummaryMs(existing)
  const newMsgs: ChatMessage[] = []

  for (const server of fresh) {
    const local = findByIdentity(localByIdentity, server)
    if (local) {
      localIdToServer.set(local.id, server)
      continue
    }
    // 回退 summary 之前的旧行不得当「新增」复活
    if (rewindMs > 0 && getCreatedAtMs(server) < rewindMs && !isRewindSummaryMessage(server)) {
      continue
    }
    newMsgs.push(server)
  }

  let changed = newMsgs.length > 0
  const merged = existing.map((local) => {
    const server = localIdToServer.get(local.id)
    if (!server) return local
    if (isFrozenOutgoingUser(local)) return local
    changed = true
    return mergeMatchedMessage(local, server)
  })

  if (!changed) {
    return { messages: existing, changed: false, newCount: 0 }
  }

  return {
    messages: sortMessagesForTimeline([...merged, ...newMsgs]),
    changed: true,
    newCount: newMsgs.length,
  }
}
