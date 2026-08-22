/**
 * 对话消息组件
 * 展示用户输入或 AI 回复（都居左显示，适合调试场景）
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { Event, Trace } from '@/types/agent-debug'
import { AlertCircle, Bot, ChevronRight, Clock, User } from 'lucide-react'

interface ConversationMessageProps {
  trace: Trace
  events: Event[] // trace 的所有 events
  isUser: boolean
  onViewDetail: () => void
}

// 格式化时间
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

// 格式化耗时
function formatDuration(ms: number | null): string {
  if (ms === null) return '运行中...'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

type MessageContentPartObject = {
  type?: string
  text?: string
  content?: string
  image_url?: { url?: string }
}

function normalizeMessageContent(content: unknown): string {
  if (content === null || content === undefined) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    const parts = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part && typeof part === 'object') {
          const partObj = part as MessageContentPartObject
          if (partObj.text) return partObj.text
          if (partObj.content) return partObj.content
          if (partObj.image_url?.url) return `[图片] ${partObj.image_url.url}`
        }
        return ''
      })
      .filter(Boolean)
    return parts.join('\n')
  }
  if (typeof content === 'object') {
    const obj = content as { text?: string; content?: string }
    if (obj.text) return obj.text
    if (obj.content) return obj.content
  }
  return String(content)
}

function getSortedEvents(events: Event[]): Event[] {
  return [...events].sort((a, b) => {
    if (typeof a.seq === 'number' && typeof b.seq === 'number') {
      return a.seq - b.seq
    }
    return new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
  })
}

function readRecordValue(record: Record<string, unknown> | null | undefined, key: string): unknown {
  return record?.[key]
}

function readNestedRecordValue(
  record: Record<string, unknown> | null | undefined,
  recordKey: string,
  valueKey: string
): unknown {
  const nested = readRecordValue(record, recordKey)
  if (nested && typeof nested === 'object' && !Array.isArray(nested)) {
    return (nested as Record<string, unknown>)[valueKey]
  }
  return undefined
}

function extractUserMessageFromState(events: Event[]): string | null {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]
    const candidates = [
      readNestedRecordValue(event.input, 'state', 'user_message'),
      readNestedRecordValue(event.output, 'state', 'user_message'),
      readRecordValue(event.input, 'user_message'),
      readRecordValue(event.output, 'user_message'),
    ]
    for (const candidate of candidates) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate
      }
    }
  }
  return null
}

// 从 events 中提取用户输入
function extractUserMessage(trace: Trace, events: Event[]): string {
  const sortedEvents = getSortedEvents(events)
  const llmEvents = sortedEvents.filter((e) => e.event_type === 'llm')
  const llmEvent =
    [...llmEvents].reverse().find((e) => Array.isArray(e.input?.messages)) ||
    llmEvents[llmEvents.length - 1]

  if (llmEvent && Array.isArray(llmEvent.input?.messages)) {
    const messages = llmEvent.input.messages
    for (let i = messages.length - 1; i >= 0; i--) {
      const role = messages[i].role
      if (role === 'user' || role === 'human') {
        const content = normalizeMessageContent(messages[i].content)
        if (content.trim()) {
          return content
        }
      }
    }
  }

  const stateMessage = extractUserMessageFromState(sortedEvents)
  if (stateMessage) return stateMessage

  const metadata = trace.metadata || {}
  const metadataMessage =
    metadata.user_message || metadata.user_input || metadata.query || metadata.prompt
  if (typeof metadataMessage === 'string' && metadataMessage.trim()) {
    return metadataMessage
  }

  return '（无用户输入）'
}

// 从 events 中提取 AI 回复
function extractAIMessage(trace: Trace, events: Event[]): string {
  const sortedEvents = getSortedEvents(events)
  const llmEvents = sortedEvents.filter((e) => e.event_type === 'llm')
  if (llmEvents.length === 0) {
    return '（未找到 LLM 输出）'
  }

  const lastLLMEvent =
    [...llmEvents].reverse().find((e) => e.output !== null && e.output !== undefined) ||
    llmEvents[llmEvents.length - 1]

  const output = lastLLMEvent.output
  const contentCandidate =
    output?.content ?? output?.message ?? output?.reply ?? output?.result ?? output
  const content = normalizeMessageContent(contentCandidate)
  if (content.trim()) {
    return content
  }

  const metadata = trace.metadata || {}
  const metadataAnswer = metadata.final_answer || metadata.reply || metadata.output
  if (typeof metadataAnswer === 'string' && metadataAnswer.trim()) {
    return metadataAnswer
  }

  return '（无 AI 输出）'
}

export function ConversationMessage({
  trace,
  events,
  isUser,
  onViewDetail,
}: ConversationMessageProps) {
  const message = isUser ? extractUserMessage(trace, events) : extractAIMessage(trace, events)
  const duration = trace.ended_at
    ? new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
    : null

  if (isUser) {
    // 用户消息 - 居左，蓝色边框
    return (
      <div className="flex justify-start mb-4">
        <div className="flex items-start gap-3 max-w-[90%]">
          <div className="flex h-8 w-8 items-center justify-center rounded-full bg-info/10 flex-shrink-0">
            <User className="h-4 w-4 text-info" />
          </div>
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-1">
              <span className="text-body font-medium">用户</span>
              <span className="text-body text-muted-foreground">
                {formatTime(trace.started_at)}
              </span>
            </div>
            <div className="bg-card border-l-4 border-info/30 rounded-lg px-4 py-3 shadow-sm">
              <p className="text-body whitespace-pre-wrap break-words">{message}</p>
            </div>
          </div>
        </div>
      </div>
    )
  }

  // AI 消息 - 居左，绿色边框
  return (
    <div className="flex justify-start mb-4">
      <div className="flex items-start gap-3 max-w-[90%]">
        <div className="flex h-8 w-8 items-center justify-center rounded-full bg-primary/10 flex-shrink-0">
          <Bot className="h-4 w-4 text-primary" />
        </div>
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-body font-medium">AI 助手</span>
            <span className="text-body text-muted-foreground">
              {formatTime(trace.ended_at || trace.started_at)}
            </span>
            {trace.status === 'error' && (
              <Badge variant="destructive" className="text-body">
                <AlertCircle className="h-3 w-3 mr-1" />
                错误
              </Badge>
            )}
            {trace.status === 'running' && (
              <Badge variant="default" className="text-body">
                <Clock className="h-3 w-3 mr-1 animate-pulse" />
                运行中
              </Badge>
            )}
          </div>

          <div
            className={cn(
              'bg-card border-l-4 border-success/30 rounded-lg px-4 py-3 shadow-sm',
              trace.status === 'error' && 'border-destructive'
            )}
          >
            <p className="text-body whitespace-pre-wrap break-words">{message}</p>

            {/* 错误信息 */}
            {trace.error && (
              <div className="mt-3 pt-3 border-t">
                <div className="flex items-start gap-1 text-body text-destructive">
                  <AlertCircle className="h-3 w-3 mt-0.5 flex-shrink-0" />
                  <span>{trace.error}</span>
                </div>
              </div>
            )}
          </div>

          {/* 底部信息栏 */}
          <div className="flex items-center gap-3 mt-2 text-body text-muted-foreground">
            <div className="flex items-center gap-1">
              <Clock className="h-3 w-3" />
              <span>耗时 {formatDuration(duration)}</span>
            </div>
            <div className="flex items-center gap-1 capitalize">
              <span>{trace.graph_type}</span>
            </div>
            <Button
              variant="ghost"
              size="sm"
              className="h-6 px-2 text-body hover:bg-muted"
              onClick={onViewDetail}
            >
              查看详情
              <ChevronRight className="h-3 w-3 ml-1" />
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
