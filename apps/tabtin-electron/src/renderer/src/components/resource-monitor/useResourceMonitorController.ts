import React from 'react'
import { toast } from '@tabtin/smartsheet-ui'
import { useTabDocRuntimeMonitorSnapshot } from '@components/context-space/tabdoc/tabdoc-runtime-monitor'
import { useTabDataRuntimeMonitorSnapshot } from '@components/table/table-runtime-monitor'
import { useSpaceStore } from '@stores/useSpaceStore'
import { useSpaceViewPrefsStore } from '@stores/useSpaceViewPrefsStore'
import { useAuthStore } from '@stores/useAuthStore'
import { useChatStore } from '@/stores/chat/useChatStore'
import { useChatRuntimeStore } from '@/stores/useChatRuntimeStore'
import { useCrawlTabStore } from '@stores/useCrawlTabStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import { contextRegistry } from '@components/context-space/registry'
import { resolveForegroundTabScopeKey } from '@components/chat/subagent/openSubagentTab'
import { resolveWorkspaceContextState } from '@components/layout/workspaceContextState'
import { captureTaskViewModeMorph } from '@components/chat/capsule/chatCapsuleMorph'
import { useCanvasLayoutStore } from '@stores/useCanvasLayoutStore'
import { useTerminalSessionStore } from '@components/context-space/sources/terminal'
import { invokeCloseContextTab } from '@components/context-space/tools/ContextSpaceToolHandler'
import { ensureSpaceSelectedWithFeedback } from '@/services/spaceNavigation'
import { useResourceMonitorSnapshot } from '@/hooks/useResourceMonitorSnapshot'
import {
  closeSettingsForResourceMonitorNavigation,
  resolveCrawlspaceIdForItem,
} from './navigationHelpers'
import {
  BROWSER_GOVERNANCE_BOUNDARY_NOTE,
  buildResourceMonitorViewModel,
  type ResourceMonitorSuggestion,
  type ResourceMonitorTabScope,
  type ResourceMonitorTabDataRuntimeView,
  type ResourceMonitorTabDocRuntimeView,
  type ResourceMonitorTrackedItem,
  type ResourceMonitorViewModel,
} from './model'
import {
  recordResourceMonitorGovernanceEvent,
  useResourceMonitorGovernanceHistory,
} from './history'
import type { ResourceMonitorGovernanceFeedbackItem } from './history'
import type { ResourceMonitorSeverityLevel } from './severity'
import {
  formatGovernanceFeedbackList,
  describeBrowserGovernanceReason,
} from './formatters'
import { closeResourceMonitorTabScopes } from './closeTabScopes'
import type { ResourceMonitorSnapshotMode } from '@shared/types/resource-monitor'

export interface ResourceMonitorController {
  viewModel: ResourceMonitorViewModel
  surfaceSeverityLevel: ResourceMonitorSeverityLevel
  isLoading: boolean
  isRefreshing: boolean
  error: string | null
  rankedSpaces: ReturnType<typeof buildResourceMonitorViewModel>['spaces']
  spaceNameById: Map<string, string>
  recentGovernanceEvents: ReturnType<typeof useResourceMonitorGovernanceHistory>
  onRefresh: () => void
  onNavigateToSpace: (spaceId: string) => void
  onNavigateToItem: (item: ResourceMonitorTrackedItem) => void
  onNavigateToDataRuntime: (data: ResourceMonitorTabDataRuntimeView) => void
  onNavigateToDocRuntime: (doc: ResourceMonitorTabDocRuntimeView) => void
  onCloseGovernanceItems: (items: ResourceMonitorTrackedItem[]) => void
  onSuggestionAction: (suggestion: ResourceMonitorSuggestion) => void
}

