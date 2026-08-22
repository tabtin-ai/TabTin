import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type QRCodeLib from 'qrcode'
import { CheckCircle2, Clock, ExternalLink, Loader2, QrCode, XCircle } from 'lucide-react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  Button,
} from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type {
  PaymentLaunchData,
  PaymentMethod,
  PaymentOrderStatus,
} from '@/types/membership'
import { PaymentApiService } from '@services/paymentApi'
import { usePaymentPolling } from '@/hooks/usePaymentPolling'
import { cn } from '@utils/cn'
import { SETTINGS_HINT, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE } from '../settingsUi'

export type PaymentCheckoutOrderType =
  | 'membership'
  | 'credits'
  | 'storage_package'
  | 'billing_addon'
  | 'cash_wallet'

/** 结账意图：在用户选择支付方式、创建订单之前就能渲染的展示信息 */
export interface PaymentCheckoutIntent {
  orderType: PaymentCheckoutOrderType
  tierName?: string
  creditsAmount?: number
  storagePackageName?: string
  addonPackageName?: string
  /** 已格式化的应付金额，如 "¥99.00" */
  amountLabel?: string
}

const QR_FALLBACK_URL = 'https://api.qrserver.com/v1/create-qr-code/?size=300x300&margin=1&data='

/**
 * PAY-09 / PAY-UX-4: 本地生成二维码，避免依赖外部 qrserver.com（国内不稳定）。
 * 支付宝 qr_code 是页面 URL → 本地 QRCode.toDataURL；微信是 base64 PNG data URI → 直传。
 */
function useLocalQrCode(url: string | null): string | null {
  const [dataUrl, setDataUrl] = useState<string | null>(() => {
    if (url?.startsWith('data:image/')) return url
    return null
  })

  useEffect(() => {
    if (!url) { setDataUrl(null); return }
    if (url.startsWith('data:image/')) { setDataUrl(url); return }
    if (url.startsWith('weixin://')) { setDataUrl(null); return }

    let cancelled = false
    import('qrcode')
      .then((mod: { default?: typeof QRCodeLib } & typeof QRCodeLib) => {
        const QRCode = mod.default ?? mod
        return QRCode.toDataURL(url, { width: 300, margin: 1 })
      })
      .then((result) => {
        if (!cancelled) setDataUrl(result)
      })
      .catch(() => {
        if (!cancelled) setDataUrl(`${QR_FALLBACK_URL}${encodeURIComponent(url)}`)
      })
    return () => { cancelled = true }
  }, [url])

  return dataUrl
}

const QrCodeImage: React.FC<{ src: string; scanLabel: string; payUrl?: string; onOpenBrowser: () => void; openBrowserLabel: string }> = ({
  src,
  scanLabel,
  payUrl,
  onOpenBrowser,
  openBrowserLabel,
}) => {
  const [hasError, setHasError] = useState(false)
  return (
    <>
      <div className="rounded-lg border border-border/60 bg-background p-3">
        {hasError ? (
          <div className="h-48 w-48 flex items-center justify-center">
            <QrCode className="h-12 w-12 text-muted-foreground/60" />
          </div>
        ) : (
          <img
            src={src}
            alt="Payment QR"
            className="h-48 w-48 object-contain"
            onError={() => setHasError(true)}
          />
        )}
      </div>
      <div className={SETTINGS_TEXT_META}>{scanLabel}</div>
      {payUrl && !hasError && (
        <button
          type="button"
          onClick={onOpenBrowser}
          className={cn(SETTINGS_TEXT_META_BASE, 'text-accent', 'hover:text-accent/80 transition-colors')}
        >
          <ExternalLink className="inline h-3 w-3 mr-0.5" />
          {openBrowserLabel}
        </button>
      )}
    </>
  )
}

interface PaymentDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** 结账意图（订单类型 / 展示信息）。订单在用户选定支付方式后才创建。 */
  intent: PaymentCheckoutIntent | null
  /** 用选定的支付方式创建订单，返回支付二维码等数据。失败时抛错，由本组件展示。 */
  createOrder: (method: PaymentMethod) => Promise<PaymentLaunchData>
  onPaymentSuccess: () => void
  /** FE-35: 充值成功后由父组件传入的最新余额，用于成功界面展示 */
  newBalancePrecise?: string | number
  /** 打开时预选的支付方式（如充值页已选支付宝/微信） */
  initialPaymentMethod?: PaymentMethod
  /** 锁定支付方式：隐藏 Dialog 内选择器，沿用 initialPaymentMethod */
  lockPaymentMethod?: boolean
}

