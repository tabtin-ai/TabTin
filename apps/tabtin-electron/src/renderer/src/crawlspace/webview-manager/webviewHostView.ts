/**
 * webviewHostView — flag=webview 时替换 EmbeddedCrawlView 的 hostView
 *
 * 设计：只覆盖**容器相关**的四个操作（show / hide / setViewBounds / destroy），
 * 其余（goBack / reload / stop / zoom / screenshot / executeScript /
 * getNavigationState / onEvent / touch …）原样透传给 WCV 版 hostView——
 * 这些走主进程 WebContents 路径，Phase 1 已容器无关，guest 经
 * `ViewFactory.getWebContents` 同样可达。
 *
 * show 语义映射（对照 WCV 的 crawl-view:show）：
 *   - 无 guest：announce → 创建 <webview>（初始 src=url）→ 定位 + 显示。
 *     初始加载由 src 承担，不再 navigate。
 *   - 已有 guest：定位 + 显示 + `webview-host:navigate`（主进程按当前 URL
 *     归一化去重 + 安全校验 + 任务锁，与 WCV showEmbeddedView 同口径——
 *     切 tab 重复 show 不会误 reload）。
 *
 * 几何单位纪律（zoom 抖动根因修复，2026-07-17）：
 *   调用方传入的 ViewBounds 是 WCV 语义的窗口坐标（CSS px × zoomFactor，
 *   供主进程 WebContentsView.setBounds 用）；<webview> 是 DOM 元素，定位
 *   单位是 renderer CSS px。两者在 zoomFactor ≠ 1 时不等，直接落样式会与
 *   WebviewManager 自身的 rAF 测量（CSS px）交替写入、来回抖动。因此本层
 *   **不信任传入 bounds 的数值**，只当"该重新定位"的触发信号，实际几何
 *   一律由 WebviewManager 自己测量 slot rect（单一事实来源）。
 */

import type { CrawlspaceHost } from '@tabtin/crawlspace-core'
import { getWebviewManager, type WebviewManager } from './WebviewManager'
import type { OpenIntentHints } from '@shared/open-intent'

type HostView = NonNullable<CrawlspaceHost['view']>
type OpenIntentHintOptions = { openIntentHints?: OpenIntentHints }

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

type NavigateResult = { success: boolean; skipped?: string; code?: string; error?: string }
type NavigateOptions = { expectedPartition?: string }
type WebviewHostNavigateBridge = { navigate?: (tabId: string, url: string, options?: NavigateOptions) => Promise<NavigateResult> }

function getWebviewHostBridge(): WebviewHostNavigateBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { tabtin?: { webviewHost?: WebviewHostNavigateBridge } }).tabtin?.webviewHost
}

type RunSessionBridge = { hasActiveRunForView?: (viewId: string) => Promise<{ active: boolean; runId?: string }> }

function getRunSessionBridge(): RunSessionBridge | undefined {
  if (typeof window === 'undefined') return undefined
  return (window as unknown as { tabtin?: { runSession?: RunSessionBridge } }).tabtin?.runSession
}

/** keepalive 兜底复查间隔：run 结束后最迟这么久回落 throttle 节流档 */
const KEEPALIVE_RECHECK_MS = 30_000

async function hasActiveRunForView(viewId: string): Promise<boolean> {
  try {
    const res = await getRunSessionBridge()?.hasActiveRunForView?.(viewId)
    return Boolean(res?.active)
  } catch {
    // 查询失败按"无 run"处理——fail-safe 落节流档，最坏只是 Agent 后台页面变慢
    return false
  }
}

export interface WebviewKeepaliveController {
  /** 调用方已经持有权威 runId（如 open_tab 创建链路），无需等待反查映射。 */
  activateKnownRun: (viewId: string) => void
  /** 普通 hide 链路先反查 viewId 是否仍属于活跃 run，再决定是否升级。 */
  maybeActivate: (viewId: string) => Promise<void>
  /** 页面显示或销毁时取消后台续期；后续由对应显隐流程接管。 */
  cancel: (viewId: string) => void
}

const keepaliveControllers = new WeakMap<WebviewManager, WebviewKeepaliveController>()

