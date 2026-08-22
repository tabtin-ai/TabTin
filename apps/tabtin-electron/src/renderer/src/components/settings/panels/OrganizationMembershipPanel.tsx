import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Crown, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { StatusNotice, toast } from '@tabtin/smartsheet-ui'
import type { Organization } from '@tabtin/app-shell'
import type {
  MembershipUpgradeQuotePreview,
  MembershipUpgradeOrder,
  MembershipUpgradePreviewResponse,
  MembershipPaymentOptions,
  SubscriptionPlan,
} from '@/types/membership'
import { MembershipApiError, MembershipApiService } from '@services/membershipApi'
import { useSettingsSpaceStore } from '@stores/useSettingsSpaceStore'
import {
  useSubscriptionOverviewQuery,
  useSubscriptionPlansQuery,
} from '@/hooks/queries/membership'
import { cn } from '@utils/cn'
import { SettingsPanelHeader } from '../SettingsPanelHeader'
import { SettingsPanelLayout } from '../SettingsPanelLayout'
import { SettingsSectionCard } from '../SettingsSectionCard'
import { SettingsRow, SettingsRowGroup } from '../SettingsRow'
import { MeterBar } from '../MeterBar'
import { MembershipPaymentDialog } from './MembershipPaymentDialog'
import { SETTINGS_HINT } from '../settingsUi'
import {
  CreditsSummaryCard,
  CurrentSubscriptionCard,
  OrganizationAccountSection,
  SubscriptionEmptyState,
  SubscriptionPlanDialog,
  SubscriptionSkeleton,
  UpgradeQuoteDialog,
} from '../subscription'
import {
  formatQuota,
  formatStorageQuota,
  toFiniteNumber,
} from '../subscription/subscriptionFormat'

interface OrganizationMembershipPanelProps {
  organization: Organization
  canManageOrganization: boolean
  embedded?: boolean
  isOwner?: boolean
  onOpenCashRecharge?: () => void
}

const UPGRADE_QUOTE_ERROR_MESSAGES: Record<string, string> = {
  CURRENT_PERIOD_PRICE_SNAPSHOT_MISSING: '当前套餐暂不支持在线升级，请联系客服。',
  MEMBERSHIP_ACTION_MISMATCH: '套餐状态已变化，请刷新当前订阅和套餐列表。',
  MEMBERSHIP_TIER_LEVEL_INVALID: '套餐等级配置异常，请刷新后重试。',
  MEMBERSHIP_UPGRADE_QUOTE_DISABLED: '当前暂未开放在线升级报价。',
  QUOTE_EXPIRED: '报价已过期，请重新获取。',
  QUOTE_INVALID: '报价无效，请重新获取。',
  ORGANIZATION_BALANCE_INSUFFICIENT: '组织现金钱包余额不足，请先充值后再次确认升级。',
  MEMBERSHIP_UPGRADE_PAYMENT_DISABLED: '当前暂未开放在线升级下单。',
  MEMBERSHIP_UPGRADE_WALLET_PAYMENT_DISABLED: '当前暂未开放组织钱包支付。',
  MEMBERSHIP_STATE_CHANGED: '当前订阅已变化，正在刷新套餐信息，请重新获取报价。',
}

const activeUpgradeOrderKey = (organizationId: string) => `membership:active-upgrade-order:${organizationId}`

const isUpgradeQuote = (
  preview: MembershipUpgradePreviewResponse | null | undefined,
): preview is MembershipUpgradeQuotePreview => {
  return Boolean(preview && preview.action === 'upgrade' && 'quote_token' in preview)
}

const getQuoteErrorMessage = (error: unknown): string => {
  const code = error instanceof MembershipApiError ? error.code : undefined
  if (code && UPGRADE_QUOTE_ERROR_MESSAGES[code]) return UPGRADE_QUOTE_ERROR_MESSAGES[code]
  return error instanceof Error ? error.message : '获取升级报价失败'
}

