import React, { useMemo } from 'react'
import { PenLine } from 'lucide-react'
import { cn } from '@utils/cn'
import { MessageListSkeleton } from '@components/common/ListSkeletons'
import { useTaskEpisodeTimeline } from '@stores/chat/presentation/messageTimeline/useTaskEpisodeTimeline'
import { getCurrentStreamingAssistantMessageId, getTimelineItemKey } from './messageList/timelineItemIdentity'
import { MessageBubble } from './messages'

interface EmbeddedMessageTimelineProps {
  sessionId: string
  subagentRunSessionId: string
  ownerRunId?: string
  showSubagentCompletionPush?: boolean
  isLoading?: boolean
  emptyStateHint?: string
  contentPadding?: string
}

/**
 * 嵌入父阅读流的时间线适配器。
 *
 * 与主会话共享 Task Episode 投影和行渲染，但不创建虚拟器、滚动容器、轮次导航或
 * 吸底状态机；高度完全由内容决定，父会话是唯一滚动视口。
 */
export function EmbeddedMessageTimeline({
  sessionId,
  subagentRunSessionId,
  ownerRunId,
  showSubagentCompletionPush = false,
  isLoading = false,
  emptyStateHint,
  contentPadding = 'px-3',
}: EmbeddedMessageTimelineProps): React.ReactElement {
  const timeline = useTaskEpisodeTimeline({ sessionId, includeSubagentMessages: true })
  const { messages, rows } = timeline
  const lastAssistantMsgId = useMemo(() => getCurrentStreamingAssistantMessageId(messages), [messages])

  if (messages.length === 0) {
    if (isLoading) {
      return (
        <div data-testid="embedded-message-timeline" className={contentPadding}>
          <MessageListSkeleton count={3} />
        </div>
      )
    }
    return (
      <div data-testid="embedded-message-timeline" className={cn(contentPadding, 'pb-2')}>
        {emptyStateHint && (
          <div className="inline-flex max-w-full min-w-0 items-start gap-1.5 rounded-md border border-border/20 bg-muted/20 px-2.5 py-1 text-caption text-muted-foreground/60">
            <PenLine className="mt-0.5 h-3 w-3 shrink-0 text-accent/80" />
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{emptyStateHint}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div data-testid="embedded-message-timeline" data-message-count={messages.length} className={cn(contentPadding, 'pb-8')}>
      {rows.map((row) => {
        if (row.isRunPlaceholder) return null
        return (
          <div
            key={getTimelineItemKey(row.message, row.index)}
            data-index={row.index}
          >
            <MessageBubble
              message={row.renderMessage}
              contentBlocksOverride={row.contentBlocksOverride}
              sessionId={sessionId}
              subagentRunSessionId={subagentRunSessionId}
              ownerRunId={ownerRunId}
              showSubagentCompletionPush={showSubagentCompletionPush}
              isLastAssistantMsg={row.renderMessage.id === lastAssistantMsgId}
              isLastInTurn={row.isLastInTurn}
              hideAgentBadge={row.hideAgentBadge}
              isMini={row.isMini}
              isSameTurnAssistant={row.isSameTurnAssistant}
              timelineMessages={messages}
              timelineIndex={row.index}
              includeSubagentMessages
              userAlign="left"
              previewMode
            />
          </div>
        )
      })}
    </div>
  )
}
