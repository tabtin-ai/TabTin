/**
 * 视图交互追踪模块
 *
 * 管理 View 的用户交互事件监听、附加/分离状态、拖拽鼠标穿透。
 * 通过 initViewInteraction() 注入运行时依赖。
 */

import type { BrowserWindow, WebContents, WebContentsView } from 'electron'
import {
  MAX_BROWSER_ZOOM_LEVEL,
  MIN_BROWSER_ZOOM_LEVEL,
} from '@shared/browser-viewport-constraints'
import { CrawlViewEventType } from '../crawl-view-events'
import { getViewFactory } from '../view-factory'
import { hasAliveWebContents, isAliveWebContents } from './utils'
import { createLogger } from './logger'
import { markManualZoom } from './fit-to-width'

const logger = createLogger('view-interaction')

type ViewInteractionDeps = {
  getMainWindow: () => BrowserWindow | null
}

let _deps: ViewInteractionDeps = {
  getMainWindow: () => null,
}

export function initViewInteraction(deps: ViewInteractionDeps): void {
  _deps = deps
}

const attachedViewIds = new Set<string>()
const viewInteractionListeners = new Map<
  string,
  {
    webContents: WebContents
    focus: () => void
    beforeInput: (event: Electron.Event, input: Electron.Input) => void
    zoomChanged: (event: Electron.Event, zoomDirection: BrowserWheelZoomDirection) => void
  }
>()
const viewInteractionAt = new Map<string, number>()
const VIEW_INTERACTION_THROTTLE_MS = 200
const BROWSER_WHEEL_ZOOM_STEP = 0.5
let dragInteractionActive = false

type BrowserWheelZoomDirection = 'in' | 'out'

const emitViewInteraction = (tabId: string): void => {
  const now = Date.now()
  const last = viewInteractionAt.get(tabId) ?? 0
  if (now - last < VIEW_INTERACTION_THROTTLE_MS) return
  viewInteractionAt.set(tabId, now)

  const mainWindow = _deps.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('crawl-view:event', {
    type: CrawlViewEventType.VIEW_FOCUSED,
    timestamp: now,
    data: { viewId: tabId },
  })
}

export const notifyBrowserZoomLevelChanged = (tabId: string, level: number): void => {
  const mainWindow = _deps.getMainWindow()
  if (!mainWindow || mainWindow.isDestroyed()) return
  mainWindow.webContents.send('crawl-view:zoom-level-changed', {
    tabId,
    level,
  })
}

// : 收窄为 WebContents 级（setIgnoreMouseEvents 是 WebContents 能力），
// WCV / webview guest 两种容器经 getWebContents 走同一路径。
const applyIgnoreMouseEvents = (wc: WebContents | null | undefined, ignore: boolean): void => {
  if (!isAliveWebContents(wc)) return
  const webContents = wc as WebContents & {
    setIgnoreMouseEvents?: (ignore: boolean, options?: { forward?: boolean }) => void
  }
  if (typeof webContents.setIgnoreMouseEvents !== 'function') return
  try {
    webContents.setIgnoreMouseEvents(ignore, { forward: true })
  } catch (error) {
    logger.warn('setIgnoreMouseEvents 失败:', error)
  }
}

export function getNextBrowserWheelZoomLevel(
  currentLevel: number,
  direction: BrowserWheelZoomDirection,
): number {
  const normalizedCurrent = Number.isFinite(currentLevel) ? currentLevel : 0
  if (direction === 'in') {
    if (normalizedCurrent >= MAX_BROWSER_ZOOM_LEVEL) return normalizedCurrent
    return Math.min(normalizedCurrent + BROWSER_WHEEL_ZOOM_STEP, MAX_BROWSER_ZOOM_LEVEL)
  }
  if (normalizedCurrent <= MIN_BROWSER_ZOOM_LEVEL) return normalizedCurrent
  return Math.max(normalizedCurrent - BROWSER_WHEEL_ZOOM_STEP, MIN_BROWSER_ZOOM_LEVEL)
}

