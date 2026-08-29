import http from 'node:http'
import { basename, extname, isAbsolute, join, resolve, normalize } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { okResponse } from '@tabtin/agent-wire'
import { getHomeTabtinPath } from '@tabtin/shared/storage-paths'
import type { BrowserPolicyHostHooks, BrowserOrchestratorHostHooks } from '@tabtin/browser-core'
import { requestAccessBarrierResolution } from '@tabtin/agent-runtime'
import {
  getCLIActionExecutor,
  getCLIViewGetter,
  getCLISpaceId,
  getCLICrawlspaceId,
  getCLIContextSpaceBridge,
  getCLIWorkspaceScopeKey,
  getCLIOrganizationRoot,
} from '../../cli-context'
import {
  errorResponse,
  sendBrowserTabUserInControlError,
} from '../shared/error-handler'
import { getCrawlspaceContextHub } from '../../../crawlspace/CrawlspaceContextHub'
import { getViewFactory } from '../../../view-factory/ViewFactory'
import { fileUrlToLocalPath, isPathWithinRoot } from '../../../crawl-view/utils'
import { requestApproval } from '../../../services/ApprovalManager'
import {
  BROWSER_CLI_APPROVAL_TIMEOUT_MS,
  getBrowserApprovalThreadId,
  isBrowserPolicyPreapproved,
} from '../../browser-policy-middleware'
import { isScheduledRuntimeThread } from '../../../agent/policy/interaction-mode-context'
import { shouldBypassConfirmApproval } from '../../../agent/policy/approval-mode-context'
import {
  assertBrowserTabAvailableForAgent as assertBrowserTabAvailableForAgentInRegistry,
  BrowserTabUserInControlError,
  lock,
} from '../../../browser-tab-lock/browserTabInputLock'

export type SendJSON = (
  res: http.ServerResponse,
  status: number,
  data: any,
) => void
export type ActionExecutor = ReturnType<typeof getCLIActionExecutor>
export type ResolveTabScope = {
  spaceId?: string | null
  tabScopeKey?: string | null
  workspaceScopeKey?: string | null
  crawlspaceId?: string | null
  /** Agent 发起 thread（sessionId），用于按会话取 CLI workspace scope */
  _thread_id?: string | null
  /** Agent run，用于创建后使后台 webview 保持可交互 */
  runId?: string | null
}

