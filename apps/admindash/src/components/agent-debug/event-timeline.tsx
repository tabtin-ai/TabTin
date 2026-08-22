/**
 * Event Timeline 组件
 * 左侧事件列表,竖向时间线,支持多维度筛选和快速跳转
 */

import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { cn } from '@/lib/utils'
import type { Event } from '@/types/agent-debug'
import {
  AlertCircle,
  ArrowDownUp,
  Brain,
  Camera,
  ChevronDown,
  Circle,
  FileWarning,
  Navigation,
  Route,
  Search,
  Timer,
  Workflow,
  Zap,
} from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { getEventNameLabel, getEventTypeLabel } from './event-labels'

interface EventTimelineProps {
  events: Event[]
  selectedEventId: string | null
  onSelectEvent: (eventId: string) => void
}

// 事件类型图标映射
const eventTypeIcons: Record<string, React.ReactNode> = {
  node: <Workflow className="h-4 w-4" />,
  route: <Route className="h-4 w-4" />,
  llm: <Brain className="h-4 w-4" />,
  tool: <Zap className="h-4 w-4" />,
  action_result: <ArrowDownUp className="h-4 w-4" />,
  prompt_snapshot: <Camera className="h-4 w-4" />,
  error: <FileWarning className="h-4 w-4" />,
  context: <Circle className="h-4 w-4" />,
}

// 事件类型颜色映射
const eventTypeColors: Record<string, string> = {
  node: 'text-type-ai',
  route: 'text-warning',
  llm: 'text-info',
  tool: 'text-success',
  action_result: 'text-info',
  prompt_snapshot: 'text-info',
  error: 'text-destructive',
  context: 'text-muted-foreground',
}

// 事件类型背景色映射
const eventTypeBgColors: Record<string, string> = {
  node: 'bg-type-ai/10 border-type-ai/30',
  route: 'bg-warning/10 border-warning/30',
  llm: 'bg-info/10 border-info/30',
  tool: 'bg-success/10 border-success/30',
  action_result: 'bg-info/10 border-info/30',
  prompt_snapshot: 'bg-info/10 border-info/30',
  error: 'bg-destructive/10 border-destructive/30',
  context: 'bg-muted border-border',
}

