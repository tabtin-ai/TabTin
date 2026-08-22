import {
  ElectronAdapter,
  WindowOptions,
  SaveDialogOptions,
  OpenDialogOptions,
  MenuTemplate
} from './types'
import { t } from './i18n'

export class ElectronPlatformAdapter implements ElectronAdapter {
  private electron: any

  constructor() {
    // 动态导入 electron，避免在非 Electron 环境中出错
    try {
      this.electron = require('electron')
    } catch (error) {
      throw new Error(t('errors.electronOnly'))
    }
  }

  async createWindow(options: WindowOptions = {}): Promise<void> {
    const { BrowserWindow } = this.electron
    const defaultOptions = {
      width: 1400,
      height: 900,
      minWidth: 1200,
      minHeight: 800,
      show: false,
      frame: options.frame !== false,
      titleBarStyle: options.titleBarStyle || 'default',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        webSecurity: true
      }
    }

    const windowOptions = { ...defaultOptions, ...options }
    const window = new BrowserWindow(windowOptions)

    window.on('ready-to-show', () => {
      window.show()
    })
  }

  async closeWindow(): Promise<void> {
    const { BrowserWindow } = this.electron
    const window = BrowserWindow.getFocusedWindow()
    if (window) {
      window.close()
    }
  }

  async minimizeWindow(): Promise<void> {
    const { BrowserWindow } = this.electron
    const window = BrowserWindow.getFocusedWindow()
    if (window) {
      window.minimize()
    }
  }

  async maximizeWindow(): Promise<void> {
    const { BrowserWindow } = this.electron
    const window = BrowserWindow.getFocusedWindow()
    if (window) {
      if (window.isMaximized()) {
        window.unmaximize()
      } else {
        window.maximize()
      }
    }
  }

  async showSaveDialog(options: SaveDialogOptions = {}): Promise<string | undefined> {
    const { dialog } = this.electron
    const result = await dialog.showSaveDialog({
      defaultPath: options.defaultPath,
      filters: options.filters || []
    })
    return result.canceled ? undefined : result.filePath
  }

  async showOpenDialog(options: OpenDialogOptions = {}): Promise<string[] | undefined> {
    const { dialog } = this.electron
    const result = await dialog.showOpenDialog({
      filters: options.filters || [],
      properties: options.properties || ['openFile']
    })
    return result.canceled ? undefined : result.filePaths
  }

  setAppUserModelId(id: string): void {
    const { app } = this.electron
    app.setAppUserModelId(id)
  }

  quit(): void {
    const { app } = this.electron
    app.quit()
  }

  setApplicationMenu(template?: MenuTemplate): void {
    const { Menu } = this.electron
    if (template) {
      const menu = Menu.buildFromTemplate([template])
      Menu.setApplicationMenu(menu)
    } else {
      Menu.setApplicationMenu(null)
    }
  }
}

// IPC 助手类
export class ElectronIPCHandler {
  private ipcMain: any

  constructor() {
    try {
      const { ipcMain } = require('electron')
      this.ipcMain = ipcMain
    } catch (error) {
      throw new Error(t('errors.ipcMainOnly'))
    }
  }

  handle(channel: string, handler: (event: any, ...args: any[]) => any): void {
    this.ipcMain.handle(channel, handler)
  }

  removeHandler(channel: string): void {
    this.ipcMain.removeHandler(channel)
  }
}

// Preload 助手类
export class ElectronPreloadAPI {
  private contextBridge: any
  private ipcRenderer: any

  constructor() {
    try {
      const { contextBridge, ipcRenderer } = require('electron')
      this.contextBridge = contextBridge
      this.ipcRenderer = ipcRenderer
    } catch (error) {
      throw new Error(t('errors.preloadOnly'))
    }
  }

  exposeAPI(apiName: string, api: Record<string, Function>): void {
    const electronAPI = Object.keys(api).reduce((acc, key) => {
      acc[key] = (...args: any[]) => this.ipcRenderer.invoke(`${apiName}:${key}`, ...args)
      return acc
    }, {} as Record<string, Function>)

    this.contextBridge.exposeInMainWorld(apiName, electronAPI)
  }
}
