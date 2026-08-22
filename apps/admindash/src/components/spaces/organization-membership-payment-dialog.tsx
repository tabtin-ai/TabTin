import type { MembershipPaymentLaunchData, MembershipUpgradeOrder } from '@/billing-management/api/billing-admin'
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
import { Loader2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'

export type AdminMembershipPaymentMethod = 'organization_wallet' | 'alipay' | 'wechat'

const money = (value?: string | number | null) =>
  `¥${Number(value ?? 0).toLocaleString('zh-CN', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`

const isPaymentComplete = (paymentStatus?: string, benefitStatus?: string) =>
  paymentStatus === 'completed' || benefitStatus === 'completed'

const isOrderExpired = (paymentStatus?: string) =>
  paymentStatus === 'expired' || paymentStatus === 'cancelled' || paymentStatus === 'failed'

const METHOD_LABEL: Record<AdminMembershipPaymentMethod, string> = {
  organization_wallet: '组织余额',
  alipay: '支付宝',
  wechat: '微信支付',
}

export function OrganizationMembershipPaymentDialog({
  open,
  onOpenChange,
  planName,
  order,
  onWalletPay,
  onThirdPartyPay,
  onSwitchPaymentMethod,
  queryStatus,
  onSuccess,
  onOrderIdChanged,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  planName: string
  order: MembershipUpgradeOrder | null
  onWalletPay: (reason: string, ticketId: string) => Promise<MembershipUpgradeOrder>
  onThirdPartyPay: (method: 'alipay' | 'wechat') => Promise<MembershipPaymentLaunchData>
  onSwitchPaymentMethod: (method: 'alipay' | 'wechat') => Promise<MembershipPaymentLaunchData>
  queryStatus: () => Promise<MembershipUpgradeOrder>
  onSuccess: () => void
  onOrderIdChanged?: (orderId: string) => void
}) {
  const [method, setMethod] = useState<AdminMembershipPaymentMethod>('organization_wallet')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [reason, setReason] = useState('')
  const [ticketId, setTicketId] = useState('')
  const [paymentData, setPaymentData] = useState<MembershipPaymentLaunchData | null>(null)
  const [qrImageSrc, setQrImageSrc] = useState<string | null>(null)
  const [paymentStatus, setPaymentStatus] = useState('pending')
  const [benefitStatus, setBenefitStatus] = useState('pending')
  const [reselectingMethod, setReselectingMethod] = useState(false)
  const [walletBalance, setWalletBalance] = useState('0.00')
  const [shortageAmount, setShortageAmount] = useState('0.00')
  const queryStatusRef = useRef(queryStatus)
  const onSuccessRef = useRef(onSuccess)
  const onOrderIdChangedRef = useRef(onOrderIdChanged)
  queryStatusRef.current = queryStatus
  onSuccessRef.current = onSuccess
  onOrderIdChangedRef.current = onOrderIdChanged

  const allowedMethods = useMemo(
    () => ({
      organization_wallet: Boolean(
        order?.allowed_actions?.organization_wallet ?? order?.allowed_actions?.pay_with_wallet
      ),
      alipay: Boolean(order?.allowed_actions?.alipay ?? order?.allowed_actions?.pay_with_alipay),
      wechat: Boolean(order?.allowed_actions?.wechat ?? order?.allowed_actions?.pay_with_wechat),
    }),
    [order]
  )

  useEffect(() => {
    if (!open || !order) return
    // 新建订单默认 payment_method=organization_wallet，优先余额；扫码进行中才跟订单渠道。
    const initialMethod: AdminMembershipPaymentMethod =
      order.payment_status === 'paying' &&
      (order.payment_method === 'alipay' || order.payment_method === 'wechat')
        ? order.payment_method
        : allowedMethods.organization_wallet
          ? 'organization_wallet'
          : allowedMethods.alipay
            ? 'alipay'
            : 'wechat'
    setMethod(initialMethod)
    setPaymentData(order.payment_data || null)
    setPaymentStatus(order.payment_status || 'pending')
    setBenefitStatus(order.benefit_status || 'pending')
    setWalletBalance(order.wallet.available_balance || order.wallet.available_cny || '0.00')
    setShortageAmount(order.wallet.shortage_amount || '0.00')
    setError(
      isOrderExpired(order.payment_status)
        ? '订单已过期，请关闭后重新点击「升级套餐」创建新订单。'
        : null
    )
    setReason('')
    setTicketId('')
    setReselectingMethod(false)
  }, [open, order?.order_id])

  useEffect(() => {
    const value = paymentData?.qr_code || paymentData?.pay_url
    if (!value) {
      setQrImageSrc(null)
      return
    }
    if (value.startsWith('data:image/')) {
      setQrImageSrc(value)
      return
    }
    let cancelled = false
    void import('qrcode')
      .then(({ default: QRCode }) => QRCode.toDataURL(value))
      .then((src) => {
        if (!cancelled) setQrImageSrc(src)
      })
      .catch(() => {
        if (!cancelled) setQrImageSrc(null)
      })
    return () => {
      cancelled = true
    }
  }, [paymentData])

  // 仅第三方扫码轮询；余额支付不轮询。paid 且权益未落定时继续等到 completed/failed。
  const shouldPollThirdParty =
    open &&
    Boolean(order) &&
    (method === 'alipay' || method === 'wechat') &&
    (paymentStatus === 'paying' ||
      (paymentStatus === 'paid' &&
        benefitStatus !== 'completed' &&
        benefitStatus !== 'failed'))

  useEffect(() => {
    if (!shouldPollThirdParty || !order) return
    let cancelled = false
    let settled = false
    const poll = async () => {
      try {
        const latest = await queryStatusRef.current()
        if (cancelled || settled) return
        setPaymentStatus(latest.payment_status)
        setBenefitStatus(latest.benefit_status || 'pending')
        setWalletBalance(
          latest.wallet.available_balance || latest.wallet.available_cny || '0.00'
        )
        setShortageAmount(latest.wallet.shortage_amount || '0.00')
        if (latest.payment_data) setPaymentData(latest.payment_data)
        if (latest.order_id && latest.order_id !== order.order_id) {
          onOrderIdChangedRef.current?.(latest.order_id)
        }
        if (isOrderExpired(latest.payment_status)) {
          setError('订单已过期，请关闭后重新点击「升级套餐」创建新订单。')
          return
        }
        if (latest.benefit_status === 'failed') {
          setError(latest.failure_message || '支付成功但套餐权益未生效，请联系技术排查。')
          return
        }
        if (isPaymentComplete(latest.payment_status, latest.benefit_status)) {
          settled = true
          onSuccessRef.current()
        }
      } catch {
        // 轮询失败不打断扫码。
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 3000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [shouldPollThirdParty, order?.order_id])

  const selectorAllowed = reselectingMethod
    ? {
        organization_wallet: allowedMethods.organization_wallet,
        alipay: true,
        wechat: true,
      }
    : allowedMethods

  const showMethodSelector = !paymentData || reselectingMethod
  const canConfirm =
    !loading &&
    !isOrderExpired(paymentStatus) &&
    selectorAllowed[method] &&
    (!paymentData || reselectingMethod) &&
    (paymentStatus === 'pending' || reselectingMethod)

  const submit = async () => {
    setLoading(true)
    setError(null)
    try {
      if (method === 'organization_wallet') {
        if (!reason.trim()) {
          setError('使用组织余额支付必须填写操作原因')
          return
        }
        const paid = await onWalletPay(reason.trim(), ticketId.trim())
        setPaymentStatus(paid.payment_status)
        setBenefitStatus(paid.benefit_status || 'pending')
        setReselectingMethod(false)
        if (paid.order_id) onOrderIdChanged?.(paid.order_id)
        // 余额支付：paid + benefit 完成才算成功；仅 paid 也刷新权益结果。
        if (
          isPaymentComplete(paid.payment_status, paid.benefit_status) ||
          paid.payment_status === 'paid'
        ) {
          if (paid.benefit_status === 'failed') {
            setError(paid.failure_message || '扣款成功但套餐权益未生效，请联系技术排查。')
            return
          }
          onSuccess()
        }
        return
      }

      if (reselectingMethod) {
        const launched = await onSwitchPaymentMethod(method)
        setPaymentData(launched)
        setPaymentStatus('paying')
        setBenefitStatus('pending')
        setReselectingMethod(false)
        if (launched.order_id) onOrderIdChanged?.(launched.order_id)
        return
      }

      const launched = await onThirdPartyPay(method)
      setPaymentData(launched)
      setPaymentStatus('paying')
      setBenefitStatus('pending')
      if (launched.order_id) onOrderIdChanged?.(launched.order_id)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : '支付失败')
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>完成支付 · {planName}</DialogTitle>
          <DialogDescription>
            与 Electron 相同：可选组织余额、支付宝或微信。余额支付需填写操作原因。
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 text-body">
          <div className="rounded-md border bg-muted/20 px-3 py-2">
            <div className="text-caption text-muted-foreground">应付金额</div>
            <div className="text-title font-semibold">{money(order?.payable_amount)}</div>
          </div>

          {showMethodSelector ? (
            <div className="space-y-2">
              <div className="text-body font-medium">支付方式</div>
              {(Object.keys(METHOD_LABEL) as AdminMembershipPaymentMethod[]).map((key) => (
                <label
                  key={key}
                  className={`flex cursor-pointer items-center justify-between rounded-md border px-3 py-2 ${
                    method === key ? 'border-primary bg-primary/5' : ''
                  } ${!selectorAllowed[key] ? 'cursor-not-allowed opacity-50' : ''}`}
                >
                  <span>{METHOD_LABEL[key]}</span>
                  <input
                    type="radio"
                    name="admin-membership-pay-method"
                    checked={method === key}
                    disabled={!selectorAllowed[key]}
                    onChange={() => setMethod(key)}
                  />
                </label>
              ))}
            </div>
          ) : (
            <div className="flex items-center justify-between rounded-md border px-3 py-2">
              <span>
                当前支付方式：
                <strong>{METHOD_LABEL[method] || method}</strong>
              </span>
              {paymentStatus === 'paying' && (method === 'alipay' || method === 'wechat') ? (
                <button
                  type="button"
                  className="text-caption text-primary hover:underline"
                  disabled={loading}
                  onClick={() => {
                    setPaymentData(null)
                    setQrImageSrc(null)
                    setReselectingMethod(true)
                  }}
                >
                  更换支付方式
                </button>
              ) : null}
            </div>
          )}

          {method === 'organization_wallet' ? (
            <div className="space-y-2 rounded-md border px-3 py-2">
              <div className="flex justify-between gap-3">
                <span className="text-muted-foreground">组织余额</span>
                <span className="tabular-nums">{money(walletBalance)}</span>
              </div>
              {Number(shortageAmount) > 0 ? (
                <div className="text-caption text-destructive">
                  余额不足，差额 {money(shortageAmount)}。可先到「配额与权益」充值，或改用扫码支付。
                </div>
              ) : (
                <div className="text-caption text-muted-foreground">余额充足，确认后立即扣款并生效。</div>
              )}
              <label className="block text-body font-medium" htmlFor="admin-membership-pay-reason">
                操作原因
              </label>
              <Input
                id="admin-membership-pay-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                placeholder="例如：客户工单确认订阅"
              />
              <label className="block text-body font-medium" htmlFor="admin-membership-pay-ticket">
                工单号（选填）
              </label>
              <Input
                id="admin-membership-pay-ticket"
                value={ticketId}
                onChange={(event) => setTicketId(event.target.value)}
                placeholder="例如：CS-20260731-001"
              />
            </div>
          ) : null}

          {(method === 'alipay' || method === 'wechat') && paymentData ? (
            <div className="space-y-2 rounded-md border px-3 py-3 text-center">
              {qrImageSrc ? (
                <img src={qrImageSrc} alt="支付二维码" className="mx-auto h-48 w-48" />
              ) : (
                <div className="flex h-48 items-center justify-center text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  生成二维码…
                </div>
              )}
              <p className="text-caption text-muted-foreground">
                请使用{METHOD_LABEL[method]}扫码支付。支付完成后会自动刷新权益。
              </p>
            </div>
          ) : null}

          {error ? (
            <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-destructive">
              {error}
            </div>
          ) : null}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={loading}>
            关闭
          </Button>
          {canConfirm ? (
            <Button onClick={() => void submit()} disabled={loading}>
              {loading ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
              {method === 'organization_wallet' ? '确认余额支付' : '确认并生成二维码'}
            </Button>
          ) : null}
          {isPaymentComplete(paymentStatus, benefitStatus) ? (
            <Button disabled>支付完成</Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