function applyBrowserWheelZoom(
  webContents: WebContents,
  tabId: string,
  direction: BrowserWheelZoomDirection,
): void {
  if (!tabId || webContents.isDestroyed()) return

  try {
    const current = webContents.getZoomLevel()
    const next = getNextBrowserWheelZoomLevel(current, direction)
    if (next === current) return

    webContents.setZoomLevel(next)
    markManualZoom(tabId, next)
    notifyBrowserZoomLevelChanged(tabId, next)
  } catch (error) {
    logger.warn('处理 BrowserView Ctrl+滚轮缩放失败:', error)
  }
}

export const attachViewInteractionListener = (
  view: WebContentsView | null | undefined,
  tabId: string,
): void => {
  if (!hasAliveWebContents(view)) return
  if (viewInteractionListeners.has(tabId)) return

  const webContents = view.webContents
  const handleFocus = () => emitViewInteraction(tabId)
  const handleBeforeInput = (_event: Electron.Event, input: Electron.Input) => {
    // before-input-event 只有 keyDown / keyUp / char 三种类型，不存在鼠标事件类型
    if (!input || typeof input.type !== 'string') return
    if (input.type !== 'keyDown' && input.type !== 'keyUp' && input.type !== 'char') return
    emitViewInteraction(tabId)
  }
  const handleZoomChanged = (_event: Electron.Event, zoomDirection: BrowserWheelZoomDirection) => {
    if (zoomDirection !== 'in' && zoomDirection !== 'out') return
    applyBrowserWheelZoom(webContents, tabId, zoomDirection)
  }

  webContents.on('focus', handleFocus)
  webContents.on('before-input-event', handleBeforeInput)
  webContents.on('zoom-changed', handleZoomChanged)
  webContents.once('destroyed', () => {
    webContents.removeListener('focus', handleFocus)
    webContents.removeListener('before-input-event', handleBeforeInput)
    webContents.removeListener('zoom-changed', handleZoomChanged)
    viewInteractionListeners.delete(tabId)
  })
  viewInteractionListeners.set(tabId, {
    webContents,
    focus: handleFocus,
    beforeInput: handleBeforeInput,
    zoomChanged: handleZoomChanged,
  })
}

export const markViewAttached = (tabId: string): void => {
  attachedViewIds.add(tabId)
  if (dragInteractionActive) {
    applyIgnoreMouseEvents(getViewFactory().getWebContents(tabId), true)
  }
}

export const markViewDetached = (tabId: string): void => {
  attachedViewIds.delete(tabId)
  applyIgnoreMouseEvents(getViewFactory().getWebContents(tabId), false)
}

/**
 * 判断当前是否有多个视图处于附加状态。
 * ⚠️ 并发 show/hide 乱序调用时，此函数返回的快照可能存在瞬间误判，
 * 调用方不应将其作为强一致性保证，仅用于非关键路径的 warn 提示逻辑。
 */
export const isMultiViewActive = (): boolean => attachedViewIds.size > 1

export const syncIgnoreMouseEventsForAttached = (ignore: boolean): void => {
  dragInteractionActive = ignore
  attachedViewIds.forEach((tabId) => {
    applyIgnoreMouseEvents(getViewFactory().getWebContents(tabId), ignore)
  })
}

export function clearInteractionState(): void {
  viewInteractionAt.clear()
  for (const [, entry] of viewInteractionListeners) {
    if (!entry.webContents.isDestroyed()) {
      entry.webContents.removeListener('focus', entry.focus)
      entry.webContents.removeListener('before-input-event', entry.beforeInput)
      entry.webContents.removeListener('zoom-changed', entry.zoomChanged)
    }
  }
  viewInteractionListeners.clear()
  attachedViewIds.clear()
  dragInteractionActive = false
}

export function deleteInteractionForView(tabId: string): void {
  viewInteractionAt.delete(tabId)
  const entry = viewInteractionListeners.get(tabId)
  if (entry && !entry.webContents.isDestroyed()) {
    entry.webContents.removeListener('focus', entry.focus)
    entry.webContents.removeListener('before-input-event', entry.beforeInput)
    entry.webContents.removeListener('zoom-changed', entry.zoomChanged)
  }
  viewInteractionListeners.delete(tabId)
  attachedViewIds.delete(tabId)
}
