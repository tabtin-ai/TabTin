import {
  type MembershipUpgradeOrder,
  type MembershipUpgradeQuote,
  type OrganizationSubscriptionOverview,
  type OrganizationSubscriptionPlan,
  createOrganizationMembershipPurchaseOrder,
  createOrganizationMembershipUpgradeOrder,
  getActiveOrganizationMembershipPurchaseOrder,
  getActiveOrganizationMembershipUpgradeOrder,
  getOrganizationMembershipPurchaseOrder,
  getOrganizationMembershipPurchasePaymentOptions,
  getOrganizationMembershipUpgradeOrder,
  getOrganizationSubscription,
  getOrganizationSubscriptionPlans,
  payOrganizationMembershipPurchaseOrder,
  payOrganizationMembershipPurchaseWithAlipay,
  payOrganizationMembershipPurchaseWithWechat,
  payOrganizationMembershipUpgradeOrder,
  previewOrganizationMembershipUpgrade,
  switchOrganizationMembershipPurchasePaymentMethod,
} from '@/billing-management/api/billing-admin'
import { OrganizationMembershipPaymentDialog } from '@/components/spaces/organization-membership-payment-dialog'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { formatDateTime } from '@/lib/utils'
import { Loader2 } from 'lucide-react'
import { type ReactNode, useCallback, useEffect, useState } from 'react'

