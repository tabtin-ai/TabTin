import React, { useCallback, useEffect, useState } from 'react'
import { Layers, ShieldCheck, Store } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useShallow } from 'zustand/react/shallow'
import { Button, ConfirmDialog, EmptyState, Input, StatusNotice, Switch, toast } from '@components/ui'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsRow, SettingsRowGroup } from '../SettingsRow'
import { SettingsLink } from '../SettingsLink'
import { SETTINGS_CONTROL, SETTINGS_HINT } from '../settingsUi'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { OrganizationBillingApiService } from '@/services/billingApi'
import type { Organization } from '@tabtin/app-shell'
import type { LowBalanceConfig, ServiceCatalogData, ServiceCatalogItem } from '@/types/billing'
import { cn } from '@utils/cn'
import {
  formatCreditsAuto as formatCredits,
  formatYuanAmount,
  formatYuanAmountPlain,
  parseYuanInput,
} from '@/utils/formatBilling'
import { OrganizationMemberYoloSetting } from './OrganizationMemberYoloSetting'
import { ManagementCardListSkeleton } from '@components/common/ListSkeletons'
import { WorkspaceAutoMemorySection } from '@components/agent-memory/WorkspaceAutoMemorySection'

interface Props {
  organization: Organization
  canManageOrganization: boolean
  readOnly?: boolean
}

const OFFICIAL_SERVICE_KEY = 'media.image'

/**
 * 低余额「邮件提醒」入口开关：本期暂不提供邮件服务，UI 上隐藏「向组织 Owner 发送邮件提醒」
 * 开关与绑定邮箱提示。仅隐藏渲染——后端 email_enabled 字段与保存逻辑保持不变（保存仍带当前
 * email_enabled 值），后续恢复邮件服务时将此改回 true 即可重新展示，无需其他改动。
 */
const SHOW_LOW_BALANCE_EMAIL_ALERT = false

type CatalogT = (key: string, opts?: Record<string, unknown>) => string

/** API 目录文案为中文硬编码；按 service_key 映射到 i18n，缺词条时回退 API。 */
function catalogLabel(item: ServiceCatalogItem, field: 'name' | 'description' | 'unit', t: CatalogT): string {
  const fallback = field === 'name' ? item.name : field === 'description' ? item.description : item.unit
  return t(`organizationServices.catalog.${item.service_key}.${field}`, { defaultValue: fallback })
}

function formatOfficialServicePrice(item: ServiceCatalogItem, t: CatalogT): string {
  if (!item.unit_price) return t('organizationServices.dynamicPricing')
  return t('organizationPricingRules.officialServicePrice', {
    price: formatCredits(item.unit_price),
    unit: catalogLabel(item, 'unit', t),
  })
}

function formatMonthlyCapInput(raw: string | number | undefined): string {
  const n = Number(raw)
  if (!Number.isFinite(n) || n === 0) return ''
  return formatYuanAmountPlain(n)
}

function parseMonthlyCapInput(raw: string): number {
  const trimmed = raw.trim()
  if (!trimmed) return 0
  return parseYuanInput(trimmed)
}

