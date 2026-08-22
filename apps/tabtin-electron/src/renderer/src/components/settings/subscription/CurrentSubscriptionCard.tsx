import React from 'react'
import { CalendarClock } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import type { OrganizationMembershipStatus, SubscriptionDisplay } from '@/types/membership'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsBadge } from '../SettingsBadge'
import { SubscriptionStatusBadge } from './SubscriptionStatusBadge'
import { formatDateLabel, resolveTierDisplayName } from './subscriptionFormat'

export const CurrentSubscriptionCard: React.FC<{
  membership?: OrganizationMembershipStatus
  display?: SubscriptionDisplay
  canManageOrganization: boolean
  autoRenewLoading?: boolean
  autoRenewChecked?: boolean
  onToggleAutoRenew?: (checked: boolean) => void
  onOpenPlans: () => void
  scheduledChange?: { type?: string; target_tier?: { tier_type?: string; name?: string; price?: string | number }; effective_at?: string } | null
  inline?: boolean
  hideScheduledChangeNotice?: boolean
}> = ({
  membership,
  display,
  canManageOrganization,
  autoRenewLoading = false,
  autoRenewChecked = false,
  onToggleAutoRenew,
  onOpenPlans,
  scheduledChange,
  inline = false,
  hideScheduledChangeNotice = false,
}) => {
  const { t } = useTranslation('settings')
  const isFree = membership?.lifecycle_state === 'free' || !membership?.membership_id
  const isExpired = membership?.lifecycle_state === 'expired'
  const currentPlanFallback = t('membership.currentSubscription.currentPlan')
  const translateTierType = (tierType: string) =>
    t(`membership.tierNames.${tierType}`, { defaultValue: '' })
  const tierName = resolveTierDisplayName(
    membership?.tier?.name || display?.title,
    membership?.tier?.tier_type,
    translateTierType,
    currentPlanFallback,
  )
  const scheduledTarget = scheduledChange?.target_tier
  const scheduledTierName = scheduledTarget && (scheduledTarget.name?.trim() || scheduledTarget.tier_type)
    ? resolveTierDisplayName(
      scheduledTarget.name,
      scheduledTarget.tier_type,
      translateTierType,
      currentPlanFallback,
    )
    : undefined

  const freeBody = (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[1.375rem] font-semibold leading-tight tracking-tight text-foreground">
            {tierName}
          </span>
          <SettingsBadge tone="muted" className="rounded-full">
            {t('membership.currentSubscription.freeBadge')}
          </SettingsBadge>
        </div>
        <div className="mt-2 flex items-center gap-2 text-body text-muted-foreground">
          <CalendarClock className="h-4 w-4 shrink-0" />
          <span>{t('membership.currentSubscription.longTerm')}</span>
        </div>
        <div className="mt-1 text-body text-muted-foreground">
          {t('membership.currentSubscription.freeDescription')}
        </div>
      </div>
      <Button type="button" size={inline ? 'default' : 'sm'} onClick={onOpenPlans} disabled={!canManageOrganization}>
        {t('membership.currentSubscription.viewPlans')}
      </Button>
    </div>
  )

  if (isFree) {
    if (inline) return freeBody
    return (
      <SettingsSectionCard title={t('membership.currentSubscription.title')}>
        {freeBody}
      </SettingsSectionCard>
    )
  }

  const paidBody = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-center gap-2">
          <span className="text-[1.375rem] font-semibold leading-tight tracking-tight text-foreground">
            {tierName}
          </span>
          <SettingsBadge tone="accent" className="rounded-full">
            {t('membership.currentSubscription.currentPlan')}
          </SettingsBadge>
          <SubscriptionStatusBadge state={membership?.lifecycle_state} />
        </div>
        <Button type="button" variant={inline ? 'default' : 'outline'} size={inline ? 'default' : 'sm'} onClick={onOpenPlans} disabled={!canManageOrganization}>
          {t('membership.currentSubscription.manage')}
        </Button>
      </div>
      <div className={`grid gap-3 rounded-xl bg-muted/20 px-4 py-3 text-body text-muted-foreground ${isExpired ? 'sm:grid-cols-2' : 'sm:grid-cols-3'}`}>
        <div><span className="mr-1 text-muted-foreground/70">{t('membership.currentSubscription.periodStart')}</span>{formatDateLabel(membership?.start_date)}</div>
        <div><span className="mr-1 text-muted-foreground/70">{t(isExpired ? 'membership.currentSubscription.expiredAt' : 'membership.currentSubscription.periodEnd')}</span>{formatDateLabel(membership?.end_date)}</div>
        {!isExpired ? (
          <div>
            {typeof membership?.days_until_expiry === 'number' && membership.days_until_expiry <= 0
              ? t('membership.currentSubscription.remainingToday')
              : t('membership.currentSubscription.remainingDays', { days: membership?.days_until_expiry ?? 0 })}
          </div>
        ) : null}
      </div>
      {scheduledTierName && !hideScheduledChangeNotice ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-sm text-amber-900">
          <div className="font-medium">{t('membership.currentSubscription.scheduledChange', { tier: scheduledTierName })}</div>
          <div className="mt-1 text-amber-800/80">
            {scheduledChange?.effective_at
              ? t('membership.currentSubscription.scheduledEffectiveAt', { date: formatDateLabel(scheduledChange.effective_at) })
              : t('membership.currentSubscription.scheduledAtPeriodEnd')}
            {Number(scheduledChange?.target_tier?.price || 0) > 0
              ? t('membership.currentSubscription.scheduledPaymentRequired')
              : t('membership.currentSubscription.scheduledFreeFallback')}
          </div>
        </div>
      ) : null}
    </div>
  )

  if (inline) return paidBody

  return (
    <SettingsSectionCard title={t('membership.currentSubscription.title')}>
      {paidBody}
    </SettingsSectionCard>
  )
}

CurrentSubscriptionCard.displayName = 'CurrentSubscriptionCard'
