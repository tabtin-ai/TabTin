import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { toast } from '@tabtin/smartsheet-ui/toast'
import { ViewContainer } from '@components/view/ViewContainer'
import { TablePaneHeader } from '@components/table/TablePaneHeader'
import { AlertTriangle } from 'lucide-react'
import {
  TableCollabProvider,
  useTableCollab,
} from '@components/table/TableCollabContext'
import { TableReadonlyProvider } from '@components/table/TableReadonlyContext'
import { TabErrorFallback } from '@components/context-space/TabErrorFallback'
import {
  TableStoreProvider,
  tableStore,
  useTableStore,
} from '@stores/useTableStore'
import { useSpaceContextTabsStore } from '@stores/useSpaceContextTabsStore'
import {
  useTableAppearanceStore,
  applyTableFontSettings,
} from '@stores/useTableAppearanceStore'
import { useContextTabScopeKey, useIsContextTabActive } from '@/hooks/useIsContextTabActive'
import { ViewStoreProvider, useViewStore } from '@stores/useViewStore'
import { RecordStoreProvider } from '@stores/useRecordStore'
import { useStore } from 'zustand'
import { useTranslation } from 'react-i18next'
import {
  useTableInitFlow,
  TableLoadingView,
} from '@tabtin/table-ui'
import {
  RemovedFromResourceOverlay,
  useResourceShareDowngrade,
  isPermissionInsufficientForEditing,
  shouldShowRemovedOverlay,
  selectResourceShareNotifications,
} from '@tabtin/smartsheet-ui'
import { useNotificationStore } from '@stores/useNotificationStore'
import { onResourceEvent } from '@/stores/useUnifiedResources'
import {
  getOrCreateRecordStore,
  getOrCreateTableStore,
  getOrCreateViewStore,
  retainStoreForTable,
  releaseStoreForTable,
  createEmbeddedTableStorePool,
} from './tableStorePool'
import { setItemMetaGuarded } from '@components/context-space/restore/openResourceMembershipGuard'
import {
  TABDATA_RESOURCE_TYPE,
  applyTableMetaPatchToState,
  buildTabDataTablePatchFromResourceEvent,
} from './tabdataResourceEventPatch'
import { resolveTableParentDocumentId } from './tablePaneAccessContext'
import { resolveTablePaneLoadFailure } from './tablePaneLoadFailure'
import { usePermissionDeniedAccessRequest } from '@components/context-space/usePermissionDeniedAccessRequest'

interface TablePaneInnerProps {
  tableId: string
  parentDocumentId?: string | null
}

const TableCollabAccessBanner: React.FC = () => {
  const { t } = useTranslation('table')
  const { collabBridge } = useTableCollab()
  const reason = collabBridge.collab.syncModeReason
  if (reason !== 'permission_denied' && reason !== 'access_verification_unavailable') {
    return null
  }

  const unavailable = reason === 'access_verification_unavailable'

  return (
    <div className={unavailable
      ? 'flex shrink-0 items-center justify-center gap-2 border-b border-warning/30 bg-warning/10 px-3 py-1.5 text-body font-medium text-warning'
      : 'flex shrink-0 items-center justify-center gap-2 border-b border-destructive/30 bg-destructive/10 px-3 py-1.5 text-body font-medium text-destructive'}>
      <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
      <span>{unavailable
        ? t('collab.accessVerificationUnavailable')
        : t('collab.permissionDenied')}</span>
    </div>
  )
}

const LAST_VIEW_ID_STORAGE_PREFIX = 'tabtin.table.lastViewId.'

const readLastViewId = (tableId: string, tabKey: string, tabScopeKey?: string | null): string => {
  const scopeKey =
    tabScopeKey ?? useSpaceContextTabsStore.getState().findSpaceByTabKey(tabKey)
  const item = scopeKey
    ? useSpaceContextTabsStore.getState().itemsBySpace[scopeKey]?.[tabKey]
    : null
  const tabViewId = typeof item?.meta?.viewId === 'string' ? item.meta.viewId : ''
  if (tabViewId) return tabViewId

  try {
    return window.localStorage.getItem(`${LAST_VIEW_ID_STORAGE_PREFIX}${tableId}`) ?? ''
  } catch {
    return ''
  }
}

