/**
 * 内置浏览器「宽度自适应」（fit-to-width）
 *
 * **要解决的问题**
 *
 * WebContentsView 的渲染宽度永远等于其 bounds 宽度（Chromium 引擎保证）。当用户把浏览器
 * 面板拖窄、或在分屏里只给浏览器很小一块时，固定宽度的桌面站（如 36氪）不会重排，右侧内容
 * 被直接裁切、且部分站点禁用了横向滚动够不着。真·浏览器拉窄也是这表现，但内嵌迷你浏览器
 * 用户期望它“自适应窗口尺寸”。
 *
 * **做法**
 *
 * 页面加载完成 / bounds 变化时，测页面实际内容宽度与当前可视宽度，按
 *   factor' = innerWidth(CSS) * currentZoomFactor / scrollWidth(CSS)
 * 计算让整页恰好填进面板的缩放因子并 `setZoomFactor`。该式与当前 zoom 无关（dpr 抵消），
 * 不会自我震荡：内容更窄（响应式站）时 factor' 趋近 1，自动复位；内容更宽时缩小到刚好放下。
 *
 * **手动缩放优先**
 *
 * 用户一旦用 Cmd +/-（→ `crawl-view:setZoomLevel`）手动缩放，本模块对该 view 暂停接管，
 * 直到 Cmd 0 复位（level=0）才重新启用自适应并立即重算。
 */

import type { WebContentsView } from 'electron'
import { getViewFactory } from '../view-factory'
import { createLogger } from './logger'
import {
  computeFitZoomFactor,
  MAX_FIT_ZOOM_FACTOR,
  ZOOM_EPSILON,
} from './fit-to-width-calc'

const log = createLogger('FitToWidth')

/** 合并同一 view 短时间内的多次触发（加载 + bounds 连续变化）。 */
const FIT_DEBOUNCE_MS = 120

/** 被用户手动缩放接管、暂停自适应的 viewId 集合。 */
const manualZoomOverride = new Set<string>()
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const rememberedContentWidths = new Map<string, { url: string; width: number }>()

const shouldLogFit = process.env.TABTIN_DEBUG_CRAWL_BOUNDS === '1' || process.env.TABTIN_DEBUG_CRAWLVIEW_VERBOSE === '1'

export { computeFitZoomFactor } from './fit-to-width-calc'

/**
 * 记录用户手动缩放意图。level !== 0 视为接管（暂停自适应）；level === 0（Cmd 0 复位）
 * 视为放权，重新启用自适应并立即重算。
 */
export function markManualZoom(viewId: string, level: number): void {
  if (!viewId) return
  if (level === 0) {
    manualZoomOverride.delete(viewId)
    scheduleFitToWidth(viewId)
  } else {
    manualZoomOverride.add(viewId)
  }
}

/** view 销毁时清理本模块状态，防止 Set/Map 随标签创建无限增长。 */
export function clearFitToWidthState(viewId: string): void {
  if (!viewId) return
  manualZoomOverride.delete(viewId)
  rememberedContentWidths.delete(viewId)
  const timer = debounceTimers.get(viewId)
  if (timer) {
    clearTimeout(timer)
    debounceTimers.delete(viewId)
  }
}

/** 排程一次（防抖的）宽度自适应；被手动缩放接管的 view 直接跳过。 */
export function scheduleFitToWidth(viewId: string): void {
  if (!viewId || manualZoomOverride.has(viewId)) return
  const existing = debounceTimers.get(viewId)
  if (existing) clearTimeout(existing)
  debounceTimers.set(
    viewId,
    setTimeout(() => {
      debounceTimers.delete(viewId)
      void applyFitToWidth(viewId)
    }, FIT_DEBOUNCE_MS),
  )
}

async function applyFitToWidth(viewId: string): Promise<void> {
  if (manualZoomOverride.has(viewId)) return

  let view: WebContentsView | null | undefined
  try {
    view = getViewFactory().getView?.(viewId)
  } catch {
    return
  }
  const wc = view?.webContents
  if (!wc || wc.isDestroyed() || wc.isLoading()) return

  try {
    const currentUrl = wc.getURL()
    const remembered = rememberedContentWidths.get(viewId)
    if (remembered && remembered.url !== currentUrl) {
      rememberedContentWidths.delete(viewId)
    }
    const metrics = (await wc.executeJavaScript(
      '({iw: window.innerWidth, sw: document.documentElement.scrollWidth})',
      true,
    )) as { iw?: number; sw?: number } | null

    const innerWidth = Number(metrics?.iw)
    const scrollWidth = Number(metrics?.sw)
    const current = wc.getZoomFactor()
    if (scrollWidth > innerWidth + 1) {
      rememberedContentWidths.set(viewId, { url: currentUrl, width: scrollWidth })
    }
    const next = computeFitZoomFactor(
      innerWidth,
      scrollWidth,
      current,
      rememberedContentWidths.get(viewId)?.width,
    )
    if (next === null) return
    if (next >= MAX_FIT_ZOOM_FACTOR - ZOOM_EPSILON && scrollWidth <= innerWidth + 1) {
      rememberedContentWidths.delete(viewId)
    }
    if (Math.abs(next - current) <= ZOOM_EPSILON) return

    wc.setZoomFactor(next)
    if (shouldLogFit) {
      log.info('fit-to-width 应用缩放', { viewId, innerWidth, scrollWidth, from: current, to: next })
    }
  } catch {
    // 页面正在导航 / webContents 已分离，忽略。
  }
}
