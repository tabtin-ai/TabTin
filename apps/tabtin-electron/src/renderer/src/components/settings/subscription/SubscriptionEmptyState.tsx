import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import { cn } from '@utils/cn'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SETTINGS_HINT } from '../settingsUi'
import { resolveTierDisplayName } from './subscriptionFormat'

export const SubscriptionEmptyState: React.FC<{
  onOpenPlans: () => void
  canManageOrganization?: boolean
  inline?: boolean
  tierName?: string
  tierType?: string
}> = ({ onOpenPlans, canManageOrganization = true, inline = false, tierName, tierType }) => {
  const { t } = useTranslation('settings')
  const displayName = resolveTierDisplayName(
    tierName,
    tierType,
    (type) => t(`membership.tierNames.${type}`, { defaultValue: '' }),
    t('membership.tierNames.free'),
  )

  const body = (
    <div className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0">
        <div className="text-[1.375rem] font-semibold leading-tight tracking-tight text-foreground">
          {displayName}
        </div>
        <p className={cn(SETTINGS_HINT, 'mt-1.5')}>
          {t('membership.currentSubscription.longTerm')}
          {' · '}
          {t('membership.currentSubscription.freeDescription')}
        </p>
      </div>
      <Button
        type="button"
        size={inline ? 'default' : 'sm'}
        onClick={onOpenPlans}
        disabled={!canManageOrganization}
        className="shrink-0"
      >
        {t('membership.currentSubscription.upgrade', { defaultValue: '立即升级' })}
      </Button>
    </div>
  )

  if (inline) return body

  return (
    <SettingsSectionCard title={t('membership.currentSubscription.title')}>
      {body}
    </SettingsSectionCard>
  )
}

SubscriptionEmptyState.displayName = 'SubscriptionEmptyState'
