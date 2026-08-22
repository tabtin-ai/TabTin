import { MembershipApiService } from '@/services/membershipApi'
import { OrganizationBillingApiService } from '@/services/billingApi'
import { useBillingStore } from '@/stores/useBillingStore'
import type { OrganizationWalletInfo } from '@/types/membership'
import type { OrganizationBillingSummary } from '@/types/billing'
import { clearBalanceBillingErrorsInChatStore } from './clearBalanceBillingChatErrors'

/** 与后端 BillingGuardService.MIN_BALANCE_THRESHOLD 对齐 */
export const MIN_SENDABLE_BALANCE = 0.01

/** 把钱包 / 月度剩余额度解析成有限数字；非法值按 0。 */
export function toFiniteCredits(value: unknown): number {
  const n = Number(value ?? 0)
  return Number.isFinite(n) ? n : 0
}

/**
 * 低余额提醒 / 发送 guard 共用的「仍可消耗点券」口径：
 * 点券钱包可用 + 本月套餐剩余。新建免费组织钱包为 0 但月度额度仍在时，不应误报严重不足。
 */
export function resolveSpendableCredits(
  walletAvailablePrecise: unknown,
  remainingIncludedCreditsPrecise: unknown = 0,
): number {
  return toFiniteCredits(walletAvailablePrecise) + toFiniteCredits(remainingIncludedCreditsPrecise)
}

export function isBillingBlockedByAvailableCredits(
  availableCreditsPrecise: unknown,
  remainingIncludedCreditsPrecise: unknown = 0,
): boolean {
  const available = Number(availableCreditsPrecise ?? 0)
  const remainingIncluded = Number(remainingIncludedCreditsPrecise ?? 0)
  if (!Number.isFinite(available) || !Number.isFinite(remainingIncluded)) return true
  return available + remainingIncluded < MIN_SENDABLE_BALANCE
}

export function syncBillingBlockedFromRuntimeState(
  wallet: Pick<OrganizationWalletInfo, 'available_credits_precise'> | null | undefined,
  summary: Pick<OrganizationBillingSummary, 'llm_month_budget'> | null | undefined,
): void {
  const wasBlocked = useBillingStore.getState().billingBlocked
  const nowBlocked = isBillingBlockedByAvailableCredits(
    wallet?.available_credits_precise,
    summary?.llm_month_budget?.remaining_credits,
  )
  useBillingStore.getState().setBillingBlocked(nowBlocked)
  // ：余额从不足恢复时，消掉对话内粘滞的余额不足卡 / 侧栏失败 `!`
  if (wasBlocked && !nowBlocked) {
    clearBalanceBillingErrorsInChatStore()
  }
}

/**
 * 用套餐 LLM 剩余额度 + 钱包余额校正 chat 发送 guard。
 * 免费套餐额度足够时，钱包为 0 也允许发送。
 */
export function syncBillingBlockedFromWallet(
  organizationId: string,
  isCurrent: () => boolean = () => true,
): void {
  void Promise.allSettled([
    MembershipApiService.getOrganizationWallet(organizationId),
    OrganizationBillingApiService.getOrganizationSummary(organizationId, { days: 1 }),
  ])
    .then(([walletResult, summaryResult]) => {
      if (!isCurrent()) return
      if (walletResult.status !== 'fulfilled') return
      const wallet = walletResult.value
      const summary = summaryResult.status === 'fulfilled' ? summaryResult.value : null
      syncBillingBlockedFromRuntimeState(wallet, summary)
    })
}
