/**
 * ：放弃创建后立即清理未发消息的预建空会话。
 *
 * 产品口径：空对话不应靠 2h 归档窗口或侧栏滤镜「藏起来」；
 * 退出 DraftMessage / 预建过期时立刻从列表与服务端 active 集清除。
 */

import type { ChatMessage, ChatSession } from '@tabtin/chat-client'
import { sessionHasVisibleMessages } from './sessionHasVisibleMessages'
import { isLocalPendingSessionId } from './actions/pendingFirstSend'

export type AbandonedEmptyDiscardReason =
  | 'draft_cancel'
  | 'prefetch_stale'

export interface AbandonedEmptySessionCandidate {
  sessionId: string
  spaceId: string
}

export interface SelectAbandonedEmptySessionsInput {
  sessionIds: readonly string[]
  sessionsBySpaceId: Record<string, ChatSession[] | undefined>
  messagesBySessionId?: Record<string, ChatMessage[] | undefined>
  /** draftMessage 正在发送时保留，避免误清首发中的预建槽 */
  draftSessionPhase?: 'open' | 'sending' | null
  /**
   * 桶里还没有该 session 时的显式归属（如 prefetch 刚 create、尚未 merge 完）。
   * 有桶命中时以桶为准。
   */
  sessionSpaceById?: Record<string, string | undefined>
  /** 只有显式 released 的 DraftSession 才能被清理。 */
  isDraftSessionReleased: (sessionId: string) => boolean
}

/**
 * 选出可立即清理的空会话（纯函数，便于单测）。
 *
 * 保留：
 * - local-pending（尚未物化）
 * - 已有服务端消息 / 本地 user 气泡
 * - 已归档
 * - draftMessage phase=sending
 */
export function selectAbandonedEmptySessions(
  input: SelectAbandonedEmptySessionsInput,
): AbandonedEmptySessionCandidate[] {
  if (input.draftSessionPhase === 'sending') return []

  const out: AbandonedEmptySessionCandidate[] = []
  const seen = new Set<string>()

  for (const sessionId of input.sessionIds) {
    if (!sessionId || seen.has(sessionId)) continue
    seen.add(sessionId)
    if (isLocalPendingSessionId(sessionId)) continue
    if (!input.isDraftSessionReleased(sessionId)) continue

    let found: ChatSession | undefined
    let spaceId: string | undefined
    for (const [bucketSpaceId, list] of Object.entries(input.sessionsBySpaceId)) {
      const hit = list?.find((session) => session.id === sessionId)
      if (hit) {
        found = hit
        spaceId = bucketSpaceId
        break
      }
    }

    if (!found) {
      const explicitSpaceId = input.sessionSpaceById?.[sessionId]
      if (!explicitSpaceId) continue
      // 桶未命中：按「空预建」处理（调用方需保证 id 来自刚 create 的 prefetch）
      out.push({ sessionId, spaceId: explicitSpaceId })
      continue
    }

    if (!spaceId) continue
    if (found.status === 'archived') continue
    if (sessionHasVisibleMessages(found)) continue

    const localMessages = input.messagesBySessionId?.[sessionId]
    if (localMessages?.some((message) => message.role === 'user')) continue

    out.push({ sessionId, spaceId })
  }

  return out
}
