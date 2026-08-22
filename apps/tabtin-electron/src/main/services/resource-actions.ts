/**
 * resource-actions.ts — 资源检测 / 捕获 / 下载 / 流解析
 *
 * 封装 ResourceHub、MediaProbe、M3U8Parser、StreamDownload、ResourceDownload
 * 等资源操作逻辑，供 FrontendActionBridge 注入到 action-tools API。
 */

import type { BrowserWindow } from 'electron'
import { basename } from 'path'
import { setResourceDetectionAPI } from '@tabtin/action-tools/runtime'
import type { ParseStreamOutput } from '@tabtin/action-tools/types'
import { getViewFactory } from '../view-factory'
import { isAliveWebContents } from '../crawl-view/utils'
import { getResourceDetectionService } from './ResourceDetectionService'
import { getResourceHubService } from './ResourceHubService'
import { getMediaProbeService } from './MediaProbeService'
import { getM3U8Parser } from './M3U8Parser'
import { getMPDParser } from './MPDParser'
import { getStreamDownloadService } from './StreamDownloadService'
import type { StreamDownloadQuality } from './StreamDownloadService'
import { getResourceDownloadService } from './ResourceDownloadService'
import { resolveResourceRequestSession } from './resourceRequestContext'
import type { StreamProgressEvent } from '@shared/types/download'
import { DOWNLOAD_MESSAGES } from '../download-messages'
import { getDownloadManager } from '../download-manager'
import { notificationService } from './notification'
import { createLogger } from '../logger'

const log = createLogger('ActionBridge:Resource')

// ---------------------------------------------------------------------------
// Context: 由 FrontendActionBridge 在初始化时传入，避免直接依赖 class 实例
// ---------------------------------------------------------------------------

export interface ResourceActionContext {
  getMainWindow: () => BrowserWindow | null
  ensureStreamProgressForwarding: () => void
}

let currentResourceActionContext: ResourceActionContext | null = null

// ---------------------------------------------------------------------------
// 内部辅助函数
// ---------------------------------------------------------------------------

