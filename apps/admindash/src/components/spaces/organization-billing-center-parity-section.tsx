import { spaceAdminApi } from '@/api/space-admin'
import {
  getOrganizationPaymentTransactions,
  type OrganizationPaymentTransactionItem,
} from '@/billing-management/api/billing-admin'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { labelCashTxType } from '@/lib/billing-labels'
import { formatDateTime } from '@/lib/utils'
import type { OrganizationCashWalletTransactionItem } from '@/types/space-admin'
import { Loader2, RefreshCw } from 'lucide-react'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'

const PAYMENT_STATUS_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'default', label: '默认' },
  { value: 'all', label: '全部' },
  { value: 'paid', label: '已支付' },
  { value: 'pending', label: '待支付' },
  { value: 'refunding', label: '退款中' },
  { value: 'refunded', label: '已退款' },
  { value: 'partially_refunded', label: '部分退款' },
  { value: 'payment_failed', label: '支付失败' },
  { value: 'closed', label: '已关闭' },
]

const CASH_TYPE_FILTERS: Array<{ value: string; label: string }> = [
  { value: 'all', label: '全部类型' },
  { value: 'recharge', label: '充值' },
  { value: 'membership_payment', label: '套餐订阅' },
  { value: 'membership_upgrade_payment', label: '套餐升级' },
  { value: 'membership_lifecycle_payment', label: '套餐续费/切换' },
  { value: 'purchase_credit_package', label: '购买点券包' },
  { value: 'purchase_addon_package', label: '购买扩容包' },
  { value: 'llm_auto_topup', label: '自动补充' },
  { value: 'refund', label: '退款' },
]

function formatMembershipCashDetail(tx: OrganizationCashWalletTransactionItem): {
  title: string
  lines: string[]
  orderNo: string
} {
  const summary = tx.membership_summary
  const meta = tx.metadata || {}
  const orderNo =
    summary?.order_no ||
    (typeof meta.order_no === 'string' ? meta.order_no : '') ||
    ''
  if (!summary) {
    return { title: tx.description || '—', lines: [], orderNo }
  }

  const titleParts = [
    summary.change_type_label || summary.change_type,
    summary.from_tier_name && summary.target_tier_name
      ? `${summary.from_tier_name} → ${summary.target_tier_name}`
      : summary.target_tier_name,
    summary.billing_cycle_label || summary.billing_cycle,
  ].filter(Boolean)
  const title = titleParts.join(' · ') || tx.description || '套餐支付'

  const lines: string[] = []
  if (summary.payable_amount) lines.push(`应付 ¥${formatMoney(summary.payable_amount)}`)
  if (summary.current_period_credit) {
    lines.push(`当期折抵 ¥${formatMoney(summary.current_period_credit)}`)
  }
  if (summary.target_period_charge) {
    lines.push(`目标周期价值 ¥${formatMoney(summary.target_period_charge)}`)
  }
  if (summary.remaining_ratio) {
    const ratio = Number(summary.remaining_ratio)
    lines.push(
      Number.isFinite(ratio)
        ? `剩余周期 ${Math.round(ratio * 100)}%`
        : `剩余周期 ${summary.remaining_ratio}`
    )
  }
  if (summary.payment_status || summary.benefit_status) {
    lines.push(
      [
        summary.payment_status ? `支付 ${summary.payment_status}` : null,
        summary.benefit_status ? `权益 ${summary.benefit_status}` : null,
      ]
        .filter(Boolean)
        .join(' · ')
    )
  }
  return { title, lines, orderNo }
}

const HIDDEN_DEFAULT_STATUSES = new Set(['closed', 'payment_failed'])

