import React, { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@tabtin/smartsheet-ui'
import type { PaymentLaunchData } from '@/types/membership'
import { PaymentMethodSelector, type MembershipPaymentMethod } from '../../payment/PaymentMethodSelector'
import { PaymentSummary } from '../../payment/PaymentSummary'
import { WalletPaymentCard } from '../../payment/WalletPaymentCard'
import { ThirdPartyPaymentCard } from '../../payment/ThirdPartyPaymentCard'

export interface MembershipPaymentTrackingStatus {
  paymentStatus: string
  benefitStatus?: string
}

export interface MembershipPaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  planName: string
  orderAmount: string
  walletBalance: string
  shortageAmount: string
  allowedMethods: Record<MembershipPaymentMethod, boolean>
  initialMethod?: MembershipPaymentMethod
  initialPaymentData?: PaymentLaunchData | null
  initialPaymentStatus?: string
  initialBenefitStatus?: string
  onWalletPay: () => Promise<MembershipPaymentTrackingStatus>
  onThirdPartyPay: (method: 'alipay' | 'wechat') => Promise<PaymentLaunchData>
  onSwitchPaymentMethod: (method: 'alipay' | 'wechat') => Promise<PaymentLaunchData>
  queryStatus: () => Promise<MembershipPaymentTrackingStatus>
  onPaymentStarted?: (data: PaymentLaunchData) => void
  onRecharge: () => void
  onSuccess: () => void
}

