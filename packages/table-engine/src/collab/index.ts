export { YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_ROW_ORDER_MAP, YDOC_VIEWS, YDOC_VIEW_ORDER_MAP, YDOC_META } from './ydoc-schema'
export { findFieldMetaIndex, orderFieldsMeta, type FieldMetaOrderLike } from './field-meta-order'
export { getOrderedIds, setOrderedIds, syncArrayToMap, moveRowInOrder, moveRowsInOrder } from './y-utils'

export {
  allocateRecordPositions,
  compareRecordPositions,
  effectiveRecordPosition,
  legacyToPositionId,
  isValidRecordPositionId,
  parseRecordPositionKey,
  projectLegacyPosition,
  MAX_RECORD_POSITION_KEY_LENGTH,
  RECORD_POSITION_FIELD,
  RECORD_POSITION_VERSION_PREFIX,
  type PositionableRecord,
  type RecordPositionAllocation,
  type RecordPositionPlan,
} from './record-position'

export {
  applyTableRecordOrderPlan,
  findReorderedRecordIds,
  getEffectiveTableRecordOrder,
  insertTableRecordAtomically,
  LEGACY_RECORD_ORDER_FIELD,
  planTableRecordInsert,
  planTableRecordOrderReconcile,
  readPositionableTableRecords,
  reorderTableRecordsAtomically,
  type TableRecordInsertInput,
  type TableRecordInsertResult,
  type TableRecordOrderContext,
} from './table-record-order'

export {
  useTableCollaboration,
  replayPendingTableWrites,
  rowOrderHas,
  COLLAB_ORIGIN_LOCAL,
  COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE,
  COLLAB_ORIGIN_MIRROR,
  selectUnseenDiscardedRecordUpdates,
  type UseTableCollaborationInput,
  type UseTableCollaborationResult,
  type CellChange,
  type PendingTableWrite,
  type DiscardedRecordUpdateNotice,
} from './useTableCollaboration'

export {
  buildTableCollabConnectionParameters,
  isRestProjectionAccess,
  parseTableCollabAccessPayload,
  resolveTableCollabDeniedReason,
  COLLAB_ACCESS_VERIFICATION_UNAVAILABLE,
  COLLAB_PERMISSION_DENIED,
  FIELD_VISIBILITY_RESTRICTED,
  COLLAB_MODE_REST_PROJECTION,
  PARENT_DOCUMENT_PARAMETER,
  type TableCollabAccessDecision,
  type TableCollabMode,
} from './collabAccess'

export {
  useDataGridCollabBridge,
  type UseDataGridCollabBridgeInput,
  type UseDataGridCollabBridgeResult,
} from './useDataGridCollabBridge'

export {
  clearCreateLifecycle,
  clearCreateLifecycles,
  isDeletingCollabCreate,
  isPendingCollabCreate,
  markCreateDeleting,
  markCreatePending,
  markCreatePersisted,
  markCreatesPersisted,
  partitionDeleteRecordIds,
  promoteStalePendingCreates,
  resolveRestSafeRecordId,
  type CollabCreateLifecycleEntry,
  type CollabCreateLifecycleState,
  type PartitionDeleteRecordIdsResult,
} from './collabRecordLifecycle'

export {
  applyViewUpdatePayload,
  buildCollabViewRecords,
  buildSortedCollabViewRecords,
  mergeViewsLifecycleIntoYDoc,
  resolveCollabViewUpdateBase,
  COLLAB_PENDING_VIEW_CREATED_AT,
  COLLAB_PENDING_VIEW_TTL_MS,
  type BuildCollabViewRecordsInput,
  type CollabViewFieldMeta,
  type MergeViewsLifecycleResult,
} from './collabViewRuntime'

export {
  buildKanbanViewRecords,
  KANBAN_DEFAULT_PER_GROUP_LIMIT,
  KANBAN_UNGROUPED_OFFSET_KEY,
  getKanbanOffsetKey,
  type BuildKanbanViewRecordsInput,
  type KanbanGroupRecord,
} from './kanban-view-runtime'

export {
  buildCalendarViewRecords,
  CALENDAR_MAX_OCCURRENCE_SPAN_DAYS,
  parseIsoDate,
  type BuildCalendarViewRecordsInput,
  type CalendarOccurrenceWrapper,
} from './calendar-view-runtime'
