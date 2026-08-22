import {
  batchResolveFailedTasks,
  getFailedTaskDetail,
  getFailedTasks,
  resolveFailedTask,
  retryFailedTask,
} from '@/celery-management/api/celery-management'
import type {
  FailedTaskDetail,
  FailedTaskItem,
  FailedTaskListResponse,
  FailedTaskQuery,
} from '@/celery-management/types'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import { ScrollArea } from '@/components/ui/scroll-area'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDateTime } from '@/lib/utils'
import {
  AlertCircle,
  Check,
  CheckCheck,
  ChevronLeft,
  ChevronRight,
  Loader2,
  RefreshCw,
  RotateCcw,
  Search,
} from 'lucide-react'
import { useCallback, useEffect, useState } from 'react'

function shortTaskName(name: string): string {
  const parts = name.split('.')
  return parts.length > 1 ? parts[parts.length - 1] : name
}

export function CeleryFailedTasksPage() {
  const [list, setList] = useState<FailedTaskListResponse | null>(null)
  const [query, setQuery] = useState<FailedTaskQuery>({
    resolved: 'false',
    page: 1,
    page_size: 20,
  })
  const [searchInput, setSearchInput] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const [selectedId, setSelectedId] = useState<number | null>(null)
  const [detail, setDetail] = useState<FailedTaskDetail | null>(null)
  const [detailLoading, setDetailLoading] = useState(false)

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set())
  const [actionLoading, setActionLoading] = useState(false)

  const fetchList = useCallback(async (q: FailedTaskQuery) => {
    setLoading(true)
    setError('')
    try {
      const res = await getFailedTasks(q)
      setList(res)
    } catch (err) {
      setError(err instanceof Error ? err.message : '获取失败任务列表失败')
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    fetchList(query)
  }, [fetchList, query])

  const fetchDetail = useCallback(async (id: number) => {
    setDetailLoading(true)
    try {
      const res = await getFailedTaskDetail(id)
      setDetail(res)
    } catch {
      setDetail(null)
    } finally {
      setDetailLoading(false)
    }
  }, [])

  useEffect(() => {
    if (selectedId !== null) {
      fetchDetail(selectedId)
    } else {
      setDetail(null)
    }
  }, [selectedId, fetchDetail])

  const handleSearch = () => {
    setQuery((prev) => ({ ...prev, task_name: searchInput, page: 1 }))
  }

  const handleResolvedFilter = (value: string) => {
    setQuery((prev) => ({ ...prev, resolved: value as FailedTaskQuery['resolved'], page: 1 }))
  }

  const handlePageChange = (page: number) => {
    setQuery((prev) => ({ ...prev, page }))
    setSelectedId(null)
  }

  const handlePageSizeChange = (pageSize: number) => {
    setQuery((prev) => ({ ...prev, page: 1, page_size: pageSize }))
    setSelectedId(null)
  }

  const handleResolve = async (id: number) => {
    setActionLoading(true)
    try {
      await resolveFailedTask(id)
      await fetchList(query)
      if (selectedId === id) {
        fetchDetail(id)
      }
    } finally {
      setActionLoading(false)
    }
  }

  const handleRetry = async (id: number) => {
    setActionLoading(true)
    try {
      const res = await retryFailedTask(id)
      alert(`任务已重新投递，新 task_id: ${res.new_task_id}`)
      await fetchList(query)
      if (selectedId === id) {
        fetchDetail(id)
      }
    } catch (err) {
      alert(err instanceof Error ? err.message : '重试失败')
    } finally {
      setActionLoading(false)
    }
  }

  const handleBatchResolve = async () => {
    if (selectedIds.size === 0) return
    setActionLoading(true)
    try {
      await batchResolveFailedTasks(Array.from(selectedIds))
      setSelectedIds(new Set())
      await fetchList(query)
    } finally {
      setActionLoading(false)
    }
  }

  const toggleSelect = (id: number) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) {
        next.delete(id)
      } else {
        next.add(id)
      }
      return next
    })
  }

  const toggleSelectAll = () => {
    if (!list) return
    const allIds = list.items.map((i) => i.id)
    const allSelected = allIds.every((id) => selectedIds.has(id))
    if (allSelected) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(allIds))
    }
  }

  const totalPages = list ? Math.max(1, Math.ceil(list.total / (list.page_size || 20))) : 1
  const currentPage = query.page ?? 1

  return (
    <div className="flex h-full">
      {/* 左侧列表 */}
      <div className="flex w-[480px] flex-col border-r">
        <div className="flex flex-col gap-3 border-b p-4">
          <div className="flex items-center justify-between">
            <h1 className="text-title font-bold">失败任务</h1>
            <Button variant="outline" size="sm" onClick={() => fetchList(query)} disabled={loading}>
              <RefreshCw className={`mr-1 h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              刷新
            </Button>
          </div>

          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                placeholder="搜索任务名..."
                value={searchInput}
                onChange={(e) => setSearchInput(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && handleSearch()}
                className="pl-8 h-9"
              />
            </div>
            <Select value={query.resolved ?? 'all'} onValueChange={handleResolvedFilter}>
              <SelectTrigger className="w-[120px] h-9">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">全部</SelectItem>
                <SelectItem value="false">未解决</SelectItem>
                <SelectItem value="true">已解决</SelectItem>
              </SelectContent>
            </Select>
          </div>

          {selectedIds.size > 0 && (
            <div className="flex items-center justify-between">
              <span className="text-body text-muted-foreground">已选 {selectedIds.size} 条</span>
              <Button
                variant="outline"
                size="sm"
                onClick={handleBatchResolve}
                disabled={actionLoading}
              >
                <CheckCheck className="mr-1 h-3 w-3" />
                批量解决
              </Button>
            </div>
          )}
        </div>

        {error && (
          <div className="flex items-center gap-2 border-b px-4 py-2 text-body text-destructive">
            <AlertCircle className="h-3 w-3" />
            {error}
          </div>
        )}

        <ScrollArea className="flex-1">
          {loading && !list ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              加载中...
            </div>
          ) : !list || list.items.length === 0 ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-body">
              暂无数据
            </div>
          ) : (
            <div>
              {/* 全选 */}
              <div className="flex items-center gap-2 px-4 py-2 border-b bg-muted/30">
                <input
                  type="checkbox"
                  checked={list.items.length > 0 && list.items.every((i) => selectedIds.has(i.id))}
                  onChange={toggleSelectAll}
                  className="rounded"
                />
                <span className="text-body text-muted-foreground">全选</span>
                <span className="ml-auto text-body text-muted-foreground">共 {list.total} 条</span>
              </div>

              {list.items.map((item) => (
                <TaskListItem
                  key={item.id}
                  item={item}
                  active={selectedId === item.id}
                  checked={selectedIds.has(item.id)}
                  onSelect={() => setSelectedId(item.id)}
                  onToggle={() => toggleSelect(item.id)}
                />
              ))}
            </div>
          )}
        </ScrollArea>

        {/* 分页 */}
        <div className="flex items-center justify-between border-t px-4 py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage <= 1}
            onClick={() => handlePageChange(currentPage - 1)}
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-body text-muted-foreground">
            {currentPage} / {totalPages}
          </span>
          <PageSizeSelect value={query.page_size ?? 20} onChange={handlePageSizeChange} />
          <Button
            variant="ghost"
            size="sm"
            disabled={currentPage >= totalPages}
            onClick={() => handlePageChange(currentPage + 1)}
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* 右侧详情 */}
      <div className="flex-1 overflow-auto">
        {detailLoading ? (
          <div className="flex h-full items-center justify-center text-muted-foreground">
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            加载详情...
          </div>
        ) : detail ? (
          <TaskDetailPanel
            detail={detail}
            onResolve={() => handleResolve(detail.id)}
            onRetry={() => handleRetry(detail.id)}
            actionLoading={actionLoading}
          />
        ) : (
          <div className="flex h-full items-center justify-center text-muted-foreground text-body">
            选择左侧任务查看详情
          </div>
        )}
      </div>
    </div>
  )
}

function TaskListItem({
  item,
  active,
  checked,
  onSelect,
  onToggle,
}: {
  item: FailedTaskItem
  active: boolean
  checked: boolean
  onSelect: () => void
  onToggle: () => void
}) {
  return (
    <div
      className={`flex items-start gap-2 border-b px-4 py-3 transition-colors ${
        active ? 'bg-accent' : 'hover:bg-muted/50'
      }`}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => {
          e.stopPropagation()
          onToggle()
        }}
        onClick={(e) => e.stopPropagation()}
        className="mt-0.5 rounded"
      />
      <button type="button" className="min-w-0 flex-1 text-left" onClick={onSelect}>
        <div className="flex items-center gap-2">
          <span className="truncate text-body font-medium" title={item.task_name}>
            {shortTaskName(item.task_name)}
          </span>
          {item.resolved ? (
            <Badge variant="secondary">已解决</Badge>
          ) : (
            <Badge variant="destructive">未解决</Badge>
          )}
        </div>
        <p className="mt-1 truncate text-body text-muted-foreground" title={item.exception}>
          {item.exception}
        </p>
        <div className="mt-1 flex items-center gap-3 text-body text-muted-foreground">
          <span>重试 {item.retries} 次</span>
          <span>{formatDateTime(item.failed_at)}</span>
        </div>
      </button>
    </div>
  )
}

function TaskDetailPanel({
  detail,
  onResolve,
  onRetry,
  actionLoading,
}: {
  detail: FailedTaskDetail
  onResolve: () => void
  onRetry: () => void
  actionLoading: boolean
}) {
  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-title font-bold">{shortTaskName(detail.task_name)}</h2>
          <p className="text-body text-muted-foreground font-mono mt-1">{detail.task_name}</p>
        </div>
        <div className="flex gap-2">
          {!detail.resolved && (
            <>
              <Button variant="outline" size="sm" onClick={onResolve} disabled={actionLoading}>
                <Check className="mr-1 h-3 w-3" />
                标记解决
              </Button>
              <Button variant="default" size="sm" onClick={onRetry} disabled={actionLoading}>
                <RotateCcw className="mr-1 h-3 w-3" />
                重新投递
              </Button>
            </>
          )}
          {detail.resolved && (
            <Badge variant="secondary" className="text-body">
              已解决 {formatDateTime(detail.resolved_at)}
            </Badge>
          )}
        </div>
      </div>

      <div className="space-y-4">
        <DetailRow label="Task ID" value={detail.task_id} mono />
        <DetailRow label="重试次数" value={String(detail.retries)} />
        <DetailRow label="失败时间" value={formatDateTime(detail.failed_at)} />
        {detail.resolved_at && (
          <DetailRow label="解决时间" value={formatDateTime(detail.resolved_at)} />
        )}

        <div>
          <p className="text-body font-medium text-muted-foreground mb-1">Args</p>
          <pre className="rounded-md bg-muted/50 p-3 text-body overflow-auto max-h-32">
            {JSON.stringify(detail.args, null, 2)}
          </pre>
        </div>

        <div>
          <p className="text-body font-medium text-muted-foreground mb-1">Kwargs</p>
          <pre className="rounded-md bg-muted/50 p-3 text-body overflow-auto max-h-32">
            {JSON.stringify(detail.kwargs, null, 2)}
          </pre>
        </div>

        <div>
          <p className="text-body font-medium text-muted-foreground mb-1">Exception</p>
          <pre className="rounded-md bg-destructive/5 border border-destructive/20 p-3 text-body overflow-auto max-h-40 text-destructive">
            {detail.exception}
          </pre>
        </div>

        {detail.traceback && (
          <div>
            <p className="text-body font-medium text-muted-foreground mb-1">Traceback</p>
            <pre className="rounded-md bg-muted/50 p-3 text-body overflow-auto max-h-64 whitespace-pre-wrap">
              {detail.traceback}
            </pre>
          </div>
        )}
      </div>
    </div>
  )
}

function DetailRow({
  label,
  value,
  mono = false,
}: {
  label: string
  value: string
  mono?: boolean
}) {
  return (
    <div className="flex items-baseline gap-4">
      <p className="text-body font-medium text-muted-foreground w-20 shrink-0">{label}</p>
      <p className={`text-body break-all ${mono ? 'font-mono' : ''}`}>{value}</p>
    </div>
  )
}