function formatMoney(value?: string | number | null): string {
  const n = Number(value ?? 0)
  if (!Number.isFinite(n)) return String(value ?? '—')
  return n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

function statusLabel(status: string): string {
  return PAYMENT_STATUS_FILTERS.find((f) => f.value === status)?.label ?? status
}

function paymentMethodLabel(method?: string | null): string {
  switch (method) {
    case 'organization_wallet':
    case 'wallet':
      return '钱包支付'
    case 'wechat':
      return '微信'
    case 'alipay':
      return '支付宝'
    case '':
    case null:
    case undefined:
      return '—'
    default:
      return method
  }
}

export function OrganizationBillingCenterParitySection({
  organizationId,
}: {
  organizationId: string
}) {
  const [view, setView] = useState<'payment' | 'cash'>('payment')
  const [statusFilter, setStatusFilter] = useState('default')
  const [cashType, setCashType] = useState('all')

  const [paymentItems, setPaymentItems] = useState<OrganizationPaymentTransactionItem[]>([])
  const [paymentTruncated, setPaymentTruncated] = useState(false)
  const [paymentLoading, setPaymentLoading] = useState(false)
  const [paymentError, setPaymentError] = useState<string | null>(null)

  const [cashBalance, setCashBalance] = useState<string | null>(null)
  const [cashTxs, setCashTxs] = useState<OrganizationCashWalletTransactionItem[]>([])
  const [cashTotal, setCashTotal] = useState(0)
  const [cashLoading, setCashLoading] = useState(false)
  const [cashError, setCashError] = useState<string | null>(null)

  const loadPayments = useCallback(async () => {
    setPaymentLoading(true)
    setPaymentError(null)
    try {
      const data = await getOrganizationPaymentTransactions(organizationId)
      setPaymentItems(data.items || [])
      setPaymentTruncated(Boolean(data.truncated))
    } catch (e) {
      setPaymentError(e instanceof Error ? e.message : '加载资金流水失败')
      setPaymentItems([])
    } finally {
      setPaymentLoading(false)
    }
  }, [organizationId])

  const loadCash = useCallback(async () => {
    setCashLoading(true)
    setCashError(null)
    try {
      const data = await spaceAdminApi.listOrganizationCashWalletTransactions(organizationId, {
        transactionType: cashType === 'all' ? undefined : cashType,
        limit: 20,
        offset: 0,
      })
      setCashBalance(data.available_cny ?? data.wallet?.available_cny ?? null)
      setCashTxs((data.transactions || []) as OrganizationCashWalletTransactionItem[])
      setCashTotal(data.total ?? 0)
    } catch (e) {
      setCashError(e instanceof Error ? e.message : '加载现金钱包流水失败')
      setCashTxs([])
      setCashTotal(0)
    } finally {
      setCashLoading(false)
    }
  }, [organizationId, cashType])

  useEffect(() => {
    void loadPayments()
  }, [loadPayments])

  useEffect(() => {
    void loadCash()
  }, [loadCash])

  const filteredPayments = useMemo(() => {
    if (statusFilter === 'all') return paymentItems
    if (statusFilter === 'default') {
      return paymentItems.filter((item) => !HIDDEN_DEFAULT_STATUSES.has(item.status))
    }
    return paymentItems.filter((item) => item.status === statusFilter)
  }, [paymentItems, statusFilter])

  return (
    <div className="space-y-3">
      <Card>
        <CardHeader className="pb-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 space-y-2">
              <div className="flex flex-wrap items-center gap-3">
                <CardTitle className="text-subtitle">账单中心</CardTitle>
                <div className="flex items-center gap-2">
                  <Button
                    size="sm"
                    variant={view === 'payment' ? 'default' : 'outline'}
                    onClick={() => setView('payment')}
                  >
                    支付订单
                  </Button>
                  <Button
                    size="sm"
                    variant={view === 'cash' ? 'default' : 'outline'}
                    onClick={() => setView('cash')}
                  >
                    现金钱包
                  </Button>
                </div>
              </div>
              <CardDescription>
                支付订单资金流水与现金钱包流水。
              </CardDescription>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => void (view === 'payment' ? loadPayments() : loadCash())}
              disabled={view === 'payment' ? paymentLoading : cashLoading}
            >
              {(view === 'payment' ? paymentLoading : cashLoading) ? (
                <Loader2 className="h-3 w-3 animate-spin" />
              ) : (
                <RefreshCw className="h-3 w-3" />
              )}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-3 pt-0">
          {view === 'payment' ? (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-caption text-muted-foreground">状态</span>
                <Select value={statusFilter} onValueChange={setStatusFilter}>
                  <SelectTrigger className="w-[160px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {PAYMENT_STATUS_FILTERS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {paymentTruncated ? (
                  <span className="text-caption text-muted-foreground">仅展示最近 500 条</span>
                ) : null}
              </div>
              {paymentError ? <ErrorBox>{paymentError}</ErrorBox> : null}
              {paymentLoading && paymentItems.length === 0 ? (
                <Loading>加载资金流水…</Loading>
              ) : filteredPayments.length === 0 ? (
                <Empty>暂无资金流水</Empty>
              ) : (
                <div className="overflow-auto rounded-md border bg-background">
                  <table className="min-w-full text-body">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">时间</th>
                        <th className="px-3 py-2 text-left font-medium">摘要</th>
                        <th className="px-3 py-2 text-left font-medium">订单号</th>
                        <th className="px-3 py-2 text-left font-medium">下单用户</th>
                        <th className="px-3 py-2 text-left font-medium">支付途径</th>
                        <th className="px-3 py-2 text-left font-medium">状态</th>
                        <th className="px-3 py-2 text-right font-medium">金额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredPayments.map((item) => {
                        const isRefund = item.kind === 'refund'
                        const amountPrefix = isRefund ? '-' : ''
                        const orderNo = isRefund
                          ? item.related_order_no || item.no
                          : item.no
                        const userLabel =
                          item.user_display_name ||
                          (item.user_id ? `${item.user_id.slice(0, 8)}…` : '—')
                        return (
                          <tr key={`${item.kind}-${item.id}`} className="border-t">
                            <td className="px-3 py-2 text-caption text-muted-foreground whitespace-nowrap">
                              {formatDateTime(item.occurred_at || item.created_at)}
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-medium">
                                {isRefund ? `退款 · ${item.summary || item.no}` : item.summary || item.no}
                              </div>
                            </td>
                            <td
                              className="px-3 py-2 font-mono text-caption max-w-[160px] truncate"
                              title={orderNo || undefined}
                            >
                              {orderNo || '—'}
                            </td>
                            <td
                              className="px-3 py-2 text-caption max-w-[140px] truncate"
                              title={item.user_id || undefined}
                            >
                              {userLabel}
                            </td>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {paymentMethodLabel(item.payment_method)}
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant="outline">{statusLabel(item.status)}</Badge>
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-mono">
                              {amountPrefix}¥{formatMoney(item.amount)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2 text-caption text-muted-foreground">
                退款如需人工处理，请通过客服工单跟进；此处只读展示流水。
              </div>
            </>
          ) : (
            <>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="text-body">
                  可用余额{' '}
                  <span className="font-medium tabular-nums">
                    ¥{cashBalance != null ? formatMoney(cashBalance) : '—'}
                  </span>
                  <span className="ml-2 text-caption text-muted-foreground">共 {cashTotal} 条</span>
                </div>
                <Select value={cashType} onValueChange={setCashType}>
                  <SelectTrigger className="w-[180px]">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {CASH_TYPE_FILTERS.map((f) => (
                      <SelectItem key={f.value} value={f.value}>
                        {f.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              {cashError ? <ErrorBox>{cashError}</ErrorBox> : null}
              {cashLoading && cashTxs.length === 0 ? (
                <Loading>加载现金钱包流水…</Loading>
              ) : cashTxs.length === 0 ? (
                <Empty>暂无现金钱包流水</Empty>
              ) : (
                <div className="overflow-auto rounded-md border bg-background">
                  <table className="min-w-full text-body">
                    <thead className="bg-muted/30">
                      <tr>
                        <th className="px-3 py-2 text-left font-medium">时间</th>
                        <th className="px-3 py-2 text-left font-medium">类型</th>
                        <th className="px-3 py-2 text-left font-medium">说明</th>
                        <th className="px-3 py-2 text-left font-medium">订单</th>
                        <th className="px-3 py-2 text-left font-medium">操作人</th>
                        <th className="px-3 py-2 text-right font-medium">金额</th>
                        <th className="px-3 py-2 text-right font-medium">余额</th>
                      </tr>
                    </thead>
                    <tbody>
                      {cashTxs.map((tx) => {
                        const membership = formatMembershipCashDetail(tx)
                        const orderDisplay = membership.orderNo || tx.related_order_id || '—'
                        const orderTitle = [
                          membership.orderNo ? `订单号 ${membership.orderNo}` : null,
                          tx.related_order_id ? `订单 ID ${tx.related_order_id}` : null,
                        ]
                          .filter(Boolean)
                          .join('\n')
                        return (
                          <tr key={tx.id} className="border-t align-top">
                            <td className="px-3 py-2 text-caption text-muted-foreground whitespace-nowrap">
                              {formatDateTime(tx.created_at)}
                            </td>
                            <td className="px-3 py-2">
                              <Badge variant="outline">{labelCashTxType(tx.transaction_type)}</Badge>
                            </td>
                            <td className="px-3 py-2">
                              <div className="font-medium">{membership.title}</div>
                              {membership.lines.length > 0 ? (
                                <div className="mt-1 space-y-0.5 text-caption text-muted-foreground">
                                  {membership.lines.map((line) => (
                                    <div key={line}>{line}</div>
                                  ))}
                                </div>
                              ) : null}
                            </td>
                            <td
                              className="px-3 py-2 font-mono text-caption max-w-[180px] truncate"
                              title={orderTitle || undefined}
                            >
                              {orderDisplay}
                            </td>
                            <td
                              className="px-3 py-2 text-caption max-w-[140px] truncate"
                              title={tx.operator_user_id || undefined}
                            >
                              {tx.operator_display_name || tx.operator_user_id || '—'}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-mono">
                              ¥{formatMoney(tx.amount_cny)}
                            </td>
                            <td className="px-3 py-2 text-right tabular-nums font-mono">
                              ¥{formatMoney(tx.balance_after_cny)}
                            </td>
                          </tr>
                        )
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>
    </div>
  )
}

function Empty({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-6 text-center text-body text-muted-foreground">
      {children}
    </div>
  )
}

function Loading({ children }: { children: ReactNode }) {
  return (
    <div className="flex h-20 items-center justify-center text-muted-foreground">
      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
      {children}
    </div>
  )
}

function ErrorBox({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-destructive/20 bg-destructive/10 px-3 py-2 text-body text-destructive">
      {children}
    </div>
  )
}
