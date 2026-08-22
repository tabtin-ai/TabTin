import type { BrowserWindow, WebContents } from 'electron'

export interface ContextMenuContext {
  webContents: WebContents
  viewId: string
  mainWindow: BrowserWindow
}
