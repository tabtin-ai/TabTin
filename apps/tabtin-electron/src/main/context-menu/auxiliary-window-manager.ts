/**
 * 辅助窗口管理器
 *
 * 管理 context-menu 创建的独立窗口（查看源代码 / 在新窗口中打开链接）。
 *
 * 设计决策：同 key（即同 URL）的窗口会复用（focus 已有窗口），而非每次创建新窗口。
 * 这与 Chrome "在新窗口中打开链接"的行为略有不同（Chrome 每次都创建新窗口），
 * 但可以避免用户无意中打开大量重复窗口。
 */

import { BrowserWindow } from 'electron'

const windows = new Map<string, BrowserWindow>()
const MAX_WINDOWS = 10

export function openOrFocusAuxWindow(key: string, url: string, title: string): void {
  const existing = windows.get(key)
  if (existing && !existing.isDestroyed()) {
    existing.focus()
    return
  }

  if (windows.size >= MAX_WINDOWS) {
    const firstKey = windows.keys().next().value
    if (firstKey) {
      const win = windows.get(firstKey)
      if (win && !win.isDestroyed()) win.close()
      windows.delete(firstKey)
    }
  }

  const win = new BrowserWindow({
    width: 960,
    height: 680,
    title,
    webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
  })
  win.loadURL(url)
  win.setMenuBarVisibility(false)

  win.on('closed', () => {
    windows.delete(key)
  })

  windows.set(key, win)
}

/**
 * 获取所有活跃的辅助窗口列表（已销毁的条目会被过滤，并从 Map 中清理）
 */
export function getActiveAuxiliaryWindows(): BrowserWindow[] {
  const active: BrowserWindow[] = []
  for (const [key, win] of windows) {
    if (win.isDestroyed()) {
      windows.delete(key)
    } else {
      active.push(win)
    }
  }
  return active
}
