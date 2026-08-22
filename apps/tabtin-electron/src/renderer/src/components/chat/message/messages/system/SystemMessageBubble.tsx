import React from 'react'
import { useTranslation } from 'react-i18next'
import { History } from 'lucide-react'
import type { ChatMessage } from '@tabtin/chat-client'
import { ShinyText } from '../../../markdown/ShinyText'

export const SystemMessageBubble: React.FC<{
  message: ChatMessage
  variant: 'compaction_checkpoint' | 'status_pill'
}> = ({ message, variant }) => {
  const { t } = useTranslation('chat')
  const metadata = message.metadata as Record<string, unknown> | null | undefined
  if (variant === 'compaction_checkpoint') {
    return (
      <div className="flex justify-center py-2">
        <div className="flex max-w-full min-w-0 items-center gap-2 rounded-full border border-border/60 bg-muted/30 px-4 py-1.5 text-caption text-muted-foreground/80">
          <History className="h-3.5 w-3.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{t('agentSteps.compactionCheckpoint')}</span>
        </div>
      </div>
    )
  }

  const isManualCompactRunning = metadata?.source === 'manual_compact_status' && metadata?.status === 'running'
  return (
    <div className="flex justify-center py-2">
      <div className="flex max-w-full min-w-0 items-center gap-2 rounded-full border border-border/30 bg-muted/20 px-4 py-1.5 text-body text-muted-foreground">
        <History className="h-3.5 w-3.5 shrink-0" />
        {isManualCompactRunning ? (
          <ShinyText className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</ShinyText>
        ) : (
          <span className="min-w-0 whitespace-pre-wrap [overflow-wrap:anywhere]">{message.content}</span>
        )}
      </div>
    </div>
  )
}