// 格式化耗时
function formatDuration(ms: number | null): string {
  if (ms === null) return ''
  if (ms < 1) return '<1 毫秒'
  if (ms < 1000) return `${Math.round(ms)} 毫秒`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)} 秒`
  return `${(ms / 60000).toFixed(1)} 分`
}

// 计算 token 数（如果是 LLM event）
function getTokenCount(event: Event): number | null {
  if (event.event_type === 'llm' && event.usage) {
    return event.usage.total_tokens || null
  }
  return null
}

function getEventPhase(event: Event): 'start' | 'end' {
  return event.ended_at ? 'end' : 'start'
}

export function EventTimeline({ events, selectedEventId, onSelectEvent }: EventTimelineProps) {
  const [searchQuery, setSearchQuery] = useState('')
  const [filterErrorsOnly, setFilterErrorsOnly] = useState(false)
  const [filterSlowOnly, setFilterSlowOnly] = useState(false)
  const [filterLLMOnly, setFilterLLMOnly] = useState(false)
  const [filterToolsOnly, setFilterToolsOnly] = useState(false)
  const slowThresholdMs = 1000

  // 选中事件的 ref,用于自动滚动
  const selectedEventRef = useRef<HTMLButtonElement>(null)

  // 当 selectedEventId 变化时,自动滚动到对应事件
  useEffect(() => {
    if (selectedEventId && selectedEventRef.current) {
      selectedEventRef.current.scrollIntoView({
        behavior: 'smooth',
        block: 'center',
      })
    }
  }, [selectedEventId])

  // 构建事件树并按 seq 排序
  const eventTree = useMemo(() => {
    const sorted = [...events].sort((a, b) => a.seq - b.seq)

    // 构建 parent -> children 映射
    const childrenMap = new Map<string | null, Event[]>()
    for (const event of sorted) {
      const parentId = event.parent_event_id
      const siblings = childrenMap.get(parentId)
      if (siblings) {
        siblings.push(event)
      } else {
        childrenMap.set(parentId, [event])
      }
    }

    // 递归构建树，返回扁平化的显示列表（带 depth 信息）
    const flatList: Array<{ event: Event; depth: number }> = []

    function buildTree(parentId: string | null, depth: number) {
      const children = childrenMap.get(parentId) || []
      for (const event of children) {
        flatList.push({ event, depth })
        // 递归处理子事件
        buildTree(event.id, depth + 1)
      }
    }

    buildTree(null, 0)
    return flatList
  }, [events])

  // 过滤事件
  const filteredEventTree = useMemo(() => {
    return eventTree.filter(({ event }) => {
      // 搜索过滤
      if (searchQuery.trim()) {
        const query = searchQuery.toLowerCase()
        const typeLabel = getEventTypeLabel(event.event_type).toLowerCase()
        const nameLabel = getEventNameLabel(event.name).toLowerCase()
        const matchesSearch =
          event.name.toLowerCase().includes(query) ||
          event.event_type.toLowerCase().includes(query) ||
          typeLabel.includes(query) ||
          nameLabel.includes(query) ||
          event.seq.toString().includes(query) ||
          event.error?.toLowerCase().includes(query)
        if (!matchesSearch) return false
      }

      // 标签筛选
      if (filterErrorsOnly && !event.error) return false
      if (filterSlowOnly && (event.duration_ms === null || event.duration_ms < slowThresholdMs))
        return false
      if (filterLLMOnly && event.event_type !== 'llm') return false
      if (filterToolsOnly && event.event_type !== 'tool') return false

      return true
    })
  }, [eventTree, searchQuery, filterErrorsOnly, filterSlowOnly, filterLLMOnly, filterToolsOnly])

  // 统计各类型事件数量
  const eventCounts = useMemo(() => {
    const isErrorEvent = (e: Event) => Boolean(e.error) || e.event_type === 'error'
    return {
      errors: events.filter(isErrorEvent).length,
      slow: events.filter((e) => e.duration_ms !== null && e.duration_ms >= slowThresholdMs).length,
      llm: events.filter((e) => e.event_type === 'llm').length,
      tools: events.filter((e) => e.event_type === 'tool').length,
    }
  }, [events])

  // 快速跳转选项
  const quickJumpOptions = useMemo(() => {
    const firstError = events.find((e) => e.error || e.event_type === 'error')
    const slowestEvent = [...events]
      .filter((e) => e.duration_ms !== null)
      .sort((a, b) => (b.duration_ms || 0) - (a.duration_ms || 0))[0]
    const firstLLM = events.find((e) => e.event_type === 'llm')
    const lastTool = [...events].reverse().find((e) => e.event_type === 'tool')

    return [
      firstError && {
        label: '第一个错误',
        event: firstError,
        icon: AlertCircle,
        color: 'text-destructive',
      },
      slowestEvent && {
        label: '最慢的事件',
        event: slowestEvent,
        icon: Timer,
        color: 'text-warning',
      },
      firstLLM && { label: '第一个模型调用', event: firstLLM, icon: Brain, color: 'text-info' },
      lastTool && { label: '最后一个工具', event: lastTool, icon: Zap, color: 'text-success' },
    ].filter(Boolean) as Array<{
      label: string
      event: Event
      icon: React.ElementType
      color: string
    }>
  }, [events])

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* 顶部搜索栏 */}
      <div className="flex-shrink-0 border-b border-border p-3 space-y-2">
        <div className="relative">
          <Search className="absolute left-2 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder="搜索事件（名称、类型、序号...）"
            className="pl-8 h-8 text-body"
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
          />
        </div>

        {/* 标签云筛选 */}
        <div className="flex items-center gap-2 flex-wrap">
          <Badge
            variant={filterErrorsOnly ? 'default' : 'outline'}
            className={cn(
              'cursor-pointer text-body',
              filterErrorsOnly && 'bg-destructive hover:bg-destructive'
            )}
            onClick={() => setFilterErrorsOnly(!filterErrorsOnly)}
          >
            <AlertCircle className="mr-1 h-3 w-3" />
            错误 {eventCounts.errors > 0 && `(${eventCounts.errors})`}
          </Badge>

          <Badge
            variant={filterSlowOnly ? 'default' : 'outline'}
            className={cn(
              'cursor-pointer text-body',
              filterSlowOnly && 'bg-warning hover:bg-warning'
            )}
            onClick={() => setFilterSlowOnly(!filterSlowOnly)}
          >
            <Timer className="mr-1 h-3 w-3" />
            慢查询 {eventCounts.slow > 0 && `(${eventCounts.slow})`}
          </Badge>

          <Badge
            variant={filterLLMOnly ? 'default' : 'outline'}
            className={cn('cursor-pointer text-body', filterLLMOnly && 'bg-info hover:bg-info')}
            onClick={() => setFilterLLMOnly(!filterLLMOnly)}
          >
            <Brain className="mr-1 h-3 w-3" />
            模型 {eventCounts.llm > 0 && `(${eventCounts.llm})`}
          </Badge>

          <Badge
            variant={filterToolsOnly ? 'default' : 'outline'}
            className={cn(
              'cursor-pointer text-body',
              filterToolsOnly && 'bg-success hover:bg-success'
            )}
            onClick={() => setFilterToolsOnly(!filterToolsOnly)}
          >
            <Zap className="mr-1 h-3 w-3" />
            工具 {eventCounts.tools > 0 && `(${eventCounts.tools})`}
          </Badge>

          {/* 快速跳转下拉菜单 */}
          {quickJumpOptions.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="h-6 text-body ml-auto">
                  <Navigation className="mr-1 h-3 w-3" />
                  快速跳转
                  <ChevronDown className="ml-1 h-3 w-3" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {quickJumpOptions.map((option) => {
                  const Icon = option.icon
                  return (
                    <DropdownMenuItem
                      key={option.event.id}
                      onClick={() => onSelectEvent(option.event.id)}
                      className="flex items-center gap-2 cursor-pointer"
                    >
                      <Icon className={cn('h-4 w-4', option.color)} />
                      <span className="flex-1">{option.label}</span>
                      <span className="text-body text-muted-foreground">#{option.event.seq}</span>
                    </DropdownMenuItem>
                  )
                })}
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </div>

      {/* 事件列表统计 */}
      <div className="flex-shrink-0 border-b border-border px-3 py-2 text-body text-muted-foreground">
        {searchQuery || filterErrorsOnly || filterSlowOnly || filterLLMOnly || filterToolsOnly ? (
          <>
            {filteredEventTree.length} / {eventTree.length} 条事件
            {filteredEventTree.length === 0 && (
              <span className="ml-2 text-warning">· 没有匹配的事件</span>
            )}
          </>
        ) : (
          `${eventTree.length} 条事件`
        )}
      </div>

      {/* 事件列表 */}
      <ScrollArea className="flex-1">
        <div className="relative">
          {/* 时间线竖线 */}
          <div className="absolute left-6 top-0 bottom-0 w-px bg-border" />

          {/* 事件卡片列表 */}
          <div className="space-y-0">
            {filteredEventTree.map(({ event, depth }) => {
              const isSelected = event.id === selectedEventId
              const tokens = getTokenCount(event)
              const isNested = depth > 0
              const isSlow = event.duration_ms !== null && event.duration_ms >= slowThresholdMs

              return (
                <button
                  type="button"
                  key={event.id}
                  ref={isSelected ? selectedEventRef : null}
                  className={cn(
                    'relative flex w-full items-start gap-3 px-3 py-2 text-left transition-colors',
                    'hover:bg-muted/50',
                    isSelected && 'bg-primary/10 border-l-2 border-primary'
                  )}
                  onClick={() => onSelectEvent(event.id)}
                  style={{
                    paddingLeft: `${12 + depth * 20}px`, // 根据层级缩进
                  }}
                >
                  {/* 嵌套连接线 */}
                  {isNested && (
                    <div
                      className="absolute top-0 bottom-1/2 border-l border-b border-border/50 rounded-bl"
                      style={{
                        left: `${24 + (depth - 1) * 20}px`,
                        width: '12px',
                      }}
                    />
                  )}

                  {/* 时间线节点 */}
                  <div className="relative z-10 mt-1">
                    <div
                      className={cn(
                        'flex items-center justify-center rounded-full border-2 bg-background',
                        eventTypeBgColors[event.event_type] || 'bg-muted border-border',
                        eventTypeColors[event.event_type] || 'text-muted-foreground',
                        isNested ? 'h-5 w-5' : 'h-6 w-6' // 嵌套事件的节点更小
                      )}
                    >
                      {isNested ? (
                        <div
                          className={cn(
                            'h-1.5 w-1.5 rounded-full',
                            eventTypeColors[event.event_type] || 'text-muted-foreground'
                          )}
                        />
                      ) : (
                        eventTypeIcons[event.event_type] || <Circle className="h-4 w-4" />
                      )}
                    </div>
                  </div>

                  {/* 事件信息 */}
                  <div className="flex-1 min-w-0 pt-0.5">
                    {/* 第一行：序号 + 类型 + 名称 */}
                    <div className="flex items-center gap-2 mb-1">
                      <span className="text-body text-muted-foreground font-mono">
                        #{event.seq}
                      </span>
                      <span
                        className={cn(
                          'text-body font-medium',
                          eventTypeColors[event.event_type] || 'text-muted-foreground'
                        )}
                        title={event.event_type}
                      >
                        {getEventTypeLabel(event.event_type)}
                      </span>
                      {event.error && <AlertCircle className="h-3 w-3 text-destructive" />}
                      {isSlow && !event.error && <Timer className="h-3 w-3 text-warning" />}
                    </div>

                    {/* 第二行：名称 */}
                    <div
                      className="text-body font-medium truncate"
                      title={`${getEventNameLabel(event.name)}（${event.name}）`}
                    >
                      {getEventNameLabel(event.name)}
                    </div>

                    {/* 第三行：耗时 + tokens（如果有） */}
                    <div className="flex items-center gap-2 mt-1 text-body text-muted-foreground">
                      {event.duration_ms !== null && (
                        <span className="font-mono">{formatDuration(event.duration_ms)}</span>
                      )}
                      {tokens !== null && (
                        <>
                          <span>·</span>
                          <span className="font-mono">{tokens} token</span>
                        </>
                      )}
                      {getEventPhase(event) === 'start' && (
                        <>
                          <span>·</span>
                          <span className="text-body text-info">进行中</span>
                        </>
                      )}
                    </div>
                  </div>
                </button>
              )
            })}
          </div>
        </div>
      </ScrollArea>
    </div>
  )
}
