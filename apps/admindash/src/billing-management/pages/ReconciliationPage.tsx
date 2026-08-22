import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { spaceAdminApi } from '@/api/space-admin'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import { ArrowLeft, Loader2, RefreshCw, Scale, ShieldAlert, Wallet } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  type ReconciliationReport,
  listReconciliationReports,
  runReconciliation,
} from '../api/billing-admin'
import { getTaskRunFeedback } from '../api/task-run-result'

const DEFAULT_PAGE_SIZE = 20

const STATUS_LABEL: Record<string, string> = {
  matched: '匹配',
  warning: '差异预警',
  mismatch: '不匹配',
}

function getStatusVariant(status: string) {
  if (status === 'matched') {
    return 'success' as const
  }

  if (status === 'warning') {
    return 'warning' as const
  }

  if (status === 'mismatch') {
    return 'destructive' as const
  }

  return 'outline' as const
}

function formatShortId(value?: string | null, length = 14): string {
  if (!value) return '-'
  return value.length > length ? `${value.slice(0, length)}...` : value
}

function isOrganizationRowId(organizationId?: string | null): boolean {
  const id = (organizationId || '').trim()
  if (!id || id.startsWith('__')) return false
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)
}

function organizationRowLabel(organizationId?: string | null): string {
  const id = (organizationId || '').trim()
  if (!id) return '全局汇总'
  if (id === '__storage_reconcile__') return '存储对账'
  if (id.startsWith('__')) return id
  return ''
}

/** 接口尚未返回组织名时，按当前页 ID 补名称（仅展示）。 */
async function enrichOrganizationNames(
  items: ReconciliationReport[]
): Promise<ReconciliationReport[]> {
  const missingIds = [
    ...new Set(
      items
        .filter((item) => {
          const id = item.organization_id || ''
          // 跳过全局汇总空串与存储对账哨兵等非 Organization UUID
          if (!id || id.startsWith('__')) return false
          return !(item.organization_name || '').trim()
        })
        .map((item) => item.organization_id)
    ),
  ]
  if (missingIds.length === 0) {
    return items
  }

  const nameEntries = await Promise.all(
    missingIds.map(async (organizationId) => {
      try {
        const org = await spaceAdminApi.getOrganization(organizationId)
        return [organizationId, (org.name || '').trim()] as const
      } catch {
        return [organizationId, ''] as const
      }
    })
  )
  const nameMap = Object.fromEntries(nameEntries)

  return items.map((item) => {
    const existing = (item.organization_name || '').trim()
    if (existing || !item.organization_id) {
      return item
    }
    const resolved = nameMap[item.organization_id]
    return resolved ? { ...item, organization_name: resolved } : item
  })
}

