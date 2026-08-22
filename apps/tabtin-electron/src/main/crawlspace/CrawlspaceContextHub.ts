import { EventEmitter } from 'events'
import type {
  CrawlspaceContextDiff,
  CrawlspaceContextDiffView,
  CrawlspaceContextSnapshot,
  CrawlspaceViewSnapshot,
  ResourceDetectionSummarySnapshot
} from './context-types'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { createLogger } from '../logger'
import { syncCrawlspaceViewInUseState } from './sync-view-in-use'

const log = createLogger('CrawlspaceContextHub')

export type {
  CrawlspaceContextDiff,
  CrawlspaceContextDiffView,
  CrawlspaceContextSnapshot,
  CrawlspaceViewSnapshot,
  ResourceDetectionSummarySnapshot
} from './context-types'

type ViewState = Omit<CrawlspaceViewSnapshot, 'isActive'> & {
  isActive: boolean
}

type CrawlspaceState = {
  crawlspaceId: string
  activeViewId?: string | null
  pendingActiveViewId?: string | null
  pendingActiveAt?: number
  views: Map<string, ViewState>
  updatedAt: number
}

function buildDiffFields(view: CrawlspaceViewSnapshot): CrawlspaceContextDiffView['fields'] {
  const fields: CrawlspaceContextDiffView['fields'] = {
    isActive: view.isActive,
    updatedAt: view.updatedAt,
  }

  if (view.title !== undefined) fields.title = view.title
  if (view.url !== undefined) fields.url = view.url
  if (view.favicon !== undefined) fields.favicon = view.favicon
  if (view.runId !== undefined) fields.runId = view.runId
  if (view.themeColor !== undefined) fields.themeColor = view.themeColor
  if (view.isLoading !== undefined) fields.isLoading = view.isLoading
  if (view.isClosing !== undefined) fields.isClosing = view.isClosing
  if (view.isPreview !== undefined) fields.isPreview = view.isPreview
  if (view.hasError !== undefined) fields.hasError = view.hasError
  if (view.errorDescription !== undefined) fields.errorDescription = view.errorDescription
  if (view.createdAt !== undefined) fields.createdAt = view.createdAt
  if (view.resourceSummary !== undefined) fields.resourceSummary = view.resourceSummary

  return fields
}

export class CrawlspaceContextHub extends EventEmitter {
  private static instance: CrawlspaceContextHub | null = null
  private crawlspaces = new Map<string, CrawlspaceState>()
  private lastSnapshots = new Map<string, CrawlspaceContextSnapshot>()
  private recentlyUnregisteredViews = new Map<string, Map<string, number>>()
  private readonly recentlyUnregisteredTtlMs = 15_000
  private readonly pendingActiveTimeoutMs = 30_000
  private pendingActiveTimers = new Map<string, NodeJS.Timeout>()

  public static getInstance(): CrawlspaceContextHub {
    if (!CrawlspaceContextHub.instance) {
      CrawlspaceContextHub.instance = new CrawlspaceContextHub()
    }
    return CrawlspaceContextHub.instance
  }

  private constructor() {
    super()
  }

  private ensureCrawlspace(crawlspaceId: string): CrawlspaceState {
    const existing = this.crawlspaces.get(crawlspaceId)
    if (existing) return existing
    const next: CrawlspaceState = {
      crawlspaceId,
      activeViewId: null,
      pendingActiveViewId: null,
      views: new Map(),
      updatedAt: Date.now()
    }
    this.crawlspaces.set(crawlspaceId, next)
    return next
  }

