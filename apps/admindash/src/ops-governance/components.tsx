import { AdminPage } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { formatDateTime as formatDateTimeBase } from '@/lib/utils'
import { useAuthStore } from '@/stores/auth-store'
import { AlertCircle, Ban, Loader2, Pause, RefreshCw } from 'lucide-react'
import { type ReactNode, useEffect, useId, useMemo, useState } from 'react'
import { hasOpsPermission } from './permissions'
import type { OpsPermissionCode } from './types'

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 100

export function formatValue(value: unknown): string {
  if (value === null || value === undefined || value === '') return '-'
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString() : '-'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function formatDateTime(value: unknown): string {
  if (!value || typeof value !== 'string') return '-'
  return formatDateTimeBase(value)
}

export const STATUS_LABELS: Record<string, string> = {
  ok: '正常',
  healthy: '正常',
  success: '正常',
  succeeded: '正常',
  normal: '正常',
  normal_backlog: '正常积压',
  worker_not_consuming: 'Worker 不消费',
  no_worker_unknown: '未知 / 无消费者',
  old_pending: '等待过久',
  needs_attention: '需要关注',
  task_failed: '任务失败',
  program_error: '程序错误',
  worker_binding_mismatch: '消费绑定异常',
  manual_intervention_required: '需要人工处理',
  unsupported: '未接入',
  data_source_unavailable: '数据源不可用',
  partial_observable: '部分可观测',
  metrics_unavailable: '指标不可用',
  data_problem: '数据问题',
  partial: '部分可用',
  degraded: '性能下降',
  critical: '严重',
  unknown: '未知',
  unavailable: '不可用',
  unhealthy: '异常',
  timeout: '超时',
  HTTPError: '健康检查失败',
  httperror: '健康检查失败',
  open: '待处理',
  failed: '失败',
  fallback: '已降级',
  pending: '等待中',
  processing: '处理中',
  resolved: '已处理',
  completed: '已完成',
  processed: '已处理',
  blocked: '已拦截',
  rate_limited: '触发限流',
  template_error: '模板异常',
  provider_error: '服务商异常',
  stale: '疑似未按时执行',
  suspected_stuck: '疑似卡住',
  stuck: '疑似卡住',
  warning: '需要关注',
  paused: '已暂停',
}

export function formatStatusLabel(status?: unknown): string {
  const raw = String(status ?? 'unknown')
  return STATUS_LABELS[raw] ?? STATUS_LABELS[raw.toLowerCase()] ?? raw
}

export function statusVariant(
  status?: string
): 'default' | 'secondary' | 'destructive' | 'success' | 'warning' {
  const s = (status || '').toLowerCase()
  if (['ok', 'healthy', 'success', 'succeeded', 'normal'].includes(s)) return 'success'
  if (
    [
      'unknown',
      'unavailable',
      'partial',
      'partial_observable',
      'metrics_unavailable',
      'normal_backlog',
      'old_pending',
      'needs_attention',
      'task_failed',
      'warning',
      'degraded',
      'stale',
      'suspected_stuck',
    ].includes(s)
  ) {
    return 'warning'
  }
  if (
    [
      'error',
      'failed',
      'critical',
      'unhealthy',
      'worker_not_consuming',
      'program_error',
      'data_problem',
    ].includes(s)
  ) {
    return 'destructive'
  }
  return 'secondary'
}

export function OpsPageShell({
  permission,
  title,
  description,
  children,
}: {
  permission: OpsPermissionCode | OpsPermissionCode[]
  title: string
  description?: string
  children: ReactNode
}) {
  const user = useAuthStore((state) => state.user)
  const permissions = Array.isArray(permission) ? permission : [permission]
  if (!permissions.some((code) => hasOpsPermission(user, code))) {
    return (
      <AdminPage>
        <Card className="border-destructive/30">
          <CardContent className="flex items-start gap-3 pt-6">
            <Ban className="mt-0.5 h-5 w-5 text-destructive" />
            <div>
              <h1 className="text-title font-semibold">没有访问权限</h1>
              <p className="mt-1 text-body text-muted-foreground">
                需要权限 `{permissions.join('` 或 `')}`。如果你刚被授权，请重新登录后再试。
              </p>
            </div>
          </CardContent>
        </Card>
      </AdminPage>
    )
  }
  return (
    <AdminPage>
      <div className="space-y-1">
        <h1 className="text-heading font-bold tracking-tight">{title}</h1>
        {description ? <p className="text-body text-muted-foreground">{description}</p> : null}
      </div>
      {children}
    </AdminPage>
  )
}

export function ModuleError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Card className="border-destructive/30 bg-destructive/5">
      <CardContent className="flex items-center justify-between gap-3 pt-6">
        <div className="flex items-center gap-2 text-destructive">
          <AlertCircle className="h-4 w-4" />
          <span className="text-body">{message}</span>
        </div>
        {onRetry ? (
          <Button type="button" variant="outline" size="sm" onClick={onRetry}>
            重新加载
          </Button>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function LoadingBlock({ label = '加载中...' }: { label?: string }) {
  return (
    <div className="flex items-center justify-center rounded-lg border bg-card p-8 text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      <span className="text-body">{label}</span>
    </div>
  )
}

export function EmptyBlock({ label }: { label: string }) {
  return (
    <div className="rounded-lg border border-dashed bg-muted/20 p-8 text-center text-body text-muted-foreground">
      {label}
    </div>
  )
}

export function StatusCard({
  title,
  value,
  status,
  description,
}: {
  title: string
  value: ReactNode
  status?: string
  description?: ReactNode
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <div className="flex items-center justify-between gap-3">
          <CardTitle className="text-body font-medium text-muted-foreground">{title}</CardTitle>
          {status ? (
            <Badge variant={statusVariant(status)}>{formatStatusLabel(status)}</Badge>
          ) : null}
        </div>
      </CardHeader>
      <CardContent>
        <div className="text-title font-semibold">{value}</div>
        {description ? (
          <div className="mt-1 text-body text-muted-foreground">{description}</div>
        ) : null}
      </CardContent>
    </Card>
  )
}

export function GovernanceInfoCard({
  title,
  status,
  description,
  impact,
  suggestion,
  anomaly,
  keyMetrics,
  samples,
  intervention,
  futureActions,
  details,
}: {
  title: string
  status?: unknown
  description: ReactNode
  impact: ReactNode
  suggestion: ReactNode
  anomaly?: ReactNode
  keyMetrics?: ReactNode
  samples?: ReactNode
  intervention?: ReactNode
  futureActions?: ReactNode
  details?: unknown
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div>
            <CardTitle className="text-subtitle">{title}</CardTitle>
            <p className="mt-1 text-body text-muted-foreground">
              状态：{formatStatusLabel(status)}
            </p>
          </div>
          <Badge variant={statusVariant(String(status ?? 'unknown'))}>
            {formatStatusLabel(status)}
          </Badge>
        </div>
      </CardHeader>
      <CardContent className="space-y-3 text-body">
        <div>
          <div className="font-medium">说明</div>
          <div className="mt-1 text-muted-foreground">{description}</div>
        </div>
        <div>
          <div className="font-medium">异常分类</div>
          <div className="mt-1 text-muted-foreground">{anomaly ?? '指标正常或暂无异常样本'}</div>
        </div>
        <div>
          <div className="font-medium">关键指标</div>
          <div className="mt-1 text-muted-foreground">{keyMetrics ?? '暂无可展示指标'}</div>
        </div>
        <div>
          <div className="font-medium">异常样本</div>
          <div className="mt-1 text-muted-foreground">{samples ?? '暂无异常样本'}</div>
        </div>
        <div>
          <div className="font-medium">影响</div>
          <div className="mt-1 text-muted-foreground">{impact}</div>
        </div>
        <div>
          <div className="font-medium">建议</div>
          <div className="mt-1 text-muted-foreground">{suggestion}</div>
        </div>
        <div>
          <div className="font-medium">当前可人工介入项</div>
          <div className="mt-1 text-muted-foreground">
            {intervention ?? '刷新、查看详情、复制排障信息'}
          </div>
        </div>
        <div>
          <div className="font-medium">后续 P1.5 可评估项</div>
          <div className="mt-1 text-muted-foreground">
            {futureActions ?? '单条受控操作，需先补权限、工单和审计闭环'}
          </div>
        </div>
        {details !== undefined ? <TechnicalDetails value={details} /> : null}
      </CardContent>
    </Card>
  )
}

export function TechnicalDetails({
  value,
  label = '查看技术详情',
}: {
  value: unknown
  label?: string
}) {
  return (
    <details className="rounded-lg border bg-muted/20 p-3">
      <summary className="cursor-pointer text-body font-medium text-muted-foreground">
        {label}
      </summary>
      <pre className="mt-3 max-h-[420px] overflow-auto rounded-md bg-muted/40 p-3 text-body">
        {JSON.stringify(value ?? {}, null, 2)}
      </pre>
    </details>
  )
}

export function ReadonlyBoundaryNotice({ children }: { children?: ReactNode }) {
  return (
    <Card className="border-muted bg-muted/20">
      <CardContent className="space-y-1 pt-4 text-body text-muted-foreground">
        <p>
          当前为只读排查模式，仅支持查看队列、Worker、Beat、Outbox 和失败样本；不提供 retry、purge、清空队列、kill worker、scale worker。
        </p>
        {children ? <div>{children}</div> : null}
      </CardContent>
    </Card>
  )
}

export function RefreshControls({
  loading,
  autoRefresh,
  intervalSeconds,
  onRefresh,
  onAutoRefreshChange,
  onIntervalChange,
}: {
  loading: boolean
  autoRefresh: boolean
  intervalSeconds: 60 | 30
  onRefresh: () => void
  onAutoRefreshChange: (enabled: boolean) => void
  onIntervalChange?: (value: 60 | 30) => void
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" onClick={onRefresh} disabled={loading}>
        <RefreshCw className={`mr-2 h-4 w-4 ${loading ? 'animate-spin' : ''}`} />
        刷新
      </Button>
      <Button
        type="button"
        variant={autoRefresh ? 'secondary' : 'outline'}
        size="sm"
        onClick={() => onAutoRefreshChange(!autoRefresh)}
      >
        {autoRefresh ? <Pause className="mr-2 h-4 w-4" /> : <RefreshCw className="mr-2 h-4 w-4" />}
        {autoRefresh ? '暂停自动刷新' : '开启自动刷新'}
      </Button>
      {onIntervalChange ? (
        <Select
          value={String(intervalSeconds)}
          onValueChange={(value) => onIntervalChange(Number(value) as 60 | 30)}
        >
          <SelectTrigger className="h-8 w-[112px]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="60">60 秒</SelectItem>
            <SelectItem value="30">30 秒</SelectItem>
          </SelectContent>
        </Select>
      ) : null}
    </div>
  )
}

export function useAutoRefresh(enabled: boolean, intervalSeconds: number, callback: () => void) {
  useEffect(() => {
    if (!enabled) return
    const timer = window.setInterval(callback, Math.max(intervalSeconds, 30) * 1000)
    return () => window.clearInterval(timer)
  }, [callback, enabled, intervalSeconds])
}

export function TimeRangeFields({
  start,
  end,
  onStartChange,
  onEndChange,
}: {
  start: string
  end: string
  onStartChange: (value: string) => void
  onEndChange: (value: string) => void
}) {
  const startId = useId()
  const endId = useId()
  return (
    <>
      <label className="space-y-1 text-body" htmlFor={startId}>
        <span className="text-muted-foreground">开始时间</span>
        <Input
          id={startId}
          type="datetime-local"
          value={start}
          onChange={(e) => onStartChange(e.target.value)}
        />
      </label>
      <label className="space-y-1 text-body" htmlFor={endId}>
        <span className="text-muted-foreground">结束时间</span>
        <Input
          id={endId}
          type="datetime-local"
          value={end}
          onChange={(e) => onEndChange(e.target.value)}
        />
      </label>
    </>
  )
}

export function ReasonFields({
  reason,
  ticketId,
  onReasonChange,
  onTicketIdChange,
  ticketRequired = false,
}: {
  reason: string
  ticketId: string
  onReasonChange: (value: string) => void
  onTicketIdChange: (value: string) => void
  ticketRequired?: boolean
}) {
  const reasonId = useId()
  const ticketIdInputId = useId()
  return (
    <>
      <label className="space-y-1 text-body" htmlFor={reasonId}>
        <span className="text-muted-foreground">Reason（必填）</span>
        <Input
          id={reasonId}
          value={reason}
          onChange={(e) => onReasonChange(e.target.value)}
          placeholder="说明排障原因"
        />
      </label>
      <label className="space-y-1 text-body" htmlFor={ticketIdInputId}>
        <span className="text-muted-foreground">
          Ticket ID{ticketRequired ? '（必填）' : '（选填）'}
        </span>
        <Input
          id={ticketIdInputId}
          value={ticketId}
          onChange={(e) => onTicketIdChange(e.target.value)}
          placeholder="OPS-123"
        />
      </label>
    </>
  )
}

export function ReadonlyTable({
  columns,
  rows,
  emptyLabel,
  pageSize = 10,
}: {
  columns: Array<{
    key: string
    label: string
    render?: (row: Record<string, unknown>) => ReactNode
  }>
  rows: Array<Record<string, unknown>>
  emptyLabel: string
  pageSize?: number
}) {
  const [page, setPage] = useState(1)
  const totalPages = Math.max(1, Math.ceil(rows.length / pageSize))
  const currentPage = Math.min(page, totalPages)
  const startIndex = (currentPage - 1) * pageSize
  const visibleRows = useMemo(
    () => rows.slice(startIndex, startIndex + pageSize),
    [pageSize, rows, startIndex]
  )

  useEffect(() => {
    if (page > totalPages) setPage(totalPages)
  }, [page, totalPages])

  if (!rows.length) return <EmptyBlock label={emptyLabel} />
  return (
    <div className="rounded-lg border">
      <div className="overflow-x-auto">
        <table className="w-full text-body">
          <thead className="bg-muted/40 text-left text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th key={column.key} className="whitespace-nowrap px-3 py-2 font-medium">
                  {column.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {visibleRows.map((row, index) => (
              <tr
                key={String(
                  row.id ?? row.order_no ?? row.task_id ?? row.name ?? startIndex + index
                )}
                className="border-t"
              >
                {columns.map((column) => (
                  <td key={column.key} className="max-w-[280px] truncate px-3 py-2 align-top">
                    {column.render ? column.render(row) : formatValue(row[column.key])}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {rows.length > pageSize ? (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t px-3 py-2 text-body text-muted-foreground">
          <span>
            第 {currentPage} / {totalPages} 页，共 {rows.length.toLocaleString()} 条
          </span>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((value) => Math.max(1, value - 1))}
              disabled={currentPage <= 1}
            >
              上一页
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => setPage((value) => Math.min(totalPages, value + 1))}
              disabled={currentPage >= totalPages}
            >
              下一页
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function PageSizeField({
  value,
  onChange,
}: {
  value: number
  onChange: (value: number) => void
}) {
  return (
    <PageSizeSelect value={value} onChange={(next) => onChange(Math.min(next, MAX_PAGE_SIZE))} />
  )
}

export function getDefaultRange(hours = 24): { start: string; end: string } {
  const end = new Date()
  const start = new Date(end.getTime() - hours * 60 * 60 * 1000)
  return {
    start: toLocalInputValue(start),
    end: toLocalInputValue(end),
  }
}

export function toIsoFromLocalInput(value: string): string | undefined {
  if (!value) return undefined
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString()
}

function toLocalInputValue(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`
}
