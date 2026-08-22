import http from 'node:http'
import { app } from 'electron'
import {
  handleBrowserAction,
  selectSmartDownloadTarget,
  getSharedBrowserJobManager,
  shutdownSharedBrowserJobManager,
  BrowserActionError,
  type SmartDownloadCandidate,
  type BrowserActionResult,
  type BrowserResourceStreamHooks,
  type BrowserOrchestratorHostHooks,
  type BrowserJobHooks,
} from '@tabtin/browser-core'
import { okResponse } from '@tabtin/agent-wire'
import type { SendJSON, ActionExecutor } from './_helpers'
import { buildBrowserRequestScope, resolveTabId, makeTaskId, sendExecutorResult, errorResponse, electronPolicyHooks } from './_helpers'
import { runWithBrowserApprovalContext } from '../../browser-policy-middleware'
import { probeResourcesForView } from '../../../services/resource-actions'
import { getResourceHubService } from '../../../services/ResourceHubService'
import { runElectronReplay } from './record'
import { runWithTabLock } from '../../../browser-tab-lock/runWithTabLock'

let electronJobShutdownHookRegistered = false

function ensureElectronJobShutdownHook(): void {
  if (electronJobShutdownHookRegistered) return
  electronJobShutdownHookRegistered = true
  app?.once('before-quit', () => {
    shutdownSharedBrowserJobManager()
  })
}

interface ElectronResourceStreamOptions {
  signal?: AbortSignal
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return
  const err = new Error('Browser job aborted')
  err.name = 'AbortError'
  throw err
}

function streamProgressToJobProgress(progress: any) {
  const completed = progress?.downloadedSegments ?? progress?.completed ?? 0
  const total = progress?.totalSegments ?? progress?.total ?? 0
  const percent = typeof progress?.percent === 'number'
    ? Math.max(0, Math.min(100, Math.round(progress.percent)))
    : (total > 0 ? Math.min(100, Math.round((completed / total) * 100)) : 0)
  return {
    phase: progress?.phase || 'downloading',
    percent,
    completed,
    total,
    detail: total > 0 ? `已下载 ${completed}/${total} 分片` : undefined,
  }
}

const normalizeRequestedTabId = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined

const resolveRouteTabId = async (
  rawTabId: unknown,
  body: any,
  options?: { allowImplicitActiveTab?: boolean }
): Promise<{ requestedTabId?: string; tabId?: string }> => {
  const scope = buildBrowserRequestScope(body)
  const requestedTabId = normalizeRequestedTabId(rawTabId)
  if (!requestedTabId) {
    if (!options?.allowImplicitActiveTab) {
      return {}
    }
    return { tabId: await resolveTabId('auto', scope) }
  }
  return { requestedTabId, tabId: await resolveTabId(requestedTabId, scope) }
}

// ─── BR-8 P3c③：resource/stream 编排收编进 browser-core Orchestrator ───────────
//
// 本文件原先逐 route 内联「解析 tabId → 校验 → executor → sendExecutorResult」；现退成
// 「查 actionId → handleBrowserAction(electronResourceStreamHooks) → 落地结果」。
// hook 与 interaction.ts 的 act/observe exec 解耦（经独立 `resourceStream` 注入点），故本文件
// 无需为满足 BrowserExecHooks 的 act/observe 必填项造哑实现、也无需改 interaction.ts。
//
// 多数 action 仍走 ActionExecutor + `sendExecutorResult`（保留 enhanceErrorResponse 的错误映射），
// 故 hook 返回 `electron-executor` 桥变体由 respondResourceAction 落地；probe / smart-download
// 自建响应（带 PROBE_FAILED / NO_MEDIA_FOUND 等显式 code），返回 ok/error 结果。
//
// legacy 别名 `/parse-m3u8`、`/download-stream` 的校验文案 / tab 解析（allowImplicit）/ executor
// type 与 canonical `/stream/parse`、`/stream/download` 现状**不同**，收敛会改行为；CLI 也只调
// canonical 路由（见 browser.go）。故 legacy 别名留旧内联逻辑（迁移缝），待后续允许行为变更切片再并。
// `/download`、`/download-batch` 不在本切片范围，同样留旧逻辑。