const writeLastViewId = (
  tableId: string,
  tabKey: string,
  tabScopeKey: string,
  viewId: string,
) => {
  try {
    window.localStorage.setItem(`${LAST_VIEW_ID_STORAGE_PREFIX}${tableId}`, viewId)
  } catch {
    // localStorage can be unavailable in restricted renderer contexts; tab meta still preserves this session.
  }

  // ：setItemMeta 会触发 restore 重算；续期 membership pending，避免索引瞬时缺失时打回多维表首页
  setItemMetaGuarded(tabScopeKey, tabKey, 'tabdata', { viewId })
}

const TablePaneInner: React.FC<TablePaneInnerProps> = ({
  tableId,
  parentDocumentId = null,
}) => {
  const { t } = useTranslation('table')

  const globalTables = useStore(tableStore, state => state.tables)
  const getGlobalTable = useStore(tableStore, state => state.getTable)
  const contextualTables = useTableStore(state => state.tables)
  const getContextualTable = useTableStore(state => state.getTable)
  const globalTableLoadError = useStore(
    tableStore,
    state => state.tableDetailLoadErrors[tableId],
  )
  const contextualTableLoadError = useTableStore(
    state => state.tableDetailLoadErrors[tableId],
  )
  const selectTable = useTableStore(state => state.selectTable)
  const selectedTable = useTableStore(state => state.selectedTable)
  const initializeView = useViewStore(state => state.initialize)
  const viewTableId = useViewStore(state => state.tableId)
  const currentViewId = useViewStore(state => state.currentViewId)
  const viewLoading = useViewStore(state => state.isLoading)

  const tabKey = `tabdata:${tableId}`
  const tabScopeKey = useContextTabScopeKey(tabKey)
  const isActive = useIsContextTabActive(tabKey)

  // 字体外观按 tableId 独立：只有 active tab 把本表的那套写到根级
  // --table-font-* CSS 变量（CanvasGridAdapter 通过 MutationObserver 消费）。
  // 切表 / 改本表风格时重应用；非 active tab 不写 root，避免互相覆盖串库。
  const tableAppearanceEntry = useTableAppearanceStore(state => state.byTable[tableId])
  const defaultAppearance = useTableAppearanceStore(state => state.defaultAppearance)
  useLayoutEffect(() => {
    if (!isActive) return
    applyTableFontSettings(tableAppearanceEntry ?? defaultAppearance)
  }, [isActive, tableAppearanceEntry, defaultAppearance])

  // 用户最后选中哪个视图，下次打开同一张表就恢复哪个视图。
  // tab meta 覆盖当前会话，localStorage 覆盖关 tab 后再次打开。
  const lastViewIdRef = useRef<string | null>(null)
  const lastViewTableIdRef = useRef<string | null>(null)
  if (lastViewTableIdRef.current !== tableId) {
    lastViewTableIdRef.current = tableId
    lastViewIdRef.current = readLastViewId(tableId, tabKey, tabScopeKey)
  }

  const initializeViewWithFallback = useMemo(() => {
    return (id: string, options?: { defaultViewId?: string }) => {
      const persisted = lastViewIdRef.current || ''
      const defaultViewId = persisted || options?.defaultViewId
      return initializeView(id, defaultViewId ? { defaultViewId } : undefined)
    }
  }, [initializeView])

  const {
    displayTable,
    fetchFailed,
    showPaneLoading,
    loadingTimedOut,
    handleForceRetry,
  } = useTableInitFlow({
    tableId,
    globalTables: parentDocumentId ? contextualTables : globalTables,
    getGlobalTable: parentDocumentId ? getContextualTable : getGlobalTable,
    selectTable,
    selectedTable,
    initializeView: initializeViewWithFallback,
    viewTableId,
    currentViewId,
    viewLoading,
    isActive,
  })
  const tableLoadError = parentDocumentId
    ? contextualTableLoadError
    : globalTableLoadError
  const loadFailure = resolveTablePaneLoadFailure({
    fetchFailed,
    hasDisplayTable: Boolean(displayTable),
    errorCode: tableLoadError?.code,
    errorStatus: tableLoadError?.status,
  })
  const [accessRevoked, setAccessRevoked] = useState(false)

  useEffect(() => {
    setAccessRevoked(false)
  }, [tableId])

  // 共享表格打开时 tab item 先带列表里的标题；真实详情到达后以 table.name 为准回写。
  // 用 silent=true 避免后台持久 tab 刷新标题时抢焦点。
  useEffect(() => {
    if (!displayTable?.name) return
    const store = useSpaceContextTabsStore.getState()
    const hostSpaceId = tabScopeKey ?? store.findSpaceByTabKey(tabKey)
    if (!hostSpaceId) return
    const item = store.itemsBySpace[hostSpaceId]?.[tabKey]
    if (!item || item.title === displayTable.name) return
    store.openResourceTab(hostSpaceId, {
      type: 'tabdata',
      id: tableId,
      title: displayTable.name,
      meta: item.meta,
      silent: true,
    })
  }, [displayTable?.name, tabKey, tabScopeKey, tableId])

  // Agent / 远端改名：WS 已 sync 页签标题，但表头读 per-tab selectedTable，需对称 patch（对齐 TabDoc）。
  // 不按 spaceId 过滤：org 级表 / 跨 Space 打开时 event.space_id 未必等于页签宿主。
  useEffect(() => {
    return onResourceEvent(TABDATA_RESOURCE_TYPE, (event) => {
      if (event.resource_id !== tableId) return
      if (event.type === 'resource_access_revoked') {
        setAccessRevoked(true)
        return
      }
      if (event.type === 'resource_access_granted') {
        setAccessRevoked(false)
        handleForceRetry()
        return
      }
      const perTabStore = getOrCreateTableStore(tableId)
      const perTabSelected = perTabStore.getState().selectedTable
      const globalState = tableStore.getState()
      const current =
        perTabSelected?.id === tableId
          ? perTabSelected
          : globalState.tables.find((table) => table.id === tableId)
            ?? (globalState.selectedTable?.id === tableId ? globalState.selectedTable : null)
      const patch = buildTabDataTablePatchFromResourceEvent(event, current)
      if (!patch) return
      perTabStore.setState((state) => applyTableMetaPatchToState(state, tableId, patch))
      tableStore.setState((state) => applyTableMetaPatchToState(state, tableId, patch))
    })
  }, [handleForceRetry, tableId])

  // 订阅 currentViewId 变化，写回 tab item.meta.viewId
  // 仅当 ViewStore 真正绑定到本表（viewTableId === tableId）且有 currentViewId 时写回，
  // 避免在表初始化中途的瞬时空状态把持久化 viewId 抹掉。
  // debounce 100ms 防止抖动；cleanup 时 flush，避免用户切完视图立刻关 tab 时丢失。
  useEffect(() => {
    if (!tabScopeKey) return
    if (viewTableId !== tableId) return
    if (!currentViewId) return
    if (lastViewIdRef.current === currentViewId) return
    const targetViewId = currentViewId
    const persistViewId = () => {
      if (lastViewIdRef.current === targetViewId) return
      lastViewIdRef.current = targetViewId
      writeLastViewId(tableId, tabKey, tabScopeKey, targetViewId)
    }
    const timer = setTimeout(persistViewId, 100)
    return () => {
      clearTimeout(timer)
      persistViewId()
    }
  }, [tabScopeKey, tabKey, tableId, viewTableId, currentViewId])

  const handleCloseTab = useCallback(() => {
    const tabKey = `tabdata:${tableId}`
    const store = useSpaceContextTabsStore.getState()
    const spaceId = tabScopeKey ?? store.findSpaceByTabKey(tabKey)
    if (spaceId) {
      if (store.closeExplicitTab) store.closeExplicitTab(spaceId, tabKey)
      else store.closeTab(spaceId, tabKey)
    }
  }, [tableId, tabScopeKey])
  const storedTableTitle = useSpaceContextTabsStore((state) => {
    const tabKey = `tabdata:${tableId}`
    const scopeKey = tabScopeKey ?? state.findSpaceByTabKey(tabKey)
    return scopeKey ? state.itemsBySpace[scopeKey]?.[tabKey]?.title || '' : ''
  })

  // Wave 4 F6 (PRD §五块 2.3 末段):订阅 NotificationStore,实时降级响应。
  //  - resource_shared + action='removed'/'auto_removed' + 命中当前 tableId → 显示遮罩
  //  - resource_shared + action='permission_changed' + 新权限 < editor → toast 提示只读
  // 注:DataGrid 的实际 readonly 由后端权限校验落到具体操作上(record/field 写 API 会拒);
  // 这里仅做 UI 提示与遮罩,不直接改表格组件内部 state。
  // 订阅整个 notifications(store 内引用稳定),外层 useMemo 派生 — 避免 selector 每次返回新数组
  // 触发 zustand v5 + React useSyncExternalStore 的 "getSnapshot should be cached" 无限循环。
  const allNotifications = useNotificationStore((s) => s.notifications)
  const resourceNotifications = useMemo(
    () => selectResourceShareNotifications(allNotifications, 'table', tableId),
    [allNotifications, tableId],
  )
  const downgrade = useResourceShareDowngrade('table', tableId, resourceNotifications)
  const downgradeInsufficient = isPermissionInsufficientForEditing(downgrade.changedPermission)
  // ：仅当 role 在 removed 通知之后重新拉取确认 viewer+ 时，才压住历史遮罩
  const tableRole = selectedTable?.current_user_role
  const [roleFetchedAtMs, setRoleFetchedAtMs] = useState(0)
  useEffect(() => {
    if (tableId && tableRole) {
      setRoleFetchedAtMs(Date.now())
    }
  }, [tableId, tableRole])
  const showRemovedOverlay = shouldShowRemovedOverlay({
    isRemoved: downgrade.isRemoved,
    role: tableRole,
    removedAt: downgrade.sourceCreatedAt,
    roleFetchedAtMs,
  })
  const accessRequest = usePermissionDeniedAccessRequest({
    resourceType: 'table',
    resourceId: tableId,
  })
  const canRequestRemovedResourceAccess = downgrade.removalAction !== 'auto_removed'

  const lastToastedNotifIdRef = useRef<string | null>(null)
  useEffect(() => {
    if (!downgradeInsufficient || !downgrade.sourceNotificationId) return
    if (lastToastedNotifIdRef.current === downgrade.sourceNotificationId) return
    lastToastedNotifIdRef.current = downgrade.sourceNotificationId
    const permLabel = downgrade.changedPermission
      ? t(`share.permission.${downgrade.changedPermission}Label`, {
          ns: 'common',
          defaultValue: downgrade.changedPermission,
        })
      : ''
    toast({
      title: t('share.editor.permissionChanged.toast', {
        ns: 'common',
        permission: permLabel,
        defaultValue: `你的权限已变更为 ${permLabel},编辑器已切换为只读`,
      }) as string,
    })
  }, [downgradeInsufficient, downgrade.sourceNotificationId, downgrade.changedPermission, t])

  if (accessRevoked || showRemovedOverlay) {
    return (
      <div className="relative h-full">
        <RemovedFromResourceOverlay
          resourceTitle={downgrade.resourceTitle || displayTable?.name || ''}
          action={downgrade.removalAction || 'removed'}
          onReturn={handleCloseTab}
          onRequestView={canRequestRemovedResourceAccess ? accessRequest.requestViewAccess : undefined}
          onRequestEdit={canRequestRemovedResourceAccess ? accessRequest.requestEditAccess : undefined}
          requestingRole={accessRequest.requestingRole}
          requestedRole={accessRequest.requestedRole}
          t={(key, opts) => t(key, { ns: 'common', ...opts }) as string}
        />
      </div>
    )
  }

  if (loadFailure === 'permission_denied') {
    return (
      <div className="relative h-full">
        <RemovedFromResourceOverlay
          resourceTitle={downgrade.resourceTitle || storedTableTitle || displayTable?.name || ''}
          action={downgrade.removalAction || 'removed'}
          onReturn={handleCloseTab}
          onRequestView={canRequestRemovedResourceAccess ? accessRequest.requestViewAccess : undefined}
          onRequestEdit={canRequestRemovedResourceAccess ? accessRequest.requestEditAccess : undefined}
          requestingRole={accessRequest.requestingRole}
          requestedRole={accessRequest.requestedRole}
          t={(key, opts) => t(key, { ns: 'common', ...opts }) as string}
        />
      </div>
    )
  }

  if (loadFailure === 'resource_unavailable') {
    return (
      <div className="relative h-full">
        <RemovedFromResourceOverlay
          resourceTitle={storedTableTitle || displayTable?.name || ''}
          action="unavailable"
          onReturn={handleCloseTab}
          t={(key, opts) => t(key, { ns: 'common', ...opts }) as string}
        />
      </div>
    )
  }

  if (loadFailure === 'access_verification_unavailable' || loadFailure === 'generic') {
    const accessVerificationUnavailable = loadFailure === 'access_verification_unavailable'
    return (
      <TabErrorFallback
        title={accessVerificationUnavailable
          ? t('pane.accessVerificationUnavailableTitle', {
              defaultValue: '暂时无法验证权限',
            })
          : undefined}
        description={accessVerificationUnavailable
          ? t('pane.accessVerificationUnavailableDescription', {
              defaultValue: '暂时无法确认父文档与表格的访问关系，请稍后重试。',
            })
          : undefined}
        onRetry={handleForceRetry}
        onClose={handleCloseTab}
      />
    )
  }

  if (showPaneLoading) {
    return (
      <TableLoadingView
        message={t('pane.loading')}
        timedOut={loadingTimedOut}
        timeoutMessage={t('pane.loadingTooLong')}
        retryLabel={t('pane.retry')}
        onRetry={handleForceRetry}
      />
    )
  }

  return (
    <TableCollabProvider parentDocumentId={parentDocumentId}>
      <TableReadonlyProvider tableId={tableId}>
        <div className="relative flex h-full flex-col overflow-hidden">
          {displayTable && <TablePaneHeader table={displayTable} />}
          {displayTable && <TableCollabAccessBanner />}
          <div className="flex-1 overflow-hidden">
            {displayTable ? (
              <ViewContainer className="h-full" withProviders={false} />
            ) : (
              <div className="h-full w-full flex items-center justify-center text-body text-muted-foreground">
                {t('pane.notReady')}
              </div>
            )}
          </div>

        </div>
      </TableReadonlyProvider>
    </TableCollabProvider>
  )
}

