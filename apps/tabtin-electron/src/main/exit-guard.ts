/**
 * 退出守卫（W2.5 T9）
 *
 * 用途：⌘Q / 关主窗口时，让 renderer 弹"合并 dirty 对话框"决定是否继续退出，
 * 避免未保存改动直接丢失。
 *
 * 设计：
 * - main 进程纯调度方：不知道有多少 dirty，也不弹 UI。把决策权交给 renderer。
 * - renderer 负责：
 *   1. collectAllDirty 聚合（已经在 dirtyRegistry 实现）
 *   2. 弹 DirtyExitConfirmHost 让用户三选
 *   3. saveAll / discard 后回调 'continue'，cancel 时回调 'cancel'
 * - main 兜底：
 *   - 超时（默认 30s）= renderer 卡死或 hang，弹原生 dialog 让用户最后决定（"仍要退出"/"取消"）
 *   - 首次调用未拿到 mainWindow = 直接 'continue'（无 UI 可弹，不能阻塞退出）
 *   - 重复触发（macOS 上用户可能连按 ⌘Q）= 复用同一 pending request，不重复弹对话框
 *
 * 与 slide:flush-before-close 的关系：
 * - slide flush 是机器自动保存（不需用户决策），用于 mainWindow.close 流程的最后一步
 * - exit-guard 是用户决策（dirty 列表 + 三选），优先于 slide flush
 * - 顺序：exit-guard 'continue' → slide flush → mainWindow.close
 *
 * 与 onBeforeQuit 的关系：
 * - exit-guard 拦在 before-quit 的最前（在 onBeforeQuit 调用之前）
 * - 'continue' → isQuitting=true → 走原 onBeforeQuit + app.quit
 * - 'cancel' → 维持 isQuitting=false，下次再触发 before-quit 还会再问
 */
import { dialog, ipcMain } from 'electron'
import type { BrowserWindow, WebContents } from 'electron'

export type ExitGuardChoice = 'continue' | 'cancel'

/**
 * 退出守卫的触发原因。决定 renderer 弹的对话框文案与按钮：
 *   - `app-quit` — Cmd+Q / Quit menu，文案 "退出前确认"
 *   - `window-close` — 关闭主窗口，文案 "关闭窗口前确认"
   *   - `app-relaunch` — Agent 调 `relaunch_app` 触发的重启，文案 "重启前确认"
 *     （用户对话语境是"重启"而非"退出"——必须分支，否则认知断裂）
 */
export type ExitGuardReason = 'app-quit' | 'window-close' | 'app-relaunch'

export interface ExitGuardLogger {
  info: (...args: unknown[]) => void
  warn: (...args: unknown[]) => void
  error: (...args: unknown[]) => void
}

export interface ExitGuardOptions {
  log: ExitGuardLogger
  /** 获取主窗口；返回 null 时退出守卫直接降级（continue），不阻塞退出 */
  getMainWindow: () => BrowserWindow | null
  /** renderer 响应超时；超时后弹原生 dialog 让用户最后决定 */
  timeoutMs?: number
  /** 测试钩子：覆盖原生 dialog（避免 unit test 真的弹窗） */
  showNativeFallback?: (window: BrowserWindow, reason: ExitGuardReason) => Promise<ExitGuardChoice>
}

export interface ExitGuardController {
  /**
   * 询问 renderer 是否可以退出 / 关闭。
   * 返回 'continue' 表示继续，'cancel' 表示用户取消。
   * 在重复并发调用时复用同一 pending（避免叠加多个 IPC request）。
   */
  ask: (reason: ExitGuardReason) => Promise<ExitGuardChoice>
  dispose: () => void
}

const REQUEST_CHANNEL = 'app:exit-guard:request'
const RESPONSE_CHANNEL = 'app:exit-guard:response'
const DEFAULT_TIMEOUT_MS = 30_000

