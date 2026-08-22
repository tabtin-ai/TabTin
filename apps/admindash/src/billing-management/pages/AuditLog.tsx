import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { spaceAdminApi } from '@/api/space-admin'
import { getUserDetail } from '@/api/users'
import { useDebounce } from '@/hooks/useDebounce'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import { ArrowLeft, Clock3, Copy, Loader2, RefreshCw, ShieldCheck, Users, X } from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { type AuditLogItem, listAuditLogs } from '../api/billing-admin'

const DEFAULT_PAGE_SIZE = 20

const ACTION_LABELS: Record<string, string> = {
  wallet_adjust: '钱包调整',
  pricing_create: '创建定价',
  pricing_update: '更新定价',
  pricing_delete: '删除定价',
  budget_create: '创建预算',
  budget_update: '更新预算',
  budget_delete: '删除预算',
  membership_update: '更新会员',
  reconciliation_run: '提交对账任务',
  storage_reconcile_run: '提交存储对账',
  anomaly_alert_resolve: '处理异常告警',
  storage_entitlement_update: '更新存储权益',
  invoice_collect_disabled: '账单收款已停用',
  invoice_batch_collect_disabled: '批量收款已停用',
  invoice_refund: '账单退款',
  organization_cleanup_retry_due: '组织清理到期重试',
  organization_cleanup_retry: '组织清理重试',
  runtime_config_update: '更新运行时配置',
  credit_package_create: '创建点券包',
  credit_package_update: '更新点券包',
  credit_package_delete: '删除点券包',
  addon_package_create: '创建增值包',
  addon_package_update: '更新增值包',
  addon_package_delete: '删除增值包',
  dispute_resolve: '处理计费争议',
}

const TARGET_TYPE_LABELS: Record<string, string> = {
  wallet: '钱包',
  pricing_rule: '定价规则',
  budget_policy: '预算策略',
  membership: '会员',
  organization_membership: '组织会员',
  reconciliation: '对账',
  storage: '存储',
  anomaly_alert: '异常告警',
  organization_billing_entitlement: '组织计费权益',
  invoice: '账单',
  organization_cleanup_job: '组织清理任务',
  runtime_config: '运行时配置',
  credit_package: '点券包',
  addon_package: '增值包',
  billing_dispute: '计费争议',
}

const DETAIL_KEY_LABELS: Record<string, string> = {
  name: '名称',
  addon_code: '增值包编码',
  meter_key: '计量项',
  unit_price: '单价',
  scope: '作用域',
  before: '变更前',
  after: '变更后',
  reason: '原因',
  count: '数量',
  task_id: '任务 ID',
  amount: '金额',
  status: '状态',
}

function formatShortId(value?: string | null, length = 10): string {
  if (!value) {
    return '-'
  }

  return value.length > length ? `${value.slice(0, length)}...` : value
}

function labelAction(action?: string | null): string {
  if (!action) return '-'
  return ACTION_LABELS[action] || action
}

function labelTargetType(targetType?: string | null): string {
  if (!targetType) return '-'
  return TARGET_TYPE_LABELS[targetType] || targetType
}

function summarizeDetail(detail: Record<string, unknown>): string {
  const entries = Object.entries(detail || {})
  if (entries.length === 0) {
    return '-'
  }

  return entries
    .slice(0, 2)
    .map(([key, value]) => `${DETAIL_KEY_LABELS[key] || key}: ${String(value)}`)
    .join(' / ')
}

/** 接口尚未返回名称时，按当前页 ID 补组织名 / 管理员名（仅展示）。 */
async function enrichAuditLogNames(items: AuditLogItem[]): Promise<AuditLogItem[]> {
  const missingOrgIds = [
    ...new Set(
      items
        .filter((item) => {
          const id = item.organization_id || ''
          if (!id || id.startsWith('__')) return false
          return !(item.organization_name || '').trim()
        })
        .map((item) => item.organization_id)
    ),
  ]
  const missingAdminIds = [
    ...new Set(
      items
        .filter((item) => item.admin_user_id && !(item.admin_user_name || '').trim())
        .map((item) => item.admin_user_id)
    ),
  ]

  if (missingOrgIds.length === 0 && missingAdminIds.length === 0) {
    return items
  }

  const [orgEntries, adminEntries] = await Promise.all([
    Promise.all(
      missingOrgIds.map(async (organizationId) => {
        try {
          const org = await spaceAdminApi.getOrganization(organizationId)
          return [organizationId, (org.name || '').trim()] as const
        } catch {
          return [organizationId, ''] as const
        }
      })
    ),
    Promise.all(
      missingAdminIds.map(async (adminUserId) => {
        try {
          const detail = await getUserDetail(adminUserId)
          const user = detail.user
          const name =
            (user.display_name || '').trim() ||
            (user.nickname || '').trim() ||
            (user.username || '').trim()
          return [adminUserId, name] as const
        } catch {
          return [adminUserId, ''] as const
        }
      })
    ),
  ])

  const orgNameMap = Object.fromEntries(orgEntries)
  const adminNameMap = Object.fromEntries(adminEntries)

  return items.map((item) => ({
    ...item,
    organization_name:
      (item.organization_name || '').trim() || orgNameMap[item.organization_id] || item.organization_name,
    admin_user_name:
      (item.admin_user_name || '').trim() || adminNameMap[item.admin_user_id] || item.admin_user_name,
  }))
}

