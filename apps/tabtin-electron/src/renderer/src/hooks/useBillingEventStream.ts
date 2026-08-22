/**
 * Billing 事件流 Hook
 *
 * 订阅 WS topic `billing.events.{organizationId}`，
 * 根据事件类型展示 toast / 桌面通知，并通过 billing:refresh 事件触发
 * React Query 全量 invalidation（由 useBillingRefreshListener 监听）。
 */
import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { BillingEvents } from '@tabtin/ws-gateway-client'
import { toast, ToastAction } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'
import { useBillingStore } from '@/stores/useBillingStore'
import { useAuthStore } from '@/stores/useAuthStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { canManageOrganization } from '@/hooks/useCanManageOrganization'
import { MembershipApiService } from '@/services/membershipApi'
import { OrganizationBillingApiService } from '@/services/billingApi'
import { MemberBudgetApiService } from '@/services/memberBudgetApi'
import { useSettingsSpaceStore } from '@/stores/useSettingsSpaceStore'
import { syncBillingBlockedFromRuntimeState } from '@/lib/billingGuardSync'
import { clearBalanceBillingErrorsInChatStore } from '@/lib/clearBalanceBillingChatErrors'
import { NOTIFICATION_REFRESH_EVENT } from './queries/notification'
import { useGatewayTopic } from './useGatewayTopic'

const COLLECTION_FAILED_THROTTLE_MS = 24 * 3600 * 1000
const BILLING_BLOCKED_RECHECK_INTERVAL_MS = 30_000
/** 兼容清理旧版本曾写入的余额应用内 toast 会话键。 */
const BALANCE_LOW_TOAST_SESSION_PREFIX = 'tabtin:balance_low_toast:'

function _recheckMemberUsage(wid: string, isCurrent: () => boolean = () => true): Promise<void> {
  return MemberBudgetApiService.getMyUsage(wid)
    .then((usage) => {
      if (!isCurrent()) return
      if (!usage || usage.policy_source == null) {
        useBillingStore.getState().setMemberLimitReached(false)
        return
      }
      const mUsed = parseFloat(usage.monthly_used || '0')
      const mLimit = usage.monthly_limit != null ? parseFloat(usage.monthly_limit) : Infinity
      const dUsed = parseFloat(usage.daily_used || '0')
      const dLimit = usage.daily_limit != null ? parseFloat(usage.daily_limit) : Infinity
      if (mLimit > 0 && mUsed >= mLimit) {
        useBillingStore.getState().setMemberLimitReached(true, 'member_monthly_limit')
      } else if (dLimit > 0 && dUsed >= dLimit) {
        useBillingStore.getState().setMemberLimitReached(true, 'member_daily_limit')
      } else {
        useBillingStore.getState().setMemberLimitReached(false)
      }
    })
    .catch(() => {/* my-usage 查询失败时保持当前状态 */})
}

interface UseBillingEventStreamOptions {
  organizationId: string | null
  enabled?: boolean
}

/**
 * 需要同步刷新 billing 数据的事件类型集合。
 * FE-54: 补充 BUDGET_WARNING / BUDGET_CRITICAL / DEGRADATION_ALERT
 * FE-58: 补充 MEMBERSHIP_EXPIRING
 * 全部使用 BillingEvents 常量，保持 type-safe。
 */
