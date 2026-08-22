import http from 'node:http'
import { okResponse } from '@tabtin/agent-wire'
// BR-8 P3a：RefCache 收编进 browser-core 共享 runtime（snapshot 填充 + act 回解 ref/toRef）。
// BR-8 P3c：act/observe/snapshot/eval 编排收编进 browser-core Orchestrator；本文件退成薄分发。
import {
  BrowserActionError,
  captchaNeedsUserIntervention,
  getSharedCaptchaGuard,
  handleBrowserAction,
  projectCaptchaRequired,
  mergeActEmbedObserve,
  type BrowserActionResult,
  type BrowserExecHooks,
  type BrowserExecOutcome,
  type BrowserObserveParams,
  type BrowserOrchestratorHostHooks,
  type BrowserSnapshotRequestParams,
  type CaptchaInfo,
} from '@tabtin/browser-core'
import type { SendJSON, ActionExecutor } from './_helpers'
import {
  buildBrowserRequestScope,
  resolveTabId,
  makeTaskId,
  sendExecutorResult,
  errorResponse,
  saveScreenshotFromBase64,
  electronPolicyHooks,
} from './_helpers'
import { runWithBrowserApprovalContext } from '../../browser-policy-middleware'
import { recordBrowserNavigationEvidenceFromHrefs } from './navigation-evidence'
import { createLogger } from '../../../logger'
import { unlock } from '../../../browser-tab-lock/browserTabInputLock'
import { runWithTabLock } from '../../../browser-tab-lock/runWithTabLock'
import { payloadHasUserInterventionWall } from '../../../browser-tab-lock/wallSignal'

const log = createLogger('browser/interaction')

export const ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS = 25_000

/** 须短于 Go CLI 默认读超时（30s），以便超时响应里仍能塞上 captcha_required。 */
export const ELECTRON_BROWSER_OBSERVE_EXECUTION_TIMEOUT_MS = 20_000

/** act 并行墙探测：先等导航起步，再轮询 detectFast，避免 click 挂死空等满 25s。 */
export const CAPTCHA_ACT_WATCH_INITIAL_DELAY_MS = 1_500
export const CAPTCHA_ACT_WATCH_POLL_MS = 1_000

/**
 * open 内嵌观察的总超时。观察链路最深处是 webContents.executeJavaScript——
 * 注入若撞上页面导航窗口（执行上下文销毁重建），其 Promise 可能永远不 settle，
 * /open 响应发不出去，Go CLI 端等满 120s 才超时（exit 7）。观察本就是
 * best-effort（失败不影响 open 结果），超时按观察失败处理即可。
 */
export const OPEN_EMBED_OBSERVE_TIMEOUT_MS = 20_000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(onTimeout()), timeoutMs)
      }),
    ])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function captchaEarlyActOutcome(captcha: CaptchaInfo): BrowserExecOutcome {
  const wire = projectCaptchaRequired(captcha)
  const pageUrl = typeof captcha.page_url === 'string' && captcha.page_url
    ? captcha.page_url
    : undefined
  return {
    success: false,
    errorMessage: wire?.reason || '页面需要完成验证码',
    raw: {
      success: false,
      executed_actions: [],
      captcha,
      ...(pageUrl ? { page_url: pageUrl } : {}),
      error: wire?.reason || '页面需要完成验证码',
    },
  }
}

/**
 * 与 executor 竞速：导航拖死时若页已是验证码墙，尽早返回信号（不必等 CONNECTION_TIMEOUT）。
 */
async function raceActWithCaptchaWatch<T>(
  executorPromise: Promise<T>,
  tabId: string | undefined,
  timeoutMs: number,
  onTimeout: () => Error,
): Promise<{ kind: 'result'; result: T } | { kind: 'captcha'; captcha: CaptchaInfo }> {
  if (!tabId) {
    const result = await withTimeout(executorPromise, timeoutMs, onTimeout)
    return { kind: 'result', result }
  }

  let stopped = false
  const resultP = executorPromise.then((result) => ({ kind: 'result' as const, result }))
  const captchaP = (async (): Promise<{ kind: 'captcha'; captcha: CaptchaInfo }> => {
    await sleep(CAPTCHA_ACT_WATCH_INITIAL_DELAY_MS)
    while (!stopped) {
      const captcha = await getSharedCaptchaGuard().detectFast(tabId)
      if (captchaNeedsUserIntervention(captcha)) {
        return { kind: 'captcha', captcha }
      }
      await sleep(CAPTCHA_ACT_WATCH_POLL_MS)
    }
    return await new Promise(() => {})
  })()

  try {
    return await withTimeout(
      Promise.race([resultP, captchaP]),
      timeoutMs,
      onTimeout,
    )
  } finally {
    stopped = true
  }
}

