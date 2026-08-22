import type { BrowserWindow } from 'electron'
import { app } from 'electron'

import { createLogger } from '../logger'
import { getModalWindowManager, getToastWindowManager } from './overlay-window-manager'

const log = createLogger('OverlayInit')

function overlayConfig() {
  return {
    isDev: !app.isPackaged,
    rendererUrl: process.env['ELECTRON_RENDERER_URL'],
  }
}

/**
 * 浮层层初始化（方案 Y）：两个透明子 BrowserWindow。
 *   - toast：默认透明穿透、常驻顶部展示；悬停卡片时可点关闭。
 *   - modal：半透明蒙层、按需 show/hide，承载全局搜索 / 确认框。
 * overlay WebContentsView 已废弃（透明合成 + 无穿透 + bounds 收缩死结）。
 */
export async function initOverlayView(mainWindow: BrowserWindow): Promise<void> {
  const config = overlayConfig()

  const toastWindow = getToastWindowManager()
  toastWindow.configure(config)
  toastWindow.init(mainWindow)

  const modalWindow = getModalWindowManager()
  modalWindow.configure(config)
  modalWindow.init(mainWindow)

  log.info('Overlay toast + modal windows initialized')
}

export function rebindOverlayView(mainWindow: BrowserWindow): void {
  const config = overlayConfig()

  const toastWindow = getToastWindowManager()
  toastWindow.configure(config)
  toastWindow.init(mainWindow)

  const modalWindow = getModalWindowManager()
  modalWindow.configure(config)
  modalWindow.init(mainWindow)
}

export function destroyOverlayView(): void {
  getToastWindowManager().destroy()
  getModalWindowManager().destroy()
}
