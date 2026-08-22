import type { PaymentOrderItem } from '../api/billing-admin'

const EXTERNAL_PAYMENT_METHODS = new Set(['alipay', 'wechat'])
const SUCCESSFUL_PAYMENT_STATUSES = new Set(['paid', 'completed'])

export interface RealRechargeStats {
  amountFen: number
  orderCount: number
  userCount: number
  organizationCount: number
}

export type RechargePeriodKey = 'today' | 'current_month' | 'last_30_days' | 'all' | 'custom'

export interface RechargePeriod {
  key: RechargePeriodKey
  startDate: string
  endDate: string
}

function parseCnyToFen(value?: string | null): number {
  const normalized = (value || '').trim()
  const match = normalized.match(/^(\d+)(?:\.(\d{1,2}))?$/)
  if (!match) return 0

  const yuan = Number(match[1])
  const fen = Number((match[2] || '').padEnd(2, '0'))
  if (!Number.isSafeInteger(yuan) || !Number.isSafeInteger(fen)) return 0

  const totalFen = yuan * 100 + fen
  return Number.isSafeInteger(totalFen) ? totalFen : 0
}

export function isRealRechargeOrder(order: PaymentOrderItem): boolean {
  return (
    order.order_type === 'cash_wallet' &&
    EXTERNAL_PAYMENT_METHODS.has(order.payment_method) &&
    SUCCESSFUL_PAYMENT_STATUSES.has(order.status)
  )
}

export function summarizeRealRechargeOrders(orders: PaymentOrderItem[]): RealRechargeStats {
  const userIds = new Set<string>()
  const organizationIds = new Set<string>()
  let amountFen = 0
  let orderCount = 0

  for (const order of orders) {
    if (!isRealRechargeOrder(order)) continue

    amountFen += parseCnyToFen(order.paid_amount)
    orderCount += 1

    const userId = (order.operator_user_id || order.user_id || '').trim()
    if (userId) userIds.add(userId)

    const organizationId = (order.organization_id || '').trim()
    if (organizationId) organizationIds.add(organizationId)
  }

  return {
    amountFen,
    orderCount,
    userCount: userIds.size,
    organizationCount: organizationIds.size,
  }
}

function localDateStart(value: string): Date | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null
  const date = new Date(`${value}T00:00:00`)
  return Number.isNaN(date.getTime()) ? null : date
}

function addDays(date: Date, days: number): Date {
  const next = new Date(date)
  next.setDate(next.getDate() + days)
  return next
}

function rechargePeriodBounds(
  period: RechargePeriod,
  now: Date
): { start: Date | null; end: Date | null } {
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())

  switch (period.key) {
    case 'today':
      return { start: today, end: addDays(today, 1) }
    case 'current_month':
      return {
        start: new Date(now.getFullYear(), now.getMonth(), 1),
        end: new Date(now.getFullYear(), now.getMonth() + 1, 1),
      }
    case 'last_30_days':
      return { start: addDays(today, -29), end: addDays(today, 1) }
    case 'custom': {
      const start = localDateStart(period.startDate)
      const endDate = localDateStart(period.endDate)
      return { start, end: endDate ? addDays(endDate, 1) : null }
    }
    case 'all':
      return { start: null, end: null }
  }
}

export function filterRealRechargeOrders(
  orders: PaymentOrderItem[],
  period: RechargePeriod,
  now = new Date()
): PaymentOrderItem[] {
  const { start, end } = rechargePeriodBounds(period, now)

  return orders.filter((order) => {
    if (!isRealRechargeOrder(order)) return false
    if (!start && !end) return true
    if (!order.paid_at) return false

    const paidAt = new Date(order.paid_at)
    if (Number.isNaN(paidAt.getTime())) return false
    return (!start || paidAt >= start) && (!end || paidAt < end)
  })
}

export function labelRechargePeriod(period: RechargePeriod): string {
  switch (period.key) {
    case 'today':
      return '今日'
    case 'current_month':
      return '本月'
    case 'last_30_days':
      return '近 30 天'
    case 'all':
      return '全部时间'
    case 'custom':
      if (period.startDate && period.endDate) return `${period.startDate} 至 ${period.endDate}`
      if (period.startDate) return `${period.startDate} 起`
      if (period.endDate) return `截至 ${period.endDate}`
      return '自定义时间'
  }
}

export function formatFenAsCny(amountFen: number): string {
  return `¥${(amountFen / 100).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`
}