const DATA_REFRESH_EVENTS = new Set<string>([
  BillingEvents.CREDITS_RECHARGED,
  BillingEvents.CASH_RECHARGED, // ：刷余额；提醒走铃铛，本 hook 不 toast
  BillingEvents.BALANCE_LOW,
  BillingEvents.MEMBERSHIP_ACTIVATED,
  BillingEvents.BILLING_UNBLOCKED,
  BillingEvents.BILLING_BLOCKED,
  BillingEvents.INVOICE_REFUNDED,
  BillingEvents.AUTO_RENEW_FAILED,
  BillingEvents.MEMBERSHIP_EXPIRING,
  BillingEvents.MEMBERSHIP_EXPIRED,
  BillingEvents.BUDGET_WARNING,
  BillingEvents.BUDGET_CRITICAL,
  BillingEvents.DEGRADATION_ALERT,
  BillingEvents.MEMBERSHIP_DOWNGRADED_OVERLIMIT,
  BillingEvents.QUOTA_EXHAUSTED,
  BillingEvents.MEMBERSHIP_RENEWAL_CANCELLED,
  BillingEvents.USAGE_AGGREGATED,
  BillingEvents.STORAGE_WARNING,
  BillingEvents.STORAGE_CRITICAL,
  BillingEvents.STORAGE_RESOLVED,
  BillingEvents.STORAGE_PACKAGE_EXPIRING,
  BillingEvents.STORAGE_AUTO_RENEW_FAILED,
  BillingEvents.BUDGET_RESOLVED,
  BillingEvents.INVOICE_COLLECTION_SUCCEEDED,
  BillingEvents.INVOICE_COLLECTION_FAILED,
  BillingEvents.PLATFORM_REFUND_COMPLETED,
  BillingEvents.PLATFORM_REFUND_FAILED,
  BillingEvents.REFUND_PARTIAL_FAILURE,
  BillingEvents.MEMBER_BUDGET_WARNING,
  BillingEvents.MEMBER_BUDGET_EXHAUSTED,
  BillingEvents.MEMBER_BUDGET_RESOLVED,
  BillingEvents.MEMBER_BUDGET_POLICY_CHANGED,
])

function dispatchBillingRefresh() {
  window.dispatchEvent(new CustomEvent('billing:refresh'))
}

/**
 * billing_blocked 事件的 reason 可能是后端机器码（如 BILLING_WALLET_INSUFFICIENT /
 * organization_insufficient_credits），直接展示对用户不可读。机器码统一映射为友好
 * 兜底文案；若 reason 已是人话（如 guard 的中文告警）则原样展示。
 */
function buildBillingBlockedDesc(reason?: string): string {
  const fallback = i18n.t('common:billing.billingBlockedDesc')
  if (!reason) return fallback
  const looksLikeMachineCode = /^[a-z0-9_]+$/i.test(reason)
  return looksLikeMachineCode ? fallback : reason
}

export function isOrganizationBillingGuard(payload: {
  reason?: unknown
  code?: unknown
  error_code?: unknown
  block_type?: unknown
}): boolean {
  const blockType = String(payload.block_type || '').toLowerCase()
  if (blockType === 'request_insufficient_credits') return false
  if (blockType === 'organization_billing_guard') return true

  const code = String(
    payload.error_code || payload.code || payload.reason || '',
  ).toUpperCase()
  return ![
    'ORGANIZATION_INSUFFICIENT_CREDITS',
    'BILLING_WALLET_INSUFFICIENT',
    'INSUFFICIENT_CREDITS',
  ].includes(code)
}

function hasAuthoritativeNotificationProjection(envelope: Record<string, unknown>): boolean {
  const presentation = envelope.presentation
  if (!presentation || typeof presentation !== 'object' || Array.isArray(presentation)) return false

  const marker = presentation as Record<string, unknown>
  return marker.owner === 'notification_projection'
    && marker.projected === true
    && typeof marker.source_event_id === 'string'
    && marker.source_event_id.trim().length > 0
}


function balanceLowToastSessionKey(organizationId: string, level: string): string {
  return `${BALANCE_LOW_TOAST_SESSION_PREFIX}${organizationId}:${level}`
}

/** 充值后清会话去重，避免余额再次跌破时被旧 key 压掉 toast。 */
export function clearBalanceLowToastSession(organizationId: string): void {
  if (!organizationId) return
  try {
    for (const level of ['warning', 'critical']) {
      sessionStorage.removeItem(balanceLowToastSessionKey(organizationId, level))
    }
  } catch {
    // sessionStorage 不可用时忽略
  }
}

