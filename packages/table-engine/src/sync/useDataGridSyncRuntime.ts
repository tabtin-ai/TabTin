import { useCallback, useEffect, useRef, useState } from 'react'
import type { Field, TableRecord } from '@tabtin/table-core'
import type { CollabSyncMode } from '@tabtin/collab-core'
import type { IncrementalSyncSnapshot, WsGatewayLike, TableStreamEvent } from './types'
import { useIncrementalSync } from './useIncrementalSync'
import { useTableEventStream } from './useTableEventStream'
import { shouldConsumeTableRecordDelta } from './legacyDeltaPolicy'

const isDeleteAction = (action: string): boolean =>
  action === 'delete_record' || action === 'batch_delete_records'

const isCreateAction = (action: string): boolean =>
  action === 'create_record' || action === 'batch_create_records'

const isSnapshotRestoreAction = (action: string): boolean =>
  action === 'snapshot_restored'

const isReorderAction = (action: string): boolean =>
  action === 'reorder_records'

const isCollabStatusAction = (action: string): boolean =>
  action === 'collab.degraded' || action === 'collab.restored'

export interface FieldChangeInfo {
  action: string
  field_ids?: string[]
}

export interface UseDataGridSyncRuntimeInput {
  /** 返回 WS Gateway 实例（平台各自注入） */
  getGateway: () => WsGatewayLike
  selectedTableId: string | null
  currentViewId: string | null
  /** 是否使用 view data（带视图过滤/排序） */
  useViewData: boolean
  syncLatestVersion: number | null
  syncEtag: string | null
  recordsQuery?: Record<string, unknown>
  requestHeaders?: Record<string, string>
  tableEventTopicContext?: Record<string, unknown>
  fields: Field[]
  mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => void
  mergeIncrementalViewRecords: (
    records: TableRecord[],
    newVersion: number,
    snapshot?: IncrementalSyncSnapshot
  ) => void
  removeRecordsByIds: (recordIds: string[], newVersion?: number) => void
  removeViewRecordsByIds: (recordIds: string[], newVersion?: number) => void
  onFieldChange?: (info: FieldChangeInfo) => void
  onViewChange?: () => void
  /** 收到排序变更 WS 事件时调用（merge 只更新数据不重排数组，需外部全量刷新） */
  onRecordOrderChanged?: () => void
  /** 增量窗口内发生过物理删除时，丢弃本地快照并全量刷新。 */
  onFullReloadRequired?: () => void | Promise<void>
  /** 资源级同步模式；collab 模式下旧 record delta 不参与领域状态更新 */
  syncMode?: CollabSyncMode
  /** Y.js 协作在线时跳过旧 WS 事件流 */
  collabActive?: boolean
  /** Y.js provider 是否已同步/健康（仅在 collabActive 时有意义，缺省视为健康） */
  isCollabSynced?: () => boolean
  /** 返回当前 store 中的 recordIds（collabActive 时用于 delete 去重过滤） */
  getRecordIds?: () => string[]
  /** 后端 Y.Doc 推送进入降级状态时回调 */
  onCollabDegraded?: () => void
  /** 后端 Y.Doc 推送从降级恢复时回调（恢复后应增量拉取一次） */
  onCollabRestored?: () => void
}

const FALLBACK_INITIAL_MS = 5_000
const FALLBACK_MAX_MS = 30_000