export function useResourceMonitorController(
  mode: ResourceMonitorSnapshotMode = 'interactive',
): ResourceMonitorController {
  const activeSpaceId = useSpaceStore((state) => state.selectedSpace?.id ?? null)
  const activeOrganizationId = useSpaceStore((state) => state.selectedSpace?.organization_id ?? null)
  const spaces = useSpaceStore((state) => state.spaces)
  const currentUserId = useAuthStore((state) => state.user?.id ?? null)
  const currentSessionId = useChatStore((state) => state.currentSessionId)
  const sessionsBySpaceId = useChatStore((state) => state.sessionsBySpaceId)
  const sessionScopes = React.useMemo(() => {
    const scopesBySessionId = new Map<string, { sessionId: string; spaceId: string }>()
    for (const [fallbackSpaceId, sessions] of Object.entries(sessionsBySpaceId)) {
      for (const session of sessions) {
        if (session.status === 'archived') continue
        scopesBySessionId.set(session.id, {
          sessionId: session.id,
          spaceId: session.space_id || fallbackSpaceId,
        })
      }
    }
    return [...scopesBySessionId.values()]
  }, [sessionsBySpaceId])
  const runProjectionBySessionId = useChatRuntimeStore((state) => state.runProjectionBySessionId)
  const busySessionIds = React.useMemo(() => new Set(
    Object.entries(runProjectionBySessionId)
      .filter(([, projection]) => projection.busy)
      .map(([sessionId]) => sessionId),
  ), [runProjectionBySessionId])
  const sidebarMode = useSpaceViewPrefsStore((state) => (
    state.getSidebarMode(activeOrganizationId, currentUserId, activeSpaceId)
  ))
  const crawlspaceConfigById = useCrawlTabStore((state) => state.crawlspaceConfigById)
  const crawlspaceContextCache = useCrawlTabStore((state) => state.crawlspaceContextCache)
  const tabOrderBySpace = useSpaceContextTabsStore((state) => state.tabOrderBySpace)
  const activeKeyBySpace = useSpaceContextTabsStore((state) => state.activeKeyBySpace)
  const spaceGroupsBySpace = useCanvasLayoutStore((state) => state.spaceGroups)
  const terminalSessionsBySpace = useTerminalSessionStore((state) => state.sessionsBySpace)
  const tabDataRuntimeSnapshot = useTabDataRuntimeMonitorSnapshot()
  const tabDocRuntimeSnapshot = useTabDocRuntimeMonitorSnapshot()
  const governanceHistory = useResourceMonitorGovernanceHistory()
  const { snapshot, history, isLoading, isRefreshing, error, refresh } = useResourceMonitorSnapshot(mode)
  const activeTabScopeKey = React.useMemo(() => {
    if (!activeSpaceId) return null
    return resolveWorkspaceContextState({
      workbenchMode: 'space',
      sidebarMode,
      organizationId: activeOrganizationId,
      userId: currentUserId,
      executionSpaceId: activeSpaceId,
      sessionId: currentSessionId,
    }).key
  }, [
    activeOrganizationId,
    activeSpaceId,
    currentSessionId,
    currentUserId,
    sidebarMode,
  ])
  const excludeActiveTabScope = React.useMemo(() => {
    if (!activeTabScopeKey?.startsWith('conversation:')) return false
    const activeSessionId = activeTabScopeKey.slice('conversation:'.length)
    return Object.values(sessionsBySpaceId).some((sessions) =>
      sessions.some((session) => session.id === activeSessionId && session.status === 'archived'),
    )
  }, [activeTabScopeKey, sessionsBySpaceId])

  const rawViewModel = React.useMemo(() => {
    return buildResourceMonitorViewModel({
      snapshot,
      history,
      dataRuntime: tabDataRuntimeSnapshot,
      docRuntime: tabDocRuntimeSnapshot,
      activeSpaceId,
      activeTabScopeKey,
      sessionScopes,
      excludeActiveTabScope,
      busySessionIds,
      spaces,
      crawlspaceConfigById,
      crawlspaceContextCache,
      tabOrderBySpace,
      activeKeyBySpace,
      spaceGroupsBySpace,
      terminalSessionsBySpace,
    })
  }, [
    snapshot,
    history,
    tabDataRuntimeSnapshot,
    tabDocRuntimeSnapshot,
    activeSpaceId,
    activeTabScopeKey,
    sessionScopes,
    excludeActiveTabScope,
    busySessionIds,
    spaces,
    crawlspaceConfigById,
    crawlspaceContextCache,
    tabOrderBySpace,
    activeKeyBySpace,
    spaceGroupsBySpace,
    terminalSessionsBySpace,
  ])

  const viewModel = React.useDeferredValue(rawViewModel)
  const surfaceSeverityLevel: ResourceMonitorSeverityLevel =
    viewModel.history.stale && viewModel.overview.severity.level === 'healthy'
      ? 'attention'
      : viewModel.overview.severity.level

  const spaceNameById = React.useMemo(() => {
    return new Map(viewModel.spaces.map((space) => [space.spaceId, space.spaceName]))
  }, [viewModel.spaces])

  const rankedSpaces = React.useMemo(() => {
    if (!viewModel.currentSpace) return viewModel.spaces
    const rest = viewModel.spaces.filter((space) => space.spaceId !== viewModel.currentSpace?.spaceId)
    return rest.length > 0 ? rest : [viewModel.currentSpace]
  }, [viewModel.currentSpace, viewModel.spaces])

  const recentGovernanceEvents = React.useMemo(() => {
    return governanceHistory.slice(-3).reverse()
  }, [governanceHistory])

  const handleRefresh = React.useCallback(async () => {
    await refresh()
  }, [refresh])

  const navigateToSpace = React.useCallback(async (spaceId: string) => {
    const success = await ensureSpaceSelectedWithFeedback(spaceId, {
      failureToast: { title: '未找到对应的 Space', variant: 'destructive' },
    })
    if (!success) return
    closeSettingsForResourceMonitorNavigation()
  }, [])

  const navigateToItem = React.useCallback(async (item: ResourceMonitorTrackedItem) => {
    if (!item.spaceId) return
    const success = await ensureSpaceSelectedWithFeedback(item.spaceId, {
      failureToast: { title: '未找到对应的 Space', variant: 'destructive' },
    })
    if (!success) return
    closeSettingsForResourceMonitorNavigation()
    const tabKey = `${item.contextType}:${item.id}` as `${string}:${string}`
    const crawlspaceId = resolveCrawlspaceIdForItem(item)
    const dispatched = contextRegistry.dispatchSelect(
      { type: item.contextType, id: item.id, tabKey, title: item.title, meta: { fromResourceMonitor: true } },
      { spaceId: item.spaceId, crawlspaceId, closeBrowserView: () => {} },
    )
    if (!dispatched) {
      // 已 ensureSpaceSelected 到 item.spaceId，标签写入该 Space 当前前台 scope 桶。
      useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(item.spaceId), {
        type: item.contextType,
        id: item.id,
        title: item.title,
        meta: { fromResourceMonitor: true },
      })
    }
  }, [])

  const navigateToDataRuntime = React.useCallback(async (data: ResourceMonitorTabDataRuntimeView) => {
    if (!data.spaceId || !data.tableId) return
    const success = await ensureSpaceSelectedWithFeedback(data.spaceId, {
      failureToast: { title: '未找到对应的 Space', variant: 'destructive' },
    })
    if (!success) return
    closeSettingsForResourceMonitorNavigation()
    useSpaceContextTabsStore.getState().openTableTab(resolveForegroundTabScopeKey(data.spaceId), data.tableId, true)
  }, [])

  const navigateToDocRuntime = React.useCallback(async (doc: ResourceMonitorTabDocRuntimeView) => {
    if (!doc.spaceId || !doc.documentId) return
    const success = await ensureSpaceSelectedWithFeedback(doc.spaceId, {
      failureToast: { title: '未找到对应的 Space', variant: 'destructive' },
    })
    if (!success) return
    closeSettingsForResourceMonitorNavigation()
    useSpaceContextTabsStore.getState().openResourceTab(resolveForegroundTabScopeKey(doc.spaceId), {
      type: 'tabdoc',
      id: doc.documentId,
      title: doc.title,
      meta: { fromResourceMonitor: true },
    })
  }, [])

  const closeGovernanceItems = React.useCallback(async (items: ResourceMonitorTrackedItem[]) => {
    const queue = items.filter(
      (item, index, all) => all.findIndex((candidate) => candidate.tabKey === item.tabKey) === index,
    )
    if (queue.length === 0) return
    const succeeded: ResourceMonitorGovernanceFeedbackItem[] = []
    const failed: ResourceMonitorGovernanceFeedbackItem[] = []
    for (const item of queue) {
      try {
        const result = await invokeCloseContextTab({
          spaceId: item.spaceId,
          crawlspaceId: item.crawlspaceId,
          tabKey: item.tabKey,
        })
        if (result.success) {
          succeeded.push({ title: item.title, reason: describeBrowserGovernanceReason(item) })
        } else {
          failed.push({
            title: item.title,
            reason: describeBrowserGovernanceReason(item),
            error: result.error ?? null,
          })
        }
      } catch (closeError) {
        failed.push({
          title: item.title,
          reason: describeBrowserGovernanceReason(item),
          error: closeError instanceof Error ? closeError.message : '未知错误',
        })
      }
    }
    recordResourceMonitorGovernanceEvent({
      kind: 'browser-close',
      at: Date.now(),
      attemptedCount: queue.length,
      succeeded,
      failed,
    })
    if (succeeded.length > 0 && failed.length === 0) {
      toast({
        title: queue.length === 1 ? `已回收 ${queue[0]?.title}` : `已回收 ${succeeded.length} 个空闲 Browser`,
        description: `${formatGovernanceFeedbackList(succeeded)}。${BROWSER_GOVERNANCE_BOUNDARY_NOTE}`,
        variant: 'success',
      })
      await handleRefresh()
      return
    }
    if (succeeded.length > 0) {
      toast({
        title: `已回收 ${succeeded.length} 个 Browser，${failed.length} 个未完成`,
        description: [
          succeeded.length > 0 ? `成功：${formatGovernanceFeedbackList(succeeded)}` : null,
          failed.length > 0 ? `未完成：${formatGovernanceFeedbackList(failed, { includeError: true })}` : null,
          BROWSER_GOVERNANCE_BOUNDARY_NOTE,
        ]
          .filter(Boolean)
          .join('；'),
      })
      await handleRefresh()
      return
    }
    toast({
      title: '未能回收空闲 Browser',
      description:
        failed.length > 0
          ? `${formatGovernanceFeedbackList(failed, { includeError: true })}。${BROWSER_GOVERNANCE_BOUNDARY_NOTE}`
          : '关闭资源失败',
      variant: 'destructive',
    })
  }, [handleRefresh])

  const closeContextTabs = React.useCallback(async (target: { scopes: ResourceMonitorTabScope[] }) => {
    const { succeeded, failed, fullyClosedScopeKeys } = await closeResourceMonitorTabScopes(
      target.scopes,
      invokeCloseContextTab,
    )
    const viewPrefs = useSpaceViewPrefsStore.getState()
    for (const scopeKey of fullyClosedScopeKeys) {
      if (scopeKey === activeTabScopeKey) {
        captureTaskViewModeMorph(viewPrefs.getTaskViewMode(scopeKey), 'chat-focus')
      }
      viewPrefs.setTaskViewModeForScope(scopeKey, 'chat-focus')
    }

    if (succeeded > 0) {
      toast({
        title: `已关闭 ${succeeded} 个标签`,
        description: failed > 0
          ? `${failed} 个标签因不可关闭、未保存确认或资源清理失败而保留。`
          : '所有未归档会话的标签已全部关闭。',
        variant: failed > 0 ? 'default' : 'success',
      })
      await handleRefresh()
      return
    }

    toast({
      title: '没有关闭任何标签',
      description: '这些标签当前不可关闭，或仍需要完成保存确认。',
      variant: 'destructive',
    })
  }, [activeTabScopeKey, handleRefresh])

  const handleSuggestionAction = React.useCallback(
    async (suggestion: ResourceMonitorSuggestion) => {
      switch (suggestion.target.kind) {
        case 'refresh':
          await handleRefresh()
          return
        case 'space':
          await navigateToSpace(suggestion.target.spaceId)
          return
        case 'item':
          await navigateToItem(suggestion.target.item)
          return
        case 'close-item':
          await closeGovernanceItems([suggestion.target.item])
          return
        case 'close-items':
          await closeGovernanceItems(suggestion.target.items)
          return
        case 'close-tabs':
          await closeContextTabs(suggestion.target)
          return
        case 'tabdata-runtime':
          await navigateToDataRuntime(suggestion.target.data)
          return
        case 'tabdoc-runtime':
          await navigateToDocRuntime(suggestion.target.doc)
          return
        default:
          return
      }
    },
    [
      closeGovernanceItems,
      closeContextTabs,
      handleRefresh,
      navigateToDataRuntime,
      navigateToDocRuntime,
      navigateToItem,
      navigateToSpace,
    ],
  )

  return {
    viewModel,
    surfaceSeverityLevel,
    isLoading,
    isRefreshing,
    error,
    rankedSpaces,
    spaceNameById,
    recentGovernanceEvents,
    onRefresh: () => void handleRefresh(),
    onNavigateToSpace: (spaceId) => void navigateToSpace(spaceId),
    onNavigateToItem: (item) => void navigateToItem(item),
    onNavigateToDataRuntime: (data) => void navigateToDataRuntime(data),
    onNavigateToDocRuntime: (doc) => void navigateToDocRuntime(doc),
    onCloseGovernanceItems: (items) => void closeGovernanceItems(items),
    onSuggestionAction: (suggestion) => void handleSuggestionAction(suggestion),
  }
}
