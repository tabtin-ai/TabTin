import { useCallback } from 'react'
import type { CrawlspaceHost } from '../types'

export interface UseCrawlViewActionsOptions {
  viewId?: string | null
  host?: CrawlspaceHost
}

export function useCrawlViewActions(options: UseCrawlViewActionsOptions = {}) {
  const { viewId, host } = options

  const navigate = useCallback(async (url: string) => {
    void viewId
    const target = url?.trim()
    if (!target) return
    // 当前宿主未提供“无 bounds 的导航”标准能力：推荐由业务层选择创建新 View 或通过 show() 导航
    console.warn('[useCrawlViewActions] navigate unavailable (host.navigate not implemented):', target)
  }, [viewId])

  const goBack = useCallback(async () => {
    if (!viewId) return
    await host?.navigation?.goBack?.(viewId)
  }, [host, viewId])

  const goForward = useCallback(async () => {
    if (!viewId) return
    await host?.navigation?.goForward?.(viewId)
  }, [host, viewId])

  const reload = useCallback(async (ignoreCache?: boolean) => {
    if (!viewId) return
    await host?.navigation?.reload?.(viewId, ignoreCache)
  }, [host, viewId])

  const stop = useCallback(async () => {
    if (!viewId) return
    await host?.navigation?.stop?.(viewId)
  }, [host, viewId])

  return { navigate, goBack, goForward, reload, stop }
}
