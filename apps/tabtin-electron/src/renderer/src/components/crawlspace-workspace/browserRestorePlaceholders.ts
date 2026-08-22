import type { CrawlspaceViewSnapshot } from '@/crawlspace/electron/crawlspace-context-client'
import type { CrawlspaceViewInfo } from '@stores/useCrawlTabStore'

export type DeferredRestoreTarget = {
  viewId: string
  title?: string
  url?: string
  favicon?: string
  runId?: string
  isPreview?: boolean
  createdAt?: number
}

export interface ReconcileBrowserRestorePlaceholdersInput {
  deferredTargets: DeferredRestoreTarget[]
  latestMainViews: CrawlspaceViewSnapshot[] | null
  latestMainActiveViewId?: string | null
  currentCacheViews: CrawlspaceViewInfo[]
  currentCacheActiveViewId?: string | null
  resolvedActiveViewId?: string | null
  now: number
}

/**
 * 冷启动占位注入前的最后一道竞态收口。
 *
 * main 的最新快照是“真实页面是否存在”的权威来源：用户若在 restore loop 期间
 * 已经点开 B，就不能再把 B 标回 deferred，也不能用启动前选中的 A 覆盖 main
 * 当前 activeViewId。拉取失败时才退回 renderer cache。
 */
export function reconcileBrowserRestorePlaceholders(
  input: ReconcileBrowserRestorePlaceholdersInput,
) {
  const {
    deferredTargets,
    latestMainViews,
    latestMainActiveViewId,
    currentCacheViews,
    currentCacheActiveViewId,
    resolvedActiveViewId,
    now,
  } = input
  const liveViewIds = new Set((latestMainViews ?? []).map(view => view.viewId))
  const pendingDeferredTargets = deferredTargets.filter(
    target => !liveViewIds.has(target.viewId),
  )
  const pendingDeferredViewIds = new Set(
    pendingDeferredTargets.map(target => target.viewId),
  )
  const sourceViews = latestMainViews ?? currentCacheViews
  const existingViews = sourceViews
    .filter(view => !pendingDeferredViewIds.has(view.viewId))
    .map(view => ({
      viewId: view.viewId,
      title: view.title,
      url: view.url,
      favicon: view.favicon,
      runId: view.runId,
      isClosing: view.isClosing,
      isPreview: view.isPreview,
      createdAt: view.createdAt,
      updatedAt: now,
    }))
  const placeholderViews = pendingDeferredTargets.map(view => ({
    viewId: view.viewId,
    title: view.title || '',
    url: view.url,
    favicon: view.favicon,
    runId: view.runId,
    isClosing: false,
    isPreview: view.isPreview || false,
    createdAt: view.createdAt || now,
    updatedAt: now,
  }))

  return {
    activeViewId: latestMainViews !== null
      ? (latestMainActiveViewId ?? null)
      : (currentCacheActiveViewId ?? resolvedActiveViewId ?? null),
    pendingDeferredTargets,
    existingViews,
    placeholderViews,
    views: [...existingViews, ...placeholderViews],
  }
}