/** CLI 超时后仍尽量投递墙信号，避免 Agent 只看到 CONNECTION_TIMEOUT 空转。 */
async function enrichTimeoutWithCaptcha(
  err: unknown,
  tabId: string | undefined,
): Promise<void> {
  if (!(err instanceof BrowserActionError) || err.info.code !== 'CONNECTION_TIMEOUT' || !tabId) {
    return
  }
  try {
    const captcha = await getSharedCaptchaGuard().detectFast(tabId)
    const wire = projectCaptchaRequired(captcha)
    if (wire) {
      const pageUrl = typeof captcha.page_url === 'string' && captcha.page_url
        ? captcha.page_url
        : undefined
      err.info.detail = {
        ...(err.info.detail ?? {}),
        ...(pageUrl ? { page_url: pageUrl } : {}),
        captcha_required: wire,
      }
    }
  } catch {
    // 探测失败不掩盖原超时
  }
}

/**
 * 把 Orchestrator 结果用 Electron envelope 落地；eval 走 sendExecutorResult 迁移缝。
 */
function respondBrowserAction(res: http.ServerResponse, sendJSON: SendJSON, result: BrowserActionResult): void {
  // 单一 `'kind' in result` 收窄：叠 `&& result.kind===...` 会令取反分支无法收窄成 ok/error 联合
  // （electron-executor 变体残留 → 后续 result.ok / result.error 访问 typecheck 报错）。
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
 * Electron 端 act/observe/snapshot/eval 的「最后一公里」，注入 Orchestrator。
 */
export function buildElectronExecHooks(executor: NonNullable<ActionExecutor>): BrowserExecHooks {
  return {
    observeLimitDefault: 50,

    async prepareTab(body: any): Promise<string | undefined> {
      return resolveTabId(body?.tabId ?? body?.tab_id, buildBrowserRequestScope(body))
    },

    async runAct(tabId: string | undefined, resolvedActions: any[], body: any): Promise<BrowserExecOutcome> {
      try {
        const raced = await raceActWithCaptchaWatch(
          executor({
            task_id: makeTaskId('act'),
            type: 'execute_act',
            params: {
              actions: resolvedActions,
              stop_on_error: body?.stop_on_error ?? true,
              crawlTabId: tabId,
              ...(body?.runId ? { runId: body.runId } : {}),
            },
            thread_id: '',
          }),
          tabId,
          ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS,
          () => {
            const actionSummary = resolvedActions
              .map((action, index) => `${index + 1}:${action?.type ?? 'unknown'}${action?.selector ? `(${action.selector})` : ''}`)
              .join(', ')
            return new BrowserActionError(504, {
              code: 'CONNECTION_TIMEOUT',
              message: `Electron browser act 执行超过 ${ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS / 1000}s，已在 CLI transport 超时前中止等待`,
              retryable: true,
              detail: {
                tabId: tabId ?? null,
                timeoutMs: ELECTRON_BROWSER_ACT_EXECUTION_TIMEOUT_MS,
                actions: actionSummary,
              },
            })
          },
        )
        if (raced.kind === 'captcha') {
          return captchaEarlyActOutcome(raced.captcha)
        }
        const result = raced.result
        return { success: !!result.success, raw: result, errorMessage: result.error }
      } catch (err) {
        await enrichTimeoutWithCaptcha(err, tabId)
        throw err
      }
    },

    async runObserve(tabId: string | undefined, params: BrowserObserveParams, body: any): Promise<BrowserExecOutcome> {
      try {
        const result = await withTimeout(executor({
          task_id: makeTaskId('observe'),
          type: 'execute_observe',
          params: {
            selector: params.selector,
            include_som: params.include_som,
            limit: params.limit,
            crawlTabId: tabId,
            ...(body?.runId ? { runId: body.runId } : {}),
          },
          thread_id: '',
        }), ELECTRON_BROWSER_OBSERVE_EXECUTION_TIMEOUT_MS, () => {
          return new BrowserActionError(504, {
            code: 'CONNECTION_TIMEOUT',
            message: `Electron browser glance/observe 执行超过 ${ELECTRON_BROWSER_OBSERVE_EXECUTION_TIMEOUT_MS / 1000}s，已在 CLI transport 超时前中止等待`,
            retryable: true,
            detail: {
              tabId: tabId ?? null,
              timeoutMs: ELECTRON_BROWSER_OBSERVE_EXECUTION_TIMEOUT_MS,
            },
          })
        })
        return { success: !!result.success, raw: result, errorMessage: result.error }
      } catch (err) {
        await enrichTimeoutWithCaptcha(err, tabId)
        throw err
      }
    },

    async runSnapshot(body: any, params: BrowserSnapshotRequestParams): Promise<BrowserExecOutcome> {
      const tabId = await resolveTabId(body?.tabId, buildBrowserRequestScope(body))
      const result = await executor({
        task_id: makeTaskId('snapshot'),
        type: 'request_snapshot',
        params: {
          ...params,
          crawlTabId: tabId,
          ...(body?.runId ? { runId: body.runId } : {}),
        },
        thread_id: '',
      })
      return {
        success: !!result.success,
        raw: { ...result, crawlTabId: tabId },
        errorMessage: result.error,
      }
    },

    async persistSnapshotScreenshot(base64: string, savePath: string | undefined): Promise<string> {
      try {
        return saveScreenshotFromBase64(base64, savePath)
      } catch (err: any) {
        log.warn('保存 snapshot 截图文件失败:', err?.message)
        throw err
      }
    },

    async runEval(tabId: string | undefined, code: string, body: any): Promise<BrowserExecOutcome> {
      const result = await executor({
        task_id: makeTaskId('eval'),
        type: 'eval',
        params: {
          code,
          crawlTabId: tabId,
          ...(body?.runId ? { runId: body.runId } : {}),
        },
        thread_id: '',
      })
      return { success: !!result.success, raw: result, errorMessage: result.error }
    },
  }
}

// 命令面重设计：/observe、/snapshot 收编为 /glance（Orchestrator 内部仍复用
// observe/snapshot 两条管线，只做 flag 翻译）。
const ORCHESTRATED_ROUTES: Record<string, string> = {
  '/act': 'act',
  '/glance': 'glance',
  '/eval': 'eval',
}

/** act 成功内嵌观察用的 tabId：与 prepareTab 同口径（body.tabId + scope 解析）。 */
async function resolveActEmbedObserveTabId(body: any): Promise<string | undefined> {
  return resolveTabId(body?.tabId ?? body?.tab_id, buildBrowserRequestScope(body))
}

/**
 * act 成功后在路由层内嵌 compact 观察（settle 已在引擎完成，此处不再 sleep）。
 * 观察失败不影响 act success；captcha / act 失败路径不调用本函数。
 */
async function enrichActWithEmbedObserve(
  result: Extract<BrowserActionResult, { ok: true }>,
  body: any,
  executor: NonNullable<ActionExecutor>,
): Promise<BrowserActionResult> {
  const observeRequested = body?.observe !== false
  let observation: Record<string, unknown> | undefined
  let observeFailed = false

  if (observeRequested) {
    const tabId = await resolveActEmbedObserveTabId(body)
    if (tabId) {
      observation = await runEmbedObserve(executor, body, tabId)
      observeFailed = observation === undefined
    } else {
      observeFailed = true
    }
  }

  return {
    ...result,
    data: mergeActEmbedObserve(result.data as Record<string, unknown>, {
      observeRequested,
      observation,
      observeFailed,
    }),
  }
}

export async function handleInteractionRoute(
  route: string,
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  executor: NonNullable<ActionExecutor>,
): Promise<boolean> {
  const actionId = ORCHESTRATED_ROUTES[route]
  if (!actionId) return false

  const hostHooks: BrowserOrchestratorHostHooks = {
    runtime: 'electron',
    exec: buildElectronExecHooks(executor),
    // BR-9：act/eval 等写操作经统一闸门判为 confirm 时走 ApprovalManager 真人审批。
    policy: electronPolicyHooks,
  }
  const tabId = await resolveTabId(
    body?.tabId ?? body?.tab_id,
    buildBrowserRequestScope(body),
  )
  let result = await runWithBrowserApprovalContext(
    body,
    () => runWithTabLock(
      tabId,
      () => handleBrowserAction(actionId, body, hostHooks),
      typeof body?._thread_id === 'string' ? body._thread_id : undefined,
    ),
  )
  if (result) {
    // glance 默认模式（元素清单）= 原 observe：观测到的真实 href 补录导航证据。
    // --tree / --screenshot 模式走 snapshot 管线，响应里没有 observed_elements，此处自然 no-op。
    if (actionId === 'glance') {
      recordNavigationEvidenceFromResult(result)
    }
    // act 成功内嵌观察：默认 compact 元素清单 + observe_status，观察失败不挡 act success。
    if (actionId === 'act' && 'ok' in result && result.ok) {
      result = await enrichActWithEmbedObserve(result, body, executor)
    }
    if (tabId && payloadHasUserInterventionWall(result)) {
      unlock(tabId)
    }
    respondBrowserAction(res, sendJSON, result)
    return true
  }
  return false
}

/**
 * 内嵌观察（ / act embed observe）：复用 glance 默认管线（observe 投影 + RefCache +
 * 导航证据补录），compact 投影控 token。open / act 成功后均可调用。
 *
 * 返回 observation 对象或 undefined（硬失败）；观察失败不影响调用方本身 success。
 */
export async function runEmbedObserve(
  executor: NonNullable<ActionExecutor>,
  body: any,
  tabId: string,
): Promise<Record<string, unknown> | undefined> {
  const hostHooks: BrowserOrchestratorHostHooks = {
    runtime: 'electron',
    exec: buildElectronExecHooks(executor),
    policy: electronPolicyHooks,
  }
  const observeBody = {
    tabId,
    compact: true,
    spaceId: body?.spaceId ?? body?.space_id,
    crawlspaceId: body?.crawlspaceId ?? body?.crawlspace_id,
    ...(body?.runId ? { runId: body.runId } : {}),
  }
  try {
    const result = await withTimeout(
      runWithBrowserApprovalContext(
        observeBody,
        () => handleBrowserAction('glance', observeBody, hostHooks),
      ),
      OPEN_EMBED_OBSERVE_TIMEOUT_MS,
      () => new Error(`内嵌观察超时（${OPEN_EMBED_OBSERVE_TIMEOUT_MS / 1000}s），跳过 observed_elements`),
    )
    if (!result || !('ok' in result) || !result.ok) return undefined
    recordNavigationEvidenceFromResult(result)
    const data = result.data as Record<string, any>
    if (!Array.isArray(data?.observed_elements)) return undefined
    // hint（无 href 条目的 act --ref 用法）一并透传：open 是 Agent 首次见到元素清单的
    // 地方，只给 observed_elements 会把编排层的用法提示剥掉。hint 在前，保证落盘
    // file_ref 的头部 preview 也露出。
    // login_required（登录墙拦截信号）置首键：open 一撞登录墙，Agent 第一眼即知「先停下来
    // 让用户登录」，无需再解析元素文本自行推断。
    return {
      ...(data.login_required ? { login_required: data.login_required } : {}),
      ...(typeof data.hint === 'string' && data.hint ? { hint: data.hint } : {}),
      observed_elements: data.observed_elements,
    }
  } catch (err: any) {
    log.warn('内嵌观察失败（不影响调用方结果）:', err?.message)
    return undefined
  }
}

/** @deprecated 薄包装，open 路径继续用；act embed observe 请用 {@link runEmbedObserve} */
export async function runObserveForOpen(
  executor: NonNullable<ActionExecutor>,
  body: any,
  tabId: string,
): Promise<Record<string, unknown> | undefined> {
  return runEmbedObserve(executor, body, tabId)
}

/**
 * 从 observe 成功结果里提取「页面 URL + 观测到的真实 href」，供补录导航证据。
 *
 * hrefs 来自 `observed_elements[].href`（ 新增，含站点签名参如 xsec_token）。
 * 纯函数，无副作用，便于单测。返回 undefined 表示无可用证据。
 */
export function collectNavigationEvidenceInput(
  result: BrowserActionResult,
): { pageUrl: string; hrefs: string[] } | undefined {
  if (!('ok' in result) || !result.ok) return undefined
  const data = result.data as Record<string, any> | undefined
  if (!data) return undefined

  const pageUrl = typeof data.page_url === 'string' ? data.page_url : undefined
  if (!pageUrl) return undefined
  const hrefs = Array.isArray(data.observed_elements)
    ? data.observed_elements
        .map((el: any) => el?.href)
        .filter((h: unknown): h is string => typeof h === 'string' && h.length > 0)
    : []
  return hrefs.length > 0 ? { pageUrl, hrefs } : undefined
}

/**
 * observe 成功后，把观测到的真实 href 补录进导航证据，
 * 使 Agent 可直接 `browser open` 这些带签名参的链接而不触发 UNVERIFIED_NAVIGATION_URL 守卫。
 */
function recordNavigationEvidenceFromResult(result: BrowserActionResult): void {
  const input = collectNavigationEvidenceInput(result)
  if (input) recordBrowserNavigationEvidenceFromHrefs(input.pageUrl, input.hrefs)
}
