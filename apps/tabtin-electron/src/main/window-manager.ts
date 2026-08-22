/**
 * 窗口管理器
 *
 * 提供全局访问主窗口和 IM 弹出窗口的方式
 */

import { BrowserWindow } from 'electron'

import { getActiveAuxiliaryWindows } from './context-menu/auxiliary-window-manager'
import { createLogger } from './logger'

const log = createLogger('WindowManager')

type MainWindowEnsurer = (signal?: AbortSignal) => Promise<BrowserWindow | null>

let mainWindowInstance: BrowserWindow | null = null
let imWindowInstance: BrowserWindow | null = null
let mainWindowNotificationHostReady = false
let mainWindowEnsurer: MainWindowEnsurer | null = null

/**
 * 设置主窗口引用
 */
export function setMainWindow(window: BrowserWindow): void {
  mainWindowInstance = window
  mainWindowNotificationHostReady = false
  log.info('主窗口已注册')
}

/**
 * 获取主窗口引用
 */
export function getMainWindow(): BrowserWindow | null {
  if (!mainWindowInstance || mainWindowInstance.isDestroyed()) {
    log.warn('主窗口不可用（未注册或已销毁）')
    return null
  }
  return mainWindowInstance
}

export function setMainWindowEnsurer(ensurer: MainWindowEnsurer): void {
  mainWindowEnsurer = ensurer
}

export async function ensureMainWindow(signal?: AbortSignal): Promise<BrowserWindow | null> {
  if (mainWindowEnsurer) {
    return mainWindowEnsurer(signal)
  }
  signal?.throwIfAborted()
  return getMainWindow()
}

/**
 * 清除主窗口引用（幂等：重复调用不会重复打印日志）
 */
export function clearMainWindow(): void {
  if (!mainWindowInstance && !mainWindowNotificationHostReady) return
  mainWindowInstance = null
  mainWindowNotificationHostReady = false
  log.info('主窗口引用已清除')
}

export function setMainWindowNotificationHostReady(ready: boolean): void {
  mainWindowNotificationHostReady = ready
}

export function isMainWindowNotificationHostReady(): boolean {
  return !!mainWindowInstance && !mainWindowInstance.isDestroyed() && mainWindowNotificationHostReady
}

export function setIMWindow(window: BrowserWindow | null): void {
  imWindowInstance = window
}

export function getIMWindow(): BrowserWindow | null {
  if (!imWindowInstance || imWindowInstance.isDestroyed()) {
    return null
  }
  return imWindowInstance
}

/**
 * 获取所有活跃窗口（含主窗口、IM 弹出窗口及辅助窗口），用于外观同步等全局操作
 */
export function getAllWindows(): BrowserWindow[] {
  const primary = [mainWindowInstance, imWindowInstance]
    .filter((w): w is BrowserWindow => !!w && !w.isDestroyed())
  return [...primary, ...getActiveAuxiliaryWindows()]
}
