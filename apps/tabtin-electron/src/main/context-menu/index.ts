/**
 * ContextMenu 模块入口
 *
 * 为浏览器页面 WebContents 注册原生右键上下文菜单——容器无关：
 * WCV 在 ViewFactory.createView() / registerExternalView() 后调用，
 * webview guest 在 adoptWebviewGuest() 装配时调用（ Phase 3）。
 */

import type { BrowserWindow, WebContents } from 'electron'
import { buildContextMenu } from './context-menu-builder'
import { initContextMenuI18n } from './i18n'

export { initContextMenuI18n }
export type { ContextMenuContext } from './types'

/**
 * 已注册过菜单的 WebContents 集合——防重复挂 listener。
 *
 * webview guest 存在 did-attach / bind 双路径收养 + 影子条目清理后重收养的
 * 场景，同一存活 WebContents 可能被多次要求注册；重复挂会导致一次右键弹出
 * 多个菜单。WeakSet 随 WebContents 销毁自动释放，无泄漏。
 */
const registeredContents = new WeakSet<WebContents>()

/**
 * 为页面 WebContents 注册右键菜单（幂等）
 *
 * @param wc          页面 WebContents（WCV 的 view.webContents 或 webview guest）
 * @param viewId      View ID（用于上下文感知，如判断所属 organization）
 * @param mainWindow  主窗口引用（用于 IPC 通信和菜单弹出定位）
 */
export function registerContextMenu(
  wc: WebContents,
  viewId: string,
  mainWindow: BrowserWindow
): void {
  if (!wc || wc.isDestroyed()) return
  if (registeredContents.has(wc)) return
  registeredContents.add(wc)

  wc.on('context-menu', (event, params) => {
    event.preventDefault()

    if (mainWindow.isDestroyed() || wc.isDestroyed()) return

    const menu = buildContextMenu(params, { webContents: wc, viewId, mainWindow })
    menu.popup({
      window: mainWindow,
      frame: (params as any).frame ?? (event as any).frame,
    } as any)
  })
}
