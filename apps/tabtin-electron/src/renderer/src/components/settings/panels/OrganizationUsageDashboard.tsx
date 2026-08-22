import React, { lazy, Suspense, useMemo } from 'react'
import { BarChart3, RefreshCw, TrendingDown, TrendingUp, Minus, Users, AlertTriangle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button, EmptyState, StatusNotice, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@components/ui'
import { useQueryClient } from '@tanstack/react-query'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SETTINGS_HINT, SETTINGS_ROW_HOVER, SETTINGS_SOFT_SURFACE, SETTINGS_TEXT_META, SETTINGS_TEXT_META_BASE, SETTINGS_TEXT_MICRO } from '../settingsUi'
import { SettingsSection } from '../SettingsSection'
import { SettingsLink } from '../SettingsLink'
import { MeterBar } from '../MeterBar'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { cn } from '@utils/cn'
import { formatCreditsAuto as formatCredits, formatUsageQuantity, toNumber } from '@/utils/formatBilling'
import { DetailedRowListSkeleton, ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { useMembershipStatusQuery, useTiersQuery } from '@/hooks/queries/membership'
import { useUsageDashboardQuery, useMemberUsageQuery, useBillingSummaryQuery, billingKeys } from '@/hooks/queries/billing'

// echarts 较重，仅在「用量中心」有数据、需要渲染趋势图时才拉取对应 chunk。
const UsageDailyTrendChart = lazy(() =>
  import('./UsageDailyTrendChart').then(m => ({ default: m.UsageDailyTrendChart })),
)

interface Props {
  organization: { id: string; name: string }
  embedded?: boolean
}

// 「消费分类占比」模块待重新整理，暂时整体隐藏；恢复时置回 true 即可。
const SHOW_METER_BREAKDOWN = false

export const OrganizationUsageDashboard: React.FC<Props> = ({ organization, embedded = false }) => {
  const { t } = useTranslation('settings')
  const setRoute = useSettingsSpaceStore(state => state.setRoute)
  /** 用量中心消费数字统一带点券单位 */
  const fmtCredits = (val: string | number) =>
    `${formatCredits(val)}${t('wallet.units.credits')}`

  const getMeterLabel = (key: string): string => {
    const map: Record<string, string> = {
      'llm.tokens': t('usage.meterLabels.llmTokens'),
      'storage.gb_day': t('usage.meterLabels.storageGbDay'),
      'storage.bytes': t('usage.meterLabels.storageBytes'),
      'speech.asr.seconds': t('usage.meterLabels.speechAsrSeconds'),
      'speech.tts.characters': t('usage.meterLabels.speechTtsCharacters'),
      'media.image.count': t('usage.meterLabels.mediaImageCount'),
      'media.video.seconds': t('usage.meterLabels.mediaVideoSeconds'),
      'media.bgm.seconds': t('usage.meterLabels.mediaBgmSeconds'),
      'rag.embedding.tokens': t('usage.meterLabels.ragEmbeddingTokens'),
    }
    return map[key] || key
  }

  const queryClient = useQueryClient()
  const dashboardQuery = useUsageDashboardQuery(organization.id, 30)
  const memberUsageQuery = useMemberUsageQuery(organization.id, 30)
  const llmBudget = useBillingSummaryQuery(organization.id).data?.llm_month_budget ?? null

  const data = dashboardQuery.data
    ? {
        ...dashboardQuery.data,
        by_meter: dashboardQuery.data.by_meter ?? [],
        by_model: dashboardQuery.data.by_model ?? [],
        daily_trend: dashboardQuery.data.daily_trend ?? [],
      }
    : null
  const loading = dashboardQuery.isFetching
  const error = dashboardQuery.error?.message ?? null
  const memberData = memberUsageQuery.data
    ? {
        ...memberUsageQuery.data,
        members: memberUsageQuery.data.members ?? [],
      }
    : null
  const memberLoading = memberUsageQuery.isFetching
  const memberError = memberUsageQuery.error?.message ?? null
  const costAnalysis = useMemo(() => {
    const topMeter = data?.by_meter
      .slice()
      .sort((a, b) => Number(b.total_credits) - Number(a.total_credits))[0] ?? null
    const topModel = data?.by_model
      .slice()
      .sort((a, b) => Number(b.total_credits) - Number(a.total_credits))[0] ?? null
    const topMember = memberData?.members
      .slice()
      .sort((a, b) => Number(b.total_credits) - Number(a.total_credits))[0] ?? null
    const memberConcentrationPct = memberData && Number(memberData.total_credits) > 0 && topMember
      ? (Number(topMember.total_credits) / Number(memberData.total_credits)) * 100
      : null
    return { topMeter, topModel, topMember, memberConcentrationPct }
  }, [data, memberData])

  // 降级超限检测：获取当前 organization 会员状态与免费档配额
  const { data: membershipStatus } = useMembershipStatusQuery(organization.id)
  const { data: tiers = [] } = useTiersQuery()
  const isExpiredMember = membershipStatus?.is_expired === true

  const freeTier = useMemo(() => {
    if (!isExpiredMember || tiers.length === 0) return null
    const sorted = [...tiers].sort((a, b) => a.sort_order - b.sort_order)
    return sorted.find(t => (t.tier_type as string) === 'free') ?? sorted[0]
  }, [isExpiredMember, tiers])

  // 免费档月度 LLM credits 上限（用于超限判断）
  const freeMonthlyCreditsLimit = freeTier ? toNumber(freeTier.included_llm_credits_monthly) : null

  const meterTotal = data?.by_meter.reduce((s, m) => s + Number(m.total_credits), 0) ?? 0
  const isInitialLoading = loading && !data

  const momIcon = data?.month_over_month_pct === null ? <Minus className="h-[1em] w-[1em] text-muted-foreground/60" />
    : (data?.month_over_month_pct ?? 0) > 0 ? <TrendingUp className="h-[1em] w-[1em] text-type-cron" />
    : (data?.month_over_month_pct ?? 0) < 0 ? <TrendingDown className="h-[1em] w-[1em] text-success" />
    : <Minus className="h-[1em] w-[1em] text-muted-foreground/60" />

  const content = (
    <>
      {error ? <StatusNotice tone="danger" description={error} /> : null}
      {isInitialLoading && (
        <div className="space-y-4 py-2">
          <ManagementCardListSkeleton count={2} />
          <DetailedRowListSkeleton count={5} compact />
        </div>
      )}

      {data && (
        <div className="space-y-6">
          {/* FE-38: 概览 — 明确标注"自然月"而非"过去30天" */}
          <SettingsSection title={t('usage.summary.title', { defaultValue: '用量概览' })}>
            <div className="grid grid-cols-2 gap-x-8 gap-y-1">
              <div className="flex justify-between py-1">
                <span className={SETTINGS_HINT}>{t('usage.summary.currentMonth')}</span>
                <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'tabular-nums')}>{fmtCredits(data.current_month_total_credits)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className={SETTINGS_HINT}>{t('usage.summary.lastMonth')}</span>
                <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'tabular-nums')}>{fmtCredits(data.last_month_total_credits)}</span>
              </div>
              <div className="flex justify-between py-1">
                <span className={SETTINGS_HINT}>{t('usage.summary.monthOverMonth')}</span>
                <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'flex items-center gap-1 tabular-nums')}>
                  {momIcon}
                  {data.month_over_month_pct !== null ? `${data.month_over_month_pct > 0 ? '+' : ''}${data.month_over_month_pct}%` : '--'}
                </span>
              </div>
              {/* FE-38 修复：把"统计周期 · N天"改为"统计口径 · 自然月" */}
              <div className="flex justify-between py-1">
                <span className={SETTINGS_HINT}>{t('usage.summary.dataBasis')}</span>
                <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'tabular-nums')}>{t('usage.summary.naturalMonth')}</span>
              </div>
            </div>
            {llmBudget && (
              <div className={cn(SETTINGS_TEXT_MICRO, 'grid grid-cols-2 gap-x-8 gap-y-1 mt-4')}>
                <div className="flex justify-between py-1">
                  <span className={SETTINGS_HINT}>{t('billing.summary.includedLlm')}</span>
                  <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'tabular-nums')}>{fmtCredits(llmBudget.included_credits)}</span>
                </div>
                <div className="flex justify-between py-1">
                  <span className={SETTINGS_HINT}>{t('billing.summary.remainingLlm')}</span>
                  <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'tabular-nums')}>{fmtCredits(llmBudget.remaining_credits)}</span>
                </div>
              </div>
            )}
            {data.today_total_credits && Number(data.today_total_credits) > 0 && (
              <div className={cn(SETTINGS_TEXT_MICRO, 'grid grid-cols-2 gap-x-8 gap-y-1 mt-4')}>
                <div className="flex justify-between py-1">
                  <span className={SETTINGS_HINT}>{t('usage.summary.todayTotal', '今日用量')}</span>
                  <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'tabular-nums')}>{fmtCredits(data.today_total_credits)}</span>
                </div>
                {data.today_aggregated_amount && Number(data.today_aggregated_amount) > 0 && (
                  <div className="flex justify-between py-1">
                    <span className={SETTINGS_HINT}>{t('usage.summary.todayAggregated', '今日聚合用量')}</span>
                    <span className={cn(SETTINGS_TEXT_META_BASE, 'font-medium text-foreground', 'tabular-nums')}>{fmtCredits(data.today_aggregated_amount)}</span>
                  </div>
                )}
              </div>
            )}
            {!embedded ? (
              <div className="flex items-center gap-3 mt-3">
                <SettingsLink onClick={() => setRoute({ category: 'organization', section: 'billing' })}>
                  {t('billing.title')}
                </SettingsLink>
                <span className="text-muted-foreground/60">·</span>
                <SettingsLink onClick={() => setRoute({ category: 'organization', section: 'membership' })}>
                  {t('wallet.goRecharge')}
                </SettingsLink>
              </div>
            ) : null}
          </SettingsSection>

          <SettingsSection title={t('usage.costAnalysis.title', { defaultValue: '成本分析' })}>
            <div className="grid gap-2 sm:grid-cols-2">
              <div className={cn(SETTINGS_SOFT_SURFACE, 'px-3 py-2')}>
                <div className={SETTINGS_HINT}>
                  {t('usage.costAnalysis.topCategory', { defaultValue: '最高成本能力' })}
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 pl-3.5">
                  <span className="truncate text-body font-medium text-foreground">
                    {costAnalysis.topMeter ? getMeterLabel(costAnalysis.topMeter.meter_key) : '—'}
                  </span>
                  <span className="shrink-0 text-body tabular-nums text-foreground">
                    {costAnalysis.topMeter ? fmtCredits(costAnalysis.topMeter.total_credits) : '—'}
                  </span>
                </div>
              </div>
              <div className={cn(SETTINGS_SOFT_SURFACE, 'px-3 py-2')}>
                <div className={SETTINGS_HINT}>
                  {t('usage.costAnalysis.topModel', { defaultValue: '最高成本模型' })}
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 pl-3.5">
                  <span className="truncate text-body font-medium text-foreground">
                    {costAnalysis.topModel?.model_name || t('usage.modelBreakdown.unknownModel')}
                  </span>
                  <span className="shrink-0 text-body tabular-nums text-foreground">
                    {costAnalysis.topModel ? fmtCredits(costAnalysis.topModel.total_credits) : '—'}
                  </span>
                </div>
              </div>
              <div className={cn(SETTINGS_SOFT_SURFACE, 'px-3 py-2')}>
                <div className={SETTINGS_HINT}>
                  {t('usage.costAnalysis.topMember', { defaultValue: '最高成本成员' })}
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 pl-3.5">
                  <span className="truncate text-body font-medium text-foreground">
                    {costAnalysis.topMember?.display_name || '—'}
                  </span>
                  <span className="shrink-0 text-body tabular-nums text-foreground">
                    {costAnalysis.topMember ? fmtCredits(costAnalysis.topMember.total_credits) : '—'}
                  </span>
                </div>
              </div>
              <div className={cn(SETTINGS_SOFT_SURFACE, 'px-3 py-2')}>
                <div className={SETTINGS_HINT}>
                  {t('usage.costAnalysis.memberConcentration', { defaultValue: '成员成本集中度' })}
                </div>
                <div className="mt-1 flex items-center justify-between gap-3 pl-3.5">
                  <span className="truncate text-body font-medium text-foreground">
                    {costAnalysis.memberConcentrationPct === null
                      ? '—'
                      : `${costAnalysis.memberConcentrationPct.toFixed(1)}%`}
                  </span>
                  {!embedded ? (
                    <SettingsLink
                      className="shrink-0"
                      onClick={() => setRoute({ category: 'organization', section: 'teamMembers' })}
                    >
                      {t('usage.costAnalysis.manageBudgets', { defaultValue: '调整预算' })}
                    </SettingsLink>
                  ) : null}
                </div>
              </div>
            </div>
            <StatusNotice
              tone={(data.month_over_month_pct ?? 0) > 20 ? 'warning' : 'info'}
              size="sm"
              description={(data.month_over_month_pct ?? 0) > 20
                ? t('usage.costAnalysis.risingNotice', { defaultValue: '本月成本环比增长较快，建议检查高成本模型和成员预算。' })
                : t('usage.costAnalysis.normalNotice', { defaultValue: '成本分析基于当前周期实时用量，最终账单以结算流水为准。' })}
            />
          </SettingsSection>

          {/* FE-42 + FE-44: 计量分布 — 显示实际用量 + 存储预警 */}
          {SHOW_METER_BREAKDOWN && (
          <SettingsSection title={t('usage.meterBreakdown.title')} subtitle={t('usage.meterBreakdown.shareHint')}>
            {/* 降级后月度超限整体提示 */}
            {isExpiredMember && freeMonthlyCreditsLimit !== null && toNumber(data.current_month_total_credits) > freeMonthlyCreditsLimit && (
              <div className="flex items-center gap-2 rounded-interactive bg-destructive/10 px-2 py-1">
                <AlertTriangle className="h-[1em] w-[1em] shrink-0 text-destructive" />
                <span className={cn(SETTINGS_TEXT_META_BASE, 'text-destructive')}>{t('usage.meterBreakdown.expiredOverBudget')}</span>
              </div>
            )}

            {data.by_meter.length === 0 ? (
              <EmptyState
                icon={<BarChart3 className="h-4 w-4" />}
                title={t('usage.meterBreakdown.empty')}
                description={t('usage.meterBreakdown.emptyHint')}
                layout="card"
                size="sm"
              />
            ) : (
              <div className="space-y-2">
                {data.by_meter.map((meter, i) => {
                  const pct = meterTotal > 0 ? (Number(meter.total_credits) / meterTotal) * 100 : 0
                  const quantityDisplay = formatUsageQuantity(meter.meter_key, meter.total_quantity)

                  // 降级超限判断：LLM tokens meter 超出免费档月度上限
                  const isLlmMeter = meter.meter_key === 'llm.tokens'
                  const isOverFreeLimit = isExpiredMember
                    && isLlmMeter
                    && freeMonthlyCreditsLimit !== null
                    && toNumber(meter.total_credits) > freeMonthlyCreditsLimit

                  return (
                    <div key={meter.meter_key} className={cn('space-y-1', isOverFreeLimit ? 'rounded-interactive bg-destructive/10 px-2 py-1' : '')}>
                      <div className={cn(SETTINGS_TEXT_MICRO, 'flex items-center justify-between')}>
                        <span className={cn('flex items-center gap-2 text-body', isOverFreeLimit ? 'text-destructive font-medium' : 'text-foreground')}>
                          {isOverFreeLimit && (
                            <TooltipProvider>
                              <Tooltip>
                                <TooltipTrigger asChild>
                                  <AlertTriangle className="h-[1em] w-[1em] shrink-0 text-destructive cursor-help" />
                                </TooltipTrigger>
                                <TooltipContent>
                                  {t('usage.meterBreakdown.overLimitTooltip')}
                                </TooltipContent>
                              </Tooltip>
                            </TooltipProvider>
                          )}
                          {getMeterLabel(meter.meter_key)}
                        </span>
                        <span className={cn('tabular-nums flex items-center gap-2', isOverFreeLimit ? 'text-destructive' : 'text-muted-foreground/60')}>
                          {/* FE-42: 展示实际用量数字 */}
                          {quantityDisplay && (
                            <span className={isOverFreeLimit ? 'text-destructive' : 'text-foreground'}>{quantityDisplay}</span>
                          )}
                          <span>
                            {t('usage.meterBreakdown.shareValue', {
                              points: formatCredits(meter.total_credits),
                              percent: pct.toFixed(1),
                            })}
                          </span>
                        </span>
                      </div>
                      <MeterBar
                        value={Number(meter.total_credits)}
                        max={meterTotal}
                        variant="series"
                        colorIndex={i}
                        color={isOverFreeLimit ? 'bg-destructive' : undefined}
                      />
                      {/* 超限提示 CTA */}
                      {isOverFreeLimit && !embedded && (
                        <div className={cn(SETTINGS_TEXT_MICRO, 'flex items-center justify-between mt-1')}>
                          <span className="text-destructive/80">{t('usage.meterBreakdown.overLimitTooltip')}</span>
                          <SettingsLink onClick={() => setRoute({ category: 'organization', section: 'membership' })}>
                            {t('usage.meterBreakdown.goPurchase')}
                          </SettingsLink>
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </SettingsSection>
          )}

          {/* 模型分布 */}
          <SettingsSection title={t('usage.modelBreakdown.title')}>
            {data.by_model.length === 0 ? (
              <EmptyState
                icon={<BarChart3 className="h-4 w-4" />}
                title={t('usage.modelBreakdown.empty')}
                description={t('usage.modelBreakdown.title')}
                layout="card"
                size="sm"
              />
            ) : (
              <div className="space-y-0.5">
                {data.by_model.map((model, idx) => (
                  <div key={model.model_name} className={cn('flex items-center justify-between py-1 rounded-interactive px-1', SETTINGS_TEXT_MICRO, SETTINGS_ROW_HOVER)}>
                    <div className="flex items-center gap-2">
                      <span className="text-muted-foreground/60 w-4 text-right tabular-nums">{idx + 1}</span>
                      <span className="text-body text-foreground">{model.model_name || t('usage.modelBreakdown.unknownModel')}</span>
                    </div>
                    <div className="flex items-center gap-3 text-muted-foreground/60">
                      <span>{model.call_count} {t('usage.modelBreakdown.calls')}</span>
                      <span className="text-foreground font-medium tabular-nums min-w-16 text-right">{fmtCredits(model.total_credits)}</span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </SettingsSection>

          {/* FE-39: 每日趋势 — 标注今日实时数据 */}
          <SettingsSection title={t('usage.dailyTrend.title')}>
            {data.daily_trend.length === 0 ? (
              <EmptyState
                icon={<BarChart3 className="h-4 w-4" />}
                title={t('usage.dailyTrend.empty')}
                description={t('usage.dailyTrend.title')}
                layout="card"
                size="sm"
              />
            ) : (
              <Suspense fallback={<div className="h-[180px] rounded-interactive bg-muted/20 animate-pulse" />}>
                <UsageDailyTrendChart dailyTrend={data.daily_trend} windowStart={data.window_start} />
              </Suspense>
            )}
          </SettingsSection>

          {/* FE-43: 成员消费 — 展示头像 */}
          <SettingsSection
            title={
              <span className="flex items-center gap-2">
                <Users className="h-[1em] w-[1em] text-muted-foreground/60" />
                {t('usage.memberUsage.title')}
              </span>
            }
          >
            {memberLoading && !memberData ? (
              <DetailedRowListSkeleton count={4} compact showPreview={false} />
            ) : memberError ? (
              <StatusNotice
                tone="danger"
                description={memberError}
                actions={
                  <Button variant="ghost" size="sm" onClick={() => void memberUsageQuery.refetch()}>
                    {t('usage.refresh')}
                  </Button>
                }
              />
            ) : !memberData || memberData.members.length === 0 ? (
              <EmptyState
                icon={<Users className="h-4 w-4" />}
                title={t('usage.memberUsage.empty')}
                description={t('usage.memberUsage.title')}
                layout="card"
                size="sm"
              />
            ) : (
              <div className="space-y-1">
                <p className={cn(SETTINGS_HINT, 'mb-2')}>
                  {t('usage.memberUsage.summary', {
                    count: memberData.member_count,
                    total: fmtCredits(memberData.total_credits),
                  })}
                </p>
                {(() => {
                  const maxMemberCredits = Math.max(
                    ...memberData.members.map(m => Number(m.total_credits)), 0.01
                  )
                  return memberData.members.map((member, idx) => {
                    const credits = Number(member.total_credits)
                    return (
                      <div key={member.user_id} className={cn('space-y-1 py-1 px-1 rounded-interactive', SETTINGS_ROW_HOVER)}>
                        <div className={cn(SETTINGS_TEXT_MICRO, 'flex items-center justify-between')}>
                          <div className="flex items-center gap-2">
                            <span className="text-muted-foreground/60 w-4 text-right tabular-nums shrink-0">{idx + 1}</span>
                            {/* FE-43: 展示成员头像 */}
                            {member.avatar ? (
                              <img
                                src={member.avatar}
                                alt={member.display_name}
                                className="h-4 w-4 rounded-full object-cover shrink-0"
                                onError={(e) => { (e.target as HTMLImageElement).style.display = 'none' }}
                              />
                            ) : (
                              <span className={cn(SETTINGS_TEXT_MICRO, 'h-4 w-4 rounded-full bg-foreground/[0.06] flex items-center justify-center shrink-0 text-foreground font-medium')}>
                                {member.display_name.charAt(0).toUpperCase()}
                              </span>
                            )}
                            <span className="text-body text-foreground">{member.display_name}</span>
                          </div>
                          <div className="flex items-center gap-2 text-muted-foreground/60">
                            <span>{t('usage.memberUsage.events', { count: member.event_count })}</span>
                            <span className={SETTINGS_TEXT_MICRO}>{member.percentage}%</span>
                            <span className="text-foreground font-medium tabular-nums min-w-16 text-right">
                              {fmtCredits(member.total_credits)}
                            </span>
                          </div>
                        </div>
                        <MeterBar
                          value={credits}
                          max={maxMemberCredits}
                          variant="series"
                          colorIndex={idx}
                          className="ml-9"
                        />
                        {member.by_meter.length > 0 && (
                          <div className="ml-9 flex flex-wrap gap-1 mt-1">
                            {member.by_meter.map(meter => {
                              const quantityDisplay = formatUsageQuantity(
                                meter.meter_key,
                                meter.quantity,
                              )
                              return (
                                <span key={meter.meter_key} className={SETTINGS_HINT}>
                                  {getMeterLabel(meter.meter_key)}{' '}
                                  {quantityDisplay || fmtCredits(meter.credits)}
                                </span>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })
                })()}
              </div>
            )}
          </SettingsSection>
        </div>
      )}
    </>
  )

  if (embedded) {
    return <div className="space-y-4">{content}</div>
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<BarChart3 className="h-4 w-4" />}
        title={t('usage.title')}
        subtitle={t('usage.subtitle', { organization: organization.name })}
        meta={
          <button type="button" onClick={() => void queryClient.invalidateQueries({ queryKey: billingKeys.all })} disabled={loading || memberLoading} className="text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40">
            <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
          </button>
        }
      />
      {content}
    </SettingsPanelLayout>
  )
}
