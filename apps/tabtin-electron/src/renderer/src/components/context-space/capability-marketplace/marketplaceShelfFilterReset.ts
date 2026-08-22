/**
 * 技能 / 连接器货架筛选重置：切组织或切「推荐 / 组织精选 / 我的」时应回到初值。
 * 抽成纯函数方便单测，避免只靠扫源码断言。
 */

export interface MarketplaceShelfFilterSnapshot {
  search: string
  /** 技能市场分类；连接器侧无此字段时忽略 */
  category: string
  mineScope: string
  workspaceScopeId: string | null
}

export const EMPTY_MARKETPLACE_SHELF_FILTERS: MarketplaceShelfFilterSnapshot = {
  search: '',
  category: 'all',
  mineScope: 'all',
  workspaceScopeId: null,
}

/** 货架 tab 或组织变更时是否应清空筛选（同值点击不清理）。 */
export function shouldResetMarketplaceShelfFilters(
  previousKey: string | null | undefined,
  nextKey: string | null | undefined,
): boolean {
  return previousKey !== nextKey
}
