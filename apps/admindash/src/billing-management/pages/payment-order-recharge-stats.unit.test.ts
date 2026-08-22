import { describe, expect, it } from 'vitest'
import type { PaymentOrderItem } from '../api/billing-admin'
import {
  type RechargePeriod,
  filterRealRechargeOrders,
  formatFenAsCny,
  isRealRechargeOrder,
  labelRechargePeriod,
  summarizeRealRechargeOrders,
} from './payment-order-recharge-stats'

function makeOrder(overrides: Partial<PaymentOrderItem> = {}): PaymentOrderItem {
  return {
    id: 'order-1',
    organization_id: 'organization-1',
    organization_name: '测试组织',
    order_no: '202608110001',
    order_type: 'cash_wallet',
    subject: '现金钱包充值',
    status: 'completed',
    payment_method: 'wechat',
    amount: '50.00',
    paid_amount: '50.00',
    paid_at: '2026-08-11T10:00:00+08:00',
    created_at: '2026-08-11T09:59:00+08:00',
    expired_at: '2026-08-11T10:14:00+08:00',
    user_id: 'user-1',
    operator_user_id: 'user-1',
    operator_name: '测试用户',
    ...overrides,
  }
}

describe('真实充值统计口径', () => {
  it('只识别支付宝或微信的成功现金钱包充值', () => {
    expect(isRealRechargeOrder(makeOrder())).toBe(true)
    expect(isRealRechargeOrder(makeOrder({ payment_method: 'alipay', status: 'paid' }))).toBe(true)
    expect(isRealRechargeOrder(makeOrder({ payment_method: 'organization_wallet' }))).toBe(false)
    expect(isRealRechargeOrder(makeOrder({ order_type: 'membership' }))).toBe(false)
    expect(isRealRechargeOrder(makeOrder({ status: 'expired' }))).toBe(false)
  })

  it('按实付金额汇总，并对用户和组织去重', () => {
    const stats = summarizeRealRechargeOrders([
      makeOrder({ id: 'order-1', paid_amount: '50' }),
      makeOrder({ id: 'order-2', paid_amount: '0.01', payment_method: 'alipay' }),
      makeOrder({
        id: 'order-3',
        organization_id: 'organization-2',
        user_id: 'user-2',
        operator_user_id: 'user-2',
        paid_amount: '12.30',
      }),
      makeOrder({ id: 'order-4', status: 'cancelled', paid_amount: '999.00' }),
    ])

    expect(stats).toEqual({
      amountFen: 6231,
      orderCount: 3,
      userCount: 2,
      organizationCount: 2,
    })
    expect(formatFenAsCny(stats.amountFen)).toBe('¥62.31')
  })

  it('按支付时间过滤本月、近 30 天和自定义范围', () => {
    const now = new Date('2026-08-11T12:00:00+08:00')
    const orders = [
      makeOrder({ id: 'august', paid_at: '2026-08-01T00:00:00+08:00' }),
      makeOrder({ id: 'july', paid_at: '2026-07-20T12:00:00+08:00' }),
      makeOrder({ id: 'old', paid_at: '2026-06-01T12:00:00+08:00' }),
      makeOrder({ id: 'cancelled', paid_at: '2026-08-10T12:00:00+08:00', status: 'cancelled' }),
    ]

    const filter = (period: RechargePeriod) =>
      filterRealRechargeOrders(orders, period, now).map((order) => order.id)

    expect(filter({ key: 'current_month', startDate: '', endDate: '' })).toEqual(['august'])
    expect(filter({ key: 'last_30_days', startDate: '', endDate: '' })).toEqual(['august', 'july'])
    expect(filter({ key: 'custom', startDate: '2026-07-20', endDate: '2026-08-01' })).toEqual([
      'august',
      'july',
    ])
    expect(labelRechargePeriod({ key: 'custom', startDate: '2026-08-01', endDate: '' })).toBe(
      '2026-08-01 起'
    )
  })
})
