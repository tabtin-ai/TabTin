/**
 * useViewManager - View 多标签管理
 *
 * 统一管理 View 的创建、切换、关闭
 * 从 useWorkspaceViews 抽取的重复逻辑，但更通用（不依赖特定 Store）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { ViewId, ViewInfo, ViewManagerReturn } from '../types'
import { t } from '../i18n'
import { isValidUrl as defaultIsValidUrl, autocompleteUrl as defaultAutocompleteUrl } from '../utils/helpers'
import { shouldMirrorViewManagerEventToLocalStore } from '../utils/context-driven-view-sync'

export interface UseViewManagerOptions {
  /** Crawlspace ID（用于生成 viewId） */
  crawlspaceId: string

  /** 是否激活（未激活时跳过创建） */
  isActive?: boolean

  /** Run ID（可选，用于关联 View 和 Run） */
  runId?: string | null

  /** 获取最新 runId（避免异步 setState 时序问题） */
  getRunId?: () => string | null

  /** 获取初始标题（从 URL 生成） */
  getInitialTitle?: (url: string) => string

  /**
   * 外部 Store 方法（适配不同的状态管理方案）
   * 如果不提供，则使用内部 useState 管理
   */
  storeAdapter?: {
    getViews: () => ViewInfo[]
    getActiveViewId: () => ViewId | null
    addView: (view: ViewInfo) => void
    removeView: (viewId: ViewId) => void
    setActiveViewId: (viewId: ViewId | null) => void
    updateView: (viewId: ViewId, update: Partial<ViewInfo>) => void
    subscribe?: (callback: () => void) => () => void
    isContextDriven?: boolean
  }

  /**
   * IPC 调用适配器（用于与主进程通信）
   */
  ipcAdapter?: {
    createView: (viewId: ViewId, url: string, runId?: string, title?: string) => Promise<boolean>
    destroyView: (viewId: ViewId) => Promise<void>
    switchView: (viewId: ViewId) => Promise<void>
    onEvent?: (callback: (event: any) => void) => () => void
  }

  /** URL 验证函数 */
  isValidUrl?: (url: string) => boolean

  /** URL 自动完成函数（例如补全 https://） */
  autocompleteUrl?: (url: string) => string

  /** View 创建回调 */
  onViewCreated?: (viewId: ViewId, view: ViewInfo) => void

  /** View 关闭回调 */
  onViewClosed?: (viewId: ViewId) => void

  /** 所有 View 关闭后的回调（用于触发 run 清理等全局收尾） */
  onAllViewsClosed?: () => void

  /** View 切换回调 */
  onViewSwitched?: (viewId: ViewId) => void
}


/**
 * 去重 View 列表
 */
const dedupeViews = (list: ViewInfo[]): ViewInfo[] => {
  const map = new Map<ViewId, ViewInfo>()
  list.forEach(v => {
    if (!map.has(v.viewId)) {
      map.set(v.viewId, v)
    }
  })
  return Array.from(map.values())
}

