/**
 * openUrlInWorkspaceTab - 在 workspace 内打开新标签页
 *
 * 统一 window-open-handler 和 context-menu-builder 的逻辑：
 * 1. workspace 判断（通过 OrganizationTabManager）
 * 2. in-flight 去重（同 workspace+URL 1 秒内不重复创建）
 * 3. ACK 清理（渲染进程确认后立即释放 in-flight 槽位）
 * 4. 超时兜底（5 秒后自动清理，防止泄漏）
 */

import { ipcMain, shell, type BrowserWindow } from 'electron'
import { isPreviewableDirectFileUrl } from '../../shared/previewable-direct-url'
import { isBlockedExternalAppProtocol } from '../external-protocol-guard'
import { getOrganizationTabManager } from '../organization/OrganizationTabManager'
import { sendResourceOpenFallback } from '../resource-open-fallback'

const inflight = new Map<string, { timer: NodeJS.Timeout; lastTs: number; ackHandler: (...args: any[]) => void }>()

const DEDUP_WINDOW_MS = 1000
const INFLIGHT_TTL_MS = 5000

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
  const now = Date.now()
  const existing = inflight.get(key)
  if (existing && now - existing.lastTs < DEDUP_WINDOW_MS) {
    return 'deduped'
  }

  // ── 派生标题 + 生成 requestId ──
  if (existing) {
    clearTimeout(existing.timer)
    ipcMain.removeListener('workspace:create-view:ack', existing.ackHandler)
  }

  let resolvedTitle = title || url
  try { resolvedTitle = title || new URL(url).hostname } catch { /* keep url */ }

  const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`

  // ── 注册 in-flight + ACK 清理 ──
  const ackHandler = (_event: any, ack: { requestId?: string }) => {
    if (ack?.requestId === requestId) {
      const entry = inflight.get(key)
      if (entry) clearTimeout(entry.timer)
      inflight.delete(key)
      ipcMain.removeListener('workspace:create-view:ack', ackHandler)
    }
  }

  const timer = setTimeout(() => {
    inflight.delete(key)
    ipcMain.removeListener('workspace:create-view:ack', ackHandler)
  }, INFLIGHT_TTL_MS)
  inflight.set(key, { timer, lastTs: now, ackHandler })

  // ── 发送 IPC + 注册 ACK 监听 ──
  mainWindow.webContents.send('workspace:create-view-requested', {
    crawlspaceId: ownerTabId,
    url,
    title: resolvedTitle,
    requestId,
  })

  ipcMain.on('workspace:create-view:ack', ackHandler)

  return 'sent'
}