export const OrganizationServiceCatalogPanel: React.FC<Props> = ({ organization, canManageOrganization, readOnly = false }) => {
  const { t } = useTranslation('settings')
  const setRoute = useSettingsSpaceStore(state => state.setRoute)
  const currentUserId = useAuthStore(useShallow((s) => s.user?.id))
  // 点券自动补充涉及组织现金钱包扣款，仅团队所有者可见可配；编辑者看不到入口。
  const isOwner = Boolean(currentUserId && organization.owner_id && currentUserId === organization.owner_id)
  const canAccessBillingSettings = canManageOrganization && !readOnly
  const canConfigureAutoTopup = isOwner && canAccessBillingSettings
  const [data, setData] = useState<ServiceCatalogData | null>(null)
  const [loading, setLoading] = useState(readOnly)
  const [error, setError] = useState<string | null>(null)

  // LLM 点券自动补充（quota_only 模式：点券用尽即停，可配置从钱包按金额购买补充）
  const [topupEnabled, setTopupEnabled] = useState(false)
  const [topupAmount, setTopupAmount] = useState('')
  const [topupCap, setTopupCap] = useState('')
  const [topupSaving, setTopupSaving] = useState(false)
  const [topupPolicyLoaded, setTopupPolicyLoaded] = useState(false)
  const [topupPolicyError, setTopupPolicyError] = useState(false)
  // 开启且每月上限为 0（不限额）时，保存前二次确认，避免误当成「不许补」
  const [unlimitedCapConfirmOpen, setUnlimitedCapConfirmOpen] = useState(false)
  // 本月已用现金钱包自动补充花费（元；与月上限同口径，来自账单摘要）
  const [monthTopupSpentYuan, setMonthTopupSpentYuan] = useState<string | null>(null)

  useEffect(() => {
    if (!canAccessBillingSettings) return
    let cancelled = false
    void (async () => {
      try {
        const policy = await OrganizationBillingApiService.getBillingPolicy(organization.id)
        if (cancelled) return
        setTopupEnabled(!!policy.auto_topup_enabled)
        setTopupAmount(formatYuanAmountPlain(policy.auto_topup_spend_yuan ?? '1'))
        setTopupCap(formatMonthlyCapInput(policy.auto_topup_monthly_cap_yuan))
        setTopupPolicyLoaded(true)
        setTopupPolicyError(false)
      } catch {
        if (!cancelled) {
          setTopupPolicyLoaded(true)
          setTopupPolicyError(true)
        }
      }
      try {
        const summary = await OrganizationBillingApiService.getOrganizationSummary(organization.id, { days: 1, eventLimit: 1 })
        if (cancelled) return
        setMonthTopupSpentYuan(summary.llm_month_budget?.auto_topup_spent_yuan ?? null)
      } catch { /* 摘要读取失败不影响配置编辑 */ }
    })()
    return () => { cancelled = true }
  }, [canAccessBillingSettings, organization.id])

  useEffect(() => {
    if (!canConfigureAutoTopup) return
    let target: string | null = null
    try {
      target = sessionStorage.getItem('settings-scroll-to')
      if (target) sessionStorage.removeItem('settings-scroll-to')
    } catch {
      return
    }
    if (target !== 'settings-llm-auto-topup') return
    const timer = window.setTimeout(() => {
      document.getElementById('settings-llm-auto-topup')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
    }, 80)
    return () => window.clearTimeout(timer)
  }, [organization.id, canConfigureAutoTopup])

  const validateTopupAmounts = useCallback((): { amount: number; cap: number } | null => {
    const amount = parseYuanInput(topupAmount)
    const cap = parseMonthlyCapInput(topupCap)
    if (!Number.isFinite(amount) || amount < 1 || !Number.isInteger(amount) || !Number.isFinite(cap) || cap < 0) {
      toast({ variant: 'destructive', title: t('billing.autoTopup.invalidValue') })
      return null
    }
    if (cap > 0 && cap < amount) {
      toast({ variant: 'destructive', title: t('billing.autoTopup.capBelowAmount') })
      return null
    }
    return { amount, cap }
  }, [topupAmount, topupCap, t])

  /** 开关 / 金额保存共用：enabled 必须显式传入，避免 setState 异步导致落库用旧值。 */
  const persistTopup = useCallback(async (enabled: boolean) => {
    const amount = parseYuanInput(topupAmount)
    const cap = parseMonthlyCapInput(topupCap)
    setTopupSaving(true)
    try {
      const policy = await OrganizationBillingApiService.updateBillingPolicy(organization.id, {
        auto_topup_enabled: enabled,
        ...(enabled && Number.isFinite(amount) && amount > 0
          ? { auto_topup_spend_yuan: amount, auto_topup_monthly_cap_yuan: cap }
          : {}),
      })
      setTopupEnabled(!!policy.auto_topup_enabled)
      setTopupAmount(formatYuanAmountPlain(policy.auto_topup_spend_yuan ?? '1'))
      setTopupCap(formatMonthlyCapInput(policy.auto_topup_monthly_cap_yuan))
      toast({
        title: enabled
          ? t('billing.autoTopup.enabledSaved', { defaultValue: '已开启 credits 自动补充' })
          : t('billing.autoTopup.disabledSaved', { defaultValue: '已关闭 credits 自动补充' }),
      })
      return true
    } catch (e: unknown) {
      toast({ variant: 'destructive', title: e instanceof Error ? e.message : t('billing.errors.saveFailed') })
      return false
    } finally {
      setTopupSaving(false)
    }
  }, [organization.id, topupAmount, topupCap, t])

  /** 金额 / 上限仍走「保存」；与开关即时落库区分。 */
  const persistTopupAmounts = useCallback(async () => {
    const amount = parseYuanInput(topupAmount)
    const cap = parseMonthlyCapInput(topupCap)
    setTopupSaving(true)
    try {
      const policy = await OrganizationBillingApiService.updateBillingPolicy(organization.id, {
        auto_topup_enabled: topupEnabled,
        ...(topupEnabled && Number.isFinite(amount) && amount > 0
          ? { auto_topup_spend_yuan: amount, auto_topup_monthly_cap_yuan: cap }
          : {}),
      })
      setTopupEnabled(!!policy.auto_topup_enabled)
      setTopupAmount(formatYuanAmountPlain(policy.auto_topup_spend_yuan ?? '1'))
      setTopupCap(formatMonthlyCapInput(policy.auto_topup_monthly_cap_yuan))
      toast({ title: t('billing.autoTopup.saved') })
      return true
    } catch (e: unknown) {
      toast({ variant: 'destructive', title: e instanceof Error ? e.message : t('billing.errors.saveFailed') })
      return false
    } finally {
      setTopupSaving(false)
    }
  }, [organization.id, topupEnabled, topupAmount, topupCap, t])

  const handleTopupEnabledChange = useCallback((checked: boolean) => {
    if (topupSaving || topupPolicyError || !topupPolicyLoaded) return

    if (!checked) {
      const previous = topupEnabled
      setTopupEnabled(false)
      void (async () => {
        const ok = await persistTopup(false)
        if (!ok) setTopupEnabled(previous)
      })()
      return
    }

    const amounts = validateTopupAmounts()
    if (!amounts) return

    setTopupEnabled(true)
    void (async () => {
      const ok = await persistTopup(true)
      if (!ok) setTopupEnabled(false)
    })()
  }, [
    topupSaving,
    topupPolicyError,
    topupPolicyLoaded,
    topupEnabled,
    validateTopupAmounts,
    persistTopup,
  ])

  const handleSaveTopup = useCallback(() => {
    if (topupEnabled) {
      const amounts = validateTopupAmounts()
      if (!amounts) return
    }
    void persistTopupAmounts()
  }, [topupEnabled, validateTopupAmounts, persistTopupAmounts])

  const handleTopupKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      handleSaveTopup()
    }
  }, [handleSaveTopup])

  const handleConfirmUnlimitedCap = useCallback(async () => {
    // 开关开启路径：确认前 UI 仍为关，落库成功后再打开
    if (!topupEnabled) {
      const ok = await persistTopup(true)
      if (ok) setTopupEnabled(true)
      return
    }
    // 已开启时改金额/上限为「不限额」：走金额保存 toast
    await persistTopupAmounts()
  }, [topupEnabled, persistTopup, persistTopupAmounts])

  // 低余额预警（计费设置，从「账单中心」迁入，统一归到本设置 tab）
  const [lowBalanceConfig, setLowBalanceConfig] = useState<LowBalanceConfig | null>(null)
  const [lowBalWarningCredits, setLowBalWarningCredits] = useState('')
  const [lowBalCriticalCredits, setLowBalCriticalCredits] = useState('')
  const [lowBalEmailEnabled, setLowBalEmailEnabled] = useState(true)
  const [lowBalSaving, setLowBalSaving] = useState(false)
  const [lowBalLoadError, setLowBalLoadError] = useState(false)

  useEffect(() => {
    if (!canAccessBillingSettings) return
    let cancelled = false
    void (async () => {
      try {
        const cfg = await OrganizationBillingApiService.getLowBalanceConfig(organization.id)
        if (cancelled) return
        setLowBalanceConfig(cfg)
        setLowBalWarningCredits(cfg.warning_credits)
        setLowBalCriticalCredits(cfg.critical_credits)
        setLowBalEmailEnabled(cfg.email_enabled)
        setLowBalLoadError(false)
      } catch {
        if (!cancelled) setLowBalLoadError(true)
      }
    })()
    return () => { cancelled = true }
  }, [canAccessBillingSettings, organization.id])

  const handleSaveLowBalance = useCallback(async () => {
    const wCredits = Number(lowBalWarningCredits)
    const cCredits = Number(lowBalCriticalCredits)
    if (!Number.isFinite(wCredits) || wCredits < 0 || !Number.isFinite(cCredits) || cCredits < 0) {
      toast({ variant: 'destructive', title: t('billing.lowBalance.invalidCredits') })
      return
    }
    if (cCredits >= wCredits) {
      toast({ variant: 'destructive', title: t('billing.lowBalance.criticalMustBeLower') })
      return
    }
    setLowBalSaving(true)
    try {
      const cfg = await OrganizationBillingApiService.updateLowBalanceConfig(organization.id, {
        warning_credits: wCredits,
        critical_credits: cCredits,
        email_enabled: lowBalEmailEnabled,
      })
      setLowBalanceConfig(cfg)
      setLowBalWarningCredits(cfg.warning_credits)
      setLowBalCriticalCredits(cfg.critical_credits)
      toast({ title: t('billing.lowBalance.saved') })
    } catch (e: unknown) {
      toast({ variant: 'destructive', title: e instanceof Error ? e.message : t('billing.errors.saveFailed') })
    } finally {
      setLowBalSaving(false)
    }
  }, [
    organization.id,
    lowBalWarningCredits,
    lowBalCriticalCredits,
    lowBalEmailEnabled,
    t,
  ])

  const handleLowBalanceKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void handleSaveLowBalance()
    }
  }, [handleSaveLowBalance])

  const load = useCallback(async () => {
    if (!readOnly) return
    setLoading(true)
    setError(null)
    try {
      const result = await OrganizationBillingApiService.getServiceCatalog(organization.id)
      setData(result)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : t('organizationServices.loadFailed'))
    } finally {
      setLoading(false)
    }
  }, [readOnly, t, organization.id])

  useEffect(() => { load() }, [load])

  if (readOnly && loading) {
    return (
      <SettingsPanelLayout>
        <SettingsPanelHeader
          icon={<Layers className="h-4 w-4" />}
          title={readOnly ? t('organizationPricingRules.title') : t('organizationServices.title')}
        />
        <ManagementCardListSkeleton count={6} />
      </SettingsPanelLayout>
    )
  }

  if (readOnly && (error || !data)) {
    return (
      <SettingsPanelLayout>
        <SettingsPanelHeader
          icon={<Layers className="h-4 w-4" />}
          title={readOnly ? t('organizationPricingRules.title') : t('organizationServices.title')}
        />
        <EmptyState
          title={t('organizationServices.loadFailed')}
          description={error || t('organizationServices.unknownError')}
          action={(
            <Button variant="outline" size="sm" onClick={load}>{t('organizationServices.retry')}</Button>
          )}
        />
      </SettingsPanelLayout>
    )
  }

  if (readOnly) {
    const officialService = data?.services.find(item => item.service_key === OFFICIAL_SERVICE_KEY)
    return (
      <SettingsPanelLayout>
        <SettingsPanelHeader
          icon={<Layers className="h-4 w-4" />}
          title={t('organizationPricingRules.title')}
          subtitle={t('organizationPricingRules.subtitle')}
        />

        <div className="space-y-4">
          <StatusNotice
            tone="info"
            description={(
              <div className="flex flex-col gap-1 sm:flex-row sm:gap-6">
                <span className="font-medium text-foreground">
                  {t('organizationPricingRules.pricingExplanationTitle')}
                </span>
                <span className={SETTINGS_HINT}>{t('organizationPricingRules.pricingNote')}</span>
              </div>
            )}
          />

          <PricingRulesCard
            icon={<Store className="h-4 w-4" />}
            title={t('organizationPricingRules.officialServicesTitle')}
          >
            {officialService ? (
              <PricingServiceRow item={officialService} officialOnly />
            ) : (
              <p className={SETTINGS_HINT}>{t('organizationPricingRules.officialServiceUnavailable')}</p>
            )}
          </PricingRulesCard>

          <PricingRulesCard
            icon={<ShieldCheck className="h-4 w-4" />}
            title={t('organizationPricingRules.byokTitle')}
          >
            <div className="flex flex-col gap-4 py-1 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <h4 className="text-body font-medium text-foreground">
                  {t('organizationPricingRules.byokServiceTitle')}
                </h4>
                <p className={cn(SETTINGS_HINT, 'mt-1')}>
                  {t('organizationPricingRules.byokApplicableScenes')}
                </p>
                <p className={cn(SETTINGS_HINT, 'mt-3')}>
                  {t('organizationPricingRules.byokDescription')}
                </p>
              </div>
              <div className="shrink-0 text-left sm:text-right">
                <p className="text-subtitle font-semibold tabular-nums text-primary">
                  {t('organizationPricingRules.byokNoCredits')}
                </p>
                <span className="mt-2 inline-flex rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-body font-medium text-primary">
                  {t('organizationPricingRules.byokProviderSettlement')}
                </span>
              </div>
            </div>
          </PricingRulesCard>
        </div>
      </SettingsPanelLayout>
    )
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Layers className="h-4 w-4" />}
        title={t('organizationServices.title')}
        subtitle={t('organizationServices.subtitle')}
      />

      <div className="space-y-4">
        <SettingsSectionCard bodyClassName="space-y-3">
          <WorkspaceAutoMemorySection organizationId={organization.id} embedded />
        </SettingsSectionCard>

        <OrganizationMemberYoloSetting
          organization={organization}
          canManageOrganization={canManageOrganization}
        />

        {/* LLM 点券自动补充：仅团队所有者可见（涉及现金钱包扣款） */}
        {canConfigureAutoTopup && (
          <SettingsSectionCard
            id="settings-llm-auto-topup"
            title={t('billing.autoTopup.title')}
            subtitle={(
              <>
                <p>{t('billing.autoTopup.subtitle')}</p>
                <p className="mt-1.5">
                  {t('billing.autoTopup.enabled')}
                  {'：'}
                  {t('billing.autoTopup.enabledHint')}
                </p>
                <p className="mt-1.5">
                  {t('billing.autoTopup.amount')}
                  {'：'}
                  {t('billing.autoTopup.amountHint')}
                </p>
                <p className="mt-1.5">
                  {t('billing.autoTopup.monthlyCap')}
                  {'：'}
                  {t('billing.autoTopup.capHint')}
                </p>
              </>
            )}
            subtitleAsTooltip
            actions={(
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={topupSaving || topupPolicyError || !topupPolicyLoaded}
                onClick={handleSaveTopup}
                className="shrink-0"
              >
                {topupSaving ? t('billing.autoTopup.saving') : t('billing.autoTopup.save')}
              </Button>
            )}
            bodyClassName="space-y-2"
          >
            <SettingsRowGroup>
              <SettingsRow
                label={t('billing.autoTopup.enabled')}
                control={(
                  <Switch
                    checked={topupEnabled}
                    disabled={topupSaving || topupPolicyError || !topupPolicyLoaded}
                    onCheckedChange={handleTopupEnabledChange}
                    aria-label={t('billing.autoTopup.enabled')}
                  />
                )}
              />
              <SettingsRow
                label={t('billing.autoTopup.amount')}
                control={(
                  <div className="flex items-center gap-1">
                    <span className={SETTINGS_HINT}>¥</span>
                    <Input
                      type="number"
                      min={1}
                      step={1}
                      value={topupAmount}
                      disabled={!topupEnabled || topupPolicyError || !topupPolicyLoaded}
                      onChange={e => setTopupAmount(e.target.value.replace(/[^\d]/g, ''))}
                      onKeyDown={handleTopupKeyDown}
                      className={cn('w-28 tabular-nums', SETTINGS_CONTROL)}
                    />
                  </div>
                )}
              />
              <SettingsRow
                label={t('billing.autoTopup.monthlyCap')}
                control={(
                  <div className="flex flex-col items-end gap-1">
                    <div className="flex items-center gap-1">
                      <span className={SETTINGS_HINT}>¥</span>
                      <Input
                        type="number"
                        min={0}
                        step={0.01}
                        placeholder={t('billing.autoTopup.capUnlimitedPlaceholder', { defaultValue: '不限额' })}
                        value={topupCap}
                        disabled={!topupEnabled || topupPolicyError || !topupPolicyLoaded}
                        onChange={e => setTopupCap(e.target.value)}
                        onKeyDown={handleTopupKeyDown}
                        aria-label={t('billing.autoTopup.monthlyCap')}
                        className={cn('w-28 tabular-nums', SETTINGS_CONTROL)}
                      />
                    </div>
                    <p className={cn(SETTINGS_HINT, 'max-w-[16rem] text-right')}>
                      {t('billing.autoTopup.capEmptyHint', {
                        defaultValue: '留空表示不限额，余额充足时持续自动补充 credits。',
                      })}
                    </p>
                  </div>
                )}
              />
            </SettingsRowGroup>
            <p className={SETTINGS_HINT}>
              {topupPolicyError
                ? t('organizationServices.summary.autoTopupUnknownDescription')
                : monthTopupSpentYuan != null
                  ? t('billing.autoTopup.monthProgress', { amount: formatYuanAmount(monthTopupSpentYuan) })
                  : t('billing.autoTopup.walletNote')}
            </p>
          </SettingsSectionCard>
        )}

        {/* 低余额预警（计费设置） */}
        {canManageOrganization && !readOnly && (
          <SettingsSectionCard
            title={t('billing.lowBalance.title')}
            subtitle={(
              <>
                <p>{t('billing.lowBalance.subtitle')}</p>
                <p className="mt-1.5">
                  {t('billing.lowBalance.warningCredits')}
                  {'：'}
                  {t('billing.lowBalance.warningCreditsHint')}
                </p>
                <p className="mt-1.5">
                  {t('billing.lowBalance.criticalCredits')}
                  {'：'}
                  {t('billing.lowBalance.criticalCreditsHint')}
                </p>
              </>
            )}
            subtitleAsTooltip
            actions={(
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={lowBalSaving || lowBalLoadError}
                onClick={() => void handleSaveLowBalance()}
                className="shrink-0"
              >
                {lowBalSaving ? t('billing.lowBalance.saving') : t('billing.lowBalance.save')}
              </Button>
            )}
            bodyClassName="space-y-2"
          >
            {lowBalLoadError ? (
              <StatusNotice
                tone="warning"
                size="sm"
                description={<p className={SETTINGS_HINT}>{t('organizationServices.summary.lowBalanceUnknownDescription')}</p>}
              />
            ) : null}
            <SettingsRowGroup>
              <SettingsRow
                label={t('billing.lowBalance.warningCredits')}
                control={(
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={lowBalWarningCredits}
                      onChange={e => setLowBalWarningCredits(e.target.value)}
                      onKeyDown={handleLowBalanceKeyDown}
                      disabled={lowBalLoadError}
                      className={cn('w-28 tabular-nums', SETTINGS_CONTROL)}
                    />
                    <span className={SETTINGS_HINT}>{t('billing.lowBalance.creditsUnit')}</span>
                  </div>
                )}
              />
              <SettingsRow
                label={t('billing.lowBalance.criticalCredits')}
                control={(
                  <div className="flex items-center gap-1">
                    <Input
                      type="number"
                      min={0}
                      step={1}
                      value={lowBalCriticalCredits}
                      onChange={e => setLowBalCriticalCredits(e.target.value)}
                      onKeyDown={handleLowBalanceKeyDown}
                      disabled={lowBalLoadError}
                      className={cn('w-28 tabular-nums', SETTINGS_CONTROL)}
                    />
                    <span className={SETTINGS_HINT}>{t('billing.lowBalance.creditsUnit')}</span>
                  </div>
                )}
              />
              {SHOW_LOW_BALANCE_EMAIL_ALERT ? (
                <SettingsRow
                  label={t('billing.lowBalance.emailEnabled')}
                  description={lowBalanceConfig ? (
                    lowBalanceConfig.owner_has_email && lowBalanceConfig.owner_email_masked
                      ? t('billing.lowBalance.emailRecipient', { email: lowBalanceConfig.owner_email_masked })
                      : t('billing.lowBalance.emailMissing')
                  ) : undefined}
                  control={(
                    <Switch
                      checked={lowBalEmailEnabled}
                      disabled={lowBalLoadError}
                      onCheckedChange={(checked) => setLowBalEmailEnabled(checked)}
                    />
                  )}
                />
              ) : null}
            </SettingsRowGroup>
            {SHOW_LOW_BALANCE_EMAIL_ALERT && lowBalanceConfig && !lowBalanceConfig.owner_has_email ? (
              <div className="space-y-1">
                <p className={cn(SETTINGS_HINT, 'text-warning')}>
                  {lowBalanceConfig.owner_user_id && currentUserId === lowBalanceConfig.owner_user_id
                    ? t('billing.lowBalance.emailMissingOwnerHint')
                    : t('billing.lowBalance.emailMissingOtherHint')}
                </p>
                {lowBalanceConfig.owner_user_id && currentUserId === lowBalanceConfig.owner_user_id ? (
                  <SettingsLink onClick={() => setRoute({ category: 'profile', section: 'account' })}>
                    {t('billing.lowBalance.goBindEmail')}
                  </SettingsLink>
                ) : null}
              </div>
            ) : null}
          </SettingsSectionCard>
        )}
      </div>

      <ConfirmDialog
        open={unlimitedCapConfirmOpen}
        onOpenChange={setUnlimitedCapConfirmOpen}
        title={t('billing.autoTopup.unlimitedCapConfirmTitle')}
        description={t('billing.autoTopup.unlimitedCapConfirmDesc')}
        confirmText={t('billing.autoTopup.unlimitedCapConfirmAction')}
        cancelText={t('cancel', { ns: 'common' })}
        variant="destructive"
        isLoading={topupSaving}
        onConfirm={handleConfirmUnlimitedCap}
      />
    </SettingsPanelLayout>
  )
}

