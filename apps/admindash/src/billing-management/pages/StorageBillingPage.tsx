import { AdminListCard, AdminMetricCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { ConfirmDialog } from '@/components/ui/confirm-dialog'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { PageSizeSelect } from '@/components/ui/pagination'
import { spaceAdminApi } from '@/api/space-admin'
import { useDebounce } from '@/hooks/useDebounce'
import { useSimpleToast } from '@/hooks/useSimpleToast'
import { labelStorageBillingMode } from '@/lib/billing-labels'
import { formatDateTime } from '@/lib/utils'
import {
  ArrowLeft,
  Coins,
  Database,
  Files,
  HardDrive,
  Loader2,
  Pencil,
  RefreshCw,
  Search,
  TriangleAlert,
} from 'lucide-react'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts'
import {
  type PricingRule,
  type StorageOverviewData,
  type StorageOrganizationItem,
  getStorageOverview,
  listStoragePricing,
  listStorageOrganizations,
  runStorageReconcile,
  updatePricingRule,
  updateStorageEntitlement,
} from '../api/billing-admin'
import { getTaskRunFeedback } from '../api/task-run-result'

function formatBytes(bytes: number): string {
  if (bytes === 0) {
    return '0 B'
  }

  const k = 1024
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB']
  const index = Math.floor(Math.log(bytes) / Math.log(k))

  return `${(bytes / k ** index).toFixed(2)} ${sizes[index]}`
}

function formatShortId(value: string, length = 10): string {
  if (value.length <= length) {
    return value
  }

  return `${value.slice(0, length)}...`
}

function usageTextClass(rate: number): string {
  if (rate >= 95) {
    return 'text-destructive'
  }

  if (rate >= 80) {
    return 'text-warning'
  }

  return 'text-success'
}

function usageBarClass(rate: number): string {
  if (rate >= 95) {
    return 'bg-destructive'
  }

  if (rate >= 80) {
    return 'bg-warning'
  }

  return 'bg-success'
}

/** 接口尚未返回 organization_name 时，按当前页 ID 补名称（仅展示，不影响筛选）。 */
async function enrichOrganizationNames(
  items: StorageOrganizationItem[]
): Promise<StorageOrganizationItem[]> {
  const missingIds = [
    ...new Set(
      items
        .filter((item) => item.organization_id && !(item.organization_name || '').trim())
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
    if (existing) {
      return item
    }
    const resolved = nameMap[item.organization_id]
    return resolved ? { ...item, organization_name: resolved } : item
  })
}

function SortButton({
  label,
  active,
  direction,
  onClick,
}: {
  label: string
  active: boolean
  direction: 'asc' | 'desc'
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className="flex items-center gap-1 font-medium hover:text-foreground"
      onClick={onClick}
    >
      <span>{label}</span>
      <span className="text-body text-muted-foreground">
        {active ? (direction === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  )
}

export function StorageBillingPage() {
  const navigate = useNavigate()
  const { show: showToast, element: toastEl } = useSimpleToast()
  const loadVersionRef = useRef(0)

  const [overview, setOverview] = useState<StorageOverviewData | null>(null)
  const [organizations, setOrganizations] = useState<StorageOrganizationItem[]>([])
  const [pagination, setPagination] = useState({
    total: 0,
    page: 1,
    pageSize: 20,
    totalPages: 0,
  })
  const [pricing, setPricing] = useState<PricingRule[]>([])
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState(false)

  const [search, setSearch] = useState('')
  const debouncedSearch = useDebounce(search, 300)
  const [sortBy, setSortBy] = useState<'active_storage_bytes' | 'active_file_count'>(
    'active_storage_bytes'
  )
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('desc')

  const [editingEntitlement, setEditingEntitlement] = useState<StorageOrganizationItem | null>(null)
  const [entitlementValue, setEntitlementValue] = useState('')
  const [savingEntitlement, setSavingEntitlement] = useState(false)

  const [editingPrice, setEditingPrice] = useState<PricingRule | null>(null)
  const [priceValue, setPriceValue] = useState('')
  const [savingPrice, setSavingPrice] = useState(false)

  const [showReconcileConfirm, setShowReconcileConfirm] = useState(false)
  const [reconciling, setReconciling] = useState(false)

  const loadData = useCallback(
    async (targetPage: number) => {
      const version = ++loadVersionRef.current
      setLoading(true)
      setLoadError(false)

      try {
        const keyword = debouncedSearch.trim()
        const [overviewData, organizationData, pricingData] = await Promise.all([
          getStorageOverview(),
          listStorageOrganizations({
            page: targetPage,
            page_size: pagination.pageSize,
            search: keyword || undefined,
            sort_by: sortBy,
            sort_order: sortOrder,
          }),
          listStoragePricing({ page_size: 50 }),
        ])

        if (version !== loadVersionRef.current) {
          return
        }

        const organizationsWithNames = await enrichOrganizationNames(
          organizationData.organizations || []
        )
        if (version !== loadVersionRef.current) {
          return
        }

        setOverview(overviewData)
        setOrganizations(organizationsWithNames)
        setPricing(pricingData.pricing_rules || [])
        setPagination((prev) => ({
          ...prev,
          total: organizationData.total ?? 0,
          page: organizationData.page ?? targetPage,
          totalPages: organizationData.total_pages ?? 0,
        }))
      } catch {
        if (version !== loadVersionRef.current) {
          return
        }

        setLoadError(true)
        showToast('加载存储数据失败', 'error')
      } finally {
        if (version === loadVersionRef.current) {
          setLoading(false)
        }
      }
    },
    [debouncedSearch, pagination.pageSize, showToast, sortBy, sortOrder]
  )

  useEffect(() => {
    void loadData(pagination.page)
  }, [loadData, pagination.page])

  const refreshCurrentPage = () => {
    void loadData(pagination.page)
  }

  const handleSort = (field: 'active_storage_bytes' | 'active_file_count') => {
    if (sortBy === field) {
      setSortOrder((current) => (current === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortBy(field)
      setSortOrder('desc')
    }

    setPagination((prev) => ({ ...prev, page: 1 }))
  }

  const openEntitlementDialog = (organization: StorageOrganizationItem) => {
    setEditingEntitlement(organization)
    setEntitlementValue(String(organization.purchased_storage_bytes))
  }

  const handleSaveEntitlement = async () => {
    if (!editingEntitlement) {
      return
    }

    const bytes = Number.parseInt(entitlementValue, 10)
    if (Number.isNaN(bytes) || bytes < 0) {
      showToast('请输入有效的字节数', 'error')
      return
    }

    setSavingEntitlement(true)

    try {
      await updateStorageEntitlement(editingEntitlement.organization_id, {
        purchased_storage_bytes: bytes,
      })
      showToast('配额调整成功', 'success')
      setEditingEntitlement(null)
      void loadData(pagination.page)
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '调整失败', 'error')
    } finally {
      setSavingEntitlement(false)
    }
  }

  const openPricingDialog = (rule: PricingRule) => {
    setEditingPrice(rule)
    setPriceValue(rule.unit_price)
  }

  const handleSavePrice = async () => {
    if (!editingPrice) {
      return
    }

    const numericValue = Number.parseFloat(priceValue)
    if (Number.isNaN(numericValue) || numericValue < 0) {
      showToast('请输入有效的非负数价格', 'error')
      return
    }

    setSavingPrice(true)

    try {
      await updatePricingRule(editingPrice.id, {
        ...editingPrice,
        unit_price: priceValue,
      })
      showToast('定价更新成功', 'success')
      setEditingPrice(null)
      void loadData(pagination.page)
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '更新失败', 'error')
    } finally {
      setSavingPrice(false)
    }
  }

  const handleReconcileStorage = async () => {
    setReconciling(true)

    try {
      const result = await runStorageReconcile()
      const feedback = getTaskRunFeedback(result)
      if (!feedback.submitted) {
        showToast(feedback.message, 'error')
        return
      }
      showToast(
        `存储校准任务已提交（task: ${result.task_id?.slice(0, 8) ?? 'unknown'}）`,
        'success'
      )
      window.setTimeout(() => {
        void loadData(pagination.page)
      }, 3000)
    } catch (error: unknown) {
      showToast(error instanceof Error ? error.message : '校准触发失败', 'error')
      throw error
    } finally {
      setReconciling(false)
    }
  }

  const trendData =
    overview?.growth_trend.map((point) => ({
      date: point.date.slice(5),
      quantity: Number(point.quantity),
    })) || []
  const highRiskOrganizations = organizations.filter((organization) => organization.usage_rate_percent >= 80)
  const activePricingCount = pricing.filter((rule) => rule.is_active).length

  return (
    <AdminPage>
      {toastEl}

      <AdminPageHeader
        title="存储用量与扣费"
        icon={HardDrive}
        badges={
          <>
            <Badge variant="outline">组织 {overview?.organization_count ?? 0}</Badge>
            <Badge variant={highRiskOrganizations.length > 0 ? 'warning' : 'outline'}>
              高风险 {highRiskOrganizations.length}
            </Badge>
            <Badge variant="outline">定价规则 {pricing.length}</Badge>
            {search ? <Badge variant="secondary">搜索：{search}</Badge> : null}
          </>
        }
        actions={
          <>
            <Button variant="outline" size="sm" onClick={() => navigate('/billing/events')}>
              <ArrowLeft className="mr-2 h-4 w-4" />
              返回用量与扣费
            </Button>
            <Button variant="outline" size="sm" onClick={refreshCurrentPage} disabled={loading}>
              {loading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <RefreshCw className="mr-2 h-4 w-4" />
              )}
              刷新
            </Button>
            <Button size="sm" onClick={() => setShowReconcileConfirm(true)} disabled={reconciling}>
              {reconciling ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Database className="mr-2 h-4 w-4" />
              )}
              提交存储校准
            </Button>
          </>
        }
      />

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <AdminMetricCard
          title="平台总存储量"
          value={overview ? formatBytes(overview.total_active_storage_bytes) : '-'}
          hint="用于判断整体容量增长和存储成本压力。"
          icon={HardDrive}
        />
        <AdminMetricCard
          title="总文件数"
          value={overview ? overview.total_active_file_count.toLocaleString() : '-'}
          hint="结合组织告警判断异常上传或大文件堆积。"
          icon={Files}
        />
        <AdminMetricCard
          title="近 30 天存储费用"
          value={overview ? `${overview.recent_30d_cost} credits` : '-'}
          hint="成本显著抬升时建议联动定价和配额策略一起看。"
          icon={Coins}
          tone={overview && Number(overview.recent_30d_cost) > 0 ? 'warning' : 'default'}
        />
        <AdminMetricCard
          title="高风险组织"
          value={highRiskOrganizations.length.toLocaleString()}
          hint="使用率 >= 80% 的当前页组织。"
          icon={TriangleAlert}
          tone={highRiskOrganizations.length > 0 ? 'warning' : 'default'}
        />
      </div>

      <AdminListCard
        title="近 30 天存储趋势"
        description="观察容量增长节奏，判断是否需要调整套餐容量或进行垃圾数据治理。"
      >
        {trendData.length > 0 ? (
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={trendData}>
              <CartesianGrid strokeDasharray="3 3" className="stroke-muted" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} tickFormatter={formatBytes} />
              <Tooltip
                formatter={(value) =>
                  typeof value === 'number' ? formatBytes(value) : String(value)
                }
              />
              <Line
                type="monotone"
                dataKey="quantity"
                stroke="hsl(var(--primary))"
                strokeWidth={2}
                dot={false}
              />
            </LineChart>
          </ResponsiveContainer>
        ) : (
          <p className="py-16 text-center text-body text-muted-foreground">
            暂无趋势数据，待后端聚合后展示。
          </p>
        )}
      </AdminListCard>

      <AdminListCard
        title="存储定价规则"
        description="核对不同计量项、作用域和单价，必要时直接调整。"
        actions={<Badge variant="outline">启用中 {activePricingCount}</Badge>}
        contentClassName="space-y-4 px-0"
      >
        {pricing.length === 0 ? (
          <div className="py-16 text-center text-body text-muted-foreground">
            暂无存储定价规则，请先在定价模块创建。
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-body" aria-label="存储定价规则">
              <thead className="border-b bg-muted/40">
                <tr>
                  <th className="px-4 py-3 text-left font-medium">计量项</th>
                  <th className="px-4 py-3 text-left font-medium">作用域</th>
                  <th className="px-4 py-3 text-left font-medium">单价</th>
                  <th className="px-4 py-3 text-left font-medium">单位</th>
                  <th className="px-4 py-3 text-left font-medium">状态</th>
                  <th className="px-4 py-3 text-left font-medium">更新时间</th>
                  <th className="px-4 py-3 text-right font-medium">操作</th>
                </tr>
              </thead>
              <tbody>
                {pricing.map((rule) => (
                  <tr key={rule.id} className="border-b last:border-0 hover:bg-muted/20">
                    <td className="px-4 py-3 font-mono text-body">{rule.meter_key}</td>
                    <td className="px-4 py-3">
                      <div className="space-y-1">
                        <p>{rule.scope}</p>
                        {rule.organization_id ? (
                          <p className="font-mono text-body text-muted-foreground">
                            {formatShortId(rule.organization_id)}
                          </p>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-3 font-mono">{rule.unit_price}</td>
                    <td className="px-4 py-3">{rule.unit}</td>
                    <td className="px-4 py-3">
                      <Badge variant={rule.is_active ? 'success' : 'outline'}>
                        {rule.is_active ? '启用' : '停用'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-body text-muted-foreground">
                      {formatDateTime(rule.updated_at)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button variant="ghost" size="sm" onClick={() => openPricingDialog(rule)}>
                        <Pencil className="mr-2 h-4 w-4" />
                        编辑单价
                      </Button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </AdminListCard>

      <AdminListCard
        title="组织存储明细"
        description="可按组织名或组织 ID 搜索，并按存储量或文件数排序，支持直接调整额外购买容量。"
        contentClassName="space-y-4 px-0"
        actions={
          <div className="relative w-full sm:w-72">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              className="pl-9"
              placeholder="搜索组织名或 ID"
              aria-label="搜索组织名或 ID"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value)
                setPagination((prev) => ({ ...prev, page: 1 }))
              }}
            />
          </div>
        }
      >
        {loading && organizations.length === 0 ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
          </div>
        ) : loadError && organizations.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">
              组织存储明细加载失败，请稍后重试。
            </p>
            <Button variant="outline" size="sm" onClick={refreshCurrentPage}>
              重试
            </Button>
          </div>
        ) : organizations.length === 0 ? (
          <div className="py-16 text-center text-body text-muted-foreground">
            暂无匹配的组织。
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table className="w-full text-body" aria-label="组织存储明细">
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-4 py-3 text-left font-medium">组织</th>
                    <th className="px-4 py-3 text-left">
                      <SortButton
                        label="当前用量"
                        active={sortBy === 'active_storage_bytes'}
                        direction={sortOrder}
                        onClick={() => handleSort('active_storage_bytes')}
                      />
                    </th>
                    <th className="px-4 py-3 text-left font-medium">套餐容量</th>
                    <th className="px-4 py-3 text-left font-medium">额外购买</th>
                    <th className="px-4 py-3 text-left font-medium">使用率</th>
                    <th className="px-4 py-3 text-left font-medium">计费模式</th>
                    <th className="px-4 py-3 text-left">
                      <SortButton
                        label="文件数"
                        active={sortBy === 'active_file_count'}
                        direction={sortOrder}
                        onClick={() => handleSort('active_file_count')}
                      />
                    </th>
                    <th className="px-4 py-3 text-left font-medium">更新时间</th>
                    <th className="px-4 py-3 text-left font-medium">操作</th>
                  </tr>
                </thead>
                <tbody>
                  {organizations.map((organization) => {
                    const orgName = (organization.organization_name || '').trim()
                    return (
                    <tr
                      key={organization.organization_id}
                      className="border-b last:border-0 hover:bg-muted/20"
                    >
                      <td className="max-w-[200px] px-4 py-3 text-left text-body">
                        {organization.organization_id ? (
                          <button
                            type="button"
                            className="text-left text-primary underline-offset-4 hover:underline"
                            title={organization.organization_id}
                            onClick={() =>
                              navigate(`/organizations/${organization.organization_id}`)
                            }
                          >
                            {orgName ? (
                              <>
                                <span className="font-medium">{orgName}</span>
                                <span className="mt-0.5 block font-mono text-caption text-muted-foreground">
                                  {formatShortId(organization.organization_id, 14)}
                                </span>
                              </>
                            ) : (
                              <span className="font-mono text-body">
                                {formatShortId(organization.organization_id, 14)}
                              </span>
                            )}
                          </button>
                        ) : (
                          '-'
                        )}
                      </td>
                      <td className="px-4 py-3 text-left font-mono">
                        {formatBytes(organization.active_storage_bytes)}
                      </td>
                      <td className="px-4 py-3 text-left">
                        {formatBytes(organization.included_storage_bytes)}
                      </td>
                      <td className="px-4 py-3 text-left">
                        {formatBytes(organization.purchased_storage_bytes)}
                      </td>
                      <td className="px-4 py-3 text-left">
                        <div className="flex min-w-40 items-center gap-3">
                          <div className="h-2 flex-1 overflow-hidden rounded-full bg-muted">
                            <div
                              className={`h-full rounded-full ${usageBarClass(organization.usage_rate_percent)}`}
                              style={{ width: `${Math.min(organization.usage_rate_percent, 100)}%` }}
                            />
                          </div>
                          <span
                            className={`text-body font-medium ${usageTextClass(organization.usage_rate_percent)}`}
                          >
                            {organization.usage_rate_percent.toFixed(1)}%
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-left">
                        <Badge
                          variant="outline"
                          title={organization.storage_billing_mode || undefined}
                        >
                          {labelStorageBillingMode(organization.storage_billing_mode)}
                        </Badge>
                      </td>
                      <td className="px-4 py-3 text-left">
                        {organization.active_file_count.toLocaleString()}
                      </td>
                      <td className="px-4 py-3 text-left text-body text-muted-foreground">
                        {formatDateTime(organization.updated_at)}
                      </td>
                      <td className="px-4 py-3 text-left">
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => openEntitlementDialog(organization)}
                        >
                          <Pencil className="mr-2 h-4 w-4" />
                          调整配额
                        </Button>
                      </td>
                    </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>

            {pagination.total > 0 ? (
              <div className="flex flex-col gap-3 px-6 pb-6 sm:flex-row sm:items-center sm:justify-between">
                <div className="text-body text-muted-foreground">
                  共 {pagination.total} 个组织，第 {pagination.page} / {pagination.totalPages}{' '}
                  页
                </div>
                <div className="flex items-center gap-2">
                  <PageSizeSelect
                    value={pagination.pageSize}
                    onChange={(nextPageSize) =>
                      setPagination((prev) => ({
                        ...prev,
                        page: 1,
                        pageSize: nextPageSize,
                      }))
                    }
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPagination((prev) => ({ ...prev, page: Math.max(1, prev.page - 1) }))
                    }
                    disabled={pagination.page <= 1}
                  >
                    上一页
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() =>
                      setPagination((prev) => ({
                        ...prev,
                        page: Math.min(prev.totalPages, prev.page + 1),
                      }))
                    }
                    disabled={pagination.page >= pagination.totalPages}
                  >
                    下一页
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </AdminListCard>

      <Dialog
        open={!!editingEntitlement}
        onOpenChange={(open) => {
          if (!open && !savingEntitlement) {
            setEditingEntitlement(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>调整存储配额</DialogTitle>
            <DialogDescription>为指定组织调整额外购买容量，保存后立即生效。</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-body">
              {(editingEntitlement?.organization_name || '').trim() ? (
                <p className="font-medium">{editingEntitlement?.organization_name}</p>
              ) : null}
              <p className="font-mono text-caption text-muted-foreground">
                {editingEntitlement?.organization_id}
              </p>
              <div className="mt-2 grid gap-2 text-muted-foreground">
                <p>
                  当前用量：
                  {editingEntitlement ? formatBytes(editingEntitlement.active_storage_bytes) : '-'}
                </p>
                <p>
                  套餐容量：
                  {editingEntitlement
                    ? formatBytes(editingEntitlement.included_storage_bytes)
                    : '-'}
                </p>
                <p>
                  已购容量：
                  {editingEntitlement
                    ? formatBytes(editingEntitlement.purchased_storage_bytes)
                    : '-'}
                </p>
              </div>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="storage-entitlement-bytes">
                额外购买容量（字节）
              </label>
              <Input
                id="storage-entitlement-bytes"
                className="mt-1"
                type="number"
                min="0"
                value={entitlementValue}
                onChange={(event) => setEntitlementValue(event.target.value)}
              />
              <p className="mt-1 text-body text-muted-foreground">
                直接填写字节数，便于和后端计量口径保持一致。
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingEntitlement(null)}
              disabled={savingEntitlement}
            >
              取消
            </Button>
            <Button size="sm" onClick={handleSaveEntitlement} disabled={savingEntitlement}>
              {savingEntitlement ? '保存中...' : '保存配额'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog
        open={!!editingPrice}
        onOpenChange={(open) => {
          if (!open && !savingPrice) {
            setEditingPrice(null)
          }
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>编辑存储单价</DialogTitle>
            <DialogDescription>调整当前计量项的单价，适用于临时修正或灰度验证。</DialogDescription>
          </DialogHeader>

          <div className="space-y-3">
            <div className="rounded-lg border border-border/60 bg-muted/20 p-3 text-body">
              <div className="grid gap-2 text-muted-foreground">
                <p>计量项：{editingPrice?.meter_key ?? '-'}</p>
                <p>作用域：{editingPrice?.scope ?? '-'}</p>
                <p>单位：{editingPrice?.unit ?? '-'}</p>
                <p>更新时间：{formatDateTime(editingPrice?.updated_at)}</p>
              </div>
            </div>

            <div>
              <label className="text-body font-medium" htmlFor="storage-price-value">
                新单价
              </label>
              <Input
                id="storage-price-value"
                className="mt-1"
                type="number"
                min="0"
                step="0.0001"
                value={priceValue}
                onChange={(event) => setPriceValue(event.target.value)}
              />
            </div>
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setEditingPrice(null)}
              disabled={savingPrice}
            >
              取消
            </Button>
            <Button size="sm" onClick={handleSavePrice} disabled={savingPrice}>
              {savingPrice ? '保存中...' : '保存单价'}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={showReconcileConfirm}
        onOpenChange={setShowReconcileConfirm}
        title="确认提交存储校准"
        description="该操作会遍历所有组织并重新校正存储快照偏差，可能持续数分钟。建议在低峰期执行。"
        confirmLabel="确认提交"
        loading={reconciling}
        onConfirm={handleReconcileStorage}
      />
    </AdminPage>
  )
}
