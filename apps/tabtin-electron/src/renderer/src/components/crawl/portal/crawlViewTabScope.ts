export interface CrawlViewTabScopeConfig {
  browserScopeKey?: string | null
  spaceId?: string | null
  projectId?: string | null
}

export interface CrawlViewTabScopeState {
  findSpaceByTabKey?: (tabKey: string) => string | null
}

const normalizeScopeKey = (value: string | null | undefined): string | null => {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed || null
}

export function resolveCrawlViewTabScope({
  tabKey,
  config,
  tabsState,
}: {
  tabKey: string
  config?: CrawlViewTabScopeConfig | null
  tabsState: CrawlViewTabScopeState
}): string | null {
  return (
    normalizeScopeKey(config?.browserScopeKey)
    ?? normalizeScopeKey(tabsState.findSpaceByTabKey?.(tabKey) ?? null)
    ?? normalizeScopeKey(config?.spaceId ?? config?.projectId)
  )
}