interface PricingServiceRowProps {
  item: ServiceCatalogItem
  officialOnly?: boolean
}

const PricingServiceRow: React.FC<PricingServiceRowProps> = ({ item, officialOnly = false }) => {
  const { t } = useTranslation('settings')

  return (
    <SettingsRow
      label={catalogLabel(item, 'name', t)}
      description={catalogLabel(item, 'description', t)}
      labelClassName="text-body font-medium text-foreground"
      className="py-1 sm:py-2"
      control={<span className="text-subtitle font-semibold tabular-nums text-primary">{formatOfficialServicePrice(item, t)}</span>}
    >
      {officialOnly ? (
        <p className={cn(SETTINGS_HINT, 'mt-2')}>
          {t('organizationPricingRules.officialServiceOnly')}
        </p>
      ) : null}
    </SettingsRow>
  )
}

interface PricingRulesCardProps {
  icon: React.ReactNode
  title: React.ReactNode
  children: React.ReactNode
}

const PricingRulesCard: React.FC<PricingRulesCardProps> = ({ icon, title, children }) => (
  <section className="overflow-hidden rounded-[12px] border border-border/60 bg-background">
    <div className="flex items-center gap-3 border-b border-border/60 px-4 py-3">
      <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
        {icon}
      </span>
      <h3 className="text-body font-semibold text-foreground">{title}</h3>
    </div>
    <div className="px-4 py-3">{children}</div>
  </section>
)
