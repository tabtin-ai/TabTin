import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useCrawlspace, type UseCrawlspaceOptions } from '../../hooks/useCrawlspace'
import { crawlspaceRegistry } from '../../registry/CrawlspaceRegistry'
import { requestCloseWorkspace } from '../../events'
import type { CrawlspaceContext, CrawlspaceHost, ViewInfo } from '../../types'
import { CrawlspaceLayout } from '../layout/CrawlspaceLayout'
import { CrawlspaceViewTabs } from '../tabs/CrawlspaceViewTabs'
import { CrawlspaceToolbar } from '../toolbar/CrawlspaceToolbar'
import { FindBar } from '../toolbar/FindBar'
import { ControlBar } from '../panels/ControlBar'
import { t } from '../../i18n'
import { autocompleteUrl as fallbackAutocomplete } from '../../utils/helpers'
import { shouldMirrorShellEventToLocalStore } from '../../utils/context-driven-view-sync'

function buildCrawlspaceContext(
  crawlspace: ReturnType<typeof useCrawlspace>,
  params: {
    crawlspaceId: string
    isActive: boolean
    userId?: string
    pluginProps?: Record<string, any>
    host: CrawlspaceHost
    closePlugin?: (pluginId: string) => void
  }
): CrawlspaceContext {
  return {
    runManager: crawlspace.run,
    viewManager: crawlspace.view,
    crawlspaceId: params.crawlspaceId,
    isActive: params.isActive,
    userId: params.userId,
    exec: crawlspace.exec,
    pluginProps: params.pluginProps,
    host: params.host,
    closePlugin: params.closePlugin,
  }
}

export interface CrawlspaceShellProps {
  pluginId?: string
  crawlspaceId: string
  isActive?: boolean
  onClosePlugin?: (pluginId: string, crawlspaceId: string) => void
  host?: CrawlspaceHost
  destroyViewsOnUnmount?: boolean

  // Optional overrides
  runPrefix?: string
  userId?: string
  showToolbar?: boolean
  showTabs?: boolean

  // Adapters
  storeAdapter?: any
  ipcAdapter?: any
  isValidUrl?: (url: string) => boolean
  autocompleteUrl?: (url: string) => string
  renderView?: (view: ViewInfo, isActive: boolean) => React.ReactNode

  pluginProps?: Record<string, any>

  // Find-in-Page
  onFind?: (viewId: string, text: string, options: { forward?: boolean; findNext?: boolean }) => void
  onStopFind?: (viewId: string) => void
  findMatchInfo?: { current: number; total: number } | null
  showFindBar?: boolean
  onFindBarToggle?: (show: boolean) => void

  // Layout resize hooks
  onLayoutResizeStart?: (ratio: number) => void
  onLayoutResizeEnd?: (ratio: number) => void
  onLayoutResizeCancel?: (ratio: number) => void

  /** Session 颜色标识，透传给标签栏底部颜色条 */
  accentColor?: string
  getViewDragData?: (view: ViewInfo) => {
    text: string
    mimeData: Record<string, string>
    effectAllowed?: DataTransfer['effectAllowed']
  } | null

  /**
   * 组件 unmount / effect cleanup 时是否保活当前 Run（不调 endRun）。
   *
   * Wave 3.2：配合 React 19.2 `<Activity>` —— hidden 触发 cleanup 时，调用方
   * 通过这个闭包告诉 hook「Space 仍在 hot 且 crawlspace 仍存在」，跳过 endRun
   * 并保留 runIdRef，让 visible 时同一 hook 实例的 ensureRun() 复用旧 runId。
   *
   * 不传 / 返回 false → 保持原行为（cleanup 即 endRun）。
   */
  shouldKeepRunOnCleanup?: () => boolean
}

