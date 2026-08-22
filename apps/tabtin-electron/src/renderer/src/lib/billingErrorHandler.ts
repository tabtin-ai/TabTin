/**
 * 统一计费错误 Toast 处理
 *
 * 单一入口：showBillingErrorToast(code) — 根据错误码渲染对应的
 * 轻量 toast，并携带可操作的 CTA 按钮。
 *
 * 防抖：相同错误码在 5 秒内只弹一次，避免批量请求失败时重复通知。
 *
 * 导航事件：
 *   billing:navigate:wallet     → 设置 > 组织资料（现金钱包 / 可用点券概览）
 *   billing:navigate:membership → 设置 > 会员与点券
 *   billing:navigate:usage      → 设置 > 用量概览
 *
 * 这些事件由 AppGlobalEffects 监听并调用 openSettings()。
 */

import React from 'react'
import { CircleAlert } from 'lucide-react'
import { toast as nativeToast, ToastAction } from '@tabtin/smartsheet-ui/toast'
import i18n from '@/i18n'

// ── 已知计费错误码（大写） ────────────────────────────────────────────────────

export const BILLING_ERROR_CODES = new Set([
  'INSUFFICIENT_CREDITS',
  'INSUFFICIENT_BALANCE',
  'ORGANIZATION_INSUFFICIENT_CREDITS',
  'QUOTA_EXCEEDED',
  'ENTITLEMENT_TABLE_LIMIT_EXCEEDED',
  'ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED',
  'ENTITLEMENT_GROUP_LIMIT_EXCEEDED',
  'ENTITLEMENT_MEMBER_LIMIT_EXCEEDED',
  'ENTITLEMENT_STORAGE_LIMIT_EXCEEDED',
  'CONVERSATION_QUOTA_EXCEEDED',
  'SEAT_QUOTA_EXCEEDED',
  'STORAGE_QUOTA_EXCEEDED',
  'BUDGET_EXCEEDED',
  'BILLING_BLOCKED',
  'RATE_LIMITED',
  'RATE_LIMIT_EXCEEDED',
  'MEMBER_MONTHLY_LIMIT',
  'MEMBER_DAILY_LIMIT',
  'MEMBER_MODEL_RESTRICTED',
])

export type QuotaResourceType = 'tabdata' | 'tabdoc'

const RESOURCE_QUOTA_ERROR_CODES: Record<QuotaResourceType, string> = {
  tabdata: 'ENTITLEMENT_TABLE_LIMIT_EXCEEDED',
  tabdoc: 'ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED',
}

const RESOURCE_QUOTA_DESCRIPTION_KEYS: Record<string, string> = {
  ENTITLEMENT_TABLE_LIMIT_EXCEEDED: 'common:billing.tableQuotaExceededDesc',
  ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED: 'common:billing.documentQuotaExceededDesc',
}

/**
 * ``QUOTA_EXCEEDED`` does not identify which resource hit its limit. Creation
 * callers provide that context so the common billing prompt stays actionable.
 */
export function resolveResourceQuotaErrorCode(
  code: string,
  resourceType?: QuotaResourceType,
): string {
  const upper = code.toUpperCase()
  if (upper === 'QUOTA_EXCEEDED' && resourceType) {
    return RESOURCE_QUOTA_ERROR_CODES[resourceType]
  }
  return upper
}

export function getResourceQuotaDescriptionKey(code: string): string | undefined {
  return RESOURCE_QUOTA_DESCRIPTION_KEYS[code.toUpperCase()]
}

function resolveBillingErrorDescription(code: string, fallback?: string): string | undefined {
  const descriptionKey = getResourceQuotaDescriptionKey(code)
  return descriptionKey ? i18n.t(descriptionKey) : fallback
}

type BillingErrorPayload = {
  code?: unknown
  errorCode?: unknown
  error_code?: unknown
  data?: {
    code?: unknown
    errorCode?: unknown
    error_code?: unknown
  }
}

