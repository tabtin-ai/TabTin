import React from 'react'
import { useTranslation } from 'react-i18next'
import type { OrganizationWalletInfo } from '@/types/membership'
import { cn } from '@utils/cn'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { MeterBar } from '../MeterBar'
import { SETTINGS_HINT, SETTINGS_SECTION_TITLE } from '../settingsUi'
import { formatCreditsDisplay, toFiniteNumber } from './subscriptionFormat'

function PlanCreditsMetric({
  includedCredits,
  consumedCredits,
  remainingCredits,
  usagePercent,
  creditsUnit,
  planCreditsLabel,
  planUsageText,
  remainingSummaryText,
}: {
  includedCredits: string | number
  consumedCredits: string | number
  remainingCredits: string | number
  usagePercent: number
  creditsUnit: string
  planCreditsLabel: string
  planUsageText: string
  remainingSummaryText: string
}) {
  return (
    <div className="flex h-full min-w-0 flex-col rounded-interactive border border-border/20 bg-background/40 px-3.5 py-3.5">
      <div className={SETTINGS_SECTION_TITLE}>{planCreditsLabel}</div>
      <div className="mt-2 text-title font-semibold tabular-nums tracking-tight text-foreground">
        {formatCreditsDisplay(includedCredits, creditsUnit)}
      </div>
      <div className={cn(SETTINGS_HINT, 'mt-1')}>
        {planUsageText}
        {' · '}
        {remainingSummaryText}
      </div>
      <div className="mt-auto pt-3">
        <MeterBar value={usagePercent} max={100} variant="threshold" />
      </div>
    </div>
  )
}

function WalletCreditsMetric({
  walletCredits,
  reservedText,
  walletCreditsLabel,
  emphasized = false,
}: {
  walletCredits: string
  reservedText: string
  walletCreditsLabel: string
  emphasized?: boolean
}) {
  return (
    <div
      className={cn(
        'flex h-full min-w-0 flex-col rounded-interactive border px-3.5 py-3.5',
        emphasized
          ? 'border-border/30 bg-muted/20'
          : 'border-border/20 bg-background/40',
      )}
    >
      <div className={SETTINGS_SECTION_TITLE}>{walletCreditsLabel}</div>
      <div
        className={cn(
          'mt-2 font-semibold tabular-nums leading-none tracking-tight text-foreground',
          emphasized ? 'text-[1.625rem]' : 'text-title',
        )}
      >
        {walletCredits}
      </div>
      <p className={cn(SETTINGS_HINT, 'mt-1.5')}>{reservedText}</p>
    </div>
  )
}

export const CreditsSummaryCard: React.FC<{
  includedCredits: string | number
  consumedCredits: string | number
  remainingCredits: string | number
  wallet?: OrganizationWalletInfo
  /** 嵌入「账户与用量」大卡片时使用，不再套外层 SettingsSectionCard */
  inline?: boolean
  /** inline 时默认双列：左套餐用量、右可用点券 */
  inlineLayout?: 'split' | 'stack'
}> = ({
  includedCredits,
  consumedCredits,
  remainingCredits,
  wallet,
  inline = false,
  inlineLayout = 'split',
}) => {
  const { t } = useTranslation('settings')
  const included = toFiniteNumber(includedCredits) ?? 0
  const consumed = toFiniteNumber(consumedCredits) ?? 0
  const usagePercent = included > 0 ? Math.min(100, Math.max(0, Math.round((consumed / included) * 100))) : 0
  const creditsUnit = t('membership.units.credits')
  const walletCredits = formatCreditsDisplay(wallet?.available_credits_precise ?? 0, creditsUnit)
  const reservedCredits = formatCreditsDisplay(wallet?.credits_frozen_precise ?? 0, creditsUnit)

  const planCreditsLabel = t('membership.creditsSummary.planCredits')
  const walletCreditsLabel = t('membership.creditsSummary.walletCredits')
  const planUsageText = t('membership.creditsSummary.planUsage', {
    consumed: formatCreditsDisplay(consumedCredits, creditsUnit),
    included: formatCreditsDisplay(includedCredits, creditsUnit),
  })
  const remainingSummaryText = t('membership.overview.creditsSummary', {
    credits: formatCreditsDisplay(remainingCredits, creditsUnit),
  })
  const reservedText = t('membership.creditsSummary.walletReserved', { reserved: reservedCredits })

  const splitMetrics = (
    <div className="grid gap-3 sm:grid-cols-2">
      <PlanCreditsMetric
        includedCredits={includedCredits}
        consumedCredits={consumedCredits}
        remainingCredits={remainingCredits}
        usagePercent={usagePercent}
        creditsUnit={creditsUnit}
        planCreditsLabel={planCreditsLabel}
        planUsageText={planUsageText}
        remainingSummaryText={remainingSummaryText}
      />
      <WalletCreditsMetric
        walletCredits={walletCredits}
        reservedText={reservedText}
        walletCreditsLabel={walletCreditsLabel}
        emphasized
      />
    </div>
  )

  const stackMetrics = (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="min-w-0">
          <div className={SETTINGS_SECTION_TITLE}>{walletCreditsLabel}</div>
          <div className="mt-1 text-[1.75rem] font-semibold tabular-nums leading-none tracking-tight text-foreground">
            {walletCredits}
          </div>
          <p className={cn(SETTINGS_HINT, 'mt-1.5')}>{reservedText}</p>
        </div>
      </div>
      <div className="rounded-interactive border border-border/20 bg-background/40 px-3.5 py-3">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span className="text-body font-medium text-foreground-secondary">{planCreditsLabel}</span>
          <span className="text-body tabular-nums text-foreground">{formatCreditsDisplay(includedCredits, creditsUnit)}</span>
        </div>
        <div className={cn(SETTINGS_HINT, 'mt-1')}>
          {planUsageText}
          {' · '}
          {remainingSummaryText}
        </div>
        <MeterBar value={usagePercent} max={100} variant="threshold" className="mt-3" />
      </div>
    </div>
  )

  const body = inline && inlineLayout === 'split' ? splitMetrics : stackMetrics

  if (inline) return body

  return (
    <SettingsSectionCard
      title={t('membership.creditsSummary.title', { defaultValue: 'credits 使用' })}
      subtitle={t('membership.creditsSummary.description')}
      subtitleAsTooltip
    >
      {body}
    </SettingsSectionCard>
  )
}

CreditsSummaryCard.displayName = 'CreditsSummaryCard'