export function useBillingEventStream(options: UseBillingEventStreamOptions) {
  const { organizationId, enabled = true } = options

  /**
   * FE-56: credits_recharged + billing_unblocked 在同一充值操作中连续发出时
   * 只展示一条 toast。记录最近一次 CREDITS_RECHARGED 的时间戳，若 BILLING_UNBLOCKED
   * 在 2s 内到达则跳过其 toast。
   */
  const lastRechargedAtRef = useRef<number>(0)
  const lastCollectionFailedRef = useRef<Map<string, number>>(new Map())
  const activeBillingOrganizationIdRef = useRef<string | null>(enabled ? organizationId : null)

  useEffect(() => {
    activeBillingOrganizationIdRef.current = enabled ? organizationId : null
  }, [enabled, organizationId])

  const handleEnvelope = useCallback((envelope: Record<string, unknown>) => {
    const raw = envelope?.payload
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return
    const payload = raw as Record<string, unknown>
    const msgType = typeof envelope?.type === 'string' ? envelope.type : ''
    if (!msgType.startsWith('billing.')) return
    const notificationProjectionHandled = hasAuthoritativeNotificationProjection(envelope)

    if (DATA_REFRESH_EVENTS.has(msgType)) {
      dispatchBillingRefresh()
    }

    switch (msgType) {
      case BillingEvents.BUDGET_WARNING:
      case BillingEvents.BUDGET_CRITICAL:
      case BillingEvents.BUDGET_RESOLVED:
        // 团队预算告警已软下线：保留 DATA_REFRESH，清掉可能残留的 banner 状态，不 toast / 不通知
        useBillingStore.getState().clearBudgetAlert()
        break

      case BillingEvents.BALANCE_LOW: {
        // 余额预警由后端持久通知承载：只给组织管理员进入通知中心并触发 OS 桌面通知。
        // 此 WS 分支只负责刷新余额数据，不在客户端内追加 toast。
        break
      }

      case BillingEvents.BILLING_BLOCKED: {
        const p = payload as unknown as {
          reason?: string
          code?: string
          error_code?: string
          block_type?: string
          organization_id?: string
        }
        // 单次请求资金不足由对话内 BillingErrorCard 承载，不再把整个组织锁住，
        // 也不叠加全局 toast。只有明确的组织计费 Guard 才进入持续阻断态。
        if (!isOrganizationBillingGuard(p)) break
        // 阻断是持续状态：进入阻断态时提醒一次即可，持续期间靠对话内 BillingErrorCard
        // 气泡 + billingBlocked 状态承载。已阻断时再收到 billing_blocked（一个回合多次
        // LLM 调用 / 连续多条消息）只更新状态 + 刷新，不再叠 toast，避免刷屏。
        const wasBlocked = useBillingStore.getState().billingBlocked
        useBillingStore.getState().setBillingBlocked(true)
        if (wasBlocked) break
        if (notificationProjectionHandled) break
        const blockedDesc = buildBillingBlockedDesc(p.reason)
        toast({
          title: i18n.t('common:billing.billingBlocked'),
          description: blockedDesc,
          variant: 'destructive',
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.viewBillingStatus'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:billing')),
            },
            i18n.t('common:billing.viewBillingStatus')
          ),
          duration: 10000,
        })
        break
      }

      case BillingEvents.BILLING_UNBLOCKED: {
        useBillingStore.getState().setBillingBlocked(false)
        clearBalanceBillingErrorsInChatStore()
        // FE-56: 充值成功后 2s 内到达的 billing_unblocked 不再重复弹 toast
        const isRechargeTriggered = Date.now() - lastRechargedAtRef.current < 2000
        if (!isRechargeTriggered) {
          toast({
            title: i18n.t('common:billing.billingUnblocked'),
            variant: 'success',
          })
        }
        break
      }

      case BillingEvents.DEGRADATION_ALERT: {
        if (notificationProjectionHandled) break
        const p = payload as unknown as { meter_key?: string }
        toast({
          title: i18n.t('common:billing.degradationAlert', {
            meterKey: p.meter_key || 'unknown',
          }),
          variant: 'destructive',
        })
        break
      }

      case BillingEvents.INVOICE_REFUNDED: {
        break
      }

      case BillingEvents.INVOICE_COLLECTION_SUCCEEDED: {
        break
      }

      case BillingEvents.INVOICE_COLLECTION_FAILED: {
        if (notificationProjectionHandled) break
        const p = payload as unknown as {
          invoice_id?: string
          invoice_no?: string
          attempt_count?: number
        }
        const invoiceId = p.invoice_id ?? p.invoice_no ?? ''
        const lastShown = lastCollectionFailedRef.current.get(invoiceId)
        if (lastShown && Date.now() - lastShown < COLLECTION_FAILED_THROTTLE_MS) break
        lastCollectionFailedRef.current.set(invoiceId, Date.now())

        const isManager = canManageOrganization(useOrganizationStore.getState().currentUserRole)
        toast({
          title: i18n.t('common:billing.invoiceCollectionFailed'),
          description: isManager
            ? (p.invoice_no
              ? `${p.invoice_no} · ${i18n.t('common:billing.invoiceCollectionFailedAttempts', { count: p.attempt_count ?? 0 })}`
              : undefined)
            : i18n.t('common:billing.invoiceCollectionFailedContactAdmin'),
          action: React.createElement(
            ToastAction,
            {
              altText: isManager
                ? i18n.t('common:billing.goRecharge')
                : i18n.t('common:billing.viewTeamMembers'),
              onClick: () => {
                if (isManager) {
                  window.dispatchEvent(new CustomEvent('billing:navigate:wallet'))
                } else {
                  useSettingsSpaceStore.getState().openSettings({ category: 'organization', section: 'members' })
                }
              },
            },
            isManager
              ? i18n.t('common:billing.goRecharge')
              : i18n.t('common:billing.viewTeamMembers'),
          ),
          variant: 'destructive',
          duration: 10000,
        })
        break
      }

      case BillingEvents.PLATFORM_REFUND_FAILED: {
        if (notificationProjectionHandled) break
        const p = payload as unknown as { refund_no?: string; failure_reason?: string; organization_id?: string }
        toast({
          title: i18n.t('common:billing.platformRefundFailed'),
          description: p.failure_reason || p.refund_no || undefined,
          variant: 'destructive',
          duration: 10000,
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.viewBillingDetail'),
              onClick: () => {
                window.dispatchEvent(new CustomEvent('billing:navigate:billing'))
              },
            },
            i18n.t('common:billing.viewBillingDetail'),
          ),
        })
        break
      }
      case BillingEvents.REFUND_PARTIAL_FAILURE: {
        if (notificationProjectionHandled) break
        const p = payload as unknown as { invoice_no?: string; refund_amount?: string | number; error?: string; organization_id?: string }
        toast({
          title: i18n.t('common:billing.refundPartialFailure'),
          description: p.invoice_no
            ? i18n.t('common:billing.refundPartialFailureDesc', { invoiceNo: p.invoice_no })
            : p.error || undefined,
          variant: 'destructive',
          duration: 10000,
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.viewBillingDetail'),
              onClick: () => {
                window.dispatchEvent(new CustomEvent('billing:navigate:billing'))
              },
            },
            i18n.t('common:billing.viewBillingDetail'),
          ),
        })
        break
      }
      case BillingEvents.PLATFORM_REFUND_COMPLETED: {
        break
      }

      case BillingEvents.CREDITS_RECHARGED:
        useBillingStore.getState().setBillingBlocked(false)
        lastRechargedAtRef.current = Date.now()
        if (organizationId) {
          clearBalanceLowToastSession(organizationId)
        }
        // ：消掉对话内「组织可用点券余额不足」卡与侧栏失败 `!`（铃铛另路径）
        clearBalanceBillingErrorsInChatStore()
        // 后端会标已读 balance_low；再派事件刷未读，避免通知 WS 丢失时角标粘滞
        window.dispatchEvent(new CustomEvent(NOTIFICATION_REFRESH_EVENT, {
          detail: { organizationId, reason: 'credits_recharged' },
        }))
        if (notificationProjectionHandled) break
        toast({
          title: i18n.t('common:billing.creditsRecharged'),
          variant: 'success',
        })
        break

      case BillingEvents.MEMBERSHIP_ACTIVATED:
        toast({
          title: i18n.t('common:billing.membershipActivated'),
          variant: 'success',
        })
        break

      case BillingEvents.MEMBERSHIP_EXPIRING: {
        if (notificationProjectionHandled) break
        const p = payload as unknown as { days_left?: number; organization_id?: string }
        toast({
          title: i18n.t('common:billing.membershipExpiring'),
          description: p.days_left != null
            ? i18n.t('common:billing.membershipExpiringDays', { days: p.days_left })
            : undefined,
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.goRenew'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:membership')),
            },
            i18n.t('common:billing.goRenew')
          ),
          variant: 'destructive',
          duration: 10000,
        })
        break
      }

      case BillingEvents.MEMBERSHIP_EXPIRED:
        if (notificationProjectionHandled) break
        toast({
          title: i18n.t('common:billing.membershipExpired'),
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.goRenew'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:membership')),
            },
            i18n.t('common:billing.goRenew')
          ),
          variant: 'destructive',
        })
        break

      case BillingEvents.AUTO_RENEW_FAILED: {
        if (notificationProjectionHandled) break
        const p = payload as unknown as { tier_name?: string; reason?: string; organization_id?: string }
        toast({
          title: i18n.t('common:billing.autoRenewFailed'),
          description: p.tier_name
            ? i18n.t('common:billing.autoRenewFailedPlan', { plan: p.tier_name })
            : p.reason === 'insufficient_balance'
              ? i18n.t('common:billing.autoRenewFailedBalance')
              : undefined,
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.goRecharge'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:wallet')),
            },
            i18n.t('common:billing.goRecharge')
          ),
          variant: 'destructive',
          duration: 10000,
        })
        break
      }

      case BillingEvents.MEMBERSHIP_DOWNGRADED_OVERLIMIT: {
        if (notificationProjectionHandled) break
        const p = payload as unknown as { exceeded_count?: number; organization_id?: string }
        const exceededCount = p.exceeded_count ?? 0
        toast({
          title: i18n.t('common:billing.membershipDowngradedOverlimit', {
            count: exceededCount,
          }),
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.membershipDowngradedOverlimitAction'),
              onClick: () =>
                window.dispatchEvent(
                  new CustomEvent('billing:navigate:membership'),
                ),
            },
            i18n.t('common:billing.membershipDowngradedOverlimitAction'),
          ),
          variant: 'destructive',
          duration: 12000,
        })
        break
      }

      case BillingEvents.QUOTA_EXHAUSTED:
        // 套餐额度切换到钱包扣费是正常资金路由，DATA_REFRESH_EVENTS 已负责刷新
        // 页面数据；不再用 destructive toast 打断用户，更不会与余额不足提示叠弹。
        break

      case BillingEvents.MEMBERSHIP_RENEWAL_CANCELLED:
        toast({
          title: i18n.t('common:billing.membershipRenewalCancelled'),
          variant: 'destructive',
        })
        break

      case BillingEvents.STORAGE_WARNING: {
        if (notificationProjectionHandled) break
        const swPct = payload.usage_percent != null ? Math.round(Number(payload.usage_percent)) : 0
        toast({
          title: i18n.t('settings:billing.storageWarning'),
          description: i18n.t('settings:billing.storageWarningDesc', { pct: swPct }),
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('settings:billing.goManageStorage'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:storage')),
            },
            i18n.t('settings:billing.goManageStorage'),
          ),
          variant: 'destructive',
          duration: 8000,
        })
        break
      }

      case BillingEvents.STORAGE_CRITICAL: {
        if (notificationProjectionHandled) break
        const scPct = payload.usage_percent != null ? Math.round(Number(payload.usage_percent)) : 0
        toast({
          title: i18n.t('settings:billing.storageCritical'),
          description: i18n.t('settings:billing.storageCriticalDesc', { pct: scPct }),
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('settings:billing.goManageStorage'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:storage')),
            },
            i18n.t('settings:billing.goManageStorage'),
          ),
          variant: 'destructive',
          duration: 12000,
        })
        break
      }

      case BillingEvents.STORAGE_RESOLVED:
        toast({
          title: i18n.t('settings:billing.storageResolved'),
          variant: 'success',
        })
        break

      case BillingEvents.STORAGE_PACKAGE_EXPIRING: {
        if (notificationProjectionHandled) break
        const sp = payload as unknown as { days_remaining?: number; package_name?: string; organization_id?: string }
        toast({
          title: i18n.t('settings:billing.storagePackageExpiring'),
          description: sp.days_remaining != null
            ? i18n.t('settings:billing.storagePackageExpiringDays', {
                days: sp.days_remaining,
                name: sp.package_name || '',
              })
            : undefined,
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('settings:billing.goManageStorage'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:storage')),
            },
            i18n.t('settings:billing.goManageStorage'),
          ),
          variant: 'destructive',
          duration: 10000,
        })
        break
      }

      case BillingEvents.STORAGE_AUTO_RENEW_FAILED: {
        if (notificationProjectionHandled) break
        const sarf = payload as unknown as { package_name?: string; reason?: string; organization_id?: string }
        toast({
          title: i18n.t('settings:billing.storageAutoRenewFailed'),
          description: sarf.reason === 'insufficient_balance'
            ? i18n.t('settings:billing.storageAutoRenewFailedBalance')
            : sarf.package_name
              ? i18n.t('settings:billing.storageAutoRenewFailedPlan', { name: sarf.package_name })
              : undefined,
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.goRecharge'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:wallet')),
            },
            i18n.t('common:billing.goRecharge'),
          ),
          variant: 'destructive',
          duration: 10000,
        })
        break
      }

      case BillingEvents.MEMBER_BUDGET_WARNING: {
        const mbw = payload as unknown as { user_id?: string; usage_percent?: number; budget_type?: string }
        const currentUserId = useAuthStore.getState().user?.id
        if (currentUserId && mbw.user_id && mbw.user_id !== currentUserId) break
        if (notificationProjectionHandled) break
        const mbwPct = mbw.usage_percent != null ? Math.round(Number(mbw.usage_percent)) : 80
        const warningDescKey = mbw.budget_type === 'daily'
          ? 'common:billing.memberBudgetDailyWarningDesc'
          : 'common:billing.memberBudgetWarningDesc'
        toast({
          title: i18n.t('common:billing.memberBudgetWarning'),
          description: i18n.t(warningDescKey, { pct: mbwPct }),
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.viewUsage'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:usage')),
            },
            i18n.t('common:billing.viewUsage'),
          ),
          duration: 6000,
        })
        break
      }

      case BillingEvents.MEMBER_BUDGET_EXHAUSTED: {
        const mbe = payload as unknown as { user_id?: string; budget_type?: string }
        const currentUserIdExh = useAuthStore.getState().user?.id
        if (currentUserIdExh && mbe.user_id && mbe.user_id !== currentUserIdExh) break
        const exhaustedReason = mbe.budget_type === 'daily' ? 'member_daily_limit' as const : 'member_monthly_limit' as const
        useBillingStore.getState().setMemberLimitReached(true, exhaustedReason)
        if (notificationProjectionHandled) break
        toast({
          title: i18n.t('common:billing.memberBudgetExhausted'),
          description: mbe.budget_type === 'daily'
            ? i18n.t('common:billing.memberBudgetDailyExhaustedDesc')
            : i18n.t('common:billing.memberBudgetExhaustedDesc'),
          action: React.createElement(
            ToastAction,
            {
              altText: i18n.t('common:billing.viewUsage'),
              onClick: () => window.dispatchEvent(new CustomEvent('billing:navigate:usage')),
            },
            i18n.t('common:billing.viewUsage'),
          ),
          variant: 'destructive',
          duration: 10000,
        })
        break
      }

      case BillingEvents.MEMBER_BUDGET_RESOLVED: {
        const mbr = payload as unknown as {
          user_id?: string; scope?: string; affected_role?: string
        }
        const currentUserIdRes = useAuthStore.getState().user?.id
        if (mbr.scope === 'personal') {
          if (currentUserIdRes && mbr.user_id && mbr.user_id !== currentUserIdRes) break
          useBillingStore.getState().setMemberLimitReached(false)
          toast({ title: i18n.t('common:billing.memberBudgetResolved'), variant: 'success' })
        } else if (organizationId) {
          _recheckMemberUsage(
            organizationId,
            () => activeBillingOrganizationIdRef.current === organizationId,
          )
        }
        break
      }

      default:
        break
    }
  }, [organizationId])

  const syncBillingRuntimeState = useCallback((jitterMs = 0) => {
    dispatchBillingRefresh()
    // 团队预算告警已软下线：同步时清掉可能残留的 banner 状态
    useBillingStore.getState().clearBudgetAlert()
    // memberLimitReached 不在此处清除，由 _recheckMemberUsage 直接调 my-usage API 校正
    const targetOrganizationId = organizationId
    if (targetOrganizationId) {
      const isCurrentOrganization = () => activeBillingOrganizationIdRef.current === targetOrganizationId
      const jitter = jitterMs > 0 ? Math.random() * jitterMs : 0
      setTimeout(() => {
        // 进入主界面 / 切组织只同步阻断状态和数据，不因余额预警打断用户；
        // 低余额 toast 由 Agent 对话产生的 billing.balance_low 事件承载。
        Promise.allSettled([
          MembershipApiService.getOrganizationWallet(targetOrganizationId),
          OrganizationBillingApiService.getOrganizationSummary(targetOrganizationId, { days: 1 }),
        ])
          .then(([walletResult, summaryResult]) => {
            if (!isCurrentOrganization()) return
            if (walletResult.status !== 'fulfilled') return
            const wallet = walletResult.value
            const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null
            syncBillingBlockedFromRuntimeState(wallet, summary)
          })

        _recheckMemberUsage(targetOrganizationId, isCurrentOrganization)
      }, jitter)
    }
  }, [organizationId])

  useEffect(() => {
    if (!enabled || !organizationId) return
    // memberLimitReached 是本地运行时状态，不带 organization/user 维度。
    // 进入或切换组织时先清掉旧值，再由 my-usage 拉回权威成员额度状态；
    // 这样旧组织/旧用户的限额错误不会把当前组织的 Chat 输入框粘住。
    useBillingStore.getState().setMemberLimitReached(false)
    syncBillingRuntimeState()
  }, [enabled, organizationId, syncBillingRuntimeState])

  useEffect(() => {
    if (!enabled || !organizationId) return
    const timer = window.setInterval(() => {
      const billingState = useBillingStore.getState()
      if (!billingState.billingBlocked && !billingState.memberLimitReached) return
      syncBillingRuntimeState(5000)
    }, BILLING_BLOCKED_RECHECK_INTERVAL_MS)
    return () => window.clearInterval(timer)
  }, [enabled, organizationId, syncBillingRuntimeState])

  const handleReconnected = useCallback(() => {
    // T4: jitter 0-5s 避免大量用户同时重连造成 API 风暴
    syncBillingRuntimeState(5000)
  }, [syncBillingRuntimeState])

  const topic = useMemo(
    () => (organizationId ? `billing.events.${organizationId}` : null),
    [organizationId],
  )

  return useGatewayTopic({
    topic,
    enabled,
    onEvent: handleEnvelope,
    onReconnected: handleReconnected,
    logPrefix: 'BillingEventStream',
  })
}
