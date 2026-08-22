/**
 * memberBudget react-query keys（无 API 依赖）。
 * 通知流等轻量模块应从此处引用，避免拉起 memberBudgetApi。
 */
export const memberBudgetKeys = {
  all: ['memberBudget'] as const,
  policies: (organizationId: string) =>
    [...memberBudgetKeys.all, 'policies', organizationId] as const,
  usageSummary: (organizationId: string) =>
    [...memberBudgetKeys.all, 'usageSummary', organizationId] as const,
  myUsage: (organizationId: string) =>
    [...memberBudgetKeys.all, 'myUsage', organizationId] as const,
}
