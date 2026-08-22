import React from 'react'
import { BarChart3, Info, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@components/ui'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsSkeleton } from '../SettingsSkeleton'
import { SETTINGS_HINT, SETTINGS_LABEL, SETTINGS_TEXT_META, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { useMyUsage } from '@/hooks/queries/memberBudget'
import { cn } from '@utils/cn'
import type { Organization } from '@tabtin/app-shell'

interface MyUsagePanelProps {
  organization: Organization
}

function formatCredits(value: string | null | undefined): string {
  if (value == null) return '0'
  const num = parseFloat(value)
  if (isNaN(num)) return '0'
  return num % 1 === 0 ? num.toFixed(0) : num.toFixed(2)
}

function calcPercent(used: string, limit: string | null): number | null {
  if (limit == null) return null
  const u = parseFloat(used)
  const l = parseFloat(limit)
  if (isNaN(u) || isNaN(l) || l <= 0) return null
  return Math.min(Math.round((u / l) * 100), 999)
}

function getProgressColor(pct: number): string {
  if (pct >= 100) return 'bg-destructive'
  if (pct >= 80) return 'bg-warning'
  return 'bg-primary'
}

const UsageRow: React.FC<{
  label: string
  used: string
  limit: string | null
  unlimitedLabel: string
  creditsLabel: string
}> = ({ label, used, limit, unlimitedLabel, creditsLabel }) => {
  const pct = calcPercent(used, limit)
  const isUnlimited = limit == null

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className={SETTINGS_LABEL}>{label}</span>
        <span className="text-body font-medium tabular-nums">
          {formatCredits(used)}
          {isUnlimited
            ? ` ${creditsLabel}`
            : ` / ${formatCredits(limit)} ${creditsLabel}`}
          {pct != null && (
            <span className={cn(
              'ml-1.5 font-normal', SETTINGS_TEXT_MICRO,
              pct >= 100 ? 'text-destructive' : pct >= 80 ? 'text-warning' : 'text-muted-foreground/60',
            )}>
              {pct}%
            </span>
          )}
        </span>
      </div>
      {!isUnlimited && pct != null && (
        <div className="h-1.5 w-full rounded-full bg-muted/40 overflow-hidden">
          <div
            className={cn('h-full rounded-full transition-all duration-300', getProgressColor(pct))}
            style={{ width: `${Math.min(pct, 100)}%` }}
          />
        </div>
      )}
      {isUnlimited && (
        <span className={SETTINGS_HINT}>{unlimitedLabel}</span>
      )}
    </div>
  )
}

export const MyUsagePanel: React.FC<MyUsagePanelProps> = ({ organization }) => {
  const { t } = useTranslation(['settings'])
  const { data, isLoading, error, refetch, isRefetching } = useMyUsage(organization.id)

  if (isLoading) return <SettingsSkeleton />

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<BarChart3 className="h-4 w-4" />}
        title={t('memberBudget.myUsage.title')}
        meta={
          <Button
            variant="ghost"
            size="sm"
            className={cn(SETTINGS_TEXT_MICRO, 'h-7 gap-1.5')}
            onClick={() => void refetch()}
            disabled={isRefetching}
          >
            <RefreshCw className={cn('h-3 w-3', isRefetching && 'animate-spin')} />
          </Button>
        }
      />

      {error ? (
        <SettingsSectionCard tone="danger">
          <p className="text-body text-destructive">{t('memberBudget.errors.loadFailed')}</p>
        </SettingsSectionCard>
      ) : !data || data.policy_source == null ? (
        <SettingsSectionCard tone="muted">
          <p className="text-body text-muted-foreground">{t('memberBudget.myUsage.noLimit')}</p>
        </SettingsSectionCard>
      ) : (
        <>
          <SettingsSectionCard>
            <div className="space-y-4">
              <UsageRow
                label={t('memberBudget.myUsage.monthlyUsed')}
                used={data.monthly_used}
                limit={data.monthly_limit}
                unlimitedLabel={t('memberBudget.myUsage.unlimited')}
                creditsLabel={t('memberBudget.myUsage.credits')}
              />
              <UsageRow
                label={t('memberBudget.myUsage.dailyUsed')}
                used={data.daily_used}
                limit={data.daily_limit}
                unlimitedLabel={t('memberBudget.myUsage.unlimited')}
                creditsLabel={t('memberBudget.myUsage.credits')}
              />
            </div>
          </SettingsSectionCard>

          <div className="flex items-start gap-2 rounded-lg bg-muted/15 px-3.5 py-2.5">
            <Info className="h-3.5 w-3.5 mt-0.5 shrink-0 text-muted-foreground/60" />
            <div className={cn(SETTINGS_TEXT_META, 'space-y-0.5')}>
              <p>{t('memberBudget.myUsage.resetHint')}</p>
              {data.daily_limit != null && (
                <p>{t('memberBudget.myUsage.dailyResetHint')}</p>
              )}
              {data.admins && data.admins.length > 0 ? (
                <p>
                  {t('memberBudget.myUsage.contactAdminNames', {
                    names: data.admins.map(a => a.display_name).join('、'),
                  })}
                </p>
              ) : (
                <p>{t('memberBudget.myUsage.contactAdmin')}</p>
              )}
            </div>
          </div>
        </>
      )}
    </SettingsPanelLayout>
  )
}
