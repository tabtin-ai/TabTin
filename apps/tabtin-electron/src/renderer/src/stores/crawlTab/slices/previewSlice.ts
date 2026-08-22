/**
 * Preview state slice — save/get/clear crawlspace preview states.
 *
 * Manages the per-workspace preview metadata (previewTabId, previewUrl, etc.).
 * Completely independent from core tab/view management.
 */

import type { CrawlspacePreviewState } from '../types'

// ---------------------------------------------------------------------------
// Store shape
// ---------------------------------------------------------------------------

export interface PreviewStore {
  crawlspacePreviewStates: Record<string, CrawlspacePreviewState>
}

type GetFn = () => PreviewStore
type SetFn = (
  partial:
    | Partial<PreviewStore>
    | ((state: PreviewStore) => Partial<PreviewStore>),
) => void

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPreviewActions(get: GetFn, set: SetFn) {
  return {
    saveCrawlspacePreviewState: (crawlspaceId: string, state: Partial<CrawlspacePreviewState>) => {
      set((prev) => ({
        crawlspacePreviewStates: {
          ...prev.crawlspacePreviewStates,
          [crawlspaceId]: {
            previewTabId: state.previewTabId !== undefined
              ? state.previewTabId
              : (prev.crawlspacePreviewStates[crawlspaceId]?.previewTabId ?? null),
            previewUrl: state.previewUrl ?? prev.crawlspacePreviewStates[crawlspaceId]?.previewUrl ?? '',
            hasView: state.hasView ?? prev.crawlspacePreviewStates[crawlspaceId]?.hasView ?? false,
            lastAccessAt: Date.now(),
          },
        },
      }))
      console.log('[CrawlTabStore] Workspace preview state saved:', { crawlspaceId, state })
    },

    getCrawlspacePreviewState: (crawlspaceId: string): CrawlspacePreviewState | null => {
      return get().crawlspacePreviewStates[crawlspaceId] || null
    },

    clearCrawlspacePreviewState: (crawlspaceId: string) => {
      set((prev) => {
        const { [crawlspaceId]: _, ...rest } = prev.crawlspacePreviewStates
        return { crawlspacePreviewStates: rest }
      })
      console.log('[CrawlTabStore] Workspace preview state cleared:', crawlspaceId)
    },

    clearAllCrawlspacePreviewStates: () => {
      set({ crawlspacePreviewStates: {} })
      console.log('[CrawlTabStore] All workspace preview states cleared')
    },
  }
}
