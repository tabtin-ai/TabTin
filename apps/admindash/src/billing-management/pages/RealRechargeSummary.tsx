import { AdminListCard, AdminMetricCard } from '@/components/admin-page'
import { Button } from '@/components/ui/button'
import { Banknote, Building2, Loader2, ReceiptText, RefreshCw, Users } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { type PaymentOrderItem, listPaymentOrders } from '../api/billing-admin'
import { RealRechargeDelivery } from './RealRechargeDelivery'
import { RealRechargePeriodControls } from './RealRechargePeriodControls'
import {
  type RealRechargeStats,
  type RechargePeriod,
  filterRealRechargeOrders,
  formatFenAsCny,
  labelRechargePeriod,
  summarizeRealRechargeOrders,
} from './payment-order-recharge-stats'

const STATS_PAGE_SIZE = 100
const EMPTY_STATS: RealRechargeStats = {
  amountFen: 0,
  orderCount: 0,
  userCount: 0,
  organizationCount: 0,
}
const DEFAULT_PERIOD: RechargePeriod = { key: 'current_month', startDate: '', endDate: '' }

async function fetchAllCashWalletOrders(): Promise<PaymentOrderItem[]> {
  const firstPage = await listPaymentOrders({
    order_type: 'cash_wallet',
    page: 1,
    page_size: STATS_PAGE_SIZE,
  })
  const orders = [...(firstPage.items || [])]
  const totalPages = Math.max(1, firstPage.total_pages || 1)

  for (let page = 2; page <= totalPages; page += 1) {
    const nextPage = await listPaymentOrders({
      order_type: 'cash_wallet',
      page,
      page_size: STATS_PAGE_SIZE,
    })
    orders.push(...(nextPage.items || []))
  }

  return orders
}

interface RealRechargeSummaryProps {
  onViewOrders: (orders: PaymentOrderItem[], periodLabel: string) => void
}

export function RealRechargeSummary({ onViewOrders }: RealRechargeSummaryProps) {
  const loadVersionRef = useRef(0)
  const [orders, setOrders] = useState<PaymentOrderItem[]>([])
  const [period, setPeriod] = useState<RechargePeriod>(DEFAULT_PERIOD)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const matchingOrders = useMemo(() => filterRealRechargeOrders(orders, period), [orders, period])
  const stats = useMemo(
    () => (loading ? EMPTY_STATS : summarizeRealRechargeOrders(matchingOrders)),
    [loading, matchingOrders]
  )

  const load = useCallback(async () => {
    const version = ++loadVersionRef.current
    setLoading(true)
    setError('')
    try {
      const nextOrders = await fetchAllCashWalletOrders()
      if (loadVersionRef.current !== version) return
      setOrders(nextOrders)
    } catch (caughtError) {
      if (loadVersionRef.current !== version) return
      setError(caughtError instanceof Error ? caughtError.message : '加载真实充值统计失败')
    } finally {
      if (loadVersionRef.current === version) setLoading(false)
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const displayValue = (value: string) => (loading ? '计算中…' : value)

  return (
    <AdminListCard
      title="真实充值统计"
      description="只计现金钱包充值中通过支付宝或微信已成功支付的订单，按实付金额汇总。组织余额付款、取消、过期和失败订单不计入。"
      actions={
        <div className="flex flex-wrap gap-2">
          <RealRechargeDelivery period={period} />
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            {loading ? (
              <Loader2 className="mr-2 h-[1em] w-[1em] animate-spin" />
            ) : (
              <RefreshCw className="mr-2 h-[1em] w-[1em]" />
            )}
            刷新统计
          </Button>
        </div>
      }
    >
      <RealRechargePeriodControls
        period={period}
        disabled={loading || Boolean(error)}
        onChange={setPeriod}
        onViewOrders={() => onViewOrders(matchingOrders, labelRechargePeriod(period))}
      />

      {error ? (
        <div className="mt-4 flex flex-col items-start gap-3 bg-destructive/10 p-4 text-body text-destructive">
          <p role="alert">真实充值统计加载失败：{error}</p>
          <Button variant="outline" size="sm" onClick={() => void load()}>
            重试
          </Button>
        </div>
      ) : (
        <div className="mt-4 grid gap-4 md:grid-cols-2 xl:grid-cols-4" aria-busy={loading}>
          <AdminMetricCard
            title="实付充值总额"
            value={displayValue(formatFenAsCny(stats.amountFen))}
            hint="统计 paid_amount，不重复计入组织余额消费。"
            icon={Banknote}
            tone="success"
          />
          <AdminMetricCard
            title="成功充值笔数"
            value={displayValue(stats.orderCount.toLocaleString('zh-CN'))}
            hint="状态为已支付或已完成的外部支付订单。"
            icon={ReceiptText}
          />
          <AdminMetricCard
            title="充值用户数"
            value={displayValue(stats.userCount.toLocaleString('zh-CN'))}
            hint="按操作人用户 ID 去重。"
            icon={Users}
          />
          <AdminMetricCard
            title="充值组织数"
            value={displayValue(stats.organizationCount.toLocaleString('zh-CN'))}
            hint="按订单归属的组织 ID 去重。"
            icon={Building2}
          />
        </div>
      )}
    </AdminListCard>
  )
}