interface PendingRequest {
  requestId: string
  reason: ExitGuardReason
  resolve: (choice: ExitGuardChoice) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

export function createExitGuardController(options: ExitGuardOptions): ExitGuardController {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const log = options.log
  let pending: PendingRequest | null = null
  let nextSeq = 0

  // 原生 dialog 兜底：renderer 卡死或没启动时，最后让用户做决定。
  // 文案硬编码中文（renderer 卡死时 i18n 也可能加载失败；此 fallback 触发概率极低，
  // 中文默认比 string template 字面量更友好）；按 reason 区分按钮文案，避免
  // window-close 时显示"仍然退出"造成误解。
  const showNativeFallback = options.showNativeFallback
    ?? (async (win: BrowserWindow, reason: ExitGuardReason): Promise<ExitGuardChoice> => {
      const messageMap: Record<ExitGuardReason, { title: string; message: string; confirmLabel: string }> = {
        'app-quit': {
          title: '应用未响应',
          message: '无法获取当前未保存改动列表。仍要退出可能会丢失数据。',
          confirmLabel: '仍然退出',
        },
        'window-close': {
          title: '窗口未响应',
          message: '无法获取当前未保存改动列表。仍要关闭可能会丢失数据。',
          confirmLabel: '仍然关闭',
        },
        'app-relaunch': {
          title: '应用未响应',
          message: '无法获取当前未保存改动列表。仍要重启 TabTin 可能会丢失未保存的改动。',
          confirmLabel: '仍然重启',
        },
      }
      const { title, message, confirmLabel } = messageMap[reason]
      const result = await dialog.showMessageBox(win, {
        type: 'warning',
        title,
        message,
        buttons: ['取消', confirmLabel],
        defaultId: 0,
        cancelId: 0,
      })
      return result.response === 1 ? 'continue' : 'cancel'
    })

  const finalize = (choice: ExitGuardChoice) => {
    if (!pending) return
    const current = pending
    pending = null
    clearTimeout(current.timeoutHandle)
    current.resolve(choice)
  }

  const responseHandler = (event: import('electron').IpcMainEvent, payload: unknown) => {
    if (!pending) return
    // 防御：仅接受来自主窗口 webContents 的响应
    const win = options.getMainWindow()
    if (win && event.sender !== win.webContents) {
      log.warn('[exit-guard] 收到非主窗口的响应，忽略')
      return
    }
    if (!isResponsePayload(payload)) {
      log.warn('[exit-guard] 收到无效响应 payload，忽略:', payload)
      return
    }
    if (payload.requestId !== pending.requestId) {
      log.warn(`[exit-guard] requestId 不匹配，忽略（expected=${pending.requestId}, got=${payload.requestId}）`)
      return
    }
    finalize(payload.choice)
  }

  ipcMain.on(RESPONSE_CHANNEL, responseHandler)

  const ask = async (reason: ExitGuardReason): Promise<ExitGuardChoice> => {
    // 复用 pending：同一个 reason 直接返回同一 promise；不同 reason 走串行（先解第一个）
    if (pending) {
      log.info(`[exit-guard] 复用 pending request (existing=${pending.reason}, new=${reason})`)
      return new Promise<ExitGuardChoice>((resolve) => {
        const prev = pending!.resolve
        pending!.resolve = (choice) => {
          prev(choice)
          resolve(choice)
        }
      })
    }

    const win = options.getMainWindow()
    if (!win || win.isDestroyed()) {
      log.warn('[exit-guard] 主窗口不可用，降级 continue')
      return 'continue'
    }
    const webContents: WebContents = win.webContents

    const requestId = `exit-${Date.now()}-${nextSeq++}`
    return new Promise<ExitGuardChoice>((resolve) => {
      const timeoutHandle = setTimeout(() => {
        log.warn(`[exit-guard] renderer 在 ${timeoutMs}ms 内未响应，弹原生 fallback`)
        // 把 pending 清空再弹 dialog，避免 fallback 期间又触发新 ask
        const cur = pending
        pending = null
        if (cur) clearTimeout(cur.timeoutHandle)
        const winNow = options.getMainWindow()
        if (!winNow || winNow.isDestroyed()) {
          resolve('continue')
          return
        }
        showNativeFallback(winNow, reason).then(resolve, (err) => {
          log.error('[exit-guard] showNativeFallback 失败，降级 continue:', err)
          resolve('continue')
        })
      }, timeoutMs)

      pending = { requestId, reason, resolve, timeoutHandle }

      try {
        webContents.send(REQUEST_CHANNEL, { reason, requestId })
        log.info(`[exit-guard] 已发送 ${reason} 请求 (requestId=${requestId})`)
      } catch (err) {
        log.error('[exit-guard] 发送请求失败:', err)
        finalize('continue')
      }
    })
  }

  const dispose = () => {
    ipcMain.removeListener(RESPONSE_CHANNEL, responseHandler)
    if (pending) {
      clearTimeout(pending.timeoutHandle)
      pending = null
    }
  }

  return { ask, dispose }
}

function isResponsePayload(value: unknown): value is { requestId: string; choice: ExitGuardChoice } {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (typeof v.requestId !== 'string') return false
  if (v.choice !== 'continue' && v.choice !== 'cancel') return false
  return true
}
