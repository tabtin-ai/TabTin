import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAgentDebugStore } from '@/stores/agent-debug-store'
import type { Event } from '@/types/agent-debug'
import { Box, Eye, GitBranch, Loader2, MessageSquare, Wrench } from 'lucide-react'
import { useEffect, useState } from 'react'

// Event 类型图标映射（复用）
const eventTypeIcons: Record<string, React.ReactNode> = {
  tool: <Wrench className="h-3 w-3" />,
  node: <Box className="h-3 w-3" />,
  route: <GitBranch className="h-3 w-3" />,
  action_result: <Eye className="h-3 w-3" />,
  context: <Eye className="h-3 w-3" />,
}

// Event 类型颜色
const eventTypeColors: Record<string, string> = {
  tool: 'bg-info/10 dark:bg-info/10 text-info dark:text-info border-info/30 dark:border-info/30',
  node: 'bg-warning/10 dark:bg-warning/10 text-warning dark:text-warning border-warning/30 dark:border-warning/30',
  route:
    'bg-teal-100 dark:bg-teal-900/30 text-teal-600 dark:text-teal-400 border-teal-300 dark:border-teal-700',
  action_result:
    'bg-success/10 dark:bg-success/10 text-success dark:text-success border-success/30 dark:border-success/30',
  context:
    'bg-muted dark:bg-muted text-muted-foreground dark:text-muted-foreground border-border dark:border-border',
}

// 格式化时间（显示相对时间）
function formatRelativeTime(startTime: string, currentTime: string): string {
  const start = new Date(startTime).getTime()
  const current = new Date(currentTime).getTime()
  const diff = current - start

  if (diff < 1000) return `+${diff}ms`
  return `+${(diff / 1000).toFixed(2)}s`
}

// 格式化耗时
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

function getEventPhase(event: Event): 'start' | 'end' {
  return event.ended_at ? 'end' : 'start'
}

// Timeline 事件项
interface TimelineEventItemProps {
  event: Event
  startTime: string
  onSelect: (event: Event) => void
  isSelected: boolean
}

function TimelineEventItem({ event, startTime, onSelect, isSelected }: TimelineEventItemProps) {
  const relativeTime = formatRelativeTime(startTime, event.started_at)
  const duration = formatDuration(event.duration_ms)

  return (
    <button
      type="button"
      onClick={() => onSelect(event)}
      className={`w-full text-left ${isSelected ? 'bg-primary/10' : 'hover:bg-muted/30'} transition-colors`}
    >
      <div className="flex gap-4 px-6 py-3">
        {/* 左侧：时间轴线 */}
        <div className="flex flex-col items-center">
          <div
            className={`flex h-6 w-6 items-center justify-center rounded-full border-2 ${
              eventTypeColors[event.event_type] ||
              'bg-muted dark:bg-muted text-muted-foreground dark:text-muted-foreground border-border dark:border-border'
            }`}
          >
            {eventTypeIcons[event.event_type] || <MessageSquare className="h-3 w-3" />}
          </div>
          <div className="w-0.5 flex-1 bg-border mt-1" />
        </div>

        {/* 右侧：事件信息 */}
        <div className="flex-1 pb-3">
          <div className="flex items-center gap-2 mb-1">
            <span className="font-medium text-body">{event.name}</span>
            <Badge variant="outline" className="text-body uppercase">
              {getEventPhase(event)}
            </Badge>
            {duration && <span className="text-body text-muted-foreground">{duration}</span>}
          </div>
          <div className="text-body text-muted-foreground">
            {relativeTime} · Seq #{event.seq}
          </div>
        </div>
      </div>
    </button>
  )
}

// Timeline 主视图
export function TimelineView({ traceId }: { traceId: string }) {
  const { events, eventsLoading, eventsError, loadEvents } = useAgentDebugStore()

  const [selectedEvent, setSelectedEvent] = useState<Event | null>(null)

  // 加载 Events
  useEffect(() => {
    loadEvents(traceId)
  }, [loadEvents, traceId])

  // Loading 状态
  if (eventsLoading && events.length === 0) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    )
  }

  // 错误状态
  if (eventsError) {
    return (
      <div className="flex h-full items-center justify-center text-destructive">
        <p>{eventsError}</p>
      </div>
    )
  }

  // 空状态
  if (events.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
        <MessageSquare className="h-12 w-12 mb-4 opacity-20" />
        <p>No events found</p>
      </div>
    )
  }

  // 按时间排序（应该已经按 seq 排序）
  const sortedEvents = [...events].sort((a, b) => a.seq - b.seq)
  const startTime = sortedEvents[0]?.started_at || new Date().toISOString()

  return (
    <div className="flex h-full">
      {/* 左侧：Timeline */}
      <div className="w-1/2 border-r">
        <div className="border-b px-6 py-3 bg-muted/10">
          <h3 className="font-semibold text-body">Timeline ({events.length} events)</h3>
        </div>
        <ScrollArea className="h-[calc(100%-49px)]">
          <div className="py-2">
            {sortedEvents.map((event, idx) => (
              <div key={event.id}>
                <TimelineEventItem
                  event={event}
                  startTime={startTime}
                  onSelect={setSelectedEvent}
                  isSelected={selectedEvent?.id === event.id}
                />
                {/* 最后一个事件不显示底部线条 */}
                {idx === sortedEvents.length - 1 && (
                  <div className="flex gap-4 px-6">
                    <div className="flex flex-col items-center">
                      <div className="h-6 w-6" />
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* 右侧：事件详情预览 */}
      <div className="w-1/2">
        {selectedEvent ? (
          <ScrollArea className="h-full">
            <div className="p-6 space-y-4">
              <div>
                <h3 className="font-semibold mb-2">{selectedEvent.name}</h3>
                <div className="grid grid-cols-2 gap-3 text-body">
                  <div>
                    <span className="text-muted-foreground">Event ID:</span>
                    <p className="font-mono text-body mt-1">{selectedEvent.id}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Type:</span>
                    <p className="mt-1 capitalize">{selectedEvent.event_type}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Phase:</span>
                    <p className="mt-1 uppercase">{getEventPhase(selectedEvent)}</p>
                  </div>
                  <div>
                    <span className="text-muted-foreground">Duration:</span>
                    <p className="mt-1">{formatDuration(selectedEvent.duration_ms)}</p>
                  </div>
                </div>
              </div>

              {selectedEvent.input && (
                <div>
                  <h4 className="font-semibold text-body mb-2">Input</h4>
                  <div className="rounded-md border bg-muted/30">
                    <pre className="p-3 text-body font-mono overflow-x-auto">
                      {JSON.stringify(selectedEvent.input, null, 2)}
                    </pre>
                  </div>
                </div>
              )}

              {selectedEvent.output && (
                <div>
                  <h4 className="font-semibold text-body mb-2">Output</h4>
                  <div className="rounded-md border bg-muted/30">
                    <pre className="p-3 text-body font-mono overflow-x-auto">
                      {JSON.stringify(selectedEvent.output, null, 2)}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          </ScrollArea>
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Select an event to view details</p>
          </div>
        )}
      </div>
    </div>
  )
}
