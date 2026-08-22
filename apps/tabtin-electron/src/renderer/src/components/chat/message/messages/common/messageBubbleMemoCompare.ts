import type { ChatMessage } from '@tabtin/chat-client'
import type { LocalChatMessage } from '@stores/chat/shared/types'

type BubbleComparableProps = {
  message: ChatMessage
  sessionId?: string | null
  tabScopeKey?: string | null
  subagentRunSessionId?: string | null
  isLastAssistantMsg?: boolean
  sessionPulseVisible?: boolean
  isLastInTurn?: boolean
  onFork?: unknown
  onContextBlockNavigate?: unknown
  onContextBlockContextMenu?: unknown
  userAlign?: unknown
  previewMode?: boolean
  hideAgentBadge?: boolean
  highlightedMessageId?: string | null
  highlightKey?: string
  isMini?: boolean
  isSameTurnAssistant?: boolean
  timelineMessages?: unknown
  timelineIndex?: number
  includeSubagentMessages?: boolean
  timelineIsStreaming?: boolean
  contentBlocksOverride?: unknown
  turnArtifacts?: unknown
  historyArtifacts?: unknown
  onUserMessageExpand?: unknown
  accessCapabilities?: unknown
}

// eslint-disable-next-line complexity -- memo 比较必须显式列出会影响气泡展示的字段，避免隐式浅比较漏刷新。
function firstUnequalField(
  prev: BubbleComparableProps,
  next: BubbleComparableProps,
): string | null {
  if (prev.message.id !== next.message.id) return 'message.id'
  if (prev.message.content !== next.message.content) return 'message.content'
  if (prev.message.intent !== next.message.intent) return 'message.intent'
  if (prev.message.attachments_json !== next.message.attachments_json) {
    return 'message.attachments_json'
  }
  if (prev.message.content_blocks_json !== next.message.content_blocks_json) {
    return 'message.content_blocks_json'
  }
  if (prev.message.metadata !== next.message.metadata) return 'message.metadata'
  // ：终态错误正典在 error_info_json；漏比会导致卡不刷新。
  if (prev.message.error_info_json !== next.message.error_info_json) {
    return 'message.error_info_json'
  }
  if (prev.message.checkpoint_hash !== next.message.checkpoint_hash) {
    return 'message.checkpoint_hash'
  }
  if (prev.message.checkpoint_record !== next.message.checkpoint_record) {
    return 'message.checkpoint_record'
  }
  if (prev.message.agent_run_id !== next.message.agent_run_id) {
    return 'message.agent_run_id'
  }
  if (prev.message.diff_summary !== next.message.diff_summary) {
    return 'message.diff_summary'
  }
  if (prev.message.error_code !== next.message.error_code) return 'message.error_code'
  if (prev.message.message_kind !== next.message.message_kind) {
    return 'message.message_kind'
  }
  if (
    (prev.message as LocalChatMessage).sendStatus
    !== (next.message as LocalChatMessage).sendStatus
  ) {
    return 'message.sendStatus'
  }
  if (prev.sessionId !== next.sessionId) return 'sessionId'
  if (prev.tabScopeKey !== next.tabScopeKey) return 'tabScopeKey'
  if (prev.subagentRunSessionId !== next.subagentRunSessionId) {
    return 'subagentRunSessionId'
  }
  if (prev.isLastAssistantMsg !== next.isLastAssistantMsg) return 'isLastAssistantMsg'
  if (prev.sessionPulseVisible !== next.sessionPulseVisible) return 'sessionPulseVisible'
  if (prev.isLastInTurn !== next.isLastInTurn) return 'isLastInTurn'
  if (prev.onFork !== next.onFork) return 'onFork'
  if (prev.onContextBlockNavigate !== next.onContextBlockNavigate) {
    return 'onContextBlockNavigate'
  }
  if (prev.onContextBlockContextMenu !== next.onContextBlockContextMenu) {
    return 'onContextBlockContextMenu'
  }
  if (prev.userAlign !== next.userAlign) return 'userAlign'
  if (prev.previewMode !== next.previewMode) return 'previewMode'
  if (prev.hideAgentBadge !== next.hideAgentBadge) return 'hideAgentBadge'
  if (prev.highlightedMessageId !== next.highlightedMessageId) {
    return 'highlightedMessageId'
  }
  if (prev.highlightKey !== next.highlightKey) return 'highlightKey'
  if (prev.isMini !== next.isMini) return 'isMini'
  if (prev.isSameTurnAssistant !== next.isSameTurnAssistant) {
    return 'isSameTurnAssistant'
  }
  if (prev.timelineMessages !== next.timelineMessages) return 'timelineMessages'
  if (prev.timelineIndex !== next.timelineIndex) return 'timelineIndex'
  if (prev.includeSubagentMessages !== next.includeSubagentMessages) {
    return 'includeSubagentMessages'
  }
  if (prev.timelineIsStreaming !== next.timelineIsStreaming) {
    return 'timelineIsStreaming'
  }
  if (prev.contentBlocksOverride !== next.contentBlocksOverride) {
    return 'contentBlocksOverride'
  }
  if (prev.turnArtifacts !== next.turnArtifacts) return 'turnArtifacts'
  if (prev.historyArtifacts !== next.historyArtifacts) return 'historyArtifacts'
  if (prev.onUserMessageExpand !== next.onUserMessageExpand) return 'onUserMessageExpand'
  if (prev.accessCapabilities !== next.accessCapabilities) return 'accessCapabilities'
  return null
}

export function messageBubblePropsAreEqual(
  prev: BubbleComparableProps,
  next: BubbleComparableProps,
): boolean {
  // 相对时间由 MessageTimeTickContext + 叶子组件订阅，不进气泡 props / memo
  return firstUnequalField(prev, next) === null
}
