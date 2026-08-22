import React from 'react'
import { motion } from 'framer-motion'
import { PenLine } from 'lucide-react'
import { MessageListSkeleton } from '@components/common/ListSkeletons'
import { cn } from '@utils/cn'
import { RevertBanner } from '../../checkpoint/RevertBanner'

export type MessageListSuggestion = {
  icon: string
  text: string
}

export interface MessageListEmptyStateProps {
  isLoading?: boolean
  className?: string
  contentPadding: string
  emptyStateHint?: string
  suggestions: MessageListSuggestion[]
  onSuggestionSelect?: (text: string) => void
  sessionId?: string | null
}

export function MessageListEmptyState({
  isLoading,
  className,
  contentPadding,
  emptyStateHint,
  suggestions,
  onSuggestionSelect,
  sessionId,
}: MessageListEmptyStateProps) {
  if (isLoading) {
    return (
      <div className={cn('scrollbar-hover flex flex-1 min-h-0 overflow-y-auto', className)}>
        <MessageListSkeleton count={6} />
      </div>
    )
  }

  return (
    <div className={cn('flex flex-1 min-h-0 flex-col justify-end pb-2', contentPadding, className)}>
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.25 }} className="space-y-1">
        {emptyStateHint && (
          <div className="pb-2">
            <div className="inline-flex max-w-full min-w-0 items-start gap-1.5 rounded-md border border-border/20 bg-muted/20 px-2.5 py-1 text-caption text-muted-foreground/60">
              <PenLine className="mt-0.5 h-3 w-3 shrink-0 text-accent/80" />
              <span className="min-w-0 flex-1 text-left break-words whitespace-normal [overflow-wrap:anywhere]">{emptyStateHint}</span>
            </div>
          </div>
        )}
        {suggestions.map((item) => (
          <button
            type="button"
            key={item.text}
            className={cn(
              'flex min-w-0 max-w-full items-center gap-2 rounded-md px-2 py-1.5 text-caption text-muted-foreground/60',
              'hover:bg-muted/20 hover:text-muted-foreground',
              'transition-colors duration-150 cursor-pointer text-left',
              !onSuggestionSelect && 'cursor-default',
            )}
            onClick={() => onSuggestionSelect?.(item.text)}
            disabled={!onSuggestionSelect}
          >
            <span className="shrink-0 text-caption">{item.icon}</span>
            <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{item.text}</span>
          </button>
        ))}
      </motion.div>
      <div className="pt-2">
        <RevertBanner sessionId={sessionId ?? undefined} placement="messageList" />
      </div>
    </div>
  )
}
