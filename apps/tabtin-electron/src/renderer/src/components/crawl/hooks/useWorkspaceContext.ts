import { useCallback } from 'react'
import { useCrawlTabStore, type CrawlTab } from '@stores/useCrawlTabStore'
import type { CrawlspaceViewMetaUpdates } from '@stores/crawlTab/types'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'

type CrawlViewRuntimeOptions =
  | {
      profile: string
      kind: 'workspace-view'
      crawlspaceId: string
      partition: string
      isPreview?: boolean
      allowMultiple?: boolean
    }
  | {
      profile: string
      kind: 'normal-view'
      crawlspaceId?: never
      partition?: string
      isPreview?: boolean
      allowMultiple?: boolean
    }

interface UseWorkspaceContextOptions {
  tab: CrawlTab
  allowMultiple?: boolean
}

type LocationUpdates = { url?: string; title?: string; themeColor?: string | null }

export function useWorkspaceContext({ tab, allowMultiple = false }: UseWorkspaceContextOptions) {
  const crawlspaceId = tab.metadata?.crawlspaceId
  const crawlspaceConfig = useCrawlTabStore(state =>
    crawlspaceId ? state.crawlspaceConfigById[crawlspaceId] : undefined
  )
  const spaceId = crawlspaceConfig?.spaceId ?? (crawlspaceConfig as { projectId?: string })?.projectId ?? null
  const browserScopeKey = crawlspaceConfig?.browserScopeKey ?? spaceId

  const setDisplayKey = useSpaceContextTabsStore(state => state.setDisplayKey)
  const getActiveKeyNow = useCallback(() => {
    if (!browserScopeKey) return null
    return useSpaceContextTabsStore.getState().activeKeyBySpace[browserScopeKey] ?? null
  }, [browserScopeKey])

  const resolveWorkspaceContext = useCallback(() => {
    const resolvedCrawlspaceId = crawlspaceId || null
    const profile = resolvedCrawlspaceId ? tab.metadata?.profile : 'user-tab'
    const partition = resolvedCrawlspaceId ? tab.metadata?.partition : undefined
    const runId = tab.runId || tab.metadata?.runId
    return { crawlspaceId: resolvedCrawlspaceId, profile, partition, runId }
  }, [tab, crawlspaceId])

  const buildViewOptions = useCallback(
    (
      resolvedCrawlspaceId: string | null,
      profile: string | undefined,
      partition: string | undefined
    ): CrawlViewRuntimeOptions | null => {
      if (resolvedCrawlspaceId) {
        if (!profile || !partition) return null
        return {
          profile, partition,
          crawlspaceId: resolvedCrawlspaceId,
          kind: 'workspace-view',
          isPreview: Boolean(tab.metadata?.isPreview),
          allowMultiple
        }
      }
      return {
        profile: profile ?? 'user-tab',
        partition,
        kind: 'normal-view',
        isPreview: Boolean(tab.metadata?.isPreview),
        allowMultiple
      }
    },
    [allowMultiple, tab.metadata?.isPreview]
  )

  const updateLocation = useCallback((updates: LocationUpdates) => {
    if (!crawlspaceId) return

    const payload: CrawlspaceViewMetaUpdates = {}
    if ('url' in updates) payload.url = updates.url
    if ('title' in updates) payload.title = updates.title
    if ('themeColor' in updates) payload.themeColor = updates.themeColor ?? undefined
    if (Object.keys(payload).length === 0) return

    useCrawlTabStore.getState().setCrawlspaceViewMeta(crawlspaceId, tab.id, payload)
  }, [crawlspaceId, tab.id])

  return {
    crawlspaceId,
    spaceId,
    browserScopeKey,
    setDisplayKey,
    getActiveKeyNow,
    resolveWorkspaceContext,
    buildViewOptions,
    updateLocation,
  }
}

export type { CrawlViewRuntimeOptions }
