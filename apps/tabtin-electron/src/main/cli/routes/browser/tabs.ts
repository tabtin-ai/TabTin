import http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
import type { SendJSON, ActionExecutor } from './_helpers'
import {
  buildBrowserRequestScope, resolveTabId, resolveContextBrowserTabId, makeTaskId, sendExecutorResult, handleRouteError,
  requireBridgeAndSpace, errorResponse, getCLICrawlspaceId, isSafeUrl, resolveWorkspaceLocalHtmlOpen,
  validateViewExists,
} from './_helpers'
import { getCrawlspaceContextHub } from '../../../crawlspace/CrawlspaceContextHub'
import { getViewFactory } from '../../../view-factory/ViewFactory'
import { getRunSessionManager } from '../../../run-session/RunSessionManager'
import { getActiveSessionName } from '../../routes/session'
import { buildBrowserQuotaExceededOptions } from './quota-exceeded-payload'
import { verifyNavigationAgainstLivePage } from './navigation-evidence'
import { runObserveForOpen } from './interaction'
import { lock, unlock } from '../../../browser-tab-lock/browserTabInputLock'
import { payloadHasUserInterventionWall } from '../../../browser-tab-lock/wallSignal'

const CONTEXT_TAB_CLOSE_TIMEOUT_MS = 15_000

const GUEST_ATTACH_TIMEOUT_MS = 15_000
const GUEST_ATTACH_RECOVERY_TIMEOUT_MS = 5_000
const GUEST_ATTACH_POLL_MS = 150
const OPEN_LOAD_URL_TIMEOUT_MS = 30_000
const OPEN_LOAD_URL_MAX_TIMEOUT_MS = 90_000
const OPEN_LOAD_URL_TIMEOUT_GRACE_MS = 5_000

const isViewQuotaFailure = (message: string): boolean => (
  message.includes('最大 View 数限制') || message.includes('配额不足')
)

/**
 * 同一 Agent run 的默认重试必须回到它自己之前打开的页面：
 * - 只在可信 runId 已随 CLI 请求进入 scope 时生效；手动 browser open 仍保持新建页语义；
 * - 显式 --new-tab 可保留多页并行场景；
 * - 只复用带相同 runId 的非关闭页，不按 URL 做猜测性去重。
 */
function findReusableRunViewId(requestScope: ReturnType<typeof buildBrowserRequestScope>): string | undefined {
  const runId = requestScope.runId
  if (!runId) return undefined

  try {
    const hub = getCrawlspaceContextHub()
    const preferredCrawlspaceId = requestScope.crawlspaceId || getCLICrawlspaceId()
    // CLI 刚切换 Workspace 时，main 侧 crawlspace context 可能还没同步；runId
    // 是跨 snapshot 的唯一归属，故优先当前 scope、未命中再扫 hub 全量快照。
    const snapshots = preferredCrawlspaceId
      ? [hub.getSnapshot(preferredCrawlspaceId), ...hub.getAllSnapshots()]
      : hub.getAllSnapshots()
    for (const snapshot of snapshots) {
      const views = snapshot?.views?.filter(view => view.runId === runId && !view.isClosing) ?? []
      if (views.length === 0) continue
      const activeRunView = views.find(view => view.viewId === snapshot?.activeViewId)
      return activeRunView?.viewId || views.at(-1)?.viewId
    }
    return undefined
  } catch {
    return undefined
  }
}

/**
 * : 等待新建 tab 的 WebContents 在主进程 ViewFactory 就绪。
 *
 * webview 容器模式下 create_web_tab 只在 store/hub 登记 + 激活 UI，guest
 * WebContents 要等 renderer 挂载 <webview>（did-attach → adoptWebviewGuest）
 * 后才进 ViewFactory——bridge 返回后立刻 load_tab_url 会命中 "View not found"，
 * 得到 ok:true + navigation 失败的假错（页面稍后经 webview src 自行加载）。
 * WCV 容器 createView 同步建好 WebContents，首次检查即命中、零额外延迟。
 *
 * 事件驱动为主（view:created=WCV / view:registered=webview guest 收养），
 * 轮询兜底覆盖订阅前一瞬完成收养的间隙。
 */
