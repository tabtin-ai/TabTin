import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { PermissionGate } from '@/components/permissions/PermissionGate'
import { SensitiveActionConfirmDialog } from '@/components/ui/SensitiveActionConfirmDialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { ADMIN_PERMISSION } from '@/lib/admin-permissions'
import { formatDateTime } from '@/lib/utils'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Clock3,
  Loader2,
  RefreshCw,
  Search,
  ShieldAlert,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type OrganizationCleanupJobItem,
  type OrganizationCleanupJobListResponse,
  type OrganizationCleanupJobStats,
  getOrganizationCleanupJobStats,
  listOrganizationCleanupJobs,
  retryDueOrganizationCleanupJobs,
  retryOrganizationCleanupJob,
} from '../api/billing-admin'

type CleanupStatus = 'all' | 'pending' | 'running' | 'failed' | 'permanently_failed' | 'succeeded'

const STATUS_OPTIONS: Array<{ value: CleanupStatus; label: string }> = [
  { value: 'all', label: '全部状态' },
  { value: 'pending', label: '待执行' },
  { value: 'running', label: '执行中' },
  { value: 'failed', label: '失败待重试' },
  { value: 'permanently_failed', label: '永久失败' },
  { value: 'succeeded', label: '已完成' },
]

function getStatusBadgeVariant(
  status: string
): 'success' | 'warning' | 'destructive' | 'secondary' | 'outline' {
  if (status === 'succeeded') {
    return 'success'
  }
  if (status === 'pending' || status === 'running') {
    return 'warning'
  }
  if (status === 'failed' || status === 'permanently_failed') {
    return 'destructive'
  }
  return 'secondary'
}

function formatTriggerSource(value: string): string {
  const normalized = value.trim()
  if (!normalized) {
    return 'unknown'
  }
  return normalized.replace(/_/g, ' ')
}

function getDeletedRows(summary?: Record<string, unknown>): number {
  const raw = summary?.total_deleted
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw
  }
  if (typeof raw === 'string') {
    const parsed = Number.parseInt(raw, 10)
    return Number.isNaN(parsed) ? 0 : parsed
  }
  return 0
}

