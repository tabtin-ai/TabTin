import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { ScrollArea } from '@/components/ui/scroll-area'
import { useAgentDebugStore } from '@/stores/agent-debug-store'
import type { Trace, TraceFilter, TraceStatus } from '@/types/agent-debug'
import {
  ChevronRight,
  Cloud,
  Cpu,
  Layers,
  MessageSquare,
  RefreshCw,
  Search,
  Table,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'

// H2-A FR-10：本地 Runtime trace 与云端 TinAgent trace 的运行环境维度。
// AdminDash 列表默认会混合本地 / 云端 trace，运维需要快速区分。
// 判定依据：
//   - 本地：graph_type === 'local-runtime' 或 metadata.runtime === 'local'
//     （双重保险——任一命中即视为本地）
//   - 云端：其余（'tin' / 'scheduler' / 等）
// 'all' 是默认值，不过滤。
type RuntimeFilter = 'all' | 'local' | 'cloud'

function getTraceRuntime(trace: Trace): 'local' | 'cloud' {
  if (trace.graph_type === 'local-runtime') return 'local'
  const meta = trace.metadata as { runtime?: unknown } | null | undefined
  if (meta && typeof meta.runtime === 'string' && meta.runtime === 'local') return 'local'
  return 'cloud'
}

// Graph 类型图标映射
const graphIcons: Record<string, React.ReactNode> = {
  tin: <Table className="h-4 w-4" />,
}

// 状态标签变体映射
const statusVariants: Record<TraceStatus, 'success' | 'default' | 'destructive'> = {
  completed: 'success',
  running: 'default',
  error: 'destructive',
}

const statusDotClasses: Record<TraceStatus, string> = {
  completed: 'bg-success',
  running: 'bg-info animate-pulse',
  error: 'bg-destructive',
}

// 格式化时间
function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diff = now.getTime() - date.getTime()

  if (diff < 60000) return 'Just now'
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`

  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
}

// 格式化耗时
function formatDuration(ms: number | null): string {
  if (ms === null) return '-'
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function TraceListPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const { traces, tracesNextCursor, tracesLoading, tracesError, filters, loadTraces, setFilters } =
    useAgentDebugStore()

  const initialThreadParam = searchParams.get('thread') || ''
  const initialRuntimeParam = (searchParams.get('runtime') as RuntimeFilter | null) || 'all'
  const [searchKeyword, setSearchKeyword] = useState(initialThreadParam)
  const [autoRefresh, setAutoRefresh] = useState(false)
  const [initialized, setInitialized] = useState(false) // ⭐ 新增：防止重复加载
  const [groupByThread, setGroupByThread] = useState(true)
  // H2-A FR-10：runtime 过滤维度。默认 'all'，避免误改运维既有习惯；
  // URL ?runtime=local 可直达本地 Runtime trace 列表（用于截图、bug 报告等场景）。
  const [runtimeFilter, setRuntimeFilter] = useState<RuntimeFilter>(initialRuntimeParam)
  const [expandedThreads, setExpandedThreads] = useState<Record<string, boolean>>(
    initialThreadParam ? { [initialThreadParam]: true } : {}
  )

  // H2-A FR-10 P0 修复（运维 Review #2）：runtime filter 必须经服务端 graph_type 过滤，
  // 否则全量上线后云端 trace 暴涨会让单页 50 条全是云端 → 切「本地」显示 0 条 →
  // 运维误以为本地 trace 没进来。把 graph_type='local-runtime' 传给 API。
  // 'cloud' 暂不支持精确过滤（需要 graph_type__neq 或服务端枚举），fallback 仍是
  // 当前页前端过滤，并标记给运维知道（页脚提示）。
  //
  // H2-A 三视角 Review 后续修复（运维 Review #1 + #2）：
  // 关键词若是 thread_id（含 `chat-session-` 前缀）或 session_id（uuid 形态）
  // 直接传给后端做精确过滤，避免「以为在全库搜，实际只搜当前页 50 条」让 SRE
  // 在真实环境的 MTTR 演练失效（Review #1 提到的核心 5 min 卡点）。
  // 短前缀关键词仍走前端 filteredTraces.filter（兼容 trace_id 8 字符前缀习惯）。
  const buildFiltersForRuntime = useCallback(
    (runtime: RuntimeFilter, keyword?: string): TraceFilter => {
      const base: TraceFilter = { ...filters, cursor: undefined }
      base.thread_id = undefined
      base.session_id = undefined
      if (runtime === 'local') {
        base.graph_type = 'local-runtime'
      } else {
        base.graph_type = undefined
      }
      // 关键词解析：thread_id (`chat-session-{uuid}`) → API thread_id 精确；
      // 36 字符 UUID → 视为 trace_id（保留前端子串过滤）；
      // 其他 → 不传给后端，仅前端 keyword 过滤。
      const trimmed = keyword?.trim() ?? ''
      if (trimmed.startsWith('chat-session-') && trimmed.length > 'chat-session-'.length) {
        base.thread_id = trimmed
      } else if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(trimmed)) {
        // 完整 UUID 同时尝试 session_id 服务端过滤（trace_id 走详情页直链不走列表）
        base.session_id = trimmed
      }
      return base
    },
    [filters]
  )

  // 初始加载（只加载一次）
  useEffect(() => {
    if (initialized) {
      return
    }
    // 初始如果 URL 带 ?runtime=local 或 ?thread=...，直接用对应字段过滤拉
    void loadTraces(buildFiltersForRuntime(runtimeFilter, searchKeyword))
    setInitialized(true)
  }, [initialized, loadTraces, buildFiltersForRuntime, runtimeFilter, searchKeyword])

  // 从 URL thread 参数初始化筛选
  useEffect(() => {
    const threadParam = searchParams.get('thread')
    if (threadParam && threadParam !== searchKeyword) {
      setSearchKeyword(threadParam)
      setGroupByThread(true)
      setExpandedThreads((prev) => ({ ...prev, [threadParam]: true }))
    }
  }, [searchKeyword, searchParams])

  // 自动刷新（每 5 秒）
  useEffect(() => {
    if (!autoRefresh) return

    const interval = setInterval(() => {
      void loadTraces(buildFiltersForRuntime(runtimeFilter, searchKeyword))
    }, 5000)

    return () => clearInterval(interval)
  }, [autoRefresh, loadTraces, buildFiltersForRuntime, runtimeFilter, searchKeyword])

  // H2-A FR-10 P0 修复：切换 runtime filter 时重新拉数据（带 graph_type 服务端过滤）。
  const handleRuntimeFilterChange = useCallback(
    (next: RuntimeFilter) => {
      setRuntimeFilter(next)
      const nextFilters = buildFiltersForRuntime(next, searchKeyword)
      setFilters(nextFilters)
      void loadTraces(nextFilters)
    },
    [buildFiltersForRuntime, loadTraces, setFilters, searchKeyword]
  )

  // H2-A 三视角 Review 后续修复：搜索框「按 Enter 提交」触发后端服务端过滤，
  // 让 SRE 输入完整 thread_id / session_id 后能跨页精确定位（演练 1 的核心 5 min
  // 卡点）。短前缀 / 部分关键词仍依赖 onChange 触发的前端 filteredTraces 子串
  // 过滤——保留它对 trace_id 8 字符前缀习惯的便利。
  const handleSearchSubmit = useCallback(() => {
    const nextFilters = buildFiltersForRuntime(runtimeFilter, searchKeyword)
    setFilters(nextFilters)
    void loadTraces(nextFilters)
  }, [buildFiltersForRuntime, loadTraces, runtimeFilter, searchKeyword, setFilters])

  // 分页 - 加载下一页
  const handleNextPage = () => {
    if (tracesNextCursor !== null) {
      const newFilters = { ...filters, cursor: tracesNextCursor }
      setFilters(newFilters)
      loadTraces(newFilters)
    }
  }

  // 搜索（按 trace_id / session_id / thread_id）+ cloud 前端过滤
  // 'local' 已经在服务端 graph_type 过滤，本地 useMemo 仅做 keyword 收窄；
  // 'cloud' 因为没有 "graph_type !== 'local-runtime'" 服务端语义，仍前端过滤
  // （上线后云端 trace 远超本地，前端过滤量级可控）。
  const filteredTraces = useMemo(() => {
    let result = traces || []

    if (runtimeFilter === 'cloud') {
      result = result.filter((t) => getTraceRuntime(t) === 'cloud')
    }

    if (searchKeyword) {
      const kw = searchKeyword.toLowerCase()
      result = result.filter(
        (t) =>
          t.trace_id.toLowerCase().includes(kw) ||
          t.session_id?.toLowerCase().includes(kw) ||
          t.thread_id?.toLowerCase().includes(kw)
      )
    }

    return result
  }, [traces, searchKeyword, runtimeFilter])

  // H2-A FR-10：runtime 计数 — 当前页样本，仅参考用。
  // 真实运维需要"全库 runtime 计数"应走专门的 admindash 统计 API（未来工作）。
  const runtimeCounts = useMemo(() => {
    const all = traces || []
    let local = 0
    let cloud = 0
    for (const t of all) {
      if (getTraceRuntime(t) === 'local') local++
      else cloud++
    }
    return { all: all.length, local, cloud }
  }, [traces])

  // 分组（按 thread_id 或 session_id）
  const groupedTraces = useMemo(() => {
    if (!groupByThread) return []

    const map = new Map<
      string,
      {
        key: string
        threadId: string | null
        sessionId: string | null
        traces: typeof filteredTraces
        latestStartedAt: string
        firstStartedAt: string
        totalDurationMs: number
        statusStats: Record<TraceStatus, number>
      }
    >()

    for (const trace of filteredTraces) {
      const key = trace.thread_id || trace.session_id || trace.trace_id
      let group = map.get(key)
      if (!group) {
        group = {
          key,
          threadId: trace.thread_id,
          sessionId: trace.session_id,
          traces: [],
          latestStartedAt: trace.started_at,
          firstStartedAt: trace.started_at,
          totalDurationMs: 0,
          statusStats: { completed: 0, running: 0, error: 0 },
        }
        map.set(key, group)
      }

      group.traces.push(trace)
      if (new Date(trace.started_at).getTime() < new Date(group.firstStartedAt).getTime()) {
        group.firstStartedAt = trace.started_at
      }
      if (new Date(trace.started_at).getTime() > new Date(group.latestStartedAt).getTime()) {
        group.latestStartedAt = trace.started_at
      }
      if (trace.ended_at) {
        const durationMs = new Date(trace.ended_at).getTime() - new Date(trace.started_at).getTime()
        if (durationMs > 0) {
          group.totalDurationMs += durationMs
        }
      }
      group.statusStats[trace.status] += 1
    }

    return Array.from(map.values()).sort(
      (a, b) => new Date(b.latestStartedAt).getTime() - new Date(a.latestStartedAt).getTime()
    )
  }, [filteredTraces, groupByThread])

  const toggleThread = (key: string) => {
    setExpandedThreads((prev) => ({
      ...prev,
      [key]: !(prev[key] ?? true),
    }))
  }

  return (
    <div className="panel-container">
      {/* 顶部工具栏 */}
      <div className="flex h-14 items-center justify-between border-b px-6 bg-background">
        <div>
          <h1 className="text-title font-semibold">Agent Debugger</h1>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={autoRefresh ? 'border-primary' : ''}
          >
            <RefreshCw className={`mr-2 h-4 w-4 ${autoRefresh ? 'animate-spin' : ''}`} />
            {autoRefresh ? 'Auto Refresh' : 'Manual'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => loadTraces()} disabled={tracesLoading}>
            <RefreshCw className={`h-4 w-4 ${tracesLoading ? 'animate-spin' : ''}`} />
          </Button>
          <Button
            variant={groupByThread ? 'default' : 'outline'}
            size="sm"
            onClick={() => setGroupByThread(!groupByThread)}
          >
            <MessageSquare className="mr-2 h-4 w-4" />
            {groupByThread ? '按会话分组' : '按 Trace'}
          </Button>
        </div>
      </div>

      {/* 筛选栏 */}
      <div className="flex items-center gap-3 border-b bg-muted/10 px-6 py-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Trace ID 子串过滤当前页，按 Enter 用 Thread/Session ID 全库精确搜索"
            className="pl-9"
            value={searchKeyword}
            onChange={(e) => setSearchKeyword(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                handleSearchSubmit()
              }
            }}
          />
        </div>

        {/* H2-A FR-10：runtime 维度过滤 — 区分本地 Runtime / 云端 TinAgent / scheduler。
            'local' 经服务端 graph_type='local-runtime' 精确过滤；'cloud' 因后端无 neq 语义
            走前端过滤当前页（未来加 graph_type__in 服务端过滤）。 */}
        <div className="flex items-center gap-1 rounded-md border bg-background p-0.5">
          <Button
            variant={runtimeFilter === 'all' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => handleRuntimeFilterChange('all')}
            className="h-7 text-body"
          >
            <Layers className="mr-1 h-3.5 w-3.5" />
            全部
            <span className="ml-1.5 text-caption text-muted-foreground">{runtimeCounts.all}</span>
          </Button>
          <Button
            variant={runtimeFilter === 'local' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => handleRuntimeFilterChange('local')}
            className="h-7 text-body"
            title="本地 Runtime（Electron / Daemon）— 经服务端 graph_type 精确过滤"
          >
            <Cpu className="mr-1 h-3.5 w-3.5" />
            本地
            <span className="ml-1.5 text-caption text-muted-foreground">{runtimeCounts.local}</span>
          </Button>
          <Button
            variant={runtimeFilter === 'cloud' ? 'default' : 'ghost'}
            size="sm"
            onClick={() => handleRuntimeFilterChange('cloud')}
            className="h-7 text-body"
            title="云端（TinAgent / Scheduler 等）— 当前页前端过滤"
          >
            <Cloud className="mr-1 h-3.5 w-3.5" />
            云端
            <span className="ml-1.5 text-caption text-muted-foreground">{runtimeCounts.cloud}</span>
          </Button>
        </div>
      </div>

      {/* Trace 列表 */}
      <div className="flex-1 overflow-hidden">
        {tracesError ? (
          <div className="flex h-full items-center justify-center text-destructive">
            <p>Error: {tracesError}</p>
          </div>
        ) : filteredTraces.length === 0 && !tracesLoading ? (
          <div className="flex h-full flex-col items-center justify-center text-muted-foreground">
            <Layers className="h-12 w-12 mb-4 opacity-20" />
            <p>No traces found</p>
          </div>
        ) : (
          <ScrollArea className="h-full">
            <div className="divide-y">
              {groupByThread
                ? groupedTraces.map((group) => {
                    const isExpanded = expandedThreads[group.key] ?? true
                    const orderedTraces = [...group.traces].sort(
                      (a, b) => new Date(a.started_at).getTime() - new Date(b.started_at).getTime()
                    )
                    return (
                      <div key={group.key} className="border-b last:border-b-0">
                        <button
                          type="button"
                          onClick={() => toggleThread(group.key)}
                          className="w-full px-6 py-3 text-left hover:bg-muted/20 transition-colors cursor-pointer"
                        >
                          <div className="flex items-center justify-between gap-4">
                            <div className="flex items-center gap-3">
                              <ChevronRight
                                className={`h-4 w-4 text-muted-foreground transition-transform ${
                                  isExpanded ? 'rotate-90' : ''
                                }`}
                              />
                              <div className="flex items-center gap-2">
                                <span className="font-mono text-body text-muted-foreground">
                                  {group.threadId ? group.threadId.substring(0, 10) : 'unknown'}...
                                </span>
                                <Badge variant="outline" className="text-body">
                                  {group.traces.length} traces
                                </Badge>
                                {group.statusStats.error > 0 && (
                                  <Badge variant="destructive" className="text-body">
                                    {group.statusStats.error} error
                                  </Badge>
                                )}
                                {group.statusStats.running > 0 && (
                                  <Badge variant="default" className="text-body">
                                    {group.statusStats.running} running
                                  </Badge>
                                )}
                              </div>
                            </div>
                            <div className="text-body text-muted-foreground">
                              {formatTime(group.latestStartedAt)}
                            </div>
                          </div>
                          <div className="mt-1 flex flex-wrap items-center gap-3 text-body text-muted-foreground">
                            {group.threadId && <span>Thread: {group.threadId}</span>}
                            {group.sessionId && <span>Session: {group.sessionId}</span>}
                            <span>
                              时段: {formatTime(group.firstStartedAt)} →{' '}
                              {formatTime(group.latestStartedAt)}
                            </span>
                            <span>
                              总耗时:{' '}
                              {group.totalDurationMs > 0
                                ? formatDuration(group.totalDurationMs)
                                : '进行中'}
                            </span>
                          </div>
                        </button>

                        {/* Thread 级别时间轴 */}
                        {orderedTraces.length > 0 && (
                          <div className="mt-2 flex items-center gap-2 overflow-x-auto pb-1 px-6">
                            {orderedTraces.map((trace, index) => (
                              <div key={trace.trace_id} className="flex items-center">
                                <button
                                  type="button"
                                  onClick={() => navigate(`/trace/${trace.trace_id}`)}
                                  title={`#${index + 1} ${trace.trace_id} (${trace.status})`}
                                  className="group flex items-center cursor-pointer"
                                >
                                  <span
                                    className={`h-2.5 w-2.5 rounded-full ${statusDotClasses[trace.status]}`}
                                  />
                                  <span className="ml-1 text-caption text-muted-foreground group-hover:text-foreground">
                                    {index + 1}
                                  </span>
                                </button>
                                {index < orderedTraces.length - 1 && (
                                  <div className="mx-2 h-px w-10 bg-border" />
                                )}
                              </div>
                            ))}
                          </div>
                        )}

                        {isExpanded && (
                          <div className="border-l border-border/50 ml-6">
                            {group.traces.map((trace) => (
                              <button
                                type="button"
                                key={trace.trace_id}
                                onClick={() => navigate(`/trace/${trace.trace_id}`)}
                                className="w-full px-6 py-4 text-left hover:bg-muted/30 transition-colors group"
                              >
                                <div className="flex items-start justify-between gap-4">
                                  {/* 左侧：图标 + 信息 */}
                                  <div className="flex items-start gap-3 flex-1">
                                    <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                                      {graphIcons[trace.graph_type] || (
                                        <Layers className="h-4 w-4" />
                                      )}
                                    </div>
                                    <div className="flex-1 min-w-0">
                                      <div className="flex items-center gap-2 mb-1">
                                        <span className="font-mono text-body font-medium text-muted-foreground">
                                          {trace.trace_id.substring(0, 8)}...
                                        </span>
                                        <Badge
                                          variant={statusVariants[trace.status]}
                                          className="uppercase"
                                        >
                                          {trace.status}
                                        </Badge>
                                        <Badge
                                          variant="outline"
                                          className="text-caption gap-1 px-1.5 py-0"
                                          title={
                                            getTraceRuntime(trace) === 'local'
                                              ? '本地 Runtime'
                                              : '云端'
                                          }
                                        >
                                          {getTraceRuntime(trace) === 'local' ? (
                                            <Cpu className="h-3 w-3" />
                                          ) : (
                                            <Cloud className="h-3 w-3" />
                                          )}
                                          {getTraceRuntime(trace) === 'local' ? '本地' : '云端'}
                                        </Badge>
                                        <span className="text-body text-muted-foreground capitalize">
                                          {trace.graph_type}
                                        </span>
                                      </div>
                                      {trace.metadata && (
                                        <p className="text-body line-clamp-2">
                                          {JSON.stringify(trace.metadata).substring(0, 100)}...
                                        </p>
                                      )}
                                      <div className="flex items-center gap-4 mt-2 text-body text-muted-foreground">
                                        {trace.session_id && (
                                          <span>Session: {trace.session_id.substring(0, 8)}</span>
                                        )}
                                        {trace.user_id && <span>User: {trace.user_id}</span>}
                                      </div>
                                    </div>
                                  </div>

                                  {/* 右侧：时间和耗时 */}
                                  <div className="text-right text-body">
                                    <p className="font-medium">
                                      {trace.ended_at
                                        ? formatDuration(
                                            new Date(trace.ended_at).getTime() -
                                              new Date(trace.started_at).getTime()
                                          )
                                        : 'Running...'}
                                    </p>
                                    <p className="text-muted-foreground mt-1">
                                      {formatTime(trace.started_at)}
                                    </p>
                                  </div>
                                </div>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })
                : filteredTraces.map((trace) => (
                    <button
                      type="button"
                      key={trace.trace_id}
                      onClick={() => navigate(`/trace/${trace.trace_id}`)}
                      className="w-full px-6 py-4 text-left hover:bg-muted/30 transition-colors group"
                    >
                      <div className="flex items-start justify-between gap-4">
                        {/* 左侧：图标 + 信息 */}
                        <div className="flex items-start gap-3 flex-1">
                          <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10 text-primary group-hover:bg-primary group-hover:text-primary-foreground transition-colors">
                            {graphIcons[trace.graph_type] || <Layers className="h-4 w-4" />}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2 mb-1">
                              <span className="font-mono text-body font-medium text-muted-foreground">
                                {trace.trace_id.substring(0, 8)}...
                              </span>
                              <Badge variant={statusVariants[trace.status]} className="uppercase">
                                {trace.status}
                              </Badge>
                              <Badge
                                variant="outline"
                                className="text-caption gap-1 px-1.5 py-0"
                                title={getTraceRuntime(trace) === 'local' ? '本地 Runtime' : '云端'}
                              >
                                {getTraceRuntime(trace) === 'local' ? (
                                  <Cpu className="h-3 w-3" />
                                ) : (
                                  <Cloud className="h-3 w-3" />
                                )}
                                {getTraceRuntime(trace) === 'local' ? '本地' : '云端'}
                              </Badge>
                              <span className="text-body text-muted-foreground capitalize">
                                {trace.graph_type}
                              </span>
                            </div>
                            {trace.metadata && (
                              <p className="text-body line-clamp-2">
                                {JSON.stringify(trace.metadata).substring(0, 100)}...
                              </p>
                            )}
                            <div className="flex items-center gap-4 mt-2 text-body text-muted-foreground">
                              {trace.session_id && (
                                <span>Session: {trace.session_id.substring(0, 8)}</span>
                              )}
                              {trace.user_id && <span>User: {trace.user_id}</span>}
                            </div>
                          </div>
                        </div>

                        {/* 右侧：时间和耗时 */}
                        <div className="text-right text-body">
                          <p className="font-medium">
                            {trace.ended_at
                              ? formatDuration(
                                  new Date(trace.ended_at).getTime() -
                                    new Date(trace.started_at).getTime()
                                )
                              : 'Running...'}
                          </p>
                          <p className="text-muted-foreground mt-1">
                            {formatTime(trace.started_at)}
                          </p>
                        </div>
                      </div>
                    </button>
                  ))}
            </div>
          </ScrollArea>
        )}
      </div>

      {/* 分页栏 */}
      <div className="flex h-12 items-center justify-between border-t px-6 bg-muted/10 text-body">
        <div className="text-muted-foreground">
          {groupByThread
            ? `Showing ${groupedTraces.length} thread(s) · ${filteredTraces.length} trace(s)`
            : `Showing ${filteredTraces.length} trace${filteredTraces.length !== 1 ? 's' : ''}`}
        </div>
        <div className="flex items-center gap-2">
          {tracesNextCursor !== null && (
            <Button variant="outline" size="sm" onClick={handleNextPage} disabled={tracesLoading}>
              Load More
              <ChevronRight className="h-4 w-4 ml-1" />
            </Button>
          )}
        </div>
      </div>
    </div>
  )
}
