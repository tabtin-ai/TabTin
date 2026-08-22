import { ErrorPanel } from '@/components/agent-debug/error-panel'
import { EventDetailsPanel } from '@/components/agent-debug/event-details-panel'
import { EventTimeline } from '@/components/agent-debug/event-timeline'
import { MiddlewareTimeline } from '@/components/agent-debug/middleware-timeline'
import { ParentTraceButton } from '@/components/agent-debug/parent-trace-button'
import { PromptInspector } from '@/components/agent-debug/prompt-inspector'
import { ResizablePanel } from '@/components/agent-debug/resizable-panel'
import { SubagentTracesSection } from '@/components/agent-debug/subagent-traces-section'
import { TraceOperationsOverview } from '@/components/agent-debug/trace-operations-overview'
import { Button } from '@/components/ui/button'
import { useTraceStream } from '@/hooks/useTraceStream'
import { formatDateTime } from '@/lib/utils'
import { useAgentDebugStore } from '@/stores/agent-debug-store'
import type { TraceStatus } from '@/types/agent-debug'
import {
  AlertCircle,
  ArrowLeft,
  Calendar,
  CheckCircle2,
  ChevronRight,
  Clock,
  Copy,
  FileText,
  Home,
  Layers,
  Loader2,
  MessageSquare,
  Radio,
  RefreshCw,
  Timer,
  User,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'

type DetailTab = 'overview' | 'events' | 'prompts' | 'middleware' | 'errors'

// 状态图标映射
const statusIcons: Record<TraceStatus, React.ReactNode> = {
  completed: <CheckCircle2 className="h-5 w-5 text-success" />,
  running: <Loader2 className="h-5 w-5 text-info animate-spin" />,
  error: <AlertCircle className="h-5 w-5 text-destructive" />,
}

// 状态文本映射
const statusLabels: Record<TraceStatus, string> = {
  completed: '已完成',
  running: '运行中',
  error: '失败',
}

// 格式化耗时
function formatDuration(ms: number | null): string {
  if (ms === null) return 'N/A'
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(2)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = ((ms % 60000) / 1000).toFixed(0)
  return `${minutes}m ${seconds}s`
}

export function TraceDetailPage() {
  const { traceId } = useParams<{ traceId: string }>()
  const [searchParams] = useSearchParams()
  const eventFromQuery = searchParams.get('event')
  const navigate = useNavigate()
  const {
    currentTrace,
    currentTraceLoading,
    currentTraceError,
    events,
    loadTrace,
    loadEvents,
    clearCurrentTrace,
  } = useAgentDebugStore()

  const [activeTab, setActiveTab] = useState<DetailTab>(eventFromQuery ? 'events' : 'overview')
  const [selectedEventId, setSelectedEventId] = useState<string | null>(eventFromQuery)

  // 根据 selectedEventId 获取选中的事件对象
  const selectedEvent = events.find((e) => e.id === selectedEventId) || null

  // 获取前一个事件（用于 Diff 对比）
  const previousEvent = useMemo(() => {
    if (!selectedEvent) return null
    const currentIndex = events.findIndex((e) => e.id === selectedEvent.id)
    if (currentIndex <= 0) return null // 第一个事件没有前置事件
    return events[currentIndex - 1]
  }, [selectedEvent, events])

  const errorEvents = useMemo(() => events.filter((event) => event.error), [events])

  const handleCopyDebugPack = () => {
    const payload = {
      trace: currentTrace,
      events,
      selected_event_id: selectedEventId,
    }
    navigator.clipboard.writeText(JSON.stringify(payload, null, 2))
  }

  const handleBackToThread = () => {
    if (currentTrace?.thread_id) {
      navigate(`/threads/${currentTrace.thread_id}`)
      return
    }
    if (currentTrace?.session_id) {
      navigate(`/threads/${currentTrace.session_id}`)
      return
    }
    navigate('/threads')
  }

  // 加载 Trace 详情和 Events
  useEffect(() => {
    if (traceId) {
      void loadTrace(traceId)
      void loadEvents(traceId)
    }
    return () => clearCurrentTrace()
  }, [clearCurrentTrace, loadEvents, loadTrace, traceId])

  // 支持 ?event= 深链选中；否则默认选中第一个事件
  useEffect(() => {
    if (events.length === 0) return
    if (eventFromQuery) {
      const matched = events.find((event) => event.id === eventFromQuery)
      if (matched) {
        setSelectedEventId(matched.id)
        setActiveTab('events')
        return
      }
    }
    if (selectedEventId === null || !events.some((event) => event.id === selectedEventId)) {
      const sortedEvents = [...events].sort((a, b) => a.seq - b.seq)
      setSelectedEventId(sortedEvents[0].id)
    }
  }, [eventFromQuery, events, selectedEventId])

  // ── H2-A FR-10：实时 Trace 流接入 ──
  // 仅当 trace 状态为 running 时订阅 — 已 completed/error 的 trace 没有新事件，
  // 不需要持有 WS 连接（节省 WS 订阅资源 + 避免 dashboard 大量"已完成 trace 的死订阅"）。
  // 收到新 event 时刷新 events 列表（轻量重新拉取，比累积本地状态更可靠 — 后端
  // bulk_create 后 seq 是一致的，重拉一次拿到完整有序列表）。
  // refresh 节流 1s，避免连续 event 触发 N+1 拉取。
  const isTraceRunning = currentTrace?.status === 'running'
  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const scheduleEventsRefresh = useCallback(() => {
    if (!traceId) return
    if (refreshTimerRef.current) return
    refreshTimerRef.current = setTimeout(() => {
      refreshTimerRef.current = null
      void loadEvents(traceId)
    }, 1000)
  }, [loadEvents, traceId])

  const { isConnected: streamConnected } = useTraceStream(
    isTraceRunning ? (traceId ?? null) : null,
    {
      onEvent: () => {
        scheduleEventsRefresh()
      },
      onTraceEnd: () => {
        // trace 终止时立即拉一次最终状态 + events
        if (traceId) {
          void loadTrace(traceId)
          void loadEvents(traceId)
        }
      },
    }
  )

  useEffect(() => {
    return () => {
      if (refreshTimerRef.current) {
        clearTimeout(refreshTimerRef.current)
        refreshTimerRef.current = null
      }
    }
  }, [])

  // 刷新
  const handleRefresh = () => {
    if (traceId) {
      loadTrace(traceId)
      loadEvents(traceId)
    }
  }

  // Loading 状态
  if (currentTraceLoading && !currentTrace) {
    return (
      <div className="panel-container">
        <div className="flex h-full items-center justify-center">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </div>
    )
  }

  // 错误状态
  if (currentTraceError) {
    return (
      <div className="panel-container">
        <div className="flex h-full flex-col items-center justify-center gap-4">
          <AlertCircle className="h-12 w-12 text-destructive" />
          <p className="text-destructive">{currentTraceError}</p>
          <Button onClick={handleRefresh}>Retry</Button>
        </div>
      </div>
    )
  }

  // Trace 不存在
  if (!currentTrace) {
    return (
      <div className="panel-container">
        <div className="flex h-full items-center justify-center text-muted-foreground">
          <p>Trace not found</p>
        </div>
      </div>
    )
  }

  const trace = currentTrace

  return (
    <div className="panel-container">
      {/* 顶部导航栏 + 面包屑 */}
      <div className="border-b bg-background">
        {/* 面包屑导航 */}
        <div className="flex items-center gap-2 px-6 py-2 text-body text-muted-foreground border-b">
          <button
            type="button"
            onClick={() => navigate('/threads')}
            className="flex items-center gap-1 hover:text-foreground transition-colors"
          >
            <Home className="h-3.5 w-3.5" />
            <span>会话列表</span>
          </button>
          {(trace.thread_id || trace.session_id) && (
            <>
              <ChevronRight className="h-3.5 w-3.5" />
              <button
                type="button"
                onClick={handleBackToThread}
                className="hover:text-foreground transition-colors font-mono"
              >
                {(trace.thread_id || trace.session_id || '').substring(0, 12)}...
              </button>
              <ChevronRight className="h-3.5 w-3.5" />
              <span className="font-mono text-foreground">
                执行记录：{trace.trace_id.substring(0, 8)}...
              </span>
            </>
          )}
        </div>

        {/* 主标题栏 */}
        <div className="flex h-14 items-center justify-between px-6">
          <div className="flex items-center gap-3">
            <Button variant="ghost" size="icon" onClick={handleBackToThread} className="h-8 w-8">
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-title font-semibold">执行详情</h1>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {/* H2-A FR-10：实时订阅状态指示器 — 仅 running trace 显示。 */}
            {isTraceRunning && (
              <div
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-body ${
                  streamConnected
                    ? 'border-success/30 bg-success/10 text-success'
                    : 'border-muted bg-muted/20 text-muted-foreground'
                }`}
                title={streamConnected ? '已订阅实时事件流' : '实时事件流未连接'}
              >
                <Radio className={`h-3.5 w-3.5 ${streamConnected ? 'animate-pulse' : ''}`} />
                <span>{streamConnected ? '实时' : '未连接'}</span>
              </div>
            )}
            <Button
              variant="outline"
              size="sm"
              onClick={handleRefresh}
              disabled={currentTraceLoading}
            >
              <RefreshCw className={`h-4 w-4 ${currentTraceLoading ? 'animate-spin' : ''}`} />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={handleCopyDebugPack}
              disabled={!currentTrace}
            >
              <Copy className="mr-1 h-4 w-4" />
              复制调试包
            </Button>
          </div>
        </div>
      </div>

      {/* 紧凑的概览信息栏 */}
      <div className="border-b bg-muted/5 px-6 py-3">
        <div className="flex items-center justify-between">
          {/* 左侧：状态 + 类型 + 耗时 */}
          <div className="flex items-center gap-6">
            <div className="flex items-center gap-2">
              {statusIcons[trace.status]}
              <span className="font-semibold text-body">{statusLabels[trace.status]}</span>
            </div>
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <Layers className="h-4 w-4" />
              <span className="capitalize">{trace.graph_type}</span>
            </div>
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <Clock className="h-4 w-4" />
              <span>
                {trace.ended_at
                  ? formatDuration(
                      new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
                    )
                  : '运行中...'}
              </span>
            </div>
            <div className="flex items-center gap-2 text-body text-muted-foreground">
              <Calendar className="h-4 w-4" />
              <span className="text-body">{formatDateTime(trace.started_at)}</span>
            </div>
            {/* LH2-A1：当前 trace 是子 Agent trace 时，提供回到父 trace 的快捷入口。
                运维收到子 trace_id（如客服工单）能一键跳到父 trace 看上下文。
                Review S3 修复：父按钮预检父 trace 是否存在——孤儿子 trace（父
                relay 未到达 / 父写表失败）显示灰色禁用 + tooltip 提示，避免点击
                跳到 404 页让运维误判"系统坏了"。 */}
            <ParentTraceButton
              parentTraceId={
                trace.metadata && typeof trace.metadata.parent_trace_id === 'string'
                  ? (trace.metadata.parent_trace_id as string)
                  : null
              }
              navigate={navigate}
            />
          </div>

          {/* 右侧：关联信息 */}
          <div className="flex items-center gap-4 text-body text-muted-foreground">
            {trace.user_id && (
              <div className="flex items-center gap-1">
                <User className="h-3 w-3" />
                <span className="font-mono">{trace.user_id.substring(0, 8)}</span>
              </div>
            )}
            {trace.thread_id && (
              <div className="flex items-center gap-1">
                <MessageSquare className="h-3 w-3" />
                <span className="font-mono">{trace.thread_id.substring(0, 8)}</span>
              </div>
            )}
          </div>
        </div>

        {/* 错误信息 */}
        {trace.error && (
          <div className="mt-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2">
            <div className="flex items-center gap-2">
              <AlertCircle className="h-3 w-3 text-destructive" />
              <span className="text-body text-destructive">{trace.error}</span>
            </div>
          </div>
        )}
        {errorEvents.length > 0 && (
          <div className="mt-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-2 text-body text-warning">
            Trace 内包含 {errorEvents.length} 个事件错误，可在左侧事件列表筛选“仅错误”查看。
          </div>
        )}
      </div>

      {/* LH2-A1（H3-C）：本父 trace 派生的子 Agent traces 卡片列表。
          没有子 Agent 调用时不渲染（组件内部已防御）。 */}
      <SubagentTracesSection events={events} />

      {/* Tab 栏 */}
      <div className="border-b bg-background px-6">
        <div className="flex gap-1">
          {[
            {
              key: 'overview' as DetailTab,
              label: '运营概览',
              icon: <MessageSquare className="h-3.5 w-3.5" />,
            },
            ...(activeTab !== 'overview'
              ? [
                  {
                    key: 'events' as DetailTab,
                    label: '原始事件',
                    icon: <Layers className="h-3.5 w-3.5" />,
                  },
                  {
                    key: 'prompts' as DetailTab,
                    label: '模型请求',
                    icon: <FileText className="h-3.5 w-3.5" />,
                  },
                  {
                    key: 'middleware' as DetailTab,
                    label: '性能明细',
                    icon: <Timer className="h-3.5 w-3.5" />,
                  },
                ]
              : []),
            ...(errorEvents.length > 0 || activeTab === 'errors'
              ? [
                  {
                    key: 'errors' as DetailTab,
                    label: '失败原因',
                    icon: <AlertCircle className="h-3.5 w-3.5" />,
                    count: errorEvents.length,
                  },
                ]
              : []),
          ].map((tab) => (
            <button
              key={tab.key}
              type="button"
              className={`flex items-center gap-1.5 px-3 py-2 text-body border-b-2 transition-colors ${
                activeTab === tab.key
                  ? 'border-primary text-primary font-medium'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
              onClick={() => setActiveTab(tab.key)}
            >
              {tab.icon}
              {tab.label}
              {'count' in tab && (tab.count ?? 0) > 0 && (
                <span className="ml-1 px-1.5 py-0.5 text-body rounded-full bg-destructive/10 text-destructive">
                  {tab.count}
                </span>
              )}
            </button>
          ))}
        </div>
      </div>

      {/* 主内容区 */}
      <div className="flex-1 overflow-hidden">
        {activeTab === 'overview' && <TraceOperationsOverview trace={trace} events={events} />}
        {activeTab === 'events' && (
          <ResizablePanel
            leftPanel={
              <EventTimeline
                events={events}
                selectedEventId={selectedEventId}
                onSelectEvent={setSelectedEventId}
              />
            }
            rightPanel={<EventDetailsPanel event={selectedEvent} previousEvent={previousEvent} />}
            defaultLeftWidth={30}
            minLeftWidth={20}
            maxLeftWidth={50}
          />
        )}
        {activeTab === 'prompts' && traceId && (
          <div className="h-full overflow-auto p-6">
            <PromptInspector traceId={traceId} />
          </div>
        )}
        {activeTab === 'middleware' && traceId && (
          <div className="h-full overflow-auto p-6">
            <MiddlewareTimeline traceId={traceId} />
          </div>
        )}
        {activeTab === 'errors' && traceId && (
          <div className="h-full overflow-auto p-6">
            <ErrorPanel traceId={traceId} />
          </div>
        )}
      </div>
    </div>
  )
}
