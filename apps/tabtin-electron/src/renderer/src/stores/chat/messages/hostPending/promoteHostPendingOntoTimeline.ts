/**
 *  / ：Host promote 成功（或乐观确认）后，把镜像排队项立刻推上主时间线。
 * USER echo 仍会经 upsertObservedUserMessage 补齐 arrival_seq，不二次插入。
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { applyBlocksArrival } from '@/stores/chat/domain/messageTimelineOrder'
import { beginStartedTurnUi } from '../runtime/applyLocalRuntimeSendAck'
import type { HostPendingSendItem } from './hostPendingSendSlice'

export type PromoteHostPendingOntoTimelineDeps = {
  sessionId: string
  runId: string
  getItem: () => HostPendingSendItem | null
  upsertObservedUserMessage: (sessionId: string, message: ChatMessage) => void
  removeHostPendingSend: (sessionId: string, runId: string) => void
  addStreamingSession: (sessionId: string, runId?: string | null) => void
  bumpSessionSidebarOnSend?: (sessionId: string, displayMessage: string) => void
}

export function promoteHostPendingOntoTimeline(
  deps: PromoteHostPendingOntoTimelineDeps,
): boolean {
  const item = deps.getItem()
  if (!item) return false

  let userMessage = item.userMessage as ChatMessage
  const blocks = userMessage.content_blocks_json
  if (
    Array.isArray(blocks)
    && blocks.length > 0
    && !blocks.some((b) => typeof (b as { arrival_seq?: unknown }).arrival_seq === 'number')
  ) {
    userMessage = {
      ...userMessage,
      content_blocks_json: applyBlocksArrival(blocks),
    }
  }

  deps.upsertObservedUserMessage(deps.sessionId, userMessage)
  deps.removeHostPendingSend(deps.sessionId, deps.runId)
  beginStartedTurnUi(deps.sessionId, (sid) => deps.addStreamingSession(sid, deps.runId))
  deps.bumpSessionSidebarOnSend?.(deps.sessionId, item.titleText)
  return true
}