export const MembershipPaymentDialog: React.FC<MembershipPaymentDialogProps> = (props) => {
  const [method, setMethod] = useState<MembershipPaymentMethod>(props.initialMethod || 'organization_wallet')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [paymentData, setPaymentData] = useState<PaymentLaunchData | null>(null)
  const [qrImageSrc, setQrImageSrc] = useState<string | null>(null)
  const [paymentStatus, setPaymentStatus] = useState(props.initialPaymentStatus || 'pending')
  const [benefitStatus, setBenefitStatus] = useState(props.initialBenefitStatus || 'pending')
  const [reselectingMethod, setReselectingMethod] = useState(false)
  const [activeThirdPartyMethod, setActiveThirdPartyMethod] = useState<'alipay' | 'wechat' | null>(null)
  const [suspendedPayment, setSuspendedPayment] = useState<PaymentLaunchData | null>(null)

  useEffect(() => {
    if (props.open) {
      const initialMethod = props.initialMethod
        || (props.allowedMethods.organization_wallet ? 'organization_wallet' : props.allowedMethods.alipay ? 'alipay' : 'wechat')
      const hasStartedThirdParty = Boolean(
        props.initialPaymentData
        && (initialMethod === 'alipay' || initialMethod === 'wechat'),
      )
      setMethod(initialMethod)
      setPaymentData(props.initialPaymentData || null)
      setPaymentStatus(props.initialPaymentStatus || (props.initialPaymentData ? 'paying' : 'pending'))
      setBenefitStatus(props.initialBenefitStatus || 'pending')
      setError(null)
      setReselectingMethod(false)
      setActiveThirdPartyMethod(
        hasStartedThirdParty ? initialMethod as 'alipay' | 'wechat' : null,
      )
      setSuspendedPayment(null)
    } else {
      setLoading(false)
      setError(null)
      setPaymentData(null)
      setQrImageSrc(null)
      setPaymentStatus('pending')
      setBenefitStatus('pending')
      setReselectingMethod(false)
      setActiveThirdPartyMethod(null)
      setSuspendedPayment(null)
    }
  }, [
    props.open,
    props.initialMethod,
    props.initialPaymentData,
    props.initialPaymentStatus,
    props.initialBenefitStatus,
    props.allowedMethods.organization_wallet,
    props.allowedMethods.alipay,
    props.allowedMethods.wechat,
  ])

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
    void import('qrcode').then(({ default: QRCode }) => QRCode.toDataURL(value)).then((src) => {
      if (!cancelled) setQrImageSrc(src)
    }).catch(() => {
      if (!cancelled) setQrImageSrc(null)
    })
    return () => { cancelled = true }
  }, [paymentData])

  useEffect(() => {
    if (!props.open) return
    let cancelled = false
    let settled = false
    const poll = async () => {
      try {
        const result = await props.queryStatus()
        if (cancelled || settled) return
        setPaymentStatus(result.paymentStatus)
        setBenefitStatus(result.benefitStatus || 'pending')
        if (!['pending', 'paying'].includes(result.paymentStatus)) {
          setQrImageSrc(null)
        }
        if (isPaymentComplete(result)) {
          settled = true
          props.onSuccess()
        }
      } catch {
        // 网络抖动不打断扫码流程，下一轮继续查询。
      }
    }
    void poll()
    const timer = window.setInterval(() => void poll(), 3000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [props.open, props.queryStatus])

  const selectorAllowedMethods = useMemo(() => {
    if (!reselectingMethod) return props.allowedMethods
    // 回到渠道选择：支付宝/微信可互切；组织余额以服务端能力为准。
    return {
      organization_wallet: props.allowedMethods.organization_wallet,
      alipay: true,
      wechat: true,
    }
  }, [props.allowedMethods, reselectingMethod])

  const showMethodSelector = !paymentData || reselectingMethod
  const canSwitchPaymentMethod = Boolean(
    paymentData
    && !reselectingMethod
    && paymentStatus === 'paying'
    && (method === 'alipay' || method === 'wechat'),
  )
  const canDisplayQrCode = ['pending', 'paying'].includes(paymentStatus)
  const canConfirmPayment = !loading
    && selectorAllowedMethods[method]
    && !paymentData
    && (paymentStatus === 'pending' || reselectingMethod)
  const confirmButtonLabel = loading
    ? '处理中…'
    : reselectingMethod
      ? (method === 'organization_wallet' ? '确认支付' : '确认并生成二维码')
      : '确认支付'

  const beginReselectPaymentMethod = () => {
    if (!paymentData || loading || (method !== 'alipay' && method !== 'wechat')) return
    setSuspendedPayment(paymentData)
    setActiveThirdPartyMethod(method)
    setPaymentData(null)
    setQrImageSrc(null)
    setReselectingMethod(true)
    setError(null)
  }

  const resumeSuspendedPayment = () => {
    if (!suspendedPayment || !activeThirdPartyMethod) return
    setMethod(activeThirdPartyMethod)
    setPaymentData(suspendedPayment)
    setPaymentStatus('paying')
    setReselectingMethod(false)
    setError(null)
  }

  const submit = async () => {
    setLoading(true)
    setError(null)
    try {
      if (method === 'organization_wallet') {
        const result = await props.onWalletPay()
        setPaymentStatus(result.paymentStatus)
        setBenefitStatus(result.benefitStatus || 'pending')
        setReselectingMethod(false)
        setSuspendedPayment(null)
        if (isPaymentComplete(result)) props.onSuccess()
        return
      }

      if (
        reselectingMethod
        && activeThirdPartyMethod
        && method === activeThirdPartyMethod
        && suspendedPayment
      ) {
        resumeSuspendedPayment()
        return
      }

      if (reselectingMethod && activeThirdPartyMethod && method !== activeThirdPartyMethod) {
        const result = await props.onSwitchPaymentMethod(method)
        setPaymentData(result)
        setPaymentStatus('paying')
        setBenefitStatus('pending')
        setActiveThirdPartyMethod(method)
        setSuspendedPayment(null)
        setReselectingMethod(false)
        props.onPaymentStarted?.(result)
        return
      }

      const result = await props.onThirdPartyPay(method)
      setPaymentData(result)
      setPaymentStatus('paying')
      setActiveThirdPartyMethod(method)
      setSuspendedPayment(null)
      setReselectingMethod(false)
      props.onPaymentStarted?.(result)
    } catch (e) {
      setError(e instanceof Error ? e.message : '支付失败')
      if (reselectingMethod && suspendedPayment && activeThirdPartyMethod) {
        setMethod(activeThirdPartyMethod)
        setPaymentData(suspendedPayment)
        setPaymentStatus('paying')
        setReselectingMethod(false)
      }
    } finally {
      setLoading(false)
    }
  }

  return (
    <Dialog open={props.open} onOpenChange={props.onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader><DialogTitle>完成支付 · {props.planName}</DialogTitle></DialogHeader>
        <div className="space-y-4">
          <PaymentSummary amount={props.orderAmount} />
          {showMethodSelector ? (
            <div className="space-y-2">
              <PaymentMethodSelector
                value={method}
                onChange={setMethod}
                allowedMethods={selectorAllowedMethods}
              />
              {reselectingMethod ? (
                <p className="text-xs text-muted-foreground">
                  {method === 'organization_wallet'
                    ? '确认后将先安全关闭当前扫码订单，再用组织余额完成支付。也可继续使用当前支付方式。'
                    : '确认新渠道后，将先安全关闭当前订单，再生成对应二维码。也可继续使用当前支付方式。'}
                </p>
              ) : null}
            </div>
          ) : (
            <div className="space-y-2 rounded-md border p-3">
              <div className="flex items-center justify-between gap-3 text-sm">
                <span>
                  当前支付方式：
                  <strong className="font-medium text-foreground">
                    {method === 'alipay' ? '支付宝' : '微信支付'}
                  </strong>
                </span>
                {canSwitchPaymentMethod ? (
                  <button
                    type="button"
                    className="text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-50"
                    disabled={loading}
                    onClick={beginReselectPaymentMethod}
                  >
                    更换支付方式
                  </button>
                ) : null}
              </div>
            </div>
          )}
          {method === 'organization_wallet'
            ? <WalletPaymentCard balance={props.walletBalance} amount={props.orderAmount} shortage={props.shortageAmount} onRecharge={props.onRecharge} />
            : <>
                <ThirdPartyPaymentCard method={method} amount={props.orderAmount} />
                {qrImageSrc && canDisplayQrCode ? (
                  <div className="flex flex-col items-center gap-2 rounded-md border p-3" role="status">
                    <img src={qrImageSrc} alt={`${method === 'alipay' ? '支付宝' : '微信'}支付二维码`} className="h-48 w-48" />
                    <p className="text-sm text-muted-foreground">请使用手机扫码完成支付</p>
                    <p className={isPaymentError(paymentStatus, benefitStatus) ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
                      {paymentStatusText(paymentStatus, benefitStatus)}
                    </p>
                  </div>
                ) : paymentData && !canDisplayQrCode ? (
                  <p className="text-sm text-destructive">
                    {paymentStatusText(paymentStatus, benefitStatus)}
                  </p>
                ) : paymentData ? (
                  <p className="text-sm text-destructive">未生成可扫码的支付二维码，请关闭后重试。</p>
                ) : null}
              </>}
          {method === 'organization_wallet' && paymentStatus !== 'pending' ? (
            <p className={isPaymentError(paymentStatus, benefitStatus) ? 'text-sm text-destructive' : 'text-sm text-muted-foreground'}>
              {paymentStatusText(paymentStatus, benefitStatus)}
            </p>
          ) : null}
          {error && <p className="text-sm text-destructive">{error}</p>}
          {canConfirmPayment && (
            <button
              type="button"
              disabled={!canConfirmPayment}
              onClick={() => void submit()}
              className="w-full rounded-md bg-primary px-4 py-2 text-primary-foreground disabled:opacity-50"
            >
              {confirmButtonLabel}
            </button>
          )}
          {reselectingMethod && suspendedPayment ? (
            <button
              type="button"
              disabled={loading}
              onClick={resumeSuspendedPayment}
              className="w-full rounded-md border px-4 py-2 text-sm disabled:opacity-50"
            >
              继续当前支付
            </button>
          ) : null}
        </div>
      </DialogContent>
    </Dialog>
  )
}

const isPaymentComplete = (status: MembershipPaymentTrackingStatus) => (
  status.paymentStatus === 'completed' || status.benefitStatus === 'completed'
)

const paymentStatusText = (status: string, benefitStatus: string) => {
  if (benefitStatus === 'failed') return '支付已成功，但权益生效失败。系统不会重复扣款，请联系客服。'
  if (status === 'paid' && benefitStatus !== 'completed') return '支付成功，权益正在同步'
  if (status === 'completed' || benefitStatus === 'completed') return '支付成功，权益已生效'
  if (status === 'cancelled') return '当前支付订单已取消，请勿继续扫码'
  if (status === 'failed') return '支付失败，请关闭后重试'
  if (status === 'expired') return '订单已过期，请关闭后重新创建'
  return '等待扫码支付中…'
}

const isPaymentError = (status: string, benefitStatus: string) => (
  status === 'cancelled' || status === 'failed' || status === 'expired' || benefitStatus === 'failed'
)
