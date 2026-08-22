import React from 'react'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContextBlock } from '../../context/ContextRefCard'
import type { SessionAccessCapabilities } from '../../sessionAccessCapabilities'
import type { TurnArtifact } from '../../turn/turnArtifacts'
import type { TaskEpisodeTimelineRow } from '@stores/chat/presentation/messageTimeline/taskEpisodeTimelineProjection'
import { MessageBubble } from '../messages'

export interface MessageListTimelineRowRendering {
  messages: ChatMessage[]
  sessionId: string | null
  tabScopeKey: string | null
  subagentRunSessionId?: string | null
  lastAssistantMsgId: string | null
  includeSubagentMessages: boolean
  isStreaming: boolean
  highlightedMessageId: string | null
  highlightKey: string
  turnArtifactsByEndIndex: ReadonlyMap<number, TurnArtifact[]>
  priorTurnArtifactsByEndIndex?: ReadonlyMap<number, TurnArtifact[]>
  onForkFromMessage?: (messageId: string) => void
  accessCapabilities?: SessionAccessCapabilities
  onContextBlockNavigate?: (block: ContextBlock) => void
  onContextBlockContextMenu?: (block: ContextBlock, x: number, y: number) => void
  userAlign: 'left' | 'right'
  previewMode?: boolean
  onUserMessageExpand: (messageId: string) => void
}

interface MessageListTimelineRowProps {
  row: TaskEpisodeTimelineRow
  rendering: MessageListTimelineRowRendering
}

export function MessageListTimelineRow({
  row,
  rendering,
}: MessageListTimelineRowProps) {
  if (row.isRunPlaceholder) return null

  const message = row.renderMessage
  const renderMessageIndex = row.renderMessageIndex
  return (
    <MessageBubble
      message={message}
      contentBlocksOverride={row.contentBlocksOverride}
      sessionId={rendering.sessionId}
      tabScopeKey={rendering.tabScopeKey}
      subagentRunSessionId={rendering.subagentRunSessionId}
      isLastAssistantMsg={message.id === rendering.lastAssistantMsgId}
      isLastInTurn={row.isLastInTurn}
      hideAgentBadge={row.hideAgentBadge}
      highlightedMessageId={rendering.highlightedMessageId}
      highlightKey={rendering.highlightKey}
      isMini={row.isMini}
      isSameTurnAssistant={row.isSameTurnAssistant}
      timelineMessages={rendering.messages}
      timelineIndex={renderMessageIndex}
      includeSubagentMessages={rendering.includeSubagentMessages}
      timelineIsStreaming={rendering.isStreaming}
      onFork={rendering.onForkFromMessage}
      accessCapabilities={rendering.accessCapabilities}
      onContextBlockNavigate={rendering.onContextBlockNavigate}
      onContextBlockContextMenu={rendering.onContextBlockContextMenu}
      userAlign={rendering.userAlign}
      previewMode={rendering.previewMode}
      turnArtifacts={rendering.turnArtifactsByEndIndex.get(renderMessageIndex)}
      historyArtifacts={rendering.priorTurnArtifactsByEndIndex?.get(renderMessageIndex)}
      onUserMessageExpand={rendering.onUserMessageExpand}
    />
  )
}
