/**
 * 主 Composer 单一 Stop 钮的分界：何时「只停答」、何时「撤回并回填」。
 *
 * 口径（单钮 + 合二为一）：
 * - 本轮助手尚无实质输出 → 当作发错了：撤回 user + 其后半截，回填输入框
 * - 本轮助手已有实质输出（可见正文 / 工具）→ 当作别答了：保留时间线，不回填
 */

import type { ChatMessage } from '@tabtin/chat-client'
import { streamingContent } from '../../execution/streamingContent'
import type { ToolEvent } from '../../shared/types'
import type { SubmittedMessageSnapshot } from '../../../useChatRuntimeStore'
import { isRegularUserMessage } from '../utils/semanticMessageCount'
import { assistantMessageHasSubstance } from '../utils/emptyInterruptedAssistant'

export type ComposerStopMode = 'stop_only' | 'withdraw_and_restore'

type TurnUserAnchor =
  | { status: 'found'; index: number }
  | { status: 'non_regular_tail' }
  | { status: 'missing' }

function messageHasSubstance(message: ChatMessage): boolean {
  return assistantMessageHasSubstance(message)
    || messageHasVisibleThinking(message)
}

function blockHasVisibleThinking(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const candidate = value as {
    type?: string
    thinking?: string
    text?: string
    content?: string
    data?: string
    block?: unknown
  }
  if (candidate.block) return blockHasVisibleThinking(candidate.block)
  if (candidate.type !== 'thinking' && candidate.type !== 'redacted_thinking') return false
  return [candidate.thinking, candidate.text, candidate.content, candidate.data]
    .some(text => typeof text === 'string' && text.trim().length > 0)
}

function messageHasVisibleThinking(message: ChatMessage): boolean {
  const persistedBlocks = message.content_blocks_json
  if (Array.isArray(persistedBlocks) && persistedBlocks.some(blockHasVisibleThinking)) return true
  const liveBlocks = message.blocks
  return Array.isArray(liveBlocks) && liveBlocks.some(blockHasVisibleThinking)
}

function resolveTurnUserAnchor(
  messages: ChatMessage[],
  snapshot: SubmittedMessageSnapshot | undefined,
): TurnUserAnchor {
  if (snapshot) {
    const bySnapshot = messages.findIndex((message) => {
      if (message.id === snapshot.localMessageId) return true
      const meta = message.metadata as { client_message_id?: string } | undefined
      return meta?.client_message_id === snapshot.clientMessageId
    })
    if (bySnapshot >= 0) return { status: 'found', index: bySnapshot }
  }
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i]
    if (!message || message.role !== 'user') continue
    if (isRegularUserMessage(message)) return { status: 'found', index: i }
    // 最近一条 user 是 push / skill_invoke 等：本轮不是真人提交，
    // 不得回撤更早真人轮。
    return { status: 'non_regular_tail' }
  }
  return { status: 'missing' }
}

export function resolveComposerStopMode(input: {
  sessionId: string
  messages: ChatMessage[]
  activeSubmitted?: SubmittedMessageSnapshot
  toolEvents?: ToolEvent[]
}): ComposerStopMode {
  const live = streamingContent.get(input.sessionId)
  if (live?.content?.trim()) return 'stop_only'

  const tools = input.toolEvents ?? []
  if (tools.some((event) => event.phase === 'start' || event.phase === 'end' || event.phase === 'error')) {
    return 'stop_only'
  }

  const anchor = resolveTurnUserAnchor(input.messages, input.activeSubmitted)
  if (anchor.status === 'non_regular_tail') return 'stop_only'
  if (anchor.status === 'missing') return 'withdraw_and_restore'

  const userIdx = anchor.index
  for (let i = userIdx + 1; i < input.messages.length; i += 1) {
    if (messageHasSubstance(input.messages[i]!)) return 'stop_only'
  }

  return 'withdraw_and_restore'
}
