import { nativeTheme } from 'electron'
import type { WebContents } from 'electron'

import { extractThemeColor } from './webcontents/theme-color-extractor'
import { createLogger } from './logger'

const log = createLogger('CrawlViewThemeColor')

export interface CrawlViewThemeColorPayload {
  themeColor: string | null
  source: string | null
  url: string
  viewId?: string
}

export interface CrawlViewThemeColorControllerOptions {
  emitThemeColorChanged: (payload: CrawlViewThemeColorPayload) => void
}

export interface CrawlViewThemeColorScheduleOptions {
  delaysMs?: number[]
}

/**
 * 刷新原因。每个原因对应一组"是否先清空 + 用哪组 delay"的策略，
 * 把所有外部调用点收敛到 requestThemeColorRefresh(reason)，
 * 避免各处散布魔法数字。
 *
 * - attach:        view 初次挂载，首屏温和采样
 * - finishLoad:    整页 load 完成，多阶段采样覆盖首屏渲染和异步内容
 * - navigation:    整页导航开始，只清空旧色；后续 finishLoad 会负责采样
 * - inPage:        SPA 路由跳转，清空旧色并立刻多阶段采样
 * - hashOnly:      同文档 hash 跳转，不清空，做一次温和重采样
 * - systemTheme:   系统深浅切换，不清空，做一次重采样
 * - nativeCleared: did-change-theme-color 收到空值，清空并立刻多阶段采样
 */
export type CrawlViewThemeColorRefreshReason =
  | 'attach'
  | 'finishLoad'
  | 'navigation'
  | 'inPage'
  | 'hashOnly'
  | 'systemTheme'
  | 'nativeCleared'

export interface CrawlViewThemeColorRefreshOptions {
  urlOverride?: string
}

interface RefreshProfile {
  clear: boolean
  delaysMs: number[]
}

/**
 * 所有主题色刷新的 delay 配置集中在这里，便于后续统一调优。
 * 数组空 = 不做采样（典型用于 navigation，只清空）；
 * 第一项为 0 = 立刻提取一次，后面是多阶段兜底。
 */
const REFRESH_PROFILES: Record<CrawlViewThemeColorRefreshReason, RefreshProfile> = {
  attach:        { clear: false, delaysMs: [0, 240, 900] },
  finishLoad:    { clear: false, delaysMs: [80, 420, 1200, 2400] },
  navigation:    { clear: true,  delaysMs: [] },
  inPage:        { clear: true,  delaysMs: [0, 180, 700, 1600] },
  hashOnly:      { clear: false, delaysMs: [180, 700] },
  systemTheme:   { clear: false, delaysMs: [300] },
  nativeCleared: { clear: true,  delaysMs: [0, 200, 800] },
}

export interface CrawlViewThemeColorController {
  attach: (webContents: WebContents, viewId: string | null) => void
  detach: () => void
  /**
   * 统一的主题色刷新入口。外部只描述"为什么要刷新"，
   * 由 controller 内部决定 clear / delay / single-flight 行为。
   */
  requestThemeColorRefresh: (
    webContents: WebContents,
    viewId: string | null,
    reason: CrawlViewThemeColorRefreshReason,
    options?: CrawlViewThemeColorRefreshOptions,
  ) => void
  /** @internal 保留给测试和底层调用；生产代码应使用 requestThemeColorRefresh */
  scheduleExtraction: (
    webContents: WebContents,
    viewId: string | null,
    options?: CrawlViewThemeColorScheduleOptions,
  ) => void
  /** @internal 保留给测试和底层调用；生产代码应使用 requestThemeColorRefresh */
  clearThemeColor: (
    webContents: WebContents,
    viewId: string | null,
    urlOverride?: string,
  ) => void
  handleNativeThemeColorChange: (
    webContents: WebContents,
    viewId: string | null,
    color: string,
  ) => void
  cleanup: () => void
}

