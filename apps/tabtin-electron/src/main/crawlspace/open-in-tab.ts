/**
 * openUrlInWorkspaceTab - 在 workspace 内打开新标签页
 *
 * 统一 window-open-handler 和 context-menu-builder 的逻辑：
 * 1. workspace 判断（通过 OrganizationTabManager）
 * 2. in-flight 去重（同 workspace+URL 在 created/TTL 前只允许一个创建请求）
 * 3. ACK 仅确认 renderer 收到请求；created 才完成继承并释放槽位
 * 4. 超时兜底（5 秒后自动清理，防止泄漏）
 */

import { ipcMain, shell, type BrowserWindow } from 'electron'
import { isPreviewableDirectFileUrl } from '../../shared/previewable-direct-url'
import { inheritViewControl } from '../browser-tab-lock/browserTabInputLock'
import { isBlockedExternalAppProtocol } from '../external-protocol-guard'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { sendResourceOpenFallback } from '../resource-open-fallback'

const inflight = new Map<string, {
  timer: NodeJS.Timeout
  retryTimer?: NodeJS.Timeout
  ackHandler: (...args: any[]) => void
  createdHandler: (...args: any[]) => void
  pendingViewId?: string
}>()

const INFLIGHT_TTL_MS = 5000
const VIEW_OWNER_MAPPING_RETRY_MS = 25

export interface OpenInTabOptions {
  url: string
  viewId: string
  mainWindow: BrowserWindow
  /** 自定义标题（可选，默认从 URL hostname 派生） */
  title?: string
  /** Chromium WindowOpenHandler disposition（可选） */
  disposition?: string
}

export type OpenInTabResult = 'sent' | 'deduped' | 'external' | 'preview' | 'invalid'

/**
 * 在 workspace 内的新标签页中打开 URL，或回退到系统浏览器
 */
export function openUrlInWorkspaceTab(opts: OpenInTabOptions): OpenInTabResult {
  const { url, viewId, mainWindow, title, disposition } = opts

  if (!url || mainWindow.isDestroyed()) return 'invalid'

  // bitbrowser: / douyin-pc: 等：禁止建标签或 shell.openExternal，避免 Windows「选取应用」弹框
  if (isBlockedExternalAppProtocol(url)) {
    return 'invalid'
  }

  // xlsx/xls/csv/pdf/image 等直链：交给 renderer Preview Modal，禁止进 tabweb loadURL。
  if (isPreviewableDirectFileUrl(url)) {
    const sent = sendResourceOpenFallback(mainWindow, {
      url,
      source: 'crawlspace_window_open',
      viewId,
      disposition,
    })
    return sent ? 'preview' : 'invalid'
  }

  const organizationTabManager = getOrganizationTabManager()
  const ownerTabId = organizationTabManager.getTabByView(viewId)

  if (!ownerTabId || !organizationTabManager.isOrganizationTab(ownerTabId)) {
    const ALLOWED_EXTERNAL_PROTOCOLS = ['http:', 'https:', 'mailto:']
    try {
      const parsed = new URL(url)
      if (!ALLOWED_EXTERNAL_PROTOCOLS.includes(parsed.protocol)) {
        return 'invalid'
      }
    } catch {
      return 'invalid'
    }
    shell.openExternal(url).catch(() => {})
    return 'external'
  }

  // ── 去重检查 ──
  const key = `${ownerTabId}|${url}`
  const existing = inflight.get(key)
  if (existing) {
    return 'deduped'
  }

  // ── 派生标题 + 生成 requestId ──
  let resolvedTitle = title || url
  try { resolvedTitle = title || new URL(url).hostname } catch { /* keep url */ }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // ── 注册 in-flight + ACK 清理 ──
  const ackHandler = (_event: any, ack: { requestId?: string }) => {
    if (ack?.requestId === requestId) {
      ipcMain.removeListener('workspace:create-view:ack', ackHandler)
    }
  }

  const cleanup = () => {
    clearTimeout(entry.timer)
    if (entry.retryTimer) clearTimeout(entry.retryTimer)
    if (inflight.get(key) === entry) {
      inflight.delete(key)
    }
    ipcMain.removeListener('workspace:create-view:ack', ackHandler)
    ipcMain.removeListener('workspace:create-view:created', createdHandler)
  }

  const isRecordedMainRenderer = (event: any): boolean => {
    if (mainWindow.isDestroyed()) return false
    if (mainWindow.webContents.isDestroyed?.()) return false
    return event?.sender?.id === mainWindow.webContents.id
  }

  const tryInheritPendingView = () => {
    const newViewId = entry.pendingViewId
    if (!newViewId) return
    if (mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed?.()) {
      cleanup()
      return
    }

    const targetOwnerTabId = organizationTabManager.getTabByView(newViewId)
    if (!targetOwnerTabId) {
      entry.retryTimer = setTimeout(() => {
        entry.retryTimer = undefined
        tryInheritPendingView()
      }, VIEW_OWNER_MAPPING_RETRY_MS)
      return
    }
    if (targetOwnerTabId !== ownerTabId) {
      cleanup()
      return
    }

    try {
      inheritViewControl(viewId, newViewId)
      mainWindow.webContents.send('workspace:create-view:inherited', {
        requestId,
        viewId: newViewId,
      })
    } catch {
      // renderer 收不到成功确认后会 fail-closed 关闭新 view。
    } finally {
      cleanup()
    }
  }

  const createdHandler = (event: any, msg: { requestId?: string; viewId?: string }) => {
    if (msg?.requestId !== requestId) return
    if (!isRecordedMainRenderer(event)) return

    if (typeof msg.viewId !== 'string' || !msg.viewId) {
      cleanup()
      return
    }
    if (entry.pendingViewId && entry.pendingViewId !== msg.viewId) return

    entry.pendingViewId = msg.viewId
    tryInheritPendingView()
  }

  const timer = setTimeout(() => {
    cleanup()
  }, INFLIGHT_TTL_MS)
  const entry: {
    timer: NodeJS.Timeout
    retryTimer?: NodeJS.Timeout
    ackHandler: (...args: any[]) => void
    createdHandler: (...args: any[]) => void
    pendingViewId?: string
  } = { timer, ackHandler, createdHandler }
  inflight.set(key, entry)

  // ── 发送 IPC + 注册 ACK / created 监听 ──
  ipcMain.on('workspace:create-view:ack', ackHandler)
  ipcMain.on('workspace:create-view:created', createdHandler)
  try {
    mainWindow.webContents.send('workspace:create-view-requested', {
      crawlspaceId: ownerTabId,
      url,
      title: resolvedTitle,
      requestId,
    })
  } catch {
    cleanup()
    return 'invalid'
  }

  return 'sent'
}
