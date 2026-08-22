import { Badge } from '@/components/ui/badge'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAgentDebugStore } from '@/stores/agent-debug-store'
import type { Event, EventPhase, LLMEvent, ToolEvent } from '@/types/agent-debug'
import {
  Box,
  Brain,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code,
  Eye,
  GitBranch,
  Loader2,
  MessageSquare,
  Wrench,
} from 'lucide-react'
import { useEffect, useState } from 'react'
import { LLMEventViewer } from './llm-event-viewer'
import { ToolEventViewer } from './tool-event-viewer'

// Event 类型图标映射
const eventTypeIcons: Record<string, React.ReactNode> = {
  llm: <Brain className="h-4 w-4" />,
  tool: <Wrench className="h-4 w-4" />,
  node: <Box className="h-4 w-4" />,
  route: <GitBranch className="h-4 w-4" />,
  action_result: <CheckCircle2 className="h-4 w-4" />,
  context: <Eye className="h-4 w-4" />,
}

function getEventPhase(event: Event): EventPhase {
  return event.ended_at ? 'end' : 'start'
}

// Event 类型颜色（根据 type + phase）
function getEventColor(type: string, phase: EventPhase): string {
  if (phase === 'start') {
    return 'text-info dark:text-info'
  }
  switch (type) {
    case 'llm':
      return 'text-type-ai'
    case 'tool':
      return 'text-success dark:text-success'
    case 'node':
      return 'text-warning dark:text-warning'
    case 'route':
      return 'text-teal-600 dark:text-teal-400'
    case 'action_result':
      return 'text-success dark:text-success'
    case 'context':
      return 'text-muted-foreground dark:text-muted-foreground'
    default:
      return 'text-muted-foreground dark:text-muted-foreground'
  }
}

// Event 类型显示名称
const eventTypeLabels: Record<string, string> = {
  llm: 'LLM',
  tool: 'Tool',
  node: 'Node',
  route: 'Route',
  action_result: 'Action Result',
  context: 'Context',
}

// 格式化时间
function formatEventTime(isoString: string): string {
  const date = new Date(isoString)
  return `${date.toLocaleTimeString('zh-CN', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })}.${date.getMilliseconds().toString().padStart(3, '0')}`
}

