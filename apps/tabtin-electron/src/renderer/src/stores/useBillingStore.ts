/**
 * useBillingStore — 计费运行时状态
 *
 * 不做 persist：应用启动/WS 重连后通过 API 同步。
 */
import { create } from 'zustand'

export interface BudgetAlert {
  level: 'warning' | 'critical'
  usagePercent: number
  budgetLimit: number
  blocking?: boolean
  walletPaygoAvailable?: boolean
}

export type MemberLimitReason = 'member_monthly_limit' | 'member_daily_limit' | 'member_model_restricted' | null

interface BillingState {
  billingBlocked: boolean
  setBillingBlocked: (blocked: boolean) => void

  memberLimitReached: boolean
  memberLimitReason: MemberLimitReason
  setMemberLimitReached: (reached: boolean, reason?: MemberLimitReason) => void

  budgetAlert: BudgetAlert | null
  /** 用户手动关闭 banner 后为 true；收到新事件会重置 */
  budgetAlertDismissed: boolean
  setBudgetAlert: (alert: BudgetAlert) => void
  clearBudgetAlert: () => void
  dismissBudgetAlert: () => void

  showPerMessageCost: boolean
  setShowPerMessageCost: (show: boolean) => void
}

export const useBillingStore = create<BillingState>((set) => ({
  billingBlocked: false,
  setBillingBlocked: (blocked) => set({ billingBlocked: blocked }),

  memberLimitReached: false,
  memberLimitReason: null,
  setMemberLimitReached: (reached, reason) => set({
    memberLimitReached: reached,
    memberLimitReason: reached ? (reason ?? null) : null,
  }),

  budgetAlert: null,
  budgetAlertDismissed: false,
  setBudgetAlert: (alert) => set({ budgetAlert: alert, budgetAlertDismissed: false }),
  clearBudgetAlert: () => set({ budgetAlert: null, budgetAlertDismissed: false }),
  dismissBudgetAlert: () => set({ budgetAlertDismissed: true }),

  // PRD-04 Wave 5 任务 2 / 任务 4：默认展示（与 Django `BillingRuntimeConfig`
  // 默认值保持一致）。开关语义统一为「控制所有费用数字的展示」——
  // MessageCostLabel / SubagentProgressCard.credits_consumed /
  // TokenUsageRing 的"已消费积分 + 预估费用"都受此开关影响；但纯 token
  // 数字不属于"费用"，不受开关影响。
  showPerMessageCost: true,
  setShowPerMessageCost: (show) => set({ showPerMessageCost: show }),
}))