const readRequestString = (body: any, ...keys: string[]): string | undefined => {
  for (const key of keys) {
    const value = body?.[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

/**
 * Browser CLI request 的唯一 scope 构造入口。
 * 所有会解析/操作 tab 的 route 都必须经此处归一化 thread 与 camel/snake aliases。
 */
export function buildBrowserRequestScope(body: any): ResolveTabScope {
  const spaceId = readRequestString(body, 'spaceId', 'space_id')
  const tabScopeKey = readRequestString(body, 'tabScopeKey', 'tab_scope_key')
  const workspaceScopeKey = readRequestString(body, 'workspaceScopeKey', 'workspace_scope_key')
  const crawlspaceId = readRequestString(body, 'crawlspaceId', 'crawlspace_id')
  const threadId = readRequestString(body, '_thread_id', 'thread_id', 'threadId')
  const runId = readRequestString(body, 'runId', 'run_id')
  return {
    ...(spaceId ? { spaceId } : {}),
    ...(tabScopeKey ? { tabScopeKey } : {}),
    ...(workspaceScopeKey ? { workspaceScopeKey } : {}),
    ...(crawlspaceId ? { crawlspaceId } : {}),
    ...(threadId ? { _thread_id: threadId } : {}),
    ...(runId ? { runId } : {}),
  }
}

export {
  errorResponse,
  getCLIViewGetter,
  getCLISpaceId,
  getCLICrawlspaceId,
  getCLIContextSpaceBridge,
  getCLIActionExecutor,
}

export function makeTaskId(prefix: string): string {
  return `cli-${prefix}-${Date.now()}`
}

// ─── 安全工具函数 ───────────────────────────────────────────────────────────────

/**
 * 允许写入截图/PDF 等文件的目录白名单。
 * 只允许 ~/.tabtin 和 /tmp 两个安全位置，防止路径遍历攻击。
 */
export function getAllowedSaveDirs(): string[] {
  return [resolve(getHomeTabtinPath()), resolve('/tmp')]
}

/**
 * 校验 savePath 是否在白名单目录内，防止路径穿越（BT-002/BT-004）。
 * @returns 规范化后的安全路径，若不安全则返回 null
 */
export function sanitizeSavePath(savePath: string): string | null {
  const normalized = normalize(resolve(savePath))
  const allowed = getAllowedSaveDirs()
  const safe = allowed.some(
    (dir) => normalized.startsWith(dir + '/') || normalized === dir,
  )
  return safe ? normalized : null
}

/** 截图默认保存目录 */
export const SCREENSHOT_DIR = join(
  getHomeTabtinPath(),
  'screenshots',
)

/**
 * 将 base64 编码的截图写入磁盘（BT-002/BT-008 共享实现）。
 * savePath 若提供，必须通过 sanitizeSavePath 安全校验；
 * 不提供则写入 SCREENSHOT_DIR 带时间戳的文件。
 * @throws 若 savePath 不在允许目录内
 */
export function saveScreenshotFromBase64(
  base64: string,
  savePath?: string,
): string {
  let filePath: string
  if (savePath) {
    const safe = sanitizeSavePath(savePath)
    if (!safe) {
      throw new Error(
        `不允许将截图保存到该路径: ${savePath}。允许目录: ~/.tabtin, /tmp`,
      )
    }
    filePath = safe
    const dir = join(filePath, '..')
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* exists */
    }
  } else {
    try {
      mkdirSync(SCREENSHOT_DIR, { recursive: true })
    } catch {
      /* exists */
    }
    const ts = new Date()
      .toISOString()
      .replace(/[:.]/g, '-')
      .replace('T', '_')
      .replace('Z', '')
    filePath = join(SCREENSHOT_DIR, `snapshot-${ts}.png`)
  }
  writeFileSync(filePath, Buffer.from(base64, 'base64'))
  return filePath
}

/**
 * 校验 URL 是否为安全协议（仅允许 http/https），防止 SSRF 和协议注入（BT-003）。
 * 拒绝 file://、javascript:、data:、内网协议等。
 *
 * Workspace 内本地 HTML 预览不走本函数——见 `resolveWorkspaceLocalHtmlOpen`
 *（ / ：仅放行当前工作目录内的 .html/.htm）。
 */
export function isSafeUrl(url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

const LOCAL_HTML_EXTENSIONS = new Set(['.html', '.htm'])

export type WorkspaceLocalHtmlOpenResult =
  | {
      ok: true
      url: string
      localPreviewRoot: string
      absolutePath: string
      title: string
    }
  | {
      ok: false
      code: 'NO_WORKSPACE' | 'OUTSIDE_WORKSPACE' | 'NOT_HTML' | 'INVALID_PATH'
      message: string
    }

/**
 * 识别「要用内嵌浏览器打开的 Workspace 本地 HTML」。
 *
 * - 返回 `null`：输入是普通 http(s) / 与本地预览无关 → 走 `isSafeUrl`
 * - 返回 `{ ok:false }`：看起来像本地打开意图，但越权 / 非 HTML / 无工作目录
 * - 返回 `{ ok:true }`：规范化后的 `file://` + `localPreviewRoot`（= workspace root）
 *
 * 接受：`file://` 绝对路径、Workspace 绝对路径、Workspace 相对路径（如 `attachments/a.html`）。
 */
export function resolveWorkspaceLocalHtmlOpen(
  rawUrl: string,
  workspaceRoot: string | null | undefined = getCLIOrganizationRoot(),
): WorkspaceLocalHtmlOpenResult | null {
  const trimmed = typeof rawUrl === 'string' ? rawUrl.trim() : ''
  if (!trimmed) return null

  let protocol: string | null = null
  try {
    protocol = new URL(trimmed).protocol
  } catch {
    protocol = null
  }

  if (protocol === 'http:' || protocol === 'https:') return null
  if (protocol && protocol !== 'file:') return null

  const looksLikeFileUrl = protocol === 'file:'
  const looksLikeAbsolutePath =
    isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)
  const looksLikeRelativeHtml =
    !trimmed.includes('://')
    && LOCAL_HTML_EXTENSIONS.has(extname(trimmed).toLowerCase())

  if (!looksLikeFileUrl && !looksLikeAbsolutePath && !looksLikeRelativeHtml) {
    return null
  }

  const root = typeof workspaceRoot === 'string' && workspaceRoot.trim()
    ? resolve(workspaceRoot.trim())
    : null
  if (!root) {
    return {
      ok: false,
      code: 'NO_WORKSPACE',
      message: '当前没有 Workspace 工作目录，无法用浏览器打开本地 HTML',
    }
  }

  let absolutePath: string | null = null
  if (looksLikeFileUrl) {
    absolutePath = fileUrlToLocalPath(trimmed)
  } else if (looksLikeAbsolutePath) {
    absolutePath = resolve(trimmed)
  } else {
    absolutePath = resolve(root, trimmed)
  }

  if (!absolutePath) {
    return {
      ok: false,
      code: 'INVALID_PATH',
      message: `无法解析本地 HTML 路径: ${trimmed}`,
    }
  }

  absolutePath = resolve(absolutePath)
  if (!isPathWithinRoot(absolutePath, root)) {
    return {
      ok: false,
      code: 'OUTSIDE_WORKSPACE',
      message: `本地 HTML 不在当前 Workspace 内，已拒绝: ${absolutePath}`,
    }
  }

  const ext = extname(absolutePath).toLowerCase()
  if (!LOCAL_HTML_EXTENSIONS.has(ext)) {
    return {
      ok: false,
      code: 'NOT_HTML',
      message: 'browser open 的本地预览仅支持 Workspace 内的 .html / .htm 文件',
    }
  }

  return {
    ok: true,
    url: pathToFileURL(absolutePath).href,
    localPreviewRoot: root,
    absolutePath,
    title: basename(absolutePath),
  }
}

// ─── BR-9：浏览器 action 安全闸门的 Electron 端「处置」 ──────────────────────────

/**
 * Electron 端浏览器 action 的 confirm **处置**钩子（注入 Orchestrator 统一闸门）。
 *
 * 判定在 browser-core 的纯函数 `evaluateBrowserActionPolicy`；这里只负责把 `confirm` 类
 * 写操作（act、eval、record 系、replay.run、run 系等，contract risk=write 或未注册 fail-safe）
 * 接到 Electron 真人审批 `ApprovalManager.requestApproval`：
 *  - `actionType` = `browser.<id>`（与终端命令审批 `execute_in_terminal` 等同口径，便于
 *    `approvalScopeCache` 的「总是允许」按 actionType 记忆/跨端同步）。
 *  - 用户允许（含 cache 命中「总是允许」）→ `approved:true` → 闸门放行进入执行。
 *  - 用户拒绝 / 超时 / 无窗口 fallback 拒绝 → `approved:false` → 闸门 403 APPROVAL_DENIED。
 *
 * **行为变更说明**：BR-9 之前 Electron CLI browser act/eval 直连 ActionExecutor、不经审批
 * （CLI route 无 middleware，比 daemon 更松，见 br-9-design §1.2/§1.3）。挂闸门后这些写操作
 * 首次会弹审批，用户可选「总是允许」记忆。这正是 BR-9 要堵的 Electron 旁路。
 *
 * 注入到**所有** Electron browser route 的 hostHooks（interaction、introspect、record、run、
 * resources）——只要某 route 会路由到 write 类 action，缺了 policy 就会被闸门 fail-closed
 * 拒成 403（把现有可用动作拒掉）。read 类（capabilities、context、observe、snapshot、
 * resource 系、stream 系）判为 allow、不会触发本钩子。
 */
export const electronPolicyHooks: BrowserPolicyHostHooks = {
  async resolveConfirmation(decision) {
    if (isBrowserPolicyPreapproved(decision.actionType)) return true
    const threadId = getBrowserApprovalThreadId()
    if (isScheduledRuntimeThread(threadId)) return true
    // ：统一审批档——生效档 auto/full_access 旁路浏览器 confirm（block 已在上游拦）。
    if (shouldBypassConfirmApproval(threadId)) return true
    const result = await requestApproval({
      actionType: `browser.${decision.actionType}`,
      detail: decision.detail,
      reason: decision.reason,
      timeoutMs: BROWSER_CLI_APPROVAL_TIMEOUT_MS,
    })
    return result.approved
  },
}

// ─── Access Barrier HITL ────────────────────────────────────────────────────

/**
 * 把 `BrowserOrchestrator` 的撞墙暂停接到当前会话 HITL 通道。
 *
 * `requestAccessBarrierResolution` 读 `runWithBrowserApprovalContext` 建立的
 * AsyncLocalStorage 上下文（threadId + interactionMode），再委托进程级
 * `setHumanInteractionHooks({ resolveAccessBarrier })` 注册的实装
 * （`ElectronAgentHost` → `AgentHost.presentAccessBarrier`）落到真实卡片 + 挂起。
 * 拿不到 threadId 或进程级未注册 → 诚实失败 `host_unavailable`（不空转 glance、
 * 不假装成功）。
 *
 * 只需注入到 `interaction.ts` 的 act/glance/eval hostHooks——这是本仓库里
 * `BrowserOrchestrator` 唯一会走到 act/observe 投影分支（即可能撞登录墙/验证码）
 * 的 Electron route；record/run/resources/introspect 系 actionId 不经该分支，
 * 注入了也是 no-op，故未逐一加（省得每条 route 都要记一遍这段说明）。
 */
export function resolveAccessBarrierHostHook(): BrowserOrchestratorHostHooks['resolveAccessBarrier'] {
  return async (barrier) => {
    const resolution = await requestAccessBarrierResolution(barrier)
    // HITL 超时：记下 tab，同 run 下次 open 跳过 reuse，避免粘死登录墙旧页。
    if (resolution.action === 'timeout') {
      const { markAccessBarrierTabTimedOut } = await import('./access-barrier-tab-reuse')
      markAccessBarrierTabTimedOut(barrier.tabId)
    }
    return resolution
  }
}

function resolveFromMainSnapshot(
  requestedMode: 'active_only' | 'active_or_first',
  crawlspaceId?: string | null,
): string | undefined {
  const resolvedCrawlspaceId = crawlspaceId || getCLICrawlspaceId()
  if (!resolvedCrawlspaceId) {
    return undefined
  }

  const snapshot = getCrawlspaceContextHub().getSnapshot(resolvedCrawlspaceId)
  const views = Array.isArray(snapshot?.views)
    ? snapshot.views.filter((view) => !view.isClosing)
    : []

  const activeView = snapshot?.activeViewId
    ? views.find((view) => view.viewId === snapshot.activeViewId)
    : undefined
  if (activeView && isCliVisibleBrowserView(activeView.viewId)) {
    return activeView.viewId
  }

  if (requestedMode === 'active_only') {
    return undefined
  }

  const fallback = views.find((view) => isCliVisibleBrowserView(view.viewId))
  return fallback?.viewId
}

export function assertBrowserTabAvailableForAgent(viewId: string): void {
  assertBrowserTabAvailableForAgentInRegistry(viewId)
}

function acceptResolvedTabId(viewId: string): string {
  assertBrowserTabAvailableForAgent(viewId)
  return viewId
}

export async function resolveTabId(
  tabId: string | undefined,
  scope?: ResolveTabScope,
): Promise<string | undefined> {
  const requestedMode = tabId === 'auto' ? 'active_only' : 'active_or_first'

  if (tabId && tabId !== 'auto') {
    if (validateViewExists(tabId)) return acceptResolvedTabId(tabId)
    return undefined
  }

  const bridge = getCLIContextSpaceBridge()
  const spaceId = scope?.spaceId || getCLISpaceId()
  const threadId = scope?._thread_id || null
  const defaultWorkspaceScopeKey = threadId ? getCLIWorkspaceScopeKey(threadId) : null
  const effectiveTabScopeKey = scope?.tabScopeKey || scope?.workspaceScopeKey || defaultWorkspaceScopeKey
  const hasWorkspaceScope = Boolean(effectiveTabScopeKey)
  if (!hasWorkspaceScope) {
    const snapshotResolved = resolveFromMainSnapshot(requestedMode, scope?.crawlspaceId)
    if (snapshotResolved) {
      return acceptResolvedTabId(snapshotResolved)
    }
  }
  if (!bridge || !spaceId) return undefined

  try {
    const result = await bridge('list_context_space', {
      spaceId,
      ...(effectiveTabScopeKey ? { tabScopeKey: effectiveTabScopeKey, workspaceScopeKey: effectiveTabScopeKey } : {}),
      crawlspaceId: scope?.crawlspaceId || getCLICrawlspaceId(),
    })
    if (result?.success !== true) {
      return undefined
    }
    const tabs = Array.isArray(result?.data?.tabs) ? result.data.tabs : []
    const visibleBrowserViewIds = tabs
      .filter((tab: any) => tab?.type === 'tabweb')
      .map((tab: any) => tab.id || tab.viewId)
      .filter(
        (candidate: any): candidate is string =>
          typeof candidate === 'string' && candidate.length > 0,
      )
    const visibleBrowserViewIdSet = new Set(
      visibleBrowserViewIds.filter((candidate: string) =>
        isCliVisibleBrowserView(candidate),
      ),
    )
    const activeTabKey: string | undefined = result?.data?.activeTabKey
    if (activeTabKey?.startsWith('tabweb:')) {
      const parts = activeTabKey.split(':')
      const resolved =
        parts.length > 1 ? parts.slice(1).join(':') : activeTabKey
      if (visibleBrowserViewIdSet.has(resolved)) return acceptResolvedTabId(resolved)
    }
    if (requestedMode === 'active_only') {
      return undefined
    }
    const fallbackBrowserViewId = visibleBrowserViewIds.find(
      (candidate: string) => visibleBrowserViewIdSet.has(candidate),
    )
    if (fallbackBrowserViewId) {
      return acceptResolvedTabId(fallbackBrowserViewId)
    }
  } catch (error) {
    if (error instanceof BrowserTabUserInControlError) throw error
    /* bridge failed, fall through */
  }
  return undefined
}

/**
 * tab switch 专用解析：以 renderer 标签清单为准，允许冷启动后尚未创建
 * WebContentsView 的 deferred 标签通过。其它需要直接操作 webContents 的 CLI
 * 仍继续使用 resolveTabId / validateViewExists，避免放宽执行前置条件。
 */
export async function resolveContextBrowserTabId(
  tabId: string,
  scope?: ResolveTabScope,
): Promise<string | undefined> {
  const bridge = getCLIContextSpaceBridge()
  const spaceId = scope?.spaceId || getCLISpaceId()
  if (!bridge || !spaceId) return undefined

  const threadId = scope?._thread_id || null
  const defaultWorkspaceScopeKey = threadId ? getCLIWorkspaceScopeKey(threadId) : null
  const effectiveTabScopeKey = scope?.tabScopeKey || scope?.workspaceScopeKey || defaultWorkspaceScopeKey

  try {
    const result = await bridge('list_context_space', {
      spaceId,
      ...(effectiveTabScopeKey ? {
        tabScopeKey: effectiveTabScopeKey,
        workspaceScopeKey: effectiveTabScopeKey,
      } : {}),
      crawlspaceId: scope?.crawlspaceId || getCLICrawlspaceId(),
    })
    if (result?.success !== true) return undefined

    const browserViewIds = (Array.isArray(result?.data?.tabs) ? result.data.tabs : [])
      .filter((tab: any) => tab?.type === 'tabweb')
      .map((tab: any) => tab.id || tab.viewId)
      .filter(
        (candidate: any): candidate is string =>
          typeof candidate === 'string' && candidate.length > 0,
      )
    const browserViewIdSet = new Set(browserViewIds)

    if (tabId !== 'auto') {
      return browserViewIdSet.has(tabId) ? acceptResolvedTabId(tabId) : undefined
    }

    const activeTabKey = typeof result?.data?.activeTabKey === 'string'
      ? result.data.activeTabKey
      : null
    if (!activeTabKey?.startsWith('tabweb:')) return undefined
    const activeViewId = activeTabKey.slice('tabweb:'.length)
    return browserViewIdSet.has(activeViewId)
      ? acceptResolvedTabId(activeViewId)
      : undefined
  } catch (error) {
    if (error instanceof BrowserTabUserInControlError) throw error
    return undefined
  }
}

export function validateViewExists(viewId: string): boolean {
  const viewGetter = getCLIViewGetter()
  if (!viewGetter) return false
  try {
    const view = viewGetter(viewId)
    return !!(view?.webContents && !view.webContents.isDestroyed())
  } catch {
    return false
  }
}

function isCliVisibleBrowserView(viewId: string): boolean {
  if (!validateViewExists(viewId)) {
    return false
  }
  try {
    const state = getViewFactory().getViewState(viewId)
    if (!state) {
      return true
    }
    return state.config.displayMode !== 'hidden'
  } catch {
    return false
  }
}

/**
 * Resolve tab + get BrowserView with webContents.
 * Returns `{ tabId, view }` or sends error and returns null.
 */
export async function requireTabWithView(
  rawTabId: string | undefined,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  scope?: ResolveTabScope,
): Promise<{ tabId: string; view: any } | null> {
  const tabId = await resolveTabId(rawTabId, scope)
  if (!tabId) {
    sendJSON(
      res,
      400,
      errorResponse('TAB_REQUIRED', '无活跃 tab，请先 open 一个页面', {
        suggestions: ['tabtin browser open "https://example.com"'],
      }),
    )
    return null
  }

  const viewGetter = getCLIViewGetter()
  if (!viewGetter) {
    sendJSON(
      res,
      500,
      errorResponse('VIEW_GETTER_MISSING', 'Electron viewGetter 未就绪'),
    )
    return null
  }

  const view = viewGetter(tabId)
  if (!view?.webContents || view.webContents.isDestroyed()) {
    sendJSON(
      res,
      400,
      errorResponse('VIEW_NOT_FOUND', `View ${tabId} 不存在或已销毁`, {
        suggestions: ['tabtin browser open "url" 重新打开页面'],
      }),
    )
    return null
  }

  lock(tabId, typeof scope?._thread_id === 'string' ? scope._thread_id : undefined)
  return { tabId, view }
}

/**
 * Validate ContextSpace bridge + spaceId availability.
 * Returns `{ bridge, spaceId }` or sends error and returns null.
 */
export function requireBridgeAndSpace(
  body: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
): {
  bridge: NonNullable<ReturnType<typeof getCLIContextSpaceBridge>>
  spaceId: string
} | null {
  const bridge = getCLIContextSpaceBridge()
  const spaceId = body?.spaceId || body?.space_id || getCLISpaceId()

  if (!bridge) {
    sendJSON(
      res,
      503,
      errorResponse(
        'INTERNAL_ERROR',
        'TabTin 界面尚未就绪，请确保应用窗口已打开',
        {
          retryable: true,
          suggestions: ['确保 TabTin 主窗口已显示', '等待几秒后重试'],
        },
      ),
    )
    return null
  }
  if (!spaceId) {
    sendJSON(
      res,
      400,
      errorResponse(
        'VALIDATION_ERROR',
        '未选择组织，请先在 TabTin 中打开一个 Space',
        {
          suggestions: ['在 TabTin 中创建或选择一个 Space'],
        },
      ),
    )
    return null
  }

  return { bridge, spaceId }
}

export function enhanceErrorResponse(
  error: any,
  sendJSON: SendJSON,
  res: http.ServerResponse,
): boolean {
  if (!error) return false
  const msg =
    typeof error === 'string' ? error : (error?.message ?? error?.error ?? '')

  if (msg.includes('未注册的工具') || msg.includes('unregistered tool')) {
    sendJSON(
      res,
      400,
      errorResponse(
        'VALIDATION_ERROR',
        '该功能当前不可用，请确保 TabTin 已更新到最新版本',
        {
          suggestions: [
            '请更新 TabTin 到最新版本',
            '运行 tabtin doctor 检查环境',
          ],
          detail: { original: msg },
        },
      ),
    )
    return true
  }

  if (msg.includes('View not found') || msg.includes('view not found')) {
    sendJSON(
      res,
      404,
      errorResponse('NOT_FOUND', '找不到目标标签页，请先打开一个页面', {
        suggestions: [
          '使用 tabtin browser open <url> 打开页面',
          '使用 tabtin browser tab list 查看已打开的标签页',
          '使用 --tab <viewId> 指定标签页',
        ],
        detail: { original: msg },
      }),
    )
    return true
  }

  if (
    msg.includes('Resource not found') ||
    msg.includes('resource not found')
  ) {
    sendJSON(
      res,
      404,
      errorResponse(
        'RESOURCE_NOT_FOUND',
        '找不到目标资源，可能已失效或所属标签已关闭',
        {
          suggestions: [
            '重新执行 tabtin browser resource list 获取最新 resourceId',
            '确认所属页面仍处于打开状态',
            '如资源依赖页面上下文，可显式传入 --tab <viewId>',
          ],
          detail: { original: msg },
        },
      ),
    )
    return true
  }

  if (
    msg.includes('resourceId/url is required') ||
    msg.includes('resourceId or url is required') ||
    msg.includes('resourceId is required') ||
    msg.includes('resourceId/url + viewId is required')
  ) {
    sendJSON(
      res,
      400,
      errorResponse(
        'VALIDATION_ERROR',
        '缺少 resourceId、url 或必要的 viewId 参数',
        {
          suggestions: [
            '显式传入 resourceId',
            '或传入 url（需要页面上下文时再补充 --tab <viewId>）',
          ],
          detail: { original: msg },
        },
      ),
    )
    return true
  }

  if (msg.includes('尚未初始化') || msg.includes('not initialized')) {
    sendJSON(
      res,
      503,
      errorResponse(
        'INTERNAL_ERROR',
        'TabTin 正在启动中，请稍后重试（通常需要 5-10 秒）',
        {
          retryable: true,
          suggestions: ['等待几秒后重试', '确保 TabTin 应用已完全启动'],
          detail: { original: msg },
        },
      ),
    )
    return true
  }

  if (
    msg.includes('invoke timeout') ||
    (msg.includes('context-space') && msg.includes('timeout'))
  ) {
    sendJSON(
      res,
      504,
      errorResponse('CONNECTION_TIMEOUT', '操作超时，可能是页面加载缓慢', {
        retryable: true,
        suggestions: [
          '检查网络连接',
          '增加 --timeout 参数',
          '确保 TabTin 前端窗口未被冻结',
        ],
        detail: { original: msg },
      }),
    )
    return true
  }

  return false
}

export function sendExecutorResult(
  result: any,
  res: http.ServerResponse,
  sendJSON: SendJSON,
  opts?: { dataOverride?: any },
): void {
  const isOk = result.success !== false
  if (!isOk && enhanceErrorResponse(result.error ?? result, sendJSON, res))
    return

  if (isOk) {
    sendJSON(res, 200, okResponse(opts?.dataOverride ?? result.data ?? result))
  } else {
    sendJSON(
      res,
      500,
      errorResponse('INTERNAL_ERROR', result.error || 'Operation failed'),
    )
  }
}

export function handleRouteError(
  err: any,
  sendJSON: SendJSON,
  res: http.ServerResponse,
): void {
  if (sendBrowserTabUserInControlError(err, sendJSON, res)) return

  if (!enhanceErrorResponse(err?.message || String(err), sendJSON, res)) {
    sendJSON(
      res,
      500,
      errorResponse('INTERNAL_ERROR', err?.message || String(err), {
        suggestions: [
          '检查命令参数是否正确',
          '运行 tabtin browser --help 查看用法',
        ],
      }),
    )
  }
}
