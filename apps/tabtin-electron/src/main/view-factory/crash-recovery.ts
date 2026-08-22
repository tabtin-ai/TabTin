/**
 * crash-recovery — View 崩溃恢复事件绑定
 *
 * 从 ViewFactory.createView 提取，负责监听 render-process-gone / unresponsive / responsive。
 */

import type { BrowserWindow, WebContentsView } from 'electron'
import { reportMainError } from '../services/mainErrorReporter'
import { createLogger } from '../logger'
import type { OpenIntentHints } from '../../shared/open-intent'
import { guardDirectLoadURL } from '../blocked-preview-load'

// 崩溃/恢复是高价值诊断事件：走 createLogger（打包版落 main.log），
// 不走 ViewFactory 注入的 verbose-gated console（打包版静默、诊断包里看不到）。
const crashLog = createLogger('ViewFactory')

const UNRESPONSIVE_TIMEOUT_MS = 10_000
const CRASH_ACTION_PREFIX = '__CRASH_ACTION__:'

/** 构建崩溃错误页面（data: URL），中英双语文案，按钮通过 console-message 桥接主进程 */
function buildCrashErrorPage(): string {
  const html =
    '<!DOCTYPE html><html><head><meta charset="utf-8">' +
    '<style>' +
    'body{display:flex;align-items:center;justify-content:center;height:100vh;margin:0;' +
    'font-family:-apple-system,system-ui,sans-serif;background:#1e1e1e;color:#d4d4d4}' +
    '.c{text-align:center}h2{color:#f48771;margin-bottom:8px}' +
    'p{color:;font-size:14px;margin-bottom:24px}' +
    '.hint{font-size:12px;color:;margin-bottom:24px}' +
    '.btns{display:flex;gap:12px;justify-content:center}' +
    'button{padding:8px 20px;border:none;border-radius:6px;font-size:14px;cursor:pointer;' +
    'transition:opacity .15s}button:hover{opacity:.85}' +
    '.reload{background:#0078d4;color:#fff}.close{background:#3a3a3a;color:#d4d4d4}' +
    '@media(prefers-color-scheme:light){' +
    'body{background:#f5f5f5;color:#1e1e1e}' +
    'h2{color:#d32f2f}' +
    'p{color:}' +
    '.hint{color:}' +
    '.close{background:#e0e0e0;color:#1e1e1e}' +
    '}' +
    '</style></head><body><div class="c">' +
    '<h2>此页面反复崩溃 / This page has crashed repeatedly</h2>' +
    '<p>该页面已连续崩溃多次，已停止自动恢复。<br>' +
    'This page has crashed multiple times. Auto-recovery has been stopped.</p>' +
    '<p class="hint">如重新加载后仍然崩溃，请等待约 1 分钟后再试。<br>' +
    'If reloading fails again, wait about 1 minute before retrying.</p>' +
    '<div class="btns">' +
    `<button class="reload" type="button" onclick="console.log('${CRASH_ACTION_PREFIX}reload')">重新加载 Reload</button>` +
    `<button class="close" type="button" onclick="console.log('${CRASH_ACTION_PREFIX}close')">关闭标签 Close Tab</button>` +
    '</div></div></body></html>'
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export interface CrashRecoveryCallbacks {
  /** 崩溃时同步 ViewFactory 内部状态，防止 LRU 误清理正在恢复的 View */
  syncState?: (update: { lastAccessAt?: number; inUse?: boolean; hasError?: boolean }) => void
  /**
   * 记录一次崩溃并返回是否允许继续恢复（频率限制：3 次/分钟）。
   * 返回 true 表示允许恢复，false 表示超过频率限制应停止恢复。
   * crashHistory 由 ViewFactory 按 URL 维度统一维护，避免 View 重建后计数丢失。
   * @param url 崩溃时的页面 URL，用于 URL 维度的频率计数
   */
  checkCrashLimit?: (url: string) => boolean
  /** 请求关闭该 View（由崩溃错误页面的"关闭标签"按钮触发） */
  requestClose?: (viewId: string) => void
  /** 崩溃发生后、恢复尝试前调用，业务层可在此做清理（如清缓存、报错到 Hub） */
  onBeforeRecover?: (viewId: string, details: Electron.RenderProcessGoneDetails) => void
  /** 恢复失败（频率超限或 loadURL 异常）时调用，业务层可在此移除 View */
  onRecoverFailed?: (viewId: string, error?: Error) => void
  /** 恢复成功后调用，业务层可在此清除错误状态 */
  onRecoverSuccess?: (viewId: string) => void
}

// ---------------------------------------------------------------------------
// Callback factory（从 ViewFactory.createView 提取的回调构造逻辑）
// ---------------------------------------------------------------------------

export interface CrashRecoveryDeps {
  hasView: (id: string) => boolean
  crashHistory: Map<string, number[]>
  getViewStateRegistry: () => {
    hasView(id: string): boolean
    updateState(id: string, updates: any): void
  }
  destroyView: (id: string, opts: { force: boolean }) => Promise<void>
  crashWindowMs?: number
  maxCrashes?: number
}

export interface CrashRecoveryHandlerOptions {
  getMainWindow?: () => BrowserWindow | null | undefined
  getOpenIntentHints?: () => OpenIntentHints | undefined
}

/**
 * 构建 CrashRecoveryCallbacks，将 ViewFactory 内部状态绑定到崩溃恢复回调。
 *
 * 提取自 ViewFactory.createView 中 28 行内联回调，降低 createView 认知负荷。
 */
export function buildCrashRecoveryCallbacks(
  viewId: string,
  deps: CrashRecoveryDeps,
): CrashRecoveryCallbacks {
  const CRASH_WINDOW_MS = deps.crashWindowMs ?? 60_000
  const MAX_CRASHES = deps.maxCrashes ?? 3

  return {
    syncState: (update) => {
      if (!deps.hasView(viewId)) return
      try {
        const registry = deps.getViewStateRegistry()
        if (registry.hasView(viewId)) {
          const vsrUpdate: Record<string, any> = {}
          if (update.lastAccessAt !== undefined) vsrUpdate.lastAccessTime = update.lastAccessAt
          if (update.inUse !== undefined) vsrUpdate.inUse = update.inUse
          if (update.hasError !== undefined) vsrUpdate.hasError = update.hasError
          registry.updateState(viewId, vsrUpdate)
        }
      } catch {
        // VSR not ready
      }
    },
    checkCrashLimit: (url) => {
      const crashKey = url || viewId
      const now = Date.now()
      const history = (deps.crashHistory.get(crashKey) ?? []).filter(t => now - t < CRASH_WINDOW_MS)
      history.push(now)
      deps.crashHistory.set(crashKey, history)
      return history.length <= MAX_CRASHES
    },
    requestClose: (id) => {
      void deps.destroyView(id, { force: true })
    },
  }
}

// ---------------------------------------------------------------------------
// Crash-recovery callback registry
//
// 允许业务层（如 embedded-crawl-view）在 View 创建后补充
// onBeforeRecover / onRecoverFailed / onRecoverSuccess 回调，
// 统一到 crash-recovery 单入口处理，消除双重 render-process-gone 监听冲突。
// ---------------------------------------------------------------------------

const crashCallbacksRegistry = new Map<string, CrashRecoveryCallbacks>()

/**
 * 为指定 View 补充或更新崩溃恢复生命周期回调。
 *
 * 仅合并 onBeforeRecover / onRecoverFailed / onRecoverSuccess 三个钩子，
 * 不覆盖 ViewFactory 通用层设置的核心回调（syncState / checkCrashLimit / requestClose）。
 */
export function updateCrashRecoveryCallbacks(
  viewId: string,
  update: Pick<CrashRecoveryCallbacks, 'onBeforeRecover' | 'onRecoverFailed' | 'onRecoverSuccess'>,
): void {
  const existing = crashCallbacksRegistry.get(viewId)
  if (!existing) return
  if (update.onBeforeRecover !== undefined) existing.onBeforeRecover = update.onBeforeRecover
  if (update.onRecoverFailed !== undefined) existing.onRecoverFailed = update.onRecoverFailed
  if (update.onRecoverSuccess !== undefined) existing.onRecoverSuccess = update.onRecoverSuccess
}

/** 清除指定 View 的崩溃恢复回调（View 销毁时自动调用，也可手动调用） */
export function clearCrashRecoveryCallbacks(viewId: string): void {
  crashCallbacksRegistry.delete(viewId)
}

export function attachCrashRecoveryHandlers(
  view: WebContentsView,
  viewId: string,
  emit: (event: string, payload: any) => void,
  log: (...args: unknown[]) => void,
  callbacks?: CrashRecoveryCallbacks,
  options?: CrashRecoveryHandlerOptions,
): void {
  // 将回调存入注册表，业务层可通过 updateCrashRecoveryCallbacks 补充钩子
  const storedCallbacks: CrashRecoveryCallbacks = { ...callbacks }
  crashCallbacksRegistry.set(viewId, storedCallbacks)

  let lastCrashUrl = ''
  let crashPageActive = false

  view.webContents.once('destroyed', () => {
    crashCallbacksRegistry.delete(viewId)
  })

  view.webContents.on('did-navigate', (_e: any, url: string) => {
    crashPageActive = url.startsWith('data:text/html')
  })

  // data: URL 错误页面无法注入 preload / ipcRenderer，
  // 通过约定前缀的 console.log 消息将用户操作传递回主进程。
  // 仅在加载了崩溃页（data: URL）后才响应，防止恶意页面伪造指令。
  view.webContents.on('console-message', (_event: any, _level: any, message: string) => {
    if (!crashPageActive || !message.startsWith(CRASH_ACTION_PREFIX)) return
    const action = message.slice(CRASH_ACTION_PREFIX.length)
    if (action === 'reload') {
      if (view.webContents.isDestroyed()) return
      try {
        const reloadUrl = lastCrashUrl || 'about:blank'
        const previewGuard = guardDirectLoadURL({
          url: reloadUrl,
          source: 'ViewFactory.crash-error-reload',
          mainWindow: options?.getMainWindow?.(),
          ...options?.getOpenIntentHints?.(),
        })
        if (previewGuard.action === 'block-preview') {
          crashLog.info(`崩溃页 reload 已转 Preview: view=${viewId}, kind=${previewGuard.intent.previewKind}`)
          return
        }
        crashPageActive = false
        view.webContents.loadURL(reloadUrl)
      } catch (e) {
        crashLog.error(`崩溃页 reload 操作失败: view=${viewId}`, e)
      }
    } else if (action === 'close') {
      crashCallbacksRegistry.get(viewId)?.requestClose?.(viewId)
    }
  })

  view.webContents.on('render-process-gone', (_event: any, details: any) => {
    const reason = details?.reason || 'unknown'
    const cb = crashCallbacksRegistry.get(viewId)
    crashLog.warn(`View ${viewId} render-process-gone (reason=${reason}, exitCode=${details?.exitCode})，尝试自动恢复...`)

    // 上报渲染进程崩溃到错误监控
    reportMainError(
      new Error(`Render process gone: ${reason} (view: ${viewId})`),
      { viewId, reason, exitCode: details?.exitCode },
      reason === 'crashed' || reason === 'killed' ? 'fatal' : 'error',
    )

    if (!view.webContents || view.webContents.isDestroyed()) {
      emit('view:crash', { id: viewId, reason, url: '' })
      return
    }

    const lastUrl = view.webContents.getURL()

    // 通知业务层：崩溃已发生，恢复尝试前执行清理
    cb?.onBeforeRecover?.(viewId, details)

    // P2-06: 崩溃发生时立即标记 hasError，供 CrawlspaceContextHub 等消费方感知错误状态
    cb?.syncState?.({ hasError: true })

    // 频率限制：超过阈值后停止恢复，加载错误页面
    if (cb?.checkCrashLimit && !cb.checkCrashLimit(lastUrl)) {
      crashLog.error(`View ${viewId} 崩溃频率超限，停止自动恢复，加载错误页面`)
      lastCrashUrl = lastUrl
      try {
        view.webContents.loadURL(buildCrashErrorPage())
      } catch (e) {
        crashLog.error(`加载崩溃错误页面失败: view=${viewId}`, e)
      }
      cb?.onRecoverFailed?.(viewId, new Error(`Crash rate limit exceeded for ${lastUrl}`))
      emit('view:crash', { id: viewId, reason, url: lastUrl })
      return
    }

    // 立即更新 lastAccessAt，防止 LRU 在恢复期间将此 View 误判为空闲并销毁
    cb?.syncState?.({ lastAccessAt: Date.now(), inUse: true })

    const navigationHistory = (view.webContents as any).navigationHistory

    try {
      const entries =
        typeof navigationHistory?.getAllEntries === 'function'
          ? navigationHistory.getAllEntries()
          : []
      const activeIndex =
        typeof navigationHistory?.getActiveIndex === 'function'
          ? navigationHistory.getActiveIndex()
          : -1

      if (
        typeof navigationHistory?.restore === 'function'
        && Array.isArray(entries)
        && entries.length > 0
        && activeIndex >= 0
      ) {
        navigationHistory.restore({ entries, index: activeIndex })
        crashLog.info(`View ${viewId} 已通过 navigationHistory.restore 恢复`)
      } else {
        const recoveryUrl = lastUrl || 'about:blank'
        const previewGuard = guardDirectLoadURL({
          url: recoveryUrl,
          source: 'ViewFactory.crash-recovery',
          mainWindow: options?.getMainWindow?.(),
          ...options?.getOpenIntentHints?.(),
        })
        if (previewGuard.action === 'block-preview') {
          crashLog.info(`View ${viewId} 崩溃恢复 URL 已转 Preview: kind=${previewGuard.intent.previewKind}`)
          cb?.onRecoverFailed?.(viewId, new Error(`Preview required for crash recovery URL: ${previewGuard.intent.previewKind}`))
          emit('view:crash', { id: viewId, reason, url: lastUrl })
          return
        }
        view.webContents.loadURL(recoveryUrl)
        crashLog.info(`View ${viewId} 已通过 loadURL 恢复`)
      }
      cb?.onRecoverSuccess?.(viewId)
      cb?.syncState?.({ hasError: false })
    } catch (e) {
      crashLog.error(`自动恢复 loadURL 失败: view=${viewId}`, e)
      cb?.onRecoverFailed?.(viewId, e instanceof Error ? e : new Error(String(e)))
    }
    emit('view:crash', { id: viewId, reason, url: lastUrl })
  })

  view.webContents.on('unresponsive', () => {
    crashLog.warn(`View ${viewId} unresponsive，${UNRESPONSIVE_TIMEOUT_MS / 1000}s 后强制恢复...`)
    let recovered = false
    const onResponsive = () => { recovered = true }
    view.webContents.once('responsive', onResponsive)
    setTimeout(() => {
      if (view.webContents && !view.webContents.isDestroyed()) {
        view.webContents.removeListener('responsive', onResponsive)
      }
      if (recovered) {
        log(`[ViewFactory] View ${viewId} 已在超时前恢复，跳过强制恢复`)
        return
      }
      try {
        if (!view.webContents.isDestroyed()) {
          view.webContents.forcefullyCrashRenderer()
        }
      } catch (e) {
        crashLog.error(`强制恢复失败: view=${viewId}`, e)
      }
    }, UNRESPONSIVE_TIMEOUT_MS)
  })

  view.webContents.on('responsive', () => {
    log(`[ViewFactory] View ${viewId} responsive — 恢复正常`)
  })
}
