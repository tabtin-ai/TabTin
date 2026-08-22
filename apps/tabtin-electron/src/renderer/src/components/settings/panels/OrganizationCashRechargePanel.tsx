import React, { useCallback, useMemo, useState } from 'react'
import { ArrowLeft, Wallet } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useQueryClient } from '@tanstack/react-query'
import { Button, Input, StatusNotice } from '@components/ui'
import type { Organization } from '@tabtin/app-shell'
import { cn } from '@utils/cn'
import { useCashWalletQuery, membershipKeys } from '@/hooks/queries/membership'
import { MembershipApiService } from '@/services/membershipApi'
import { formatYuanAmount } from '@/utils/formatBilling'
import { getDefaultPaymentExtraParams } from '@/utils/paymentParams'
import type { PaymentMethod } from '@/types/membership'
import { createLogger } from '@/utils/logger'
import { SETTINGS_CONTROL, SETTINGS_FIELD_TITLE, SETTINGS_HINT, SETTINGS_SOFT_SURFACE, SETTINGS_TEXT_META } from '../settingsUi'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { PaymentDialog, type PaymentCheckoutIntent } from './PaymentDialog'

const log = createLogger('CashRecharge')

const PRESET_AMOUNTS = [50, 100, 500, 1000, 5000] as const
const MIN_AMOUNT = 0.01
const MAX_AMOUNT = 100_000

interface OrganizationCashRechargePanelProps {
  organization: Organization
  onBack: () => void
}

function parseAmountInput(raw: string): number | null {
  const normalized = raw.trim().replace(/,/g, '')
  if (!normalized) return null
  if (!/^\d+(\.\d{0,2})?$/.test(normalized)) return null
  const value = Number(normalized)
  if (!Number.isFinite(value)) return null
  return value
}

