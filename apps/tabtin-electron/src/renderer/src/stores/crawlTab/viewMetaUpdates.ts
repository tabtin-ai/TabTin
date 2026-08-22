import type {
  CrawlspaceContextCache,
  CrawlspacePersistedViewSeed,
  CrawlspaceViewMetaUpdates,
} from './types'

const CACHE_UPDATE_KEYS = [
  'title',
  'url',
  'favicon',
  'runId',
  'kind',
  'crawlspaceId',
  'isPreview',
  'themeColor',
  'isLoading',
  'hasError',
  'errorDescription',
  'openIntentHints',
] as const

const SEED_UPDATE_KEYS = [
  'title',
  'url',
  'favicon',
  'runId',
  'isPreview',
  'openIntentHints',
] as const

type CacheUpdateKey = (typeof CACHE_UPDATE_KEYS)[number]
type SeedUpdateKey = (typeof SEED_UPDATE_KEYS)[number]

function normalizeFaviconOwnerUrl(url?: string): string | null {
  if (!url || url === 'about:blank') return null

  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null
    return parsed.hostname.replace(/^www\./, '')
  } catch {
    return url
  }
}

export function canReuseFaviconForUrl(sourceUrl?: string, targetUrl?: string): boolean {
  const sourceKey = normalizeFaviconOwnerUrl(sourceUrl)
  const targetKey = normalizeFaviconOwnerUrl(targetUrl)
  return Boolean(sourceKey && targetKey && sourceKey === targetKey)
}

function shouldClearFaviconForUrlChange(previousUrl?: string, nextUrl?: string): boolean {
  if (!nextUrl || previousUrl === nextUrl) return false
  return !canReuseFaviconForUrl(previousUrl, nextUrl)
}

function hasOwn<T extends object, K extends PropertyKey>(
  object: T,
  key: K,
): object is T & Record<K, unknown> {
  return Object.prototype.hasOwnProperty.call(object, key)
}

export function applyViewMetaUpdatesToCache(
  cache: CrawlspaceContextCache | undefined,
  viewId: string,
  updates: CrawlspaceViewMetaUpdates,
): CrawlspaceContextCache | undefined {
  if (!cache) return cache

  let changed = false
  const nextViewList = cache.viewList.map((view) => {
    if (view.viewId !== viewId) return view

    let nextView = view
    for (const key of CACHE_UPDATE_KEYS) {
      if (!hasOwn(updates, key)) continue
      const typedKey = key as CacheUpdateKey
      const nextValue = updates[typedKey]
      if (nextView[typedKey] === nextValue) continue
      if (nextView === view) {
        nextView = { ...view }
      }
      nextView[typedKey] = nextValue as never
      changed = true
    }

    if (
      !hasOwn(updates, 'favicon') &&
      hasOwn(updates, 'url') &&
      shouldClearFaviconForUrlChange(view.url, updates.url) &&
      nextView.favicon !== undefined
    ) {
      if (nextView === view) {
        nextView = { ...view }
      }
      nextView.favicon = undefined
      changed = true
    }

    if (
      !hasOwn(updates, 'openIntentHints') &&
      hasOwn(updates, 'url') &&
      updates.url !== view.url &&
      nextView.openIntentHints !== undefined
    ) {
      if (nextView === view) {
        nextView = { ...view }
      }
      nextView.openIntentHints = undefined
      changed = true
    }

    return nextView
  })

  return changed ? { ...cache, viewList: nextViewList } : cache
}

export function applyViewMetaUpdatesToSeeds(
  seeds: CrawlspacePersistedViewSeed[] | undefined,
  viewId: string,
  updates: CrawlspaceViewMetaUpdates,
): CrawlspacePersistedViewSeed[] | undefined {
  if (!seeds || seeds.length === 0) return seeds

  let changed = false
  const nextSeeds = seeds.map((seed) => {
    if (seed.viewId !== viewId) return seed

    let nextSeed = seed
    for (const key of SEED_UPDATE_KEYS) {
      if (!hasOwn(updates, key)) continue
      const typedKey = key as SeedUpdateKey
      const nextValue = updates[typedKey]
      if (nextSeed[typedKey] === nextValue) continue
      if (nextSeed === seed) {
        nextSeed = { ...seed }
      }
      nextSeed[typedKey] = nextValue as never
      changed = true
    }

    if (
      !hasOwn(updates, 'favicon') &&
      hasOwn(updates, 'url') &&
      shouldClearFaviconForUrlChange(seed.url, updates.url) &&
      nextSeed.favicon !== undefined
    ) {
      if (nextSeed === seed) {
        nextSeed = { ...seed }
      }
      nextSeed.favicon = undefined
      changed = true
    }

    if (
      !hasOwn(updates, 'openIntentHints') &&
      hasOwn(updates, 'url') &&
      updates.url !== seed.url &&
      nextSeed.openIntentHints !== undefined
    ) {
      if (nextSeed === seed) {
        nextSeed = { ...seed }
      }
      nextSeed.openIntentHints = undefined
      changed = true
    }

    return nextSeed
  })

  return changed ? nextSeeds : seeds
}