export async function probeResourcesForView(viewId: string) {
  //  Phase 3: 容器无关取页面 WebContents（WCV 与 webview guest 通吃）
  const wc = getViewFactory().getWebContents(viewId)
  if (!isAliveWebContents(wc)) {
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

function resolveResourceContext(input: { viewId?: string; crawlTabId?: string; resourceId?: string; url?: string }) {
  const hub = getResourceHubService()
  const explicitViewId = input.viewId || input.crawlTabId
  if (explicitViewId) {
    return {
      viewId: explicitViewId,
      resource: hub.resolveResource(explicitViewId, {
        resourceId: input.resourceId,
        url: input.url
      })
    }
  }

  if (input.resourceId) {
    const found = hub.findResourceLocation(input.resourceId)
    if (found) {
      return found
    }
  }

  return { viewId: undefined as string | undefined, resource: null as any }
}

function resolveTargetUrlOrError(
  input: { resourceId?: string; url?: string },
  resource?: { url?: string | null } | null
): { targetUrl?: string; error?: string } {
  const targetUrl = resource?.url || input.url
  if (targetUrl) {
    return { targetUrl }
  }
  if (input.resourceId) {
    return { error: `Resource not found: ${input.resourceId}` }
  }
  return { error: 'resourceId or url is required' }
}

function getResourceActionContext() {
  return currentResourceActionContext
}

async function captureResourceInPage(viewId: string, url: string, resource?: any) {
  //  Phase 3: 容器无关取页面 WebContents（WCV 与 webview guest 通吃）
  const wc = getViewFactory().getWebContents(viewId)
  if (!isAliveWebContents(wc)) {
    throw new Error(`View not found: ${viewId}`)
  }

  // E2E-005 同款白名单：防止恶意 URL 注入任意 JS。blob:/data: 必须放行——
  // 页面绑定的 blob 资源（page_bound_blob）只能在创建它的页面里 fetch 捕获，
  // 这正是本函数存在的主要场景。
  const isSafeUrl = /^https?:\/\//i.test(url) || /^blob:/i.test(url) || /^data:/i.test(url)
  if (!isSafeUrl) {
    throw new Error(`Unsupported URL scheme for resource capture: ${url.slice(0, 30)}`)
  }

  const targetUrl = JSON.stringify(url)
  const raw = await wc.executeJavaScript(`
    (async () => {
      const targetUrl = ${targetUrl};
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
    })()
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

async function handleCaptureResource(input: { resourceId?: string; url?: string; viewId?: string; crawlTabId?: string; force?: boolean }) {
  try {
    const { viewId, resource } = resolveResourceContext(input)
    const { targetUrl, error } = resolveTargetUrlOrError(input, resource)
    if (error) {
      return { success: false, error }
    }
    if (!viewId || !targetUrl) {
      return { success: false, error: 'resourceId/url + viewId is required for capture_resource' }
    }

    if (resource?.contentRef && !input.force) {
      return { success: true, data: { resource, captured: false } }
    }

    const captured = await captureResourceInPage(viewId, targetUrl, resource)
    return {
      success: true,
      data: {
        resource: captured,
        captured: true
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * handleDownloadResource — 资源下载共享核心逻辑。
 *
 * 由 Agent 工具桥（setResourceDetectionAPI）和 crawlspace/ipc 的
 * `resourceDetection:downloadResource` / `downloadBatch` 共同调用——
 * 与 parseStreamCore / handleDownloadStream 的复用方式一致。
 * 成功路径统一登记进 DownloadManager 账本，别再另起本地拷贝，
 * 否则会重演「Agent 路径登记了、UI 路径漏了」的断层。
 */
export async function handleDownloadResource(input: {
  resourceId?: string
  url?: string
  filename?: string
  headers?: Record<string, string>
  viewId?: string
  crawlTabId?: string
}) {
  try {
    const hub = getResourceHubService()
    const downloadService = getResourceDownloadService()
    let { viewId, resource } = resolveResourceContext(input)
    const { targetUrl, error } = resolveTargetUrlOrError(input, resource)

    if (error || !targetUrl) {
      return { success: false, error: error || 'resourceId or url is required' }
    }

    if ((!resource || !resource.contentRef) && viewId && (targetUrl.startsWith('blob:') || resource?.captureStatus === 'page_bound_blob')) {
      resource = await captureResourceInPage(viewId, targetUrl, resource)
    }

    let result
    if (resource?.contentRef) {
      result = await downloadService.saveCapturedContent({
        url: resource.url,
        filename: input.filename,
        mimeType: resource.mimeType,
        contentRef: resource.contentRef
      })
    } else if (targetUrl.startsWith('data:')) {
      // renderer blob/data 预览下载：静默落到 ~/Downloads/TabTin，与 https 主进程路径一致，
      // 避免 saveExportBlob 弹「存储为」造成 Agent / IM 手感不一致。
      result = await downloadService.saveCapturedContent({
        url: targetUrl,
        filename: input.filename,
        contentRef: { kind: 'data_url', data: targetUrl },
      })
    } else {
      const mergedHeaders = {
        ...(resource?.requestHeaders || {}),
        ...(input.headers || {})
      }
      const requestSession = resolveResourceRequestSession({ viewId, resource })
      result = await downloadService.download({
        url: targetUrl,
        filename: input.filename,
        headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
        requestSession,
      })
    }

    let updatedResource = resource
    if (viewId) {
      updatedResource = hub.markDownloaded(
        viewId,
        { resourceId: resource?.resourceId, url: resource?.url || targetUrl },
        result
      ) ?? updatedResource
    }

    // 登记进「下载管理」账本——ResourceDownloadService 不经 will-download，
    // 不登记的话下载成功但下载管理页无记录。登记失败不影响下载本身。
    try {
      getDownloadManager().trackExternalDownload({
        url: resource?.url || targetUrl,
        savePath: result.filePath,
        size: result.size,
        mimeType: result.mimeType,
        viewId,
      })
    } catch (trackError) {
      log.warn('登记外部下载到 DownloadManager 失败（不影响下载结果）:', trackError)
    }

    return {
      success: true,
      data: {
        ...result,
        resourceId: updatedResource?.resourceId
      }
    }
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

/**
 * parseStreamCore — DASH / HLS 流解析共享核心逻辑。
 *
 * 由 resource-actions 和 crawlspace/ipc 共同调用。
 * 不做输入验证和 try/catch，调用方自行处理。
 */
export async function parseStreamCore(input: {
  targetUrl: string
  category?: string
  headers?: Record<string, string>
  requestSession?: Electron.Session
  viewId?: string
  resourceId?: string
}): Promise<ParseStreamOutput> {
  const { targetUrl, category, viewId, resourceId } = input
  const hub = getResourceHubService()
  const headersArg = input.headers && Object.keys(input.headers).length > 0
    ? input.headers
    : undefined

  if (category === 'dash' || /\.mpd(\?|#|$)/i.test(targetUrl)) {
    const mpdParser = getMPDParser()
    const result = await mpdParser.fetchAndParse(
      targetUrl, headersArg, { requestSession: input.requestSession }
    )

    let resolvedResourceId = resourceId
    if (viewId) {
      const streamInfo = mpdParser.toStreamInfo(result)
      getResourceDetectionService().updateStreamInfo(viewId, targetUrl, streamInfo)
      const updated = hub.updateStreamInfo(viewId, { resourceId, url: targetUrl }, streamInfo)
      if (updated?.resourceId) resolvedResourceId = updated.resourceId
    }

    return {
      success: true,
      data: {
        streamType: 'dash',
        isMasterPlaylist: result.variants.length > 1,
        variants: result.variants.length > 0 ? result.variants : undefined,
        segments: result.segments.length > 0 ? result.segments : undefined,
        duration: result.duration || undefined,
        isLive: result.isLive,
        resourceId: resolvedResourceId,
        initSegmentUrl: result.initSegmentUrl,
        hasAudioTrack: Boolean(result.audioSegments?.segments?.length),
        isEncrypted: result.isEncrypted,
      }
    }
  }

  const parser = getM3U8Parser()
  const result = await parser.fetchAndParse(
    targetUrl, headersArg, { requestSession: input.requestSession }
  )

  let resolvedResourceId = resourceId
  if (viewId) {
    const streamInfo = parser.toStreamInfo(result)
    getResourceDetectionService().updateStreamInfo(viewId, targetUrl, streamInfo)
    const updated = hub.updateStreamInfo(viewId, { resourceId, url: targetUrl }, streamInfo)
    if (updated?.resourceId) resolvedResourceId = updated.resourceId
  }

  return {
    success: true,
    data: {
      streamType: 'hls' as const,
      isMasterPlaylist: result.isMasterPlaylist,
      variants: result.variants.length > 0 ? result.variants : undefined,
      segments: result.segments.length > 0 ? result.segments : undefined,
      duration: result.duration || undefined,
      isLive: result.isLive,
      isEncrypted: result.isEncrypted,
      resourceId: resolvedResourceId
    }
  }
}

async function handleParseStream(input: {
  resourceId?: string
  url?: string
  headers?: Record<string, string>
  viewId?: string
  crawlTabId?: string
}): Promise<ParseStreamOutput> {
  try {
    const { viewId, resource } = resolveResourceContext(input)
    const { targetUrl, error } = resolveTargetUrlOrError(input, resource)
    if (error || !targetUrl) {
      return { success: false, error: error || 'resourceId or url is required' }
    }

    return await parseStreamCore({
      targetUrl,
      category: resource?.category,
      headers: {
        ...(resource?.requestHeaders || {}),
        ...(input.headers || {})
      },
      requestSession: resolveResourceRequestSession({ viewId, resource }),
      viewId,
      resourceId: resource?.resourceId,
    })
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function ensureResourceProbe(viewId: string, forceProbe = false) {
  const hub = getResourceHubService()
  const summary = hub.getSummary(viewId)
  if (!forceProbe && summary.total > 0) {
    return hub
  }

  const { error } = await probeResourcesForView(viewId)
  if (error) {
    log.warn('MediaProbe 失败:', error)
  }
  return hub
}

function normalizeConcurrency(value: unknown, fallback = 3) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return fallback
  }
  return Math.max(1, Math.floor(value))
}

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
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

interface DownloadStreamActionInput {
  resourceId?: string
  url?: string
  quality?: string
  filename?: string
  outputPath?: string
  headers?: Record<string, string>
  concurrency?: number
  viewId?: string
  crawlTabId?: string
  signal?: AbortSignal
}

export async function handleDownloadStream(input: DownloadStreamActionInput) {
  const ctx = getResourceActionContext()
  if (!ctx) {
    return {
      success: false,
      downloadId: '',
      error: 'ResourceActionContext 尚未初始化，无法执行流下载'
    }
  }

  try {
    const service = getStreamDownloadService()
    const userFriendlyErrors = DOWNLOAD_MESSAGES.streamErrors
    const { viewId, resource } = resolveResourceContext(input)
    const { targetUrl, error } = resolveTargetUrlOrError(input, resource)
    if (error || !targetUrl) {
      return { success: false, downloadId: '', error: error || 'resourceId or url is required' }
    }

    ctx.ensureStreamProgressForwarding()
    const mergedHeaders = {
      ...(resource?.requestHeaders || {}),
      ...(input.headers || {})
    }
    const result = await service.download({
      url: targetUrl,
      quality: input.quality as StreamDownloadQuality,
      filename: input.filename,
      outputPath: input.outputPath,
      headers: Object.keys(mergedHeaders).length > 0 ? mergedHeaders : undefined,
      concurrency: input.concurrency,
      viewId,
      resource,
      signal: input.signal,
    })

    const mainWindow = ctx.getMainWindow()

    if (result.success && result.data) {
      const filename = basename(result.data.filePath)
      const sizeMB = (result.data.size / 1024 / 1024).toFixed(1)
      notificationService.show({
        type: 'download.completed',
        title: DOWNLOAD_MESSAGES.streamCompleted,
        body: `${filename} (${sizeMB} MB)`,
        priority: 'normal',
      })

      if (viewId) {
        getResourceHubService().markDownloaded(
          viewId,
          { resourceId: resource?.resourceId, url: targetUrl },
          result.data
        )
      }

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download:stream:completed', {
          downloadId: result.downloadId,
          ...result.data,
          name: filename,
          url: targetUrl,
          resourceId: resource?.resourceId
        })
      }
    } else if (!result.success) {
      const userMsg = result.errorCode
        ? userFriendlyErrors[result.errorCode] || result.error
        : result.error

      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('download:stream:failed', {
          downloadId: result.downloadId,
          url: targetUrl,
          resourceId: resource?.resourceId,
          error: userMsg,
          errorCode: result.errorCode
        })
      }

      return { ...result, error: userMsg }
    }

    return {
      ...result,
      data: result.data
        ? {
            ...result.data,
            resourceId: resource?.resourceId
          }
        : undefined
    }
  } catch (error) {
    return {
      success: false,
      downloadId: '',
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

async function fetchResourceData(input: {
  viewId: string
  probeMedia?: boolean
  hideSegments?: boolean
  category?: string
  captureStatus?: string
  capability?: string
  limit?: number
}) {
  try {
    const hub = await ensureResourceProbe(input.viewId, Boolean(input.probeMedia))
    const filter = {
      category: input.category as any,
      captureStatus: (input as any).captureStatus,
      capability: (input as any).capability,
      hideSegments: input.hideSegments,
    }
    const resources = hub.getResources(input.viewId, {
      ...filter,
      limit: input.limit
    })
    const summary = hub.getSummary(input.viewId, filter)
    return {
      success: true,
      data: {
        resources,
        summary,
        viewId: input.viewId,
        pageUrl: hub.getPageUrl(input.viewId)
      }
    }
  } catch (error) {
    return {
      success: false,
      data: { resources: [], summary: { total: 0, byCategory: {}, byCaptureStatus: {} }, viewId: input.viewId },
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

// ---------------------------------------------------------------------------
// 公开 API: 由 FrontendActionBridge 在构造阶段调用
// ---------------------------------------------------------------------------

export function setupResourceDetectionAPI(ctx: ResourceActionContext): void {
  currentResourceActionContext = ctx
  setResourceDetectionAPI({
    getResources: fetchResourceData,
    listResources: fetchResourceData,

    inspectResource: async (input) => {
      try {
        const { viewId, resource } = resolveResourceContext(input)
        if (!resource) {
          return { success: false, error: input.resourceId ? `Resource not found: ${input.resourceId}` : 'resourceId is required' }
        }
        return {
          success: true,
          data: { resource: viewId ? getResourceHubService().getResource(viewId, resource.resourceId) || resource : resource }
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

    captureResource: handleCaptureResource,

    downloadResource: handleDownloadResource,

    downloadBatch: async (input) => {
      try {
        const descriptors: Array<{ resourceId?: string; url?: string }> = []
        const resolvedViewId = input.viewId || (input as any).crawlTabId
        const resourceIds = input.resourceIds || []
        const urls = input.urls || []
        const concurrency = normalizeConcurrency(input.concurrency)

        for (const resourceId of resourceIds) {
          descriptors.push({ resourceId })
        }

        for (const url of urls) {
          descriptors.push({ url })
        }

        const settled = await mapWithConcurrency(
          descriptors,
          concurrency,
          (descriptor) => handleDownloadResource({
            ...descriptor,
            headers: input.headers,
            viewId: resolvedViewId
          })
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
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

    parseM3U8: handleParseStream,

    parseStream: handleParseStream,

    probeMedia: async (input) => {
      try {
        const { result, error } = await probeResourcesForView(input.viewId)
        if (!result) {
          return { success: false, error: error || `View not found: ${input.viewId}` }
        }

        return {
          success: true,
          data: {
            elements: result.elements.map(el => ({
              url: el.currentSrc || el.sources[0] || '',
              tagName: el.tagName,
              currentSrc: el.currentSrc,
              sources: el.sources,
              videoWidth: el.videoWidth,
              videoHeight: el.videoHeight,
              duration: el.duration,
              usesMediaSource: el.usesMediaSource,
            })),
            pageUrl: result.pageUrl,
            probeTimeMs: result.probeTimeMs,
            ...(result.error ? { error: result.error } : {})
          }
        }
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : String(error)
        }
      }
    },

    downloadStream: handleDownloadStream,
  })
}