export const OrganizationCashRechargePanel: React.FC<OrganizationCashRechargePanelProps> = ({
  organization,
  onBack,
}) => {
  const { t } = useTranslation('settings')
  const queryClient = useQueryClient()
  const { data: cashWallet, isLoading, isError } = useCashWalletQuery(organization.id)
  const available = cashWallet?.available_cny ?? cashWallet?.balance_cny

  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>('alipay')
  const [selectedPreset, setSelectedPreset] = useState<number | null>(100)
  const [customAmount, setCustomAmount] = useState('')
  const [acknowledged, setAcknowledged] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)
  const [paymentDialogOpen, setPaymentDialogOpen] = useState(false)
  const [checkoutIntent, setCheckoutIntent] = useState<PaymentCheckoutIntent | null>(null)
  const [pendingAmount, setPendingAmount] = useState<string | null>(null)

  const amountValue = useMemo(() => {
    if (selectedPreset != null) return selectedPreset
    return parseAmountInput(customAmount)
  }, [selectedPreset, customAmount])

  const amountLabel = amountValue != null
    ? `¥${formatYuanAmount(amountValue)}`
    : undefined

  const validate = (): string | null => {
    if (amountValue == null) {
      return t('billing.cashWallet.recharge.amountRequired')
    }
    if (amountValue < MIN_AMOUNT || amountValue > MAX_AMOUNT) {
      return t('billing.cashWallet.recharge.amountRange', {
        min: MIN_AMOUNT,
        max: MAX_AMOUNT.toLocaleString('zh-CN'),
      })
    }
    if (!acknowledged) {
      return t('billing.cashWallet.recharge.ackRequired')
    }
    return null
  }

  const handleConfirm = () => {
    const error = validate()
    if (error) {
      setFormError(error)
      return
    }
    if (amountValue == null) return

    const amountStr = amountValue.toFixed(2)
    setFormError(null)
    setPendingAmount(amountStr)
    setCheckoutIntent({
      orderType: 'cash_wallet',
      amountLabel: `¥${formatYuanAmount(amountStr)}`,
    })
    setPaymentDialogOpen(true)
    log.info(`cash recharge checkout open org=${organization.id} amount=${amountStr} method=${paymentMethod}`)
  }

  const createOrder = useCallback(
    async (method: PaymentMethod) => {
      if (!pendingAmount) {
        throw new Error(t('billing.cashWallet.recharge.amountRequired'))
      }
      // 页面已选定支付方式；Dialog 锁定后仍会传入 method，优先用页面选择
      const resolvedMethod = paymentMethod || method
      return MembershipApiService.rechargeOrganizationCashWallet({
        organizationId: organization.id,
        amountCny: pendingAmount,
        paymentMethod: resolvedMethod,
        extraParams: getDefaultPaymentExtraParams(resolvedMethod),
      })
    },
    [organization.id, pendingAmount, paymentMethod, t],
  )

  const handlePaymentSuccess = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: membershipKeys.cashWallet(organization.id) })
    void queryClient.invalidateQueries({ queryKey: membershipKeys.all })
    log.info(`cash recharge success org=${organization.id}`)
  }, [organization.id, queryClient])

  return (
    <div className="space-y-6">
      <div className="flex items-start gap-3">
        <button
          type="button"
          onClick={onBack}
          className="mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-interactive text-muted-foreground transition-colors hover:bg-foreground/[0.03] hover:text-foreground dark:hover:bg-foreground/[0.05]"
          aria-label={t('billing.cashWallet.recharge.back')}
        >
          <ArrowLeft className="h-4 w-4" />
        </button>
        <div className="min-w-0">
          <h2 className="text-subtitle font-semibold text-foreground">
            {t('billing.cashWallet.recharge.title')}
          </h2>
          <p className={cn(SETTINGS_HINT, 'mt-1')}>
            {t('billing.cashWallet.recharge.subtitle')}
          </p>
        </div>
      </div>

      <StatusNotice
        tone="info"
        description={t('billing.cashWallet.recharge.notice')}
      />

      <SettingsSectionCard title={t('billing.cashWallet.recharge.accountTitle')}>
        <div className={cn(SETTINGS_SOFT_SURFACE, 'flex flex-wrap items-center gap-4 px-4 py-3')}>
          <div className="flex min-w-0 items-center gap-2">
            <Wallet className="h-4 w-4 shrink-0 text-muted-foreground/60" />
            <span className="truncate text-body font-medium text-foreground">
              {organization.name}
            </span>
          </div>
          <div className="h-4 w-px bg-border/40" />
          <div className="text-body tabular-nums text-foreground">
            <span className="text-muted-foreground/60">
              {t('billing.cashWallet.recharge.cashBalance')}
            </span>
            {' '}
            <span className="font-medium">
              {isLoading
                ? '…'
                : isError || available == null
                  ? '—'
                  : `¥${formatYuanAmount(available)}`}
            </span>
          </div>
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard title={t('billing.cashWallet.recharge.methodTitle')}>
        <div className="grid gap-2 sm:grid-cols-2">
          {([
            { id: 'alipay' as const, realtime: true },
            { id: 'wechat' as const, realtime: true },
          ]).map((method) => {
            const selected = paymentMethod === method.id
            return (
              <button
                key={method.id}
                type="button"
                onClick={() => setPaymentMethod(method.id)}
                className={cn(
                  'rounded-interactive border px-4 py-3 text-left transition-colors',
                  selected
                    ? 'border-accent/40 bg-accent/10'
                    : 'border-border/60 bg-background hover:border-accent/30',
                )}
              >
                <div className="flex items-center gap-2">
                  <span
                    className={cn(
                      'flex h-4 w-4 items-center justify-center rounded-full border',
                      selected ? 'border-accent' : 'border-muted-foreground/40',
                    )}
                    aria-hidden
                  >
                    {selected ? (
                      <span className="h-2 w-2 rounded-full bg-accent" />
                    ) : null}
                  </span>
                  <span className={cn('text-body font-medium', selected ? 'text-accent' : 'text-foreground')}>
                    {t(`membership.paymentMethods.${method.id}`)}
                  </span>
                </div>
                <p className={cn(SETTINGS_HINT, 'mt-1.5 pl-6')}>
                  {t('billing.cashWallet.recharge.methodRealtime')}
                </p>
              </button>
            )
          })}
        </div>
      </SettingsSectionCard>

      <SettingsSectionCard title={t('billing.cashWallet.recharge.amountTitle')}>
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            {PRESET_AMOUNTS.map((amount) => {
              const selected = selectedPreset === amount
              return (
                <button
                  key={amount}
                  type="button"
                  onClick={() => {
                    setSelectedPreset(amount)
                    setCustomAmount('')
                    setFormError(null)
                  }}
                  className={cn(
                    'min-w-[4.5rem] rounded-interactive border px-3 py-2 text-body tabular-nums transition-colors',
                    selected
                      ? 'border-accent/40 bg-accent/10 font-medium text-accent'
                      : 'border-border/60 text-foreground hover:border-accent/30',
                  )}
                >
                  ¥{amount}
                </button>
              )
            })}
          </div>

          <div>
            <div className={SETTINGS_FIELD_TITLE}>
              {t('billing.cashWallet.recharge.customAmount')}
            </div>
            <div className="mt-1.5 flex items-center gap-2">
              <span className="text-body text-muted-foreground">¥</span>
              <Input
                type="text"
                inputMode="decimal"
                value={customAmount}
                placeholder={t('billing.cashWallet.recharge.customPlaceholder')}
                onChange={(event) => {
                  setCustomAmount(event.target.value)
                  setSelectedPreset(null)
                  setFormError(null)
                }}
                className={cn(SETTINGS_CONTROL, 'max-w-[12rem]')}
              />
            </div>
            <p className={cn(SETTINGS_HINT, 'mt-1.5')}>
              {t('billing.cashWallet.recharge.amountHint', {
                min: MIN_AMOUNT,
                max: MAX_AMOUNT.toLocaleString('zh-CN'),
              })}
            </p>
          </div>
        </div>
      </SettingsSectionCard>

      <label className={cn(SETTINGS_TEXT_META, 'flex items-start gap-2')}>
        <input
          type="checkbox"
          checked={acknowledged}
          onChange={(event) => {
            setAcknowledged(event.target.checked)
            setFormError(null)
          }}
          className="mt-0.5"
        />
        <span>{t('billing.cashWallet.recharge.ackText')}</span>
      </label>

      {formError ? (
        <StatusNotice tone="danger" description={formError} />
      ) : null}

      <div className="flex flex-wrap items-center gap-3">
        <Button type="button" onClick={handleConfirm} className="min-w-[7rem]">
          {t('billing.cashWallet.recharge.confirm')}
        </Button>
        {amountLabel ? (
          <span className="text-body tabular-nums text-muted-foreground">
            {t('billing.cashWallet.recharge.payable', { amount: amountLabel })}
          </span>
        ) : null}
      </div>

      <PaymentDialog
        open={paymentDialogOpen}
        onOpenChange={(open) => {
          setPaymentDialogOpen(open)
          if (!open) {
            setCheckoutIntent(null)
            setPendingAmount(null)
          }
        }}
        intent={checkoutIntent}
        createOrder={createOrder}
        onPaymentSuccess={handlePaymentSuccess}
        initialPaymentMethod={paymentMethod}
        lockPaymentMethod
        newBalancePrecise={available ?? undefined}
      />
    </div>
  )
}
