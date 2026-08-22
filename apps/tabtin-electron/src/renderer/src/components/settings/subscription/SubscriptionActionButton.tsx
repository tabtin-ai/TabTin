import React from 'react'
import { useTranslation } from 'react-i18next'
import { Button } from '@tabtin/smartsheet-ui'
import type { MembershipChangeAction } from '@/types/membership'

export const SubscriptionActionButton: React.FC<{
  action: MembershipChangeAction
  label?: string
  current?: boolean
  disabled?: boolean
  loading?: boolean
  onClick?: () => void
}> = ({ action, label, current, disabled, loading, onClick }) => {
  const { t } = useTranslation('settings')

  return (
    <Button
      type="button"
      size="sm"
      variant={current ? 'outline' : action === 'downgrade' || action === 'switch' ? 'ghost' : 'default'}
      disabled={disabled || current || loading}
      onClick={onClick}
      className="w-full h-8 text-body"
    >
      {loading
        ? t('membership.planDialog.loading')
        : current
          ? t('membership.planDialog.current')
          : t(`membership.planDialog.actions.${action}`, { defaultValue: label || action })}
    </Button>
  )
}

SubscriptionActionButton.displayName = 'SubscriptionActionButton'