export interface TablePaneViewProps {
  tableId: string
}

export const TablePaneView: React.FC<TablePaneViewProps> = ({ tableId }) => {
  const parentDocumentId = useSpaceContextTabsStore(
    state => resolveTableParentDocumentId(state, tableId),
  )
  const embeddedPool = useMemo(
    () => parentDocumentId ? createEmbeddedTableStorePool(parentDocumentId) : null,
    [parentDocumentId],
  )
  const tableStore = embeddedPool
    ? embeddedPool.getOrCreateTableStore(tableId)
    : getOrCreateTableStore(tableId)
  const viewStore = embeddedPool
    ? embeddedPool.getOrCreateViewStore(tableId)
    : getOrCreateViewStore(tableId)
  const recordStore = embeddedPool
    ? embeddedPool.getOrCreateRecordStore(tableId, viewStore)
    : getOrCreateRecordStore(tableId, viewStore)

  useEffect(() => {
    if (embeddedPool) {
      embeddedPool.retainStoreForTable(tableId)
      return () => embeddedPool.releaseStoreForTable(tableId)
    }
    retainStoreForTable(tableId)
    return () => releaseStoreForTable(tableId)
  }, [embeddedPool, tableId])

  return (
    <TableStoreProvider store={tableStore}>
      <ViewStoreProvider store={viewStore}>
        <RecordStoreProvider store={recordStore}>
          <TablePaneInner
            tableId={tableId}
            parentDocumentId={parentDocumentId}
          />
        </RecordStoreProvider>
      </ViewStoreProvider>
    </TableStoreProvider>
  )
}

TablePaneView.displayName = 'TablePaneView'
