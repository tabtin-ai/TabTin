/**
 * MembershipExpiredBanner — 会员过期后在顶部显示的可关闭全局提示条。
 *
 * 条件：selectedOrganization 存在 && membership is_expired === true
 * 放置：AppLayout.tsx 中 WsConnectionBanner 之后。
 * 「知道了」按 organization 维度在本次会话内关闭，切换团队后互不影响。
 */
import React, { useState } from 'react'
import { X, Crown } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { cn } from '@utils/cn'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useMembershipStatusQuery } from '@/hooks/queries/membership'

export const MembershipExpiredBanner: React.FC = () => {
  const { t } = useTranslation('settings')
  const [dismissedOrganizations, setDismissedOrganizations] = useState<Set<string>>(new Set())

  const selectedOrganization = useOrganizationStore(state => state.selectedOrganization)
  const openSettings = useSettingsSpaceStore(state => state.openSettings)

  const { data: membershipStatus } = useMembershipStatusQuery(selectedOrganization?.id)

  const isExpired = membershipStatus?.is_expired === true
  const inGrace = membershipStatus?.in_grace_period === true
  const graceDaysRemaining = membershipStatus?.grace_days_remaining
  const isDismissed = selectedOrganization ? dismissedOrganizations.has(selectedOrganization.id) : false

  if (!isExpired || isDismissed || !selectedOrganization) return null

  const bannerText =
    inGrace
      ? t('membership.expiredBanner.graceText', { count: graceDaysRemaining ?? 0 })
      : t('membership.expiredBanner.text')

  return (
    <div
      className={cn(
        'relative z-banner no-drag flex items-center justify-between gap-3 px-4 py-1.5 border-b shrink-0',
        inGrace
          ? 'bg-warning/10 border-warning/20'
          : 'bg-destructive/10 border-destructive/20',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Crown
          className={cn(
            'h-3.5 w-3.5 shrink-0',
            inGrace ? 'text-warning/80' : 'text-destructive/80',
          )}
        />
        <span
          className={cn(
            'text-caption truncate',
            inGrace ? 'text-warning/80' : 'text-destructive/80',
          )}
        >
          {bannerText}
        </span>
      </div>
      <div className="flex items-center gap-3 shrink-0">
        <button
          type="button"
          onClick={() => openSettings({ category: 'organization', section: 'membership' })}
          className={cn(
            'text-caption font-medium transition-colors',
            inGrace
              ? 'text-warning hover:text-warning/80'
              : 'text-destructive hover:text-destructive/80',
          )}
        >
          {t('membership.expiredBanner.renewCta')}
        </button>
        <button
          type="button"
          aria-label={t('membership.expiredBanner.dismiss')}
          onClick={() => {
            if (selectedOrganization) {
              setDismissedOrganizations(prev => new Set(prev).add(selectedOrganization.id))
            }
          }}
          className={cn(
            'transition-colors',
            inGrace
              ? 'text-warning/60 hover:text-warning/80'
              : 'text-destructive/60 hover:text-destructive/80',
          )}
        >
          <X className="h-3.5 w-3.5" />
        </button>
      </div>
    </div>
  )
}
