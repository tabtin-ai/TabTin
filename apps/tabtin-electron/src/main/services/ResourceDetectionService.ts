/**
 * 资源检测服务
 *
 * Browser Runtime 的核心感知能力之一 —— 被动监控 WebContentsView 的网络请求，
 * 识别并分类媒体/静态资源（视频、M3U8/HLS、音频、图片、字体、文档等）。
 *
 * 设计原则：
 * - 机制而非策略：只分类和存储，不决定如何处理
 * - 被动无侵入：使用 webRequest API，不注入页面脚本、不启动 CDP
 * - 只存 metadata：不捕获 response body，避免内存压力
 * - per-view 隔离：每个视图独立的资源列表，导航时自动清空
 * - per-session listener：crawlspace 视图使用分区 session，需要独立挂载 listener
 *
 * @author TabTin Team
 */

import { EventEmitter } from 'events'
import { session, webContents as wcModule, type WebContents } from 'electron'
import { createHash } from 'crypto'

import type {
  ResourceCategory,
  DetectedResource,
  ResourceDetectionSummary,
  MediaElementInfo,
  StreamInfo
} from '@tabtin/action-tools/types'
import { getResourceHubService } from './ResourceHubService'
import { createLogger } from '../logger'

const log = createLogger('ResourceDetection')

// ========== 内部类型 ==========

interface ClassificationRule {
  category: ResourceCategory
  urlPatterns: RegExp[]
  mimeTypes: (string | RegExp)[]
}

interface ViewResourceStore {
  viewId: string
  resources: Map<string, DetectedResource> // keyed by URL
  pageUrl: string
  maxCount: number
  webContentsId: number
  sessionPartition: string | undefined
  listeners: {
    didNavigate?: (...args: any[]) => void
    didNavigateInPage?: (...args: any[]) => void
    destroyed?: () => void
  }
}

export interface ResourceDetectionFilter {
  category?: ResourceCategory
  limit?: number
}

type ExternalDetectedResourceInput = Omit<
  DetectedResource,
  'id' | 'resourceId' | 'timestamp' | 'viewId' | 'pageUrl' | 'captureStatus' | 'capabilities'
> & Partial<Pick<DetectedResource, 'pageUrl' | 'captureStatus' | 'capabilities'>>

// ========== 分类规则 ==========