// 格式化耗时
function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  if (ms < 1) return '<1ms'
  if (ms < 1000) return `${Math.round(ms)}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

// 构建树形结构
function buildEventTree(events: Event[]): Event[] {
  const eventMap = new Map<string, Event & { children: Event[] }>()
  const roots: Event[] = []

  // 初始化 map
  for (const event of events) {
    eventMap.set(event.id, { ...event, children: [] })
  }

  // 构建父子关系
  for (const event of events) {
    const node = eventMap.get(event.id)
    if (!node) {
      continue
    }
    if (event.parent_event_id !== null) {
      const parent = eventMap.get(event.parent_event_id)
      if (parent) {
        parent.children.push(node)
        continue
      }
    }
    roots.push(node)
  }

  return roots
}

// Event Tree Node 组件
function EventTreeNode({
  event,
  level = 0,
  onSelect,
  selectedId,
}: {
  event: Event & { children?: Event[] }
  level?: number
  onSelect: (event: Event) => void
  selectedId: string | null
}) {
  const [isExpanded, setIsExpanded] = useState(level < 2) // 默认展开前两层
  const hasChildren = Boolean(event.children?.length)

  return (
    <div>
      <div
        className={`w-full flex items-center gap-2 py-2 px-3 text-left hover:bg-muted/50 transition-colors ${
          selectedId === event.id ? 'bg-primary/10 border-l-2 border-primary' : ''
        }`}
        style={{ paddingLeft: `${level * 20 + 12}px` }}
      >
        {/* 展开/收起按钮 */}
        {hasChildren ? (
          <button
            type="button"
            onClick={(clickEvent) => {
              clickEvent.stopPropagation()
              setIsExpanded(!isExpanded)
            }}
            className="flex-shrink-0 h-4 w-4 hover:bg-muted rounded"
          >
            {isExpanded ? (
              <ChevronDown className="h-4 w-4" />
            ) : (
              <ChevronRight className="h-4 w-4" />
            )}
          </button>
        ) : (
          <div className="w-4" />
        )}

        <button
          type="button"
          className="flex flex-1 items-center gap-2 min-w-0 text-left"
          onClick={() => onSelect(event)}
        >
          {/* 图标 */}
          <div className={`flex-shrink-0 ${getEventColor(event.event_type, getEventPhase(event))}`}>
            {eventTypeIcons[event.event_type] || <Code className="h-4 w-4" />}
          </div>

          {/* 内容 */}
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-body font-medium truncate">{event.name}</span>
              <Badge variant="outline" className="text-body uppercase">
                {getEventPhase(event)}
              </Badge>
              {event.duration_ms !== null && event.duration_ms !== undefined && (
                <span className="text-body text-muted-foreground">
                  {formatDuration(event.duration_ms)}
                </span>
              )}
            </div>
            <div className="text-body text-muted-foreground">
              {formatEventTime(event.started_at)} ·{' '}
              {eventTypeLabels[event.event_type] || event.event_type}
            </div>
          </div>
        </button>
      </div>

      {/* 子节点 */}
      {hasChildren && isExpanded && (
        <div>
          {event.children?.map((child) => (
            <EventTreeNode
              key={child.id}
              event={child}
              level={level + 1}
              onSelect={onSelect}
              selectedId={selectedId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// Event 详情面板
function EventDetailPanel({ event }: { event: Event }) {
  // 根据事件类型渲染专用查看器
  const renderSpecializedViewer = () => {
    if (event.event_type === 'llm') {
      return <LLMEventViewer event={event as LLMEvent} />
    }
    if (event.event_type === 'tool') {
      return <ToolEventViewer event={event as ToolEvent} />
    }
    return null
  }

  const specializedViewer = renderSpecializedViewer()

  return (
    <ScrollArea className="h-full">
      <div className="p-6 space-y-6">
        {/* 基本信息 */}
        <div>
          <h3 className="font-semibold mb-3 flex items-center gap-2">
            <div className={getEventColor(event.event_type, getEventPhase(event))}>
              {eventTypeIcons[event.event_type] || <Code className="h-4 w-4" />}
            </div>
            {event.name}
            <Badge variant="outline" className="ml-2 text-body uppercase">
              {getEventPhase(event)}
            </Badge>
          </h3>
          <div className="grid grid-cols-2 gap-4 text-body">
            <div>
              <span className="text-muted-foreground">Event ID:</span>
              <p className="font-mono text-body mt-1">{event.id}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Type:</span>
              <p className="mt-1">{eventTypeLabels[event.event_type] || event.event_type}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Seq:</span>
              <p className="mt-1">#{event.seq}</p>
            </div>
            <div>
              <span className="text-muted-foreground">Timestamp:</span>
              <p className="mt-1">{formatEventTime(event.started_at)}</p>
            </div>
            {event.duration_ms !== null && event.duration_ms !== undefined && (
              <div>
                <span className="text-muted-foreground">Duration:</span>
                <p className="mt-1">{formatDuration(event.duration_ms)}</p>
              </div>
            )}
            {event.parent_event_id !== null && (
              <div className="col-span-2">
                <span className="text-muted-foreground">Parent Event:</span>
                <p className="font-mono text-body mt-1">{event.parent_event_id}</p>
              </div>
            )}
          </div>
        </div>

        {/* 专用查看器（LLM 或 Tool） */}
        {specializedViewer ? (
          specializedViewer
        ) : (
          <>
            {/* 通用 Input/Output */}
            {event.input && (
              <div>
                <h4 className="font-semibold mb-2">Input</h4>
                <div className="rounded-md border bg-muted/30">
                  <ScrollArea className="h-[300px]">
                    <pre className="p-4 text-body font-mono">
                      {JSON.stringify(event.input, null, 2)}
                    </pre>
                  </ScrollArea>
                </div>
              </div>
            )}

            {event.output && (
              <div>
                <h4 className="font-semibold mb-2">Output</h4>
                <div className="rounded-md border bg-muted/30">
                  <ScrollArea className="h-[300px]">
                    <pre className="p-4 text-body font-mono">
                      {JSON.stringify(event.output, null, 2)}
                    </pre>
                  </ScrollArea>
                </div>
              </div>
            )}

            {event.error && (
              <div>
                <h4 className="font-semibold mb-2 text-destructive">Error</h4>
                <div className="rounded-md border border-destructive bg-destructive/10 p-3">
                  <p className="text-body">{event.error}</p>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </ScrollArea>
  )
}

// Events 视图组件（主导出）
export function EventsView({ traceId }: { traceId: string }) {
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

  // 构建树形结构
  const eventTree = buildEventTree(events)

  return (
    <div className="flex h-full">
      {/* 左侧：Event 树 */}
      <div className="w-1/2 border-r">
        <div className="border-b px-4 py-3 bg-muted/10">
          <h3 className="font-semibold text-body">Events ({events.length})</h3>
        </div>
        <ScrollArea className="h-[calc(100%-49px)]">
          <div className="py-2">
            {eventTree.map((event) => (
              <EventTreeNode
                key={event.id}
                event={event}
                onSelect={setSelectedEvent}
                selectedId={selectedEvent?.id || null}
              />
            ))}
          </div>
        </ScrollArea>
      </div>

      {/* 右侧：Event 详情 */}
      <div className="w-1/2">
        {selectedEvent ? (
          <EventDetailPanel event={selectedEvent} />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <p>Select an event to view details</p>
          </div>
        )}
      </div>
    </div>
  )
}
