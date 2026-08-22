import React from 'react'
import { AlertCircle, Key, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ChatMessage } from '@tabtin/chat-client'
import { isProjectTaskEditAndResendBlocked } from '@/stores/chat/messages/product/delivery/projectTaskSendGate'
import { BILLING_ERROR_CATEGORIES } from '@utils/chat/billingErrorCategories'
import { useSettingsSpaceStore } from '../../../stores/useSettingsSpaceStore'
import { useOrganizationStore } from '../../../stores/useOrganizationStore'
import { canManageOrganization } from '../../../hooks/useCanManageOrganization'

export const BillingErrorCard: React.FC<{
  message: ChatMessage
  sessionId?: string | null
}> = ({ message, sessionId = null }) => {
  const { t } = useTranslation('chat')
  const openSettings = useSettingsSpaceStore(s => s.openSettings)
  const currentUserRole = useOrganizationStore(s => s.currentUserRole)
  const meta = message.metadata as Record<string, unknown> | undefined
  const errorCategory = (meta?.errorCategory ?? meta?.error_category) as string | undefined
  // LLM 点券用尽被拦时后端透传的自动补充失败原因（SSE extras → errorExtras）：
  // auto_topup_disabled / wallet_insufficient / monthly_cap_reached / topup_error。
  // 存在即表示走的是 quota_only「点券用尽」口径（而非旧的钱包扣款不足）。
  const errorExtras = meta?.errorExtras as Record<string, unknown> | undefined
  const topupReason = (errorExtras?.topup_reason ?? meta?.topup_reason) as string | undefined

  const isByokError = errorCategory?.startsWith('byok_') ?? false

  const isBudget = errorCategory === 'budget_exceeded'
  const isOrganization = errorCategory === 'organization_insufficient_credits'
  const isModelRestricted = errorCategory === 'member_model_restricted'
  const isMemberLimit = errorCategory === 'member_budget'
    || errorCategory === 'member_monthly_limit'
    || errorCategory === 'member_daily_limit'
    || isModelRestricted
  const isBalanceIssue = !isBudget && !isMemberLimit && !isByokError
    && (errorCategory === 'insufficient_credits'
      || errorCategory === 'organization_insufficient_credits')
  // 角色感知 CTA:可管理团队（owner）跳团队钱包,普通成员引导联系所有者。
  // currentUserRole 来自 useOrganizationStore,模式参考 BudgetAlertBanner.tsx。
  const isOrganizationAdmin = canManageOrganization(currentUserRole)
  // quota_only 口径（topupReason 存在）：标题改为「LLM 点券已用完」，描述按
  // 「补充失败原因 × 角色」细分——成员一律引导联系管理员；管理员按原因引导
  // 开启自动补充 / 去充值 / 调整上限。
  const quotaExhausted = isOrganization && !!topupReason

  // ：失败 Project Task 会话禁用 BYOK「重试」类入口（充值/设置 CTA 仍可用）。
  const projectTaskResendBlocked = isProjectTaskEditAndResendBlocked(sessionId)

  const handlePrimaryCta = () => {
    if (isByokError) {
      if (errorCategory === 'byok_rate_limit_exceeded') {
        if (projectTaskResendBlocked) return
        window.dispatchEvent(new CustomEvent('chat:retry-last-message', {
          detail: { sessionId },
        }))
      } else if (errorCategory === 'byok_invalid_key') {
        openSettings({ category: 'organization', section: 'llm' })
      } else {
        window.dispatchEvent(new CustomEvent('chat:open-model-selector', {
          detail: { filter: { exclude_byok: true } },
        }))
      }
      return
    }
    if (isModelRestricted) {
      window.dispatchEvent(new CustomEvent('chat:open-model-selector'))
    } else if (isMemberLimit) {
      openSettings({ category: 'organization', section: 'myUsage' })
    } else if (isBudget) {
      openSettings({ category: 'organization', section: 'billing' })
    } else if (isOrganization && !isOrganizationAdmin) {
      // 普通成员无法充值,引导到成员/用量页让他能看到"找谁负责"。
      openSettings({ category: 'organization', section: 'members' })
    } else if (quotaExhausted && isOrganizationAdmin && topupReason !== 'wallet_insufficient') {
      // 点券用尽（管理员）：除"余额不足要先充值"外，主引导都是自动补充设置
      // （开启自动补充 / 调整每月上限），设置卡在「AI 成本」页。
      openSettings({ category: 'organization', section: 'services' })
    } else {
      // 组织侧钱包信息已并入「组织资料」(general) 页，不再有独立 wallet 菜单。
      openSettings({ category: 'organization', section: 'general' })
    }
  }

  const handleSecondaryCta = () => {
    if (errorCategory === 'byok_rate_limit_exceeded') {
      openSettings({ category: 'organization', section: 'llm' })
    } else if (errorCategory === 'byok_invalid_key') {
      window.dispatchEvent(new CustomEvent('chat:open-model-selector', {
        detail: { filter: { exclude_byok: true } },
      }))
    } else if (errorCategory === 'byok_provider_unavailable' || errorCategory === 'byok_quota_exhausted') {
      openSettings({ category: 'organization', section: 'llm' })
    }
  }

  const byokTitle = isByokError
    ? t(`billingError.${byokTitleKey(errorCategory!)}.title`)
    : undefined

  const byokDescription = isByokError
    ? t(`billingError.${byokTitleKey(errorCategory!)}.description`)
    : undefined

  // organization_insufficient_credits 与 BYOK 错误同样走"标题 + 描述"两段式,
  // 让用户能一眼分辨"是钱包问题"而不是后端中文一行文案被淹没在通用气泡里。
  const organizationTitle = isOrganization
    ? (quotaExhausted
        ? t('billingError.quotaExhausted.title', '本月 LLM credits 已用完')
        : t('billingError.organizationInsufficientCredits.title', '组织可用 credits 余额不足'))
    : undefined
  const organizationDescription = isOrganization
    ? (quotaExhausted
        ? (isOrganizationAdmin
            ? t(`billingError.quotaExhausted.admin.${topupReasonKey(topupReason)}`)
            : t('billingError.quotaExhausted.member'))
        : t('billingError.organizationInsufficientCredits.description', '请联系组织管理员充值后再试'))
    : undefined

  const showTitle = isByokError || isOrganization
  const cardTitle = isByokError ? byokTitle : organizationTitle
  const cardDescription = isByokError
    ? byokDescription
    : isOrganization
      ? organizationDescription
      : message.content

  const hideByokRetry =
    projectTaskResendBlocked && errorCategory === 'byok_rate_limit_exceeded'
  const primaryLabel = getPrimaryLabel()
  const secondaryLabel = getSecondaryLabel()

  function getPrimaryLabel(): string {
    if (!isByokError) {
      if (isModelRestricted) return t('billing.switchModel', '切换模型')
      if (isMemberLimit) return t('billing.contactAdmin', '联系管理员')
      if (isBudget) return t('billing.adjustBudget', '调整预算')
      if (isOrganization) {
        if (!isOrganizationAdmin) return t('billing.contactAdmin', '联系管理员')
        if (quotaExhausted) {
          if (topupReason === 'wallet_insufficient') return t('billing.goRecharge', '去充值')
          if (topupReason === 'monthly_cap_reached') return t('billing.adjustTopupCap', '调整花费上限')
          return t('billing.setupAutoTopup', '设置自动补充')
        }
        return t('billing.goTeamWallet', '前往组织钱包')
      }
      return t('billing.goRecharge', '去充值')
    }
    if (errorCategory === 'byok_rate_limit_exceeded') return t('billingError.cta.retry', '重试')
    if (errorCategory === 'byok_invalid_key') return t('billingError.cta.teamSettings', '组织设置')
    return t('billingError.cta.switchToPlatform', '切换到平台模型')
  }

  function getSecondaryLabel(): string | undefined {
    if (!isByokError) return undefined
    if (errorCategory === 'byok_rate_limit_exceeded') return t('billingError.cta.addBackupKey', '添加备用 Key')
    if (errorCategory === 'byok_invalid_key') return t('billingError.cta.switchToPlatform', '切换到平台模型')
    return t('billingError.cta.teamSettings', '组织设置')
  }

  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border/40 bg-background px-4 py-3 max-w-md">
      <div className="flex items-start gap-2">
        <AlertCircle className="h-4 w-4 text-destructive/80 mt-0.5 shrink-0" />
        <div className="flex flex-col gap-1">
          {showTitle && cardTitle && (
            <div className="text-body font-medium text-foreground">
              {cardTitle}
            </div>
          )}
          <div className="text-body leading-[1.6] text-foreground">
            {cardDescription}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {hideByokRetry ? (
          <p className="text-caption text-muted-foreground">
            {t('projectTask.runRequiredTitle', { defaultValue: '请从任务详情重新运行' })}
          </p>
        ) : (
          <button
            type="button"
            onClick={handlePrimaryCta}
            className="inline-flex items-center gap-1 self-start rounded-md bg-accent px-3 h-7 text-body font-medium text-accent-foreground hover:bg-accent/90 transition-colors"
          >
            {errorCategory === 'byok_rate_limit_exceeded' && (
              <RefreshCw className="h-3 w-3" />
            )}
            {primaryLabel}
          </button>
        )}
        {secondaryLabel && isByokError && !hideByokRetry && (
          <button
            type="button"
            onClick={handleSecondaryCta}
            className="self-start text-body text-muted-foreground hover:text-foreground transition-colors"
          >
            {secondaryLabel}
          </button>
        )}
        {isModelRestricted && (
          <button
            type="button"
            onClick={() => openSettings({ category: 'organization', section: 'myUsage' })}
            className="self-start text-body text-muted-foreground hover:text-foreground transition-colors"
          >
            {t('billing.contactAdmin', '联系管理员')}
          </button>
        )}
        {quotaExhausted && isOrganizationAdmin && (
          <button
            type="button"
            onClick={() => openSettings({
              category: 'organization',
              section: topupReason === 'wallet_insufficient' ? 'services' : 'general',
            })}
            className="self-start text-body text-muted-foreground hover:text-foreground transition-colors"
          >
            {topupReason === 'wallet_insufficient'
              ? t('billing.setupAutoTopup', '设置自动补充')
              : t('billing.goTeamWallet', '前往组织钱包')}
          </button>
        )}
        {isBalanceIssue && (
          <button
            type="button"
            onClick={() => window.dispatchEvent(new CustomEvent('chat:open-model-selector'))}
            className="inline-flex items-center gap-1 self-start text-body text-muted-foreground hover:text-foreground transition-colors"
          >
            <Key className="h-3 w-3" />
            {t('billing.useByok', '使用自备 API Key')}
          </button>
        )}
      </div>
      {isBalanceIssue && (
        <div className="text-caption leading-relaxed text-muted-foreground">
          {t(
            'billing.byokHint',
            '自备 API Key 只豁免支持模型的 LLM token 按量费；存储、会员、账单等平台费用仍需钱包余额。',
          )}
        </div>
      )}
    </div>
  )
}

function topupReasonKey(reason: string | undefined): string {
  switch (reason) {
    case 'auto_topup_disabled': return 'autoTopupDisabled'
    case 'wallet_insufficient': return 'walletInsufficient'
    case 'monthly_cap_reached': return 'monthlyCapReached'
    default: return 'topupError'
  }
}

function byokTitleKey(category: string): string {
  switch (category) {
    case 'byok_provider_unavailable': return 'byokProviderUnavailable'
    case 'byok_rate_limit_exceeded': return 'byokRateLimit'
    case 'byok_quota_exhausted': return 'byokQuotaExhausted'
    case 'byok_invalid_key': return 'byokInvalidKey'
    default: return 'byokProviderUnavailable'
  }
}