export function ReconciliationPage() {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const loadVersionRef = useRef(0)

  const [items, setItems] = useState<ReconciliationReport[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [statusFilter, setStatusFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [running, setRunning] = useState(false)
  const [showRunConfirm, setShowRunConfirm] = useState(false)

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const data = await listReconciliationReports({
        page,
        page_size: pageSize,
        status: statusFilter || undefined,
      })

      if (loadVersionRef.current !== version) {
        return
      }

      const enriched = await enrichOrganizationNames(data.items || [])
      if (loadVersionRef.current !== version) {
        return
      }

      setItems(enriched)
      setTotal(data.total || 0)
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setItems([])
      setLoadError(true)
      showToast('对账报告加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [page, pageSize, showToast, statusFilter])

  useEffect(() => {
    void load()
  }, [load])

  const handleRunReconciliation = async () => {
    setRunning(true)

    try {
      const result = await runReconciliation()
      const feedback = getTaskRunFeedback(result)
      if (!feedback.submitted) {
        showToast(feedback.message, 'error')
        return
      }
      showToast(`对账任务已提交（task: ${result.task_id.slice(0, 8)}）`, 'success')
      window.setTimeout(() => {
        void load()
      }, 3000)
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '手动对账执行失败', 'error')
      throw error
    } finally {
      setRunning(false)
    }
  }

  const matchedCount = items.filter((item) => item.status === 'matched').length
  const warningCount = items.filter((item) => item.status === 'warning').length
  const mismatchCount = items.filter((item) => item.status === 'mismatch').length
  const totalDiff = items.reduce((sum, item) => sum + Math.abs(item.diff_amount ?? 0), 0)

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="对账任务"
        icon={Scale}
        badges={
          <>
            <Badge variant="outline">总记录 {total}</Badge>
            {statusFilter ? (
              <Badge variant={getStatusVariant(statusFilter)}>
                筛选：{STATUS_LABEL[statusFilter] || statusFilter}
              </Badge>
            ) : null}
            <Badge variant={mismatchCount > 0 ? 'destructive' : 'outline'}>
              不匹配 {mismatchCount}
            </Badge>
          </>
        }
        actions={
          <>
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate('/billing/payment-orders')}
            >
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回账单与对账
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
            <Button size="sm" onClick={() => setShowRunConfirm(true)} disabled={running}>
              {running ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Wallet className="mr-2 h-4 w-4" />
              )}
              提交对账任务
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="匹配"
          value={matchedCount.toLocaleString()}
          hint="当前页已完全匹配的对账记录。"
          icon={Wallet}
          tone={matchedCount > 0 ? 'success' : 'default'}
        />
        <AdminMetricCard
          title="差异预警"
          value={warningCount.toLocaleString()}
          hint="存在轻微差异，建议跟进但未必阻塞。"
          icon={ShieldAlert}
          tone={warningCount > 0 ? 'warning' : 'default'}
        />
        <AdminMetricCard
          title="不匹配"
          value={mismatchCount.toLocaleString()}
          hint="高优先级问题，建议优先处理。"
          icon={Scale}
          tone={mismatchCount > 0 ? 'danger' : 'default'}
        />
        <AdminMetricCard
          title="当前页绝对差额"
          value={totalDiff.toFixed(2)}
          hint="用于感知当前页问题记录的总体影响规模。"
          icon={RefreshCw}
          tone={totalDiff > 0 ? 'warning' : 'default'}
        />
      </div>

      <AdminListCard
        title="筛选与任务触发"
        description="按状态筛选差异，必要时重新提交对账任务。"
        actions={
          <Select
            value={statusFilter || '__all__'}
            onValueChange={(value) => {
              setStatusFilter(value === '__all__' ? '' : value)
              setPage(1)
            }}
          >
            <SelectTrigger className="w-40" aria-label="按状态筛选">
              <SelectValue placeholder="全部状态" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部状态</SelectItem>
              <SelectItem value="matched">匹配</SelectItem>
              <SelectItem value="warning">差异预警</SelectItem>
              <SelectItem value="mismatch">不匹配</SelectItem>
            </SelectContent>
          </Select>
        }
      >
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-body text-muted-foreground">
          <p>对账会每日对比 `BillingUsageEvent` 与 `WalletTransaction` 的消费记录。</p>
          <p className="mt-2">
            当前页如存在大量 `warning / mismatch`，建议先刷新一次，再决定是否重跑对账。
          </p>
        </div>
      </AdminListCard>

      <AdminListCard
        title="对账记录"
        description="查看每个 Organization 的计费金额、钱包扣款和差异。"
        contentClassName="space-y-4 px-0"
        actions={
          <Badge variant="outline">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
          </Badge>
        }
      >
        {loading && items.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">对账报告加载失败，请稍后重试。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="对账报告列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">日期</th>
                    <th className="px-4 py-3 text-left font-medium">组织</th>
                    <th className="px-4 py-3 text-right font-medium">计费金额</th>
                    <th className="px-4 py-3 text-right font-medium">钱包扣款</th>
                    <th className="px-4 py-3 text-right font-medium">差额</th>
                    <th className="px-4 py-3 text-right font-medium">差异%</th>
                    <th className="px-4 py-3 text-center font-medium">状态</th>
                    <th className="px-4 py-3 text-left font-medium">生成时间</th>
                  </tr>
                </thead>
                <tbody>
                  {items.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-4 py-12 text-center text-body text-muted-foreground"
                      >
                        暂无对账记录
                      </td>
                    </tr>
                  ) : (
                    items.map((item) => {
                      const organizationName = (item.organization_name || '').trim()
                      const isOrgRow = isOrganizationRowId(item.organization_id)
                      const nonOrgLabel = organizationRowLabel(item.organization_id)
                      return (
                      <tr key={item.id} className="border-b last:border-0 hover:bg-muted/20">
                        <td className="px-4 py-3 font-mono text-body">{item.report_date}</td>
                        <td className="px-4 py-3 text-body">
                          {isOrgRow ? (
                            <button
                              type="button"
                              className="text-left text-primary underline-offset-4 hover:underline"
                              title={`查看组织：${item.organization_id}`}
                              onClick={() => navigate(`/organizations/${item.organization_id}`)}
                            >
                              <span className="font-medium">
                                {organizationName || '未知组织'}
                              </span>
                              <span className="mt-0.5 block font-mono text-caption text-muted-foreground">
                                {formatShortId(item.organization_id, 14)}
                              </span>
                            </button>
                          ) : (
                            <span className="text-muted-foreground">{nonOrgLabel}</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          {item.billing_total.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">
                          {item.wallet_total.toFixed(2)}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono ${
                            item.diff_amount === 0 ? 'text-muted-foreground' : 'text-destructive'
                          }`}
                        >
                          {item.diff_amount.toFixed(2)}
                        </td>
                        <td className="px-4 py-3 text-right font-mono">{item.diff_pct ?? 0}%</td>
                        <td className="px-4 py-3 text-center">
                          <Badge variant={getStatusVariant(item.status)}>
                            {STATUS_LABEL[item.status] || item.status}
                          </Badge>
                        </td>
                        <td className="px-4 py-3 text-body text-muted-foreground">
                          {formatDateTime(item.created_at)}
                        </td>
                      </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            <div className="px-6 pb-6">
              <nav aria-label="分页导航">
                <Pagination
                  page={page}
                  total={total}
                  pageSize={pageSize}
                  onChange={setPage}
                  onPageSizeChange={(nextPageSize) => {
                    setPage(1)
                    setPageSize(nextPageSize)
                  }}
                />
              </nav>
            </div>
          </>
        )}
      </AdminListCard>

      <ConfirmDialog
        open={showRunConfirm}
        onOpenChange={setShowRunConfirm}
        title="确认提交对账任务"
        description="该操作会触发新一轮对账计算，适合在怀疑结果过旧或已修复数据后重新核对。"
        confirmLabel="确认提交"
        loading={running}
        onConfirm={handleRunReconciliation}
      />
    </AdminPage>
  )
}
