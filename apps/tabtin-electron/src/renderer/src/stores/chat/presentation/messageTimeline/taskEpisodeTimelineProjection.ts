import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '@stores/useChatRuntimeStore'
import { materializeMessagesForTimeline } from '@/stores/chat/domain/messageTimelineOrder'
import { isEmptyInterruptedAssistantShell } from '@/stores/chat/messages/utils/emptyInterruptedAssistant'
import {
  isContextInjectionMessage,
  isRenderableUserMessage,
} from '@/stores/chat/messages/utils/semanticMessageCount'
import {
  isLlmAssistantSegment,
  isToolArtifactMessage,
  shouldSkipInTurnScan,
} from './turnTransparency'
import { assembleRunContentBlocks, computeAssistantRuns, type AssistantRun } from './messageRuns'
import {
  isAgentSwitchedSystemMessage,
  isPushNotificationMessage,
  isSubagentCompletionPush,
  isRenderableSystemMessage,
} from '@stores/chat/presentation/messageBubble/timelineMessageVisibility'

const EMPTY_PARTIAL_BLOCKS: ContentBlockEntry[] = []
const EMPTY_BLOCKS_BY_MESSAGE_ID: Record<string, ContentBlockEntry[]> = {}

export interface TaskEpisodeTimelineRow {
  index: number
  /**
   * 虚拟列表身份锚点。连续 assistant run 的第一段仍用 firstIndex 这条消息占位，
   * 保持 ACK / materialize 前后的 row key 稳定。
   */
  message: ChatMessage
  /** 实际渲染气泡的消息；连续 assistant run 用末段承载 footer / diff / copy 语义。 */
  renderMessage: ChatMessage
  /** 实际渲染消息在 messages 中的索引；轮末派生数据必须跟随该索引。 */
  renderMessageIndex: number
  /** 已在 projection 层重组好的正文块；row 组件不再理解 assistant run。 */
  contentBlocksOverride?: ContentBlockEntry[]
  highlightedMessageId: string
  isRunPlaceholder: boolean
  isMini: boolean
  isSameTurnAssistant: boolean
  isLastInTurn: boolean
  hideAgentBadge: boolean
}

export interface TaskEpisodeTimelineProjection {
  messages: ChatMessage[]
  rows: TaskEpisodeTimelineRow[]
}

export interface TaskEpisodeTimelineOptions {
  includeSubagentMessages?: boolean
  blocksByMessageId?: Record<string, ContentBlockEntry[]>
  /** 调用场景附加的可见性门（例如共享会话隐藏 Runtime 内部上下文）。 */
  isMessageVisible?: (message: ChatMessage) => boolean
}

/**
 * 把存储层消息投影为用户实际看到的任务时间线。
 *
 * 这里是消息可见性与块级物化的唯一入口；视口与行组件只消费投影结果，
 * 不再各自解释哪些消息属于主任务时间线。
 */
export function projectTaskEpisodeTimeline(rawMessages: readonly ChatMessage[], options: TaskEpisodeTimelineOptions = {}): TaskEpisodeTimelineProjection {
  const { includeSubagentMessages = false } = options
  const blocksByMessageId = options.blocksByMessageId ?? EMPTY_BLOCKS_BY_MESSAGE_ID
  const isMessageVisible = options.isMessageVisible ?? ((message: ChatMessage) =>
    (message.role !== 'system' || isRenderableSystemMessage(message))
      && (message.role !== 'user' || isRenderableUserMessage(message) || isPushNotificationMessage(message)))
  const visibleMessages = rawMessages.filter(
    (message) => isMessageVisible(message)
      && !isContextInjectionMessage(message)
      && !isSubagentCompletionPush(message)
      && !isAgentSwitchedSystemMessage(message)
      && !isEmptyInterruptedAssistantShell(message)
      && (includeSubagentMessages || !message.subagent_run_id),
  )

  const messages = materializeMessagesForTimeline(visibleMessages)
  const runByIndex = computeAssistantRuns(messages)

  // 一次前扫 + 一次后扫建立轮次相邻关系，避免每个虚拟行在 render 期重复扫描。
  const previousTurnPeer: Array<ChatMessage | null> = new Array(messages.length)
  const nextTurnPeer: Array<ChatMessage | null> = new Array(messages.length)
  let peer: ChatMessage | null = null
  for (let index = 0; index < messages.length; index++) {
    previousTurnPeer[index] = peer
    if (!shouldSkipInTurnScan(messages[index])) peer = messages[index]
  }
  peer = null
  for (let index = messages.length - 1; index >= 0; index--) {
    nextTurnPeer[index] = peer
    if (!shouldSkipInTurnScan(messages[index])) peer = messages[index]
  }

  function isMiddleOfTurnAt(index: number): boolean {
    const message = messages[index]
    const next = isToolArtifactMessage(message) ? (messages[index + 1] ?? null) : nextTurnPeer[index]
    const isErrorEnvelope = message.role === 'assistant' && (message.message_kind ?? 'llm') === 'error_envelope'
    return !isToolArtifactMessage(message) && !isErrorEnvelope && isLlmAssistantSegment(message) && isLlmAssistantSegment(next)
  }

  function shouldHideAgentBadgeForRun(run: AssistantRun): boolean {
    for (let index = run.firstIndex - 1; index >= 0; index--) {
      if (shouldSkipInTurnScan(messages[index])) continue
      return isLlmAssistantSegment(messages[index])
    }
    return false
  }

  function getRunContentBlocksOverride(run: AssistantRun): ContentBlockEntry[] {
    const memberMessages = run.memberIndices.map((memberIndex) => messages[memberIndex])
    const blocks = assembleRunContentBlocks(memberMessages, blocksByMessageId)
    return blocks.length > 0 ? blocks : EMPTY_PARTIAL_BLOCKS
  }

  const rows = messages.map((message, index): TaskEpisodeTimelineRow => {
    const run = runByIndex.get(index)
    const isMini = isToolArtifactMessage(message)
    const previous = isMini ? (messages[index - 1] ?? null) : previousTurnPeer[index]
    const isRunPlaceholder = !!run && index !== run.firstIndex
    const renderMessageIndex = run ? run.lastIndex : index
    const renderMessage = run && !isRunPlaceholder ? messages[run.lastIndex] : message
    const isPartialSegment = (message.metadata as Record<string, unknown> | null | undefined)?._timeline_is_partial === true
    const contentBlocksOverride = run && !isRunPlaceholder
      ? getRunContentBlocksOverride(run)
      : isPartialSegment
        ? (message.blocks ?? EMPTY_PARTIAL_BLOCKS)
        : undefined

    return {
      index,
      message,
      renderMessage,
      renderMessageIndex,
      contentBlocksOverride,
      highlightedMessageId: renderMessage.id,
      isRunPlaceholder,
      isMini,
      isSameTurnAssistant: isLlmAssistantSegment(message) && isLlmAssistantSegment(previous),
      isLastInTurn: !isMiddleOfTurnAt(run && !isRunPlaceholder ? run.lastIndex : index),
      hideAgentBadge: run && !isRunPlaceholder ? shouldHideAgentBadgeForRun(run) : isLlmAssistantSegment(message) && isLlmAssistantSegment(previous),
    }
  })

  return { messages, rows }
}
