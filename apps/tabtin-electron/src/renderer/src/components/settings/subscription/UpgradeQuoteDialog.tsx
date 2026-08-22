import React from 'react'
import { useTranslation } from 'react-i18next'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, Button, StatusNotice } from '@tabtin/smartsheet-ui'
import type { MembershipUpgradeOrder, MembershipUpgradeQuotePreview } from '@/types/membership'
import { formatDateLabel, formatPriceDisplay, resolveTierDisplayName } from './subscriptionFormat'

export const UpgradeQuoteDialog: React.FC<{
  open: boolean
  onOpenChange: (open: boolean) => void
  quote?: MembershipUpgradeQuotePreview | null
  order?: MembershipUpgradeOrder | null
  loading?: boolean
  orderLoading?: boolean
  error?: string
  onRetry?: () => void
  onCreateOrder?: () => void
  onOpenPayment?: () => void
  onRecharge?: (amount: string) => void
}> = ({
  open,
  onOpenChange,
  quote,
  order,
  loading = false,
  orderLoading = false,
  error = '',
  onRetry,
  onCreateOrder,
  onOpenPayment,
  onRecharge,
}) => {
  const { t } = useTranslation('settings')
  const localizePlanName = (name?: string | null) =>
    resolveTierDisplayName(
      name,
      undefined,
      (tierType) => t(`membership.tierNames.${tierType}`, { defaultValue: '' }),
      name?.trim() || t('membership.currentSubscription.currentPlan'),
    )
  const wallet = order?.wallet
  const canOpenPayment = Boolean(
    order?.allowed_actions?.pay_with_wallet
    || order?.allowed_actions?.pay_with_alipay
    || order?.allowed_actions?.pay_with_wechat,
  )
  const canRecharge = Boolean(order?.allowed_actions?.recharge)
  const isCompleted = order?.payment_status === 'completed' || order?.benefit_status === 'completed'
  const isBenefitProcessing = order?.payment_status === 'paid' && order?.benefit_status !== 'completed'
  const isBenefitFailed = order?.benefit_status === 'failed'

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-[620px]">
        <DialogHeader>
          <DialogTitle>升级报价预览</DialogTitle>
          <DialogDescription>
            本次升级支持组织余额、支付宝和微信支付；充值只增加余额，不会自动扣款。
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="space-y-3">
            <div className="h-6 w-2/3 animate-pulse rounded bg-muted/40" />
            <div className="h-36 animate-pulse rounded-[12px] bg-muted/30" />
          </div>
        ) : error ? (
          <StatusNotice tone="danger" description={error} />
        ) : quote ? (
          <div className="space-y-4">
            <div className="rounded-[12px] bg-muted/20 p-3 text-body text-muted-foreground">
              <div className="font-medium text-foreground">{localizePlanName(quote.current_plan)} → {localizePlanName(quote.target_plan)}</div>
              <div>当前周期：{formatDateLabel(quote.period_start)} 至 {formatDateLabel(quote.period_end)}</div>
              <div>报价时间：{formatDateLabel(quote.quoted_at)}</div>
              <div>报价过期：{formatDateLabel(quote.quote_expires_at)}</div>
            </div>
            <div className="space-y-2">
              <QuoteRow label="当前套餐实际周期价" value={formatPriceDisplay(quote.current_actual_paid_period_price ?? quote.current_effective_period_price)} />
              <QuoteRow label="目标完整周期价格" value={formatPriceDisplay(quote.target_effective_period_price)} />
              <QuoteRow label="当前套餐剩余价值" value={formatPriceDisplay(quote.current_value)} />
              <QuoteRow label="目标套餐剩余周期价值" value={formatPriceDisplay(quote.target_value)} />
              <QuoteRow label="抵扣金额" value={formatPriceDisplay(quote.discount_amount)} />
              <QuoteRow label="应付金额" value={formatPriceDisplay(quote.payable_amount)} strong />
            </div>
            <div className="rounded-[12px] bg-primary/10 p-3 text-body text-primary">
              支付成功后立即生效；原到期时间不变；下周期按目标套餐完整价格续费。
            </div>
            {order ? (
              <div className="space-y-2 rounded-[12px] border border-border bg-background p-3">
                <div className="text-body font-medium text-foreground">升级支付订单</div>
                <QuoteRow label="订单号" value={order.order_no} />
                <QuoteRow label="支付状态" value={paymentStatusLabel(order.payment_status)} />
                <QuoteRow label="权益状态" value={benefitStatusLabel(order.benefit_status)} />
                <QuoteRow label="组织余额" value={formatPriceDisplay(wallet?.available_balance ?? wallet?.available_cny ?? '0.00')} />
                {wallet && !wallet.sufficient ? (
                  <QuoteRow label="余额差额" value={formatPriceDisplay(wallet.shortage_amount)} strong />
                ) : null}
                {isBenefitProcessing ? (
                  <StatusNotice tone="info" description="支付成功，套餐权益正在生效。" />
                ) : null}
                {isCompleted ? (
                  <StatusNotice tone="success" description="升级成功，当前订阅和权益已刷新。" />
                ) : null}
                {isBenefitFailed ? (
                  <StatusNotice tone="danger" description="支付已成功，但套餐权益处理异常。系统不会重复扣款，请联系客服。" />
                ) : null}
              </div>
            ) : null}
          </div>
        ) : order ? (
          <div className="space-y-4">
            <div className="rounded-[12px] bg-muted/20 p-3 text-body text-muted-foreground">
              已恢复一笔未完成的升级订单。报价 token 不会持久化保存，如需重新选择套餐可关闭后重新获取报价。
            </div>
            <div className="space-y-2 rounded-[12px] border border-border bg-background p-3">
              <div className="text-body font-medium text-foreground">升级支付订单</div>
              <QuoteRow label="订单号" value={order.order_no} />
              <QuoteRow label="支付状态" value={paymentStatusLabel(order.payment_status)} />
              <QuoteRow label="权益状态" value={benefitStatusLabel(order.benefit_status)} />
              <QuoteRow label="应付金额" value={formatPriceDisplay(order.payable_amount)} strong />
              <QuoteRow label="组织余额" value={formatPriceDisplay(wallet?.available_balance ?? wallet?.available_cny ?? '0.00')} />
              {wallet && !wallet.sufficient ? (
                <QuoteRow label="余额差额" value={formatPriceDisplay(wallet.shortage_amount)} strong />
              ) : null}
              {isBenefitProcessing ? (
                <StatusNotice tone="info" description="支付成功，套餐权益正在生效。" />
              ) : null}
              {isCompleted ? (
                <StatusNotice tone="success" description="升级成功，当前订阅和权益已刷新。" />
              ) : null}
              {isBenefitFailed ? (
                <StatusNotice tone="danger" description="支付已成功，但套餐权益处理异常。系统不会重复扣款，请联系客服。" />
              ) : null}
            </div>
          </div>
        ) : null}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            关闭
          </Button>
          {error && onRetry ? (
            <Button type="button" onClick={onRetry}>
              重新获取报价
            </Button>
          ) : quote && !order ? (
            <Button type="button" disabled={orderLoading} onClick={onCreateOrder}>
              {orderLoading ? '创建订单中…' : `继续升级 ${formatPriceDisplay(quote.payable_amount)}`}
            </Button>
          ) : order ? (
            <div className="flex gap-2">
              {canOpenPayment && <Button type="button" disabled={orderLoading} onClick={onOpenPayment}>选择支付方式</Button>}
              {!order.allowed_actions?.pay_with_wallet && canRecharge && <Button type="button" variant="outline" disabled={orderLoading} onClick={() => onRecharge?.(order.wallet.recommended_recharge_amount)}>充值</Button>}
            </div>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

const QuoteRow: React.FC<{ label: string; value: string; strong?: boolean }> = ({ label, value, strong }) => (
  <div className="flex items-center justify-between gap-4 text-body">
    <span className="text-muted-foreground">{label}</span>
    <span className={strong ? 'text-title font-semibold text-foreground' : 'text-foreground'}>{value}</span>
  </div>
)

const paymentStatusLabel = (status?: string) => ({
  pending: '待支付',
  paying: '支付处理中',
  paid: '已支付',
  failed: '支付失败',
  expired: '已过期',
  cancelled: '已取消',
}[status || ''] || '状态未知')

const benefitStatusLabel = (status?: string) => ({
  pending: '待发放',
  processing: '权益同步中',
  completed: '权益已生效',
  failed: '权益同步失败',
}[status || ''] || '状态未知')

UpgradeQuoteDialog.displayName = 'UpgradeQuoteDialog'
