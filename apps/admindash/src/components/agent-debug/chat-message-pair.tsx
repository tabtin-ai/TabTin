/**
 * Chat 消息对组件（用户消息 + AI 消息配对显示）
 * 用于调试面板回放对话，一个 trace_id 对应一组对话
 */

import type { ChatMessageItem } from '@/api/chat'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { CheckCircle2, ChevronDown, ChevronUp, Clock, Loader2, XCircle } from 'lucide-react'
import { useState } from 'react'

interface ChatMessagePairProps {
  userMessage: ChatMessageItem
  assistantMessage?: ChatMessageItem
  onSelectTrace?: (traceId: string) => void
  selected?: boolean
  index: number
  traceStatus?: 'completed' | 'running' | 'error' | null
  traceDurationMs?: number
}

function formatTime(isoString: string): string {
  const date = new Date(isoString)
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

export function ChatMessagePair({
  userMessage,
  assistantMessage,
  onSelectTrace,
  selected = false,
  index,
  traceStatus = null,
  traceDurationMs,
}: ChatMessagePairProps) {
  const [expanded, setExpanded] = useState(false)
  const traceId = userMessage.trace_id || null
  const hasTrace = !!traceId

  const handleSelect = () => {
    if (traceId && onSelectTrace) {
      onSelectTrace(traceId)
    }
  }

  const userContent = userMessage.content?.trim() || '（空消息）'
  const assistantContent = assistantMessage?.content?.trim() || '（暂无回复）'

  const shouldTruncate = userContent.length > 120 || assistantContent.length > 200
  const maxUserLength = 120
  const maxAssistantLength = 200

  const displayUserContent =
    expanded || userContent.length <= maxUserLength
      ? userContent
      : `${userContent.substring(0, maxUserLength)}...`

  const displayAssistantContent =
    expanded || assistantContent.length <= maxAssistantLength
      ? assistantContent
      : `${assistantContent.substring(0, maxAssistantLength)}...`

  const isInteractive = hasTrace && !!onSelectTrace

  const getStatusIcon = () => {
    switch (traceStatus) {
      case 'completed':
        return <CheckCircle2 className="h-3 w-3 text-success" />
      case 'error':
        return <XCircle className="h-3 w-3 text-destructive" />
      case 'running':
        return <Loader2 className="h-3 w-3 text-warning animate-spin" />
      default:
        return <Clock className="h-3 w-3 text-muted-foreground" />
    }
  }

  return (
    <div
      className={cn(
        'group relative py-3 px-4 transition-all border-l-2',
        isInteractive ? 'cursor-pointer' : '',
        selected
          ? 'border-l-primary bg-primary/5'
          : 'border-l-transparent hover:border-l-primary/40 hover:bg-muted/30'
      )}
      onClick={handleSelect}
      onKeyDown={(event) => {
        if (!isInteractive) return
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          handleSelect()
        }
      }}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive ? 0 : undefined}
    >
      {/* 轮次和状态信息 */}
      <div className="flex items-center gap-2 mb-3 text-body text-muted-foreground">
        <span className="font-medium">第 {index + 1} 轮</span>
        <span>·</span>
        <div className="flex items-center gap-1">{getStatusIcon()}</div>
        {typeof traceDurationMs === 'number' && traceDurationMs > 0 && (
          <>
            <span>·</span>
            <span>{formatDuration(traceDurationMs)}</span>
          </>
        )}
        <span>·</span>
        <span>{formatTime(userMessage.created_at)}</span>
        {selected && (
          <>
            <span>·</span>
            <Badge variant="default" className="h-4 text-caption px-1.5">
              当前
            </Badge>
          </>
        )}
      </div>

      {/* 用户消息 - 气泡样式 */}
      <div className="mb-3">
        <div className="inline-block max-w-[85%] bg-info text-white rounded-2xl rounded-tl-sm px-4 py-2.5 shadow-sm">
          <p className="text-body whitespace-pre-wrap break-words leading-relaxed">
            {displayUserContent}
          </p>
        </div>
      </div>

      {/* AI 消息 - 直接展示，不用气泡 */}
      <div className="mb-2">
        <p
          className={cn(
            'text-body text-foreground/80 whitespace-pre-wrap break-words leading-relaxed',
            traceStatus === 'error' && 'text-destructive'
          )}
        >
          {displayAssistantContent}
        </p>
      </div>

      {/* 展开/收起 */}
      {shouldTruncate && (
        <button
          type="button"
          className="text-body text-primary hover:underline flex items-center gap-1 mt-2"
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(!expanded)
          }}
        >
          {expanded ? (
            <>
              <ChevronUp className="h-3 w-3" />
              收起
            </>
          ) : (
            <>
              <ChevronDown className="h-3 w-3" />
              展开
            </>
          )}
        </button>
      )}
    </div>
  )
}
