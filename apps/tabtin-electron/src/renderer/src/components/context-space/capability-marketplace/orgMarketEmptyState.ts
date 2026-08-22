/**
 * 组织精选列表空态文案键（纯函数，便于 RTL / 单测，不依赖 React）。
 */

export type OrgMarketEmptyKind = 'loadFailed' | 'noMatch'

export function resolveOrgMarketEmptyKind(input: {
  orgError: string | null
  visibleCount: number
}): OrgMarketEmptyKind | null {
  if (input.orgError) return 'loadFailed'
  if (input.visibleCount === 0) return 'noMatch'
  return null
}
