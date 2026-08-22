/**
 * 能力市场「组织精选」跨端列表刷新策略（技能 / 连接器共用口径，）。
 * 无跨端推送时：面板可见则短轮询；从隐藏切回可见时由调用方强制重拉。
 */

export const ORG_MARKET_CATALOG_POLL_MS = 15_000

export function shouldRefreshOrgMarketCatalog(input: {
  liveCatalog: boolean
  catalogActive: boolean
  organizationId: string | null | undefined
}): boolean {
  return Boolean(input.liveCatalog && input.catalogActive && input.organizationId)
}