async function waitForViewWebContents(
  viewId: string,
  timeoutMs: number = GUEST_ATTACH_TIMEOUT_MS,
): Promise<boolean> {
  const factory = getViewFactory()
  const ready = (): boolean => {
    try {
      const wc = factory.getWebContents(viewId) as { isDestroyed?: () => boolean } | null
      return !!wc && (typeof wc.isDestroyed !== 'function' || !wc.isDestroyed())
    } catch {
      return false
    }
  }
  if (ready()) return true

  return new Promise<boolean>((resolve) => {
    let poller: ReturnType<typeof setInterval> | undefined
    let deadline: ReturnType<typeof setTimeout> | undefined
    let done = false
    const onViewEvent = (payload?: { id?: string }): void => {
      if (payload?.id === viewId && ready()) settle(true)
    }
    const settle = (ok: boolean): void => {
      if (done) return
      done = true
      if (poller) clearInterval(poller)
      if (deadline) clearTimeout(deadline)
      factory.off('view:created', onViewEvent)
      factory.off('view:registered', onViewEvent)
      resolve(ok)
    }
    factory.on('view:created', onViewEvent)
    factory.on('view:registered', onViewEvent)
    poller = setInterval(() => { if (ready()) settle(true) }, GUEST_ATTACH_POLL_MS)
    deadline = setTimeout(() => settle(false), timeoutMs)
  })
}

/**
 * 新建 tab 的 attach 慢属于 webview 容器内部生命周期，不该暴露成 Agent
 * 要手写 `tab list → sleep → open --tab-id` 的业务步骤。先保留既有 15s
 * 主窗口，再用一个短 grace 窗口吸收刚越过边界才收养完成的 guest。
 */
async function waitForNewTabWebContents(viewId: string): Promise<boolean> {
  if (await waitForViewWebContents(viewId, GUEST_ATTACH_TIMEOUT_MS)) return true
  return waitForViewWebContents(viewId, GUEST_ATTACH_RECOVERY_TIMEOUT_MS)
}

/**
 * 向当前活跃 tab 实时求证：eval 抓页面全部 a[href]（含站点签名参数），供导航守卫按「页面真相」判定。
 * 无同站活跃 tab / eval 失败时返回 undefined（守卫维持原判，不误放行）。
 */
async function fetchLiveAnchorsFromActiveTab(
  executor: NonNullable<ActionExecutor>,
  body: any,
): Promise<{ pageUrl: string; hrefs: string[] } | undefined> {
  // 用 active_or_first（传 undefined 而非 'auto'）：'auto' 是严格 active_only，
  // CLI 上下文常解析不到活跃 tab；active_or_first 会回退到第一个可见浏览器 tab，
  // 即「Agent 当前在看的页」，正是要向它求证真实链接的那一页。
  const tabId = await resolveTabId(undefined, buildBrowserRequestScope(body))
  if (!tabId) return undefined
  // 向该标签 eval 求证真实链接，属于「使用这个标签」——盖膜，不按命令种类分流。
  lock(tabId, typeof body?._thread_id === 'string' ? body._thread_id : undefined)

  const evalResult = await executor({
    task_id: makeTaskId('nav-verify'),
    type: 'eval',
    params: {
      code: `JSON.stringify({ url: window.location.href, hrefs: Array.from(document.querySelectorAll('a[href]')).map(a => a.href) })`,
      crawlTabId: tabId,
      ...(body?.runId ? { runId: body.runId } : {}),
    },
    thread_id: '',
  })
  if (evalResult?.success === false) return undefined

  const raw = (evalResult as any)?.data?.result ?? (evalResult as any)?.result ?? (evalResult as any)?.data
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    if (parsed && typeof parsed.url === 'string' && Array.isArray(parsed.hrefs)) {
      return { pageUrl: parsed.url, hrefs: parsed.hrefs.filter((h: unknown): h is string => typeof h === 'string') }
    }
  } catch {
    // eval 结果非预期形态 → 无法求证
  }
  return undefined
}

type RawBrowserTab = {
  id?: string
  viewId?: string
  type?: string
  tabKey?: string
  title?: string
  meta?: {
    url?: string
    favicon?: string
  } | null
}

type SnapshotBrowserView = {
  viewId: string
  title?: string
  url?: string
  favicon?: string
  isClosing?: boolean
}

type BrowserTabSummary = {
  id: string
  viewId: string
  /** BR-11 主字段：与输入 flag `--tab-id` 同名，值 = 纯 viewId（不带 tabweb: 前缀）。 */
  tabId: string
  /**
   * @deprecated 选 Tab 请用 `tabId`（纯 viewId，对应 `--tab-id`）。
   * tabKey（值形如 `tabweb:<viewId>`）保留仅为兼容既有消费方，勿据它拼 CLI 参数。
   */
  tabKey: string
  type: 'tabweb'
  title?: string
  url?: string
  favicon?: string
  /**
   * ：主进程是否真实存在该 tab 的网页进程（WebContents）。
   * false = 仅登记未挂载（webview 模式 guest 尚未 attach，或已被 discard）——
   * 此时 url/title 来自登记数据，不代表页面已加载；glance/act/state 会失败。
   */
  attached: boolean
}

