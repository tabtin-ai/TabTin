import { AdminListCard, AdminPage, AdminPageHeader } from '@/components/admin-page'
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
import {
  PAYMENT_METHOD_LABELS,
  PAYMENT_ORDER_TYPE_LABELS,
  PAYMENT_STATUS_LABELS,
  labelPaymentMethod,
  labelPaymentOrderType,
  labelPaymentStatus,
} from '@/lib/billing-labels'
import { formatDateTime } from '@/lib/utils'
import { CreditCard, Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { type PaymentOrderItem, listPaymentOrders } from '../api/billing-admin'
import { RealRechargeSummary } from './RealRechargeSummary'

const DEFAULT_PAGE_SIZE = 20

const STATUS_FILTERS = [
  { value: '__all__', label: '全部状态' },
  ...Object.entries(PAYMENT_STATUS_LABELS)
    .filter(([value]) => value !== 'payment_failed')
    .map(([value, label]) => ({ value, label })),
]

const ORDER_TYPE_FILTERS = [
  { value: '__all__', label: '全部类型' },
  ...Object.entries(PAYMENT_ORDER_TYPE_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
]

const PAYMENT_METHOD_FILTERS = [
  { value: '__all__', label: '全部支付方式' },
  ...Object.entries(PAYMENT_METHOD_LABELS).map(([value, label]) => ({
    value,
    label,
  })),
]

type PaymentOrderFilters = {
  orderNo: string
  organization: string
  orderType: string
  paymentMethod: string
  status: string
  operator: string
}

type RealRechargeOrderView = {
  orders: PaymentOrderItem[]
  periodLabel: string
}

const EMPTY_FILTERS: PaymentOrderFilters = {
  orderNo: '',
  organization: '',
  orderType: '__all__',
  paymentMethod: '__all__',
  status: '__all__',
  operator: '',
}

function formatAmount(value?: string | null): string {
  const amount = Number(value || 0)
  if (!Number.isFinite(amount)) return value || '—'
  return amount.toLocaleString('zh-CN', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  })
}

export function PaymentOrdersPage() {
  const [searchParams] = useSearchParams()
  const urlOrganization = useMemo(() => {
    const organization = (searchParams.get('organization') || '').trim()
    if (organization) return organization
    // 兼容旧入口 ?keyword=<organizationId>
    return (searchParams.get('keyword') || '').trim()
  }, [searchParams])

  const loadVersionRef = useRef(0)
  const [items, setItems] = useState<PaymentOrderItem[]>([])
  const [total, setTotal] = useState(0)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [draft, setDraft] = useState<PaymentOrderFilters>({
    ...EMPTY_FILTERS,
    organization: urlOrganization,
  })
  const [applied, setApplied] = useState<PaymentOrderFilters>({
    ...EMPTY_FILTERS,
    organization: urlOrganization,
  })
  const [loading, setLoading] = useState(true)
  const [loadError, setLoadError] = useState('')
  const [refreshVersion, setRefreshVersion] = useState(0)
  const [realRechargeView, setRealRechargeView] = useState<RealRechargeOrderView | null>(null)

  const displayedTotal = realRechargeView?.orders.length ?? total
  const displayedItems = useMemo(() => {
    if (!realRechargeView) return items
    const start = (page - 1) * pageSize
    return realRechargeView.orders.slice(start, start + pageSize)
  }, [items, page, pageSize, realRechargeView])

  useEffect(() => {
    setDraft((prev) => ({ ...prev, organization: urlOrganization }))
    setApplied((prev) => ({ ...prev, organization: urlOrganization }))
    setPage(1)
  }, [urlOrganization])

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setLoadError('')
    try {
      const data = await listPaymentOrders({
        order_no: applied.orderNo || undefined,
        organization: applied.organization || undefined,
        order_type: applied.orderType === '__all__' ? undefined : applied.orderType,
        payment_method: applied.paymentMethod === '__all__' ? undefined : applied.paymentMethod,
        status: applied.status === '__all__' ? undefined : applied.status,
        operator: applied.operator || undefined,
        page,
        page_size: pageSize,
      })
      if (loadVersionRef.current !== version) return
      setItems(data.items || [])
      setTotal(data.total || 0)
    } catch (error) {
      if (loadVersionRef.current !== version) return
      setItems([])
      setTotal(0)
      setLoadError(error instanceof Error ? error.message : '加载支付订单失败')
    } finally {
      if (loadVersionRef.current === version) {
        setLoading(false)
      }
    }
  }, [applied, page, pageSize])

  useEffect(() => {
    void load()
  }, [load])

  const runQuery = () => {
    setPage(1)
    setRealRechargeView(null)
    setApplied({
      orderNo: draft.orderNo.trim(),
      organization: draft.organization.trim(),
      orderType: draft.orderType,
      paymentMethod: draft.paymentMethod,
      status: draft.status,
      operator: draft.operator.trim(),
    })
  }

  const updateDraft = <K extends keyof PaymentOrderFilters>(
    key: K,
    value: PaymentOrderFilters[K]
  ) => {
    setDraft((prev) => ({ ...prev, [key]: value }))
  }

  return (
    <AdminPage>
      <AdminPageHeader
        title="支付订单"
        icon={CreditCard}
        badges={<Badge variant="outline">共 {displayedTotal} 条</Badge>}
        actions={
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              setRealRechargeView(null)
              setRefreshVersion((value) => value + 1)
              void load()
            }}
            disabled={loading}
          >
            {loading ? (
              <Loader2 className="mr-2 h-[1em] w-[1em] animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-[1em] w-[1em]" />
            )}
            刷新
          </Button>
        }
      />

      <RealRechargeSummary
        key={refreshVersion}
        onViewOrders={(orders, periodLabel) => {
          setRealRechargeView({ orders, periodLabel })
          setPage(1)
          window.requestAnimationFrame(() => {
            document.getElementById('payment-orders-table')?.scrollIntoView({ behavior: 'smooth' })
          })
        }}
      />

      <AdminListCard
        title="筛选"
        description="按订单号、组织、类型、支付方式、状态和操作人筛选支付订单。"
      >
        <div className="flex flex-col gap-3 lg:flex-row lg:flex-wrap lg:items-end">
          <label className="text-body font-medium" htmlFor="payment-orders-order-no">
            订单号
            <Input
              id="payment-orders-order-no"
              className="mt-1 w-full sm:w-56"
              value={draft.orderNo}
              onChange={(event) => updateDraft('orderNo', event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runQuery()
              }}
              placeholder="输入订单号"
            />
          </label>

          <label className="text-body font-medium" htmlFor="payment-orders-organization">
            组织名 / 组织 ID
            <Input
              id="payment-orders-organization"
              className="mt-1 w-full sm:w-64"
              value={draft.organization}
              onChange={(event) => updateDraft('organization', event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runQuery()
              }}
              placeholder="输入组织名称或 UUID"
            />
          </label>

          <label className="text-body font-medium" htmlFor="payment-orders-type">
            类型
            <Select
              value={draft.orderType}
              onValueChange={(value) => updateDraft('orderType', value)}
            >
              <SelectTrigger id="payment-orders-type" className="mt-1 w-44">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {ORDER_TYPE_FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-body font-medium" htmlFor="payment-orders-method">
            支付方式
            <Select
              value={draft.paymentMethod}
              onValueChange={(value) => updateDraft('paymentMethod', value)}
            >
              <SelectTrigger id="payment-orders-method" className="mt-1 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHOD_FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-body font-medium" htmlFor="payment-orders-status">
            状态
            <Select value={draft.status} onValueChange={(value) => updateDraft('status', value)}>
              <SelectTrigger id="payment-orders-status" className="mt-1 w-40">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {STATUS_FILTERS.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </label>

          <label className="text-body font-medium" htmlFor="payment-orders-operator">
            操作人昵称 / 操作人 ID
            <Input
              id="payment-orders-operator"
              className="mt-1 w-full sm:w-64"
              value={draft.operator}
              onChange={(event) => updateDraft('operator', event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') runQuery()
              }}
              placeholder="输入昵称或用户 ID"
            />
          </label>

          <Button onClick={runQuery} disabled={loading}>
            查询
          </Button>
        </div>
      </AdminListCard>

      <AdminListCard
        title="支付记录"
        description={
          realRechargeView
            ? `正在查看“${realRechargeView.periodLabel}”真实充值统计对应的订单。`
            : '展示套餐订阅、点券充值等支付订单。后台人民币钱包直接充值/购买不会出现在此列表。'
        }
        contentClassName="space-y-4 px-0"
        actions={
          <div className="flex items-center gap-2">
            {realRechargeView ? (
              <>
                <Badge variant="secondary">真实充值口径</Badge>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => {
                    setRealRechargeView(null)
                    setPage(1)
                  }}
                >
                  退出专用视图
                </Button>
              </>
            ) : null}
            <Badge variant="outline">
              第 {page} / {Math.max(1, Math.ceil(displayedTotal / pageSize))} 页
            </Badge>
          </div>
        }
      >
        {loading && displayedItems.length === 0 && !realRechargeView ? (
          <div className="flex items-center justify-center py-20 text-muted-foreground">
            <Loader2 className="mr-2 h-5 w-5 animate-spin" />
            加载中…
          </div>
        ) : loadError && !realRechargeView ? (
          <div className="flex flex-col items-center justify-center gap-3 py-16 text-center">
            <p className="text-body text-muted-foreground">{loadError}</p>
            <Button variant="outline" size="sm" onClick={() => void load()}>
              重试
            </Button>
          </div>
        ) : (
          <>
            <div className="overflow-x-auto">
              <table
                id="payment-orders-table"
                className="w-full table-fixed text-body"
                aria-label="支付订单列表"
              >
                <colgroup>
                  <col className="w-[12%]" />
                  <col className="w-[14%]" />
                  <col className="w-[9%]" />
                  <col className="w-[8%]" />
                  <col className="w-[10%]" />
                  <col className="w-[8%]" />
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                  <col className="w-[13%]" />
                </colgroup>
                <thead className="border-b bg-muted/40">
                  <tr>
                    <th className="px-3 py-3 text-left font-medium">订单号</th>
                    <th className="px-3 py-3 text-left font-medium">组织</th>
                    <th className="px-3 py-3 text-left font-medium">类型</th>
                    <th className="px-3 py-3 text-left font-medium">金额</th>
                    <th className="px-3 py-3 text-left font-medium">支付方式</th>
                    <th className="px-3 py-3 text-left font-medium">状态</th>
                    <th className="px-3 py-3 text-left font-medium">操作人</th>
                    <th className="px-3 py-3 text-left font-medium">支付时间</th>
                    <th className="px-3 py-3 text-left font-medium">创建时间</th>
                  </tr>
                </thead>
                <tbody>
                  {displayedItems.length === 0 ? (
                    <tr>
                      <td
                        colSpan={9}
                        className="px-3 py-12 text-center text-body text-muted-foreground"
                      >
                        暂无支付订单
                      </td>
                    </tr>
                  ) : (
                    displayedItems.map((item) => {
                      const operatorId = (item.operator_user_id || item.user_id || '').trim()
                      const operatorName = (item.operator_name || '').trim()
                      return (
                        <tr key={item.id} className="border-t align-top">
                          <td
                            className="truncate px-3 py-3 text-left font-mono text-caption"
                            title={item.order_no}
                          >
                            {item.order_no || '—'}
                          </td>
                          <td className="px-3 py-3 text-left">
                            <div
                              className="truncate font-medium"
                              title={item.organization_name || undefined}
                            >
                              {item.organization_name || '未命名组织'}
                            </div>
                            <div
                              className="mt-0.5 truncate font-mono text-caption text-muted-foreground"
                              title={item.organization_id || undefined}
                            >
                              {item.organization_id || '—'}
                            </div>
                          </td>
                          <td className="truncate px-3 py-3 text-left">
                            {labelPaymentOrderType(item.order_type)}
                          </td>
                          <td className="truncate px-3 py-3 text-left font-mono tabular-nums">
                            {formatAmount(item.amount)}
                          </td>
                          <td className="truncate px-3 py-3 text-left">
                            {labelPaymentMethod(item.payment_method, '')}
                          </td>
                          <td className="truncate px-3 py-3 text-left">
                            {labelPaymentStatus(item.status)}
                          </td>
                          <td className="px-3 py-3 text-left">
                            {operatorName || operatorId ? (
                              <>
                                <div
                                  className="truncate font-medium"
                                  title={operatorName || undefined}
                                >
                                  {operatorName || '未命名用户'}
                                </div>
                                <div
                                  className="mt-0.5 truncate font-mono text-caption text-muted-foreground"
                                  title={operatorId || undefined}
                                >
                                  {operatorId || '—'}
                                </div>
                              </>
                            ) : (
                              '—'
                            )}
                          </td>
                          <td
                            className="truncate px-3 py-3 text-left text-caption text-muted-foreground"
                            title={item.paid_at || undefined}
                          >
                            {item.paid_at ? formatDateTime(item.paid_at) : '—'}
                          </td>
                          <td
                            className="truncate px-3 py-3 text-left text-caption text-muted-foreground"
                            title={item.created_at || undefined}
                          >
                            {item.created_at ? formatDateTime(item.created_at) : '—'}
                          </td>
                        </tr>
                      )
                    })
                  )}
                </tbody>
              </table>
            </div>

            <nav aria-label="支付订单分页导航" className="px-6 pb-6">
              <Pagination
                page={page}
                total={displayedTotal}
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
    </AdminPage>
  )
}