const TAB_REQUIRED_ERROR: BrowserActionResult = {
  ok: false,
  status: 400,
  error: {
    code: 'TAB_REQUIRED',
    message: '当前没有可用的浏览器标签，请先 open 一个页面或显式传入 --tab',
    suggestions: ['示例: tabtin browser open https://example.com', '或使用 tabtin browser tab list 查看可用浏览器标签'],
  },
}

function viewNotFoundError(requestedTabId: string): BrowserActionResult {
  return {
    ok: false,
    status: 400,
    error: {
      code: 'VIEW_NOT_FOUND',
      message: `找不到目标 tab: ${requestedTabId}`,
      suggestions: ['使用 tabtin browser tab list 查看可用标签', '确认传入的 --tab <viewId> 仍然存在'],
    },
  }
}

/** 把 executor 产出包成 electron-executor 桥变体（route 经 sendExecutorResult 落地，保留 enhanceErrorResponse）。 */
function executorBridge(result: any): BrowserActionResult {
  return { kind: 'electron-executor', executorResult: result }
}

/** 把 Orchestrator 结果用 Electron envelope 落地；executor 桥变体走 sendExecutorResult。 */
function respondResourceAction(res: http.ServerResponse, sendJSON: SendJSON, result: BrowserActionResult): void {
  // 用单一 `'kind' in result` 收窄 electron-executor 变体（不叠 `&& result.kind===...`，
  // 否则取反分支 TS 无法收窄成 ok/error 联合——P3c② interaction.ts/introspect.ts 踩过的坑）。
  if ('kind' in result) {
    sendExecutorResult(result.executorResult, res, sendJSON, { dataOverride: result.dataOverride })
    return
  }
  if (result.ok) {
    sendJSON(res, result.status, okResponse(result.data))
  } else {
    sendJSON(res, result.status, errorResponse(result.error.code as any, result.error.message, {
      suggestions: result.error.suggestions,
      retryable: result.error.retryable,
      detail: result.error.detail,
    }))
  }
}

/**
 * Electron 端 resource / stream 家族的「最后一公里」（BR-8 P3c③），注入 Orchestrator 的
 * `resourceStream` 注入点。每个 hook 逐字复刻原 route 分支：tabId 解析 / 必填校验 / VIEW_NOT_FOUND
 * / executor type+params / 响应落地，行为零变更。
 */
