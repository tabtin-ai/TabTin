/**
 * Browser zoom controller —— module-level zoom level cache + IPC orchestration.
 *
 * **Why module-level（Wave 6.2 自修复）**
 *
 * 之前 zoom 监听器写在 `CrawlspaceWorkspace.tsx` 的 useEffect 内（按 viewId 维护
 * renderer 主权 zoom 累计值，配合主进程 `setZoomLevel(viewId, level)`）。
 *
 * Wave 6.2 把 SpaceWorkbenchHost 内层 Activity 在 canvas mode 切到 hidden 后，
 * `CrawlspaceWorkspace` 子树 effect 会 cleanup —— 监听器随之失效，**用户在分屏
 * 模式下按 Cmd+/Cmd-/Cmd0 没反应**（zoom 之前能工作，是回归）。
 *
 * 修法跟 Wave 3.3 `events/close-workspace.ts` 同款：把"跨组件生命周期需求的
 * renderer 层副作用"提到 module-level，再由调用方（`useBrowserActions`）直接
 * 调本模块的 `adjustBrowserZoom`，不再依赖 `window` CustomEvent 中转 +
 * 组件 effect 监听。
 *
 * BrowserView 由主进程持有，本模块只做 renderer 主权 zoom level 累计 + 调
 * `tabtin.crawlView.setZoomLevel(viewId, absoluteLevel)`。
 */

import {
  MAX_BROWSER_ZOOM_LEVEL,
  MIN_BROWSER_ZOOM_LEVEL,
} from '@shared/browser-viewport-constraints'

export type BrowserZoomDirection = 'in' | 'out' | 'reset'
export type BrowserZoomLevelListener = (level: number) => void

const MAX_ZOOM = MAX_BROWSER_ZOOM_LEVEL
const MIN_ZOOM = MIN_BROWSER_ZOOM_LEVEL
const STEP = 0.5

const zoomLevelByViewId: Record<string, number> = {}
const zoomLevelListenersByViewId: Record<string, Set<BrowserZoomLevelListener>> = {}

function notifyBrowserZoomLevel(viewId: string, level: number): void {
  const listeners = zoomLevelListenersByViewId[viewId]
  if (!listeners) return
  for (const listener of listeners) {
    listener(level)
  }
}

/**
 * 调整指定 view 的缩放等级。direction='reset' 时复位到 0。
 * 调用方一般是 `useBrowserActions.handleZoomItem`（响应键盘 / 菜单触发）。
 */
export function adjustBrowserZoom(viewId: string, direction: BrowserZoomDirection): void {
  if (!viewId) return
  const tabtin = typeof window !== 'undefined' ? window.tabtin : undefined
  if (!tabtin?.crawlView?.setZoomLevel) return

  const current = zoomLevelByViewId[viewId] ?? 0
  let next: number
  if (direction === 'in') next = Math.min(current + STEP, MAX_ZOOM)
  else if (direction === 'out') next = Math.max(current - STEP, MIN_ZOOM)
  else next = 0

  zoomLevelByViewId[viewId] = next
  tabtin.crawlView.setZoomLevel(viewId, next)
  notifyBrowserZoomLevel(viewId, next)
}

/** 查询特定 view 当前累计的 zoom level（renderer 视角，调试用） */
export function getBrowserZoomLevel(viewId: string): number {
  return zoomLevelByViewId[viewId] ?? 0
}

/** Electron zoom level -> 用户可读百分比；level 0 对应 100%。 */
export function browserZoomLevelToPercent(level: number): number {
  const safeLevel = Number.isFinite(level) ? level : 0
  return Math.round(Math.pow(1.2, safeLevel) * 100)
}

/** 查询特定 view 当前 zoom 百分比（renderer 视角，UI 展示用）。 */
export function getBrowserZoomPercent(viewId: string): number {
  return browserZoomLevelToPercent(getBrowserZoomLevel(viewId))
}

/** 从主进程 BrowserView 事件同步实际 zoom level（例如 Ctrl+滚轮路径）。 */
export function syncBrowserZoomLevel(viewId: string, level: number): void {
  if (!viewId || !Number.isFinite(level)) return
  if (zoomLevelByViewId[viewId] === level) return
  zoomLevelByViewId[viewId] = level
  notifyBrowserZoomLevel(viewId, level)
}

/** 订阅指定 view 的 zoom level 变化，让显式 UI 入口和快捷键共用一份状态。 */
export function subscribeBrowserZoomLevel(viewId: string, listener: BrowserZoomLevelListener): () => void {
  if (!viewId) return () => {}

  let listeners = zoomLevelListenersByViewId[viewId]
  if (!listeners) {
    listeners = new Set()
    zoomLevelListenersByViewId[viewId] = listeners
  }
  listeners.add(listener)

  return () => {
    listeners.delete(listener)
    if (listeners.size === 0) {
      delete zoomLevelListenersByViewId[viewId]
    }
  }
}

/** 清理某 view 的 zoom level 缓存（view 关闭时由 store 触发） */
export function clearBrowserZoom(viewId: string): void {
  delete zoomLevelByViewId[viewId]
}

/** 测试用：复位所有 zoom 缓存 */
export function __resetBrowserZoomForTesting(): void {
  for (const key of Object.keys(zoomLevelByViewId)) {
    delete zoomLevelByViewId[key]
  }
  for (const key of Object.keys(zoomLevelListenersByViewId)) {
    delete zoomLevelListenersByViewId[key]
  }
}