export const PaymentDialog: React.FC<PaymentDialogProps> = ({
  open,
  onOpenChange,
  intent,
  createOrder,
  onPaymentSuccess,
  newBalancePrecise,
  initialPaymentMethod = 'alipay',
  lockPaymentMethod = false,
}) => {
  const { t } = useTranslation('settings')

  // 支付方式在 Dialog 内选择（或由父页锁定）；订单数据在「确认支付」后才生成
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(initialPaymentMethod)
  const [paymentData, setPaymentData] = useState<PaymentLaunchData | null>(null)
  const [creating, setCreating] = useState(false)
  const [createError, setCreateError] = useState<string | null>(null)

  const orderType = intent?.orderType ?? 'membership'
  const tierName = intent?.tierName
  const creditsAmount = intent?.creditsAmount
  const storagePackageName = intent?.storagePackageName
  const addonPackageName = intent?.addonPackageName

  const pollingT = useMemo(() => ({
    expired: t('membership.paymentDialog.expired', '支付已过期，请重新发起'),
    timeout: t('membership.orderTracking.timeout'),
    queryFailed: t('membership.orderTracking.queryFailed'),
    countdown: (minutes: number, seconds: number) =>
      t('membership.paymentDialog.countdown', { minutes, seconds }),
  }), [t])

  const successCallbackFiredRef = useRef(false)

  const handleTerminal = useCallback((terminalStatus: PaymentOrderStatus) => {
    if (terminalStatus === 'paid' || terminalStatus === 'completed') {
      if (!successCallbackFiredRef.current) {
        successCallbackFiredRef.current = true
        onPaymentSuccess()
      }
    }
  }, [onPaymentSuccess])

  const dynamicMaxAttempts = useMemo(() => {
    if (paymentData?.expired_at) {
      const remaining = new Date(paymentData.expired_at).getTime() - Date.now()
      if (remaining > 0) {
        return Math.ceil(remaining / 3000) + 10
      }
    }
    return 600
  }, [paymentData?.expired_at])

  const dialogOpenTimeRef = useRef(0)
  const qrImageSrc = useLocalQrCode(paymentData?.qr_code ?? null)

  const { status, error, countdown, pollTick, stopPolling, reset, restartPolling } = usePaymentPolling({
    orderNo: paymentData?.order_no ?? null,
    expiredAt: paymentData?.expired_at,
    enabled: open && !!paymentData?.order_no,
    maxAttempts: dynamicMaxAttempts,
    queryOrder: PaymentApiService.queryOrder,
    onTerminal: handleTerminal,
    t: pollingT,
  })

  const isTerminal = status === 'paid' || status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired'
  const isSuccess = status === 'paid' || status === 'completed'

  useEffect(() => {
    if (open) {
      dialogOpenTimeRef.current = Date.now()
      setPaymentMethod(initialPaymentMethod)
    } else {
      // 关闭后回到「选择支付方式」初始态，下次开启重新走结账流程
      reset()
      successCallbackFiredRef.current = false
      setPaymentData(null)
      setCreateError(null)
      setCreating(false)
      setPaymentMethod(initialPaymentMethod)
    }
  }, [open, reset, initialPaymentMethod])

  // FE-04: weixin:// 类型 QR 码在 Dialog 打开时自动调用 openExternal 唤起微信
  useEffect(() => {
    if (open && paymentData?.qr_code?.startsWith('weixin://')) {
      void window.tabtin?.openExternal?.(paymentData.qr_code)
    }
  }, [open, paymentData?.qr_code])

  const handleOpenBrowser = () => {
    if (paymentData?.pay_url) {
      window.open(paymentData.pay_url, '_blank', 'noopener')
    }
  }

  const handleOpenWeixin = () => {
    if (paymentData?.qr_code?.startsWith('weixin://')) {
      void window.tabtin?.openExternal?.(paymentData.qr_code)
    }
  }

  const handleClose = () => {
    if (!isTerminal && paymentData?.order_no) {
      const openedLongEnough = Date.now() - dialogOpenTimeRef.current > 10_000
      if (openedLongEnough) {
        const confirmed = window.confirm(t('membership.paymentDialog.closeConfirm'))
        if (!confirmed) return
      }
    }
    stopPolling()
    if (!isTerminal && paymentData?.order_no) {
      void PaymentApiService.cancelOrder(paymentData.order_no).catch(() => {})
    }
    if (isSuccess && !successCallbackFiredRef.current) {
      successCallbackFiredRef.current = true
      onPaymentSuccess()
    }
    onOpenChange(false)
  }

  const handleRetryQuery = () => {
    restartPolling()
  }

  const handleConfirmPay = async () => {
    if (creating) return
    setCreating(true)
    setCreateError(null)
    try {
      const data = await createOrder(paymentMethod)
      dialogOpenTimeRef.current = Date.now()
      setPaymentData(data)
    } catch (e: unknown) {
      setCreateError(e instanceof Error ? e.message : t('membership.errors.purchaseFailed'))
    } finally {
      setCreating(false)
    }
  }

  if (!intent) return null

  const orderLabel = orderType === 'membership'
    ? `${t('membership.orderTracking.membershipOrder')}${tierName ? ` · ${tierName}` : ''}`
    : orderType === 'credits'
      ? `${t('membership.orderTracking.creditsOrder')}${creditsAmount ? ` · ${creditsAmount}` : ''}`
      : orderType === 'billing_addon'
        ? `${t('membership.orderTracking.addonOrder')}${addonPackageName ? ` · ${addonPackageName}` : ''}`
        : orderType === 'cash_wallet'
          ? t('membership.orderTracking.cashWalletOrder', { defaultValue: '现金钱包充值' })
          : `${t('membership.orderTracking.storageOrder')}${storagePackageName ? ` · ${storagePackageName}` : ''}`

  const payMethodLabel = paymentMethod === 'alipay'
    ? t('membership.paymentMethods.alipay')
    : t('membership.paymentMethods.wechat')

  return (
    <Dialog open={open} onOpenChange={(isOpen) => { if (!isOpen) handleClose() }}>
      <DialogContent className="sm:max-w-sm p-0 overflow-hidden">
        <DialogHeader className="px-5 pt-5 pb-0">
          <DialogTitle className="text-subtitle font-semibold">
            {t('membership.paymentDialog.title')}
          </DialogTitle>
          <DialogDescription className={SETTINGS_TEXT_META}>
            {paymentData ? `${orderLabel} · ${payMethodLabel}` : orderLabel}
          </DialogDescription>
        </DialogHeader>

        {/* 第一步：选择支付方式（订单尚未创建） */}
        {!paymentData && (
          <div className="px-5 pb-5 pt-4 space-y-4">
            {intent.amountLabel && (
              <div className="flex items-baseline justify-between">
                <span className={SETTINGS_TEXT_META}>
                  {t('membership.paymentDialog.payable')}
                </span>
                <span className="text-subtitle font-semibold text-foreground tabular-nums">
                  {intent.amountLabel}
                </span>
              </div>
            )}

            {lockPaymentMethod ? (
              <div className="rounded-lg border border-border/60 bg-muted/10 px-3 py-2.5 text-body text-foreground">
                {payMethodLabel}
              </div>
            ) : (
              <div className="space-y-2">
                <div className={SETTINGS_HINT}>
                  {t('membership.paymentDialog.selectMethod')}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {(['alipay', 'wechat'] as PaymentMethod[]).map(m => (
                    <button
                      key={m}
                      type="button"
                      onClick={() => setPaymentMethod(m)}
                      className={cn(
                        'rounded-lg border px-3 py-2.5 text-body transition-colors',
                        paymentMethod === m
                          ? 'border-accent/40 bg-accent/10 text-accent font-medium'
                          : 'border-border/60 text-muted-foreground hover:border-accent/30',
                      )}
                    >
                      {t(`membership.paymentMethods.${m}`)}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {createError && (
              <div className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{createError}</div>
            )}

            <Button
              type="button"
              size="sm"
              disabled={creating}
              onClick={() => void handleConfirmPay()}
              className="w-full"
            >
              {creating
                ? t('membership.paymentDialog.creatingOrder')
                : t('membership.paymentDialog.confirmPay')}
            </Button>
          </div>
        )}

        {paymentData && (
        <div className="px-5 pb-5 space-y-4">
          {isSuccess && (
            <div className="flex flex-col items-center gap-3 py-6">
              <CheckCircle2 className="h-12 w-12 text-success" />
              <div className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground')}>
                {t('membership.paymentDialog.success')}
              </div>
              {/* FE-35: 充值成功后展示最新余额（由父组件经 React Query 刷新后传入） */}
              {newBalancePrecise != null && (
                <div className={SETTINGS_HINT}>
                  {t('membership.paymentDialog.newBalance', { balance: newBalancePrecise })}
                </div>
              )}
              <Button size="sm" onClick={handleClose} className="mt-2">
                {t('membership.paymentDialog.close')}
              </Button>
            </div>
          )}

          {(status === 'failed' || status === 'cancelled' || status === 'expired') && (
            <div className="flex flex-col items-center gap-3 py-6">
              <XCircle className="h-12 w-12 text-destructive" />
              <div className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>
                {error || t(`membership.orderTracking.statusNotice.${status}`)}
              </div>
              <Button size="sm" variant="outline" onClick={handleClose} className="mt-2">
                {t('membership.paymentDialog.close')}
              </Button>
              <div className={cn(SETTINGS_HINT, 'text-center')}>
                {t('membership.paymentDialog.supportHint')}
              </div>
            </div>
          )}

          {!isTerminal && (
            <>
              <div className="flex flex-col items-center gap-3">
                {paymentData.qr_code && qrImageSrc && (
                  <QrCodeImage
                    src={qrImageSrc}
                    scanLabel={t('membership.paymentDialog.scanQr')}
                    payUrl={paymentData.pay_url}
                    onOpenBrowser={handleOpenBrowser}
                    openBrowserLabel={t('membership.paymentDialog.openBrowser')}
                  />
                )}
                {paymentData.qr_code?.startsWith('weixin://') && !qrImageSrc && (
                  <div className="flex flex-col items-center gap-3 py-4">
                    <QrCode className="h-12 w-12 text-muted-foreground/60" />
                    <div className={cn(SETTINGS_TEXT_META, 'text-center max-w-[240px]')}>
                      {t('membership.paymentDialog.wechatOpenAppHint')}
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={handleOpenWeixin}
                      className="gap-1.5"
                    >
                      <ExternalLink className="h-3.5 w-3.5" />
                      {t('membership.paymentDialog.wechatOpenApp')}
                    </Button>
                  </div>
                )}
                {!paymentData.qr_code && paymentData.pay_url && (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={handleOpenBrowser}
                    className="gap-1.5"
                  >
                    <ExternalLink className="h-3.5 w-3.5" />
                    {t('membership.paymentDialog.openBrowser')}
                  </Button>
                )}
              </div>

              <div className="space-y-2">
                {!error && (
                  <div className={cn(SETTINGS_TEXT_META, 'flex items-center justify-center gap-2')}>
                    <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    <span>{t('membership.paymentDialog.waitingPayment')}</span>
                  </div>
                )}

                {countdown && !error && (
                  <div className={cn(SETTINGS_TEXT_META, 'flex items-center justify-center gap-1.5')}>
                    <Clock className="h-3 w-3" />
                    <span>{countdown}</span>
                  </div>
                )}

                <div className={cn(SETTINGS_TEXT_META, 'rounded-lg border border-border/40 bg-muted/20 p-3 space-y-1')}>
                  <div>
                    {t('membership.orderTracking.orderNo')}:{' '}
                    <span className="font-mono text-foreground">{paymentData.order_no}</span>
                  </div>
                  <div>
                    {t('membership.orderTracking.statusLabel')}:{' '}
                    <span className={cn(
                      'font-medium',
                      status === 'paying' ? 'text-primary' : 'text-foreground'
                    )}>
                      {t(`membership.orderTracking.status.${status}`)}
                    </span>
                  </div>
                  <div className={SETTINGS_HINT}>
                    {t('membership.orderTracking.pollingHint', { tick: pollTick })}
                  </div>
                </div>

                {error && (
                  <div className="flex flex-col items-center gap-2">
                    <div className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive', 'text-center')}>{error}</div>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="default"
                        onClick={handleRetryQuery}
                        className="text-body"
                      >
                        {t('membership.paymentDialog.retryQuery')}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={handleClose}
                        className="text-body"
                      >
                        {t('membership.paymentDialog.retryPayment')}
                      </Button>
                    </div>
                    <div className={cn(SETTINGS_HINT, 'text-center')}>
                      {t('membership.paymentDialog.supportHint')}
                    </div>
                  </div>
                )}
              </div>
            </>
          )}
        </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
