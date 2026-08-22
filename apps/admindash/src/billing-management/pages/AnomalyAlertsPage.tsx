import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Pagination } from '@/components/ui/pagination'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { formatDateTime } from '@/lib/utils'
import {
  AlertTriangle,
  ArrowLeft,
  CheckCircle2,
  Loader2,
  RefreshCw,
  ShieldAlert,
  TrendingUp,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { type AnomalyAlert, listAnomalyAlerts, resolveAnomalyAlert } from '../api/billing-admin'

const DEFAULT_PAGE_SIZE = 20

const SEVERITY_LABEL: Record<string, string> = {
  info: '信息',
  warning: '警告',
  critical: '严重',
}

const TYPE_LABEL: Record<string, string> = {
  spike: '消费突增',
  abuse: '疑似滥用',
  pattern: '异常模式',
  charge_failed: '计费失败',
  cleanup_failed: '清理失败',
  frozen_leak: '冻结泄漏',
  refund_inconsistency: '退款不一致',
  zero_price_model: '零价模型',
  event_update_failed: '事件更新失败',
}

const ALERT_TYPE_OPTIONS = Object.entries(TYPE_LABEL).map(([value, label]) => ({
  value,
  label,
}))

function getSeverityVariant(severity: string) {
  if (severity === 'critical') {
    return 'destructive' as const
  }

  if (severity === 'warning') {
    return 'warning' as const
  }

  if (severity === 'info') {
    return 'secondary' as const
  }

  return 'outline' as const
}

function formatShortId(value?: string | null): string {
  if (!value) {
    return '-'
  }

  return value.length > 8 ? `${value.slice(0, 8)}...` : value
}

export function AnomalyAlertsPage() {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const loadVersionRef = useRef(0)

  const [items, setItems] = useState<AnomalyAlert[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [severityFilter, setSeverityFilter] = useState('')
  const [resolvedFilter, setResolvedFilter] = useState('')
  const [alertTypeFilter, setAlertTypeFilter] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [resolvingId, setResolvingId] = useState<string | null>(null)

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const data = await listAnomalyAlerts({
        page,
        page_size: pageSize,
        severity: severityFilter || undefined,
        is_resolved: resolvedFilter || undefined,
        alert_type: alertTypeFilter || undefined,
      })

      if (loadVersionRef.current !== version) {
        return
      }

      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setItems([])
      setLoadError(true)
      showToast('异常告警加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [page, pageSize, resolvedFilter, severityFilter, alertTypeFilter, showToast])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = setInterval(() => {
      void load()
    }, 5000)
    return () => clearInterval(timer)
  }, [autoRefresh, load])

  const failOpenCount24h = items.filter(
    (a) =>
      !a.is_resolved &&
      (a.alert_type === 'charge_failed' || a.alert_type === 'pattern') &&
      new Date(a.created_at).getTime() > Date.now() - 24 * 60 * 60 * 1000
  ).length

  const handleResolve = async (alertId: string) => {
    setResolvingId(alertId)

    try {
      await resolveAnomalyAlert(alertId)
      showToast('异常告警已标记为处理完成', 'success')
      void load()
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '处理失败', 'error')
    } finally {
      setResolvingId(null)
    }
  }

  const unresolvedCount = items.filter((item) => !item.is_resolved).length
  const criticalCount = items.filter((item) => item.severity === 'critical').length
  const warningCount = items.filter((item) => item.severity === 'warning').length
  const resolvedCount = items.filter((item) => item.is_resolved).length

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="异常与预算"
        icon={ShieldAlert}
        badges={
          <>
            <Badge variant="outline">总告警 {total}</Badge>
            {severityFilter ? (
              <Badge variant={getSeverityVariant(severityFilter)}>
                级别：{SEVERITY_LABEL[severityFilter] || severityFilter}
              </Badge>
            ) : null}
            {resolvedFilter ? (
              <Badge variant={resolvedFilter === 'false' ? 'warning' : 'success'}>
                {resolvedFilter === 'false' ? '仅未处理' : '仅已处理'}
              </Badge>
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
            <Button variant="outline" size="sm" onClick={() => navigate('/billing/budget')}>
              预算策略
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="未处理"
          value={unresolvedCount.toLocaleString()}
          hint="建议优先处理未关闭的异常。"
          icon={AlertTriangle}
          tone={unresolvedCount > 0 ? 'warning' : 'default'}
        />
        <AdminMetricCard
          title="严重告警"
          value={criticalCount.toLocaleString()}
          hint="严重告警通常需要立即介入。"
          icon={ShieldAlert}
          tone={criticalCount > 0 ? 'danger' : 'default'}
        />
        <AdminMetricCard
          title="警告级"
          value={warningCount.toLocaleString()}
          hint="警告级适合纳入观察和回访。"
          icon={TrendingUp}
          tone={warningCount > 0 ? 'warning' : 'default'}
        />
        <AdminMetricCard
          title="已处理"
          value={resolvedCount.toLocaleString()}
          hint="当前页已完成处理闭环的告警数。"
          icon={CheckCircle2}
          tone={resolvedCount > 0 ? 'success' : 'default'}
        />
        <AdminMetricCard
          title="24h fail-open 累计"
          value={failOpenCount24h.toLocaleString()}
          hint="近 24 小时内 charge_failed/pattern 类型的未处理告警。按 organization 聚合后超过阈值应触发硬阻断。"
          icon={ShieldAlert}
          tone={failOpenCount24h > 10 ? 'danger' : failOpenCount24h > 0 ? 'warning' : 'default'}
        />
      </div>

      <AdminListCard
        title="筛选"
        description="按严重程度、处理状态和异常类型缩小范围。"
        actions={
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select
              value={severityFilter || '__all__'}
              onValueChange={(value) => {
                setSeverityFilter(value === '__all__' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full sm:w-36" aria-label="按严重程度筛选">
                <SelectValue placeholder="全部级别" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部级别</SelectItem>
                <SelectItem value="critical">严重</SelectItem>
                <SelectItem value="warning">警告</SelectItem>
                <SelectItem value="info">信息</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={resolvedFilter || '__all__'}
              onValueChange={(value) => {
                setResolvedFilter(value === '__all__' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full sm:w-36" aria-label="按处理状态筛选">
                <SelectValue placeholder="处理状态" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部状态</SelectItem>
                <SelectItem value="false">未处理</SelectItem>
                <SelectItem value="true">已处理</SelectItem>
              </SelectContent>
            </Select>

            <Select
              value={alertTypeFilter || '__all__'}
              onValueChange={(value) => {
                setAlertTypeFilter(value === '__all__' ? '' : value)
                setPage(1)
              }}
            >
              <SelectTrigger className="w-full sm:w-40" aria-label="按告警类型筛选">
                <SelectValue placeholder="全部类型" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="__all__">全部类型</SelectItem>
                {ALERT_TYPE_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <Button
              variant={autoRefresh ? 'default' : 'outline'}
              size="sm"
              onClick={() => setAutoRefresh((prev) => !prev)}
            >
              {autoRefresh ? '⏸ 暂停轮询' : '▶ 启动轮询'}
            </Button>
          </div>
        }
      >
        <div className="rounded-lg border border-border/60 bg-muted/20 p-4 text-body text-muted-foreground">
          <p>异常告警会基于消费行为和计费模式自动生成。</p>
          <p className="mt-2">
            当出现 `critical` 且未处理的告警时，建议优先核对对应用户或组织的近期操作。
          </p>
        </div>
      </AdminListCard>

      <AdminListCard
        title="告警列表"
        description="查看异常说明、关联对象，并可标记处理。"
        contentClassName="space-y-4"
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
            <p className="text-body text-muted-foreground">异常告警加载失败，请稍后重试。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : items.length === 0 ? (
          <div className="py-16 text-center text-body text-muted-foreground">暂无告警。</div>
        ) : (
          <div className="space-y-3">
            {items.map((alert) => (
              <div
                key={alert.id}
                className={`rounded-lg border p-4 ${alert.is_resolved ? 'opacity-70' : ''}`}
              >
                <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                  <div className="min-w-0 flex-1 space-y-3">
                    <div className="flex flex-wrap items-center gap-2">
                      <Badge variant={getSeverityVariant(alert.severity)}>
                        {SEVERITY_LABEL[alert.severity] || alert.severity}
                      </Badge>
                      <Badge variant="outline">
                        {TYPE_LABEL[alert.alert_type] || alert.alert_type}
                      </Badge>
                      <Badge variant={alert.is_resolved ? 'success' : 'warning'}>
                        {alert.is_resolved ? '已处理' : '待处理'}
                      </Badge>
                    </div>

                    <div>
                      <p className="text-body font-medium">{alert.message}</p>
                      <p className="mt-1 text-body text-muted-foreground">
                        指标：{alert.metric_name || '-'}，阈值倍数：{alert.threshold_ratio ?? 0}
                      </p>
                    </div>

                    <div className="grid gap-2 text-body text-muted-foreground sm:grid-cols-2 xl:grid-cols-4">
                      <div>
                        <span className="block">用户</span>
                        <span className="font-mono text-foreground">
                          {formatShortId(alert.user_id)}
                        </span>
                      </div>
                      <div>
                        <span className="block">组织</span>
                        <span className="font-mono text-foreground">
                          {formatShortId(alert.organization_id)}
                        </span>
                      </div>
                      <div>
                        <span className="block">当前值 / 基线值</span>
                        <span className="text-foreground">
                          {(alert.current_value ?? 0).toFixed(2)} /{' '}
                          {(alert.baseline_value ?? 0).toFixed(2)}
                        </span>
                      </div>
                      <div>
                        <span className="block">创建时间</span>
                        <span className="text-foreground">{formatDateTime(alert.created_at)}</span>
                      </div>
                    </div>
                  </div>

                  <div className="flex flex-col items-start gap-2 lg:items-end">
                    {alert.resolved_at ? (
                      <p className="text-body text-muted-foreground">
                        处理时间：{formatDateTime(alert.resolved_at)}
                      </p>
                    ) : null}
                    {!alert.is_resolved ? (
                      <Button
                        size="sm"
                        onClick={() => void handleResolve(alert.id)}
                        disabled={resolvingId === alert.id}
                      >
                        {resolvingId === alert.id ? (
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                        ) : (
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                        )}
                        标记已处理
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

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
      </AdminListCard>
    </AdminPage>
  )
}