function getPayloadErrorCodeCandidates(payload: BillingErrorPayload | undefined): unknown[] {
  return [
    payload?.errorCode,
    payload?.error_code,
    payload?.code,
    payload?.data?.errorCode,
    payload?.data?.error_code,
    payload?.data?.code,
  ]
}

export function isBillingErrorCode(code: string): boolean {
  return BILLING_ERROR_CODES.has(code.toUpperCase())
}

export function extractBillingErrorCode(error: unknown): string | null {
  if (!error) return null
  let objectMessage = ''
  if (typeof error === 'object') {
    const candidate = error as {
      code?: unknown
      errorCode?: unknown
      error_code?: unknown
      message?: unknown
      response?: { data?: BillingErrorPayload }
      data?: BillingErrorPayload
    }
    objectMessage = typeof candidate.message === 'string' ? candidate.message : ''
    const errorCodeCandidates = [
      candidate.errorCode,
      candidate.error_code,
      candidate.code,
      ...getPayloadErrorCodeCandidates(candidate.response?.data),
      ...getPayloadErrorCodeCandidates(candidate.data),
    ]
    for (const rawCode of errorCodeCandidates) {
      if (typeof rawCode === 'string' && isBillingErrorCode(rawCode)) {
        return rawCode.toUpperCase()
      }
    }
  }
  const message = error instanceof Error ? error.message : objectMessage || String(error)
  const upperMessage = message.toUpperCase()
  for (const code of BILLING_ERROR_CODES) {
    if (upperMessage.includes(code)) return code
  }
  return null
}

// ── 防抖：5 秒内相同错误码只弹一次 ──────────────────────────────────────────

const _lastShownAt: Map<string, number> = new Map()
const DEBOUNCE_MS = 5000

function _shouldShow(code: string): boolean {
  const now = Date.now()
  const last = _lastShownAt.get(code) ?? 0
  if (now - last < DEBOUNCE_MS) return false
  _lastShownAt.set(code, now)
  return true
}

// ── CTA 工厂（ToastAction 需要 React.createElement，因 toast 在组件树外） ──

function _ctaAction(label: string, event: string) {
  return React.createElement(
    ToastAction,
    {
      altText: label,
      onClick: () => window.dispatchEvent(new CustomEvent(event)),
    },
    label,
  )
}

/**
 * 与主界面浮层保持一致：中性卡片面 + 小面积语义色，不再把整张卡片染成告警色。
 * 限制原因必须由文字表达，图标只作辅助，避免仅靠颜色传达状态。
 */
function _noticeTitle(title: React.ReactNode, variant: string | undefined) {
  const iconClass = variant === 'destructive'
    ? 'text-destructive'
    : variant === 'default'
      ? 'text-muted-foreground'
      : 'text-warning'
  return React.createElement(
    'div',
    { className: 'flex min-w-0 items-center gap-2 text-foreground' },
    React.createElement(CircleAlert, {
      className: `h-4 w-4 shrink-0 ${iconClass}`,
      'aria-hidden': true,
    }),
    React.createElement('span', null, title),
  )
}

function _noticeDescription(description: React.ReactNode) {
  if (!description) return undefined
  return React.createElement('span', { className: 'text-muted-foreground' }, description)
}

function toast(options: Parameters<typeof nativeToast>[0]): void {
  nativeToast({
    ...options,
    title: _noticeTitle(options.title, options.variant),
    description: _noticeDescription(options.description),
  })
}

// ── 主函数 ────────────────────────────────────────────────────────────────────

/**
 * 根据错误码展示对应的 billing 错误 toast。
 * 重复调用同一错误码会被防抖忽略（5 秒窗口）。
 */