function createWebviewKeepaliveController(manager: WebviewManager): WebviewKeepaliveController {
  const recheckTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** 每次激活生成新 token，忽略 cancel 后才返回的异步 IPC 结果。 */
  const recheckTokens = new Map<string, symbol>()

  const clearRecheckTimer = (viewId: string): void => {
    const timer = recheckTimers.get(viewId)
    if (timer) clearTimeout(timer)
    recheckTimers.delete(viewId)
  }

  const cancel = (viewId: string): void => {
    clearRecheckTimer(viewId)
    recheckTokens.delete(viewId)
  }

  const scheduleRecheck = (viewId: string, token: symbol): void => {
    clearRecheckTimer(viewId)
    const timer = setTimeout(async () => {
      recheckTimers.delete(viewId)
      if (recheckTokens.get(viewId) !== token) return
      if (manager.getVisibility(viewId) !== 'keepalive') return
      const active = await hasActiveRunForView(viewId)
      if (recheckTokens.get(viewId) !== token) return
      if (manager.getVisibility(viewId) !== 'keepalive') return
      if (active) {
        scheduleRecheck(viewId, token)
      } else {
        manager.hide(viewId, 'throttle')
      }
    }, KEEPALIVE_RECHECK_MS)
    recheckTimers.set(viewId, timer)
  }

  const activateKnownRun = (viewId: string): void => {
    cancel(viewId)
    const visibility = manager.getVisibility(viewId)
    if (visibility !== 'throttle' && visibility !== 'keepalive') return
    const token = Symbol(viewId)
    recheckTokens.set(viewId, token)
    if (visibility === 'throttle') {
      manager.keepAliveHidden(viewId)
    }
    scheduleRecheck(viewId, token)
  }

  const maybeActivate = async (viewId: string): Promise<void> => {
    const active = await hasActiveRunForView(viewId)
    if (!active) return
    if (manager.getVisibility(viewId) !== 'throttle') return
    activateKnownRun(viewId)
  }

  return { activateKnownRun, maybeActivate, cancel }
}

/** 同一 manager 共享一个控制器，避免创建链路与 show/hide 链路各自维护定时器。 */
export function getWebviewKeepaliveController(
  manager: WebviewManager = getWebviewManager(),
): WebviewKeepaliveController {
  const existing = keepaliveControllers.get(manager)
  if (existing) return existing
  const controller = createWebviewKeepaliveController(manager)
  keepaliveControllers.set(manager, controller)
  return controller
}

