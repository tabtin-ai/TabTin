import { useCallback, useEffect, useMemo } from 'react'
import {
  type Field,
  type TableRecord,
  type ViewMeta,
  type ViewRecordsQuery,
} from '@tabtin/table-core'
import {
  useDataGridSyncRuntime,
  type FieldChangeInfo,
} from '@tabtin/table-engine/sync'
import type { WsGatewayLike } from '@tabtin/table-engine/sync'
import type { CollabSyncMode } from '@tabtin/collab-core'

interface UseDataGridViewRuntimeInput {
  getGateway: () => WsGatewayLike
  views: ViewMeta[]
  currentViewId: string | null
  initializeDraft: (viewId: string) => void
  selectedTableId: string | null
  currentViewLatestVersion: number | null
  currentViewEtag: string | null
  latestVersion: number | null
  recordsEtag: string | null
  recordsQuery: ViewRecordsQuery
  requestHeaders?: Record<string, string>
  tableEventTopicContext?: Record<string, unknown>
  fields: Field[]
  mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => void
  mergeIncrementalViewRecords: (records: TableRecord[], newVersion: number) => void
  removeRecordsByIds: (recordIds: string[], newVersion?: number) => void
  removeViewRecordsByIds: (recordIds: string[], newVersion?: number) => void
  /** 收到字段结构变更 WS 事件时调用（刷新字段列表） */
  onFieldChange?: (info: FieldChangeInfo) => void
  /** 收到视图变更 WS 事件时调用（刷新视图数据） */
  onViewChange?: () => void
  /** 收到排序变更 WS 事件时调用（全量刷新以体现新顺序） */
  onRecordOrderChanged?: () => void
  /** 增量窗口内发生过物理删除时全量刷新。 */
  onFullReloadRequired?: () => void | Promise<void>
  /** 资源级同步模式；collab 模式下旧 record delta 不参与领域状态更新 */
  syncMode?: CollabSyncMode
  /** Y.js 协作是否在线（在线时禁用旧 WS 事件流） */
  collabActive?: boolean
  /** Y.js provider 是否已同步/健康（仅在 collabActive 时有意义，缺省视为健康） */
  isCollabSynced?: () => boolean
  /** 返回当前 store 中的 recordIds（collabActive 时用于 delete 去重过滤） */
  getRecordIds?: () => string[]
}

export const useDataGridViewRuntime = ({
  getGateway,
  views,
  currentViewId,
  initializeDraft,
  selectedTableId,
  currentViewLatestVersion,
  currentViewEtag,
  latestVersion,
  recordsEtag,
  recordsQuery,
  requestHeaders,
  tableEventTopicContext,
  fields,
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
}: UseDataGridViewRuntimeInput) => {
  const currentView = useMemo(
    () => views.find(view => view.id === currentViewId) ?? null,
    [views, currentViewId]
  )
  const useViewData = Boolean(currentView)

  const syncLatestVersion = useViewData
    ? currentViewLatestVersion
    : latestVersion
  const syncEtag = useViewData ? currentViewEtag : recordsEtag
  const { startPolling, isCollabDegraded, triggerSync } = useDataGridSyncRuntime({
    getGateway,
    selectedTableId,
    currentViewId,
    useViewData,
    syncLatestVersion,
    syncEtag,
    recordsQuery: recordsQuery as Record<string, unknown>,
    requestHeaders,
    tableEventTopicContext,
    fields,
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
  })

  // 历史遗留：on_change 自动触发字段（曾用于已下架的 TabData AI 字段）。
  // 当前没有任何字段类型走"输入变更后自动触发"语义，回调保留为空函数兼容上游编辑控制器调用。
  // 后续若有新的 on_change 自动字段类型，在此处实现匹配逻辑。
  const checkIfTriggersAutoField = useCallback((_fieldNameOrId: string): Field[] => [], [])

  useEffect(() => {
    if (currentViewId) {
      initializeDraft(currentViewId)
    }
  }, [currentViewId, initializeDraft])

  return {
    currentView,
    useViewData,
    startPolling,
    checkIfTriggersAutoField,
    isCollabDegraded,
    triggerSync,
  }
}
