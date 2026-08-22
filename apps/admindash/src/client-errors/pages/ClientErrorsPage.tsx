/**
 * 客户端错误监控面板
 *
 * 功能：统计概览 + 错误分组列表 + 分组详情（堆栈/事件/面包屑）
 */

import { PageSizeSelect } from '@/components/ui/pagination'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import {
  AlertCircle,
  ArrowDown,
  ArrowUp,
  Bug,
  ChevronLeft,
  Clock,
  Copy,
  Filter,
  Monitor,
  Package,
  RefreshCw,
  Search,
  Users,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'
import {
  type ErrorEventItem,
  type ErrorGroupDetail,
  type ErrorGroupItem,
  type ErrorStats,
  type Pagination,
  type ReleaseDetail,
  type ReleaseItem,
  batchUpdateGroupStatus,
  fetchErrorGroupDetail,
  fetchErrorGroups,
  fetchErrorStats,
  fetchEventDetail,
  fetchGroupEvents,
  fetchReleaseDetail,
  fetchReleases,
  updateGroupStatus,
} from '../api/client-errors'
import {
  buildEventDiagnosticMarkdown,
  buildGroupDiagnosticMarkdown,
  copyToClipboard,
  formatLocalTime,
} from '../utils/format'

// ── Stat Card ──

function StatCard({
  label,
  value,
  icon: Icon,
  color = 'text-foreground',
}: {
  label: string
  value: string | number
  icon: React.ElementType
  color?: string
}) {
  return (
    <div className="rounded-lg border bg-card p-4">
      <div className="flex items-center gap-2 text-body text-muted-foreground mb-1">
        <Icon className="h-3.5 w-3.5" />
        {label}
      </div>
      <div className={`text-heading font-bold ${color}`}>{value}</div>
    </div>
  )
}

// ── Status Badge ──

const STATUS_CONFIG: Record<string, { label: string; className: string }> = {
  open: {
    label: '待处理',
    className: 'bg-destructive/10 text-destructive dark:bg-destructive/10 dark:text-destructive',
  },
  confirmed: {
    label: '已确认',
    className: 'bg-warning/10 text-warning dark:bg-warning/10 dark:text-warning',
  },
  resolved: {
    label: '已修复',
    className: 'bg-success/10 text-success dark:bg-success/10 dark:text-success',
  },
  ignored: {
    label: '已忽略',
    className: 'bg-muted text-muted-foreground dark:bg-muted dark:text-muted-foreground',
  },
}

function StatusBadge({ status }: { status: string }) {
  const config = STATUS_CONFIG[status] || STATUS_CONFIG.open
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-body font-medium ${config.className}`}
    >
      {config.label}
    </span>
  )
}

const LEVEL_COLORS: Record<string, string> = {
  fatal: 'text-destructive dark:text-destructive',
  error: 'text-warning dark:text-warning',
  warning: 'text-warning dark:text-warning',
}

// ── Trend Chart (simple) ──

function TrendChart({ data }: { data: { time: string; count: number }[] }) {
  if (!data.length) return <div className="text-body text-muted-foreground">暂无数据</div>

  const max = Math.max(...data.map((d) => d.count), 1)
  return (
    <div className="flex items-end gap-0.5 h-16">
      {data.map((d) => (
        <div
          key={d.time}
          className="flex-1 bg-primary/70 rounded-t-sm min-w-[3px] transition-all hover:bg-primary"
          style={{ height: `${(d.count / max) * 100}%` }}
          title={`${d.time.slice(0, 16)}: ${d.count} 条`}
        />
      ))}
    </div>
  )
}

// ── Main Page ──

export function ClientErrorsPage() {
  const { show: showToast, element: toastElement } = useSimpleToast()

  // 统计
  const [stats, setStats] = useState<ErrorStats | null>(null)
  const [statHours, setStatHours] = useState(24)

  // 列表
  const [groups, setGroups] = useState<ErrorGroupItem[]>([])
  const [pagination, setPagination] = useState<Pagination>({
    total: 0,
    page: 1,
    page_size: 20,
    total_pages: 0,
  })
  const [groupsPageSize, setGroupsPageSize] = useState(20)
  const [filterStatus, setFilterStatus] = useState('all')
  const [filterLevel, setFilterLevel] = useState('all')
  const [keyword, setKeyword] = useState('')
  const [searchInput, setSearchInput] = useState('')

  // 详情
  const [selectedGroup, setSelectedGroup] = useState<ErrorGroupDetail | null>(null)
  const [groupEvents, setGroupEvents] = useState<ErrorEventItem[]>([])
  const [eventPagination, setEventPagination] = useState<Pagination>({
    total: 0,
    page: 1,
    page_size: 20,
    total_pages: 0,
  })
  const [eventsPageSize, setEventsPageSize] = useState(20)
  const [selectedEvent, setSelectedEvent] = useState<ErrorEventItem | null>(null)

  const [loading, setLoading] = useState(false)

  // 批量选择
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())

  // 自动刷新
  const [autoRefresh, setAutoRefresh] = useState(false)

  // Tab: 'errors' | 'releases'
  const [activeTab, setActiveTab] = useState<'errors' | 'releases'>('errors')

  // Release
  const [releases, setReleases] = useState<ReleaseItem[]>([])
  const [releasePagination, setReleasePagination] = useState<Pagination>({
    total: 0,
    page: 1,
    page_size: 20,
    total_pages: 0,
  })
  const [releasesPageSize, setReleasesPageSize] = useState(20)
  const [selectedRelease, setSelectedRelease] = useState<ReleaseDetail | null>(null)

  // ── 加载统计 ──
  const loadStats = useCallback(async () => {
    try {
      const data = await fetchErrorStats(statHours)
      setStats(data)
    } catch (e) {
      console.error('加载统计失败:', e)
    }
  }, [statHours])

  // ── 加载分组列表 ──
  const loadGroups = useCallback(
    async (page = 1, pageSize = groupsPageSize) => {
      setLoading(true)
      try {
        const data = await fetchErrorGroups({
          status: filterStatus !== 'all' ? filterStatus : undefined,
          level: filterLevel !== 'all' ? filterLevel : undefined,
          keyword: keyword || undefined,
          page,
          page_size: pageSize,
        })
        setGroups(data.items)
        setPagination(data.pagination)
      } catch (e) {
        console.error('加载错误列表失败:', e)
      } finally {
        setLoading(false)
      }
    },
    [filterStatus, filterLevel, keyword, groupsPageSize]
  )

  useEffect(() => {
    loadStats()
  }, [loadStats])
  useEffect(() => {
    loadGroups(1)
  }, [loadGroups])

  // ── 自动刷新 ──
  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => {
      loadStats()
      loadGroups(pagination.page, groupsPageSize)
    }, 30000)
    return () => clearInterval(timer)
  }, [autoRefresh, loadStats, loadGroups, pagination.page, groupsPageSize])

  // ── 加载 Release 列表 ──
  const loadReleases = useCallback(
    async (page = 1, pageSize = releasesPageSize) => {
      try {
        const data = await fetchReleases({ page, page_size: pageSize })
        setReleases(data.items)
        setReleasePagination(data.pagination)
      } catch (e) {
        console.error('加载版本列表失败:', e)
      }
    },
    [releasesPageSize]
  )

  useEffect(() => {
    if (activeTab === 'releases') loadReleases(1)
  }, [activeTab, loadReleases])

  const openRelease = async (version: string) => {
    try {
      const detail = await fetchReleaseDetail(version)
      setSelectedRelease(detail)
    } catch (e) {
      console.error('加载版本详情失败:', e)
    }
  }

  // ── 加载分组事件 ──
  const loadGroupEvents = useCallback(
    async (groupId: number, page: number, pageSize = eventsPageSize) => {
      try {
        const data = await fetchGroupEvents(groupId, { page, page_size: pageSize })
        setGroupEvents(data.items)
        setEventPagination(data.pagination)
      } catch (e) {
        console.error('加载事件列表失败:', e)
      }
    },
    [eventsPageSize]
  )

  // ── 查看分组详情 ──
  const openGroup = async (groupId: number) => {
    try {
      const [detail] = await Promise.all([
        fetchErrorGroupDetail(groupId),
        loadGroupEvents(groupId, 1, eventsPageSize),
      ])
      setSelectedGroup(detail)
      setSelectedEvent(null)
    } catch (e) {
      console.error('加载详情失败:', e)
    }
  }

  // ── 查看事件详情 ──
  const openEvent = async (eventId: number) => {
    try {
      const detail = await fetchEventDetail(eventId)
      setSelectedEvent(detail)
    } catch (e) {
      console.error('加载事件详情失败:', e)
    }
  }

  // ── 批量更新状态 ──
  const handleBatchStatus = async (newStatus: string) => {
    try {
      await batchUpdateGroupStatus(Array.from(selectedIds), newStatus)
      setSelectedIds(new Set())
      loadGroups(pagination.page, groupsPageSize)
    } catch (e) {
      console.error('批量操作失败:', e)
    }
  }

  // ── 更新状态 ──
  const handleStatusChange = async (groupId: number, newStatus: string) => {
    try {
      await updateGroupStatus(groupId, newStatus)
      if (selectedGroup?.id === groupId) {
        setSelectedGroup((prev) => (prev ? { ...prev, status: newStatus } : null))
      }
      loadGroups(pagination.page, groupsPageSize)
    } catch (e) {
      console.error('更新状态失败:', e)
    }
  }

  // ── 复制现场（Markdown 格式，方便发给同事 / AI）──
  const handleCopyGroup = async () => {
    if (!selectedGroup) return
    const md = buildGroupDiagnosticMarkdown(selectedGroup, groupEvents)
    const ok = await copyToClipboard(md)
    showToast(
      ok ? `已复制分组现场 (${md.length} 字符)` : '复制失败：浏览器禁止访问剪贴板',
      ok ? 'success' : 'error'
    )
  }

  const handleCopyEvent = async () => {
    if (!selectedEvent) return
    const md = buildEventDiagnosticMarkdown(selectedEvent)
    const ok = await copyToClipboard(md)
    showToast(
      ok ? `已复制事件现场 (${md.length} 字符)` : '复制失败：浏览器禁止访问剪贴板',
      ok ? 'success' : 'error'
    )
  }

  // ── Release 详情视图 ──
  if (selectedRelease) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center gap-3 border-b px-6 py-3">
          <button
            type="button"
            onClick={() => setSelectedRelease(null)}
            className="p-1 hover:bg-muted rounded-md"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <Package className="h-4 w-4 text-primary" />
          <h2 className="text-body font-semibold">v{selectedRelease.app_version}</h2>
        </div>
        <div className="flex-1 overflow-y-auto p-6 space-y-6">
          {/* 版本概况 */}
          <div className="grid grid-cols-4 gap-3">
            <StatCard
              label="错误事件"
              value={selectedRelease.event_count}
              icon={Bug}
              color="text-destructive dark:text-destructive"
            />
            <StatCard
              label="新增错误类型"
              value={selectedRelease.new_group_count}
              icon={AlertCircle}
              color="text-warning dark:text-warning"
            />
            <StatCard label="影响用户" value={selectedRelease.user_count} icon={Users} />
            <div className="rounded-lg border bg-card p-4">
              <div className="flex items-center gap-2 text-body text-muted-foreground mb-1">
                <Clock className="h-3.5 w-3.5" />
                活跃时段
              </div>
              <div className="text-body text-muted-foreground">
                <div>{formatLocalTime(selectedRelease.first_seen).slice(0, 10)}</div>
                <div>至 {formatLocalTime(selectedRelease.last_seen).slice(0, 10)}</div>
              </div>
            </div>
          </div>

          {/* 按级别分布 */}
          {selectedRelease.by_level && Object.keys(selectedRelease.by_level).length > 0 && (
            <div className="rounded-lg border bg-card p-4">
              <div className="text-body text-muted-foreground mb-2">错误级别分布</div>
              <div className="flex gap-4">
                {Object.entries(selectedRelease.by_level).map(([level, count]) => (
                  <div key={level} className="flex items-center gap-2">
                    <span className={`text-body font-medium ${LEVEL_COLORS[level] || ''}`}>
                      {level.toUpperCase()}
                    </span>
                    <span className="text-body font-bold">{count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* 该版本引入的新错误 */}
          <div>
            <h3 className="text-body font-semibold text-muted-foreground mb-2">
              该版本引入的新错误 ({selectedRelease.new_groups.length})
            </h3>
            {selectedRelease.new_groups.length === 0 ? (
              <div className="text-body text-muted-foreground py-4 text-center border rounded-md">
                该版本没有引入新错误
              </div>
            ) : (
              <div className="space-y-1">
                {selectedRelease.new_groups.map((g) => (
                  <button
                    key={g.id}
                    type="button"
                    onClick={() => {
                      setSelectedRelease(null)
                      openGroup(g.id)
                    }}
                    className="w-full text-left rounded-md border px-4 py-2.5 text-body hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 flex-1 min-w-0">
                        <StatusBadge status={g.status} />
                        <span className={`font-medium ${LEVEL_COLORS[g.level] || ''}`}>
                          {g.level.toUpperCase()}
                        </span>
                        <span className="truncate">{g.title}</span>
                      </div>
                      <div className="text-muted-foreground shrink-0 ml-3">
                        {g.event_count} 次 · {g.user_count} 用户
                      </div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    )
  }

  // ── 错误分组详情视图 ──
  if (selectedGroup) {
    return (
      <div className="flex h-full flex-col">
        {/* 头部 */}
        <div className="flex items-center gap-3 border-b px-6 py-3">
          <button
            type="button"
            onClick={() => {
              setSelectedGroup(null)
              setSelectedEvent(null)
            }}
            className="p-1 hover:bg-muted rounded-md"
          >
            <ChevronLeft className="h-4 w-4" />
          </button>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <StatusBadge status={selectedGroup.status} />
              <span className={`text-body font-medium ${LEVEL_COLORS[selectedGroup.level] || ''}`}>
                {selectedGroup.level.toUpperCase()}
              </span>
            </div>
            <h2 className="text-body font-medium mt-1 truncate">{selectedGroup.title}</h2>
          </div>
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={handleCopyGroup}
              className="flex items-center gap-1 px-2 py-1 text-body rounded-md border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors mr-1"
              title="把整组错误现场（含组件栈、堆栈、最近事件列表）打包成 Markdown 复制到剪贴板，便于发给同事或 AI"
            >
              <Copy className="h-3.5 w-3.5" />
              复制现场
            </button>
            {Object.entries(STATUS_CONFIG).map(([key, cfg]) => (
              <button
                key={key}
                type="button"
                onClick={() => handleStatusChange(selectedGroup.id, key)}
                disabled={selectedGroup.status === key}
                className={`px-2 py-1 text-body rounded-md border transition-colors ${
                  selectedGroup.status === key
                    ? 'bg-primary text-primary-foreground'
                    : 'hover:bg-muted text-muted-foreground'
                }`}
              >
                {cfg.label}
              </button>
            ))}
          </div>
        </div>

        <div className="flex flex-1 overflow-hidden">
          {/* 左侧：堆栈 + 事件列表 */}
          <div className="flex-1 overflow-y-auto p-6 space-y-4 border-r">
            {/* 统计 */}
            <div className="flex gap-4 text-body text-muted-foreground">
              <span>
                出现 <strong className="text-foreground">{selectedGroup.event_count}</strong> 次
              </span>
              <span>
                影响 <strong className="text-foreground">{selectedGroup.user_count}</strong> 用户
              </span>
              <span>版本 {selectedGroup.sample_app_version || '-'}</span>
              <span>首次 {formatLocalTime(selectedGroup.first_seen)}</span>
              <span>最近 {formatLocalTime(selectedGroup.last_seen)}</span>
            </div>

            {/* React 组件栈（如果有，比 JS 堆栈更能直接定位 React 渲染类错误） */}
            {selectedGroup.sample_component_stack && (
              <div>
                <h3 className="text-body font-semibold mb-2 text-muted-foreground flex items-center gap-2">
                  React 组件栈
                  <span className="text-caption font-normal text-muted-foreground/60">
                    定位崩溃所在的 React 组件树位置
                  </span>
                </h3>
                {selectedGroup.resolved_component_stack && (
                  <pre className="rounded-md border border-success/30 dark:border-success/30 bg-success/10 dark:bg-success/10 p-3 text-body overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed mb-2">
                    {selectedGroup.resolved_component_stack}
                  </pre>
                )}
                <details className={selectedGroup.resolved_component_stack ? '' : 'open'}>
                  <summary className="text-body text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                    {selectedGroup.resolved_component_stack ? '查看原始组件栈' : ''}
                  </summary>
                  <pre className="rounded-md border bg-muted/30 p-3 text-body overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed mt-1">
                    {selectedGroup.sample_component_stack}
                  </pre>
                </details>
              </div>
            )}

            {/* 堆栈 */}
            {selectedGroup.sample_stack_trace && (
              <div>
                <h3 className="text-body font-semibold mb-2 text-muted-foreground">
                  {selectedGroup.resolved_stack_trace ? '还原堆栈' : '堆栈信息'}
                </h3>
                {selectedGroup.resolved_stack_trace && (
                  <pre className="rounded-md border border-success/30 dark:border-success/30 bg-success/10 dark:bg-success/10 p-3 text-body overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed mb-2">
                    {selectedGroup.resolved_stack_trace}
                  </pre>
                )}
                <details className={selectedGroup.resolved_stack_trace ? '' : 'open'}>
                  <summary className="text-body text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                    {selectedGroup.resolved_stack_trace ? '查看原始堆栈' : ''}
                  </summary>
                  <pre className="rounded-md border bg-muted/30 p-3 text-body overflow-x-auto whitespace-pre-wrap font-mono leading-relaxed mt-1">
                    {selectedGroup.sample_stack_trace}
                  </pre>
                </details>
              </div>
            )}

            {/* 事件列表 */}
            <div>
              <h3 className="text-body font-semibold mb-2 text-muted-foreground">
                事件记录 ({eventPagination.total})
              </h3>
              <div className="space-y-1">
                {groupEvents.map((ev) => (
                  <button
                    key={ev.id}
                    type="button"
                    onClick={() => openEvent(ev.id)}
                    className={`w-full text-left rounded-md border px-3 py-2 text-body transition-colors ${
                      selectedEvent?.id === ev.id
                        ? 'border-primary bg-primary/5'
                        : 'hover:bg-muted/50'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-medium truncate flex-1">
                        {ev.error_type}: {ev.message.slice(0, 80)}
                      </span>
                      <span className="text-muted-foreground ml-2 shrink-0">
                        {formatLocalTime(ev.occurred_at)}
                      </span>
                    </div>
                    <div className="flex gap-3 mt-1 text-muted-foreground">
                      <span>{ev.source}</span>
                      <span>
                        {ev.os_name} {ev.arch}
                      </span>
                      <span>{ev.app_version || '-'}</span>
                      {ev.user_id && <span>user: {ev.user_id.slice(0, 8)}...</span>}
                    </div>
                  </button>
                ))}
              </div>
              {eventPagination.total > 0 && (
                <div className="flex items-center justify-center gap-2 text-body mt-3">
                  <PageSizeSelect
                    value={eventsPageSize}
                    onChange={(nextPageSize) => {
                      setEventsPageSize(nextPageSize)
                      setEventPagination((prev) => ({ ...prev, page: 1, page_size: nextPageSize }))
                      loadGroupEvents(selectedGroup.id, 1, nextPageSize)
                    }}
                  />
                  <button
                    type="button"
                    disabled={eventPagination.page <= 1}
                    onClick={() => loadGroupEvents(selectedGroup.id, eventPagination.page - 1)}
                    className="px-3 py-1 rounded-md border hover:bg-muted disabled:opacity-50"
                  >
                    上一页
                  </button>
                  <span className="text-muted-foreground">
                    {eventPagination.page} / {eventPagination.total_pages}
                  </span>
                  <button
                    type="button"
                    disabled={eventPagination.page >= eventPagination.total_pages}
                    onClick={() => loadGroupEvents(selectedGroup.id, eventPagination.page + 1)}
                    className="px-3 py-1 rounded-md border hover:bg-muted disabled:opacity-50"
                  >
                    下一页
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* 右侧：事件详情面板 */}
          {selectedEvent && (
            <div className="w-[400px] overflow-y-auto p-4 space-y-4">
              <div className="flex items-center justify-between">
                <h3 className="text-body font-semibold text-muted-foreground">
                  事件详情 #{selectedEvent.id}
                </h3>
                <button
                  type="button"
                  onClick={handleCopyEvent}
                  className="flex items-center gap-1 px-2 py-1 text-caption rounded-md border border-primary/40 bg-primary/5 text-primary hover:bg-primary/10 transition-colors"
                  title="把这条事件完整现场（含组件栈、堆栈、面包屑、设备信息）打包成 Markdown 复制到剪贴板"
                >
                  <Copy className="h-3 w-3" />
                  复制
                </button>
              </div>

              {/* 设备信息 */}
              <div className="space-y-1 text-body">
                <div className="font-semibold text-muted-foreground mb-1">设备信息</div>
                <div className="grid grid-cols-2 gap-1">
                  <span className="text-muted-foreground">操作系统</span>
                  <span>
                    {selectedEvent.os_name} {selectedEvent.os_version}
                  </span>
                  <span className="text-muted-foreground">架构</span>
                  <span>{selectedEvent.arch}</span>
                  <span className="text-muted-foreground">Electron</span>
                  <span>{selectedEvent.electron_version || '-'}</span>
                  <span className="text-muted-foreground">应用版本</span>
                  <span>{selectedEvent.app_version || '-'}</span>
                  <span className="text-muted-foreground">语言</span>
                  <span>{selectedEvent.locale || '-'}</span>
                  <span className="text-muted-foreground">来源进程</span>
                  <span>{selectedEvent.source}</span>
                  <span className="text-muted-foreground">用户ID</span>
                  <span className="truncate">{selectedEvent.user_id || '匿名'}</span>
                </div>
              </div>

              {/* React 组件栈：放在 JS 堆栈前面，作为 React 错误的主线索 */}
              {selectedEvent.component_stack && (
                <div>
                  <div className="text-body font-semibold text-muted-foreground mb-1">
                    React 组件栈
                  </div>
                  {selectedEvent.resolved_component_stack && (
                    <pre className="rounded-md border border-success/30 dark:border-success/30 bg-success/10 dark:bg-success/10 p-2 text-caption overflow-x-auto whitespace-pre-wrap font-mono max-h-48 mb-1">
                      {selectedEvent.resolved_component_stack}
                    </pre>
                  )}
                  <details className={selectedEvent.resolved_component_stack ? '' : 'open'}>
                    <summary className="text-body text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                      {selectedEvent.resolved_component_stack ? '查看原始组件栈' : ''}
                    </summary>
                    <pre className="rounded-md border bg-muted/30 p-2 text-caption overflow-x-auto whitespace-pre-wrap font-mono max-h-48 mt-1">
                      {selectedEvent.component_stack}
                    </pre>
                  </details>
                </div>
              )}

              {/* 堆栈 */}
              {selectedEvent.stack_trace && (
                <div>
                  <div className="text-body font-semibold text-muted-foreground mb-1">
                    {selectedEvent.resolved_stack_trace ? '还原堆栈' : '堆栈'}
                  </div>
                  {selectedEvent.resolved_stack_trace && (
                    <pre className="rounded-md border border-success/30 dark:border-success/30 bg-success/10 dark:bg-success/10 p-2 text-caption overflow-x-auto whitespace-pre-wrap font-mono max-h-48 mb-1">
                      {selectedEvent.resolved_stack_trace}
                    </pre>
                  )}
                  <details className={selectedEvent.resolved_stack_trace ? '' : 'open'}>
                    <summary className="text-body text-muted-foreground cursor-pointer hover:text-foreground transition-colors">
                      {selectedEvent.resolved_stack_trace ? '查看原始堆栈' : ''}
                    </summary>
                    <pre className="rounded-md border bg-muted/30 p-2 text-caption overflow-x-auto whitespace-pre-wrap font-mono max-h-48 mt-1">
                      {selectedEvent.stack_trace}
                    </pre>
                  </details>
                </div>
              )}

              {/* 面包屑 */}
              {selectedEvent.breadcrumbs && selectedEvent.breadcrumbs.length > 0 && (
                <div>
                  <div className="text-body font-semibold text-muted-foreground mb-1">
                    操作轨迹 ({selectedEvent.breadcrumbs.length})
                  </div>
                  <div className="space-y-0.5 max-h-60 overflow-y-auto">
                    {selectedEvent.breadcrumbs.map((b) => (
                      <div
                        key={`${b.timestamp ?? 'unknown'}-${b.type}-${b.message}`}
                        className="flex items-start gap-2 rounded px-2 py-1 text-caption hover:bg-muted/30"
                      >
                        <span className="shrink-0 rounded bg-muted px-1 py-0.5 font-mono text-caption">
                          {b.type}
                        </span>
                        <span className="flex-1 text-muted-foreground break-all">{b.message}</span>
                        <span className="shrink-0 text-muted-foreground/60">
                          {b.timestamp ? formatLocalTime(b.timestamp, true).slice(11) : ''}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* 附加信息 */}
              {selectedEvent.extra && Object.keys(selectedEvent.extra).length > 0 && (
                <div>
                  <div className="text-body font-semibold text-muted-foreground mb-1">附加信息</div>
                  <pre className="rounded-md border bg-muted/30 p-2 text-caption overflow-x-auto whitespace-pre-wrap font-mono max-h-32">
                    {JSON.stringify(selectedEvent.extra, null, 2)}
                  </pre>
                </div>
              )}
            </div>
          )}
        </div>
        {toastElement}
      </div>
    )
  }

  // ── 列表视图 ──
  return (
    <div className="flex h-full flex-col">
      {/* 头部 */}
      <div className="flex items-center justify-between border-b px-6 py-3">
        <div className="flex items-center gap-2">
          <Monitor className="h-5 w-5 text-primary" />
          <h1 className="text-title font-semibold">客户端错误监控</h1>
        </div>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setAutoRefresh((prev) => !prev)}
            className={`flex items-center gap-1 rounded-md border px-3 py-1.5 text-body transition-colors ${
              autoRefresh ? 'bg-primary text-primary-foreground' : 'hover:bg-muted'
            }`}
          >
            <RefreshCw className={`h-3 w-3 ${autoRefresh ? 'animate-spin' : ''}`} />
            自动刷新
          </button>
          <button
            type="button"
            onClick={() => {
              loadStats()
              loadGroups(1)
            }}
            className="flex items-center gap-1 rounded-md border px-3 py-1.5 text-body hover:bg-muted transition-colors"
          >
            <RefreshCw className="h-3 w-3" />
            刷新
          </button>
        </div>
      </div>

      {/* Tab 切换 */}
      <div className="flex border-b px-6">
        {(
          [
            ['errors', '错误列表'],
            ['releases', '版本追踪'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            onClick={() => setActiveTab(key)}
            className={`px-4 py-2 text-body font-medium border-b-2 transition-colors ${
              activeTab === key
                ? 'border-primary text-primary'
                : 'border-transparent text-muted-foreground hover:text-foreground'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6 space-y-6">
        {activeTab === 'errors' && (
          <>
            {/* 统计概览 */}
            {stats && (
              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-body font-semibold">概览</h2>
                  <div className="flex items-center gap-1">
                    {[1, 6, 24, 72, 168].map((h) => (
                      <button
                        key={h}
                        type="button"
                        onClick={() => setStatHours(h)}
                        className={`px-2 py-0.5 text-body rounded-md transition-colors ${
                          statHours === h
                            ? 'bg-primary text-primary-foreground'
                            : 'text-muted-foreground hover:bg-muted'
                        }`}
                      >
                        {h < 24 ? `${h}h` : `${h / 24}d`}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="grid grid-cols-4 gap-3">
                  <StatCard
                    label="错误事件"
                    value={stats.total_events}
                    icon={Bug}
                    color="text-destructive dark:text-destructive"
                  />
                  <StatCard label="影响用户" value={stats.affected_users} icon={Users} />
                  <StatCard
                    label="待处理分组"
                    value={stats.open_groups}
                    icon={AlertCircle}
                    color="text-warning dark:text-warning"
                  />
                  <StatCard label="总分组数" value={stats.total_groups} icon={Filter} />
                </div>
                {/* 趋势图 */}
                <div className="rounded-lg border bg-card p-4">
                  <div className="text-body text-muted-foreground mb-2 flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    错误趋势（最近 {statHours < 24 ? `${statHours} 小时` : `${statHours / 24} 天`}）
                  </div>
                  <TrendChart data={stats.trend} />
                </div>
                {/* 分布统计 */}
                <div className="grid grid-cols-3 gap-3">
                  {/* 按级别分布 */}
                  <div className="rounded-lg border bg-card p-4">
                    <div className="text-body text-muted-foreground mb-2">按级别分布</div>
                    {stats.by_level && Object.keys(stats.by_level).length > 0 ? (
                      <div className="space-y-1.5">
                        {Object.entries(stats.by_level).map(([level, count]) => (
                          <div key={level} className="flex items-center justify-between">
                            <span
                              className={`text-body font-medium ${LEVEL_COLORS[level] || 'text-foreground'}`}
                            >
                              {level.toUpperCase()}
                            </span>
                            <span className="text-body font-medium">{count}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-body text-muted-foreground">暂无数据</div>
                    )}
                  </div>
                  {/* 按来源分布 */}
                  <div className="rounded-lg border bg-card p-4">
                    <div className="text-body text-muted-foreground mb-2">按来源分布</div>
                    {stats.by_source && Object.keys(stats.by_source).length > 0 ? (
                      <div className="space-y-1.5">
                        {Object.entries(stats.by_source).map(([source, count]) => (
                          <div key={source} className="flex items-center justify-between">
                            <span className="text-body font-medium">{source}</span>
                            <span className="text-body font-medium">{count}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-body text-muted-foreground">暂无数据</div>
                    )}
                  </div>
                  {/* 按版本分布 */}
                  <div className="rounded-lg border bg-card p-4">
                    <div className="text-body text-muted-foreground mb-2">按版本分布</div>
                    {stats.by_version && stats.by_version.length > 0 ? (
                      <div className="space-y-1.5">
                        {stats.by_version.map((v) => (
                          <div key={v.app_version} className="flex items-center justify-between">
                            <span className="text-body font-medium">v{v.app_version}</span>
                            <span className="text-body font-medium">{v.count}</span>
                          </div>
                        ))}
                      </div>
                    ) : (
                      <div className="text-body text-muted-foreground">暂无数据</div>
                    )}
                  </div>
                </div>
              </div>
            )}

            {/* 筛选栏 */}
            <div className="flex items-center gap-3">
              <input
                type="checkbox"
                checked={groups.length > 0 && selectedIds.size === groups.length}
                onChange={(e) => {
                  if (e.target.checked) {
                    setSelectedIds(new Set(groups.map((g) => g.id)))
                  } else {
                    setSelectedIds(new Set())
                  }
                }}
                className="h-4 w-4 rounded border-border accent-primary"
                title="全选/取消全选"
              />
              <div className="relative flex-1 max-w-sm">
                <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" />
                <input
                  type="text"
                  value={searchInput}
                  onChange={(e) => setSearchInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && setKeyword(searchInput)}
                  placeholder="搜索错误标题、堆栈、指纹..."
                  className="w-full rounded-md border bg-background pl-8 pr-3 py-1.5 text-body placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-primary"
                />
              </div>
              <select
                value={filterStatus}
                onChange={(e) => setFilterStatus(e.target.value)}
                className="rounded-md border bg-background px-3 py-1.5 text-body"
              >
                <option value="all">全部状态</option>
                <option value="open">待处理</option>
                <option value="confirmed">已确认</option>
                <option value="resolved">已修复</option>
                <option value="ignored">已忽略</option>
              </select>
              <select
                value={filterLevel}
                onChange={(e) => setFilterLevel(e.target.value)}
                className="rounded-md border bg-background px-3 py-1.5 text-body"
              >
                <option value="all">全部级别</option>
                <option value="fatal">Fatal</option>
                <option value="error">Error</option>
                <option value="warning">Warning</option>
              </select>
            </div>

            {/* 批量操作栏 */}
            {selectedIds.size > 0 && (
              <div className="flex items-center gap-3 rounded-md border bg-muted/50 px-4 py-2">
                <span className="text-body text-muted-foreground">
                  已选择 <strong className="text-foreground">{selectedIds.size}</strong> 项
                </span>
                <button
                  type="button"
                  onClick={() => handleBatchStatus('confirmed')}
                  className="rounded-md border px-2.5 py-1 text-body hover:bg-muted transition-colors"
                >
                  标记已确认
                </button>
                <button
                  type="button"
                  onClick={() => handleBatchStatus('resolved')}
                  className="rounded-md border px-2.5 py-1 text-body hover:bg-muted transition-colors"
                >
                  标记已修复
                </button>
                <button
                  type="button"
                  onClick={() => handleBatchStatus('ignored')}
                  className="rounded-md border px-2.5 py-1 text-body hover:bg-muted transition-colors"
                >
                  标记已忽略
                </button>
                <button
                  type="button"
                  onClick={() => setSelectedIds(new Set())}
                  className="ml-auto rounded-md px-2.5 py-1 text-body text-muted-foreground hover:bg-muted transition-colors"
                >
                  取消选择
                </button>
              </div>
            )}

            {/* 错误分组列表 */}
            <div className="space-y-1">
              {loading ? (
                <div className="text-body text-muted-foreground py-8 text-center">加载中...</div>
              ) : groups.length === 0 ? (
                <div className="text-body text-muted-foreground py-8 text-center">暂无错误记录</div>
              ) : (
                groups.map((group) => (
                  <div
                    key={group.id}
                    className="flex items-start gap-3 rounded-md border px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedIds.has(group.id)}
                      onChange={(e) => {
                        e.stopPropagation()
                        setSelectedIds((prev) => {
                          const next = new Set(prev)
                          if (e.target.checked) {
                            next.add(group.id)
                          } else {
                            next.delete(group.id)
                          }
                          return next
                        })
                      }}
                      onClick={(e) => e.stopPropagation()}
                      className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-primary"
                    />
                    <button
                      type="button"
                      onClick={() => openGroup(group.id)}
                      className="flex-1 min-w-0 text-left"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2 mb-1">
                            <StatusBadge status={group.status} />
                            <span
                              className={`text-body font-medium ${LEVEL_COLORS[group.level] || ''}`}
                            >
                              {group.level.toUpperCase()}
                            </span>
                          </div>
                          <p className="text-body font-medium truncate">{group.title}</p>
                        </div>
                        <div className="text-right shrink-0 text-body text-muted-foreground space-y-0.5">
                          <div>{group.event_count} 次</div>
                          <div>{group.user_count} 用户</div>
                        </div>
                      </div>
                      <div className="flex items-center gap-3 mt-2 text-body text-muted-foreground">
                        <span>首次 {formatLocalTime(group.first_seen)}</span>
                        <span>最近 {formatLocalTime(group.last_seen)}</span>
                        {group.sample_app_version && <span>v{group.sample_app_version}</span>}
                      </div>
                    </button>
                  </div>
                ))
              )}
            </div>

            {/* 分页 */}
            {pagination.total > 0 && (
              <div className="flex items-center justify-center gap-2 text-body">
                <PageSizeSelect
                  value={groupsPageSize}
                  onChange={(nextPageSize) => {
                    setGroupsPageSize(nextPageSize)
                    setPagination((prev) => ({ ...prev, page: 1, page_size: nextPageSize }))
                    setSelectedIds(new Set())
                  }}
                />
                <button
                  type="button"
                  disabled={pagination.page <= 1}
                  onClick={() => loadGroups(pagination.page - 1)}
                  className="px-3 py-1 rounded-md border hover:bg-muted disabled:opacity-50"
                >
                  上一页
                </button>
                <span className="text-muted-foreground">
                  {pagination.page} / {pagination.total_pages}
                </span>
                <button
                  type="button"
                  disabled={pagination.page >= pagination.total_pages}
                  onClick={() => loadGroups(pagination.page + 1)}
                  className="px-3 py-1 rounded-md border hover:bg-muted disabled:opacity-50"
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}

        {/* ── 版本追踪 Tab ── */}
        {activeTab === 'releases' && (
          <>
            <div className="space-y-1">
              {releases.length === 0 ? (
                <div className="text-body text-muted-foreground py-8 text-center">暂无版本记录</div>
              ) : (
                releases.map((r) => (
                  <button
                    key={r.app_version}
                    type="button"
                    onClick={() => openRelease(r.app_version)}
                    className="w-full text-left rounded-md border px-4 py-3 hover:bg-muted/50 transition-colors"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <Package className="h-4 w-4 text-muted-foreground" />
                        <span className="text-body font-semibold">v{r.app_version}</span>
                        <span className="text-body text-muted-foreground">
                          {formatLocalTime(r.first_seen).slice(0, 10)}
                        </span>
                      </div>
                      <div className="flex items-center gap-4 text-body text-muted-foreground">
                        <span>{r.event_count} 事件</span>
                        <span>{r.new_group_count} 新错误</span>
                        <span>{r.user_count} 用户</span>
                      </div>
                    </div>
                    {r.vs_prev && (
                      <div className="flex items-center gap-2 mt-1.5 ml-7 text-body">
                        <span className="text-muted-foreground">vs {r.vs_prev.prev_version}:</span>
                        <span
                          className={`flex items-center gap-0.5 font-medium ${
                            r.vs_prev.event_change > 0
                              ? 'text-destructive'
                              : r.vs_prev.event_change < 0
                                ? 'text-success'
                                : 'text-muted-foreground'
                          }`}
                        >
                          {r.vs_prev.event_change > 0 ? (
                            <ArrowUp className="h-3 w-3" />
                          ) : r.vs_prev.event_change < 0 ? (
                            <ArrowDown className="h-3 w-3" />
                          ) : null}
                          {r.vs_prev.event_change > 0 ? '+' : ''}
                          {r.vs_prev.event_change_pct}%
                        </span>
                        {r.vs_prev.new_groups_introduced > 0 && (
                          <span className="text-warning font-medium">
                            +{r.vs_prev.new_groups_introduced} 新错误类型
                          </span>
                        )}
                      </div>
                    )}
                  </button>
                ))
              )}
            </div>

            {releasePagination.total > 0 && (
              <div className="flex items-center justify-center gap-2 text-body">
                <PageSizeSelect
                  value={releasesPageSize}
                  onChange={(nextPageSize) => {
                    setReleasesPageSize(nextPageSize)
                    setReleasePagination((prev) => ({ ...prev, page: 1, page_size: nextPageSize }))
                  }}
                />
                <button
                  type="button"
                  disabled={releasePagination.page <= 1}
                  onClick={() => loadReleases(releasePagination.page - 1)}
                  className="px-3 py-1 rounded-md border hover:bg-muted disabled:opacity-50"
                >
                  上一页
                </button>
                <span className="text-muted-foreground">
                  {releasePagination.page} / {releasePagination.total_pages}
                </span>
                <button
                  type="button"
                  disabled={releasePagination.page >= releasePagination.total_pages}
                  onClick={() => loadReleases(releasePagination.page + 1)}
                  className="px-3 py-1 rounded-md border hover:bg-muted disabled:opacity-50"
                >
                  下一页
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
