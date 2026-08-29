import { ipcMain } from 'electron'
import { guardedHandle, guardedOn } from '../utils/guarded-handle'
import { getCrawlspaceContextHub } from './CrawlspaceContextHub'
import { getViewFactory } from '../view-factory'
import type { ViewProfile } from '../view-factory'
import { withAgentBackgroundInteraction } from '../view-factory/background-interaction'
import { getResourceDetectionService } from '../services/ResourceDetectionService'
import { getResourceHubService } from '../services/ResourceHubService'
import { resolveResourceRequestSession } from '../services/resourceRequestContext'
import { handleDownloadResource, handleDownloadStream, parseStreamCore } from '../services/resource-actions'
import { getResourceDownloadService } from '../services/ResourceDownloadService'
import { getMediaProbeService } from '../services/MediaProbeService'
import { normalizeRendererViewMetaUpdates } from './renderer-view-meta-updates'
import type { RendererCrawlspaceViewMetaUpdates } from '@shared/types/crawlspace'
import type { OpenIntentHints } from '../../shared/open-intent'
import { guardDirectLoadURL } from '../blocked-preview-load'
import { getMainWindow } from '../window-manager'
import { buildAntiDetectConfig, AccessLevel } from '@tabtin/browser-core'
import { resolveBrowserContainerMode } from '../../shared/browser-container-mode'
import { createLogger } from '../logger'
import { fileUrlToLocalPath, isAllowedLocalFileUrl } from '../crawl-view/utils'
import { detectLocalHtmlPreviewEncoding } from '../file-system/html-preview-encoding'
import { discardViewControl } from '../browser-tab-lock/browserTabInputLock'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'

const log = createLogger('CrawlspaceIPC')

const RESOURCE_QUERY_LIMIT_MAX = 500

type Subscription = {
  crawlspaceId?: string | null
  /** full-snapshot listener for initial sync (changed event) */
  listener: (snapshot: any) => void
  /** RP-006: diff listener for incremental push (context-diff event) */
  diffListener: (diff: any) => void
  destroyHandler: () => void
  /** CE-33: 渲染进程崩溃清理回调 */
  crashHandler: () => void
  /** CE-33: 清理 sender 侧两个事件监听器的函数 */
  removeSenderListeners: () => void
}

const subscriptions = new Map<number, Subscription>()

async function detectLocalPreviewDefaultEncoding(url: string, root?: string): Promise<string | undefined> {
  if (!root || !isAllowedLocalFileUrl(url, root)) return undefined
  const filePath = fileUrlToLocalPath(url)
  if (!filePath) return undefined
  try {
    return await detectLocalHtmlPreviewEncoding(filePath)
  } catch (error) {
    log.warn('本地 HTML 编码探测失败，继续使用 Chromium 默认编码', { url, error })
    return undefined
  }
}

function cleanupSubscription(id: number): void {
  const existing = subscriptions.get(id)
  if (!existing) return
  const hub = getCrawlspaceContextHub()
  hub.off('changed', existing.listener)
  hub.off('context-diff', existing.diffListener)
  // CE-33: 同时清理 sender 侧的 destroyed/render-process-gone 监听器，防止孤儿监听器堆积
  existing.removeSenderListeners()
  subscriptions.delete(id)
}

/** CE-34: 幂等保护 — 防止 registerCrawlspaceContextIpcHandlers 被意外调用两次导致 handler 重复注册 */
let _handlersRegistered = false

