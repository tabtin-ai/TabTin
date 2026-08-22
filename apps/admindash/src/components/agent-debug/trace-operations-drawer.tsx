import { agentDebugApi } from '@/api/agent-debug'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { Event, ThreadOverviewMessage, Trace } from '@/types/agent-debug'
import { AlertCircle, ArrowLeft, Code2, Loader2 } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
import { collectContentBlocksForTrace } from './conversation-process-utils'
import { EventDetailsPanel } from './event-details-panel'
import { EventTimeline } from './event-timeline'
import { LlmInputInspector } from './llm-input-inspector'
import { ResizablePanel } from './resizable-panel'
import { TraceOperationsOverview } from './trace-operations-overview'

type DrawerView = 'overview' | 'llm-input' | 'technical'

interface TraceOperationsDrawerProps {
  traceId: string | null
  /** 会话消息（含已合并的 content_blocks），用于在诊断里展示思考/执行过程 */
  messages?: ThreadOverviewMessage[]
  onClose: () => void
}

export function TraceOperationsDrawer({ traceId, messages, onClose }: TraceOperationsDrawerProps) {
  const [trace, setTrace] = useState<Trace | null>(null)
  const [events, setEvents] = useState<Event[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [view, setView] = useState<DrawerView>('overview')
  const [selectedEventId, setSelectedEventId] = useState<string | null>(null)

  useEffect(() => {
    if (!traceId) return

    let cancelled = false
    setLoading(true)
    setError(null)
    setTrace(null)
    setEvents([])
    setView('overview')
    setSelectedEventId(null)

    void Promise.all([agentDebugApi.getTrace(traceId), agentDebugApi.getAllTraceEvents(traceId)])
      .then(([nextTrace, eventResponse]) => {
        if (cancelled) return
        setTrace(nextTrace)
        setEvents(eventResponse.items)
      })
      .catch(() => {
        if (!cancelled) setError('执行信息加载失败，请稍后重试')
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => {
      cancelled = true
    }
  }, [traceId])

  const sortedEvents = useMemo(
    () => [...events].sort((left, right) => left.seq - right.seq),
    [events]
  )

  const contentBlocks = useMemo(
    () => collectContentBlocksForTrace(messages, traceId),
    [messages, traceId]
  )

  const selectedEvent = useMemo(
    () => events.find((event) => event.id === selectedEventId) ?? null,
    [events, selectedEventId]
  )

  const previousEvent = useMemo(() => {
    if (!selectedEvent) return null
    const index = sortedEvents.findIndex((event) => event.id === selectedEvent.id)
    if (index <= 0) return null
    return sortedEvents[index - 1]
  }, [selectedEvent, sortedEvents])

  const openTechnicalDetails = (eventId?: string) => {
    const nextId =
      eventId ?? selectedEventId ?? (sortedEvents.length > 0 ? sortedEvents[0].id : null)
    setSelectedEventId(nextId)
    setView('technical')
  }

  const title =
    view === 'overview' ? '本次执行' : view === 'llm-input' ? 'LLM 调用入参' : '技术详情'
  const description =
    view === 'overview'
      ? '在当前会话内查看结果，不会离开对话上下文'
      : view === 'llm-input'
        ? '查看这一轮执行中模型实际收到的上下文'
        : '本轮执行的完整事件流与入参出参，仍留在当前弹框中'

  const isWide = view === 'technical'

  return (
    <Dialog open={Boolean(traceId)} onOpenChange={(open) => !open && onClose()}>
      <DialogContent
        className={`left-auto right-0 top-0 h-screen max-w-none translate-x-0 translate-y-0 grid-rows-[auto_minmax(0,1fr)] gap-0 rounded-none p-0 transition-[width] ${
          isWide ? 'w-[min(1100px,96vw)]' : 'w-[min(760px,96vw)]'
        }`}
      >
        <DialogHeader className="border-b px-6 py-4 pr-14">
          <div className="flex items-start justify-between gap-4">
            <div className="flex min-w-0 items-start gap-2">
              {view !== 'overview' && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="-ml-2 h-8 w-8 shrink-0"
                  onClick={() => setView('overview')}
                  aria-label="返回本次执行"
                >
                  <ArrowLeft className="h-4 w-4" />
                </Button>
              )}
              <div className="min-w-0">
                <DialogTitle>{title}</DialogTitle>
                <DialogDescription className="mt-1 truncate">{description}</DialogDescription>
              </div>
            </div>
            <div className="flex shrink-0 items-center gap-2">
              {view === 'overview' && (
                <>
                  <Button variant="outline" size="sm" onClick={() => setView('llm-input')}>
                    <Code2 className="mr-2 h-4 w-4" />
                    查看 LLM 调用入参
                  </Button>
                  <Button variant="outline" size="sm" onClick={() => openTechnicalDetails()}>
                    技术详情
                  </Button>
                </>
              )}
            </div>
          </div>
        </DialogHeader>

        <div className="min-h-0 flex-1 overflow-hidden">
          {loading && (
            <div className="flex h-full items-center justify-center text-body text-muted-foreground">
              <Loader2 className="mr-2 h-5 w-5 animate-spin" />
              正在整理执行信息…
            </div>
          )}
          {error && (
            <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
              <AlertCircle className="h-9 w-9 text-destructive" />
              <p className="text-body text-destructive">{error}</p>
            </div>
          )}
          {!loading && !error && trace && view === 'overview' && (
            <TraceOperationsOverview trace={trace} events={events} contentBlocks={contentBlocks} />
          )}
          {!loading && !error && trace && view === 'llm-input' && (
            <LlmInputInspector events={events} />
          )}
          {!loading && !error && trace && view === 'technical' && (
            <ResizablePanel
              leftPanel={
                <EventTimeline
                  events={events}
                  selectedEventId={selectedEventId}
                  onSelectEvent={setSelectedEventId}
                />
              }
              rightPanel={<EventDetailsPanel event={selectedEvent} previousEvent={previousEvent} />}
              defaultLeftWidth={34}
              minLeftWidth={24}
              maxLeftWidth={50}
            />
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