export function AuditLog() {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const loadVersionRef = useRef(0)

  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [logs, setLogs] = useState<AuditLogItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [actionFilter, setActionFilter] = useState('')
  const [targetTypeFilter, setTargetTypeFilter] = useState('')
  const [adminFilter, setAdminFilter] = useState('')
  const debouncedAdmin = useDebounce(adminFilter, 400)
  const [startDate, setStartDate] = useState('')
  const [endDate, setEndDate] = useState('')

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const params: Record<string, string | number | boolean> = {
        page,
        page_size: pageSize,
      }

      if (actionFilter) {
        params.action = actionFilter
      }

      if (targetTypeFilter) {
        params.target_type = targetTypeFilter
      }

      if (debouncedAdmin) {
        params.admin_user_id = debouncedAdmin
      }

      if (startDate) {
        const date = new Date(startDate)
        if (!Number.isNaN(date.getTime())) {
          params.start_date = date.toISOString()
        }
      }

      if (endDate) {
        const date = new Date(endDate)
        if (!Number.isNaN(date.getTime())) {
          params.end_date = date.toISOString()
        }
      }

      const response = await listAuditLogs(params)
      if (loadVersionRef.current !== version) {
        return
      }

      const enriched = await enrichAuditLogNames(response.audit_logs || [])
      if (loadVersionRef.current !== version) {
        return
      }

      setLogs(enriched)
      setTotal(response.total ?? 0)
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setLogs([])
      setLoadError(true)
      showToast('审计日志加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [
    actionFilter,
    debouncedAdmin,
    endDate,
    page,
    pageSize,
    showToast,
    startDate,
    targetTypeFilter,
  ])

  useEffect(() => {
    void load()
  }, [load])

  const clearFilters = () => {
    setActionFilter('')
    setTargetTypeFilter('')
    setAdminFilter('')
    setStartDate('')
    setEndDate('')
    setPage(1)
  }

  const copyTargetId = async (value: string) => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      showToast('已复制对象 ID', 'success')
    } catch {
      showToast('复制失败，请手动复制', 'error')
    }
  }

  const activeFilterCount = [
    actionFilter,
    targetTypeFilter,
    adminFilter,
    startDate,
    endDate,
  ].filter(Boolean).length
  const adminCount = new Set(logs.map((log) => log.admin_user_id).filter(Boolean)).size
  const targetTypeCount = new Set(logs.map((log) => log.target_type).filter(Boolean)).size
  const detailCount = logs.filter((log) => Object.keys(log.detail ?? {}).length > 0).length

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="审计日志"
        icon={ShieldCheck}
        badges={
          <>
            <Badge variant="outline">总记录 {total}</Badge>
            {actionFilter ? (
              <Badge variant="secondary">操作：{labelAction(actionFilter)}</Badge>
            ) : null}
            {targetTypeFilter ? (
              <Badge variant="secondary">目标：{labelTargetType(targetTypeFilter)}</Badge>
            ) : null}
            {activeFilterCount > 0 ? (
              <Badge variant="outline">筛选条件 {activeFilterCount}</Badge>
            ) : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/billing')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回计费首页
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="当前页日志数"
          value={logs.length.toLocaleString()}
          hint="当前页加载到的审计记录数量。"
          icon={Clock3}
        />
        <AdminMetricCard
          title="涉及管理员"
          value={adminCount.toLocaleString()}
          hint="当前页去重后的管理员数量。"
          icon={Users}
        />
        <AdminMetricCard
          title="目标类型"
          value={targetTypeCount.toLocaleString()}
          hint="当前页涉及的钱包、定价、预算、会员类型数。"
          icon={ShieldCheck}
        />
        <AdminMetricCard
          title="带详情记录"
          value={detailCount.toLocaleString()}
          hint="detail 字段非空的日志更适合回看变更内容。"
          icon={RefreshCw}
        />
      </div>

      <AdminListCard
        title="筛选条件"
        description="从操作类型、目标类型、管理员和时间范围中缩小排查范围。"
        actions={
          activeFilterCount > 0 ? (
            <Button variant="ghost" size="sm" onClick={clearFilters}>
              <X className="mr-2 h-4 w-4" />
              清空筛选
            </Button>
          ) : null
        }
      >
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          <Select
            value={actionFilter || '__all__'}
            onValueChange={(value) => {
              setActionFilter(value === '__all__' ? '' : value)
              setPage(1)
            }}
          >
            <SelectTrigger aria-label="操作类型筛选">
              <SelectValue placeholder="操作类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部操作</SelectItem>
              {Object.entries(ACTION_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Select
            value={targetTypeFilter || '__all__'}
            onValueChange={(value) => {
              setTargetTypeFilter(value === '__all__' ? '' : value)
              setPage(1)
            }}
          >
            <SelectTrigger aria-label="目标类型筛选">
              <SelectValue placeholder="目标类型" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__all__">全部目标</SelectItem>
              {Object.entries(TARGET_TYPE_LABELS).map(([key, label]) => (
                <SelectItem key={key} value={key}>
                  {label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>

          <Input
            placeholder="管理员 ID"
            aria-label="管理员 ID 筛选"
            value={adminFilter}
            onChange={(event) => {
              setAdminFilter(event.target.value)
              setPage(1)
            }}
          />

          <Input
            type="datetime-local"
            aria-label="开始时间"
            value={startDate}
            onChange={(event) => {
              setStartDate(event.target.value)
              setPage(1)
            }}
          />

          <Input
            type="datetime-local"
            aria-label="结束时间"
            value={endDate}
            onChange={(event) => {
              setEndDate(event.target.value)
              setPage(1)
            }}
          />
        </div>
      </AdminListCard>

      <AdminListCard
        title="日志明细"
        description="逐条查看时间、操作、目标、管理员和变更摘要。"
        contentClassName="space-y-4 px-0"
        actions={
          <Badge variant="outline">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
          </Badge>
        }
      >
        {loading && logs.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">审计日志加载失败，请稍后重试。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="审计日志列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">时间</th>
                    <th className="px-3 py-3 text-left font-medium">操作</th>
                    <th className="px-3 py-3 text-left font-medium">目标</th>
                    <th className="px-3 py-3 text-left font-medium">对象 ID</th>
                    <th className="px-3 py-3 text-left font-medium">组织</th>
                    <th className="px-3 py-3 text-left font-medium">管理员</th>
                    <th className="px-3 py-3 text-left font-medium">IP</th>
                    <th className="px-3 py-3 text-left font-medium">详情摘要</th>
                  </tr>
                </thead>
                <tbody>
                  {logs.length === 0 ? (
                    <tr>
                      <td
                        colSpan={8}
                        className="px-3 py-12 text-center text-body text-muted-foreground"
                      >
                        暂无审计日志
                      </td>
                    </tr>
                  ) : (
                    logs.map((log) => {
                      const organizationName = (log.organization_name || '').trim()
                      const adminName = (log.admin_user_name || '').trim()
                      return (
                        <tr key={log.id} className="border-b last:border-0 hover:bg-muted/20">
                          <td className="whitespace-nowrap px-3 py-3 text-body text-muted-foreground">
                            {formatDateTime(log.created_at)}
                          </td>
                          <td className="px-3 py-3">
                            <Badge variant="outline">{labelAction(log.action)}</Badge>
                          </td>
                          <td className="px-3 py-3">{labelTargetType(log.target_type)}</td>
                          <td className="px-3 py-3 text-body">
                            {log.target_id ? (
                              <button
                                type="button"
                                className="inline-flex items-center gap-1 font-mono hover:text-primary"
                                title={`复制对象 ID：${log.target_id}`}
                                aria-label="复制对象 ID"
                                onClick={() => void copyTargetId(log.target_id)}
                              >
                                {formatShortId(log.target_id, 14)}
                                <Copy className="h-3 w-3 shrink-0" />
                              </button>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="px-3 py-3 text-body" title={log.organization_id || undefined}>
                            {log.organization_id ? (
                              <div>
                                <div>{organizationName || '未知组织'}</div>
                                <div className="mt-0.5 font-mono text-caption text-muted-foreground">
                                  {log.organization_id}
                                </div>
                              </div>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="px-3 py-3 text-body" title={log.admin_user_id || undefined}>
                            {log.admin_user_id ? (
                              <div>
                                <div>{adminName || '未知管理员'}</div>
                                <div className="mt-0.5 font-mono text-caption text-muted-foreground">
                                  {log.admin_user_id}
                                </div>
                              </div>
                            ) : (
                              '-'
                            )}
                          </td>
                          <td className="px-3 py-3 text-body">{log.ip_address || '-'}</td>
                          <td
                            className="max-w-[280px] px-3 py-3 text-body text-muted-foreground"
                            title={JSON.stringify(log.detail ?? {})}
                          >
                            <div className="truncate">{summarizeDetail(log.detail ?? {})}</div>
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
    </AdminPage>
  )
}