const CLASSIFICATION_RULES: ClassificationRule[] = [
  // 优先级 1: HLS
  {
    category: 'hls',
    urlPatterns: [/\.m3u8(\?|#|$)/i],
    mimeTypes: [
      'application/vnd.apple.mpegurl',
      'application/x-mpegurl',
      'audio/mpegurl',
      'audio/x-mpegurl'
    ]
  },
  // 优先级 2: DASH
  {
    category: 'dash',
    urlPatterns: [/\.mpd(\?|#|$)/i],
    mimeTypes: ['application/dash+xml']
  },
  // 优先级 3: Video
  {
    category: 'video',
    urlPatterns: [/\.(mp4|webm|flv|mov|avi|mkv|wmv|m4v|3gp|ts)(\?|#|$)/i],
    mimeTypes: [/^video\//]
  },
  // 优先级 4: Audio
  {
    category: 'audio',
    urlPatterns: [/\.(mp3|aac|ogg|wav|flac|m4a|wma|opus)(\?|#|$)/i],
    mimeTypes: [/^audio\//]
  },
  // 优先级 5: Image
  {
    category: 'image',
    urlPatterns: [/\.(jpg|jpeg|png|gif|webp|svg|bmp|ico|avif|tiff)(\?|#|$)/i],
    mimeTypes: [/^image\//]
  },
  // 优先级 6: Font
  {
    category: 'font',
    urlPatterns: [/\.(woff2?|ttf|otf|eot)(\?|#|$)/i],
    mimeTypes: [/^font\//, 'application/font-woff', 'application/font-woff2']
  },
  // 优先级 7: Document
  {
    category: 'document',
    urlPatterns: [/\.(pdf|doc|docx|xls|xlsx|ppt|pptx)(\?|#|$)/i],
    mimeTypes: [
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-excel',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-powerpoint',
      'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    ]
  }
]

/** 不应被检测的 URL 模式（注意：blob: 不再跳过，由 MediaProbeService 处理） */
const SKIP_URL_PATTERNS = [
  /^chrome-extension:\/\//,
  /^devtools:\/\//,
  /^data:/,
  /^about:/,
  /^chrome:/
]

// ========== 服务实现 ==========

const MAX_RESOURCES_PER_VIEW = 500
const SUMMARY_DEBOUNCE_MS = 500

export class ResourceDetectionService extends EventEmitter {
  private stores = new Map<string, ViewResourceStore>()
  /** webContents.id → viewId，用于在 webRequest 回调中快速关联 */
  private wcIdToViewId = new Map<number, string>()
  /** 每个 session partition 的 listener 引用及视图计数，用于在最后一个视图销毁时移除 */
  private sessionListeners = new Map<string, {
    session: Electron.Session
    handler: (details: Electron.OnCompletedListenerDetails) => void
    viewCount: number
  }>()
  /** debounce timer for summary updates */
  private summaryDebounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 外部回调：当 summary 变化时通知 CrawlspaceContextHub */
  private onSummaryChanged?: (viewId: string, summary: ResourceDetectionSummary) => void
  /**
   * 导航清理抑制集合。viewId 在此集合中时，handleNavigation 不清空资源。
   * 用于 ensureImagesCaptured 等场景：reload 前抑制，reload 后恢复。
   */
  private navigationSuppressed = new Set<string>()

  /**
   * 设置 summary 变化回调（由 ViewFactory 或 main index 注入）
   */
  setSummaryChangedCallback(
    cb: (viewId: string, summary: ResourceDetectionSummary) => void
  ): void {
    this.onSummaryChanged = cb
  }

  /**
   * 抑制指定 viewId 的导航清理。
   * 调用后，handleNavigation 对该 viewId 只更新 pageUrl，不清空资源。
   * 用于程序化 reload（如 ensureImagesCaptured）保留已检测资源。
   */
  suppressNavigationClear(viewId: string): void {
    this.navigationSuppressed.add(viewId)
  }

  /**
   * 恢复指定 viewId 的导航清理行为。
   */
  resumeNavigationClear(viewId: string): void {
    this.navigationSuppressed.delete(viewId)
  }

  /**
   * 根据 webContentsId 查找 viewId
   */
  getViewIdByWebContentsId(wcId: number): string | undefined {
    return this.wcIdToViewId.get(wcId)
  }

  /**
   * 注册一个 view 进行资源检测
   *
   * : 参数从 WebContentsView 收窄为 WebContents（内部只用 webContents）。
   */
  registerView(viewId: string, webContents: WebContents, options?: { partition?: string }): void {
    // 清理旧的注册（如果存在）
    if (this.stores.has(viewId)) {
      this.unregisterView(viewId)
    }

    const wc = webContents
    if (wc.isDestroyed()) {
      log.warn(`⚠️  WebContents 已销毁，跳过注册: ${viewId}`)
      return
    }

    const wcId = wc.id
    const wcSession = wc.session
    const partition = this.resolveSessionPartition(wcSession, options?.partition)

    // 创建 store
    const store: ViewResourceStore = {
      viewId,
      resources: new Map(),
      pageUrl: wc.getURL() || '',
      maxCount: MAX_RESOURCES_PER_VIEW,
      webContentsId: wcId,
      sessionPartition: partition,
      listeners: {}
    }

    this.stores.set(viewId, store)
    this.wcIdToViewId.set(wcId, viewId)
    getResourceHubService().registerView(viewId, store.pageUrl)

    // 监听主框架导航 → 清空资源列表
    const onDidNavigate = (_event: any, url: string) => {
      this.handleNavigation(viewId, url)
    }
    wc.on('did-navigate', onDidNavigate)
    store.listeners.didNavigate = onDidNavigate

    const onDidNavigateInPage = (_event: any, url: string) => {
      this.handleNavigation(viewId, url)
    }
    wc.on('did-navigate-in-page', onDidNavigateInPage)
    store.listeners.didNavigateInPage = onDidNavigateInPage

    // 监听 webContents 销毁
    const onDestroyed = () => {
      this.unregisterView(viewId)
    }
    wc.once('destroyed', onDestroyed)
    store.listeners.destroyed = onDestroyed

    // 注册 webRequest listener
    this.ensureSessionListener(wcSession, partition)

    log.info(
      `✅ 已注册 view: ${viewId} (wcId=${wcId}, partition=${partition || 'default'})`
    )
  }

  /**
   * 反注册 view
   */
  unregisterView(viewId: string): void {
    const store = this.stores.get(viewId)
    if (!store) return

    // 清除 debounce timer
    const timer = this.summaryDebounceTimers.get(viewId)
    if (timer) {
      clearTimeout(timer)
      this.summaryDebounceTimers.delete(viewId)
    }

    // 移除 WebContents 上的事件监听器，防止内存泄漏
    this.removeWebContentsListeners(store)

    // 清除 wcId 映射
    this.wcIdToViewId.delete(store.webContentsId)

    // 清除资源
    store.resources.clear()
    getResourceHubService().unregisterView(viewId)

    // 递减 partition listener 引用计数
    this.releaseSessionListener(store.sessionPartition)

    // 移除 store
    this.stores.delete(viewId)

    log.debug(`🗑️  已反注册 view: ${viewId}`)
  }

  /**
   * 获取指定 view 检测到的资源列表
   */
  getResources(viewId: string, filter?: ResourceDetectionFilter): DetectedResource[] {
    return getResourceHubService().getResources(viewId, filter)
  }

  /**
   * 获取指定 view 的资源统计摘要
   */
  getSummary(viewId: string): ResourceDetectionSummary {
    return getResourceHubService().getSummary(viewId)
  }

  /**
   * 清空指定 view 的资源列表
   */
  clearResources(viewId: string): void {
    const store = this.stores.get(viewId)
    if (store) {
      store.resources.clear()
      getResourceHubService().clearView(viewId, store.pageUrl)
      this.notifySummaryChanged(viewId)
    }
  }

  /**
   * 检查 view 是否已注册
   */
  hasView(viewId: string): boolean {
    return this.stores.has(viewId)
  }

  /**
   * 清理所有注册（应用退出时调用）
   */
  cleanup(): void {
    const hub = getResourceHubService()
    for (const [viewId, store] of this.stores) {
      this.removeWebContentsListeners(store)
      hub.unregisterView(viewId)
    }
    for (const timer of this.summaryDebounceTimers.values()) {
      clearTimeout(timer)
    }
    this.summaryDebounceTimers.clear()
    this.stores.clear()
    this.wcIdToViewId.clear()
    this.navigationSuppressed.clear()

    for (const [key, entry] of this.sessionListeners) {
      try {
        entry.session.webRequest.onCompleted({ urls: ['<all_urls>'] }, null as any)
      } catch {
        // session 可能已销毁
      }
      log.debug(`🧹 cleanup: 移除 session listener: ${key}`)
    }
    this.sessionListeners.clear()

    log.info('🧹 已清理所有注册')
  }

  /**
   * 处理来自 NetworkCaptureService 的 defaultSession 请求事件
   * 用于 user-tab 等使用 defaultSession 的视图
   */
  handleDefaultSessionRequest(details: Electron.OnCompletedListenerDetails): void {
    this.processRequest(details)
  }

  /**
   * 接收外部探测到的资源（如 MediaProbeService 通过 CDP 探测的 DOM 媒体元素）
   * 与被动网络检测互补：网络层看不到的 blob: URL 和 MediaSource 资源可以通过此方法注入
   */
  addExternalResource(
    viewId: string,
    resource: ExternalDetectedResourceInput
  ): DetectedResource | null {
    const store = this.stores.get(viewId)
    if (!store) return null

    if (store.resources.has(resource.url)) {
      const existing = store.resources.get(resource.url)!
      if (resource.mediaElementInfo) {
        existing.mediaElementInfo = resource.mediaElementInfo
      }
      if (resource.streamInfo) {
        existing.streamInfo = resource.streamInfo
      }
      const {
        capabilities: _ignoredCapabilities,
        captureStatus: _ignoredCaptureStatus,
        ...hubInput
      } = existing
      const normalized = getResourceHubService().upsertResource({
        ...hubInput,
        viewId,
        url: existing.url,
        sessionPartition: store.sessionPartition
      })
      store.resources.set(resource.url, normalized)
      return normalized
    }

    if (store.resources.size >= store.maxCount) return null

    const fullResource: DetectedResource = {
      ...resource,
      id: this.generateResourceId(resource.url, viewId),
      resourceId: this.generateResourceId(resource.url, viewId),
      timestamp: Date.now(),
      viewId,
      pageUrl: store.pageUrl,
      captureStatus: 'metadata_only',
      capabilities: []
    }

    const { capabilities: _ignoredCapabilities, ...hubInput } = fullResource
    const normalized = getResourceHubService().upsertResource({
      ...hubInput,
      viewId,
      url: fullResource.url,
      sessionPartition: store.sessionPartition
    })
    store.resources.set(resource.url, normalized)
    this.notifySummaryChanged(viewId)
    this.emit('resource-detected', normalized)

    log.debug(
      `🔍 外部资源: ${resource.category} (${resource.source || 'external'}): ${resource.url.substring(0, 100)}`
    )

    return normalized
  }

  /**
   * 更新已检测资源的流媒体信息（如 M3U8 解析后的结果）
   */
  updateStreamInfo(viewId: string, url: string, streamInfo: StreamInfo): boolean {
    const store = this.stores.get(viewId)
    if (!store) return false

    const resource = store.resources.get(url)
    if (!resource) return false

    resource.streamInfo = streamInfo
    const normalized = getResourceHubService().updateStreamInfo(viewId, { url }, streamInfo) ?? resource
    this.emit('resource-updated', normalized)
    return true
  }

  // ========== 内部方法 ==========

  /**
   * 移除 WebContents 上已注册的事件监听器。
   * 在 unregisterView 和 cleanup 时调用，防止监听器堆积导致内存泄漏。
   */
  private removeWebContentsListeners(store: ViewResourceStore): void {
    try {
      const wc = wcModule.fromId(store.webContentsId)
      if (!wc || wc.isDestroyed()) return

      if (store.listeners.didNavigate) {
        wc.off('did-navigate', store.listeners.didNavigate)
      }
      if (store.listeners.didNavigateInPage) {
        wc.off('did-navigate-in-page', store.listeners.didNavigateInPage)
      }
      if (store.listeners.destroyed) {
        wc.removeListener('destroyed', store.listeners.destroyed)
      }
    } catch {
      // WebContents 可能已销毁或 ID 无效
    }
    store.listeners = {}
  }

  /**
   * 确保指定 session 上有且仅有一个 webRequest.onCompleted listener，
   * 并维护该 partition 下的 view 引用计数。
   */
  private ensureSessionListener(
    targetSession: Electron.Session,
    partitionKey: string | undefined
  ): void {
    if (!partitionKey || targetSession === session.defaultSession) {
      return
    }

    const existing = this.sessionListeners.get(partitionKey)
    if (existing) {
      existing.viewCount++
      return
    }

    const handler = (details: Electron.OnCompletedListenerDetails) => {
      this.processRequest(details)
    }

    targetSession.webRequest.onCompleted(
      { urls: ['<all_urls>'] },
      handler
    )

    this.sessionListeners.set(partitionKey, { session: targetSession, handler, viewCount: 1 })
    log.debug(`🔧 已注册 session listener: ${partitionKey}`)
  }

  /**
   * 递减 partition 引用计数，当最后一个 view 销毁时移除 listener。
   */
  private releaseSessionListener(partitionKey: string | undefined): void {
    if (!partitionKey) return

    const entry = this.sessionListeners.get(partitionKey)
    if (!entry) return

    entry.viewCount--
    if (entry.viewCount <= 0) {
      try {
        entry.session.webRequest.onCompleted({ urls: ['<all_urls>'] }, null as any)
      } catch {
        // session 可能已销毁
      }
      this.sessionListeners.delete(partitionKey)
      log.debug(`🔧 已移除 session listener: ${partitionKey}`)
    }
  }

  /**
   * 处理一个已完成的网络请求
   */
  private processRequest(details: Electron.OnCompletedListenerDetails): void {
    // 1. 基础过滤（只允许 2xx 成功响应，3xx 重定向不应进入检测流程）
    if (!details.url || details.statusCode < 200 || details.statusCode >= 300) {
      return
    }

    // 2. 跳过不应检测的 URL
    if (SKIP_URL_PATTERNS.some(p => p.test(details.url))) {
      return
    }

    // 3. 通过 webContentsId 关联到 viewId
    const wcId = (details as any).webContentsId as number | undefined
    if (wcId == null) return

    const viewId = this.wcIdToViewId.get(wcId)
    if (!viewId) return

    const store = this.stores.get(viewId)
    if (!store) return

    const existing = store.resources.get(details.url)

    // 5. 数量限制
    if (!existing && store.resources.size >= store.maxCount) {
      return
    }

    // 6. 获取 Content-Type
    const mimeType = this.getMimeType(details.responseHeaders)

    // 7. 分类
    const category = this.classifyResource(details.url, mimeType)
    if (!category) return

    // 8. 构建 DetectedResource
    const resource: DetectedResource = {
      id: existing?.resourceId || this.generateResourceId(details.url, viewId),
      resourceId: existing?.resourceId || this.generateResourceId(details.url, viewId),
      url: details.url,
      category,
      mimeType,
      size: this.getContentLength(details.responseHeaders),
      statusCode: details.statusCode,
      method: details.method || 'GET',
      source: 'network',
      referrer: this.getHeader(details.responseHeaders, 'referer')
        || this.getRequestHeader(details, 'referer'),
      requestHeaders: this.extractDownloadHeaders(details),
      timestamp: Date.now(),
      viewId,
      pageUrl: store.pageUrl,
      mediaElementInfo: existing?.mediaElementInfo,
      streamInfo: existing?.streamInfo,
      captureStatus: existing?.captureStatus ?? 'metadata_only',
      capabilities: existing?.capabilities ?? []
    }

    // 9. 存储
    const { capabilities: _ignoredCapabilities, ...hubInput } = resource
    const normalized = getResourceHubService().upsertResource({
      ...hubInput,
      resourceId: existing?.resourceId,
      viewId,
      url: resource.url,
      sessionPartition: store.sessionPartition
    })
    store.resources.set(details.url, normalized)

    // 10. 通知 summary 变化（debounced）
    if (!existing) {
      this.notifySummaryChanged(viewId)
    }

    // 11. 发射事件（供外部监听）
    this.emit(existing ? 'resource-updated' : 'resource-detected', normalized)

    // 日志（只在非图片资源时打印，图片太多）
    if (category !== 'image') {
      log.debug(
        existing
          ? `🔄 补全网络上下文: ${details.url.substring(0, 100)} (view=${viewId})`
          : `🎯 ${category}: ${details.url.substring(0, 100)} (view=${viewId})`
      )
    }
  }

  /**
   * 分类资源
   */
  private classifyResource(url: string, mimeType?: string): ResourceCategory | null {
    // 提取 pathname 用于 URL 匹配（去除 query/hash 干扰）
    let pathname = url
    try {
      pathname = new URL(url).pathname
    } catch {
      log.debug('classifyResource: URL 解析失败, 使用原始 URL:', url.substring(0, 100))
    }

    for (const rule of CLASSIFICATION_RULES) {
      // URL 模式匹配
      if (rule.urlPatterns.some(p => p.test(pathname) || p.test(url))) {
        return rule.category
      }

      // Content-Type 匹配
      if (mimeType) {
        const normalizedMime = mimeType.toLowerCase()
        for (const mimePattern of rule.mimeTypes) {
          if (typeof mimePattern === 'string') {
            if (normalizedMime === mimePattern) return rule.category
          } else {
            if (mimePattern.test(normalizedMime)) return rule.category
          }
        }
      }
    }

    return null
  }

  /**
   * 处理页面导航（主框架）
   */
  private handleNavigation(viewId: string, newUrl: string): void {
    const store = this.stores.get(viewId)
    if (!store) return

    if (this.navigationSuppressed.has(viewId)) {
      store.pageUrl = newUrl
      log.debug(`🔄 导航清空已抑制 (reload): ${viewId} → ${newUrl.substring(0, 80)}`)
      return
    }

    store.pageUrl = newUrl
    store.resources.clear()
    getResourceHubService().clearView(viewId, newUrl)
    this.notifySummaryChanged(viewId)

    log.debug(`🔄 导航清空: ${viewId} → ${newUrl.substring(0, 80)}`)
  }

  /**
   * 通知 summary 变化（debounced）
   */
  private notifySummaryChanged(viewId: string): void {
    // 清除之前的 timer
    const existing = this.summaryDebounceTimers.get(viewId)
    if (existing) clearTimeout(existing)

    const timer = setTimeout(() => {
      this.summaryDebounceTimers.delete(viewId)
      if (this.onSummaryChanged) {
        const summary = this.getSummary(viewId)
        this.onSummaryChanged(viewId, summary)
      }
      this.emit('summary-changed', viewId, this.getSummary(viewId))
    }, SUMMARY_DEBOUNCE_MS)

    this.summaryDebounceTimers.set(viewId, timer)
  }

  // ========== 辅助方法 ==========

  private generateResourceId(url: string, viewId: string): string {
    return createHash('md5').update(`${url}:${viewId}`).digest('hex').substring(0, 12)
  }

  private getMimeType(headers?: Record<string, string[]>): string | undefined {
    if (!headers) return undefined
    const contentType = headers['content-type']?.[0] || headers['Content-Type']?.[0]
    return contentType?.split(';')[0]?.trim()?.toLowerCase()
  }

  private getContentLength(headers?: Record<string, string[]>): number | undefined {
    if (!headers) return undefined
    const cl = headers['content-length']?.[0] || headers['Content-Length']?.[0]
    if (!cl) return undefined
    const n = parseInt(cl, 10)
    return isNaN(n) ? undefined : n
  }

  private getHeader(headers?: Record<string, string[]>, name?: string): string | undefined {
    if (!headers || !name) return undefined
    const lower = name.toLowerCase()
    for (const [key, values] of Object.entries(headers)) {
      if (key.toLowerCase() === lower && values.length > 0) {
        return values[0]
      }
    }
    return undefined
  }

  private getRequestHeader(details: any, name: string): string | undefined {
    const headers = details.requestHeaders
    if (!headers) return undefined
    const lower = name.toLowerCase()
    for (const [key, value] of Object.entries(headers as Record<string, string>)) {
      if (key.toLowerCase() === lower) return value as string
    }
    return undefined
  }

  /**
   * 提取下载时可能需要的请求头
   */
  private extractDownloadHeaders(details: any): Record<string, string> | undefined {
    const headers: Record<string, string> = {}
    const referer = this.getRequestHeader(details, 'referer')
    if (referer) headers['Referer'] = referer
    const origin = this.getRequestHeader(details, 'origin')
    if (origin) headers['Origin'] = origin

    return Object.keys(headers).length > 0 ? headers : undefined
  }

  /**
   * 从 Electron Session 推断 partition key
   */
  private resolveSessionPartition(
    targetSession: Electron.Session,
    explicitPartition?: string
  ): string | undefined {
    if (targetSession === session.defaultSession) {
      return undefined
    }

    const inferredPartition = this.getPartitionKey(targetSession)
    if (explicitPartition && explicitPartition !== 'shared') {
      if (explicitPartition.startsWith('persist:')) {
        return explicitPartition
      }
      return inferredPartition ? `persist:${explicitPartition}` : explicitPartition
    }

    return inferredPartition
  }

  private getPartitionKey(targetSession: Electron.Session): string | undefined {
    // Electron 没有直接暴露 partition key 的 API
    // 但 storagePath 包含 partition 信息
    const storagePath = (targetSession as any).storagePath
    if (storagePath && typeof storagePath === 'string') {
      // storagePath 通常是 .../<partition>/
      const parts = storagePath.split('/')
      const rawPartition = parts.filter(Boolean).pop()
      if (!rawPartition) {
        return undefined
      }
      const decodedPartition = decodeURIComponent(rawPartition)
      return decodedPartition.startsWith('persist:')
        ? decodedPartition
        : `persist:${decodedPartition}`
    }
    return undefined
  }
}

// ========== 单例 ==========

let instance: ResourceDetectionService | null = null

export function getResourceDetectionService(): ResourceDetectionService {
  if (!instance) {
    instance = new ResourceDetectionService()
  }
  return instance
}

export function resetResourceDetectionService(): void {
  if (instance) {
    instance.cleanup()
    instance = null
  }
}
