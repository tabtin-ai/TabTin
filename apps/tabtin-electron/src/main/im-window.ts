import { join } from 'path'

import { BrowserWindow } from 'electron'

import { DETACHED_IM_MODE } from '../shared/detached-window-modes'
import { applySequoiaFix, attachWindowControlEvents, type MainWindowLogger } from './main-window'
import { setIMWindow } from './window-manager'

const IM_WINDOW_WIDTH = 980
const IM_WINDOW_HEIGHT = 760
const IM_WINDOW_MIN_WIDTH = 640
const IM_WINDOW_MIN_HEIGHT = 520

export interface DetachedIMWindowController {
  open: () => BrowserWindow
  getWindow: () => BrowserWindow | null
  close: () => void
}

export interface DetachedIMWindowControllerOptions {
  isDev: boolean
  rendererUrl?: string
  log: MainWindowLogger
  getBackgroundColor: () => string
}

export function createDetachedIMWindowController(
  options: DetachedIMWindowControllerOptions,
): DetachedIMWindowController {
  let imWindow: BrowserWindow | null = null

  const getWindow = (): BrowserWindow | null => {
    return imWindow && !imWindow.isDestroyed() ? imWindow : null
  }

  const close = (): void => {
    getWindow()?.close()
  }

  const open = (): BrowserWindow => {
    const existingWindow = getWindow()
    if (existingWindow) {
      if (existingWindow.isMinimized()) {
        existingWindow.restore()
      }
      existingWindow.show()
      existingWindow.focus()
      return existingWindow
    }

    const win = new BrowserWindow({
      width: IM_WINDOW_WIDTH,
      height: IM_WINDOW_HEIGHT,
      minWidth: IM_WINDOW_MIN_WIDTH,
      minHeight: IM_WINDOW_MIN_HEIGHT,
      show: false,
      frame: false,
      titleBarStyle: 'hidden',
      trafficLightPosition: process.platform === 'darwin' ? { x: 12, y: 12 } : undefined,
      backgroundColor: options.getBackgroundColor(),
      webPreferences: {
        preload: join(import.meta.dirname, '../preload/index.cjs'),
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: !options.isDev,
        enableWebSQL: false,
        spellcheck: false,
        v8CacheOptions: 'code',
      },
    })

    applySequoiaFix(win)
    attachWindowControlEvents(win)

    const queryParams = new URLSearchParams({ mode: DETACHED_IM_MODE }).toString()
    if (options.isDev && options.rendererUrl) {
      void win.loadURL(`${options.rendererUrl}?${queryParams}`)
    } else {
      void win.loadURL(`tabtin-file://app/index.html?${queryParams}`)
    }

    win.on('ready-to-show', () => {
      win.show()
    })

    win.on('closed', () => {
      if (imWindow !== win) return
      imWindow = null
      setIMWindow(null)
    })

    win.webContents.on('render-process-gone', (_event, details) => {
      options.log.error('[IMWindow] renderer crashed:', details.reason)
      if (imWindow === win) {
        imWindow = null
        setIMWindow(null)
      }
      if (!win.isDestroyed()) {
        win.close()
      }
    })

    imWindow = win
    setIMWindow(win)
    return win
  }

  return {
    open,
    getWindow,
    close,
  }
}