export function buildElectronResourceStreamHooks(executor: NonNullable<ActionExecutor>, opts: ElectronResourceStreamOptions = {}): BrowserResourceStreamHooks {
  return {
    async runResourceList(body: any): Promise<BrowserActionResult> {
      const { tabId } = await resolveRouteTabId(body?.tabId, body, { allowImplicitActiveTab: true })
      if (!tabId) return TAB_REQUIRED_ERROR
      const result: any = await executor({
        task_id: makeTaskId('resources'),
        type: 'list_resources',
        params: {
          crawlTabId: tabId,
          category: body?.category,
          captureStatus: body?.captureStatus,
          capability: body?.capability,
          limit: body?.limit,
          probeMedia: body?.probeMedia ?? false,
          hideSegments: body?.hideSegments ?? body?.hide_segments ?? true,
          ...(body?.runId ? { runId: body.runId } : {})
        },
        thread_id: '',
      })
      // 命令族统一 --compact：默认轻量（name/url/type/category/size 关键字段）；
      // --compact=false 给全字段。与 daemon runResourceList 口径一致。
      if (body?.compact === true && Array.isArray(result?.data?.resources)) {
        result.data = {
          ...result.data,
          resources: result.data.resources.map((r: any) => {
            const light: Record<string, unknown> = {}
            for (const k of ['name', 'url', 'type', 'category', 'size']) {
              if (r?.[k] !== undefined) light[k] = r[k]
            }
            return light
          }),
        }
      }
      return executorBridge(result)
    },

    async runResourceInspect(body: any): Promise<BrowserActionResult> {
      if (!body?.resourceId) {
        return { ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: '缺少 resourceId 参数' } }
      }
      const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body)
      if (requestedTabId && !tabId) return viewNotFoundError(requestedTabId)
      const result = await executor({
        task_id: makeTaskId('resource-inspect'),
        type: 'inspect_resource',
        params: { resourceId: body.resourceId, crawlTabId: tabId },
        thread_id: '',
      })
      return executorBridge(result)
    },

    async runResourceCapture(body: any): Promise<BrowserActionResult> {
      const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body)
      if (requestedTabId && !tabId) return viewNotFoundError(requestedTabId)
      const result = await executor({
        task_id: makeTaskId('resource-capture'),
        type: 'capture_resource',
        params: { resourceId: body?.resourceId, url: body?.url, crawlTabId: tabId, force: body?.force ?? false },
        thread_id: '',
      })
      return executorBridge(result)
    },

    async runResourceDownload(body: any): Promise<BrowserActionResult> {
      const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body)
      if (requestedTabId && !tabId) return viewNotFoundError(requestedTabId)
      const result = await executor({
        task_id: makeTaskId('resource-download'),
        type: 'download_resource',
        params: { resourceId: body?.resourceId, url: body?.url, filename: body?.filename, headers: body?.headers, crawlTabId: tabId },
        thread_id: '',
      })
      return executorBridge(result)
    },

    async runStreamParse(body: any): Promise<BrowserActionResult> {
      const url = body?.url
      if (!url && !body?.resourceId) {
        return { ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: '缺少 resourceId 或 url 参数' } }
      }
      const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body)
      if (requestedTabId && !tabId) return viewNotFoundError(requestedTabId)
      const result = await executor({
        task_id: makeTaskId('stream-parse'),
        type: 'parse_stream',
        params: { resourceId: body?.resourceId, url, headers: body?.headers, crawlTabId: tabId },
        thread_id: '',
      })
      return executorBridge(result)
    },

    async runStreamInfo(body: any): Promise<BrowserActionResult> {
      if (!body?.url && !body?.resourceId) {
        return { ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: '缺少 resourceId 或 url 参数' } }
      }
      const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body)
      if (requestedTabId && !tabId) return viewNotFoundError(requestedTabId)
      const result = await executor({
        task_id: makeTaskId('stream-info'),
        type: 'parse_stream',
        params: { resourceId: body?.resourceId, url: body?.url, headers: body?.headers, crawlTabId: tabId },
        thread_id: '',
      })
      return executorBridge(result)
    },

    async runStreamDownload(body: any): Promise<BrowserActionResult> {
      throwIfAborted(opts.signal)
      // BT-010: 与 /download-stream 保持一致，前置校验 url/resourceId 必填其一
      if (!body?.url && !body?.resourceId) {
        return { ok: false, status: 400, error: { code: 'VALIDATION_ERROR', message: '缺少 url 或 resourceId 参数', suggestions: ['示例: tabtin browser stream download --url "https://example.com/stream.m3u8"'] } }
      }
      const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body)
      if (requestedTabId && !tabId) return viewNotFoundError(requestedTabId)
      const result = await executor({
        task_id: makeTaskId('stream-download'),
        type: 'download_stream',
        params: {
          resourceId: body?.resourceId,
          url: body?.url,
          quality: body?.quality,
          filename: body?.filename,
          outputPath: body?.output ?? body?.outputPath ?? body?.output_path,
          headers: body?.headers,
          concurrency: body?.concurrency,
          crawlTabId: tabId,
          signal: opts.signal,
        },
        thread_id: '',
      })
      return executorBridge(result)
    },

    async runResourceProbe(body: any): Promise<BrowserActionResult> {
      const { tabId } = await resolveRouteTabId(body?.tabId, body, { allowImplicitActiveTab: true })
      if (!tabId) return TAB_REQUIRED_ERROR
      try {
        const { result, error } = await probeResourcesForView(tabId)
        if (error) {
          return { ok: false, status: 500, error: { code: 'PROBE_FAILED', message: error } }
        }
        const hub = getResourceHubService()
        // 无 --limit：返回全部探测到的资源，不做有损截断。
        const resources = hub.getResources(tabId)
        const summary = hub.getSummary(tabId)
        return {
          ok: true,
          status: 200,
          data: {
            probeResult: {
              elementCount: result?.elements?.length ?? 0,
              pageUrl: result?.pageUrl,
              probeTimeMs: result?.probeTimeMs,
            },
            resources,
            summary,
          },
        }
      } catch (err) {
        return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } }
      }
    },

    async runResourceSmartDownload(body: any): Promise<BrowserActionResult> {
      throwIfAborted(opts.signal)
      const { tabId } = await resolveRouteTabId(
        body?.tabId ?? body?.tab_id,
        body,
        { allowImplicitActiveTab: true }
      )
      if (!tabId) return TAB_REQUIRED_ERROR

      const quality = body?.quality || 'best'
      const category: string | undefined = body?.category

      try {
        await probeResourcesForView(tabId)
        throwIfAborted(opts.signal)

        const hub = getResourceHubService()
        // 无 --limit：扫描全部资源，不做有损截断。
        const allResources: any[] = hub.getResources(tabId)

        // 挑选规则与下载策略判定收敛到 browser-core（与 Daemon 共用同一份，永不漂移）。
        const selection = selectSmartDownloadTarget(allResources as SmartDownloadCandidate[], { category })

        if (!selection) {
          return {
            ok: false,
            status: 404,
            error: {
              code: 'NO_MEDIA_FOUND',
              message: 'No downloadable media found on this page',
              detail: { resourceCount: allResources.length, probed: true },
              suggestions: ['确保页面上有视频或音频内容', '尝试手动播放视频后重新探测'],
            },
          }
        }

        const target = selection.target as any

        let downloadResult: any
        if (selection.strategy === 'stream') {
          downloadResult = await executor({
            task_id: makeTaskId('smart-dl-stream'),
            type: 'download_stream',
            params: {
              resourceId: target.resourceId,
              crawlTabId: tabId,
              quality,
              outputPath: body?.output ?? body?.outputPath ?? body?.output_path,
              signal: opts.signal,
            },
            thread_id: '',
          })
        } else if (selection.strategy === 'capture-then-download') {
          throwIfAborted(opts.signal)
          const captureResult = await executor({
            task_id: makeTaskId('smart-dl-capture'),
            type: 'capture_resource',
            params: { resourceId: target.resourceId, crawlTabId: tabId, force: true },
            thread_id: '',
          })
          if (!captureResult?.success) {
            return {
              ok: false,
              status: 500,
              error: {
                code: 'CAPTURE_FAILED',
                message: captureResult?.error || 'Failed to capture page-bound resource',
                detail: { targetResource: { resourceId: target.resourceId, category: target.category, url: target.url, captureStatus: target.captureStatus } },
              },
            }
          }
          throwIfAborted(opts.signal)
          downloadResult = await executor({
            task_id: makeTaskId('smart-dl-resource'),
            type: 'download_resource',
            params: { resourceId: target.resourceId, crawlTabId: tabId },
            thread_id: '',
          })
        } else {
          throwIfAborted(opts.signal)
          downloadResult = await executor({
            task_id: makeTaskId('smart-dl-resource'),
            type: 'download_resource',
            params: { resourceId: target.resourceId, crawlTabId: tabId },
            thread_id: '',
          })
        }

        const targetInfo = {
          resourceId: target.resourceId,
          category: target.category,
          url: target.url,
          captureStatus: target.captureStatus,
        }

        if (downloadResult?.success === true) {
          return {
            ok: true,
            status: 200,
            data: {
              ...(downloadResult?.data || {}),
              targetResource: targetInfo,
            },
          }
        }
        return {
          ok: false,
          status: 500,
          error: {
            code: 'DOWNLOAD_FAILED',
            message: downloadResult?.error || 'Download failed',
            detail: { targetResource: targetInfo },
          },
        }
      } catch (err) {
        return { ok: false, status: 500, error: { code: 'INTERNAL_ERROR', message: err instanceof Error ? err.message : String(err) } }
      }
    },
  }
}

