import type { WebContents } from 'electron'
import { getMainWindow } from '../window-manager'
import { openUrlInWorkspaceTab } from './open-in-tab'
import { createLogger } from '../logger'

const log = createLogger('CrawlspaceWindowOpen')

/** 只保留 origin + pathname，丢弃可能含 token 的 query/hash，避免写入诊断包 */
function safeUrlForLog(raw: string | undefined): string {
  if (!raw) return '<none>'
  try {
    const u = new URL(raw)
    return `${u.origin}${u.pathname}${u.search ? '?…' : ''}`
  } catch {
    return '<invalid-url>'
  }
}

/** : 参数从 WebContentsView 收窄为 WebContents（内部只用 webContents） */
export function ensureCrawlspaceWindowOpenHandler(webContents: WebContents, tabId: string): void {
  webContents.setWindowOpenHandler(({ url, frameName, disposition }) => {
    log.info(`拦截新窗口请求: url=${safeUrlForLog(url)}, disposition=${disposition}, viewId=${tabId}`)

    const mainWindow = getMainWindow()
    if (!mainWindow || mainWindow.isDestroyed()) {
      return { action: 'deny' }
    }

    const result = openUrlInWorkspaceTab({
      url,
      viewId: tabId,
      mainWindow,
      title: frameName || undefined,
      disposition,
    })

    if (result === 'external') {
      log.warn(`⏭️  非工作区 view 的新窗口请求已忽略（请使用 ContextSpace）: url=${safeUrlForLog(url)}, viewId=${tabId}`)
    } else if (result === 'preview') {
      log.info(`📎 可预览文件改走 Preview Modal: url=${safeUrlForLog(url)}, viewId=${tabId}`)
    } else {
      log.debug(`🆕 openUrlInWorkspaceTab 结果: ${result}, viewId=${tabId}`)
    }

    return { action: 'deny' }
  })
}
