import React from 'react'
import { CrawlViewPortalHost } from '@components/crawl/portal/CrawlViewPortalHost'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { quoteBrowserSelectionToChat } from '@components/context-space/hooks/quoteBrowserSelectionToChat'
import {
  activateBrowserView,
  retryBrowserViewActivation,
  useBrowserViewActivationState,
} from '@/services/browserViewActivation'
import { BrowserViewRecoveryPanel } from './BrowserViewRecoveryPanel'

interface BrowserPaneRendererProps {
  crawlspaceId: string
  viewId: string
  isGroupActive?: boolean
  isPaneActive?: boolean
  onPaneInteraction?: () => void
}

export const BrowserPaneRenderer: React.FC<BrowserPaneRendererProps> = ({
  crawlspaceId,
  viewId,
  isGroupActive,
  isPaneActive = true,
  onPaneInteraction,
}) => {
  const activationState = useBrowserViewActivationState(crawlspaceId, viewId)
  const isDeferred = useCrawlTabStore(state =>
    state.crawlspaceDeferredViewIdsByCS[crawlspaceId]?.has(viewId) ?? false
  )

  React.useEffect(() => {
    if (!isGroupActive || !isPaneActive || !isDeferred || activationState.phase !== 'idle') return
    void activateBrowserView(crawlspaceId, viewId)
  }, [activationState.phase, crawlspaceId, isDeferred, isGroupActive, isPaneActive, viewId])

  React.useEffect(() => {
    const unsubscribe = window.tabtin?.contextMenu?.onAddToContextRequest?.(({ viewId: requestedViewId, selectionText }) => {
      if (requestedViewId !== viewId) return
      const trimmedSelection = selectionText.trim()
      if (!trimmedSelection) return

      const store = useCrawlTabStore.getState()
      const view = Object.values(store.crawlspaceContextCache)
        .flatMap(cache => cache.viewList)
        .find(candidate => candidate.viewId === viewId)
      const url = view?.url || ''
      if (!url || url === 'about:blank') return

      void quoteBrowserSelectionToChat({
        text: trimmedSelection,
        url,
        viewId,
        title: view?.title || url,
        favicon: view?.favicon,
        crawlspaceId: view?.crawlspaceId,
      })
    })

    return () => { unsubscribe?.() }
  }, [viewId])

  if (isDeferred || activationState.phase !== 'idle') {
    const visibleState = activationState.phase === 'idle'
      ? { phase: 'restoring' as const }
      : activationState
    return (
      <BrowserViewRecoveryPanel
        state={visibleState}
        onRetry={() => { void retryBrowserViewActivation(crawlspaceId, viewId) }}
        onInteraction={onPaneInteraction}
      />
    )
  }

  return (
    <CrawlViewPortalHost
      viewId={viewId}
      isActive={isGroupActive}
      priority={1}
      source="canvas"
      enabled={Boolean(isGroupActive)}
      className="h-full w-full overflow-hidden rounded-[12px]"
      data-canvas-view-id={viewId}
      onInteraction={onPaneInteraction}
    />
  )
}