export function createWebviewHostView(base: HostView, manager: WebviewManager = getWebviewManager()): HostView {
  /**
   * 显隐代际（display epoch）：hide / destroy 递增；show 在每次 await 后校验。
   *
   * 竞态根因（2026-07-20 live）：show 含 await ensure/navigate/rebuild，用户
   * 切走 tab 后 useWebviewDisplay 已调 hide，但迟到的 show 尾部仍 manager.show，
   * guest 浮在 parking 态 React 树之上关不掉（8 个 root 全在 parking，1 个
   * webview 仍 visible@lastRect）。
   */
  const displayEpoch = new Map<string, number>()

  const bumpDisplayEpoch = (viewId: string): void => {
    displayEpoch.set(viewId, (displayEpoch.get(viewId) ?? 0) + 1)
  }

  const isDisplayEpochCurrent = (viewId: string, epoch: number): boolean =>
    (displayEpoch.get(viewId) ?? 0) === epoch

  const keepaliveController = getWebviewKeepaliveController(manager)

  return {
    ...base,

    show: async (viewId, url, _bounds, runId, options) => {
      if (!viewId) {
        return { success: false, error: '[webviewHostView] show 缺少 viewId' }
      }
      keepaliveController.cancel(viewId)
      const epochAtStart = displayEpoch.get(viewId) ?? 0
      const ensureConfig = {
        url,
        profile: options?.profile,
        partition: options?.partition,
        crawlspaceId: options?.kind === 'workspace-view' ? options.crawlspaceId : undefined,
        kind: options?.kind,
        isPreview: options?.isPreview,
        runId,
        openIntentHints: (options as OpenIntentHintOptions | undefined)?.openIntentHints,
      }
      /**
       * stale-container 自愈：主进程权威条目被 WCV 影子容器占用（未迁移路径
       * 抢建），navigate 打不进可见 guest。销毁本地元素后以目标 URL 重建——
       * 重建走 announce → bind → adopt，adopt 会销毁影子条目、guest 接管。
       * 旧 guest 的 destroyed 收敛（释放 binding / 销毁影子条目）是异步的，
       * announce 可能短暂被「已绑定」拒绝，故带间隔重试。
       */
      const rebuildWithUrl = async (): Promise<{ success: boolean; error?: string; skipped?: string }> => {
        manager.destroy(viewId)
        let lastError = '[webviewHostView] 重建 guest 失败'
        for (let attempt = 0; attempt < 3; attempt++) {
          if (!isDisplayEpochCurrent(viewId, epochAtStart)) {
            return { success: true, skipped: 'stale-show' }
          }
          if (attempt > 0) {
            await new Promise((resolve) => setTimeout(resolve, 150 * attempt))
          }
          try {
            await manager.ensure(viewId, ensureConfig)
            if (!isDisplayEpochCurrent(viewId, epochAtStart)) {
              return { success: true, skipped: 'stale-show' }
            }
            manager.show(viewId)
            return { success: true }
          } catch (error) {
            lastError = errorMessage(error, lastError)
          }
        }
        return { success: false, error: lastError }
      }
      try {
        const existed = manager.has(viewId)
        if (!existed) {
          await manager.ensure(viewId, ensureConfig)
        }
        if (!isDisplayEpochCurrent(viewId, epochAtStart)) {
          return { success: true, skipped: 'stale-show' }
        }
        // bounds 数值不用（单位是 WCV 窗口坐标）；show 内部会 requestSync 自测量
        manager.show(viewId)

        if (existed) {
          // expectedPartition：让主进程比对权威条目 partition——env 绑定切换后
          // <webview> 的 partition 焊死在旧值，须销毁元素以新 partition 重建
          const nav = await getWebviewHostBridge()?.navigate?.(viewId, url, {
            expectedPartition: options?.partition,
          })
          if (!isDisplayEpochCurrent(viewId, epochAtStart)) {
            return { success: true, skipped: 'stale-show' }
          }
          if (nav && nav.success === false) {
            if (nav.code === 'stale-container') {
              console.warn('[webviewHostView] 主进程条目为 WCV 影子容器，销毁元素重建 guest:', viewId)
              return rebuildWithUrl()
            }
            if (nav.code === 'partition-mismatch') {
              // env 绑定切换（ Phase 3）：重建走与 stale-container 同一
              // 路径——ensureConfig 已带新 partition，announce 归一化后生效。
              // run 进行中主进程不会走到这里（返回 skipped 延迟重建）。
              console.warn('[webviewHostView] partition 已变更（env 绑定切换），销毁元素以新 partition 重建 guest:', viewId)
              return rebuildWithUrl()
            }
            // ：主进程旧版可能仍返回 success:false + PREVIEW_REQUIRED；
            // fallback 已在 navigate 侧发出，这里按软成功处理，避免 CrawlViewError。
            if (nav.code === 'PREVIEW_REQUIRED') {
              return { success: true, skipped: 'preview-required' }
            }
            return { success: false, error: nav.error || '[webviewHostView] navigate 失败' }
          }
          // skipped（task-lock / same-url）透传给调用方：导航未真正发生，
          // 地址栏不应停留在乐观更新后的目标 URL
          return { success: true, skipped: nav?.skipped }
        }
        return { success: true }
      } catch (error) {
        return { success: false, error: errorMessage(error, '[webviewHostView] show 失败') }
      }
    },

    hide: async (viewId) => {
      // WCV 版无 viewId 时隐藏"当前 tab"（主进程记账）；webview 容器没有主
      // 进程 currentTabId 概念，无 viewId 直接 no-op（调用点均显式传 id）
      if (viewId) {
        bumpDisplayEpoch(viewId)
        keepaliveController.cancel(viewId)
        manager.hide(viewId, 'throttle')
        // Agent 后台执行中的 tab 升级 keepalive 档（不节流），run 结束回落
        void keepaliveController.maybeActivate(viewId)
      }
      return { success: true }
    },

    setViewBounds: async (viewId, _viewBounds) => {
      if (!viewId) {
        return { success: false, error: '[webviewHostView] setViewBounds 缺少 viewId' }
      }
      // 传入值只作触发信号：数值是 WCV 窗口坐标（×zoomFactor），不能当
      // CSS px 落样式；由 manager 按 slot rect 自测量（不回填 applied，
      // 调用方 lastBoundsRef 回落 requested 值记账，两侧同单位、去重自洽）
      manager.requestSync(viewId)
      return { success: true } as { success: boolean; error?: string }
    },

    destroy: async (viewId) => {
      if (!viewId) {
        return { success: false, error: '[webviewHostView] destroy 缺少 viewId' }
      }
      keepaliveController.cancel(viewId)
      bumpDisplayEpoch(viewId)
      if (manager.has(viewId)) {
        // 元素移除 → guest 销毁 → 主进程经 destroyed 事件反注册
        manager.destroy(viewId)
        return { success: true }
      }
      // 没有本地 guest（如 flag 切换前遗留的 WCV view）→ 回落原路径
      return base.destroy
        ? base.destroy(viewId)
        : { success: false, error: '[webviewHostView] destroy 不可用' }
    },
  }
}