export function showBillingErrorToast(
  code: string,
  options: { description?: string; resourceType?: QuotaResourceType } = {},
): void {
  const upper = resolveResourceQuotaErrorCode(code, options.resourceType)
  if (!_shouldShow(upper)) return

  switch (upper) {
    case 'ORGANIZATION_INSUFFICIENT_CREDITS':
      toast({
        title: i18n.t('common:billing.organizationInsufficientCreditsTitle'),
        description: i18n.t('common:billing.organizationInsufficientCreditsDesc'),
        variant: 'warning',
        action: _ctaAction(
          i18n.t('common:billing.goTeamRecharge'),
          'billing:navigate:wallet',
        ),
        duration: 5000,
      })
      break

    case 'INSUFFICIENT_CREDITS':
    case 'INSUFFICIENT_BALANCE':
      toast({
        title: i18n.t('common:billing.insufficientCreditsTitle'),
        description: i18n.t('common:billing.insufficientCreditsDesc'),
        variant: 'warning',
        action: _ctaAction(
          i18n.t('common:billing.goRecharge'),
          'billing:navigate:wallet',
        ),
        duration: 5000,
      })
      break

    case 'QUOTA_EXCEEDED':
    case 'ENTITLEMENT_TABLE_LIMIT_EXCEEDED':
    case 'ENTITLEMENT_DOCUMENT_LIMIT_EXCEEDED':
    case 'ENTITLEMENT_GROUP_LIMIT_EXCEEDED':
    case 'CONVERSATION_QUOTA_EXCEEDED':
      toast({
        title: i18n.t('common:billing.quotaExceeded'),
        description: resolveBillingErrorDescription(upper, options.description),
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.goUpgrade'),
          'billing:navigate:membership',
        ),
        duration: 8000,
      })
      break

    case 'SEAT_QUOTA_EXCEEDED':
    case 'ENTITLEMENT_MEMBER_LIMIT_EXCEEDED':
      toast({
        title: i18n.t('common:billing.seatQuotaExceeded'),
        description: options.description,
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.goUpgrade'),
          'billing:navigate:membership',
        ),
        duration: 8000,
      })
      break

    case 'STORAGE_QUOTA_EXCEEDED':
    case 'ENTITLEMENT_STORAGE_LIMIT_EXCEEDED':
      toast({
        title: i18n.t('common:billing.storageQuotaExceeded'),
        description: options.description,
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.goManageStorage', { defaultValue: '管理存储' }),
          'billing:navigate:storage',
        ),
        duration: 8000,
      })
      break

    case 'BUDGET_EXCEEDED':
      toast({
        title: i18n.t('common:billing.budgetExceeded'),
        description: i18n.t('common:billing.budgetExceededDesc'),
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.goRecharge'),
          'billing:navigate:wallet',
        ),
        duration: 8000,
      })
      break

    case 'MEMBER_MONTHLY_LIMIT':
      toast({
        title: i18n.t('common:billing.memberMonthlyLimit'),
        description: i18n.t('common:billing.memberMonthlyLimitDesc'),
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.viewUsage'),
          'billing:navigate:usage',
        ),
        duration: 8000,
      })
      break

    case 'MEMBER_DAILY_LIMIT':
      toast({
        title: i18n.t('common:billing.memberDailyLimit'),
        description: i18n.t('common:billing.memberDailyLimitDesc'),
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.viewUsage'),
          'billing:navigate:usage',
        ),
        duration: 8000,
      })
      break

    case 'MEMBER_MODEL_RESTRICTED':
      toast({
        title: i18n.t('common:billing.memberModelRestricted'),
        description: i18n.t('common:billing.memberModelRestrictedDesc'),
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.viewUsage'),
          'billing:navigate:usage',
        ),
        duration: 8000,
      })
      break

    case 'BILLING_BLOCKED':
      toast({
        title: i18n.t('common:billing.billingBlocked'),
        description: i18n.t('common:billing.billingBlockedDesc'),
        variant: 'destructive',
        action: _ctaAction(
          i18n.t('common:billing.goRecharge'),
          'billing:navigate:wallet',
        ),
        duration: 10000,
      })
      break

    case 'RATE_LIMITED':
    case 'RATE_LIMIT_EXCEEDED':
      toast({
        title: i18n.t('common:billing.rateLimited'),
        variant: 'default',
        duration: 5000,
      })
      break

    default:
      break
  }
}