export function OrganizationCleanupPage() {
  const navigate = useNavigate()
  const { show: showToast, element: toastElement } = useSimpleToast()

  const [status, setStatus] = useState<CleanupStatus>('all')
  const [organizationInput, setOrganizationInput] = useState('')
  const [organizationKeyword, setOrganizationKeyword] = useState('')
  const [triggerInput, setTriggerInput] = useState('')
  const [triggerKeyword, setTriggerKeyword] = useState('')
  const [keywordInput, setKeywordInput] = useState('')
  const [keyword, setKeyword] = useState('')
  const [dueOnly, setDueOnly] = useState(false)
  const [stuckOnly, setStuckOnly] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(20)

  const [listData, setListData] = useState<OrganizationCleanupJobListResponse | null>(null)
  const [statsData, setStatsData] = useState<OrganizationCleanupJobStats | null>(null)
  const [loading, setLoading] = useState(false)
  const [statsLoading, setStatsLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [statsError, setStatsError] = useState<string | null>(null)
  const [runDueOpen, setRunDueOpen] = useState(false)
  const [actionLoading, setActionLoading] = useState(false)
  const [retryTarget, setRetryTarget] = useState<OrganizationCleanupJobItem | null>(null)

  const loadJobs = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await listOrganizationCleanupJobs({
        status: status === 'all' ? undefined : status,
        organization_id: organizationKeyword || undefined,
        trigger_source: triggerKeyword || undefined,
        keyword: keyword || undefined,
        due_only: dueOnly || undefined,
        stuck_only: stuckOnly || undefined,
        page,
        page_size: pageSize,
        order_by: '-updated_at',
      })
      setListData(response)
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : '加载 organization cleanup 列表失败'
      setError(message)
    } finally {
      setLoading(false)
    }
  }, [dueOnly, keyword, page, pageSize, status, stuckOnly, triggerKeyword, organizationKeyword])

  const loadStats = useCallback(async () => {
    setStatsLoading(true)
    setStatsError(null)
    try {
      const response = await getOrganizationCleanupJobStats()
      setStatsData(response)
    } catch (caughtError) {
      const message =
        caughtError instanceof Error ? caughtError.message : '加载 organization cleanup 统计失败'
      setStatsError(message)
    } finally {
      setStatsLoading(false)
    }
  }, [])

  const reloadAll = useCallback(async () => {
    await Promise.all([loadJobs(), loadStats()])
  }, [loadJobs, loadStats])

  useEffect(() => {
    void loadJobs()
  }, [loadJobs])

  useEffect(() => {
    void loadStats()
  }, [loadStats])

  const handleSearch = () => {
    setPage(1)
    setOrganizationKeyword(organizationInput.trim())
    setTriggerKeyword(triggerInput.trim())
    setKeyword(keywordInput.trim())
  }

  const handleRetryDue = async () => {
    setActionLoading(true)
    try {
      const result = await retryDueOrganizationCleanupJobs({ limit: 50, recover_stuck: true })
      showToast(
        `批量执行完成：成功 ${result.succeeded}，失败 ${result.failed}，恢复卡住 ${result.recovered_stuck_jobs}`,
        'success'
      )
      setRunDueOpen(false)
      await reloadAll()
    } catch (caughtError) {
      showToast(
        caughtError instanceof Error ? caughtError.message : '批量执行 cleanup 队列失败',
        'error'
      )
    } finally {
      setActionLoading(false)
    }
  }

  const handleRetrySingle = async (payload: { reason: string; ticket_id: string }) => {
    if (!retryTarget) return
    setActionLoading(true)
    try {
      await retryOrganizationCleanupJob(retryTarget.id, payload)
      showToast(`已触发 ${retryTarget.organization_id} 的 cleanup 重试`, 'success')
      setRetryTarget(null)
      await reloadAll()
    } catch (caughtError) {
      showToast(
        caughtError instanceof Error ? caughtError.message : '重试 cleanup job 失败',
        'error'
      )
    } finally {
      setActionLoading(false)
    }
  }

  const counts = statsData?.counts
  const listSummary = listData?.summary
  const recentFailed = statsData?.recent_failed_jobs ?? []
  const recentSucceeded = statsData?.recent_succeeded_jobs ?? []
  const pagination = listData

  const hasPrevPage = Boolean(pagination && pagination.page > 1)
  const hasNextPage = Boolean(pagination && pagination.page < pagination.total_pages)

  const highlightedIssues = useMemo(() => {
    const issues: string[] = []
    if ((counts?.stuck_running_jobs ?? 0) > 0) {
      issues.push(`有 ${counts?.stuck_running_jobs ?? 0} 个卡住的 running job`)
    }
    if ((counts?.permanently_failed ?? 0) > 0) {
      issues.push(`有 ${counts?.permanently_failed ?? 0} 个永久失败 job`)
    }
    if ((counts?.due_retry_jobs ?? 0) > 0) {
      issues.push(`有 ${counts?.due_retry_jobs ?? 0} 个待执行或待重试 job`)
    }
    return issues
  }, [counts])

  return (
    <AdminPage>
      {toastElement}

      <AdminPageHeader
        title="Organization 清理风险"
        icon={Trash2}
        badges={
          <>
            <Badge variant="outline">自动队列</Badge>
            <Badge variant={(counts?.stuck_running_jobs ?? 0) > 0 ? 'destructive' : 'success'}>
              卡住任务 {(counts?.stuck_running_jobs ?? 0).toLocaleString()}
            </Badge>
            <Badge variant={(counts?.due_retry_jobs ?? 0) > 0 ? 'warning' : 'success'}>
              待处理 {(counts?.due_retry_jobs ?? 0).toLocaleString()}
            </Badge>
          </>
        }
        actions={
          <>
            <Button variant="outline" onClick={() => navigate('/billing/anomalies')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回异常与预算
            </Button>
            <Button
              variant="outline"
              onClick={() => void reloadAll()}
              disabled={loading || statsLoading}
            >
              <RefreshCw className="mr-2 h-4 w-4" />
              刷新
            </Button>
            <Button onClick={() => setRunDueOpen(true)} disabled={actionLoading}>
              {actionLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Clock3 className="mr-2 h-4 w-4" />
              )}
              执行到期队列
            </Button>
          </>
        }
      />

      {highlightedIssues.length > 0 ? (
        <div className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 text-body text-warning">
          <div className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0" />
            <div className="space-y-1">
              {highlightedIssues.map((issue) => (
                <p key={issue}>{issue}</p>
              ))}
            </div>
          </div>
        </div>
      ) : null}

      {error || statsError ? (
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-body text-destructive">
          {error || statsError}
        </div>
      ) : null}

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="清理任务总数"
          value={(counts?.total ?? 0).toLocaleString()}
          hint={`涉及 organization ${(listSummary?.organization_count ?? 0).toLocaleString()} 个`}
          icon={Trash2}
        />
        <AdminMetricCard
          title="待执行 / 待重试"
          value={(counts?.due_retry_jobs ?? 0).toLocaleString()}
          hint={`pending ${(counts?.pending ?? 0).toLocaleString()} / failed ${(counts?.failed ?? 0).toLocaleString()}`}
          icon={Clock3}
          tone={(counts?.due_retry_jobs ?? 0) > 0 ? 'warning' : 'success'}
        />
        <AdminMetricCard
          title="卡住中的任务"
          value={(counts?.stuck_running_jobs ?? 0).toLocaleString()}
          hint={`running ${(counts?.running ?? 0).toLocaleString()} / permanent ${(counts?.permanently_failed ?? 0).toLocaleString()}`}
          icon={ShieldAlert}
          tone={
            (counts?.stuck_running_jobs ?? 0) > 0 || (counts?.permanently_failed ?? 0) > 0
              ? 'danger'
              : 'success'
          }
        />
        <AdminMetricCard
          title="近 7 天清理行数"
          value={(statsData?.deleted_rows_last_7d ?? 0).toLocaleString()}
          hint={`完成 ${(counts?.succeeded ?? 0).toLocaleString()} 个 job`}
          icon={CheckCircle2}
          tone="success"
        />
      </div>

      <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
        <AdminListCard
          title="清理任务列表"
          description="按 organization、触发来源和状态筛选，快速定位失败、卡住和待执行任务。"
          actions={
            <div className="flex flex-wrap items-center gap-2 text-body text-muted-foreground">
              <span>过滤后 {listSummary?.counts.total ?? 0} 条</span>
              <span>organization {listSummary?.organization_count ?? 0} 个</span>
              <span>最近更新 {formatDateTime(listSummary?.latest_updated_at)}</span>
            </div>
          }
          contentClassName="space-y-4"
        >
          <div className="grid gap-3 lg:grid-cols-[1.2fr_1fr_1fr_auto]">
            <div className="relative">
              <Search className="absolute left-3 top-2.5 h-4 w-4 text-muted-foreground" />
              <Input
                className="pl-9"
                placeholder="organization / 关键词 / 错误信息"
                value={keywordInput}
                onChange={(event) => setKeywordInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleSearch()
                  }
                }}
              />
            </div>
            <Input
              placeholder="organization_id 过滤"
              value={organizationInput}
              onChange={(event) => setOrganizationInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleSearch()
                }
              }}
            />
            <Input
              placeholder="trigger_source 过滤"
              value={triggerInput}
              onChange={(event) => setTriggerInput(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  handleSearch()
                }
              }}
            />
            <Button onClick={handleSearch}>查询</Button>
          </div>

          <div className="grid gap-3 lg:grid-cols-[180px_1fr_auto_auto]">
            <Select
              value={status}
              onValueChange={(value) => {
                setStatus(value as CleanupStatus)
                setPage(1)
              }}
            >
              <SelectTrigger>
                <SelectValue placeholder="状态" />
              </SelectTrigger>
              <SelectContent>
                {STATUS_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="flex flex-wrap items-center gap-4 rounded-lg border px-3 py-2 text-body">
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={dueOnly}
                  onChange={(event) => {
                    setDueOnly(event.target.checked)
                    setPage(1)
                  }}
                />
                仅看待处理
              </label>
              <label className="inline-flex items-center gap-2">
                <input
                  type="checkbox"
                  checked={stuckOnly}
                  onChange={(event) => {
                    setStuckOnly(event.target.checked)
                    setPage(1)
                  }}
                />
                仅看卡住任务
              </label>
            </div>

            <Badge variant="outline">
              trigger_source {Object.keys(listSummary?.trigger_sources ?? {}).length}
            </Badge>
            <Badge variant="outline">
              failed{' '}
              {(listSummary?.counts.failed ?? 0) + (listSummary?.counts.permanently_failed ?? 0)}
            </Badge>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-body">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">Organization</th>
                  <th className="px-4 py-3 text-left font-medium">来源 / 状态</th>
                  <th className="px-4 py-3 text-left font-medium">尝试次数</th>
                  <th className="px-4 py-3 text-left font-medium">调度时间</th>
                  <th className="px-4 py-3 text-left font-medium">结果摘要</th>
                  <th className="px-4 py-3 text-left font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      <span className="inline-flex items-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        加载 cleanup 队列中...
                      </span>
                    </td>
                  </tr>
                ) : (listData?.jobs.length ?? 0) === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-4 py-12 text-center text-muted-foreground">
                      当前筛选条件下没有 cleanup job
                    </td>
                  </tr>
                ) : (
                  listData?.jobs.map((job) => (
                    <tr key={job.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-4 py-3 align-top">
                        <div className="font-medium">{job.organization_id}</div>
                        <div className="mt-1 text-body text-muted-foreground">
                          job {job.id.slice(0, 12)}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <div className="flex flex-wrap items-center gap-2">
                          <Badge variant="outline">{formatTriggerSource(job.trigger_source)}</Badge>
                          <Badge variant={getStatusBadgeVariant(job.status)}>{job.status}</Badge>
                        </div>
                        {job.last_error ? (
                          <div
                            className="mt-2 max-w-[320px] text-body text-destructive"
                            title={job.last_error}
                          >
                            {job.last_error}
                          </div>
                        ) : null}
                      </td>
                      <td className="px-4 py-3 align-top text-body">
                        <div>
                          {job.attempt_count} / {job.max_attempts}
                        </div>
                        <div className="text-muted-foreground">
                          updated {formatDateTime(job.updated_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top text-body text-muted-foreground">
                        <div>next {formatDateTime(job.next_retry_at)}</div>
                        <div>start {formatDateTime(job.started_at)}</div>
                        <div>end {formatDateTime(job.finished_at)}</div>
                      </td>
                      <td className="px-4 py-3 align-top text-body">
                        <div>
                          删除行数 {getDeletedRows(job.last_success_summary).toLocaleString()}
                        </div>
                        <div className="text-muted-foreground">
                          created {formatDateTime(job.created_at)}
                        </div>
                      </td>
                      <td className="px-4 py-3 align-top">
                        <PermissionGate permission={ADMIN_PERMISSION.ORGANIZATION_CLEANUP_RETRY}>
                          <Button
                            size="sm"
                            variant="outline"
                            disabled={actionLoading || job.status === 'running'}
                            onClick={() => setRetryTarget(job)}
                          >
                            强制重试
                          </Button>
                        </PermissionGate>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between text-body text-muted-foreground">
            <span>
              共 {pagination?.total ?? 0} 条，当前第 {pagination?.page ?? 1} /{' '}
              {pagination?.total_pages ?? 1} 页
            </span>
            <div className="flex items-center gap-2">
              <PageSizeSelect
                value={pageSize}
                onChange={(nextPageSize) => {
                  setPage(1)
                  setPageSize(nextPageSize)
                }}
              />
              <Button
                size="sm"
                variant="outline"
                disabled={!hasPrevPage || loading}
                onClick={() => setPage((current) => Math.max(1, current - 1))}
              >
                上一页
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={!hasNextPage || loading}
                onClick={() => setPage((current) => current + 1)}
              >
                下一页
              </Button>
            </div>
          </div>
        </AdminListCard>

        <div className="space-y-6">
          <AdminListCard
            title="最近失败"
            description="优先关注永久失败和最近失败的 organization。"
            contentClassName="space-y-3"
          >
            {statsLoading ? (
              <div className="py-8 text-body text-muted-foreground">加载中...</div>
            ) : recentFailed.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-10 text-center text-body text-muted-foreground">
                近期没有失败任务
              </div>
            ) : (
              recentFailed.map((job) => (
                <div key={job.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{job.organization_id}</p>
                    <Badge variant={getStatusBadgeVariant(job.status)}>{job.status}</Badge>
                  </div>
                  <p className="mt-2 text-body text-muted-foreground">
                    {formatDateTime(job.updated_at)}
                  </p>
                  <p className="mt-2 text-body text-destructive">{job.last_error || '—'}</p>
                </div>
              ))
            )}
          </AdminListCard>

          <AdminListCard
            title="最近成功"
            description="确认最近 cleanup 确实在落地，而不是只有队列在堆积。"
            contentClassName="space-y-3"
          >
            {statsLoading ? (
              <div className="py-8 text-body text-muted-foreground">加载中...</div>
            ) : recentSucceeded.length === 0 ? (
              <div className="rounded-lg border border-dashed px-4 py-10 text-center text-body text-muted-foreground">
                暂无成功记录
              </div>
            ) : (
              recentSucceeded.map((job) => (
                <div key={job.id} className="rounded-lg border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-medium">{job.organization_id}</p>
                    <Badge variant="success">{job.status}</Badge>
                  </div>
                  <p className="mt-2 text-body text-muted-foreground">
                    {formatDateTime(job.finished_at)}
                  </p>
                  <p className="mt-2 text-body">
                    total_deleted {getDeletedRows(job.last_success_summary).toLocaleString()}
                  </p>
                </div>
              ))
            )}
          </AdminListCard>
        </div>
      </div>

      <ConfirmDialog
        open={runDueOpen}
        onOpenChange={setRunDueOpen}
        title="执行到期 cleanup 队列"
        description="这会立即处理 pending/failed 队列，并尝试恢复卡住的 running job。确认继续吗？"
        confirmLabel="立即执行"
        loading={actionLoading}
        onConfirm={handleRetryDue}
      />
      <SensitiveActionConfirmDialog
        open={Boolean(retryTarget)}
        title="重试 Organization Cleanup Job"
        targetLabel={retryTarget ? `${retryTarget.organization_id} / ${retryTarget.id}` : ''}
        impact="会立即触发一次强制重试，可能再次执行清理动作并改变任务状态。"
        confirmText="重试"
        loading={actionLoading}
        onCancel={() => setRetryTarget(null)}
        onConfirm={(payload) => void handleRetrySingle(payload)}
      />
    </AdminPage>
  )
}
