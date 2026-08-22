import type { RendererCrawlspaceViewMetaUpdates } from '@shared/types/crawlspace'
import { withTimeout, DEFAULT_IPC_TIMEOUT } from '../utils/withTimeout'
import { createLogger } from '@/utils/logger'

const log = createLogger('CrawlspaceContext')

export interface CrawlspaceViewSnapshot {
  viewId: string
  title?: string
  url?: string
  favicon?: string
  runId?: string
  themeColor?: string
  isActive: boolean
  isClosing?: boolean
  isLoading?: boolean
  isPreview?: boolean
  /** 页面加载是否失败 */
  hasError?: boolean
  /** 错误描述（用于 UI 展示） */
  errorDescription?: string
  /** 检测到的资源摘要 */
  resourceSummary?: {
    total: number
    byCategory: Partial<Record<string, number>>
    byCaptureStatus?: Partial<Record<string, number>>
  }
  createdAt?: number
  updatedAt: number
}

export interface CrawlspaceContextSnapshot {
  crawlspaceId: string
  activeViewId?: string | null
  viewCount: number
  views: CrawlspaceViewSnapshot[]
  updatedAt: number
}

export type CrawlspaceContextError = {
  crawlspaceId: string | null
  error: Error
}

/** RP-006: diff payload mirroring CrawlspaceContextDiff from main process */
interface CrawlspaceContextDiff {
  crawlspaceId: string
  updatedAt: number
  activeViewId: string | null
  viewCount: number
  views: Array<{ viewId: string; fields: Partial<CrawlspaceViewSnapshot> }>
  removedViews?: string[]
}

type ContextListener = (snapshot: CrawlspaceContextSnapshot) => void
type ErrorListener = (error: CrawlspaceContextError) => void

class CrawlspaceContextClient {
  private listeners = new Map<string, Set<ContextListener>>()
  private errorListeners = new Set<ErrorListener>()
  private isSubscribed = false
  private boundHandler: ((event: any, snapshot: CrawlspaceContextSnapshot) => void) | null = null
  /** RP-006: diff handler for incremental IPC push */
  private boundDiffHandler: ((event: any, diff: CrawlspaceContextDiff) => void) | null = null
  private unsubHandler: (() => void) | null = null
  private unsubDiffHandler: (() => void) | null = null
  /** RP-006: local snapshot cache for diff merging */
  private snapshotCache = new Map<string, CrawlspaceContextSnapshot>()

  private getIpc(): any | null {
    if (typeof window === 'undefined') return null
    return window.electron?.ipcRenderer || null
  }

  private dispatchSnapshot(snapshot: CrawlspaceContextSnapshot): void {
    const crawlspaceId = snapshot?.crawlspaceId
    if (!crawlspaceId) return
    const cached = this.snapshotCache.get(crawlspaceId)
    if (cached && cached.updatedAt === snapshot.updatedAt) return
    this.snapshotCache.set(crawlspaceId, snapshot)
    const direct = this.listeners.get(crawlspaceId)
    direct?.forEach(listener => listener(snapshot))
    const wildcard = this.listeners.get('*')
    wildcard?.forEach(listener => listener(snapshot))
  }

  private ensureSubscribed(): void {
    if (this.isSubscribed) return
    const ipc = this.getIpc()
    if (!ipc) return

    if (!this.boundHandler) {
      this.boundHandler = (_event: any, snapshot: CrawlspaceContextSnapshot) => {
        this.dispatchSnapshot(snapshot)
      }
    }

    if (!this.boundDiffHandler) {
      this.boundDiffHandler = (_event: any, diff: CrawlspaceContextDiff) => {
        const cached = this.snapshotCache.get(diff.crawlspaceId)
        if (!cached) {
          this.getContext(diff.crawlspaceId)
            .then(snap => { if (snap && !Array.isArray(snap)) this.dispatchSnapshot(snap) })
            .catch(e => { log.warn('diff full-snapshot fallback fetch failed:', { crawlspaceId: diff.crawlspaceId, error: e }) })
          return
        }
        const merged = this.mergeDiff(cached, diff)
        this.dispatchSnapshot(merged)
      }
    }

    this.unsubHandler = ipc.on('crawlspace:context-changed', this.boundHandler) ?? null
    this.unsubDiffHandler = ipc.on('crawlspace:context-diff', this.boundDiffHandler) ?? null
    ipc.send('crawlspace:subscribe', null)
    this.isSubscribed = true
  }

  private maybeTeardown(): void {
    if (this.listeners.size > 0) return
    const ipc = this.getIpc()
    if (!ipc) return
    this.unsubHandler?.()
    this.unsubHandler = null
    this.unsubDiffHandler?.()
    this.unsubDiffHandler = null
    ipc.send('crawlspace:unsubscribe')
    this.isSubscribed = false
    this.snapshotCache.clear()
  }