export const CrawlspaceShell: React.FC<CrawlspaceShellProps> = ({
  pluginId,
  crawlspaceId,
  isActive = true,
  onClosePlugin,
  host,
  runPrefix,
  userId,
  showToolbar = true,
  showTabs = true,
  storeAdapter,
  ipcAdapter,
  isValidUrl,
  autocompleteUrl,
  renderView,
  pluginProps,
  destroyViewsOnUnmount = false,
  onFind,
  onStopFind,
  findMatchInfo,
  showFindBar: showFindBarProp,
  onFindBarToggle,
  onLayoutResizeStart,
  onLayoutResizeEnd,
  onLayoutResizeCancel,
  accentColor,
  getViewDragData,
  shouldKeepRunOnCleanup,
}) => {
  // 1. 获取插件定义
  const plugin = pluginId ? crawlspaceRegistry.get(pluginId) : undefined

  // 将旧的 onClosePlugin 桥接到 host.closeWorkspaceUI（便于逐步收敛）
  const effectiveHost: CrawlspaceHost = useMemo(() => {
    const bridgedCloseWorkspaceUI: CrawlspaceHost['closeWorkspaceUI'] = onClosePlugin
      ? ({ crawlspaceId, pluginId, reason }) => {
          void reason
          onClosePlugin(pluginId || 'unknown', crawlspaceId)
        }
      : undefined
    return {
      ...host,
      closeWorkspaceUI: host?.closeWorkspaceUI || bridgedCloseWorkspaceUI
    }
  }, [host, onClosePlugin])

  // 2. 初始化核心 Hook
  const crawlspace = useCrawlspace({
    crawlspaceId,
    isActive,
    runOptions: {
      userId,
      runPrefix: runPrefix || 'run', // ✅ 使用传入的 runPrefix
      adapter: effectiveHost.runSession,
      shouldKeepRunOnCleanup,
    },
    viewOptions: {
      storeAdapter,
      ipcAdapter,
      isValidUrl,
      autocompleteUrl,
      getInitialTitle: (url: string) => new URL(url).hostname,
      onAllViewsClosed: undefined
    },
    executeOptions: {
      runId: null,
      adapter: effectiveHost.taskApi,
      analytics: effectiveHost.analytics,
      onTaskCreated: undefined,
      onTaskCompleted: undefined,
      onTaskFailed: (taskId: string, error: string) => {
        console.error('[CrawlspaceShell] Task failed:', taskId, error)
      },
      onTaskPaused: (taskId: string, pauseInfo: any) => {
        plugin?.onPause?.(buildCrawlspaceContext(crawlspace, { crawlspaceId, isActive, userId, pluginProps, host: effectiveHost, closePlugin }))
      },
      onTaskCancelled: (taskId: string) => {
        plugin?.onCancel?.(buildCrawlspaceContext(crawlspace, { crawlspaceId, isActive, userId, pluginProps, host: effectiveHost, closePlugin }))
      },
      onTaskResumed: (taskId: string) => {
        plugin?.onResume?.(buildCrawlspaceContext(crawlspace, { crawlspaceId, isActive, userId, pluginProps, host: effectiveHost, closePlugin }))
      }
    }
  })

  /**
   * 关闭工作区：触发 plugin.onDeactivate（如有），然后通过 module-level
   * event bus 派发关闭请求。
   *
   * 关闭链路：
   *   `requestCloseWorkspace({ crawlspaceId })` → store 注入的 handler
   *   → `useCrawlTabStore.getState().closeCrawlspace(...)` → store 内
   *   `endRunsSafe` + `closeViewsSafe` 完成 IPC 资源释放 + set 删 cache /
   *   tabs / config → SpaceWorkbenchHost 不再渲染该 cs → Shell 真 unmount。
   *
   * handler 由 store 持有（与 React 组件生命周期解耦），任何 cs 状态
   * （hot/hidden/cold/已 unmount）都能响应；具体语义见
   * `packages/crawlspace-core/src/events/close-workspace.ts`。
   *
   * `plugin.onDeactivate` 路径分裂（已知技术债）：
   * - 本路径（Shell 主动关）：调用 ✓
   * - 外部 close（用户右键 tab / 跨 Space 关闭等直达 store handler）：跳过
   * 当前 0 plugin 实现 onDeactivate，无实际影响。详见 `plugin.ts` 注释，
   * 治理方向待 Wave 3.4+ 决策。
   *
   * fallback 仅兜测试 / SSR：生产路径下 store 模块加载即注入 handler，
   * `requestCloseWorkspace` 永远返 true，下面的 `if (!handled)` 分支
   * 不触发。
   */
  const closeWorkspace = useCallback(async (_pluginIdToClose: string, reason?: string) => {
    try {
      await plugin?.onDeactivate?.(
        buildCrawlspaceContext(crawlspace, { crawlspaceId, isActive, userId, pluginProps, host: effectiveHost }),
      )
    } catch (error) {
      console.warn('[CrawlspaceShell] closeWorkspace: plugin.onDeactivate failed (ignored):', error)
    }

    const handled = requestCloseWorkspace({
      crawlspaceId,
      reason: reason || 'shell.closeWorkspace',
    })

    if (!handled) {
      // handler 未注入（应用启动期 / 测试环境）→ fallback 到旧路径，避免请求
      // 静默丢失。生产路径下 handler 在 useCrawlTabStore 加载时立即注入，
      // 这条 fallback 主要兜测试 / SSR。
      console.warn(
        '[CrawlspaceShell] closeWorkspace: requestCloseWorkspace returned false (no handler), falling back to host.closeWorkspaceUI',
        { crawlspaceId, reason },
      )
      try {
        await effectiveHost.closeWorkspaceUI?.({ crawlspaceId, pluginId: _pluginIdToClose, reason })
      } catch (error) {
        console.warn('[CrawlspaceShell] closeWorkspace: closeWorkspaceUI fallback failed (ignored):', error)
      }
    }
  }, [crawlspace, crawlspaceId, effectiveHost, isActive, plugin, pluginProps, userId])

  // 兼容：插件继续调用 closePlugin，但内部收敛到 closeWorkspace
  const closePlugin = useCallback((pluginIdToClose: string) => {
    void closeWorkspace(pluginIdToClose, 'plugin-request')
  }, [closeWorkspace])

  const shouldShowViewTabs = showTabs && (crawlspace.view.views.length > 0 || !pluginId)

  // 3. Toolbar 导航能力
  const handleNavigate = useCallback(async (url: string) => {
    const normalize = (autocompleteUrl || fallbackAutocomplete)(url)
    // Shell 不掌握 bounds，因此默认行为是“打开新 View”
    await crawlspace.view.createView(normalize)
  }, [crawlspace.view, autocompleteUrl])

  const handleBack = useCallback(async () => {
    try {
      const viewId = crawlspace.view.activeViewId
      if (!viewId) return
      await effectiveHost.navigation?.goBack?.(viewId)
    } catch (error) {
      console.warn('[CrawlspaceShell] goBack failed (ignored):', error)
    }
  }, [crawlspace.view.activeViewId, effectiveHost])

  const handleForward = useCallback(async () => {
    try {
      const viewId = crawlspace.view.activeViewId
      if (!viewId) return
      await effectiveHost.navigation?.goForward?.(viewId)
    } catch (error) {
      console.warn('[CrawlspaceShell] goForward failed (ignored):', error)
    }
  }, [crawlspace.view.activeViewId, effectiveHost])

  const handleRefresh = useCallback(async () => {
    try {
      const viewId = crawlspace.view.activeViewId
      if (!viewId) return
      await effectiveHost.navigation?.reload?.(viewId, false)
    } catch (error) {
      console.warn('[CrawlspaceShell] reload failed (ignored):', error)
    }
  }, [crawlspace.view.activeViewId, effectiveHost])

  const handleStop = useCallback(async () => {
    try {
      const viewId = crawlspace.view.activeViewId
      if (!viewId) return
      await effectiveHost.navigation?.stop?.(viewId)
    } catch (error) {
      console.warn('[CrawlspaceShell] stop failed (ignored):', error)
    }
  }, [crawlspace.view.activeViewId, effectiveHost])

  // 监听视图导航状态变化
  useEffect(() => {
    const unsubscribe = effectiveHost.view?.onEvent?.((event: any) => {
      // 事件结构: { type: 'navigation:state' | 'page:loading' | 'theme-color:changed' | ..., data: { viewId, ... } }
      const eventType = event?.type as string
      const eventData = event?.data || {}
      const viewId = eventData.viewId as string | undefined

      if (!viewId) return

      // 仅处理我们关心的事件类型
      const handledTypes = [
        'page:loading',
        'page:loaded',
        'navigation:state',
        'navigation:completed',
        'theme-color:changed'
      ]
      if (!handledTypes.includes(eventType)) return
      if (!shouldMirrorShellEventToLocalStore(eventType, Boolean(crawlspace.view.isContextDriven))) {
        return
      }

      const updates: Partial<ViewInfo> = {}

      if (eventType === 'page:loading') {
        updates.isLoading = true
      } else if (eventType === 'page:loaded') {
        updates.isLoading = false
      }

      // navigation:state 携带完整导航状态
      if (typeof eventData.canGoBack === 'boolean') {
        updates.canGoBack = eventData.canGoBack
      }
      if (typeof eventData.canGoForward === 'boolean') {
        updates.canGoForward = eventData.canGoForward
      }
      if (typeof eventData.isLoading === 'boolean') {
        updates.isLoading = eventData.isLoading
      }

      // theme-color:changed 携带主题色
      if (eventType === 'theme-color:changed') {
        // themeColor 可能为 null（表示清除），需要显式设置
        updates.themeColor = eventData.themeColor || undefined
      }

      if (eventData.url) {
        updates.url = eventData.url
      }
      if (eventData.title) {
        updates.title = eventData.title
      }

      if (Object.keys(updates).length > 0) {
        void crawlspace.view.updateView(viewId, updates)
      }
    })

    return () => {
      unsubscribe?.()
    }
  }, [effectiveHost.view, crawlspace.view])

  const handleNewView = useCallback(async () => {
    await crawlspace.view.createView('', t('tabs.untitled'))
  }, [crawlspace.view])

  const shouldShowPanel = Boolean(pluginId)

  // 4. 渲染插件面板
  const panelContent = useMemo(() => {
    if (!pluginId) {
      return null
    }

    if (!plugin) {
      return (
        <div className="flex h-full items-center justify-center text-muted-foreground">
          {t('crawlspaceShell.pluginNotFound', { id: pluginId })}
        </div>
      )
    }

    const baseContext = buildCrawlspaceContext(crawlspace, { crawlspaceId, isActive, userId, pluginProps, host: effectiveHost, closePlugin })
    const asyncUpdateView = async (viewId: string, updates: Partial<ViewInfo>) => {
      crawlspace.view.updateView(viewId, updates)
    }
    const pluginContext: CrawlspaceContext = {
      ...baseContext,
      viewManager: {
        views: crawlspace.view.views,
        activeViewId: crawlspace.view.activeViewId,
        createView: crawlspace.view.createView,
        switchView: crawlspace.view.switchView,
        closeView: crawlspace.view.closeView,
        updateView: asyncUpdateView,
        setActiveView: crawlspace.view.setActiveView
      },
    }

    return plugin.renderPanel(pluginContext, pluginProps)
  }, [plugin, pluginId, crawlspaceId, isActive, userId, crawlspace, pluginProps, effectiveHost])

  const destroyViewsOnUnmountRef = useRef(destroyViewsOnUnmount)

  useEffect(() => {
    destroyViewsOnUnmountRef.current = destroyViewsOnUnmount
  }, [destroyViewsOnUnmount])

  // 清理：组件卸载时销毁所有 View，避免残留网页悬浮
  useEffect(() => {
    return () => {
      if (!destroyViewsOnUnmountRef.current) {
        return
      }
      const viewIds = crawlspace.view.views.map(v => v.viewId)
      viewIds.forEach(id => {
        crawlspace.view.closeView(id).catch(e => console.warn('[CrawlspaceShell] unmount closeView failed:', id, e))
      })
      crawlspace.run.cleanupRun?.().catch(e => console.warn('[CrawlspaceShell] unmount cleanupRun failed:', e))
    }
  // 只在组件卸载时运行
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  return (
    <div className="flex h-full w-full flex-col overflow-hidden bg-transparent text-foreground">

      {/* ✅ 使用上下分栏布局 */}
      <CrawlspaceLayout
        top={
          /* 上方：视图区域（带标签栏） */
          <div className="h-full w-full flex flex-col bg-transparent">
            {/* 标签栏 */}
            {shouldShowViewTabs && (
              <div className="flex-shrink-0 border-b border-border/50 bg-background px-2 py-1">
                <CrawlspaceViewTabs
                  views={crawlspace.view.views}
                  activeViewId={crawlspace.view.activeViewId}
                  onSelectView={(viewId) => crawlspace.view.switchView(viewId)}
                  onCloseView={(viewId) => crawlspace.view.closeView(viewId)}
                  onNewView={handleNewView}
                  showNewButton={true}
                  showClose={true}
                  accentColor={accentColor}
                  getViewDragData={getViewDragData}
                />
              </div>
            )}

            {/* 视图内容区域 */}
            <div className="flex-1 relative overflow-hidden">
              {showFindBarProp && crawlspace.view.activeViewId && (
                <FindBar
                  onFind={(text, options) => onFind?.(crawlspace.view.activeViewId!, text, options)}
                  onStopFind={() => {
                    onStopFind?.(crawlspace.view.activeViewId!)
                    onFindBarToggle?.(false)
                  }}
                  matchInfo={findMatchInfo}
                />
              )}
              {crawlspace.view.views.map((view: ViewInfo) => {
                const isViewActive = view.viewId === crawlspace.view.activeViewId
                if (!isViewActive && !renderView) return null

                return (
                  <div
                    key={view.viewId}
                    className={`absolute inset-0 ${isViewActive ? 'z-sticky block' : 'hidden'}`}
                  >
                    {renderView ? renderView(view, isViewActive) : (
                      <iframe src={view.url} className="h-full w-full border-0" />
                    )}
                  </div>
                )
              })}

              {crawlspace.view.views.length === 0 && (
                <div className="flex h-full items-center justify-center text-muted-foreground">
                  {pluginId
                    ? t('crawlspaceShell.noActiveViews')
                    : t('crawlspaceShell.noTabs')}
                </div>
              )}
            </div>
          </div>
        }
        bottom={
          /* 下方：插件面板（带内边距） */
          <div className="h-full flex flex-col overflow-hidden bg-background p-4">
            {panelContent}
          </div>
        }
        bottomHidden={!shouldShowPanel}
        defaultRatio={0.6}
        minRatio={0.3}
        maxRatio={0.9}
        onResizeStart={onLayoutResizeStart}
        onResizeEnd={onLayoutResizeEnd}
        onResizeCancel={onLayoutResizeCancel}
      />
    </div>
  )
}
