import React from 'react'
import { useTranslation } from 'react-i18next'
import { SettingsBadge } from '../SettingsBadge'

const TONES: Record<string, React.ComponentProps<typeof SettingsBadge>['tone']> = {
  free: 'muted',
  active: 'success',
  grace_period: 'warning',
  expired: 'destructive',
  suspended: 'destructive',
  unknown: 'muted',
}

export const SubscriptionStatusBadge: React.FC<{ state?: string | null }> = ({ state }) => {
  const key = state || 'unknown'
  const { t } = useTranslation('settings')
  return (
    <SettingsBadge tone={TONES[key] || 'muted'} className="rounded-full font-medium">
      {t(`membership.lifecycleState.${key}`, { defaultValue: key })}
    </SettingsBadge>
  )
}

SubscriptionStatusBadge.displayName = 'SubscriptionStatusBadge'