  /** RP-006: merge incremental diff into cached snapshot */
  private mergeDiff(cached: CrawlspaceContextSnapshot, diff: CrawlspaceContextDiff): CrawlspaceContextSnapshot {
    const viewMap = new Map(cached.views.map(v => [v.viewId, v]))

    if (diff.removedViews) {
      for (const vid of diff.removedViews) viewMap.delete(vid)
    }

    for (const dv of diff.views) {
      const existing = viewMap.get(dv.viewId)
      if (existing) {
        viewMap.set(dv.viewId, { ...existing, ...dv.fields })
      } else {
        viewMap.set(dv.viewId, { viewId: dv.viewId, isActive: false, updatedAt: diff.updatedAt, ...dv.fields })
      }
    }

    return {
      crawlspaceId: diff.crawlspaceId,
      activeViewId: diff.activeViewId,
      viewCount: diff.viewCount,
      views: Array.from(viewMap.values()),
      updatedAt: diff.updatedAt
    }
  }

  async getContext(crawlspaceId?: string | null): Promise<CrawlspaceContextSnapshot | CrawlspaceContextSnapshot[] | null> {
    const ipc = this.getIpc()
    if (!ipc) return null
    return withTimeout(ipc.invoke('crawlspace:getContext', crawlspaceId ?? null), DEFAULT_IPC_TIMEOUT, 'crawlspace:getContext')
  }

  async setActiveView(
    crawlspaceId: string,
    viewId?: string | null
  ): Promise<{ success: boolean; error?: string }> {
    const ipc = this.getIpc()
    if (!ipc) return { success: false, error: 'ipcRenderer not available' }
    return withTimeout(ipc.invoke('crawlspace:setActiveView', crawlspaceId, viewId ?? null), DEFAULT_IPC_TIMEOUT, 'crawlspace:setActiveView')
  }

  async updateViewMeta(
    crawlspaceId: string,
    viewId: string,
    updates: RendererCrawlspaceViewMetaUpdates
  ): Promise<{ success: boolean; error?: string }> {
    const ipc = this.getIpc()
    if (!ipc) return { success: false, error: 'ipcRenderer not available' }
    return withTimeout(ipc.invoke('crawlspace:updateViewMeta', crawlspaceId, viewId, updates), DEFAULT_IPC_TIMEOUT, 'crawlspace:updateViewMeta')
  }

  async closeView(
    crawlspaceId: string,
    viewId: string,
    reason?: string
  ): Promise<{ success: boolean; code?: string; error?: string }> {
    const ipc = this.getIpc()
    if (!ipc) return { success: false, error: 'ipcRenderer not available' }
    return withTimeout(ipc.invoke('crawlspace:closeView', { crawlspaceId, viewId, reason }), DEFAULT_IPC_TIMEOUT, 'crawlspace:closeView')
  }

  /**
   * 重新加载指定视图（用于加载失败后重试）
   */
  async reloadView(
    crawlspaceId: string,
    viewId: string
  ): Promise<{ success: boolean; error?: string }> {
    const ipc = this.getIpc()
    if (!ipc) return { success: false, error: 'ipcRenderer not available' }
    return withTimeout(ipc.invoke('crawlspace:reloadView', { crawlspaceId, viewId }), DEFAULT_IPC_TIMEOUT, 'crawlspace:reloadView')
  }

  private emitError(error: CrawlspaceContextError): void {
    this.errorListeners.forEach(listener => {
      try { listener(error) } catch { /* 防止 listener 异常扩散 */ }
    })
  }

  onError(listener: ErrorListener): () => void {
    this.errorListeners.add(listener)
    return () => { this.errorListeners.delete(listener) }
  }

  /**
   * 订阅 crawlspace context 变更。
   *
   * 返回 unsubscribe 句柄；若 IPC 不可用（preload 未注入 / 非 Electron 环境），
   * 返回 `null` 让调用方显式感知"订阅未成立"——避免 silent noop 让上层缓存假
   * 订阅记录、IPC 恢复后再次订阅被永久短路。
   */
  subscribe(crawlspaceId: string | null | undefined, listener: ContextListener): (() => void) | null {
    const key = crawlspaceId ?? '*'
    const ipc = this.getIpc()
    if (!ipc) {
      return null
    }

    const existing = this.listeners.get(key)
    if (existing) {
      existing.add(listener)
    } else {
      this.listeners.set(key, new Set([listener]))
    }

    this.ensureSubscribed()

    // 🆕 主动拉取当前快照，避免订阅切换导致错过初始数据
    if (crawlspaceId) {
      this.getContext(crawlspaceId)
        .then(snapshot => {
          if (snapshot && !Array.isArray(snapshot)) {
            listener(snapshot)
          }
        })
        .catch(e => {
          log.warn('getContext snapshot failed:', { crawlspaceId, error: e })
          this.emitError({ crawlspaceId, error: e instanceof Error ? e : new Error(String(e)) })
        })
    } else {
      this.getContext(null)
        .then(snapshot => {
          if (Array.isArray(snapshot)) {
            snapshot.forEach(item => listener(item))
          }
        })
        .catch(e => {
          log.warn('getContext all snapshot failed:', { error: e })
          this.emitError({ crawlspaceId: null, error: e instanceof Error ? e : new Error(String(e)) })
        })
    }

    return () => {
      const set = this.listeners.get(key)
      if (set) {
        set.delete(listener)
        if (set.size === 0) {
          this.listeners.delete(key)
        }
      }
      this.maybeTeardown()
    }
  }
}

export const crawlspaceContextClient = new CrawlspaceContextClient()