/**
 * Electron 端长任务异步执行 + 取消的「最后一公里」（BR-10 P2）。
 *
 * `manager` 用 browser-core 进程级共享单例（供 job status/cancel 端点查询与中止）；`execute` 复用
 * resource/stream 的**同步 hook** 跑长任务（经渲染进程 ActionExecutor），把结果落进 job。
 *
 * Electron 的 stream downloader 已接收 AbortSignal：cancel 会中断后续分片请求和合并写入；
 * 非 stream 的 direct download 仍只能在步骤边界 best-effort 停止。
 */
export function buildElectronJobHooks(executor: NonNullable<ActionExecutor>): BrowserJobHooks {
  ensureElectronJobShutdownHook()
  return {
    manager: getSharedBrowserJobManager(),
    async execute(actionId, body, ctx): Promise<unknown> {
      const streamHooks = buildElectronResourceStreamHooks(executor, { signal: ctx.signal })
      let result: BrowserActionResult
      if (actionId === 'stream.download') {
        ctx.reportProgress({ phase: 'starting', percent: 0 })
        result = await streamHooks.runStreamDownload!(body)
      } else if (actionId === 'resource.smart-download') {
        ctx.reportProgress({ phase: 'starting', percent: 0 })
        result = await streamHooks.runResourceSmartDownload!(body)
      } else if (actionId === 'replay.run') {
        return runElectronReplay(body, executor, {
          signal: ctx.signal,
          reportProgress: ctx.reportProgress,
        })
      } else {
        throw new BrowserActionError(400, { code: 'VALIDATION_ERROR', message: `job 暂不支持异步执行 action: ${actionId}` })
      }
      ctx.reportProgress(streamProgressToJobProgress((result as any)?.data ?? (result as any)?.executorResult?.data ?? {}))
      // electron-executor 桥变体：成功取 data 落 job.result，失败抛错落 job.error。
      if ('kind' in result) {
        const exec = result.executorResult
        if (exec?.success === false) {
          throw new BrowserActionError(500, {
            code: 'INTERNAL_ERROR',
            message: (typeof exec?.error === 'string' ? exec.error : undefined) || '下载失败',
          })
        }
        return result.dataOverride ?? exec?.data ?? exec
      }
      if (result.ok) return result.data
      throw new BrowserActionError(result.status, result.error)
    },
  }
}