export function useDataGridSyncRuntime({
  getGateway,
  selectedTableId,
  currentViewId,
  useViewData,
  syncLatestVersion,
  syncEtag,
  recordsQuery,
  requestHeaders,
  tableEventTopicContext,
  fields: _fields,
  mergeIncrementalRecords,
  mergeIncrementalViewRecords,
  removeRecordsByIds,
  removeViewRecordsByIds,
  onFieldChange,
  onViewChange,
  onRecordOrderChanged,
  onFullReloadRequired,
  syncMode,
  collabActive,
  isCollabSynced,
  getRecordIds,
  onCollabDegraded,
  onCollabRestored,
}: UseDataGridSyncRuntimeInput) {
  const mergeRecordsRef = useRef(mergeIncrementalRecords)
  mergeRecordsRef.current = mergeIncrementalRecords
  const mergeViewRecordsRef = useRef(mergeIncrementalViewRecords)
  mergeViewRecordsRef.current = mergeIncrementalViewRecords
  const onFieldChangeRef = useRef(onFieldChange)
  onFieldChangeRef.current = onFieldChange
  const onViewChangeRef = useRef(onViewChange)
  onViewChangeRef.current = onViewChange
  const onRecordOrderChangedRef = useRef(onRecordOrderChanged)
  onRecordOrderChangedRef.current = onRecordOrderChanged
  const getRecordIdsRef = useRef(getRecordIds)
  getRecordIdsRef.current = getRecordIds
  const onCollabDegradedRef = useRef(onCollabDegraded)
  onCollabDegradedRef.current = onCollabDegraded
  const onCollabRestoredRef = useRef(onCollabRestored)
  onCollabRestoredRef.current = onCollabRestored
  const isCollabSyncedRef = useRef(isCollabSynced)
  isCollabSyncedRef.current = isCollabSynced

  const [isCollabDegraded, setIsCollabDegraded] = useState(false)

  const isEffectiveCollabActive = useCallback(
    (): boolean => Boolean(
      collabActive
      && !isCollabDegraded
      && (!isCollabSyncedRef.current || isCollabSyncedRef.current())
    ),
    [collabActive, isCollabDegraded]
  )

  const onUpdateStable = useCallback(
    (records: TableRecord[], newVersion: number, snapshot?: IncrementalSyncSnapshot) => {
      const t0 = performance.now()
      mergeRecordsRef.current(records, newVersion)
      mergeViewRecordsRef.current(records, newVersion, snapshot)
      const elapsed = Math.round(performance.now() - t0)
      if (elapsed > 50) {
        console.warn(`[SyncRuntime] ⚠️ merge 耗时 ${elapsed}ms (${records.length} records, v${newVersion})`)
      }
    },
    []
  )

  const { triggerSync, startPolling } = useIncrementalSync({
    tableId: selectedTableId,
    viewId: useViewData ? currentViewId : undefined,
    latestVersion: syncLatestVersion,
    syncEtag,
    onUpdate: onUpdateStable,
    onFullReloadRequired,
    pollInterval: 3000,
    pollTimeout: 60000,
    mode: useViewData ? 'view' : 'table',
    viewQuery: recordsQuery,
    requestHeaders,
  })

  const handleTableEvent = useCallback(
    (event: TableStreamEvent) => {
      if (!selectedTableId) return
      const payload = event.data ?? {}
      const eventTableId = payload.table_id as string | undefined
      if (eventTableId && eventTableId !== selectedTableId) return

      if (event.event === 'table.events.field') {
        const action = (payload.action as string) ?? ''
        onFieldChangeRef.current?.({ action, field_ids: payload.field_ids as string[] | undefined })
        return
      }

      if (event.event === 'table.events.view') {
        onViewChangeRef.current?.()
        return
      }

      if (event.event !== 'table.events.delta') return

      const action = (payload.action as string) ?? ''

      if (syncLatestVersion == null) return

      if (isCollabStatusAction(action)) {
        if (action === 'collab.degraded') {
          setIsCollabDegraded(true)
          onCollabDegradedRef.current?.()
        } else {
          setIsCollabDegraded(false)
          onCollabRestoredRef.current?.()
          void triggerSync()
        }
        return
      }

      const inlineRecords = payload.records as TableRecord[] | undefined
      const inlineVersion = payload.latest_version as number | undefined
      const recordIds = payload.record_ids as string[] | undefined
      const metadata = payload.metadata as Record<string, unknown> | undefined

      if (isSnapshotRestoreAction(action)) {
        const restoredRecordIds = Array.isArray(recordIds) ? new Set(recordIds) : null
        const currentRecordIds = getRecordIdsRef.current?.() ?? []
        if (restoredRecordIds) {
          const staleRecordIds = currentRecordIds.filter(id => !restoredRecordIds.has(id))
          if (staleRecordIds.length > 0) {
            removeRecordsByIds(staleRecordIds, inlineVersion)
            removeViewRecordsByIds(staleRecordIds, inlineVersion)
          }
        }
        if (Array.isArray(inlineRecords) && inlineRecords.length > 0 && typeof inlineVersion === 'number') {
          mergeRecordsRef.current(inlineRecords, inlineVersion)
          if (!useViewData) {
            mergeViewRecordsRef.current(inlineRecords, inlineVersion, {
              total: typeof metadata?.total === 'number' ? metadata.total : inlineRecords.length,
            })
          }
        }
        onRecordOrderChangedRef.current?.()
        return
      }

      const effectiveSyncMode: CollabSyncMode = syncMode ?? (isEffectiveCollabActive() ? 'collab' : 'legacy')
      if (!shouldConsumeTableRecordDelta(effectiveSyncMode)) {
        return
      }

      if (isDeleteAction(action) && Array.isArray(recordIds) && recordIds.length > 0) {
        let idsToDelete = recordIds
        if (collabActive && getRecordIdsRef.current) {
          const currentIds = new Set(getRecordIdsRef.current())
          idsToDelete = recordIds.filter(id => currentIds.has(id))
          if (idsToDelete.length === 0) return
        }
        removeRecordsByIds(idsToDelete, inlineVersion)
        removeViewRecordsByIds(idsToDelete, inlineVersion)
        if (useViewData) {
          void triggerSync()
        }
        return
      }

      if (Array.isArray(inlineRecords) && inlineRecords.length > 0 && typeof inlineVersion === 'number') {
        mergeRecordsRef.current(inlineRecords, inlineVersion)
        if (useViewData && isCreateAction(action)) {
          // 新建/恢复在视图模式下交给 triggerSync 拉取带完整 metadata 的增量：
          // WS 内联 payload 不含 sub_records.tree_data，直接合并会让新（子）记录
          // 缺失父聚类信息而被当成根节点掉到列表末尾（子记录「先在父下、随后跳末尾」）。
          void triggerSync()
          return
        }
        mergeViewRecordsRef.current(inlineRecords, inlineVersion)
        if (isReorderAction(action)) {
          onRecordOrderChangedRef.current?.()
        }
        return
      }

      if (isReorderAction(action) && onRecordOrderChangedRef.current) {
        onRecordOrderChangedRef.current()
        return
      }

      void triggerSync()
    },
    [selectedTableId, syncLatestVersion, syncMode, collabActive, isEffectiveCollabActive, removeRecordsByIds, removeViewRecordsByIds, triggerSync, useViewData]
  )

  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current)
        reconnectTimerRef.current = null
      }
    }
  }, [])

  const handleReconnected = useCallback(() => {
    if (reconnectTimerRef.current) return
    const delay = 300 + Math.random() * 700
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null
      void triggerSync()
    }, delay)
  }, [triggerSync])

  const isPushEnabled = Boolean(selectedTableId)
  const { isConnected } = useTableEventStream({
    tableId: selectedTableId,
    getGateway,
    enabled: isPushEnabled,
    onEvent: handleTableEvent,
    onReconnected: handleReconnected,
    topicContext: tableEventTopicContext,
  })

  // WS 断连降级轮询：渐进式间隔 5s → 30s
  // collabActive 但 provider 不健康时也需要轮询
  const fallbackCountRef = useRef(0)
  useEffect(() => {
    if (!selectedTableId || syncLatestVersion == null || isConnected || isEffectiveCollabActive()) {
      fallbackCountRef.current = 0
      return
    }
    const interval = Math.min(FALLBACK_MAX_MS, FALLBACK_INITIAL_MS + fallbackCountRef.current * 5_000)
    const timer = window.setTimeout(() => {
      fallbackCountRef.current += 1
      void triggerSync()
    }, interval)
    return () => window.clearTimeout(timer)
  }, [selectedTableId, syncLatestVersion, isConnected, isEffectiveCollabActive, triggerSync])

  // SYNCING→SYNCED 转换补偿：collab provider 完成初始同步后拉取 SYNCING 期间遗漏的 WS 增量
  const collabSyncedNow = isCollabSynced?.() ?? true
  const prevCollabSyncedRef = useRef(collabSyncedNow)
  useEffect(() => {
    const prev = prevCollabSyncedRef.current
    prevCollabSyncedRef.current = collabSyncedNow
    if (!prev && collabSyncedNow && collabActive) {
      void triggerSync()
    }
  }, [collabSyncedNow, collabActive, triggerSync])

  // 页面可见性恢复时触发同步
  useEffect(() => {
    const handleVisibility = () => {
      if (!document.hidden && selectedTableId && syncLatestVersion != null) {
        void triggerSync()
      }
    }
    document.addEventListener('visibilitychange', handleVisibility)
    return () => document.removeEventListener('visibilitychange', handleVisibility)
  }, [selectedTableId, syncLatestVersion, triggerSync])

  // 切换 table 时重置降级状态
  useEffect(() => {
    setIsCollabDegraded(false)
  }, [selectedTableId])

  return { startPolling, isConnected, isCollabDegraded, triggerSync }
}
