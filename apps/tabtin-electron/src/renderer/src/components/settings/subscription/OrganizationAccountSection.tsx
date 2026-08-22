import React from 'react'
import { CreditCard } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import type { OrganizationMembershipStatus, OrganizationWalletInfo, SubscriptionDisplay } from '@/types/membership'
import { useCashWalletQuery } from '@/hooks/queries/membership'
import { formatYuanAmount } from '@/utils/formatBilling'
import { cn } from '@utils/cn'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsLink } from '../SettingsLink'
import { SETTINGS_CONTROL_SM, SETTINGS_HINT } from '../settingsUi'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { CreditsSummaryCard } from './CreditsSummaryCard'
import { CurrentSubscriptionCard } from './CurrentSubscriptionCard'
import { SubscriptionEmptyState } from './SubscriptionEmptyState'

const CASH_WALLET_SCROLL_TARGET = 'settings-llm-auto-topup'

export const OrganizationAccountSection: React.FC<{
  organizationId: string
  isOwner: boolean
  canManageOrganization: boolean
  membership?: OrganizationMembershipStatus
  display?: SubscriptionDisplay
  includedCredits: string | number
  consumedCredits: string | number
  remainingCredits: string | number
  wallet?: OrganizationWalletInfo
  autoRenewLoading?: boolean
  autoRenewChecked?: boolean
  onToggleAutoRenew?: (checked: boolean) => void
  onOpenPlans: () => void
  onOpenCashRecharge?: () => void
  scheduledChange?: { type?: string; target_tier?: { tier_type?: string; name?: string; price?: string | number }; effective_at?: string } | null
  hideScheduledChangeNotice?: boolean
  isFreeTier: boolean
}> = ({
  organizationId,
  isOwner,
  canManageOrganization,
  membership,
  display,
  includedCredits,
  consumedCredits,
  remainingCredits,
  wallet,
  autoRenewLoading,
  autoRenewChecked,
  onToggleAutoRenew,
  onOpenPlans,
  onOpenCashRecharge,
  scheduledChange,
  hideScheduledChangeNotice = false,
  isFreeTier,
}) => {
  const { t } = useTranslation('settings')
  const setRoute = useSettingsSpaceStore((s) => s.setRoute)
  const { data: cashWallet, isLoading: cashLoading, isError: cashError } = useCashWalletQuery(organizationId)
  const availableCny = cashWallet?.available_cny ?? cashWallet?.balance_cny

  const openAutoTopup = () => {
    try {
      sessionStorage.setItem('settings-scroll-to', CASH_WALLET_SCROLL_TARGET)
    } catch {
      /* ignore */
    }
    setRoute({ category: 'organization', section: 'services' })
  }

  return (
    <SettingsSectionCard
      title={t('membership.accountOverview.title', { defaultValue: '账户与用量' })}
    >
      <div className="space-y-5">
        <div className="border-b border-border/25 pb-5">
          {isFreeTier ? (
            <SubscriptionEmptyState
              inline
              canManageOrganization={canManageOrganization}
              onOpenPlans={onOpenPlans}
              tierName={membership?.tier?.name || display?.title}
              tierType={membership?.tier?.tier_type}
            />
          ) : (
            <CurrentSubscriptionCard
              inline
              membership={membership}
              display={display}
              canManageOrganization={canManageOrganization}
              autoRenewLoading={autoRenewLoading}
              autoRenewChecked={autoRenewChecked}
              onToggleAutoRenew={onToggleAutoRenew}
              onOpenPlans={onOpenPlans}
              scheduledChange={scheduledChange}
              hideScheduledChangeNotice={hideScheduledChangeNotice}
            />
          )}
        </div>

        <CreditsSummaryCard
          inline
          includedCredits={includedCredits}
          consumedCredits={consumedCredits}
          remainingCredits={remainingCredits}
          wallet={wallet}
        />

        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border/25 pt-4">
          <div className="min-w-0">
            <div className="text-body font-medium text-foreground">
              {t('billing.cashWallet.title')}
            </div>
            <div className="mt-0.5 flex items-baseline gap-1">
              <span className="text-title font-semibold tabular-nums tracking-tight text-foreground">
                {cashLoading ? '…' : cashError || availableCny == null ? '—' : `¥${formatYuanAmount(availableCny)}`}
              </span>
            </div>
            {isOwner ? (
              <p className={cn(SETTINGS_HINT, 'mt-1')}>
                {t('billing.cashWallet.autoTopupGuidePrefix')}
                <SettingsLink onClick={openAutoTopup} className="mx-0.5 align-baseline">
                  {t('billing.cashWallet.autoTopupGuideLink')}
                </SettingsLink>
                {t('billing.cashWallet.autoTopupGuideSuffix')}
              </p>
            ) : null}
          </div>
          {isOwner && onOpenCashRecharge ? (
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={onOpenCashRecharge}
              className={cn('shrink-0 gap-1.5', SETTINGS_CONTROL_SM)}
            >
              <CreditCard className="h-[1em] w-[1em]" />
              {t('billing.cashWallet.rechargeButton')}
            </Button>
          ) : null}
        </div>
      </div>
    </SettingsSectionCard>
  )
}

OrganizationAccountSection.displayName = 'OrganizationAccountSection'
