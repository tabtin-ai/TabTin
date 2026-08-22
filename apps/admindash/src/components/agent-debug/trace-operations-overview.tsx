import type { Event, Trace } from '@/types/agent-debug'
import {
  AlertCircle,
  Brain,
  CheckCircle2,
  Clock,
  Loader2,
  MessageSquare,
  Wrench,
} from 'lucide-react'
import { useMemo } from 'react'
import { buildMessageProcessView } from './conversation-process-utils'
import { MessageProcessBlocks } from './message-process-blocks'

interface TraceOperationsOverviewProps {
  trace: Trace
  events: Event[]
  /** 本轮消息落库 content_blocks；有则展示思考/执行过程 */
  contentBlocks?: unknown[] | null
}

function formatDuration(milliseconds: number): string {
  if (milliseconds < 1000) return `${Math.round(milliseconds)} 毫秒`
  if (milliseconds < 60_000) return `${(milliseconds / 1000).toFixed(1)} 秒`
  return `${Math.floor(milliseconds / 60_000)} 分 ${Math.round((milliseconds % 60_000) / 1000)} 秒`
}

function getEventKey(event: Event): string {
  return `${event.event_type} ${event.name}`.toLowerCase()
}

function isLlmEvent(event: Event): boolean {
  const key = getEventKey(event)
  return key.includes('llm') && !key.includes('timing')
}

function isToolEvent(event: Event): boolean {
  return getEventKey(event).includes('tool')
}

function isKeyEvent(event: Event): boolean {
  const key = getEventKey(event)
  return (
    isLlmEvent(event) ||
    isToolEvent(event) ||
    key.includes('user') ||
    key.includes('thinking') ||
    key.includes('assistant') ||
    event.event_type === 'error' ||
    Boolean(event.error)
  )
}

/** 关键过程副文案：有耗时显示耗时；仅整轮仍在跑且步骤未结束时才显示「尚未结束」。 */
export function getKeyProcessStepMeta(event: Event, traceStatus: Trace['status']): string {
  if (event.duration_ms != null) return formatDuration(event.duration_ms)
  if (event.ended_at) {
    const computed = new Date(event.ended_at).getTime() - new Date(event.started_at).getTime()
    if (Number.isFinite(computed) && computed >= 0) return formatDuration(computed)
  }
  if (traceStatus === 'running') return '尚未结束'
  // user / thinking / tool_started 等多为瞬时或 start 事件，整轮结束后仍无 duration
  return '无单独耗时'
}

export function TraceOperationsOverview({
  trace,
  events,
  contentBlocks,
}: TraceOperationsOverviewProps) {
  const summary = useMemo(() => {
    const llmEvents = events.filter(isLlmEvent)
    const toolEvents = events.filter(isToolEvent)
    const errorEvents = events.filter((event) => event.event_type === 'error' || event.error)
    const duration =
      trace.duration_ms ??
      (trace.ended_at
        ? new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
        : null)
    const keyEventCandidates = events.filter(isKeyEvent).sort((left, right) => left.seq - right.seq)
    let hasUserRequest = false
    const keyEvents = keyEventCandidates
      .filter((event) => {
        if (!getEventKey(event).includes('user')) return true
        if (hasUserRequest) return false
        hasUserRequest = true
        return true
      })
      .slice(0, 12)

    return { llmEvents, toolEvents, errorEvents, duration, keyEvents }
  }, [events, trace])

  const messageProcess = useMemo(() => buildMessageProcessView(contentBlocks), [contentBlocks])
  const hasMessageProcess =
    messageProcess.thinkingSteps.length > 0 || messageProcess.toolSteps.length > 0

  const outcome =
    trace.status === 'completed'
      ? {
          title: '本次执行已正常完成',
          description: 'Agent 已完成这一轮处理，目前不需要运营介入。',
          icon: <CheckCircle2 className="h-5 w-5 text-success" />,
          tone: 'border-success/30 bg-success/5',
        }
      : trace.status === 'running'
        ? {
            title: '本次执行仍在进行',
            description: 'Agent 尚未结束处理，可以稍后刷新查看最终结果。',
            icon: <Loader2 className="h-5 w-5 animate-spin text-info" />,
            tone: 'border-info/30 bg-info/5',
          }
        : {
            title: '本次执行未能完成',
            description: '建议先查看失败原因，再判断是否需要联系用户或转交研发排查。',
            icon: <AlertCircle className="h-5 w-5 text-destructive" />,
            tone: 'border-destructive/30 bg-destructive/5',
          }

  return (
    <div className="h-full overflow-auto bg-muted/10 p-6">
      <div className="mx-auto max-w-5xl space-y-5">
        <section
          className={`rounded-lg border p-5 ${outcome.tone}`}
          aria-labelledby="outcome-title"
        >
          <div className="flex items-start gap-3">
            {outcome.icon}
            <div>
              <h2 id="outcome-title" className="text-subtitle font-semibold">
                {outcome.title}
              </h2>
              <p className="mt-1 text-body text-muted-foreground">{outcome.description}</p>
              {trace.error && (
                <p className="mt-3 rounded-md bg-background/70 px-3 py-2 text-body text-destructive">
                  失败原因：{trace.error}
                </p>
              )}
            </div>
          </div>
        </section>

        <section aria-labelledby="execution-summary-title">
          <h2 id="execution-summary-title" className="mb-3 text-subtitle font-semibold">
            执行摘要
          </h2>
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <SummaryItem
              icon={<Clock className="h-4 w-4" />}
              label="处理耗时"
              value={summary.duration === null ? '进行中' : formatDuration(summary.duration)}
            />
            <SummaryItem
              icon={<MessageSquare className="h-4 w-4" />}
              label="关键动作"
              value={`${summary.keyEvents.length} 个`}
            />
            <SummaryItem
              icon={<Brain className="h-4 w-4" />}
              label="生成回复"
              value={`${summary.llmEvents.length} 次`}
            />
            <SummaryItem
              icon={<Wrench className="h-4 w-4" />}
              label="调用工具"
              value={`${summary.toolEvents.length} 次`}
            />
          </div>
        </section>

        {hasMessageProcess && (
          <section
            className="rounded-lg border bg-background p-4"
            aria-labelledby="message-process-title"
          >
            <div className="mb-3">
              <h2 id="message-process-title" className="text-subtitle font-semibold">
                思考与执行过程
              </h2>
              <p className="mt-0.5 text-caption text-muted-foreground">
                来自本轮消息落库的思考与工具调用明细
              </p>
            </div>
            <MessageProcessBlocks contentBlocks={contentBlocks} />
          </section>
        )}
      </div>
    </div>
  )
}

function SummaryItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode
  label: string
  value: string
}) {
  return (
    <div className="rounded-lg border bg-background p-4">
      <div className="flex items-center gap-2 text-caption text-muted-foreground">
        {icon}
        <span>{label}</span>
      </div>
      <p className="mt-2 text-title font-semibold">{value}</p>
    </div>
  )
}