export function createCrawlViewThemeColorController(
  options: CrawlViewThemeColorControllerOptions,
): CrawlViewThemeColorController {
  let attachedTarget: { webContents: WebContents; viewId: string | null } | null = null
  const pendingTimers = new Set<ReturnType<typeof setTimeout>>()
  let extractionGeneration = 0
  let lastEmittedSignature: string | null = null

  const clearPendingThemeColorExtraction = (): void => {
    if (pendingTimers.size === 0) {
      return
    }
    for (const timer of pendingTimers) {
      clearTimeout(timer)
    }
    pendingTimers.clear()
  }

  const invalidateExtractionGeneration = (): number => {
    extractionGeneration += 1
    return extractionGeneration
  }

  const normalizeDelays = (delaysMs?: number[]): number[] => {
    const source = Array.isArray(delaysMs) && delaysMs.length > 0 ? delaysMs : [300]
    return Array.from(new Set(source.map((delay) => Math.max(0, Math.round(delay)))))
      .sort((a, b) => a - b)
  }

  const buildPayloadSignature = (payload: CrawlViewThemeColorPayload): string => {
    return `${payload.url}|${payload.themeColor ?? 'null'}|${payload.source ?? 'null'}`
  }

  const emitThemeColorChanged = (payload: CrawlViewThemeColorPayload): void => {
    const signature = buildPayloadSignature(payload)
    if (signature === lastEmittedSignature) {
      return
    }

    lastEmittedSignature = signature
    options.emitThemeColorChanged(payload)
    if (payload.themeColor) {
      log.debug(`🎨 主题色提取成功: ${payload.themeColor} (来源: ${payload.source})`)
    }
  }

  const isCurrentAttachedView = (
    webContents: WebContents,
    viewId: string | null,
  ): boolean => {
    return attachedTarget?.webContents === webContents && attachedTarget.viewId === viewId
  }

  const scheduleExtraction = (
    webContents: WebContents,
    viewId: string | null,
    scheduleOptions?: CrawlViewThemeColorScheduleOptions,
  ): void => {
    clearPendingThemeColorExtraction()
    const delays = normalizeDelays(scheduleOptions?.delaysMs)
    const generation = invalidateExtractionGeneration()

    for (const delayMs of delays) {
      const timer = setTimeout(async () => {
        pendingTimers.delete(timer)
        if (webContents.isDestroyed()) return

        try {
          const result = await extractThemeColor(webContents)
          if (webContents.isDestroyed()) return
          if (generation !== extractionGeneration) return
          if (!isCurrentAttachedView(webContents, viewId)) return

          emitThemeColorChanged({
            themeColor: result.color,
            source: result.source,
            url: webContents.getURL(),
            viewId: viewId ?? undefined,
          })
        } catch (error) {
          log.warn('⚠️ 主题色提取失败:', error)
        }
      }, delayMs)
      pendingTimers.add(timer)
    }
  }

  const clearThemeColor = (
    webContents: WebContents,
    viewId: string | null,
    urlOverride?: string,
  ): void => {
    clearPendingThemeColorExtraction()
    invalidateExtractionGeneration()
    if (webContents.isDestroyed()) return
    if (!isCurrentAttachedView(webContents, viewId)) return

    emitThemeColorChanged({
      themeColor: null,
      source: null,
      url: urlOverride ?? webContents.getURL(),
      viewId: viewId ?? undefined,
    })
  }

  const requestThemeColorRefresh = (
    webContents: WebContents,
    viewId: string | null,
    reason: CrawlViewThemeColorRefreshReason,
    refreshOptions?: CrawlViewThemeColorRefreshOptions,
  ): void => {
    const profile = REFRESH_PROFILES[reason]
    if (!profile) {
      log.warn(`⚠️ 未知的主题色刷新原因: ${String(reason)}`)
      return
    }
    if (profile.clear) {
      clearThemeColor(webContents, viewId, refreshOptions?.urlOverride)
    }
    if (profile.delaysMs.length > 0) {
      scheduleExtraction(webContents, viewId, { delaysMs: profile.delaysMs })
    }
  }

  const themeListener = () => {
    if (!attachedTarget || attachedTarget.webContents.isDestroyed()) {
      return
    }
    log.debug('🌓 检测到主题变化，重新提取主题色')
    requestThemeColorRefresh(attachedTarget.webContents, attachedTarget.viewId, 'systemTheme')
  }

  return {
    attach: (webContents, viewId) => {
      clearPendingThemeColorExtraction()
      invalidateExtractionGeneration()
      nativeTheme.removeListener('updated', themeListener)
      attachedTarget = { webContents, viewId }
      lastEmittedSignature = null
      nativeTheme.on('updated', themeListener)
    },
    detach: () => {
      clearPendingThemeColorExtraction()
      invalidateExtractionGeneration()
      nativeTheme.removeListener('updated', themeListener)
      attachedTarget = null
      lastEmittedSignature = null
    },
    requestThemeColorRefresh,
    scheduleExtraction,
    clearThemeColor,
    handleNativeThemeColorChange: (webContents, viewId, color) => {
      if (webContents.isDestroyed()) return
      if (!isCurrentAttachedView(webContents, viewId)) return
      if (!color) {
        requestThemeColorRefresh(webContents, viewId, 'nativeCleared')
        return
      }
      emitThemeColorChanged({
        themeColor: color,
        source: 'meta',
        url: webContents.getURL(),
        viewId: viewId ?? undefined,
      })
      log.debug(`🎨 原生主题色事件: ${color}`)
    },
    cleanup: () => {
      clearPendingThemeColorExtraction()
      invalidateExtractionGeneration()
      attachedTarget = null
      lastEmittedSignature = null
      nativeTheme.removeListener('updated', themeListener)
    },
  }
}
