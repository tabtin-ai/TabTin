import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import { Input } from '@/components/ui/input'
import { Pagination } from '@/components/ui/pagination'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import {
  AlertTriangle,
  ArrowLeft,
  Loader2,
  Pencil,
  Plus,
  RefreshCw,
  Shield,
  Trash2,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { formatDateTime } from '@/lib/utils'
import {
  type BudgetPolicy,
  createBudgetPolicy,
  deleteBudgetPolicy,
  getUsageAlerts,
  listBudgetPolicies,
  updateBudgetPolicy,
} from '../api/billing-admin'
import { SortableHeader, toggleSort } from '../components/SortableHeader'

const DEFAULT_PAGE_SIZE = 20

const EMPTY_FORM = {
  organization_id: '',
  warning_threshold_percent: 80,
  critical_threshold_percent: 100,
  block_on_critical: false,
  is_active: true,
}


export function BudgetManagement() {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const [loading, setLoading] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const [policies, setPolicies] = useState<BudgetPolicy[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [alerts, setAlerts] = useState<Array<Record<string, unknown>>>([])
  const [showForm, setShowForm] = useState(false)
  const [editId, setEditId] = useState<string | null>(null)
  const [form, setForm] = useState(EMPTY_FORM)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null)
  const [sort, setSort] = useState('')
  const loadVersionRef = useRef(0)

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError(false)

    try {
      const params: Record<string, string | number | boolean> = {
        page,
        page_size: pageSize,
      }

      if (sort) {
        params.order_by = sort
      }

      const [policyResponse, alertResponse] = await Promise.all([
        listBudgetPolicies(params),
        getUsageAlerts().catch(() => ({
          alerts: [],
          summary: { total_alerts: 0, critical_alerts: 0, warning_alerts: 0 },
        })),
      ])

      if (loadVersionRef.current !== version) {
        return
      }

      setPolicies(policyResponse.policies)
      setTotal(policyResponse.total)
      setAlerts((alertResponse?.alerts || []) as Array<Record<string, unknown>>)
    } catch {
      if (loadVersionRef.current !== version) {
        return
      }

      setPolicies([])
      setLoadError(true)
      showToast('加载失败，请稍后重试', 'error')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [page, pageSize, showToast, sort])

  useEffect(() => {
    void load()
  }, [load])

  const openCreate = () => {
    setEditId(null)
    setForm(EMPTY_FORM)
    setShowForm(true)
  }

  const openEdit = (policy: BudgetPolicy) => {
    setEditId(policy.id)
    setForm({
      organization_id: policy.organization_id,
      warning_threshold_percent: policy.warning_threshold_percent,
      critical_threshold_percent: policy.critical_threshold_percent,
      block_on_critical: policy.block_on_critical,
      is_active: policy.is_active,
    })
    setShowForm(true)
  }

  const handleSave = async () => {
    setSaving(true)

    try {
      if (editId) {
        await updateBudgetPolicy(editId, form)
      } else {
        await createBudgetPolicy(form)
      }

      setShowForm(false)
      showToast('保存成功', 'success')
      void load()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '保存失败', 'error')
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteTarget) {
      return
    }

    try {
      await deleteBudgetPolicy(deleteTarget)
      setDeleteTarget(null)
      showToast('删除成功', 'success')
      void load()
    } catch (error) {
      showToast(error instanceof Error ? error.message : '删除失败', 'error')
      throw error
    }
  }

  const activePolicies = policies.filter((policy) => policy.is_active).length
  const blockPolicies = policies.filter((policy) => policy.block_on_critical).length
  const criticalAlerts = alerts.filter((alert) => alert.severity === 'critical').length
  const invalidThresholds = form.critical_threshold_percent < form.warning_threshold_percent

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="预算风险"
        icon={Shield}
        badges={
          <>
            <Badge variant="outline">共 {total} 条策略</Badge>
            {alerts.length > 0 ? (
              <Badge variant={criticalAlerts > 0 ? 'destructive' : 'warning'}>
                {alerts.length} 条预算告警
              </Badge>
            ) : (
              <Badge variant="success">当前无预算告警</Badge>
            )}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/billing/anomalies')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回异常与预算
            </Button>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
            <Button size="sm" onClick={openCreate}>
              <Plus className="mr-2 h-4 w-4" />
              新建策略
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="策略总数"
          value={total.toLocaleString()}
          hint="当前页筛选下的预算策略总量。"
          icon={Shield}
        />
        <AdminMetricCard
          title="启用策略"
          value={activePolicies.toLocaleString()}
          hint="启用策略才会持续监控预算消耗。"
          tone={activePolicies > 0 ? 'success' : 'warning'}
          icon={RefreshCw}
        />
        <AdminMetricCard
          title="阻断策略"
          value={blockPolicies.toLocaleString()}
          hint="达到严重阈值后会直接阻断新增消费。"
          tone={blockPolicies > 0 ? 'warning' : 'default'}
          icon={AlertTriangle}
        />
        <AdminMetricCard
          title="未清预算告警"
          value={alerts.length.toLocaleString()}
          hint={alerts.length > 0 ? '建议优先检查告警策略是否需要收紧。' : '预算运行稳定。'}
          tone={criticalAlerts > 0 ? 'danger' : alerts.length > 0 ? 'warning' : 'success'}
          icon={AlertTriangle}
        />
      </div>

      {alerts.length > 0 ? (
        <AdminListCard
          title="待处理预算告警"
          description="先处理已触发风险，再维护阈值。"
          actions={
            <Button variant="outline" size="sm" onClick={() => navigate('/billing/anomalies')}>
              查看异常告警
            </Button>
          }
          contentClassName="space-y-3"
        >
          {alerts.slice(0, 5).map((alert) => {
            const key = `${String(alert.organization_id ?? 'unknown')}-${String(alert.message ?? 'alert')}`
            const isCritical = alert.severity === 'critical'

            return (
              <div
                key={key}
                className="rounded-lg border border-warning/30 bg-warning/10 px-4 py-3 dark:border-warning/30 dark:bg-warning/10"
              >
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={isCritical ? 'destructive' : 'warning'}>
                    {isCritical ? '严重告警' : '预算预警'}
                  </Badge>
                  <span className="text-body font-medium">
                    {String(alert.organization_id || '未知组织')}
                  </span>
                </div>
                <p className="mt-2 text-body text-warning dark:text-warning">
                  {String(
                    alert.message ||
                      `${alert.organization_id || '未知组织'} 当前预算消耗已触发告警阈值。`
                  )}
                </p>
              </div>
            )
          })}
        </AdminListCard>
      ) : null}

      {showForm ? (
        <AdminListCard
          title={editId ? '编辑预算策略' : '新建预算策略'}
          description="建议保持严重阈值不低于警告阈值，避免策略误触发。"
          contentClassName="space-y-4"
          actions={
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
              取消编辑
            </Button>
          }
        >
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
            <div>
              <label className="text-body font-medium" htmlFor="budget-organization-id">
                组织 ID
              </label>
              <Input
                id="budget-organization-id"
                className="mt-1"
                value={form.organization_id}
                onChange={(event) =>
                  setForm((current) => ({ ...current, organization_id: event.target.value }))
                }
                disabled={!!editId}
              />
            </div>
            <div>
              <label className="text-body font-medium" htmlFor="budget-warning-threshold">
                警告阈值 %
              </label>
              <Input
                id="budget-warning-threshold"
                className="mt-1"
                type="number"
                value={form.warning_threshold_percent}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    warning_threshold_percent: Number(event.target.value),
                  }))
                }
              />
            </div>
            <div>
              <label className="text-body font-medium" htmlFor="budget-critical-threshold">
                严重阈值 %
              </label>
              <Input
                id="budget-critical-threshold"
                className="mt-1"
                type="number"
                value={form.critical_threshold_percent}
                onChange={(event) =>
                  setForm((current) => ({
                    ...current,
                    critical_threshold_percent: Number(event.target.value),
                  }))
                }
              />
            </div>
            <div className="flex items-end gap-6">
              <div className="flex items-center gap-2 text-body">
                <Checkbox
                  id="budget-block-on-critical"
                  checked={form.block_on_critical}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      block_on_critical: checked === true,
                    }))
                  }
                />
                <label htmlFor="budget-block-on-critical">严重时阻断</label>
              </div>
              <div className="flex items-center gap-2 text-body">
                <Checkbox
                  id="budget-is-active"
                  checked={form.is_active}
                  onCheckedChange={(checked) =>
                    setForm((current) => ({
                      ...current,
                      is_active: checked === true,
                    }))
                  }
                />
                <label htmlFor="budget-is-active">启用策略</label>
              </div>
            </div>
          </div>

          {invalidThresholds ? (
            <p className="text-body text-destructive">严重阈值不能低于警告阈值。</p>
          ) : (
            <p className="text-body text-muted-foreground">
              勾选“严重时阻断”后，该组织达到严重阈值时会停止新增消费。
            </p>
          )}

          <div className="flex gap-2">
            <Button
              size="sm"
              onClick={() => void handleSave()}
              disabled={saving || !form.organization_id.trim() || invalidThresholds}
            >
              {saving ? '保存中...' : '保存策略'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setShowForm(false)}>
              取消
            </Button>
          </div>
        </AdminListCard>
      ) : null}

      <AdminListCard
        title="预算策略列表"
        description="按 Organization 查看阈值、阻断状态和更新时间。"
        contentClassName="space-y-4 px-0"
        actions={
          <Badge variant="outline">
            第 {page} / {Math.max(1, Math.ceil(total / pageSize))} 页
          </Badge>
        }
      >
        {loading && policies.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">预算策略加载失败，请检查网络后重试。</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="预算策略列表">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 text-left">
                      <SortableHeader
                        label="组织"
                        field="organization_id"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-4 py-3 text-right font-medium">警告阈值</th>
                    <th className="px-4 py-3 text-right font-medium">严重阈值</th>
                    <th className="px-4 py-3 text-center font-medium">严重阻断</th>
                    <th className="px-4 py-3 text-center font-medium">状态</th>
                    <th className="px-4 py-3 text-left">
                      <SortableHeader
                        label="更新时间"
                        field="updated_at"
                        currentSort={sort}
                        onSort={(field) => {
                          setSort(toggleSort(sort, field))
                          setPage(1)
                        }}
                      />
                    </th>
                    <th className="px-4 py-3 text-right font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {policies.map((policy) => (
                    <tr key={policy.id} className="border-b last:border-0 hover:bg-muted/20">
                      <td className="px-4 py-3 font-mono text-body">{policy.organization_id}</td>
                      <td className="px-4 py-3 text-right">{policy.warning_threshold_percent}%</td>
                      <td className="px-4 py-3 text-right">{policy.critical_threshold_percent}%</td>
                      <td className="px-4 py-3 text-center">
                        {policy.block_on_critical ? '是' : '否'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <Badge variant={policy.is_active ? 'success' : 'outline'}>
                          {policy.is_active ? '启用' : '禁用'}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-body text-muted-foreground">
                        {formatDateTime(policy.updated_at)}
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex justify-end gap-2">
                          <Button variant="outline" size="sm" onClick={() => openEdit(policy)}>
                            <Pencil className="mr-2 h-3.5 w-3.5" />
                            编辑
                          </Button>
                          <Button
                            variant="outline"
                            size="sm"
                            className="text-destructive hover:text-destructive"
                            onClick={() => setDeleteTarget(policy.id)}
                          >
                            <Trash2 className="mr-2 h-3.5 w-3.5" />
                            删除
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                  {policies.length === 0 ? (
                    <tr>
                      <td colSpan={7} className="px-4 py-12 text-center text-muted-foreground">
                        当前没有预算策略，建议至少为重点组织创建一条保护策略。
                      </td>
                    </tr>
                  ) : null}
                </tbody>
              </table>
            </div>

            <nav aria-label="预算策略分页导航" className="px-6 pb-6">
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
          </>
        )}
      </AdminListCard>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => {
          if (!open) {
            setDeleteTarget(null)
          }
        }}
        title="删除预算策略"
        description="删除后不可恢复，确认删除这条预算策略吗？"
        confirmLabel="删除"
        variant="destructive"
        onConfirm={handleDelete}
      />
    </AdminPage>
  )
}
