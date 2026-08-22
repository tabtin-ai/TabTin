import { useCallback, useEffect, useRef, useState } from 'react'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { autocompleteUrl, isValidUrl } from '@tabtin/crawlspace-core'
import { crawlspaceViewClient } from '@/crawlspace/electron/crawlspace-view-client'
import { crawlspaceContextClient } from '@/crawlspace/electron/crawlspace-context-client'
import { getCrawlspaceConfig } from '@/crawlspace/registry'

interface UseWorkspacePreviewOptions {
  crawlspaceId: string
  initialUrl?: string
  isActive?: boolean
}

interface UseWorkspacePreviewResult {
  previewTabId: string | null
  previewUrl: string
  setPreviewUrl: (url: string) => void
  ensurePreview: (url: string) => Promise<string | null>
  setPreview: (tabId: string, url: string) => void
  clearPreview: () => void
}

/**
 * 管理工作区的预览 Tab 状态（URL 输入后的即时预览）
 * - 持久化 previewTabId / previewUrl
 * - 激活时自动恢复预览
 */
export function useWorkspacePreview({
  crawlspaceId,
  initialUrl = '',
  isActive = true
}: UseWorkspacePreviewOptions): UseWorkspacePreviewResult {
  const saveCrawlspacePreviewState = useCrawlTabStore((s) => s.saveCrawlspacePreviewState)
  const getCrawlspacePreviewState = useCrawlTabStore((s) => s.getCrawlspacePreviewState)
  const crawlspaceState = getCrawlspacePreviewState(crawlspaceId)

  const [previewTabId, setPreviewTabId] = useState<string | null>(crawlspaceState?.previewTabId || null)
  const [previewUrl, setPreviewUrl] = useState<string>(crawlspaceState?.previewUrl || initialUrl || '')

  const isCreatingRef = useRef(false)
  const tabIdRef = useRef<string | null>(crawlspaceState?.previewTabId || null)

  // 持久化状态
  useEffect(() => {
    if (previewTabId || previewUrl) {
      saveCrawlspacePreviewState(crawlspaceId, {
        previewTabId,
        previewUrl,
        hasView: !!previewTabId,
        lastAccessAt: Date.now()
      })
    }
  }, [crawlspaceId, previewTabId, previewUrl, saveCrawlspacePreviewState])

  // 激活时尝试恢复预览
  useEffect(() => {
    if (!isActive) return
    const state = getCrawlspacePreviewState(crawlspaceId)
    if (state?.previewUrl && !state.hasView) {
      void ensurePreview(state.previewUrl)
    }
  }, [isActive]) // eslint-disable-line react-hooks/exhaustive-deps

  const ensurePreview = useCallback(async (url: string): Promise<string | null> => {
    if (!isActive) return null
    const normalized = autocompleteUrl(url)
    if (!isValidUrl(normalized)) return null

    if (isCreatingRef.current) return tabIdRef.current
    isCreatingRef.current = true
    try {
      if (previewUrl === normalized && previewTabId) {
        return previewTabId
      }

      const store = useCrawlTabStore.getState()
      const crawlspaceConfig = getCrawlspaceConfig(crawlspaceId) as
        | { profile?: string; partition?: string; spaceId?: string }
        | undefined
      if (!crawlspaceConfig?.profile || !crawlspaceConfig?.partition) {
        console.warn('[useWorkspacePreview] ⚠️ 缺少 crawlspace 配置，跳过创建预览 View')
        return null
      }

      const result = await crawlspaceViewClient.createView({
        crawlspaceId,
        url: normalized,
        title: new URL(normalized).hostname,
        isPreview: true,
        spaceId: crawlspaceConfig.spaceId,
        kind: 'workspace-view',
        profile: crawlspaceConfig.profile,
        partition: crawlspaceConfig.partition
      })

      if (!result?.success || !result.viewId) {
        console.warn('[useWorkspacePreview] ⚠️ 创建预览 View 失败:', result?.error)
        return null
      }

      const viewId = result.viewId
      void crawlspaceContextClient.setActiveView(crawlspaceId, viewId)
      store.setCrawlspaceViewMeta(crawlspaceId, viewId, { isPreview: true })

      setPreviewTabId(viewId)
      tabIdRef.current = viewId
      setPreviewUrl(normalized)
      return viewId
    } finally {
      isCreatingRef.current = false
    }
  }, [isActive, previewTabId, previewUrl, crawlspaceId])

  return {
    previewTabId,
    previewUrl,
    setPreviewUrl,
    ensurePreview,
    setPreview: (tabId: string, url: string) => {
      setPreviewTabId(tabId)
      tabIdRef.current = tabId
      setPreviewUrl(url)
      saveCrawlspacePreviewState(crawlspaceId, {
        previewTabId: tabId,
        previewUrl: url,
        hasView: true,
        lastAccessAt: Date.now()
      })
    },
    clearPreview: () => {
      const store = useCrawlTabStore.getState()
      setPreviewTabId(null)
      tabIdRef.current = null
      if (previewTabId) {
        store.setCrawlspaceViewMeta(crawlspaceId, previewTabId, { isPreview: false })
        void crawlspaceContextClient.updateViewMeta(crawlspaceId, previewTabId, { isPreview: false })
      }
      setPreviewUrl('')
      saveCrawlspacePreviewState(crawlspaceId, {
        previewTabId: null,
        previewUrl: '',
        hasView: false,
        lastAccessAt: Date.now()
      })
    }
  }
}
