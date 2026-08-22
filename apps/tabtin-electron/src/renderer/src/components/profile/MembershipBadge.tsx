import React from 'react'
import { Crown } from 'lucide-react'
import { Button } from '@tabtin/smartsheet-ui'
import { useTranslation } from 'react-i18next'
import { useMembershipStatusQuery } from '@/hooks/queries/membership'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { cn } from '@utils/cn'

export const MembershipBadge: React.FC = () => {
  const { t } = useTranslation('settings')
  const activeOrganizationId = useOrganizationStore(state => state.selectedOrganization?.id ?? null)
  const openSettings = useSettingsSpaceStore(state => state.openSettings)

  const { data: membershipStatus } = useMembershipStatusQuery(activeOrganizationId ?? undefined)

  const isMember = membershipStatus?.is_member && !membershipStatus?.is_expired
  const isExpired = membershipStatus?.is_expired
  const tierName = membershipStatus?.tier?.name

  const label = isMember
    ? (tierName || t('membership.badge.defaultTier'))
    : isExpired
      ? t('membership.badge.expired')
      : t('membership.badge.free')

  return (
    <Button
      variant="ghost"
      size="icon"
      onClick={() => openSettings({ category: 'organization', section: 'membership' })}
      className={cn(
        'h-7 w-7 rounded-md transition-colors',
        isMember
          ? 'text-primary/80 hover:text-primary hover:bg-primary/10'
          : isExpired
            ? 'text-destructive/80 hover:text-destructive hover:bg-destructive/10'
            : 'text-muted-foreground/60 hover:text-foreground hover:bg-muted/30',
      )}
      title={label}
    >
      <Crown className="h-3.5 w-3.5" />
    </Button>
  )
}