/**
 * resource/stream 路由 → 能力 actionId。legacy 别名 `/parse-m3u8`、`/download-stream` 与
 * `/download`、`/download-batch` 不在此表，保留旧内联逻辑（见上方说明）。
 */
const RESOURCE_STREAM_ROUTES: Record<string, string> = {
  '/resources': 'resource.list',
  '/resource/inspect': 'resource.inspect',
  '/resource/capture': 'resource.capture',
  '/resource/download': 'resource.download',
  '/resource/probe': 'resource.probe',
  '/resource/smart-download': 'resource.smart-download',
  '/stream/parse': 'stream.parse',
  '/stream/info': 'stream.info',
  '/stream/download': 'stream.download',
}

export async function handleResourcesRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {

  // ── resource / stream（BR-8 P3c③：编排收编进 browser-core Orchestrator）──
  const resourceStreamAction = RESOURCE_STREAM_ROUTES[route]
  if (resourceStreamAction) {
    const hostHooks: BrowserOrchestratorHostHooks = {
      runtime: 'electron',
      resourceStream: buildElectronResourceStreamHooks(executor),
      // BR-9/BR-30：resource.*/stream.* contract risk=read；普通下载仍 allow，但媒体下载护栏
      // 命中风险信号（临时签名 URL / 跨站 / 大文件 / 需会话）时升级为 confirm → 经 policy 弹审批
      // （CLI middleware 已预授权时不二次弹），故必须注入 policy，否则 confirm 会 fail-closed 403。
      policy: electronPolicyHooks,
      // BR-10 P2：接 jobs 钩子 → stream.download / resource.smart-download 传 --async 时返回 202 + jobId
      // （默认仍同步，零行为变更）。
      jobs: buildElectronJobHooks(executor),
    }
    const { tabId } = await resolveRouteTabId(
      body?.tabId ?? body?.tab_id,
      body,
      { allowImplicitActiveTab: true },
    )
    const result = await runWithBrowserApprovalContext(
      body,
      () => runWithTabLock(
        tabId,
        () => handleBrowserAction(resourceStreamAction, body, hostHooks),
        typeof body?._thread_id === 'string' ? body._thread_id : undefined,
      ),
    )
    if (result) {
      respondResourceAction(res, sendJSON, result)
      return true
    }
  }

  // ── /download（单文件直链下载，不在 P3c③ 范围，保留旧逻辑）────────────────────
  if (route === '/download') {
    const url = body?.url
    if (!url) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 url 参数', {
        suggestions: ['示例: tabtin browser resource download --url "https://example.com/file.zip"'],
      }))
      return true
    }
    const { tabId } = await resolveRouteTabId(body?.tabId, body, { allowImplicitActiveTab: true })
    const result = await executor({
      task_id: makeTaskId('download'),
      type: 'download_resource',
      params: { url, filename: body?.filename, headers: body?.headers, crawlTabId: tabId },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  // ── /download-batch（批量下载，不在 P3c③ 范围，保留旧逻辑）─────────────────────
  if (route === '/download-batch') {
    const urls = body?.urls
    const resourceIds = body?.resourceIds
    const hasUrls = Array.isArray(urls) && urls.length > 0
    const hasResourceIds = Array.isArray(resourceIds) && resourceIds.length > 0
    if (!hasUrls && !hasResourceIds) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 urls 数组参数', {
        suggestions: ['示例: tabtin browser resource download --url "https://example.com/file.zip"（CLI 逐个下载）'],
      }))
      return true
    }
    const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body, { allowImplicitActiveTab: !hasResourceIds })
    if (requestedTabId && !tabId) {
      sendJSON(res, 400, errorResponse('VIEW_NOT_FOUND', `找不到目标 tab: ${requestedTabId}`, {
        suggestions: ['使用 tabtin browser tab list 查看可用标签', '确认传入的 --tab <viewId> 仍然存在'],
      }))
      return true
    }
    const result = await executor({
      task_id: makeTaskId('download-batch'),
      type: 'download_batch',
      params: { resourceIds, urls, headers: body?.headers, concurrency: body?.concurrency ?? 3, crawlTabId: tabId },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  // ── /parse-m3u8（legacy 别名：校验文案 / allowImplicit / executor type 与 /stream/parse 不同，
  //    保留旧逻辑作迁移缝，零行为变更；CLI 用 /stream/parse）──────────────────────
  if (route === '/parse-m3u8') {
    const url = body?.url
    if (!url && !body?.resourceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 url 参数', {
        suggestions: ['示例: tabtin browser stream parse --url "https://example.com/stream.m3u8"'],
      }))
      return true
    }
    const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body, { allowImplicitActiveTab: !body?.resourceId })
    if (requestedTabId && !tabId) {
      sendJSON(res, 400, errorResponse('VIEW_NOT_FOUND', `找不到目标 tab: ${requestedTabId}`, {
        suggestions: ['使用 tabtin browser tab list 查看可用标签', '确认传入的 --tab <viewId> 仍然存在'],
      }))
      return true
    }
    const result = await executor({
      task_id: makeTaskId('parse-m3u8'),
      type: 'parse_m3u8',
      params: { resourceId: body?.resourceId, url, headers: body?.headers, crawlTabId: tabId },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  // ── /download-stream（legacy 别名：同 /parse-m3u8 理由，保留旧逻辑；CLI 用 /stream/download）──
  if (route === '/download-stream') {
    const url = body?.url
    if (!url && !body?.resourceId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 url 参数', {
        suggestions: ['示例: tabtin browser stream download --url "https://example.com/stream.m3u8"'],
      }))
      return true
    }
    const { requestedTabId, tabId } = await resolveRouteTabId(body?.tabId, body, { allowImplicitActiveTab: !body?.resourceId })
    if (requestedTabId && !tabId) {
      sendJSON(res, 400, errorResponse('VIEW_NOT_FOUND', `找不到目标 tab: ${requestedTabId}`, {
        suggestions: ['使用 tabtin browser tab list 查看可用标签', '确认传入的 --tab <viewId> 仍然存在'],
      }))
      return true
    }
    const result = await executor({
      task_id: makeTaskId('download-stream'),
      type: 'download_stream',
      params: {
        resourceId: body?.resourceId,
        url,
        quality: body?.quality,
        filename: body?.filename,
        headers: body?.headers,
        concurrency: body?.concurrency,
        crawlTabId: tabId
      },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  return false
}
