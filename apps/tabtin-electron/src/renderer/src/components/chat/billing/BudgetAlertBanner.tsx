/**
 * BudgetAlertBanner — 预算告警持久 banner
 *
 * 当收到 BUDGET_WARNING / BUDGET_CRITICAL 事件时，在聊天内容顶部
 * 展示持久 banner（toast 消失后仍可见），直到收到 BUDGET_RESOLVED。
 * CTA 按角色差异化：管理员→调整预算，普通成员→联系管理员/查看用量。
 *
 * 套餐额度用完但组织钱包可继续扣费（非阻断）时不展示——用户可正常使用，
 * 无需反复提示「后续从钱包扣费」。
 */

import React from 'react'
import { X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { useBillingStore } from '@/stores/useBillingStore'
import { useOrganizationStore } from '@/stores/useOrganizationStore'
import { canManageOrganization } from '@/hooks/useCanManageOrganization'
import { cn } from '@utils/cn'

export const BudgetAlertBanner: React.FC = React.memo(() => {
  const { t } = useTranslation('common')
  const budgetAlert = useBillingStore(s => s.budgetAlert)
  const dismissed = useBillingStore(s => s.budgetAlertDismissed)
  const dismiss = useBillingStore(s => s.dismissBudgetAlert)
  const currentUserRole = useOrganizationStore(s => s.currentUserRole)

  if (!budgetAlert || dismissed) return null

  // 非阻断 paygo：套餐用完但钱包可扣，不打扰用户
  if (budgetAlert.walletPaygoAvailable && !budgetAlert.blocking) return null

  const isCritical = budgetAlert.level === 'critical'
  const isAdmin = canManageOrganization(currentUserRole)

  const pct = Math.round(budgetAlert.usagePercent)
  const limit = budgetAlert.budgetLimit

  const message = isCritical
    ? t('billing.budgetBannerCritical', { pct, limit })
    : t('billing.budgetBannerWarning', { pct, limit })

  const handleCta = () => {
    if (isAdmin) {
      window.dispatchEvent(new CustomEvent('billing:navigate:billing'))
    } else {
      window.dispatchEvent(new CustomEvent('billing:navigate:usage'))
    }
  }

  const ctaLabel = isAdmin
    ? t('billing.adjustBudget')
    : t('billing.contactAdmin')

  // 设计语言 point-only：容器保持中性 bg-background，状态色退到圆点 + 文字承担，
  // 不做整片彩色面（彩色面积 ≤ 5%）。
  const toneClasses = isCritical
    ? 'bg-background text-destructive'
    : 'bg-background text-warning'

  const dotClass = isCritical ? 'bg-destructive' : 'bg-warning'

  return (
    <div
      className={cn(
        'flex items-center justify-center gap-2 px-3 py-1.5 text-body shrink-0',
        toneClasses,
      )}
      data-chat-notice
    >
      <span className={cn('inline-block w-2 h-2 rounded-full shrink-0', dotClass)} />
      <span className="min-w-0 truncate">{message}</span>
      <button
        type="button"
        onClick={handleCta}
        className="ml-1 underline hover:no-underline shrink-0"
      >
        {ctaLabel}
      </button>
      <button
        type="button"
        onClick={dismiss}
        aria-label={t('close')}
        className="ml-1 opacity-60 hover:opacity-100 transition-opacity shrink-0"
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  )
})
BudgetAlertBanner.displayName = 'BudgetAlertBanner'
