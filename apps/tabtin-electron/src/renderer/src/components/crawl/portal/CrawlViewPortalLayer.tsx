import React, { useCallback, useEffect, useMemo, useRef } from 'react'
import { createPortal } from 'react-dom'
import { EmbeddedCrawlView } from '@components/crawl/EmbeddedCrawlView'
import {
  useCrawlTabStore,
  type CrawlTab,
  type CrawlspaceConfig,
  type CrawlspaceViewInfo
} from '@stores/useCrawlTabStore'
import { useCrawlspaceRegistry } from '@/crawlspace/registry'
import { crawlViewClient } from '@/crawlspace/electron/crawl-view-client'
import { crawlspaceContextClient } from '@/crawlspace/electron/crawlspace-context-client'
import { contextRegistry } from '@components/context-space/registry'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { useCrawlViewPortal, type CrawlViewSlotSource } from './CrawlViewPortalContext'
import { resolveCrawlViewTabScope } from './crawlViewTabScope'
import i18n from '@/i18n'
import { createIPCErrorHandler } from '../utils/ipc-error-handler'

const handleError = createIPCErrorHandler('CrawlViewPortalLayer')

type CrawlViewEntry = {
  viewId: string
  viewInfo: CrawlspaceViewInfo
  crawlspaceId: string
  crawlspaceConfig: CrawlspaceConfig
}

/**
 * 🎯 Slot 来源优先级配置
 *
 * 优先级规则（从高到低）：
 * - canvas (2): 分屏画布，优先级最高
 * - workspace (1): 单标签工作区
 * - unknown (0): 未知来源，兜底
 *
 * 当多个 slot 同时激活时，选择优先级最高的
 */
const SOURCE_PRIORITY: Record<CrawlViewSlotSource, number> = {
  canvas: 2,
  workspace: 1,
  unknown: 0
} as const

const buildViewTab = (entry: CrawlViewEntry): CrawlTab => {
  const { viewInfo, crawlspaceId, crawlspaceConfig } = entry
  const createdAt = new Date(viewInfo.createdAt ?? Date.now())
  const newTabTitle = i18n.t('context:label.newTab')
  return {
    id: viewInfo.viewId,
    url: viewInfo.url || '',
    name: viewInfo.title || newTabTitle,
    createdAt,
    updatedAt: new Date(),
    kind: 'temporary',
    runId: viewInfo.runId,
    metadata: {
      crawlspaceId,
      runId: viewInfo.runId,
      profile: crawlspaceConfig.profile,
      partition: crawlspaceConfig.partition,
      toolbarColor: crawlspaceConfig.sessionColor,
      isPreview: Boolean(viewInfo.isPreview),
      kind: viewInfo.kind || 'workspace-view'
    }
  }
}