  private touch(crawlspaceId: string): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    state.updatedAt = Date.now()
    this.emitChange(crawlspaceId)
  }

  private getOrCreateRecentlyUnregisteredMap(crawlspaceId: string): Map<string, number> {
    const existing = this.recentlyUnregisteredViews.get(crawlspaceId)
    if (existing) return existing
    const next = new Map<string, number>()
    this.recentlyUnregisteredViews.set(crawlspaceId, next)
    return next
  }

  private pruneRecentlyUnregistered(crawlspaceId: string): void {
    const map = this.recentlyUnregisteredViews.get(crawlspaceId)
    if (!map || map.size === 0) return
    const now = Date.now()
    for (const [viewId, ts] of map.entries()) {
      if (now - ts > this.recentlyUnregisteredTtlMs) {
        map.delete(viewId)
      }
    }
    if (map.size === 0) {
      this.recentlyUnregisteredViews.delete(crawlspaceId)
    }
  }

  private markRecentlyUnregistered(crawlspaceId: string, viewId: string): void {
    const map = this.getOrCreateRecentlyUnregisteredMap(crawlspaceId)
    map.set(viewId, Date.now())
    this.pruneRecentlyUnregistered(crawlspaceId)
  }

  private clearRecentlyUnregistered(crawlspaceId: string, viewId: string): void {
    const map = this.recentlyUnregisteredViews.get(crawlspaceId)
    if (!map) return
    map.delete(viewId)
    if (map.size === 0) {
      this.recentlyUnregisteredViews.delete(crawlspaceId)
    }
  }

  private clearPendingActiveTimer(crawlspaceId: string): void {
    const existing = this.pendingActiveTimers.get(crawlspaceId)
    if (existing) {
      clearTimeout(existing)
      this.pendingActiveTimers.delete(crawlspaceId)
    }
  }

  private isRecentlyUnregistered(crawlspaceId: string, viewId: string): boolean {
    this.pruneRecentlyUnregistered(crawlspaceId)
    return this.recentlyUnregisteredViews.get(crawlspaceId)?.has(viewId) ?? false
  }

  public registerView(
    crawlspaceId: string,
    viewId: string,
    meta: {
      title?: string
      url?: string
      favicon?: string
      createdAt?: number
      runId?: string
      isPreview?: boolean
      themeColor?: string
    }
  ): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    this.clearRecentlyUnregistered(crawlspaceId, viewId)
    const existing = state.views.get(viewId)
    const now = Date.now()
    const next: ViewState = {
      viewId,
      title: meta.title ?? existing?.title,
      url: meta.url ?? existing?.url,
      favicon: meta.favicon ?? existing?.favicon,
      runId: meta.runId ?? existing?.runId,
      themeColor: meta.themeColor ?? existing?.themeColor,
      isActive: existing?.isActive ?? false,
      isClosing: existing?.isClosing ?? false,
      isPreview: meta.isPreview ?? existing?.isPreview ?? false,
      isLoading: existing?.isLoading,
      createdAt: meta.createdAt ?? existing?.createdAt,
      updatedAt: now
    }
    state.views.set(viewId, next)

    if (state.pendingActiveViewId === viewId) {
      this.clearPendingActiveTimer(crawlspaceId)
      state.pendingActiveViewId = null
      state.pendingActiveAt = undefined
      state.activeViewId = viewId
      for (const [id, view] of state.views.entries()) {
        const isActive = id === viewId
        if (view.isActive !== isActive) {
          state.views.set(id, { ...view, isActive, updatedAt: now })
        }
      }
    }

    state.updatedAt = now
    this.emitChange(crawlspaceId)
  }

  public updateViewMeta(
    crawlspaceId: string,
    viewId: string,
    meta: {
      title?: string
      url?: string
      favicon?: string | null
      runId?: string
      isPreview?: boolean
      themeColor?: string | null
    }
  ): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    const existing = state.views.get(viewId)
    if (!existing) {
      // CE-29: 原代码在 isRecentlyUnregistered 分支和默认分支均无条件 return，内层 if 死代码，已移除
      return
    }
    if (existing.isClosing) {
      return
    }
    const nextTitle = meta.title ?? existing.title
    const nextUrl = meta.url ?? existing.url
    const nextFavicon =
      meta.favicon === null
        ? undefined
        : (meta.favicon ?? existing.favicon)
    const nextRunId = meta.runId ?? existing.runId
    const nextThemeColor =
      meta.themeColor === null
        ? undefined
        : (meta.themeColor ?? existing.themeColor)
    const nextIsPreview = meta.isPreview ?? existing.isPreview ?? false
    if (
      nextTitle === existing.title &&
      nextUrl === existing.url &&
      nextFavicon === existing.favicon &&
      nextRunId === existing.runId &&
      nextThemeColor === existing.themeColor &&
      nextIsPreview === (existing.isPreview ?? false)
    ) {
      return
    }
    const now = Date.now()
    state.views.set(viewId, {
      ...existing,
      title: nextTitle,
      url: nextUrl,
      favicon: nextFavicon,
      runId: nextRunId,
      themeColor: nextThemeColor,
      isClosing: existing.isClosing ?? false,
      isPreview: nextIsPreview,
      updatedAt: now
    })
    state.updatedAt = now
    this.emitChange(crawlspaceId)
  }

  public setViewLoading(crawlspaceId: string, viewId: string, isLoading: boolean): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    const existing = state.views.get(viewId)
    if (!existing) {
      // CE-29: 同 updateViewMeta，移除内层死代码 if 分支
      return
    }
    if (existing.isClosing) {
      return
    }
    const nextHasError = isLoading ? false : existing.hasError
    const nextErrorDescription = isLoading ? undefined : existing.errorDescription
    if (
      existing.isLoading === isLoading &&
      existing.hasError === nextHasError &&
      existing.errorDescription === nextErrorDescription
    ) {
      return
    }
    const now = Date.now()
    state.views.set(viewId, {
      ...existing,
      isLoading,
      // 🔧 开始加载时清除错误状态
      ...(isLoading ? { hasError: false, errorDescription: undefined } : {}),
      isClosing: existing.isClosing ?? false,
      isPreview: existing.isPreview ?? false,
      updatedAt: now
    })
    state.updatedAt = now
    this.emitChange(crawlspaceId)
  }

  /**
   * 设置或清除 view 的错误状态
   * 在 did-fail-load 事件触发时由 ViewFactory 调用
   */
  public setViewError(
    crawlspaceId: string,
    viewId: string,
    error: { errorDescription: string } | null
  ): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    const existing = state.views.get(viewId)
    if (!existing) return
    if (existing.isClosing) return
    const nextHasError = error !== null
    const nextErrorDescription = error?.errorDescription
    if (
      existing.hasError === nextHasError &&
      existing.errorDescription === nextErrorDescription &&
      existing.isLoading === false
    ) {
      return
    }
    const now = Date.now()
    state.views.set(viewId, {
      ...existing,
      hasError: nextHasError,
      errorDescription: nextErrorDescription,
      isLoading: false,
      updatedAt: now
    })
    state.updatedAt = now
    this.emitChange(crawlspaceId)
  }

  /**
   * 更新 view 的资源检测统计摘要
   * 由 ResourceDetectionService 调用（debounced）
   */
  public updateViewResourceSummary(
    crawlspaceId: string,
    viewId: string,
    summary: ResourceDetectionSummarySnapshot
  ): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    const existing = state.views.get(viewId)
    if (!existing) return
    // CR-016: 与 updateViewMeta / setViewLoading 保持一致，关闭中的 View 不再更新
    if (existing.isClosing) return
    const now = Date.now()
    state.views.set(viewId, {
      ...existing,
      resourceSummary: summary,
      updatedAt: now
    })
    state.updatedAt = now
    this.emitChange(crawlspaceId)
  }

  public setActiveView(crawlspaceId: string, viewId: string | null): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    if (viewId && !state.views.has(viewId)) {
      log.warn('setActiveView 目标不存在，忽略:', {
        crawlspaceId,
        viewId
      })
      state.pendingActiveViewId = viewId
      state.pendingActiveAt = Date.now()

      // B-05 修复：30s 超时自动清除 pending 状态，防止永久挂起
      this.clearPendingActiveTimer(crawlspaceId)
      const timer = setTimeout(() => {
        this.pendingActiveTimers.delete(crawlspaceId)
        if (state.pendingActiveViewId === viewId) {
          log.warn('pendingActiveViewId 超时清除:', {
            crawlspaceId,
            viewId
          })
          state.pendingActiveViewId = null
          state.pendingActiveAt = undefined
        }
      }, this.pendingActiveTimeoutMs)
      this.pendingActiveTimers.set(crawlspaceId, timer)
      return
    }
    this.clearPendingActiveTimer(crawlspaceId)
    state.pendingActiveViewId = null
    state.pendingActiveAt = undefined
    state.activeViewId = viewId
    const now = Date.now()
    for (const [id, view] of state.views.entries()) {
      const isActive = viewId ? id === viewId : false
      if (view.isActive !== isActive) {
        state.views.set(id, { ...view, isActive, updatedAt: now })
      }
    }
    state.updatedAt = now
    this.emitChange(crawlspaceId)
    // 预览/脱屏且未激活 → inUse=false，与性能监控回收边界一致
    try {
      syncCrawlspaceViewInUseState(crawlspaceId)
    } catch (error) {
      log.debug('setActiveView 后同步 inUse 失败（可忽略）:', error)
    }
  }

  public markViewClosing(crawlspaceId: string, viewId: string): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    const existing = state.views.get(viewId)
    if (!existing) {
      return
    }
    if (existing.isClosing) {
      return
    }
    const now = Date.now()
    state.views.set(viewId, {
      ...existing,
      isClosing: true,
      updatedAt: now
    })
    state.updatedAt = now
    this.emitChange(crawlspaceId)
  }

  public clearViewClosing(crawlspaceId: string, viewId: string): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    const existing = state.views.get(viewId)
    if (!existing || !existing.isClosing) {
      return
    }
    const now = Date.now()
    state.views.set(viewId, {
      ...existing,
      isClosing: false,
      updatedAt: now
    })
    state.updatedAt = now
    this.emitChange(crawlspaceId)
  }

  public unregisterView(crawlspaceId: string, viewId: string): void {
    const state = this.ensureCrawlspace(crawlspaceId)
    state.views.delete(viewId)
    this.markRecentlyUnregistered(crawlspaceId, viewId)
    if (state.pendingActiveViewId === viewId) {
      state.pendingActiveViewId = null
      state.pendingActiveAt = undefined
    }
    if (state.activeViewId === viewId) {
      const remaining = Array.from(state.views.values())
      const now = Date.now()
      if (remaining.length > 0) {
        remaining.sort((a, b) => b.updatedAt - a.updatedAt)
        const newActiveId = remaining[0]?.viewId ?? null
        state.activeViewId = newActiveId
        // B-01 修复：切换 active view 后同步更新所有 view 的 isActive 字段
        for (const [id, view] of state.views.entries()) {
          const isActive = newActiveId ? id === newActiveId : false
          if (view.isActive !== isActive) {
            state.views.set(id, { ...view, isActive, updatedAt: now })
          }
        }
      } else {
        state.activeViewId = null
      }
    }
    this.touch(crawlspaceId)

    // B-04 修复：views 为空时清理 lastSnapshots 条目，防止内存泄漏
    if (state.views.size === 0) {
      this.lastSnapshots.delete(crawlspaceId)
    } else {
      try {
        syncCrawlspaceViewInUseState(crawlspaceId)
      } catch (error) {
        log.debug('unregisterView 后同步 inUse 失败（可忽略）:', error)
      }
    }
  }

  /**
   * 完全移除一个 crawlspace 的所有状态（包括 lastSnapshots、recentlyUnregistered）
   * 当 crawlspace 关闭时由外部调用
   */
  public removeContext(crawlspaceId: string): void {
    this.clearPendingActiveTimer(crawlspaceId)

    // VL-004 修复：联动 WTM 清理 Tab 级别的映射，防止僵尸条目
    try {
      getOrganizationTabManager().clearTab(crawlspaceId)
    } catch (error) {
      log.error('removeContext: WTM clearTab 失败:', { crawlspaceId, error })
    }

    this.crawlspaces.delete(crawlspaceId)
    this.lastSnapshots.delete(crawlspaceId)
    this.recentlyUnregisteredViews.delete(crawlspaceId)
  }

  public getSnapshot(crawlspaceId: string): CrawlspaceContextSnapshot {
    const state = this.ensureCrawlspace(crawlspaceId)
    const views = Array.from(state.views.values()).map(view => ({
      ...view
    }))
    return {
      crawlspaceId,
      activeViewId: state.activeViewId ?? null,
      viewCount: views.length,
      views,
      updatedAt: state.updatedAt
    }
  }

  public getAllSnapshots(): CrawlspaceContextSnapshot[] {
    return Array.from(this.crawlspaces.keys()).map(id => this.getSnapshot(id))
  }

  private emitChange(crawlspaceId: string): void {
    const snapshot = this.getSnapshot(crawlspaceId)
    const diff = this.computeDiff(snapshot)
    if (diff) {
      this.emitSafely('context-diff', diff)
    } else {
      this.emitSafely('changed', snapshot)
    }
  }

  private emitSafely(eventName: 'changed' | 'context-diff', payload: CrawlspaceContextSnapshot | CrawlspaceContextDiff): void {
    const listeners = this.rawListeners(eventName)
    for (const listener of listeners) {
      try {
        ;(listener as (data: CrawlspaceContextSnapshot | CrawlspaceContextDiff) => void)(payload)
      } catch (error) {
        log.error('listener execution failed:', { eventName, error })
      }
    }
  }

  private computeDiff(snapshot: CrawlspaceContextSnapshot): CrawlspaceContextDiff | null {
    const previous = this.lastSnapshots.get(snapshot.crawlspaceId)
    this.lastSnapshots.set(snapshot.crawlspaceId, snapshot)
    if (!previous) {
      return {
        crawlspaceId: snapshot.crawlspaceId,
        updatedAt: snapshot.updatedAt,
        activeViewId: snapshot.activeViewId ?? null,
        viewCount: snapshot.viewCount,
        views: snapshot.views.map(view => ({
          viewId: view.viewId,
          fields: buildDiffFields(view)
        }))
      }
    }

    const changedViews: CrawlspaceContextDiffView[] = []
    const prevViewMap = new Map(previous.views.map(view => [view.viewId, view]))

    for (const view of snapshot.views) {
      const prev = prevViewMap.get(view.viewId)
      if (!prev) {
        changedViews.push({
          viewId: view.viewId,
          fields: buildDiffFields(view)
        })
        continue
      }

      const fields: CrawlspaceContextDiffView['fields'] = {}
      if (view.title !== prev.title) fields.title = view.title
      if (view.url !== prev.url) fields.url = view.url
      if (view.favicon !== prev.favicon) fields.favicon = view.favicon
      if (view.runId !== prev.runId) fields.runId = view.runId
      if (view.themeColor !== prev.themeColor) fields.themeColor = view.themeColor
      if (view.isLoading !== prev.isLoading) fields.isLoading = view.isLoading
      if (view.isActive !== prev.isActive) fields.isActive = view.isActive
      if (view.isClosing !== prev.isClosing) fields.isClosing = view.isClosing
      if (view.isPreview !== prev.isPreview) fields.isPreview = view.isPreview
      if (view.hasError !== prev.hasError) fields.hasError = view.hasError
      if (view.errorDescription !== prev.errorDescription) fields.errorDescription = view.errorDescription
      if (view.createdAt !== prev.createdAt) fields.createdAt = view.createdAt
      if (view.updatedAt !== prev.updatedAt) fields.updatedAt = view.updatedAt
      const prevSummary = JSON.stringify(prev.resourceSummary || null)
      const curSummary = JSON.stringify(view.resourceSummary || null)
      if (curSummary !== prevSummary) fields.resourceSummary = view.resourceSummary

      if (Object.keys(fields).length > 0) {
        changedViews.push({ viewId: view.viewId, fields })
      }
    }

    const removedViews = previous.views
      .filter(prevView => !snapshot.views.some(view => view.viewId === prevView.viewId))
      .map(view => view.viewId)

    const hasCrawlspaceChange =
      snapshot.activeViewId !== previous.activeViewId ||
      snapshot.viewCount !== previous.viewCount ||
      snapshot.updatedAt !== previous.updatedAt

    if (!hasCrawlspaceChange && changedViews.length === 0 && removedViews.length === 0) {
      return null
    }

    return {
      crawlspaceId: snapshot.crawlspaceId,
      updatedAt: snapshot.updatedAt,
      activeViewId: snapshot.activeViewId ?? null,
      viewCount: snapshot.viewCount,
      views: changedViews,
      removedViews
    }
  }
}

export function getCrawlspaceContextHub(): CrawlspaceContextHub {
  return CrawlspaceContextHub.getInstance()
}