function readString(body: any, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = body?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function readPositiveNumber(body: any, ...keys: string[]): number | undefined {
  for (const key of keys) {
    const value = Number(body?.[key])
    if (Number.isFinite(value) && value > 0) return Math.floor(value)
  }
  return undefined
}

function buildLoadUrlParams(
  body: any,
  viewId: string,
  url: string,
  localPreviewRoot?: string,
): Record<string, unknown> {
  const waitUntil = readString(body, 'waitUntil', 'wait_until')
  const waitForSelector = readString(body, 'waitForSelector', 'wait_selector')
  return {
    viewId,
    url,
    crawlTabId: viewId,
    ...(waitUntil && ['load', 'domcontentloaded', 'networkidle', 'settled'].includes(waitUntil) ? { waitUntil } : {}),
    ...(readPositiveNumber(body, 'timeout') ? { timeout: readPositiveNumber(body, 'timeout') } : {}),
    ...(waitForSelector ? { waitForSelector } : {}),
    ...(readPositiveNumber(body, 'waitForTimeout', 'wait_for_timeout') ? { waitForTimeout: readPositiveNumber(body, 'waitForTimeout', 'wait_for_timeout') } : {}),
    ...(localPreviewRoot ? { localPreviewRoot } : {}),
  }
}

function getOpenLoadUrlTimeoutMs(body: any): number {
  const requestedTimeoutMs = readPositiveNumber(body, 'timeout')
  if (!requestedTimeoutMs) return OPEN_LOAD_URL_TIMEOUT_MS
  return Math.min(requestedTimeoutMs + OPEN_LOAD_URL_TIMEOUT_GRACE_MS, OPEN_LOAD_URL_MAX_TIMEOUT_MS)
}

async function runLoadTabUrlForOpen(
  executor: NonNullable<ActionExecutor>,
  body: any,
  viewId: string,
  targetUrl: string,
  localPreviewRoot?: string,
): Promise<any> {
  const timeoutMs = getOpenLoadUrlTimeoutMs(body)
  const start = Date.now()
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      executor({
        task_id: makeTaskId('load-url'),
        type: 'load_tab_url',
        params: buildLoadUrlParams(body, viewId, targetUrl, localPreviewRoot),
        thread_id: '',
      }),
      new Promise((resolve) => {
        timeout = setTimeout(() => {
          const end = Date.now()
          resolve({
            success: false,
            data: {
              status: 'timeout',
              finalUrl: targetUrl,
              timing: { start, end, duration: end - start },
            },
            error: {
              code: 'CONNECTION_TIMEOUT',
              message: `browser open 导航执行超过 ${timeoutMs / 1000}s，已在 CLI transport 超时前中止等待`,
              retryable: true,
              detail: {
                viewId,
                tabId: viewId,
                url: targetUrl,
                timeoutMs,
              },
            },
          })
        }, timeoutMs)
      }),
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

function sendOpenResult(
  res: http.ServerResponse,
  sendJSON: SendJSON,
  baseData: Record<string, unknown>,
  loadResult: any,
  observation?: Record<string, unknown>,
): void {
  const navigation = {
    success: loadResult?.success !== false,
    recoverable: loadResult?.success === false,
    ...(loadResult?.data || {}),
    ...(loadResult?.error ? { error: loadResult.error } : {}),
  }
  sendJSON(res, 200, okResponse({
    ...baseData,
    ...(loadResult?.data || {}),
    navigation,
    ...(observation || {}),
  }))
}

/**
 * open 是否内嵌观察：默认开；`--observe=false` 显式关（脚本化场景省输出），
 * 普通导航失败时跳过；load 执行超时例外，因为页面可能已被 webview src 加载到可观察状态。
 */
function shouldEmbedObservation(body: any, loadResult: any): boolean {
  return body?.observe !== false && (
    loadResult?.success !== false ||
    loadResult?.error?.code === 'CONNECTION_TIMEOUT'
  )
}

function lockOpenedTab(
  tabId: string,
  loadResult: unknown,
  observation: Record<string, unknown> | undefined,
  sessionId?: string,
): void {
  lock(tabId, sessionId)
  if (payloadHasUserInterventionWall({
    ...(loadResult as Record<string, unknown>),
    data: {
      ...((loadResult as { data?: Record<string, unknown> })?.data ?? {}),
      ...observation,
    },
  })) {
    unlock(tabId)
  }
}

export async function handleTabsRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  const requestScope = buildBrowserRequestScope(body)

  if (route === '/open') {
    const rawTargetUrl = body?.url
    if (!rawTargetUrl) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 url 参数', {
        suggestions: ['示例: tabtin browser open --url https://example.com'],
      }))
      return true
    }

    // ：工作空间内 HTML 允许 file:// / 相对路径预览（需带 localPreviewRoot）。
    // 这与「打开 HTML 源码文件」的 present_to_user local_file / TabFiles 路径分开——browser open = 渲染预览。
    const localHtml = resolveWorkspaceLocalHtmlOpen(
      typeof rawTargetUrl === 'string' ? rawTargetUrl : String(rawTargetUrl),
    )
    let targetUrl = typeof rawTargetUrl === 'string' ? rawTargetUrl : String(rawTargetUrl)
    let localPreviewRoot: string | undefined
    let openTitle = typeof body?.title === 'string' && body.title.trim() ? body.title : undefined
    if (localHtml) {
      if (!localHtml.ok) {
        sendJSON(res, 400, errorResponse('VALIDATION_ERROR', localHtml.message, {
          suggestions: [
            '先确认当前已进入工作空间，且文件落在工作目录内',
            '本地预览仅支持 .html / .htm：相对路径 tabtin browser open --url attachments/a.html',
            '或 shell 内绝对路径：tabtin browser open --url "file://$TABTIN_WORKSPACE/attachments/a.html"',
            '若要打开 HTML 源码文件（非渲染预览），用 present_to_user 的 local_file item',
          ],
        }))
        return true
      }
      targetUrl = localHtml.url
      localPreviewRoot = localHtml.localPreviewRoot
      if (!openTitle) openTitle = localHtml.title
    } else if (!isSafeUrl(targetUrl)) {
      sendJSON(res, 400, errorResponse(
        'VALIDATION_ERROR',
        `不允许的 URL 协议: ${targetUrl}。仅支持 http/https，或当前工作空间内的本地 HTML（file:// / 相对路径）`,
        {
          suggestions: [
            '使用 https:// 或 http:// 开头的 URL',
            '本地 HTML 预览：tabtin browser open --url path/a.html（相对工作目录根；须在工作目录内）',
            '打开 HTML 源码文件请用 present_to_user 的 local_file item，不要用 browser open',
          ],
        },
      ))
      return true
    }

    // 守卫事实源 = 页面此刻真的有什么：已记录未命中时，向当前 tab 实时抓一次真实 a[href] 再判。
    // 这样 eval 采集的、observe 截断在 50 之外的、乃至没感知过的链接，只要真在 DOM 里就放行；
    // 凭空猜的 URL（不在 DOM）仍拦。本地 HTML 预览不走二级页反幻觉守卫。
    //
    // `skipNavigationEvidenceCheck`：仅可信内部调用方（如 /reach 适配器按平台契约拼
    // `/video/<id>`）可开。Agent 面的 `tabtin browser open` 不得传此字段——反幻觉守卫仍生效。
    const skipNavigationEvidenceCheck =
      body?.skipNavigationEvidenceCheck === true ||
      body?.skip_navigation_evidence_check === true
    if (!localPreviewRoot && !skipNavigationEvidenceCheck) {
      const unverifiedNavigation = await verifyNavigationAgainstLivePage(
        targetUrl,
        () => fetchLiveAnchorsFromActiveTab(executor, body),
      )
      if (unverifiedNavigation) {
        // 有同 host+path 的已验证链接（仅 query 差异，多为签名参数被改写）时，
        // 直接在 message 正文给出可照抄的完整 href——Agent 只能稳定看到 message。
        const samePathHref = unverifiedNavigation.verifiedHrefsSamePath[0]
        const message = samePathHref
          ? `拒绝打开未在页面中观测到的二级页 URL: ${targetUrl}。该 path 存在已验证链接（勿改写 query 参数），请改用: ${samePathHref}`
          : `拒绝打开未在页面中观测到的二级页 URL: ${targetUrl}`
        sendJSON(res, 400, errorResponse('UNVERIFIED_NAVIGATION_URL', message, {
          detail: unverifiedNavigation,
          suggestions: [
            '不要猜测 /invest、/venture、/project 等路径，也不要改写/拼接页面链接的 query 参数（会丢失站点签名参数）',
            '用 tabtin browser glance --tab-id <tabId> 重新观测当前页，照抄 observed_elements[].href 里的完整链接去 open',
            `如果目标是页面上的无 href 导航文字（见 detail.labelsWithoutHref），它本身就可点击：先 tabtin browser glance 拿到该条目的 ref，再 tabtin browser act --actions '[{"type":"click","ref":"<eN>"}]'；仍找不到入口再用 web_search 查官方 URL`,
          ],
        }))
        return true
      }
    }

    const requestedProfile = typeof body?.profile === 'string' ? body.profile : 'agent-workspace'
    if (requestedProfile !== 'agent-workspace') {
      sendJSON(res, 400, errorResponse(
        'VALIDATION_ERROR',
        `browser open 当前仅支持 agent-workspace profile，收到: ${requestedProfile}`,
        {
          suggestions: [
            '移除 --profile 参数，或显式传入 --profile agent-workspace',
            '需要后台任务/临时预览时，请走对应 Agent/Tool 链路而不是 browser open',
          ],
        }
      ))
      return true
    }

    const requestedTabId = readString(body, 'tabId', 'tab_id')
    if (requestedTabId) {
      const tabId = await resolveTabId(requestedTabId, requestScope)
      if (!tabId) {
        // ：区分「标签根本不存在」和「已登记但网页进程未挂载」——后者
        // 报 VIEW_NOT_FOUND 会把 Agent 引进「list 有、操作没有」的死循环。
        const registeredButUnattached = requestedTabId !== 'auto'
          ? await resolveContextBrowserTabId(requestedTabId, requestScope)
          : undefined
        if (registeredButUnattached) {
          sendJSON(res, 409, errorResponse(
            'VIEW_NOT_READY',
            `目标 tab 已登记但网页进程尚未挂载: ${requestedTabId}`,
            {
              retryable: true,
              suggestions: [
                '稍等 1-2 秒重试本命令（后台挂载可能正在进行）',
                `仍失败则先 tabtin browser tab close --tab-id ${requestedTabId} 再重新 open --url <url>`,
              ],
            }
          ))
          return true
        }
        sendJSON(res, 400, errorResponse(
          requestedTabId === 'auto' ? 'TAB_REQUIRED' : 'VIEW_NOT_FOUND',
          requestedTabId === 'auto'
            ? '无活跃 browser tab，请先打开一个页面或显式指定 --tab-id'
            : `找不到目标 tab: ${requestedTabId}`,
          {
            suggestions: requestedTabId === 'auto'
              ? ['使用 tabtin browser open <url> 新开一个页面', '或使用 --tab-id <viewId> 指定已有标签']
              : ['使用 tabtin browser tab list 查看可用标签', '确认传入的 --tab-id <viewId> 仍然存在'],
          }
        ))
        return true
      }

      const result = await runLoadTabUrlForOpen(executor, body, tabId, targetUrl, localPreviewRoot)
      const observation = shouldEmbedObservation(body, result)
        ? await runObserveForOpen(executor, body, tabId)
        : undefined
      lockOpenedTab(
        tabId,
        result,
        observation,
        typeof body?._thread_id === 'string' ? body._thread_id : undefined,
      )
      sendOpenResult(res, sendJSON, { viewId: tabId, tabId }, result, observation)
      return true
    }

    // Agent 失败重试常会再次调用 browser open；若同一 run 已有页，复用它
    // 才能避免每次失败都堆一个隐藏标签。用户和显式 --new-tab 仍总是创建新页。
    if (body?.newTab !== true) {
      const reusableViewId = findReusableRunViewId(requestScope)
      if (reusableViewId) {
        const tabId = await resolveTabId(reusableViewId, requestScope)
        if (tabId) {
          const result = await runLoadTabUrlForOpen(executor, body, tabId, targetUrl, localPreviewRoot)
          const observation = shouldEmbedObservation(body, result)
            ? await runObserveForOpen(executor, body, tabId)
            : undefined
          lockOpenedTab(
            tabId,
            result,
            observation,
            typeof body?._thread_id === 'string' ? body._thread_id : undefined,
          )
          sendOpenResult(res, sendJSON, { viewId: tabId, tabId, reused: true }, result, observation)
          return true
        }
      }
    }

    const ctx = requireBridgeAndSpace(body, res, sendJSON)
    if (!ctx) return true

    try {
      const sessionName = body?.session || getActiveSessionName() || undefined
      // ：只透传 thread + 显式 scope；缺 scope 时由 bridge-core 按 thread 注入，
      // 避免此处与 bridge 双重注入、也避免无 thread 时写死全局 scope。
      const bridgeResult = await ctx.bridge('create_web_tab', {
        ...requestScope,
        spaceId: ctx.spaceId,
        url: targetUrl,
        title: openTitle,
        ...(localPreviewRoot ? { localPreviewRoot } : {}),
        ...(sessionName ? { sessionName } : {}),
      }, 15000)

      if (bridgeResult.success) {
        const viewId = bridgeResult.data?.viewId
        if (!viewId) {
          sendJSON(res, 500, errorResponse('INTERNAL_ERROR', '创建标签页成功，但未返回 viewId'))
          return true
        }

        // 等 WebContents 真正就绪再导航（webview 容器 guest 收养是异步的，见
        // waitForViewWebContents 注释）；超时按真失败返回，不再吐 ok:true 假错。
        const viewReady = await waitForNewTabWebContents(viewId)
        if (!viewReady) {
          const totalAttachTimeoutMs = GUEST_ATTACH_TIMEOUT_MS + GUEST_ATTACH_RECOVERY_TIMEOUT_MS
          //  止血：attach 超时的 tab 没有 WebContents，留着就是「新标签」
          // 尸体——--tab-id 重试 / glance / close 全走 validateViewExists 死路。
          // 这里尽力回收自己建的 tab，失败也照常报错（回收结果进 detail）。
          let cleanedUp = false
          if (bridgeResult.data?.tabKey) {
            try {
              const closeResult = await ctx.bridge('close_context_tab', {
                ...requestScope,
                spaceId: ctx.spaceId,
                tabKey: bridgeResult.data.tabKey,
                crawlspaceId: bridgeResult.data?.crawlspaceId,
              }, CONTEXT_TAB_CLOSE_TIMEOUT_MS)
              cleanedUp = closeResult?.success === true
            } catch {
              // 回收失败不影响主错误返回；tab 交给 tab list / 用户手动清理
            }
          }
          sendJSON(res, 500, errorResponse(
            'INTERNAL_ERROR',
            `标签页已创建（tabId: ${viewId}），但浏览器视图 ${totalAttachTimeoutMs / 1000}s 内未就绪，导航未执行${cleanedUp ? '；该标签已自动回收' : ''}`,
            {
              retryable: true,
              detail: {
                viewId,
                tabId: viewId,
                crawlspaceId: bridgeResult.data?.crawlspaceId,
                tabKey: bridgeResult.data?.tabKey,
                attachWaitMs: totalAttachTimeoutMs,
                cleanedUp,
              },
              suggestions: cleanedUp
                ? [
                    '直接重试 tabtin browser open --url <url>（失败标签已回收，不会堆积）',
                    '连续失败说明浏览器容器异常：用 tabtin browser tab list 查看整体状态，必要时重启应用',
                  ]
                : [
                    '直接重试 tabtin browser open --url <url>',
                    `残留标签自动回收失败，用 tabtin browser tab list 确认后手动 tab close --tab-id ${viewId}`,
                  ],
            },
          ))
          return true
        }

        const loadResult = await runLoadTabUrlForOpen(
          executor,
          body,
          viewId,
          targetUrl,
          localPreviewRoot,
        )

        const observation = shouldEmbedObservation(body, loadResult)
          ? await runObserveForOpen(executor, body, viewId)
          : undefined
        lockOpenedTab(
          viewId,
          loadResult,
          observation,
          typeof body?._thread_id === 'string' ? body._thread_id : undefined,
        )
        sendOpenResult(
          res,
          sendJSON,
          {
            viewId,
            tabId: viewId,
            crawlspaceId: bridgeResult.data?.crawlspaceId,
            tabKey: bridgeResult.data?.tabKey,
          },
          loadResult,
          observation,
        )
        return true
      } else {
        const message = bridgeResult.error || '创建标签页失败'
        if (isViewQuotaFailure(message)) {
          const crawlspaceId = requestScope.crawlspaceId || getCLICrawlspaceId()
          const quotaOpts = buildBrowserQuotaExceededOptions({
            limit: getRunSessionManager().getQuota().maxTotalViews,
            cleaned: 0,
            items: getViewFactory().listQuotaSnapshotItems(),
            currentCrawlspaceId: crawlspaceId,
          })
          sendJSON(res, 409, errorResponse('QUOTA_EXCEEDED', message, quotaOpts))
        } else {
          sendJSON(res, 500, errorResponse('INTERNAL_ERROR', message, {
            suggestions: ['检查 TabTin 是否正常运行', '尝试重启应用后重试'],
          }))
        }
      }
    } catch (err: any) {
      handleRouteError(err, sendJSON, res)
    }
    return true
  }

  if (route === '/tabs') {
    const ctx = requireBridgeAndSpace(body, res, sendJSON)
    if (!ctx) return true

    try {
      const crawlspaceId = requestScope.crawlspaceId || getCLICrawlspaceId()
      const result = await ctx.bridge('list_context_space', {
        ...requestScope,
        spaceId: ctx.spaceId,
        crawlspaceId,
      })
      const rawTabs: RawBrowserTab[] = Array.isArray(result?.data?.tabs) ? result.data.tabs : []
      const rawBrowserTabs = rawTabs.filter((tab): tab is RawBrowserTab => tab?.type === 'tabweb')
      const snapshot = crawlspaceId ? getCrawlspaceContextHub().getSnapshot(crawlspaceId) : null
      const snapshotViews: SnapshotBrowserView[] = Array.isArray(snapshot?.views)
        ? snapshot.views.filter((view: SnapshotBrowserView) => !view.isClosing)
        : []
      const snapshotViewMap = new Map<string, SnapshotBrowserView>(snapshotViews.map(view => [view.viewId, view]))
      const rawTabMap = new Map<string, RawBrowserTab>(
        rawBrowserTabs
          .map(tab => ({ viewId: tab.id || tab.viewId, tab }))
          .filter((entry): entry is { viewId: string; tab: RawBrowserTab } => typeof entry.viewId === 'string' && entry.viewId.length > 0)
          .map(entry => [entry.viewId, entry.tab])
      )
      const orderedViewIds = Array.from(new Set([
        ...rawBrowserTabs
          .map(tab => tab.id || tab.viewId)
          .filter((viewId): viewId is string => typeof viewId === 'string' && viewId.length > 0),
        ...snapshotViews.map(view => view.viewId),
      ]))
      const activeSnapshotView = snapshot?.activeViewId
        ? snapshotViews.find(view => view.viewId === snapshot.activeViewId)
        : undefined
      const tabs = orderedViewIds
        .map((viewId): BrowserTabSummary | null => {
          const viewState = getViewFactory().getViewState(viewId)
          if (viewState && viewState.config.displayMode === 'hidden') {
            return null
          }
          const rawTab = rawTabMap.get(viewId)
          const snapshotView = snapshotViewMap.get(viewId)
          return {
            id: viewId,
            viewId,
            // BR-11：tabId 作主字段，名字与输入 flag --tab-id 一致、值为纯 viewId，
            // 引导 Agent 据输出正名拼命令；tabKey 保留为兼容字段（deprecated）。
            tabId: viewId,
            tabKey: rawTab?.tabKey || `tabweb:${viewId}`,
            type: 'tabweb' as const,
            title: snapshotView?.title || rawTab?.title,
            url: snapshotView?.url ?? rawTab?.meta?.url,
            favicon: snapshotView?.favicon ?? rawTab?.meta?.favicon,
            attached: validateViewExists(viewId),
          }
        })
        .filter((tab): tab is BrowserTabSummary => Boolean(tab?.id))
      const visibleTabIdSet = new Set(tabs.map(tab => tab.id))
      const rawActiveTabKey = typeof result?.data?.activeTabKey === 'string' ? result.data.activeTabKey : null
      const rawActiveViewId = rawActiveTabKey?.startsWith('tabweb:')
        ? rawActiveTabKey.slice('tabweb:'.length)
        : null
      // BR-11：activeTabId 作主字段（纯 viewId，名字对齐输入 flag --tab-id）；
      // activeTabKey 保留为兼容字段（deprecated），值仍带 tabweb: 前缀。
      const activeTabId = activeSnapshotView?.viewId
        ? activeSnapshotView.viewId
        : rawActiveViewId && visibleTabIdSet.has(rawActiveViewId) ? rawActiveViewId : null
      const activeTabKey = activeTabId ? `tabweb:${activeTabId}` : null
      if (result?.success) {
        sendJSON(res, 200, okResponse({ tabs, activeTabId, activeTabKey, count: tabs.length }))
      } else {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', result?.error || 'Failed to list tabs'))
      }
    } catch (err: any) {
      handleRouteError(err, sendJSON, res)
    }
    return true
  }

  if (route === '/tab-switch') {
    const rawTabId = typeof body?.tabId === 'string' ? body.tabId.trim() : ''
    if (!rawTabId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 tabId 参数', {
        suggestions: ['使用 tabtin browser tab list 查看可用标签', '或使用 --tab-id auto 自动选择活跃标签'],
      }))
      return true
    }

    const ctx = requireBridgeAndSpace(body, res, sendJSON)
    if (!ctx) return true
    const tabId = await resolveContextBrowserTabId(rawTabId, requestScope)
    if (!tabId) {
      sendJSON(res, 400, errorResponse(
        rawTabId === 'auto' ? 'TAB_REQUIRED' : 'VIEW_NOT_FOUND',
        rawTabId === 'auto'
          ? '当前没有活跃 browser tab，请先激活一个浏览器标签'
          : `找不到目标 tab: ${rawTabId}`,
        {
          suggestions: rawTabId === 'auto'
            ? ['使用 tabtin browser tab list 查看当前活跃标签', '或显式传入 --tab-id <viewId>']
            : ['使用 tabtin browser tab list 查看可用标签', '确认传入的 --tab-id <viewId> 仍然存在'],
        }
      ))
      return true
    }
    try {
      const tabKey = `tabweb:${tabId}`
      const result = await ctx.bridge('set_active_context_tab', {
        ...requestScope,
        spaceId: ctx.spaceId,
        tabKey,
        crawlspaceId: requestScope.crawlspaceId || getCLICrawlspaceId(),
      })
      if (result?.success) {
        sendJSON(res, 200, okResponse({ tabId, ...(result?.data || {}) }))
      } else {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', result?.error || 'Failed to switch tab'))
      }
    } catch (err: any) {
      handleRouteError(err, sendJSON, res)
    }
    return true
  }

  if (route === '/tab-close') {
    const rawTabId = typeof body?.tabId === 'string' ? body.tabId.trim() : ''
    if (!rawTabId) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少 tabId 参数', {
        suggestions: ['使用 tabtin browser tab list 查看可用标签', '或使用 --tab-id auto 自动选择活跃标签'],
      }))
      return true
    }

    const ctx = requireBridgeAndSpace(body, res, sendJSON)
    if (!ctx) return true
    // ：close 与 switch 同口径用 renderer 标签清单解析——关闭走 bridge
    // close_context_tab，不需要 WebContents 存在。原先用 resolveTabId
    // （validateViewExists）会让「已登记未挂载」的僵尸标签连关都关不掉。
    const tabId = await resolveContextBrowserTabId(rawTabId, requestScope)
    if (!tabId) {
      sendJSON(res, 400, errorResponse(
        rawTabId === 'auto' ? 'TAB_REQUIRED' : 'VIEW_NOT_FOUND',
        rawTabId === 'auto'
          ? '当前没有活跃 browser tab，请先激活一个浏览器标签'
          : `找不到目标 tab: ${rawTabId}`,
        {
          suggestions: rawTabId === 'auto'
            ? ['使用 tabtin browser tab list 查看当前活跃标签', '或显式传入 --tab-id <viewId>']
            : ['使用 tabtin browser tab list 查看可用标签', '确认传入的 --tab-id <viewId> 仍然存在'],
        }
      ))
      return true
    }

    try {
      const tabKey = `tabweb:${tabId}`
      const result = await ctx.bridge('close_context_tab', {
        ...requestScope,
        spaceId: ctx.spaceId,
        tabKey,
        crawlspaceId: requestScope.crawlspaceId || getCLICrawlspaceId(),
      }, CONTEXT_TAB_CLOSE_TIMEOUT_MS)
      if (result?.success) {
        sendJSON(res, 200, okResponse({ tabId, closed: true, ...(result?.data || {}) }))
      } else {
        sendJSON(res, 500, errorResponse('INTERNAL_ERROR', result?.error || 'Failed to close tab'))
      }
    } catch (err: any) {
      handleRouteError(err, sendJSON, res)
    }
    return true
  }

  if (route === '/nav') {
    const direction = body?.direction
    if (!direction || !['back', 'forward', 'reload', 'stop'].includes(direction)) {
      sendJSON(res, 400, errorResponse('VALIDATION_ERROR', '缺少或无效的 direction 参数', {
        suggestions: ['可选值: back, forward, reload, stop', '示例: tabtin browser nav back --tab-id auto'],
      }))
      return true
    }

    const tabId = await resolveTabId(body?.tabId, requestScope)
    // BT-007: tabId 解析失败时提前报错，避免传 undefined 给 executor
    if (!tabId) {
      sendJSON(res, 400, errorResponse('TAB_REQUIRED', '无活跃 tab，请先打开一个页面或显式指定 --tab-id', {
        suggestions: ['使用 tabtin browser open <url> 打开页面', '使用 --tab-id <viewId> 指定标签'],
      }))
      return true
    }
    const result = await executor({
      task_id: makeTaskId('nav'),
      type: 'nav_tab',
      params: {
        action: direction,
        viewId: tabId,
        ignoreCache: body?.ignoreCache,
        ...(body?.runId ? { runId: body.runId } : {}),
      },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  if (route === '/tab-state') {
    const tabId = await resolveTabId(body?.tabId, requestScope)
    if (!tabId) {
      sendJSON(res, 400, errorResponse('NOT_FOUND', '无活跃标签页，请先打开一个页面', {
        suggestions: ['使用 tabtin browser open <url> 打开页面', '使用 tabtin browser tab list 查看已打开标签'],
      }))
      return true
    }
    const result = await executor({
      task_id: makeTaskId('tab-state'),
      type: 'tab_state',
      params: {
        viewId: tabId,
        includeHistory: body?.includeHistory ?? false,
        crawlTabId: tabId,
      },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  if (route === '/wait') {
    const tabId = await resolveTabId(body?.tabId, requestScope)
    // BT-007: tabId 解析失败时提前报错，避免传 undefined 给 executor
    if (!tabId) {
      sendJSON(res, 400, errorResponse('TAB_REQUIRED', '无活跃 tab，请先打开一个页面或显式指定 --tab-id', {
        suggestions: ['使用 tabtin browser open <url> 打开页面', '使用 --tab-id <viewId> 指定标签'],
      }))
      return true
    }
    const result = await executor({
      task_id: makeTaskId('wait'),
      type: 'wait_for',
      params: {
        viewId: tabId,
        selector: body?.selector,
        timeout: body?.selector ? (body?.timeout ?? 10000) : undefined,
        delay: body?.selector ? undefined : (body?.timeout ?? 2000),
        crawlTabId: tabId,
        ...(body?.runId ? { runId: body.runId } : {}),
      },
      thread_id: '',
    })
    sendExecutorResult(result, res, sendJSON)
    return true
  }

  return false
}