export const CrawlViewPortalLayer: React.FC = () => {
  const { slots, parkingHost, setParkingHost } = useCrawlViewPortal()
  const { configsById: crawlspaceConfigById } = useCrawlspaceRegistry()
  const ensureCrawlspaceConfig = useCrawlTabStore(state => state.ensureCrawlspaceConfig)
  const crawlspaceContextCache = useCrawlTabStore(state => state.crawlspaceContextCache)
  const warnedRef = useRef<Set<string>>(new Set())
  const missingParkingFramesRef = useRef(0)
  const hasParkingHostRef = useRef(false)
  const slotSnapshotRef = useRef<Map<string, string>>(new Map())
  // 🧹 移除了 fallback 相关的 ref
  const logTabSwitch = useCallback((stage: string, payload: Record<string, unknown>) => {
    if (!globalThis.__TABTIN_DEBUG_TAB_SWITCH__) return
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now()
    console.info(`[TabSwitch] ${stage}`, { t: now, ...payload })
  }, [])

  const warnOnce = useCallback((key: string, message: string, details?: Record<string, unknown>) => {
    if (warnedRef.current.has(key)) {
      return
    }
    warnedRef.current.add(key)
    if (globalThis.__TABTIN_DEBUG_TAB_SWITCH__) {
      console.warn(message, details)
    }
  }, [])

  const handleSetParkingHost = useCallback((node: HTMLDivElement | null) => {
    if (node) {
      hasParkingHostRef.current = true
      // 使用 inert 代替 aria-hidden，这会自动处理焦点问题（防止焦点进入，并将现有焦点移出）
      node.inert = true
    }
    setParkingHost(node)
  }, [setParkingHost])

  const missingConfigIds = useMemo(() => {
    const result: string[] = []
    Object.entries(crawlspaceContextCache).forEach(([crawlspaceId, cache]) => {
      if (crawlspaceConfigById[crawlspaceId]) {
        return
      }
      if ((cache?.viewList || []).length > 0) {
        result.push(crawlspaceId)
      }
    })
    return result
  }, [crawlspaceConfigById, crawlspaceContextCache])

  const closingViewIdSet = useMemo(() => {
    const ids = new Set<string>()
    Object.values(crawlspaceContextCache).forEach(cache => {
      cache.viewList.forEach(view => {
        if (view.isClosing) {
          ids.add(view.viewId)
        }
      })
    })
    return ids
  }, [crawlspaceContextCache])

  useEffect(() => {
    if (missingConfigIds.length === 0) {
      return
    }
    missingConfigIds.forEach(crawlspaceId => {
      const ensured = ensureCrawlspaceConfig(crawlspaceId)
      if (!ensured) {
        warnOnce(
          `missing-config:${crawlspaceId}`,
          '[CrawlViewPortal] Missing crawlspace config while views exist',
          { crawlspaceId }
        )
      }
    })
  }, [ensureCrawlspaceConfig, missingConfigIds, warnOnce])

  const viewEntryMap = useMemo(() => {
    const map = new Map<string, CrawlViewEntry>()
    Object.entries(crawlspaceContextCache).forEach(([crawlspaceId, cache]) => {
      const crawlspaceConfig = crawlspaceConfigById[crawlspaceId]
      if (!crawlspaceConfig) {
        return
      }
      cache?.viewList?.forEach(viewInfo => {
        if (viewInfo.isClosing) {
          return
        }
        map.set(viewInfo.viewId, {
          viewId: viewInfo.viewId,
          viewInfo,
          crawlspaceId,
          crawlspaceConfig
        })
      })
    })
    return map
  }, [crawlspaceConfigById, crawlspaceContextCache])

  const viewIds = useMemo(() => Array.from(viewEntryMap.keys()), [viewEntryMap])
  const rootMapRef = useRef<Map<string, HTMLDivElement>>(new Map())

  const resolveViewContext = useCallback((viewId: string) => {
    const entry = viewEntryMap.get(viewId)
    const entrySpaceId = entry?.crawlspaceConfig?.spaceId ?? (entry?.crawlspaceConfig as { projectId?: string })?.projectId
    if (entry && entrySpaceId) {
      return {
        crawlspaceId: entry.crawlspaceId,
        spaceId: entrySpaceId,
        browserScopeKey: entry.crawlspaceConfig.browserScopeKey,
      }
    }

    const state = useCrawlTabStore.getState()
    const caches = state.crawlspaceContextCache || {}
    for (const [crawlspaceId, cache] of Object.entries(caches)) {
      if (cache.viewList.some(view => view.viewId === viewId)) {
        const config = state.crawlspaceConfigById[crawlspaceId]
        const spaceId = config?.spaceId ?? (config as { projectId?: string })?.projectId
        if (spaceId) {
          return { crawlspaceId, spaceId, browserScopeKey: config?.browserScopeKey }
        }
      }
    }
    return null
  }, [viewEntryMap])

  const handleViewInteraction = useCallback((viewId: string) => {
    if (!viewId) return
    const resolved = resolveViewContext(viewId)
    if (!resolved?.spaceId || !resolved?.crawlspaceId) {
      return
    }

    const tabKey = contextRegistry.buildTabKey('tabweb', viewId)
    const tabsState = useSpaceContextTabsStore.getState()
    const tabScopeKey = resolveCrawlViewTabScope({
      tabKey,
      config: resolved,
      tabsState,
    })
    if (!tabScopeKey) {
      return
    }

    const currentActiveKey = tabsState.activeKeyBySpace[tabScopeKey] ?? null
    if (currentActiveKey !== tabKey) {
      tabsState.setActiveKey(tabScopeKey, tabKey)
    }

    const crawlState = useCrawlTabStore.getState()
    const activeViewId = crawlState.crawlspaceContextCache[resolved.crawlspaceId]?.activeViewId ?? null
    if (activeViewId !== viewId) {
      crawlspaceContextClient.setActiveView(resolved.crawlspaceId, viewId).catch(handleError('setActiveView'))
    }
  }, [resolveViewContext])

  useEffect(() => {
    const unsubscribe = crawlViewClient.onEvent((event) => {
      if (!event || event.type !== 'view:focused') return
      const viewId = event?.data?.viewId
      if (typeof viewId !== 'string' || !viewId) return
      if (document.activeElement instanceof HTMLElement) {
        document.activeElement.blur()
      }
      handleViewInteraction(viewId)
    })
    return unsubscribe
  }, [handleViewInteraction])

  useEffect(() => {
    const unsubscribe = crawlViewClient.onCrashRecovered((payload) => {
      if (globalThis.__TABTIN_DEBUG_TAB_SWITCH__) {
        console.warn(`[CrawlViewPortalLayer] View ${payload.viewId} crashed (${payload.reason}), reloading URL: ${payload.url}`)
      }
    })
    return unsubscribe
  }, [])

  const ensureRoot = useCallback((viewId: string): HTMLDivElement | null => {
    const existing = rootMapRef.current.get(viewId)
    if (existing) return existing
    if (typeof document === 'undefined') return null
    const root = document.createElement('div')
    root.dataset.crawlViewRoot = viewId
    root.style.height = '100%'
    root.style.width = '100%'
    root.style.minHeight = '0'
    root.style.minWidth = '0'
    rootMapRef.current.set(viewId, root)
    return root
  }, [])

  /**
   * 🎯 计算每个 view 的渲染目标
   *
   * 逻辑：
   * 1. 检查孤儿 slot（有 slot 但没有对应的 view）
   * 2. 为每个 view 找到最佳的 slot（或 parkingHost）
   * 3. 检测多 slot 冲突并记录警告
   */
  const slotTargets = useMemo(() => {
    const result = new Map<string, { target: HTMLElement | null; isActive: boolean; source: CrawlViewSlotSource }>()

    // 🔍 检查孤儿 slot：有 slot 注册但没有对应的 view entry
    const slotKeys = Array.from(slots.keys())
    slotKeys.forEach(slotViewId => {
      if (!viewEntryMap.has(slotViewId)) {
        const entries = slots.get(slotViewId)
        const hasActive = Array.from(entries?.values() ?? []).some(entry => entry.isActive)
        if (hasActive) {
          if (closingViewIdSet.has(slotViewId)) {
            return
          }
          warnOnce(
            `missing-view:${slotViewId}`,
            '[CrawlViewPortal] ⚠️ 孤儿 slot：有激活的 slot 但没有对应的 view entry',
            { viewId: slotViewId }
          )
        }
      }
    })

    // 🎯 为每个 view 计算渲染目标
    viewIds.forEach(viewId => {
      const entries = slots.get(viewId)
      const activeEntries = Array.from(entries?.values() ?? [])
        .filter(entry => entry.isActive && entry.element.isConnected)

      // ⚠️ 多 slot 冲突检测
      if (activeEntries.length > 1) {
        warnOnce(
          `multi-active:${viewId}`,
          '[CrawlViewPortal] ⚠️ 多 slot 冲突：同一 view 有多个激活的 slot，将选择优先级最高的',
          {
            viewId,
            conflictCount: activeEntries.length,
            slots: activeEntries.map(entry => ({
              source: entry.source,
              priority: entry.priority
            }))
          }
        )
      }

      // 🎯 使用稳定的排序算法选择最佳 slot
      const ranked = activeEntries.map((entry, index) => ({ entry, index }))
      ranked.sort((a, b) => {
        // 1. 优先级高者优先
        if (a.entry.priority !== b.entry.priority) {
          return b.entry.priority - a.entry.priority
        }
        // 2. 来源优先级高者优先
        if (a.entry.source !== b.entry.source) {
          return SOURCE_PRIORITY[b.entry.source] - SOURCE_PRIORITY[a.entry.source]
        }
        // 3. 保持插入顺序稳定性
        return a.index - b.index
      })

      const activeSlot = ranked[0]?.entry ?? null

      // ⚠️ 无目标警告
      if (entries && entries.size > 0 && !activeSlot && !parkingHost) {
        warnOnce(
          `no-target:${viewId}`,
          `[CrawlViewPortal] ${i18n.t('crawl:portal.logs.noRenderTarget')}`,
          { viewId, slotCount: entries.size }
        )
      }

      // 🎯 确定最终目标：优先使用 activeSlot，否则使用 parkingHost
      const target = activeSlot?.element ?? parkingHost
      const nextSnapshot = activeSlot
        ? `${activeSlot.source}:${activeSlot.priority}:1:1`
        : 'none'

      const prevSnapshot = slotSnapshotRef.current.get(viewId)
      if (prevSnapshot !== nextSnapshot) {
        slotSnapshotRef.current.set(viewId, nextSnapshot)
        logTabSwitch('portal:slot-change', {
          viewId,
          prev: prevSnapshot ?? null,
          next: nextSnapshot
        })
      }

      result.set(viewId, {
        target,
        isActive: Boolean(activeSlot),
        source: activeSlot?.source ?? 'unknown'
      })
    })

    return result
  }, [parkingHost, slots, viewEntryMap, viewIds, warnOnce, closingViewIdSet, logTabSwitch])

  // ⭐ 使用 useEffect + requestAnimationFrame，打破同步循环
  useEffect(() => {
    if (!parkingHost) return

    // 延迟执行 DOM 操作，让 React 完成渲染批次
    const rafId = requestAnimationFrame(() => {
      const movedViewIds: string[] = []
      if (viewIds.length === 0) {
        missingParkingFramesRef.current = 0
      } else if (parkingHost) {
        missingParkingFramesRef.current = 0
      } else if (hasParkingHostRef.current) {
        missingParkingFramesRef.current += 1
        if (missingParkingFramesRef.current >= 2) {
          warnOnce(
            'parking-missing',
            '[CrawlViewPortal] Parking host is not ready while views exist',
            { viewCount: viewIds.length }
          )
        }
      } else {
        missingParkingFramesRef.current = 0
      }
      const activeIds = new Set(viewIds)
      viewIds.forEach(viewId => {
        const root = ensureRoot(viewId)
        if (!root) return
        const target = slotTargets.get(viewId)?.target
        if (!target) {
          return
        }
        if (root.parentElement !== target) {
          // 🛡️ 修复 "Blocked aria-hidden" 错误
          // 如果视图被移动到 parkingHost（它是隐藏的且有 aria-hidden），
          // 而视图内部仍持有焦点，浏览器会报错。
          // 因此在移动前，如果焦点在当前视图内，强制移除焦点。
          if (target === parkingHost && root.contains(document.activeElement)) {
            (document.activeElement as HTMLElement).blur?.()
          }

          target.appendChild(root)
          movedViewIds.push(viewId)
        }
      })
      rootMapRef.current.forEach((root, viewId) => {
        if (!activeIds.has(viewId)) {
          root.remove()
          rootMapRef.current.delete(viewId)
        }
      })
      if (movedViewIds.length > 0 && typeof window !== 'undefined') {
        movedViewIds.forEach(viewId => {
          window.dispatchEvent(new CustomEvent('crawl-view-slot-change', { detail: { viewId } }))
        })
      }
    })

    return () => {
      cancelAnimationFrame(rafId)
    }
  }, [ensureRoot, parkingHost, slotTargets, viewIds, warnOnce])

  return (
    <>
      {/*
        屏外停泊宿主（工具类机制，不是业务"挂载但隐藏"）。
        当一个 view 当前没有可挂的 active slot（所有 slot 不可见 / 真正 unmount），
        它的 React root 会被 appendChild 到这里——保证 root 始终有父节点，
        EmbeddedCrawlView 的 React 树不被卸载，状态保留。

        屏外可见性靠 5 重保证：
        - `pointer-events-none`：渲染层不可交互
        - `inert`（在 handleSetParkingHost 里设，自动接管焦点管理）
        - `absolute -left-[99999px] -top-[99999px]`：屏外位移
        - `h-0 w-0`：0 尺寸
        - `overflow-hidden`：裁剪溢出
        BrowserView 的可见性由主进程通过 `useViewDisplay` 的 hide IPC 控制，
        跟这里的 DOM 隐藏完全独立。
      */}
      <div
        ref={handleSetParkingHost}
        className="pointer-events-none absolute -left-[99999px] -top-[99999px] h-0 w-0 overflow-hidden"
        data-crawl-view-parking="true"
      />
      {viewIds.map(viewId => {
        const root = ensureRoot(viewId)
        if (!root) return null
        const entry = viewEntryMap.get(viewId)
        if (!entry) return null
        const slotInfo = slotTargets.get(viewId)
        const isActive = slotInfo?.isActive ?? false
        const allowMultiple = slotInfo?.source === 'canvas'
        return createPortal(
          <EmbeddedCrawlView
            tab={buildViewTab(entry)}
            isActive={isActive}
            allowMultiple={allowMultiple}
            onInteraction={() => handleViewInteraction(viewId)}
          />,
          root,
          viewId
        )
      })}
    </>
  )
}

CrawlViewPortalLayer.displayName = 'CrawlViewPortalLayer'