const money = (value?: string | number | null) =>
  `¥${Number(value ?? 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const number = (value?: string | number | null) =>
  Number(value ?? 0).toLocaleString('zh-CN', { maximumFractionDigits: 4 })

const date = (value?: string | null) => {
  if (!value) return '长期有效'
  return formatDateTime(value)
}

const bytes = (value?: number) => {
  const size = Number(value ?? 0)
  if (size >= 1024 ** 3) return `${number(size / 1024 ** 3)} GB`
  if (size >= 1024 ** 2) return `${number(size / 1024 ** 2)} MB`
  return `${number(size)} B`
}

const canSelectPlanAction = (action?: string) => action === 'upgrade' || action === 'new'

const isPurchaseOrder = (order?: MembershipUpgradeOrder | null) => order?.action === 'new'

/**
 * 组织资料「资金与套餐」内的套餐变更入口：按钮 + 选套餐 / 报价 / 支付对话框。
 * 覆盖首次订阅（new）与付费升级（upgrade）；套餐摘要由外层卡片展示。
 */
export function OrganizationSubscriptionSection({
  organizationId,
  onChanged,
}: {
  organizationId: string
  onChanged?: () => void
}) {
  const [overview, setOverview] = useState<OrganizationSubscriptionOverview | null>(null)
  const [plans, setPlans] = useState<OrganizationSubscriptionPlan[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [planDialogOpen, setPlanDialogOpen] = useState(false)
  const [upgradeDialogOpen, setUpgradeDialogOpen] = useState(false)
  const [purchaseDialogOpen, setPurchaseDialogOpen] = useState(false)
  const [selectedPlan, setSelectedPlan] = useState<OrganizationSubscriptionPlan | null>(null)
  const [quote, setQuote] = useState<MembershipUpgradeQuote | null>(null)
  const [order, setOrder] = useState<MembershipUpgradeOrder | null>(null)
  const [actionLoading, setActionLoading] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextOverview, nextPlans] = await Promise.all([
        getOrganizationSubscription(organizationId),
        getOrganizationSubscriptionPlans(organizationId),
      ])
      setOverview(nextOverview)
      setPlans(nextPlans.plans || [])
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '加载可升级套餐失败')
    } finally {
      setLoading(false)
    }
  }, [organizationId])

  useEffect(() => {
    void load()
  }, [load])

  useEffect(() => {
    let cancelled = false
    void Promise.all([
      getActiveOrganizationMembershipUpgradeOrder(organizationId).catch(() => null),
      getActiveOrganizationMembershipPurchaseOrder(organizationId).catch(() => null),
    ]).then(([upgradeOrder, purchaseOrder]) => {
      if (cancelled) return
      const activeOrder = upgradeOrder || purchaseOrder
      if (activeOrder) {
        setOrder(activeOrder)
        setQuote(null)
        setSelectedPlan(null)
      }
    })
    return () => {
      cancelled = true
    }
  }, [organizationId])

  const openPendingOrder = () => {
    setSelectedPlan(null)
    setQuote(null)
    setActionError(null)
    if (isPurchaseOrder(order)) {
      setPurchaseDialogOpen(true)
      return
    }
    setUpgradeDialogOpen(true)
  }

  const selectPlan = async (plan: OrganizationSubscriptionPlan) => {
    const pendingStatuses = new Set(['pending', 'paying', 'paid'])
    if (
      order &&
      pendingStatuses.has(order.payment_status || '') &&
      order.benefit_status !== 'completed'
    ) {
      setPlanDialogOpen(false)
      setActionError('已有未完成的套餐订单，请先继续支付或等待权益生效。')
      openPendingOrder()
      return
    }
    if (!canSelectPlanAction(plan.action)) {
      setActionError(`当前套餐动作是「${plan.button.label}」，后台暂不支持该操作。`)
      setUpgradeDialogOpen(true)
      return
    }

    setPlanDialogOpen(false)
    setSelectedPlan(plan)
    setQuote(null)
    setOrder(null)
    setActionError(null)
    setReason('')
    setTicketId('')
    setActionLoading(true)
    try {
      if (plan.action === 'new') {
        const created = await createOrganizationMembershipPurchaseOrder(
          organizationId,
          plan.id,
          overview?.membership.billing_cycle || 'monthly'
        )
        setOrder(created)
        setPurchaseDialogOpen(true)
        return
      }
      setUpgradeDialogOpen(true)
      setQuote(
        await previewOrganizationMembershipUpgrade(
          organizationId,
          plan.id,
          overview?.membership.billing_cycle || 'monthly'
        )
      )
    } catch (caught) {
      setActionError(
        caught instanceof Error
          ? caught.message
          : plan.action === 'new'
            ? '创建订阅订单失败'
            : '生成升级报价失败'
      )
      if (plan.action !== 'new') setUpgradeDialogOpen(true)
    } finally {
      setActionLoading(false)
    }
  }

  const createUpgradeOrder = async () => {
    if (!selectedPlan || !quote) return
    setActionLoading(true)
    setActionError(null)
    try {
      const created = await createOrganizationMembershipUpgradeOrder(
        organizationId,
        selectedPlan.id,
        quote.quote_token,
        quote.billing_cycle || overview?.membership.billing_cycle || 'monthly'
      )
      setOrder(created)
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '创建升级订单失败')
    } finally {
      setActionLoading(false)
    }
  }

  const payOrder = async () => {
    if (!order) return
    const payingUpgrade = !isPurchaseOrder(order)
    setActionLoading(true)
    setActionError(null)
    try {
      const paid = isPurchaseOrder(order)
        ? await payOrganizationMembershipPurchaseOrder(
            organizationId,
            order.order_id,
            reason,
            ticketId
          )
        : await payOrganizationMembershipUpgradeOrder(
            organizationId,
            order.order_id,
            reason,
            ticketId
          )
      setOrder(paid)
      await load()
      onChanged?.()
      const completed =
        paid.payment_status === 'completed' || paid.benefit_status === 'completed'
      if (payingUpgrade && completed) {
        setUpgradeDialogOpen(false)
        setSelectedPlan(null)
        setQuote(null)
        setOrder(null)
        setReason('')
        setTicketId('')
        setActionError(null)
      }
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '套餐支付失败')
    } finally {
      setActionLoading(false)
    }
  }

  const refreshOrder = async () => {
    if (!order) return
    setActionLoading(true)
    setActionError(null)
    try {
      setOrder(
        isPurchaseOrder(order)
          ? await getOrganizationMembershipPurchaseOrder(organizationId, order.order_id)
          : await getOrganizationMembershipUpgradeOrder(organizationId, order.order_id)
      )
    } catch (caught) {
      setActionError(caught instanceof Error ? caught.message : '刷新订单失败')
    } finally {
      setActionLoading(false)
    }
  }

  const orderTerminal = ['completed', 'expired', 'cancelled', 'failed'].includes(
    order?.payment_status || ''
  )
  const orderCompleted =
    order?.payment_status === 'completed' || order?.benefit_status === 'completed'
  const hasPendingOrder = Boolean(
    order &&
      !orderCompleted &&
      !orderTerminal &&
      ['pending', 'paying', 'paid'].includes(order.payment_status || '')
  )

  const clearOrderIfSettled = () => {
    const status = order?.payment_status || ''
    if (
      order?.benefit_status === 'completed' ||
      ['completed', 'expired', 'cancelled', 'failed'].includes(status)
    ) {
      setOrder(null)
    }
  }

  const closeUpgradeDialog = () => {
    setUpgradeDialogOpen(false)
    setSelectedPlan(null)
    setQuote(null)
    setActionError(null)
    setReason('')
    setTicketId('')
    // 未完成订单保留在 state，便于「继续未完成升级」；过期/完成则清掉。
    clearOrderIfSettled()
  }
  const canPayWithWallet = Boolean(
    order?.allowed_actions?.pay_with_wallet ?? order?.wallet.sufficient
  )
  const canOpenPlans = !loading && !error && plans.length > 0

  return (
    <>
      <div className="flex flex-wrap items-center gap-2">
        {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
        {error ? (
          <span className="max-w-[14rem] truncate text-caption text-destructive" title={error}>
            {error}
          </span>
        ) : null}
        {hasPendingOrder ? (
          <Button size="sm" variant="outline" onClick={openPendingOrder}>
            {isPurchaseOrder(order) ? '继续未完成订阅' : '继续未完成升级'}
          </Button>
        ) : null}
        {actionError && !upgradeDialogOpen && !purchaseDialogOpen ? (
          <span className="max-w-[16rem] truncate text-caption text-destructive" title={actionError}>
            {actionError}
          </span>
        ) : null}
        <Button
          size="sm"
          onClick={() => setPlanDialogOpen(true)}
          disabled={!canOpenPlans || hasPendingOrder}
          title={
            hasPendingOrder
              ? '请先处理未完成的套餐订单'
              : error || undefined
          }
        >
          升级套餐
        </Button>
      </div>

      <Dialog open={planDialogOpen} onOpenChange={setPlanDialogOpen}>
        <DialogContent className="max-w-5xl">
          <DialogHeader>
            <DialogTitle>选择套餐</DialogTitle>
            <DialogDescription>
              套餐动作由服务端判断。免费组织可「立即订阅」，付费组织可「升级套餐」。
            </DialogDescription>
          </DialogHeader>
          <div className="grid max-h-[65vh] gap-3 overflow-y-auto pr-1 md:grid-cols-2 xl:grid-cols-3">
            {plans.map((plan) => (
              <div key={plan.id} className="rounded-md border bg-background p-3">
                <div className="flex items-start justify-between gap-2">
                  <div>
                    <div className="font-medium">{plan.name}</div>
                    <div className="mt-1 text-caption text-muted-foreground">
                      {money(plan.monthly_price)} / 月
                    </div>
                  </div>
                  {plan.current ? (
                    <Badge>当前套餐</Badge>
                  ) : plan.recommended ? (
                    <Badge variant="outline">推荐</Badge>
                  ) : null}
                </div>
                <div className="mt-3 space-y-1 text-caption text-muted-foreground">
                  <div>月度点券 {number(plan.entitlements.included_credits)}</div>
                  <div>
                    成员 {number(plan.entitlements.max_members)} · 文档{' '}
                    {number(plan.entitlements.max_documents)}
                  </div>
                  <div>
                    表格 {number(plan.entitlements.max_tables)} · 群组{' '}
                    {number(plan.entitlements.max_groups)}
                  </div>
                  <div>存储 {bytes(plan.entitlements.storage_bytes)}</div>
                </div>
                <Button
                  className="mt-3 w-full"
                  size="sm"
                  variant={canSelectPlanAction(plan.action) ? 'default' : 'outline'}
                  disabled={
                    plan.current || plan.button.disabled || !canSelectPlanAction(plan.action)
                  }
                  onClick={() => void selectPlan(plan)}
                >
                  {plan.button.label}
                </Button>
              </div>
            ))}
          </div>
        </DialogContent>
      </Dialog>

      <Dialog
        open={upgradeDialogOpen}
        onOpenChange={(open) => !open && closeUpgradeDialog()}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>升级报价预览</DialogTitle>
          </DialogHeader>
          {actionLoading && !quote && !order ? (
            <div className="flex h-24 items-center justify-center text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              生成报价…
            </div>
          ) : quote ? (
            <div className="space-y-3 text-body">
              <Detail
                label="套餐变更"
                value={`${
                  quote.current_tier?.name ||
                  quote.current_plan ||
                  overview?.membership.tier?.name ||
                  '当前套餐'
                } → ${
                  quote.target_tier?.name ||
                  quote.target_plan ||
                  selectedPlan?.name ||
                  '目标套餐'
                }`}
              />
              <Detail
                label="当前套餐实际周期价"
                value={money(
                  quote.current_actual_paid_period_price ?? quote.current_effective_period_price
                )}
              />
              <Detail label="目标完整周期价格" value={money(quote.target_effective_period_price)} />
              <Detail label="当前套餐剩余价值" value={money(quote.current_value)} />
              <Detail label="目标套餐剩余周期价值" value={money(quote.target_value)} />
              <Detail label="抵扣金额" value={`-${money(quote.discount_amount)}`} />
              <Detail label="应付金额" value={money(quote.payable_amount)} emphasized />
              <Detail
                label="权益周期"
                value={`${date(quote.period_start)} 至 ${date(quote.period_end)}`}
              />
              {quote.quoted_at ? <Detail label="报价时间" value={date(quote.quoted_at)} /> : null}
              <Detail label="报价有效期" value={date(quote.quote_expires_at)} />
              {quote.admin_price_snapshot_backfilled || (quote.notes && quote.notes.length > 0) ? (
                <div className="rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-caption text-muted-foreground">
                  {(quote.notes && quote.notes.length > 0
                    ? quote.notes
                    : ['缺少本周期成交价快照，已按当前套餐标价补录后报价']
                  ).join('；')}
                </div>
              ) : null}
              <div className="rounded-md bg-primary/10 p-3 text-primary">
                支付成功后立即生效，原到期时间不变；下一周期按目标套餐完整价格续费。
              </div>
              {order ? <UpgradeOrderDetails order={order} /> : null}
            </div>
          ) : order && !isPurchaseOrder(order) ? (
            <div className="space-y-3 text-body">
              <div className="rounded-md bg-muted/20 p-3 text-muted-foreground">
                已恢复一笔未完成的升级订单，可继续支付或刷新订单状态。
              </div>
              <UpgradeOrderDetails order={order} />
            </div>
          ) : null}
          {order && !isPurchaseOrder(order) && !orderCompleted ? (
            <div className="space-y-2 border-t pt-3">
              <label htmlFor="membership-upgrade-reason" className="text-body font-medium">
                操作原因
              </label>
              <Input
                id="membership-upgrade-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="例如：客户工单确认升级"
              />
              <label htmlFor="membership-upgrade-ticket" className="text-body font-medium">
                工单号（选填）
              </label>
              <Input
                id="membership-upgrade-ticket"
                value={ticketId}
                onChange={(event) => setTicketId(event.target.value)}
                placeholder="例如：CS-20260729-001"
              />
            </div>
          ) : null}
          {actionError ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-body text-destructive">
              {actionError}
            </div>
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={closeUpgradeDialog} disabled={actionLoading}>
              关闭
            </Button>
            {quote && !order ? (
              <Button onClick={() => void createUpgradeOrder()} disabled={actionLoading}>
                {actionLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                继续升级 {money(quote.payable_amount)}
              </Button>
            ) : null}
            {order && !isPurchaseOrder(order) && !orderCompleted ? (
              <>
                <Button
                  variant="outline"
                  onClick={() => void refreshOrder()}
                  disabled={actionLoading}
                >
                  刷新状态
                </Button>
                <Button
                  onClick={() => void payOrder()}
                  disabled={!canPayWithWallet || !reason.trim() || actionLoading}
                >
                  {actionLoading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {canPayWithWallet ? '余额支付' : '余额不足，请先充值'}
                </Button>
              </>
            ) : null}
            {orderCompleted && !isPurchaseOrder(order) ? (
              <Button onClick={closeUpgradeDialog}>完成</Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <OrganizationMembershipPaymentDialog
        open={purchaseDialogOpen && Boolean(order && isPurchaseOrder(order))}
        onOpenChange={(open) => {
          setPurchaseDialogOpen(open)
          if (!open) {
            setActionError(null)
            clearOrderIfSettled()
          }
        }}
        planName={order?.target_plan || selectedPlan?.name || '会员套餐'}
        order={isPurchaseOrder(order) ? order : null}
        onWalletPay={async (payReason, payTicketId) => {
          if (!order) throw new Error('订阅订单不存在')
          const paid = await payOrganizationMembershipPurchaseOrder(
            organizationId,
            order.order_id,
            payReason,
            payTicketId
          )
          setOrder(paid)
          return paid
        }}
        onThirdPartyPay={async (method) => {
          if (!order) throw new Error('订阅订单不存在')
          return method === 'alipay'
            ? payOrganizationMembershipPurchaseWithAlipay(organizationId, order.order_id)
            : payOrganizationMembershipPurchaseWithWechat(organizationId, order.order_id)
        }}
        onSwitchPaymentMethod={async (method) => {
          if (!order) throw new Error('订阅订单不存在')
          return switchOrganizationMembershipPurchasePaymentMethod(
            organizationId,
            order.order_id,
            method
          )
        }}
        queryStatus={async () => {
          if (!order) throw new Error('订阅订单不存在')
          const latest = await getOrganizationMembershipPurchasePaymentOptions(
            organizationId,
            order.order_id
          )
          setOrder(latest)
          return latest
        }}
        onOrderIdChanged={(orderId) => {
          setOrder((current) =>
            current ? { ...current, order_id: orderId } : current
          )
        }}
        onSuccess={() => {
          setPurchaseDialogOpen(false)
          setOrder(null)
          void load()
          onChanged?.()
        }}
      />
    </>
  )
}

function UpgradeOrderDetails({ order }: { order: MembershipUpgradeOrder }) {
  const benefitProcessing = order.payment_status === 'paid' && order.benefit_status !== 'completed'

  return (
    <div className="space-y-2 rounded-md border bg-background p-3">
      <div className="font-medium">组织现金钱包</div>
      <Detail label="订单号" value={order.order_no} />
      <Detail label="支付状态" value={paymentStatusLabel(order.payment_status)} />
      <Detail label="权益状态" value={benefitStatusLabel(order.benefit_status)} />
      <Detail label="应付金额" value={money(order.payable_amount)} emphasized />
      <Detail
        label="组织余额"
        value={money(order.wallet.available_balance ?? order.wallet.available_cny)}
      />
      {!order.wallet.sufficient ? (
        <Detail label="余额差额" value={money(order.wallet.shortage_amount)} emphasized />
      ) : null}
      {benefitProcessing ? (
        <div className="rounded-md bg-primary/10 px-3 py-2 text-primary">
          支付成功，套餐权益正在生效。
        </div>
      ) : null}
      {order.benefit_status === 'completed' ? (
        <div className="rounded-md bg-primary/10 px-3 py-2 text-primary">
          升级成功，当前订阅和权益已刷新。
        </div>
      ) : null}
      {order.benefit_status === 'failed' ? (
        <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
          {order.failure_message || '支付已完成，但套餐权益处理异常，请联系技术人员。'}
        </div>
      ) : null}
    </div>
  )
}

const paymentStatusLabel = (status?: string) =>
  ({
    pending: '待支付',
    paying: '支付处理中',
    paid: '已支付',
    completed: '已完成',
    failed: '支付失败',
    expired: '已过期',
    cancelled: '已取消',
  })[status || ''] || '待支付'

const benefitStatusLabel = (status?: string) =>
  ({
    pending: '待发放',
    processing: '权益同步中',
    completed: '权益已生效',
    failed: '权益同步失败',
  })[status || ''] || '待发放'

function Detail({
  label,
  value,
  emphasized = false,
}: {
  label: string
  value: ReactNode
  emphasized?: boolean
}) {
  return (
    <div className="flex items-start justify-between gap-4 border-b pb-2 last:border-0">
      <span className="text-muted-foreground">{label}</span>
      <span className={emphasized ? 'font-semibold' : 'font-medium'}>{value}</span>
    </div>
  )
}