export function useViewManager(options: UseViewManagerOptions): ViewManagerReturn {
  const {
    crawlspaceId,
    isActive = true,
    runId = null,
    getRunId,
    getInitialTitle,
    storeAdapter,
    ipcAdapter,
    isValidUrl = defaultIsValidUrl,
    autocompleteUrl = defaultAutocompleteUrl,
    onViewCreated,
    onViewClosed,
    onAllViewsClosed,
    onViewSwitched
  } = options

  // 内部状态（如果没有提供 storeAdapter）
  // 🔧 修复：如果提供了 storeAdapter，直接在初始化时读取，避免首次渲染为空
  const [internalViews, setInternalViews] = useState<ViewInfo[]>(() => {
    if (storeAdapter) {
      const initialViews = storeAdapter.getViews()
      return initialViews
    }
    return []
  })

  const [internalActiveViewId, setInternalActiveViewId] = useState<ViewId | null>(() => {
    if (storeAdapter) {
      return storeAdapter.getActiveViewId()
    }
    return null
  })

  // 防并发创建
  const creatingViewsRef = useRef<Set<string>>(new Set())
  const activeViewIdRef = useRef<ViewId | null>(null)
  // 记录最近激活的 View，便于恢复
  const lastActiveViewIdRef = useRef<ViewId | null>(null)
  const unsubscribeRef = useRef<(() => void) | null>(null)
  const syncScheduledRef = useRef(false)

  // 🔧 改进：从 storeAdapter 同步到内部状态（按需调用，而不是轮询）
  const syncFromStore = useCallback(() => {
    if (!storeAdapter) return

    const latestViews = storeAdapter.getViews()
    let latestActiveId = storeAdapter.getActiveViewId()

    const activeInList = latestActiveId && latestViews.some(v => v.viewId === latestActiveId)
    // 🛠️ 兜底：如果 activeId 无效，仅在 hook 内部修正，不回写 store
    if ((!latestActiveId || !activeInList) && latestViews.length > 0) {
      const candidate = lastActiveViewIdRef.current && latestViews.some(v => v.viewId === lastActiveViewIdRef.current)
        ? lastActiveViewIdRef.current
        : latestViews[0].viewId
      latestActiveId = candidate
    }

    // 🔧 优化：使用更高效且顺序无关的比较方式
    setInternalViews(prev => {
      // 快速检查：长度不同直接更新
      if (prev.length !== latestViews.length) return latestViews

      // 按 viewId 建立 map 比对（顺序无关）
      const prevMap = new Map((prev as ViewInfo[]).map(v => [v.viewId, v]))
      const latestMap = new Map((latestViews as ViewInfo[]).map(v => [v.viewId, v]))

      // 检查是否有变化（使用 JSON.stringify 覆盖全部字段，包括 status/isLoading/canGoBack/canGoForward/themeColor/isClosing 等）
      if (prevMap.size !== latestMap.size) return latestViews

      for (const [viewId, latest] of latestMap) {
        const old = prevMap.get(viewId)
        if (!old || JSON.stringify(old) !== JSON.stringify(latest)) {
          return latestViews
        }
      }

      return prev
    })

    setInternalActiveViewId(prev => {
      if (prev === latestActiveId) return prev
      return latestActiveId
    })
    // 记录最近激活的 View
    lastActiveViewIdRef.current = latestActiveId
  }, [storeAdapter])

  // 初始同步
  useEffect(() => {
    if (!storeAdapter) return
    syncFromStore()
    // 订阅外部 store 变化，实时同步
    if (typeof storeAdapter.subscribe === 'function') {
      unsubscribeRef.current = storeAdapter.subscribe(() => {
        if (syncScheduledRef.current) return
        syncScheduledRef.current = true
        // 使用 rAF 合并高频变更，fallback setTimeout
        const schedule = (typeof requestAnimationFrame !== 'undefined' ? requestAnimationFrame : setTimeout) as any
        schedule(() => {
          syncFromStore()
          syncScheduledRef.current = false
        })
      })
    }
    return () => {
      unsubscribeRef.current?.()
      unsubscribeRef.current = null
      syncScheduledRef.current = false
    }
  }, [storeAdapter, syncFromStore])

  // 🔧 CC-012：views ref，供 createView 等回调读取最新值，避免依赖 views 导致频繁重建
  const viewsRef = useRef<ViewInfo[]>([])
  // 🔧 修复 CC-001：使用 useRef 缓存 views 引用，仅在内容实际变化时返回新引用
  const viewsCacheRef = useRef<ViewInfo[]>([])
  const views = (() => {
    const raw = storeAdapter ? storeAdapter.getViews() : internalViews
    const deduped = dedupeViews(raw)
    const prev = viewsCacheRef.current
    // 深比较：长度相同且每项所有字段一致则复用旧引用（使用 JSON.stringify 覆盖全部字段）
    if (
      prev.length === deduped.length &&
      prev.every((v, i) => JSON.stringify(v) === JSON.stringify(deduped[i]))
    ) {
      return prev
    }
    viewsCacheRef.current = deduped
    return deduped
  })()
  // 🔧 CC-012：保持 viewsRef 与 views 同步
  viewsRef.current = views

  // 获取当前 activeViewId（优先从 storeAdapter 读取，否则用内部状态）
  const storeActiveViewId = storeAdapter?.getActiveViewId() ?? null
  const storeActiveInList = storeActiveViewId && views.some(v => v.viewId === storeActiveViewId)
  const activeViewId = storeActiveInList ? storeActiveViewId : (internalActiveViewId ?? storeActiveViewId)

  // 同步 activeViewIdRef
  useEffect(() => {
    activeViewIdRef.current = activeViewId
  }, [activeViewId])

  // 🔧 修复：监听 IPC 事件（title/favicon 更新）
  useEffect(() => {
    const subscribe = ipcAdapter?.onEvent
    if (!subscribe) {
      console.warn('[useViewManager] ipcAdapter.onEvent not provided')
      return
    }
    const isContextDriven = Boolean(storeAdapter?.isContextDriven)

    const unsubscribe = subscribe((event: any) => {
      if (!event?.type) return

      const viewId = event.data?.viewId || event.viewId || event.tabId
      if (!viewId) return

      // ✅ 仅处理当前 crawlspace 的 view 事件
      if (storeAdapter) {
        const knownViewIds = storeAdapter.getViews().map(v => v.viewId)
        if (!knownViewIds.includes(viewId)) {
          return
        }
      } else if (!viewId.startsWith(`view-${crawlspaceId}-`)) {
        return  // 忽略其他 crawlspace 的事件
      }

      if (!shouldMirrorViewManagerEventToLocalStore(event.type, isContextDriven)) {
        return
      }

      // Title 变化
      if (event.type === 'title:changed' && event.data?.title) {
        const { title, url } = event.data
        if (storeAdapter) {
          storeAdapter.updateView(viewId, { title, url: url || '' })
          // 🔧 手动同步到内部状态
          syncFromStore()
        } else {
          setInternalViews(prev => prev.map(v =>
            v.viewId === viewId ? { ...v, title, url: url || v.url } : v
          ))
        }
      }

      // Favicon 变化
      if (event.type === 'favicon:changed' && event.data?.favicon) {
        const { favicon } = event.data
        if (storeAdapter) {
          storeAdapter.updateView(viewId, { favicon })
          // 🔧 手动同步到内部状态
          syncFromStore()
        } else {
          setInternalViews(prev => prev.map(v =>
            v.viewId === viewId ? { ...v, favicon } : v
          ))
        }
      }
    })

    return () => {
      unsubscribe?.()
    }
  }, [ipcAdapter, storeAdapter, syncFromStore, crawlspaceId])  // 🔧 添加 crawlspaceId 依赖

  /**
   * 设置激活的 View
   */
  const setActiveView = useCallback((viewId: ViewId | null) => {
    const isContextDriven = Boolean(storeAdapter?.isContextDriven)
    if (storeAdapter) {
      // 🔧 CC-011 修复：context-driven 模式下也通知宿主更新 activeViewId
      storeAdapter.setActiveViewId(viewId)
      if (!isContextDriven) {
        syncFromStore()
      }
    } else {
      setInternalActiveViewId(viewId)
    }
    // 🔧 修复：同步更新 ref（用于比较）
    activeViewIdRef.current = viewId
    lastActiveViewIdRef.current = viewId || lastActiveViewIdRef.current
  }, [storeAdapter, syncFromStore])

  /**
   * 切换到指定 View
   */
  const switchView = useCallback(async (viewId: ViewId): Promise<void> => {
    if (activeViewIdRef.current === viewId) {
      return
    }


    // 调用 IPC 切换 View（如果有）
    if (ipcAdapter?.switchView) {
      try {
        await ipcAdapter.switchView(viewId)
      } catch (error) {
        console.warn('[useViewManager] switchView IPC failed:', error)
        // 宿主未确认切换成功时，不能继续更新本地 active 状态。
        // 对 deferred 浏览器标签而言，IPC 失败表示真实页面尚未创建或激活；
        // 继续 setActiveView 会把 UI 切到一个不存在的 view，重新制造无反馈白屏。
        return
      }
    }

    setActiveView(viewId)
    onViewSwitched?.(viewId)
  }, [setActiveView, ipcAdapter, onViewSwitched])

  /**
   * 创建新 View
   */
  const createView = useCallback(async (url: string, title?: string): Promise<ViewId | null> => {
    if (!isActive) {
      console.warn('[useViewManager] inactive, skipping view creation')
      return null
    }

    const rawUrl = (url || '').trim()

    const isContextDriven = Boolean(storeAdapter?.isContextDriven)

    // 🆕 支持空白标签：context 驱动时走 IPC 让主进程创建；否则直接入库
    if (!rawUrl) {
      const viewId: ViewId = `view-${crawlspaceId}-${Date.now()}`
      const latestRunId = getRunId?.() ?? runId ?? undefined
      const fallbackTitle = title || t('tabs.untitled')
      const viewInfo: ViewInfo = {
        viewId,
        url: '',
        title: fallbackTitle,
        runId: latestRunId ?? undefined,
        createdAt: Date.now(),
        kind: 'workspace-view',
        crawlspaceId
      }

      if (storeAdapter) {
        if (isContextDriven) {
          if (!ipcAdapter?.createView) {
            console.warn('[useViewManager] createView not provided')
            return null
          }
          const success = await ipcAdapter.createView(viewId, 'about:blank', latestRunId, fallbackTitle)
          if (!success) {
            console.warn('[useViewManager] createBlankView IPC failed')
            return null
          }
          storeAdapter.setActiveViewId(viewId)
        } else {
          storeAdapter.addView(viewInfo)
          storeAdapter.setActiveViewId(viewId)
          syncFromStore()
        }
      } else {
        setInternalViews(prev => [...prev, viewInfo])
        setInternalActiveViewId(viewId)
      }

      onViewCreated?.(viewId, viewInfo)
      return viewId
    }

    const normalizedUrl = autocompleteUrl(rawUrl)
    if (!isValidUrl(normalizedUrl)) {
      console.warn('[useViewManager] invalid URL, skipping:', url)
      return null
    }

    // 🔧 CC-012：使用 viewsRef 读取最新 views，避免 useCallback 依赖 views
    const existing = viewsRef.current.find(v => v.url === normalizedUrl)
    if (existing) {
      await switchView(existing.viewId)
      return existing.viewId
    }

    // 防并发创建
    if (creatingViewsRef.current.has(normalizedUrl)) {
      console.warn('[useViewManager] same URL already being created:', normalizedUrl)
      return null
    }
    creatingViewsRef.current.add(normalizedUrl)

    try {
      const viewId: ViewId = `view-${crawlspaceId}-${Date.now()}`
      const latestRunId = getRunId?.() ?? runId ?? undefined
      const viewInfo: ViewInfo = {
        viewId,
        url: normalizedUrl,
        title: title || getInitialTitle?.(normalizedUrl) || new URL(normalizedUrl).hostname,
        runId: latestRunId ?? undefined,
        createdAt: Date.now(),
        kind: 'workspace-view',
        crawlspaceId
      }


      // 调用 IPC 创建 View（如果有）
      if (ipcAdapter?.createView) {
        const success = await ipcAdapter.createView(viewId, normalizedUrl, latestRunId, viewInfo.title)
        if (!success) {
          console.warn('[useViewManager] createView IPC failed')
          return null
        }
      }

      // 更新状态
      if (storeAdapter) {
        if (!isContextDriven) {
          storeAdapter.addView(viewInfo)
        }
        storeAdapter.setActiveViewId(viewId)
        if (!isContextDriven) {
          // 🔧 手动同步到内部状态
          syncFromStore()
        }
      } else {
        setInternalViews(prev => [...prev, viewInfo])
        setInternalActiveViewId(viewId)
      }

      onViewCreated?.(viewId, viewInfo)
      return viewId
    } catch (error) {
      console.error('[useViewManager] view creation failed:', error)
      return null
    } finally {
      creatingViewsRef.current.delete(normalizedUrl)
    }
  }, [
    isActive,
    autocompleteUrl,
    isValidUrl,
    // 🔧 CC-012：移除 views 依赖，改用 viewsRef 读取
    switchView,
    crawlspaceId,
    getInitialTitle,
    ipcAdapter,
    getRunId,
    runId,
    storeAdapter,
    onViewCreated
  ])

  /**
   * 关闭 View
   */
  const closeView = useCallback(async (viewId: ViewId): Promise<void> => {

    // 调用 IPC 销毁 View（如果有）
    if (ipcAdapter?.destroyView) {
      try {
        await ipcAdapter.destroyView(viewId)
      } catch (error) {
        console.warn('[useViewManager] destroyView IPC failed (ignored):', error)
      }
    }

    // 更新状态
    if (storeAdapter) {
      const isContextDriven = Boolean(storeAdapter?.isContextDriven)
      if (!isContextDriven) {
        storeAdapter.removeView(viewId)
        // 🔧 手动同步到内部状态
        syncFromStore()
      }
    } else {
      setInternalViews(prev => prev.filter(v => v.viewId !== viewId))
    }

    // 🔧 修复：如果关闭的是当前激活的 View，切换到最新列表中的下一个
    const currentViews = storeAdapter?.getViews() ?? dedupeViews(internalViews)
    const remaining = currentViews.filter(v => v.viewId !== viewId)
    if (activeViewIdRef.current === viewId) {
      if (remaining.length > 0) {
        await switchView(remaining[0].viewId)
      } else {
        setActiveView(null)
      }
    }

    // 🆕 如果所有 View 都已关闭，触发全局收尾（例如清理 run）
    if (remaining.length === 0) {
      onAllViewsClosed?.()
    }

    onViewClosed?.(viewId)
  }, [ipcAdapter, storeAdapter, internalViews, switchView, setActiveView, onViewClosed, onAllViewsClosed])

  /**
   * 更新 View 信息
   */
  const updateView = useCallback(async (viewId: ViewId, updates: Partial<ViewInfo>) => {
    if (storeAdapter) {
      const isContextDriven = Boolean(storeAdapter?.isContextDriven)
      storeAdapter.updateView(viewId, updates)
      if (!isContextDriven) {
        syncFromStore()
      }
    } else {
      setInternalViews(prev => prev.map(v =>
        v.viewId === viewId ? { ...v, ...updates } : v
      ))
    }
  }, [storeAdapter, syncFromStore])

  const isContextDriven = Boolean(storeAdapter?.isContextDriven)

  return useMemo(() => ({
    views,
    activeViewId,
    isContextDriven,
    createView,
    switchView,
    closeView,
    updateView,
    setActiveView
  }), [views, activeViewId, isContextDriven, createView, switchView, closeView, updateView, setActiveView])
}