export const OrganizationMembershipPanel: React.FC<OrganizationMembershipPanelProps> = ({
  organization,
  canManageOrganization,
  embedded = false,
  isOwner = false,
  onOpenCashRecharge,
}) => {
  const { t } = useTranslation('settings')
  const overviewQuery = useSubscriptionOverviewQuery(organization.id)
  const setSettingsRoute = useSettingsSpaceStore((s) => s.setRoute)
  const [planDialogOpen, setPlanDialogOpen] = useState(false)
  const plansQuery = useSubscriptionPlansQuery(organization.id, { enabled: planDialogOpen })
  const openPlanDialog = useCallback(() => {
    setPlanDialogOpen(true)
  }, [])
  const handlePlanDialogOpenChange = useCallback((open: boolean) => {
    setPlanDialogOpen(open)
  }, [])
  const [autoRenewLoading, setAutoRenewLoading] = useState(false)
  const [autoRenewOptimistic, setAutoRenewOptimistic] = useState<boolean | null>(null)
  const [notice, setNotice] = useState('')
  const [localError, setLocalError] = useState('')
  const [quoteDialogOpen, setQuoteDialogOpen] = useState(false)
  const [upgradePaymentDialogOpen, setUpgradePaymentDialogOpen] = useState(false)
  const [quoteLoading, setQuoteLoading] = useState(false)
  const [upgradeOrderLoading, setUpgradeOrderLoading] = useState(false)
  const [quoteError, setQuoteError] = useState('')
  const [upgradeQuote, setUpgradeQuote] = useState<MembershipUpgradeQuotePreview | null>(null)
  const [upgradeOrder, setUpgradeOrder] = useState<MembershipUpgradeOrder | null>(null)
  const [lastUpgradeTarget, setLastUpgradeTarget] = useState<SubscriptionPlan | null>(null)
  const [purchaseDialogOpen, setPurchaseDialogOpen] = useState(false)
  const [purchaseOrder, setPurchaseOrder] = useState<{ order_id: string; amount: string | number } | null>(null)
  const [purchaseOptions, setPurchaseOptions] = useState<MembershipPaymentOptions | null>(null)
  const [scheduledChange, setScheduledChange] = useState<{ type?: string; target_tier?: { tier_type?: string; name?: string; price?: string | number }; effective_at?: string } | null>(null)
  const noticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const overview = overviewQuery.data
  const membership = overview?.membership
  const isInitialLoading = overviewQuery.isLoading && !overview
  const queryError = overviewQuery.error || plansQuery.error
  const error = localError || (queryError instanceof Error ? queryError.message : queryError ? '加载订阅信息失败' : '')

  const showNotice = useCallback((message: string) => {
    setNotice(message)
    if (noticeTimerRef.current) clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = setTimeout(() => {
      setNotice('')
      noticeTimerRef.current = null
    }, 5000)
  }, [])

  const refreshAll = useCallback(() => {
    window.dispatchEvent(new CustomEvent('billing:refresh'))
    void overviewQuery.refetch()
    if (planDialogOpen) void plansQuery.refetch()
    void MembershipApiService.getMembershipScheduledChange(organization.id).then((data) => setScheduledChange(data as typeof scheduledChange)).catch(() => setScheduledChange(null))
  }, [organization.id, overviewQuery, planDialogOpen, plansQuery])

  useEffect(() => {
    void MembershipApiService.getMembershipScheduledChange(organization.id).then((data) => setScheduledChange(data as typeof scheduledChange)).catch(() => setScheduledChange(null))
  }, [organization.id])

  // AdminDash 可随时改套餐展示名；每次打开弹窗强制拉最新目录与概览
  useEffect(() => {
    if (!planDialogOpen) return
    void plansQuery.refetch()
    void overviewQuery.refetch()
    // 只在打开瞬间刷新；勿把 query 对象放进 deps（每帧新引用会打爆请求）
    // eslint-disable-next-line react-hooks/exhaustive-deps -- open edge only
  }, [planDialogOpen])

  const closeQuoteDialog = useCallback((open: boolean) => {
    setQuoteDialogOpen(open)
    if (!open) {
      setUpgradeQuote(null)
      setUpgradeOrder(null)
      setQuoteError('')
      setLastUpgradeTarget(null)
      // quote_token 只存在于 React state，关闭窗口立即销毁。
    }
  }, [])

  const requestUpgradeQuote = useCallback(async (plan: SubscriptionPlan) => {
    setLastUpgradeTarget(plan)
    setQuoteDialogOpen(true)
    setQuoteLoading(true)
    setQuoteError('')
    setUpgradeQuote(null)
    setUpgradeOrder(null)
    try {
      const preview = await MembershipApiService.previewMembershipUpgrade(
        organization.id,
        plan.id,
        membership?.billing_cycle || 'monthly',
      )
      if (!isUpgradeQuote(preview)) {
        setQuoteError(UPGRADE_QUOTE_ERROR_MESSAGES.MEMBERSHIP_ACTION_MISMATCH)
        void plansQuery.refetch()
        return
      }
      setUpgradeQuote(preview)
    } catch (err) {
      const message = getQuoteErrorMessage(err)
      setQuoteError(message)
      if (err instanceof MembershipApiError && ['MEMBERSHIP_STATE_CHANGED', 'MEMBERSHIP_ACTION_MISMATCH', 'QUOTE_INVALID', 'QUOTE_EXPIRED'].includes(err.code || '')) {
        void overviewQuery.refetch()
        void plansQuery.refetch()
      }
    } finally {
      setQuoteLoading(false)
    }
  }, [membership?.billing_cycle, organization.id, overviewQuery, plansQuery])

  const refreshUpgradeOrder = useCallback(async (orderId: string) => {
    const order = await MembershipApiService.getMembershipUpgradeOrder(organization.id, orderId)
    setUpgradeOrder(order)
    return order
  }, [organization.id])

  useEffect(() => {
    if (!canManageOrganization) return
    let cancelled = false
    const restore = async () => {
      try {
        const active = await MembershipApiService.getActiveMembershipUpgradeOrder(organization.id)
        if (cancelled || !active) return
        setUpgradeOrder(active)
        try {
          sessionStorage.setItem(activeUpgradeOrderKey(organization.id), active.order_id)
        } catch {
          // active order id 只是短期恢复线索；无法写入时仍以服务端查询为准。
        }
        setUpgradePaymentDialogOpen(true)
      } catch {
        // 恢复失败不影响当前订阅展示。
      }
    }
    void restore()
    return () => {
      cancelled = true
    }
  }, [canManageOrganization, organization.id])

  const handleCreateUpgradeOrder = useCallback(async () => {
    if (!upgradeQuote || !lastUpgradeTarget || upgradeOrderLoading) return
    setUpgradeOrderLoading(true)
    setQuoteError('')
    try {
      const order = await MembershipApiService.createMembershipUpgradeOrder({
        organizationId: organization.id,
        targetTierId: lastUpgradeTarget.id,
        billingCycle: upgradeQuote.billing_cycle || membership?.billing_cycle || 'monthly',
        quoteToken: upgradeQuote.quote_token,
      })
      setUpgradeOrder(order)
      try {
        sessionStorage.setItem(activeUpgradeOrderKey(organization.id), order.order_id)
      } catch {
        // ignore
      }
      setQuoteDialogOpen(false)
      setUpgradePaymentDialogOpen(true)
      showNotice('升级订单已创建，请选择组织余额、支付宝或微信扫码支付。')
    } catch (err) {
      const code = err instanceof MembershipApiError ? err.code : undefined
      if (code === 'MEMBERSHIP_STATE_CHANGED' || code === 'QUOTE_INVALID' || code === 'QUOTE_EXPIRED') {
        // 报价创建订单时发现生命周期版本变化：刷新服务端状态并自动重新报价一次，
        // 避免用户看到错误后只能手动关闭弹窗重来。
        await overviewQuery.refetch()
        await plansQuery.refetch()
        if (lastUpgradeTarget) {
          await requestUpgradeQuote(lastUpgradeTarget)
          setQuoteError('当前订阅已刷新，请确认最新报价后继续支付。')
          return
        }
      }
      setQuoteError(getQuoteErrorMessage(err))
    } finally {
      setUpgradeOrderLoading(false)
    }
  }, [lastUpgradeTarget, membership?.billing_cycle, organization.id, overviewQuery, plansQuery, requestUpgradeQuote, showNotice, upgradeOrderLoading, upgradeQuote])

  const handleWalletPayUpgradeOrder = useCallback(async () => {
    if (!upgradeOrder) throw new Error('升级订单不存在')
    if (upgradeOrderLoading) throw new Error('支付正在处理中')
    setUpgradeOrderLoading(true)
    setQuoteError('')
    try {
      const order = await MembershipApiService.payMembershipUpgradeOrderWithWallet(
        organization.id,
        upgradeOrder.order_id,
      )
      setUpgradeOrder(order)
      if (order.benefit_status === 'completed' || order.payment_status === 'completed') {
        try {
          sessionStorage.removeItem(activeUpgradeOrderKey(organization.id))
        } catch {
          // ignore
        }
        showNotice('升级成功，当前订阅和权益已刷新。')
        refreshAll()
      } else if (order.payment_status === 'paid') {
        showNotice('支付成功，套餐权益正在生效。')
        window.setTimeout(() => {
          void refreshUpgradeOrder(order.order_id).then((latest) => {
            if (latest.benefit_status === 'completed' || latest.payment_status === 'completed') {
              try {
                sessionStorage.removeItem(activeUpgradeOrderKey(organization.id))
              } catch {
                // ignore
              }
              refreshAll()
            }
          })
        }, 1500)
      }
      return order
    } catch (err) {
      const message = getQuoteErrorMessage(err)
      setQuoteError(message)
      if (err instanceof MembershipApiError && err.code === 'ORGANIZATION_BALANCE_INSUFFICIENT') {
        try {
          const latest = await refreshUpgradeOrder(upgradeOrder.order_id)
          setUpgradeOrder(latest)
        } catch {
          // 保留当前订单视图，不清空订阅信息。
        }
      }
      throw err
    } finally {
      setUpgradeOrderLoading(false)
    }
  }, [organization.id, refreshAll, refreshUpgradeOrder, showNotice, upgradeOrder, upgradeOrderLoading])

  const handleRechargeForUpgrade = useCallback((amount: string) => {
    if (upgradeOrder?.order_id) {
      try {
        sessionStorage.setItem(activeUpgradeOrderKey(organization.id), upgradeOrder.order_id)
        sessionStorage.setItem('settings-open-cash-recharge', '1')
      } catch {
        // ignore
      }
    }
    closeQuoteDialog(false)
    setSettingsRoute({ category: 'organization', section: 'team', organizationId: organization.id })
    showNotice(`已保留升级订单，请充值 ¥${amount}。充值成功后回到「会员与 credits」会自动恢复该订单。`)
  }, [closeQuoteDialog, organization.id, setSettingsRoute, showNotice, upgradeOrder?.order_id])

  const handleSelectPlan = useCallback((plan: SubscriptionPlan) => {
    setLocalError('')
    setNotice('')
    if (plan.current) return
    if (plan.action === 'upgrade') {
      void requestUpgradeQuote(plan)
      return
    }
    if (plan.action === 'new') {
      setLastUpgradeTarget(plan)
      void (async () => {
        try {
          const order = await MembershipApiService.createMembershipPaymentOrder({ organizationId: organization.id, tierId: plan.id, billingCycle: 'monthly' })
          const options = await MembershipApiService.getMembershipPaymentOptions(organization.id, order.order_id)
          setPurchaseOrder(order)
          setPurchaseOptions(options)
          setPurchaseDialogOpen(true)
        } catch (error) {
          const message = error instanceof Error ? error.message : '创建套餐购买订单失败'
          // 套餐弹窗打开时，页面内 StatusNotice 会被遮挡；用 toast 确保错误出现在最上层。
          toast({ variant: 'destructive', description: message })
        }
      })()
      return
    }
    if (plan.action === 'downgrade') {
      void (async () => {
        try {
          const preview = await MembershipApiService.previewMembershipDowngrade(organization.id, plan.id, membership?.billing_cycle || 'monthly')
          const impact = preview.impact as { remaining_days?: number; lost_value?: number } | undefined
          const confirmed = window.confirm(
            `确认预约降级到${plan.name}？\n当前周期继续使用原套餐，下周期生效。\n当前周期不退款。${impact?.remaining_days != null ? `\n剩余 ${impact.remaining_days} 天。` : ''}`,
          )
          if (!confirmed) return
          const quoteToken = String(preview.quote_token || '')
          if (!quoteToken) throw new Error('降级报价已失效，请重新获取')
          await MembershipApiService.scheduleMembershipDowngrade(organization.id, plan.id, quoteToken, membership?.billing_cycle || 'monthly')
          refreshAll()
          showNotice('已预约下周期降级，当前周期继续使用原套餐。')
        } catch (error) {
          toast({ variant: 'destructive', description: error instanceof Error ? error.message : '预约降级失败' })
        }
      })()
      return
    }
    if (plan.action === 'switch') {
      showNotice('PR3 仅展示：同级/月付年付切换将在 PR5 实现，下周期生效。')
      return
    }
    showNotice('PR3 仅展示套餐动作，不创建真实支付订单。')
  }, [membership?.billing_cycle, organization.id, refreshAll, requestUpgradeQuote, showNotice])

  const handleToggleAutoRenew = useCallback(async (checked: boolean) => {
    if (autoRenewLoading) return
    setAutoRenewOptimistic(checked)
    setAutoRenewLoading(true)
    try {
      await MembershipApiService.toggleOrganizationAutoRenew(organization.id, checked)
      toast({ description: checked ? '自动续费已开启' : '自动续费已关闭' })
      refreshAll()
    } catch {
      setAutoRenewOptimistic(null)
      toast({ variant: 'destructive', description: '更新自动续费失败' })
    } finally {
      setAutoRenewLoading(false)
    }
  }, [autoRenewLoading, organization.id, refreshAll])

  const entitlementRows = useMemo(() => {
    const quotaUsage = overview?.entitlements?.quota_usage || membership?.quota_usage || {}
    const entitlements = overview?.entitlements || {}
    const readQuota = (key: string): number | null => toFiniteNumber(entitlements[key])
    const unlimitedLabel = t('membership.entitlements.unlimited')
    const quotaFormatter = (value: number | null | undefined) => formatQuota(value, unlimitedLabel)
    const storageFormatter = (value: number | null | undefined) => formatStorageQuota(value, unlimitedLabel)
    const usageRow = (key: string, label: string, formatter: (value: number | null | undefined) => string = quotaFormatter) => {
      const usage = quotaUsage[key]
      const used = usage?.used
      const limit = usage?.limit ?? readQuota(key)
      const usagePercent = typeof used === 'number' && typeof limit === 'number' && limit > 0
        ? Math.min(100, Math.max(0, Math.round((used / limit) * 100)))
        : undefined
      return {
        key,
        label,
        description: typeof usage?.plan_limit === 'number'
          ? t('membership.entitlements.planLimit', { limit: formatter(usage.plan_limit) })
          : undefined,
        value: typeof used === 'number'
          ? t('membership.entitlements.usedOfLimit', { used: formatter(used), limit: formatter(limit) })
          : formatter(limit),
        usagePercent,
      }
    }
    return [
      usageRow('max_members', t('membership.entitlements.members')),
      usageRow('max_documents', t('membership.entitlements.documents')),
      usageRow('max_tables', t('membership.entitlements.tables')),
      usageRow('included_storage_bytes', t('membership.entitlements.storage'), storageFormatter),
      usageRow('max_groups', t('membership.entitlements.groups')),
    ]
  }, [membership?.quota_usage, overview, t])

  const isFreeTier = !membership || membership.lifecycle_state === 'free' || !membership.membership_id

  const accountOverview = overview ? (
    <OrganizationAccountSection
      organizationId={organization.id}
      isOwner={isOwner}
      canManageOrganization={canManageOrganization}
      membership={membership}
      display={overview.subscription_display}
      includedCredits={overview.included_credits}
      consumedCredits={overview.consumed_credits}
      remainingCredits={overview.remaining_credits}
      wallet={overview.wallet}
      autoRenewLoading={autoRenewLoading}
      autoRenewChecked={autoRenewOptimistic ?? (membership?.auto_renew ?? false)}
      onToggleAutoRenew={handleToggleAutoRenew}
      onOpenPlans={openPlanDialog}
      onOpenCashRecharge={onOpenCashRecharge}
      scheduledChange={scheduledChange}
      hideScheduledChangeNotice={embedded}
      isFreeTier={isFreeTier}
    />
  ) : null

  const entitlementSummaryCard = overview ? (
    <SettingsSectionCard title={t('membership.entitlements.title')} subtitle={t('membership.entitlements.snapshotDescription')}>
      <SettingsRowGroup>
        {entitlementRows.map((row) => (
          <SettingsRow
            key={row.key}
            label={row.label}
            description={row.description}
            control={(
              <div className="flex items-center gap-3">
                <span className="text-body tabular-nums text-foreground">{row.value}</span>
                {typeof row.usagePercent === 'number' && (
                  <MeterBar value={row.usagePercent} max={100} variant="threshold" className="w-24 shrink-0" />
                )}
              </div>
            )}
          />
        ))}
      </SettingsRowGroup>
      <p className={cn(SETTINGS_HINT, 'mt-3')}>{t('membership.entitlements.limitHint')}</p>
    </SettingsSectionCard>
  ) : null

  const content = (
    <>
      {error ? <StatusNotice tone="danger" description={error} /> : null}
      {notice ? <StatusNotice tone="success" description={notice} /> : null}

      {isInitialLoading ? (
        <SubscriptionSkeleton />
      ) : embedded ? (
        <>
          {accountOverview}
          {entitlementSummaryCard}
        </>
      ) : !membership || isFreeTier ? (
        <>
          <SubscriptionEmptyState
            canManageOrganization={canManageOrganization}
            onOpenPlans={openPlanDialog}
            tierName={membership?.tier?.name || overview?.subscription_display?.title}
          />
          {accountOverview ? (
            <CreditsSummaryCard
              includedCredits={overview!.included_credits}
              consumedCredits={overview!.consumed_credits}
              remainingCredits={overview!.remaining_credits}
              wallet={overview!.wallet}
            />
          ) : null}
          {entitlementSummaryCard}
        </>
      ) : overview ? (
        <>
            <CurrentSubscriptionCard
            membership={membership}
            display={overview.subscription_display}
            canManageOrganization={canManageOrganization}
            autoRenewLoading={autoRenewLoading}
            autoRenewChecked={autoRenewOptimistic ?? (membership.auto_renew ?? false)}
            onToggleAutoRenew={handleToggleAutoRenew}
          onOpenPlans={openPlanDialog}
              scheduledChange={scheduledChange}
              hideScheduledChangeNotice={embedded}
            />

          <CreditsSummaryCard
            includedCredits={overview.included_credits}
            consumedCredits={overview.consumed_credits}
            remainingCredits={overview.remaining_credits}
            wallet={overview.wallet}
          />
          {entitlementSummaryCard}
        </>
      ) : null}
    </>
  )

  const dialogs = (
    <>
      <SubscriptionPlanDialog
        open={planDialogOpen}
        onOpenChange={handlePlanDialogOpenChange}
        plans={plansQuery.data?.plans ?? []}
        loading={plansQuery.isLoading || (planDialogOpen && plansQuery.isFetching && !plansQuery.data)}
        error={plansQuery.error instanceof Error ? plansQuery.error.message : ''}
        canManageOrganization={canManageOrganization}
        loadingPlanId={quoteLoading ? lastUpgradeTarget?.id ?? null : null}
        onSelectPlan={handleSelectPlan}
      />
      <UpgradeQuoteDialog
        open={quoteDialogOpen}
        onOpenChange={closeQuoteDialog}
        quote={upgradeQuote}
        order={upgradeOrder}
        error={quoteError}
        loading={quoteLoading}
        orderLoading={upgradeOrderLoading}
        onRetry={() => {
          if (lastUpgradeTarget) {
            void overviewQuery.refetch()
            void plansQuery.refetch()
            void requestUpgradeQuote(lastUpgradeTarget)
          }
        }}
        onCreateOrder={handleCreateUpgradeOrder}
        onOpenPayment={() => {
          setQuoteDialogOpen(false)
          setUpgradePaymentDialogOpen(true)
        }}
        onRecharge={handleRechargeForUpgrade}
      />
      <MembershipPaymentDialog
        open={upgradePaymentDialogOpen}
        onOpenChange={(open) => {
          setUpgradePaymentDialogOpen(open)
          if (!open && upgradeOrder && upgradeOrder.benefit_status !== 'completed') {
            setQuoteDialogOpen(true)
          }
        }}
        planName={lastUpgradeTarget?.name || upgradeOrder?.subject || '会员套餐升级'}
        orderAmount={String(upgradeOrder?.payable_amount ?? '0.00')}
        walletBalance={String(upgradeOrder?.wallet?.available_balance ?? upgradeOrder?.wallet?.available_cny ?? '0.00')}
        shortageAmount={String(upgradeOrder?.wallet?.shortage_amount ?? '0.00')}
        allowedMethods={{
          organization_wallet: Boolean(upgradeOrder?.allowed_actions?.pay_with_wallet),
          alipay: Boolean(upgradeOrder?.allowed_actions?.pay_with_alipay),
          wechat: Boolean(upgradeOrder?.allowed_actions?.pay_with_wechat),
        }}
        initialMethod={upgradeOrder?.payment_method}
        initialPaymentData={upgradeOrder?.payment_data}
        initialPaymentStatus={upgradeOrder?.payment_status}
        initialBenefitStatus={upgradeOrder?.benefit_status}
        onWalletPay={async () => {
          const order = await handleWalletPayUpgradeOrder()
          return {
            paymentStatus: order.payment_status,
            benefitStatus: order.benefit_status,
          }
        }}
        onThirdPartyPay={async (method) => {
          if (!upgradeOrder) throw new Error('升级订单不存在')
          return MembershipApiService.payMembershipOrderWithThirdParty(
            organization.id,
            upgradeOrder.order_id,
            method,
          )
        }}
        onSwitchPaymentMethod={async (method) => {
          if (!upgradeOrder) throw new Error('升级订单不存在')
          const result = await MembershipApiService.switchMembershipPaymentMethod(
            organization.id,
            upgradeOrder.order_id,
            method,
          )
          if (!result.order_id) throw new Error('更换支付方式后未返回新订单')
          setUpgradeOrder((current) => current ? {
            ...current,
            order_id: result.order_id as string,
            order_no: result.order_no || current.order_no,
            payment_method: method,
            payment_status: 'paying',
            benefit_status: 'pending',
            payment_data: result,
          } : current)
          try {
            sessionStorage.setItem(activeUpgradeOrderKey(organization.id), result.order_id)
          } catch {
            // ignore
          }
          void MembershipApiService.getMembershipUpgradeOrder(
            organization.id,
            result.order_id,
          ).then(setUpgradeOrder).catch(() => {
            // 启动支付的响应已包含权威新订单 ID 与二维码，详情刷新失败不回退旧订单。
          })
          return result
        }}
        queryStatus={async () => {
          if (!upgradeOrder) throw new Error('升级订单不存在')
          const order = await MembershipApiService.getMembershipUpgradeOrder(
            organization.id,
            upgradeOrder.order_id,
          )
          return {
            paymentStatus: order.payment_status,
            benefitStatus: order.benefit_status,
          }
        }}
        onPaymentStarted={(data) => {
          const orderId = data.order_id || upgradeOrder?.order_id
          if (orderId) void refreshUpgradeOrder(orderId)
        }}
        onRecharge={() => handleRechargeForUpgrade(upgradeOrder?.wallet?.recommended_recharge_amount || '0.00')}
        onSuccess={() => {
          setUpgradePaymentDialogOpen(false)
          setQuoteDialogOpen(false)
          if (upgradeOrder?.order_id) {
            void refreshUpgradeOrder(upgradeOrder.order_id).finally(refreshAll)
          } else {
            refreshAll()
          }
          showNotice('升级成功，套餐权益已生效。')
        }}
      />
      <MembershipPaymentDialog
        open={purchaseDialogOpen}
        onOpenChange={(open) => {
          setPurchaseDialogOpen(open)
          if (!open) {
            setPurchaseOrder(null)
            setPurchaseOptions(null)
            setLastUpgradeTarget(null)
          }
        }}
        planName={lastUpgradeTarget?.name || '会员套餐'}
        orderAmount={String(purchaseOrder?.amount ?? '0.00')}
        walletBalance={String(purchaseOptions?.wallet_balance ?? '0.00')}
        shortageAmount={String(purchaseOptions?.shortage_amount ?? '0.00')}
        allowedMethods={{
          organization_wallet: Boolean(purchaseOptions?.allowed_actions.organization_wallet),
          alipay: Boolean(purchaseOptions?.allowed_actions.alipay),
          wechat: Boolean(purchaseOptions?.allowed_actions.wechat),
        }}
        initialMethod={purchaseOptions?.payment_method}
        initialPaymentData={purchaseOptions?.payment_data}
        initialPaymentStatus={purchaseOptions?.payment_status}
        initialBenefitStatus={purchaseOptions?.benefit_status}
        onWalletPay={async () => {
          if (!purchaseOrder) throw new Error('支付订单不存在')
          const result = await MembershipApiService.payMembershipOrderWithWallet(
            organization.id,
            purchaseOrder.order_id,
          )
          if (result.order_id && result.order_id !== purchaseOrder.order_id) {
            setPurchaseOrder((current) => current ? {
              ...current,
              order_id: String(result.order_id),
            } : current)
          }
          return {
            paymentStatus: String(result.status || ''),
            benefitStatus: String(result.benefit_status || ''),
          }
        }}
        onThirdPartyPay={(method) => {
          if (!purchaseOrder) throw new Error('支付订单不存在')
          return MembershipApiService.payMembershipOrderWithThirdParty(organization.id, purchaseOrder.order_id, method)
        }}
        onSwitchPaymentMethod={async (method) => {
          if (!purchaseOrder) throw new Error('支付订单不存在')
          const result = await MembershipApiService.switchMembershipPaymentMethod(
            organization.id,
            purchaseOrder.order_id,
            method,
          )
          if (!result.order_id) throw new Error('更换支付方式后未返回新订单')
          setPurchaseOrder((current) => current ? {
            order_id: result.order_id as string,
            amount: result.amount ?? current.amount,
          } : current)
          setPurchaseOptions((current) => current ? {
            ...current,
            order_id: result.order_id as string,
            order_no: result.order_no || current.order_no,
            payment_method: method,
            payment_status: 'paying',
            benefit_status: 'pending',
            payment_data: result,
            allowed_actions: {
              organization_wallet: Boolean(current.allowed_actions.organization_wallet),
              alipay: method === 'alipay',
              wechat: method === 'wechat',
            },
          } : current)
          void MembershipApiService.getMembershipPaymentOptions(
            organization.id,
            result.order_id,
          ).then(setPurchaseOptions).catch(() => {
            // 启动支付的响应已包含权威新订单 ID 与二维码，详情刷新失败不回退旧订单。
          })
          return result
        }}
        queryStatus={async () => {
          if (!purchaseOrder) throw new Error('支付订单不存在')
          const options = await MembershipApiService.getMembershipPaymentOptions(
            organization.id,
            purchaseOrder.order_id,
          )
          return {
            paymentStatus: options.payment_status,
            benefitStatus: options.benefit_status,
          }
        }}
        onPaymentStarted={(data) => {
          const orderId = data.order_id || purchaseOrder?.order_id
          if (!orderId) return
          void MembershipApiService.getMembershipPaymentOptions(organization.id, orderId)
            .then(setPurchaseOptions)
        }}
        onRecharge={() => {
          setPurchaseDialogOpen(false)
          setSettingsRoute({ category: 'organization', section: 'team', organizationId: organization.id })
          showNotice('请先充值组织余额，充值后可继续支付。')
        }}
        onSuccess={() => {
          setPurchaseDialogOpen(false)
          setPurchaseOrder(null)
          setPurchaseOptions(null)
          setLastUpgradeTarget(null)
          refreshAll()
          showNotice('套餐购买成功，权益已生效。')
        }}
      />
    </>
  )

  const refreshButton = (
    <button
      type="button"
      onClick={refreshAll}
      disabled={overviewQuery.isLoading}
      aria-label={t('membership.refresh')}
      className="text-muted-foreground/60 hover:text-foreground transition-colors disabled:opacity-40"
    >
      <RefreshCw className={cn('h-3.5 w-3.5', overviewQuery.isLoading && 'animate-spin')} />
    </button>
  )

  if (embedded) {
    return (
      <>
        {content}
        {dialogs}
      </>
    )
  }

  return (
    <SettingsPanelLayout>
      <SettingsPanelHeader
        icon={<Crown className="h-4 w-4" />}
        title={t('membership.title')}
        subtitle={organization.name}
        meta={refreshButton}
      />
      {content}
      {dialogs}
    </SettingsPanelLayout>
  )
}