export function registerCrawlspaceContextIpcHandlers(): void {
  if (_handlersRegistered) {
    log.warn('registerCrawlspaceContextIpcHandlers 已注册，跳过重复注册')
    return
  }
  _handlersRegistered = true
  const probeResourcesForView = async (viewId: string) => {
    // GH-4777 Phase 3: 容器无关取页面 WebContents（WCV 与 webview guest 通吃）
    const wc = getViewFactory().getWebContents(viewId)
    if (!wc || wc.isDestroyed()) {
      return { result: null, error: `View not found: ${viewId}` }
    }

    const probeService = getMediaProbeService()
    const result = await probeService.probe(wc)
    const service = getResourceDetectionService()
    for (const el of result.elements) {
      const url = el.currentSrc || el.sources[0]
      if (!url) continue
      service.addExternalResource(viewId, {
        url,
        category: el.inferredCategory,
        statusCode: 200,
        method: 'GET',
        source: 'dom_probe',
        mediaElementInfo: probeService.toMediaElementInfo(el)
      })
    }

    return { result, error: null }
  }

  const resolveResourceContext = (payload: { viewId?: string; resourceId?: string; url?: string }) => {
    const hub = getResourceHubService()
    if (payload.viewId) {
      return {
        viewId: payload.viewId,
        resource: hub.resolveResource(payload.viewId, {
          resourceId: payload.resourceId,
          url: payload.url
        })
      }
    }
    if (payload.resourceId) {
      const found = hub.findResourceLocation(payload.resourceId)
      if (found) {
        return found
      }
    }
    return { viewId: undefined as string | undefined, resource: null as any }
  }

  const ensureResourceProbe = async (viewId: string, forceProbe = false) => {
    const hub = getResourceHubService()
    const summary = hub.getSummary(viewId)
    if (!forceProbe && summary.total > 0) {
      return hub
    }

    await probeResourcesForView(viewId)
    return hub
  }

  const captureResourceInPage = async (viewId: string, url: string, resource?: any) => {
    // GH-4777 Phase 3: 容器无关取页面 WebContents（WCV 与 webview guest 通吃）
    const wc = getViewFactory().getWebContents(viewId)
    if (!wc || wc.isDestroyed()) {
      throw new Error(`View not found: ${viewId}`)
    }

    // E2E-005 修复：验证 URL 格式，防止通过恶意 URL 注入任意 JS
    const isSafeUrl = /^https?:\/\//i.test(url) || /^blob:/i.test(url) || /^data:/i.test(url)
    if (!isSafeUrl) {
      throw new Error(`Unsupported URL scheme: ${url.slice(0, 30)}`)
    }

    const raw = await wc.executeJavaScript(`
      (async (targetUrl) => {
        try {
          const response = await fetch(targetUrl);
          const blob = await response.blob();
          const dataUrl = await new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = () => reject(new Error('Failed to read blob'));
            reader.readAsDataURL(blob);
          });
          return {
            success: true,
            dataUrl,
            mimeType: blob.type || undefined,
            size: blob.size
          };
        } catch (error) {
          return {
            success: false,
            error: error instanceof Error ? error.message : String(error)
          };
        }
      })(${JSON.stringify(url)})
    `, true)

    if (!raw?.success || !raw?.dataUrl) {
      throw new Error(raw?.error || 'Resource capture failed')
    }

    return getResourceHubService().attachCapturedContent(viewId, url, {
      mimeType: raw.mimeType || resource?.mimeType,
      size: raw.size || resource?.size,
      category: resource?.category,
      source: 'manual_capture',
      pageUrl: resource?.pageUrl,
      contentRef: {
        kind: 'data_url',
        data: raw.dataUrl,
        size: raw.size || resource?.size,
        mimeType: raw.mimeType || resource?.mimeType,
        capturedAt: Date.now()
      }
    })
  }

  const clampResourceLimit = (value: unknown): number | undefined => {
    if (value == null) return undefined
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return RESOURCE_QUERY_LIMIT_MAX
    return Math.min(Math.floor(value), RESOURCE_QUERY_LIMIT_MAX)
  }

  const normalizeConcurrency = (value: unknown, fallback = 3) => {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      return fallback
    }
    return Math.max(1, Math.floor(value))
  }

  const mapWithConcurrency = async <T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
  ): Promise<R[]> => {
    if (items.length === 0) {
      return []
    }

    const results = new Array<R>(items.length)
    let cursor = 0
    const workerCount = Math.min(concurrency, items.length)

    const runNext = async () => {
      while (cursor < items.length) {
        const index = cursor++
        results[index] = await worker(items[index], index)
      }
    }

    await Promise.all(Array.from({ length: workerCount }, () => runNext()))
    return results
  }

  // #4871：本文件原有一份 handleDownloadResource 本地拷贝，与 resource-actions
  // 的实现重复且漂移（漏掉 trackExternalDownload 登记，导致 UI 下载不进下载管理）。
  // 已删除，统一复用 resource-actions 导出的 handleDownloadResource。

  const handleParseStream = async (payload: { resourceId?: string; url?: string; viewId?: string; headers?: Record<string, string> }) => {
    const { viewId, resource } = resolveResourceContext(payload)
    const targetUrl = resource?.url || payload.url
    if (!targetUrl) {
      return { success: false, error: 'missing resourceId/url' }
    }

    return parseStreamCore({
      targetUrl,
      category: resource?.category,
      headers: {
        ...(resource?.requestHeaders || {}),
        ...(payload.headers || {})
      },
      requestSession: resolveResourceRequestSession({ viewId, resource }),
      viewId,
      resourceId: resource?.resourceId,
    })
  }

  guardedHandle('crawlspace:getContext', (_event, crawlspaceId?: string | null) => {
    const hub = getCrawlspaceContextHub()
    if (crawlspaceId) {
      return hub.getSnapshot(crawlspaceId)
    }
    return hub.getAllSnapshots()
  })

  guardedOn('crawlspace:subscribe', (event, crawlspaceId?: string | null) => {
    const hub = getCrawlspaceContextHub()
    const sender = event.sender
    const senderId = sender.id

    const existing = subscriptions.get(senderId)
    if (existing) {
      // cleanupSubscription 已包含 removeSenderListeners，会移除旧 destroyed/render-process-gone 监听
      cleanupSubscription(senderId)
    }

    // RP-006: full-snapshot listener reserved for initial sync only;
    // the 'changed' subscription is kept so that non-resource-summary
    // changes (view creation, tab switch, etc.) still reach the renderer.
    const listener = (snapshot: any) => {
      if (crawlspaceId && snapshot?.crawlspaceId !== crawlspaceId) {
        return
      }
      try {
        sender.send('crawlspace:context-changed', snapshot)
      } catch (error) {
        log.warn('subscribe: sender.send failed, auto cleanup subscription:', {
          senderId,
          crawlspaceId,
          error,
        })
        cleanupSubscription(senderId)
      }
    }

    // RP-006: incremental diff listener – sends small payloads instead of full snapshots
    const diffListener = (diff: any) => {
      if (crawlspaceId && diff?.crawlspaceId !== crawlspaceId) {
        return
      }
      try {
        sender.send('crawlspace:context-diff', diff)
      } catch (error) {
        log.warn('subscribe: diff sender.send failed, auto cleanup:', {
          senderId,
          crawlspaceId,
          error,
        })
        cleanupSubscription(senderId)
      }
    }

    const destroyHandler = () => {
      cleanupSubscription(senderId)
    }

    // CE-33: 渲染进程崩溃时 'destroyed' 事件不一定可靠触发，
    // 额外监听 'render-process-gone' 确保订阅被清理，防止泄漏
    const crashHandler = () => {
      cleanupSubscription(senderId)
    }

    const removeSenderListeners = () => {
      try {
        sender.removeListener('destroyed', destroyHandler)
        sender.removeListener('render-process-gone', crashHandler)
      } catch {
        // sender 已销毁时忽略
      }
    }

    subscriptions.set(senderId, { crawlspaceId, listener, diffListener, destroyHandler, crashHandler, removeSenderListeners })
    hub.on('changed', listener)
    hub.on('context-diff', diffListener)
    sender.once('destroyed', destroyHandler)
    sender.once('render-process-gone', crashHandler)

    if (crawlspaceId) {
      listener(hub.getSnapshot(crawlspaceId))
    } else {
      for (const snapshot of hub.getAllSnapshots()) {
        listener(snapshot)
      }
    }
  })

  guardedOn('crawlspace:unsubscribe', event => {
    cleanupSubscription(event.sender.id)
  })

  guardedHandle(
    'crawlspace:createView',
    async (
      _event,
      payload: {
        crawlspaceId: string
        viewId?: string
        url: string
        title?: string
        runId?: string
        spaceId?: string
        isPreview?: boolean
        kind: 'workspace-view'
        profile: ViewProfile
        partition: string
        sessionMode?: string
        allowPrivateHostNavigation?: boolean
        localPreviewRoot?: string
        openIntentHints?: OpenIntentHints
        antiDetect?: unknown
        proxy?: {
          server: string
          username?: string
          password?: string
        }
      }
    ) => {
      if (!payload?.crawlspaceId || !payload?.profile || !payload?.partition || !payload?.kind) {
        return { success: false, error: 'missing crawlspaceId/profile/partition/kind' }
      }
      if (payload.kind !== 'workspace-view') {
        return { success: false, error: 'invalid kind for crawlspace:createView' }
      }

      const viewId = payload.viewId || `view-${payload.crawlspaceId}-${Date.now()}`
      const antiDetect = payload.antiDetect ?? buildAntiDetectConfig(AccessLevel.L0)
      const localPreviewDefaultEncoding = await detectLocalPreviewDefaultEncoding(
        payload.url,
        payload.localPreviewRoot,
      )

      // GH-4777 影子 WCV 根治：flag=webview 时容器由 <webview> 元素经
      // announce → bind → adoptWebviewGuest 建立，这里若照旧 createView 会
      // 产出一个用户看不见的 WCV「影子视图」抢占 tabId 权威条目——地址栏
      // 导航 / executeScript / 截图全部打进影子（现象：地址栏变了页面没变）。
      // 因此只登记 hub 元数据（tab 列表渲染与 setActiveView 依赖），真正的
      // 容器与全量注册等 guest 收养时完成；tab 在挂载前被关闭由
      // crawlspace:closeView 的 context_pruned 分支清理。
      if (resolveBrowserContainerMode() === 'webview') {
        // dogfood grep 关键字：webview placeholder register
        log.info('webview 模式：跳过 WCV 容器创建，仅登记 hub 元数据', {
          crawlspaceId: payload.crawlspaceId,
          viewId,
        })
        // #6215：本地 HTML 产物预览的 file:// 放行根。本分支不建影子 WCV，
        // root 无 view config 可落——寄存到 webview-host，announce 时取用
        // （否则 will-attach 白名单拒 file:// src，预览空白）。
        if (payload.localPreviewRoot) {
          const { registerWebviewLocalPreviewRoot } = await import('../webview-host/webview-host')
          registerWebviewLocalPreviewRoot(viewId, payload.localPreviewRoot)
        }
        const createdAt = Date.now()
        const ownerRegistered = getOrganizationTabManager().registerView(
          payload.crawlspaceId,
          viewId,
          {
            title: payload.title || payload.url,
            url: payload.url,
            runId: payload.runId,
            createdAt,
          },
        )
        if (!ownerRegistered) {
          return { success: false, error: 'view 已绑定其他 crawlspace' }
        }
        getCrawlspaceContextHub().registerView(payload.crawlspaceId, viewId, {
          title: payload.title,
          url: payload.url,
          runId: payload.runId,
          isPreview: Boolean(payload.isPreview),
          createdAt,
        })
        return { success: true, viewId }
      }

      try {
        const viewFactory = getViewFactory()
        const viewConfig = {
          id: viewId,
          profile: payload.profile,
          url: payload.url,
          runId: payload.runId,
          spaceId: payload.spaceId,
          partition: payload.partition,
          sessionMode: payload.sessionMode as any,
          allowPrivateHostNavigation: payload.allowPrivateHostNavigation === true,
          ...(payload.localPreviewRoot ? { localPreviewRoot: payload.localPreviewRoot } : {}),
          ...(localPreviewDefaultEncoding ? { localPreviewDefaultEncoding } : {}),
          antiDetect: antiDetect as any,
          proxy: payload.proxy,
          notifyRenderer: false,
          keepAlive: true,
          metadata: {
            crawlspaceId: payload.crawlspaceId,
            title: payload.title,
            kind: payload.kind,
            isPreview: Boolean(payload.isPreview),
            ...(payload.openIntentHints ? { openIntentHints: payload.openIntentHints } : {}),
            createdBy: 'crawlspace:createView'
          }
        }
        await viewFactory.createView({
          ...viewConfig,
          ...withAgentBackgroundInteraction(viewConfig),
        })

        // WCV 模式没有 <webview> 的 announce/adopt 生命周期，ViewFactory 也不会
        // 代替 crawlspace hub 建立 UI 上下文。缺少这条登记会让后续
        // crawlspace:setActiveView 找不到刚创建的 view：右侧虽有标签和 slot，
        // 原生 BrowserView 却永远不会被 show。与 webview 分支保持同一权威元数据。
        getCrawlspaceContextHub().registerView(payload.crawlspaceId, viewId, {
          title: payload.title,
          url: payload.url,
          runId: payload.runId,
          isPreview: Boolean(payload.isPreview),
          createdAt: Date.now(),
        })

        return { success: true, viewId }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle('crawlspace:setActiveView', (_event, crawlspaceId: string, viewId?: string | null) => {
    if (!crawlspaceId) {
      return { success: false, error: 'missing crawlspaceId' }
    }
    if (viewId) {
      const snapshot = getCrawlspaceContextHub().getSnapshot(crawlspaceId)
      const exists = snapshot.views.some(view => view.viewId === viewId)
      if (!exists) {
        return { success: false, error: `view not found in crawlspace: ${viewId}` }
      }
    }
    getCrawlspaceContextHub().setActiveView(crawlspaceId, viewId ?? null)
    return { success: true }
  })

  guardedHandle(
    'crawlspace:updateViewMeta',
    (_event, crawlspaceId: string, viewId: string, updates: RendererCrawlspaceViewMetaUpdates) => {
      if (!crawlspaceId || !viewId) {
        return { success: false, error: 'missing crawlspaceId/viewId' }
      }
      const payload = normalizeRendererViewMetaUpdates(updates)
      if (!payload || Object.keys(payload).length === 0) {
        return { success: false, error: 'no supported updates' }
      }
      getCrawlspaceContextHub().updateViewMeta(crawlspaceId, viewId, payload)
      return { success: true }
    }
  )

  guardedHandle(
    'resourceDetection:getResources',
    async (_event, payload: { viewId: string; category?: string; captureStatus?: string; capability?: string; limit?: number; probeMedia?: boolean; hideSegments?: boolean }) => {
      if (!payload?.viewId) {
        return { success: false, error: 'missing viewId' }
      }
      try {
        const clampedLimit = clampResourceLimit(payload.limit)
        const filter = {
          category: payload.category as any,
          captureStatus: payload.captureStatus as any,
          capability: payload.capability as any,
          hideSegments: payload.hideSegments,
        }
        const hub = await ensureResourceProbe(payload.viewId, Boolean(payload.probeMedia))
        const resources = hub.getResources(payload.viewId, {
          ...filter,
          limit: clampedLimit
        })
        const summary = hub.getSummary(payload.viewId, filter)
        const data = { resources, summary, viewId: payload.viewId, pageUrl: hub.getPageUrl(payload.viewId) }
        return { success: true, resources, summary, data }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:listResources',
    async (_event, payload: { viewId: string; category?: string; captureStatus?: string; capability?: string; limit?: number; probeMedia?: boolean; hideSegments?: boolean }) => {
      if (!payload?.viewId) {
        return { success: false, error: 'missing viewId' }
      }
      try {
        const clampedLimit = clampResourceLimit(payload.limit)
        const filter = {
          category: payload.category as any,
          captureStatus: payload.captureStatus as any,
          capability: payload.capability as any,
          hideSegments: payload.hideSegments,
        }
        const hub = await ensureResourceProbe(payload.viewId, Boolean(payload.probeMedia))
        const resources = hub.getResources(payload.viewId, {
          ...filter,
          limit: clampedLimit
        })
        const summary = hub.getSummary(payload.viewId, filter)
        return {
          success: true,
          data: {
            resources,
            summary,
            viewId: payload.viewId,
            pageUrl: hub.getPageUrl(payload.viewId)
          }
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:inspectResource',
    (_event, payload: { resourceId: string; viewId?: string }) => {
      if (!payload?.resourceId) {
        return { success: false, error: 'missing resourceId' }
      }
      try {
        const hub = getResourceHubService()
        const resource = payload.viewId
          ? hub.getResource(payload.viewId, payload.resourceId)
          : hub.findResourceById(payload.resourceId)
        if (!resource) {
          return { success: false, error: `Resource not found: ${payload.resourceId}` }
        }
        return { success: true, data: { resource } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:captureResource',
    async (_event, payload: { resourceId?: string; url?: string; viewId?: string; force?: boolean }) => {
      try {
        const { viewId, resource } = resolveResourceContext(payload)
        const targetUrl = resource?.url || payload.url
        if (!viewId || !targetUrl) {
          return { success: false, error: 'resourceId/url + viewId is required' }
        }
        if (resource?.contentRef && !payload.force) {
          return { success: true, data: { resource, captured: false } }
        }
        const captured = await captureResourceInPage(viewId, targetUrl, resource)
        return { success: true, data: { resource: captured, captured: true } }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:downloadResource',
    async (_event, payload: { resourceId?: string; url?: string; viewId?: string; filename?: string; headers?: Record<string, string> }) => {
      try {
        return await handleDownloadResource(payload)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  /**
   * 远程媒体拉进内存（不落盘）。聊天 file-ref 拖回 / 附件预览用。
   * 不走 api-proxy 白名单（第三方 CDN 如火山 TOS）；仍拦私网 SSRF。
   */
  guardedHandle(
    'resourceDetection:fetchBuffer',
    async (_event, payload: { url?: string; headers?: Record<string, string>; maxBytes?: number }) => {
      try {
        const url = typeof payload?.url === 'string' ? payload.url.trim() : ''
        if (!url) {
          return { success: false, error: 'url is required' }
        }
        const result = await getResourceDownloadService().fetchToBuffer({
          url,
          headers: payload.headers,
          maxBytes: payload.maxBytes,
        })
        // 独立 ArrayBuffer，避免与 Node Buffer 池共享（同 fs:readBinaryFile）
        const data = result.buffer.buffer.slice(
          result.buffer.byteOffset,
          result.buffer.byteOffset + result.buffer.byteLength,
        )
        return {
          success: true,
          data: {
            buffer: data,
            mimeType: result.mimeType,
            size: result.size,
          },
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:downloadBatch',
    async (_event, payload: {
      resourceIds?: string[]
      urls?: string[]
      headers?: Record<string, string>
      concurrency?: number
      viewId?: string
    }) => {
      try {
        const descriptors: Array<{ resourceId?: string; url?: string }> = []
        const resourceIds = payload.resourceIds || []
        const urls = payload.urls || []
        const concurrency = normalizeConcurrency(payload.concurrency)

        for (const resourceId of resourceIds) {
          descriptors.push({ resourceId })
        }

        for (const url of urls) {
          descriptors.push({ url })
        }

        const settled = await mapWithConcurrency(
          descriptors,
          concurrency,
          async (descriptor) => {
            try {
              return await handleDownloadResource({
                ...descriptor,
                headers: payload.headers,
                viewId: payload.viewId
              })
            } catch (error) {
              return {
                success: false,
                error: error instanceof Error ? error.message : String(error)
              }
            }
          }
        )

        const results = settled.map((item: any, index) => ({
          url: descriptors[index]?.url
            || (item?.data?.resourceId ? (getResourceHubService().findResourceById(item.data.resourceId)?.url || '') : ''),
          resourceId: item?.data?.resourceId,
          success: Boolean(item?.success),
          data: item?.success ? item.data : undefined,
          error: item?.success ? undefined : item?.error
        }))
        const succeeded = results.filter(item => item.success).length
        const failed = results.length - succeeded

        return {
          success: true,
          data: {
            total: results.length,
            succeeded,
            failed,
            results
          }
        }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:parseM3U8',
    async (_event, payload: { resourceId?: string; url?: string; viewId?: string; headers?: Record<string, string> }) => {
      try {
        return await handleParseStream(payload)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:parseStream',
    async (_event, payload: { resourceId?: string; url?: string; viewId?: string; headers?: Record<string, string> }) => {
      try {
        return await handleParseStream(payload)
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

  guardedHandle(
    'resourceDetection:downloadStream',
    async (_event, payload: {
      resourceId?: string
      url?: string
      viewId?: string
      quality?: string
      filename?: string
      outputPath?: string
      headers?: Record<string, string>
      concurrency?: number
    }) => {
      try {
        return await handleDownloadStream({
          resourceId: payload.resourceId,
          url: payload.url,
          quality: payload.quality,
          filename: payload.filename,
          outputPath: payload.outputPath,
          headers: payload.headers,
          concurrency: payload.concurrency,
          viewId: payload.viewId,
          crawlTabId: payload.viewId,
        })
      } catch (error) {
        return {
          success: false,
          downloadId: '',
          error: error instanceof Error ? error.message : String(error)
        }
      }
    }
  )

  guardedHandle(
    'crawlspace:closeView',
    async (
      _event,
      payload: { crawlspaceId: string; viewId: string; reason?: string }
    ) => {
      if (!payload?.crawlspaceId || !payload?.viewId) {
        return { success: false, error: 'missing crawlspaceId/viewId' }
      }
      try {
        const viewFactory = getViewFactory()
        const hub = getCrawlspaceContextHub()
        const state = viewFactory.getViewState(payload.viewId)
        if (!state) {
          const snapshot = hub.getSnapshot(payload.crawlspaceId)
          const existsInContext = snapshot.views.some(view => view.viewId === payload.viewId)
          if (existsInContext) {
            hub.unregisterView(payload.crawlspaceId, payload.viewId)
            getOrganizationTabManager().unregisterView(payload.viewId)
            discardViewControl(payload.viewId)
            return { success: true, code: 'context_pruned' }
          }
          discardViewControl(payload.viewId)
          return { success: true, code: 'already_closed' }
        }
        if (state?.config?.metadata?.crawlspaceId &&
          state.config.metadata.crawlspaceId !== payload.crawlspaceId) {
          return { success: false, code: 'mismatched_crawlspace', error: 'view 不属于该 crawlspace' }
        }
        if (state?.config?.metadata?.kind && state.config.metadata.kind !== 'workspace-view') {
          return { success: false, code: 'invalid_kind', error: '仅允许关闭 workspace-view' }
        }

        await viewFactory.destroyView(payload.viewId, { force: true })
        discardViewControl(payload.viewId)
        return { success: true, code: 'closed' }
      } catch (error) {
        return {
          success: false,
          code: 'close_failed',
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }
  )

  guardedHandle(
    'crawlspace:reloadView',
    async (
      _event,
      payload: { crawlspaceId: string; viewId: string }
    ) => {
      if (!payload?.crawlspaceId || !payload?.viewId) {
        return { success: false, error: 'missing crawlspaceId/viewId' }
      }
      try {
        const viewFactory = getViewFactory()
        const viewState = viewFactory.getViewState(payload.viewId)
        if (!viewState) {
          return { success: false, error: 'view not found' }
        }
        const webContents = viewState.view?.webContents
        if (!webContents || webContents.isDestroyed()) {
          return { success: false, error: 'webContents not available' }
        }
        const url = webContents.getURL() || viewState.config?.url
        if (url) {
          const hints = viewState.config?.metadata?.openIntentHints as OpenIntentHints | undefined
          const previewGuard = guardDirectLoadURL({
            url,
            source: 'crawlspace:reloadView',
            mainWindow: getMainWindow(),
            ...hints,
          })
          if (previewGuard.action === 'block-preview') {
            return {
              success: false,
              code: 'PREVIEW_REQUIRED',
              intent: previewGuard.intent,
              error: `previewable URL blocked from BrowserView reload: ${previewGuard.intent.previewKind}`,
            }
          }
          webContents.loadURL(url)
        } else {
          webContents.reload()
        }
        return { success: true }
      } catch (error) {
        return { success: false, error: error instanceof Error ? error.message : String(error) }
      }
    }
  )

}

export function unregisterCrawlspaceContextIpcHandlers(): void {
  ipcMain.removeHandler('crawlspace:getContext')
  ipcMain.removeAllListeners('crawlspace:subscribe')
  ipcMain.removeAllListeners('crawlspace:unsubscribe')
  ipcMain.removeHandler('crawlspace:createView')
  ipcMain.removeHandler('crawlspace:setActiveView')
  ipcMain.removeHandler('crawlspace:updateViewMeta')
  ipcMain.removeHandler('resourceDetection:getResources')
  ipcMain.removeHandler('resourceDetection:listResources')
  ipcMain.removeHandler('resourceDetection:inspectResource')
  ipcMain.removeHandler('resourceDetection:captureResource')
  ipcMain.removeHandler('resourceDetection:downloadResource')
  ipcMain.removeHandler('resourceDetection:fetchBuffer')
  ipcMain.removeHandler('resourceDetection:downloadBatch')
  ipcMain.removeHandler('resourceDetection:parseM3U8')
  ipcMain.removeHandler('resourceDetection:parseStream')
  ipcMain.removeHandler('resourceDetection:downloadStream')
  ipcMain.removeHandler('crawlspace:closeView')
  ipcMain.removeHandler('crawlspace:reloadView')

  for (const [id, sub] of subscriptions) {
    const hub = getCrawlspaceContextHub()
    hub.off('changed', sub.listener)
    hub.off('context-diff', sub.diffListener)
    sub.removeSenderListeners()
  }
  subscriptions.clear()
}
