export interface TableUiModuleInfo {
  name: string
  version: string
}

export const TABLE_UI_MODULE_INFO: TableUiModuleInfo = {
  name: '@tabtin/table-ui',
  version: '0.1.0',
}

export * from './types'
export * from './utils/viewVisibility'
export * from './utils/galleryCardLayout'
export * from './utils/viewToolbarActions'
export * from './utils/viewLock'
export * from './utils/viewDraftSaveState'
export * from './utils/filterHelpers'
export * from './utils/groupHelpers'
export * from './utils/canvasMenuLabels'
export * from './utils/buildRowsWithDraft'
export * from './utils/recordOpsHelpers'
export * from './utils/gridSearchFocus'
export * from './utils/restoreTableGridFocus'
export * from './utils/attachmentFieldTypes'
export * from './utils/attachmentReferences'
export * from './utils/viewCardTitle'
// createdRecordVisibility 从 @tabtin/table-ui/clipboard subpath 导出
export * from './components/view/ViewFilterRulesEditor'
export * from './components/view/ViewGroupRulesEditor'
export * from './components/view/ViewSortRulesEditor'
export * from './components/toolbar/GridToolbarLeftSection'
export * from './components/toolbar/GridToolbarMoreMenu'
export * from './components/toolbar/GridToolbarMainBar'
export * from './components/toolbar/GridToolbarSearchButton'
export { COMMON_TABLE_EMOJIS } from './components/toolbar/constants'
export * from './components/grid/DataGridFullWidthRowRenderer'
export * from './components/grid/DataGridPaginationBar'
export * from './components/grid/DataGridContext'

export * from './controller/advisoryConflictNotice'
export * from './controller/cellValueUtils'
export * from './controller/useDataGridColumns'
export * from './controller/useDataGridDataset'
export * from './controller/useDataGridEditingController'
export * from './controller/useViewContainerState'
export * from './controller/useKanbanViewController'
export * from './controller/useCalendarViewController'
export * from './controller/useGalleryViewController'
export * from './controller/useFormViewController'
export * from './controller/useGridToolbarController'
export * from './controller/useGridToolbarUiState'
export * from './controller/useViewToolbarController'
export * from './controller/useViewFilterGroupController'
export * from './controller/useViewSwitcherController'
export * from './controller/useViewEditorForm'
export * from './controller/useHideFieldsState'
export * from './controller/useSortEditorState'
export * from './controller/ViewPopoverContext'
// useDataGridClipboard 从 @tabtin/table-ui/clipboard subpath 导出
export * from './controller/useTableInitFlow'

export * from './components/common/TableLoadingView'
export * from './components/common/TableErrorView'
export * from './components/common/PopoverSearchInput'
export * from './components/common/dnd-kit'
export * from './components/view/viewTypeIcons'
export * from './components/view/ToolBarButton'
export * from './components/view/ViewFilterPopover'
export * from './components/view/ViewFilterPanel'
export * from './components/view/ViewGroupPopover'
export * from './components/view/ViewGroupPanel'
export * from './components/view/ViewContextMenuContent'
export * from './components/view/AddViewDropdown'
export * from './components/view/ViewTabButton'
export * from './components/view/HideFieldsPopoverContent'
export * from './components/view/SaveAsViewDialog'
export * from './components/view/ViewDraftActions'
export * from './components/view/ViewDraggableWrapper'
export * from './utils/sortNormalize'
export * from './utils/sortPanelTexts'
export * from './utils/popoverUtils'
export * from './utils/recordFormUtils'
export * from './components/view/UndoRedoContext'

export * from './stores/useTableViewUiStore'
export * from './stores/createStoreHost'
export * from './stores/createHostAdapters'

export * from './controller/useUndoRedo'
export {
  GRID_FOCUS_TRAP_ATTR,
  GRID_CELL_EDITOR_OVERLAY_ATTR,
  GRID_CELL_EDITOR_OVERLAY_VALUE,
  GRID_CELL_EDITING_ATTR,
  isDocumentFallbackFocus,
  shouldDeferTableUndoToNativeEditor,
  shouldHandleTableUndoShortcut,
} from './controller/tableUndoKeyboard'
export { notifyBackendUndoable, registerBackendUndoableRecorder } from './controller/undoTimelineBridge'
export { createUndoTimeline, type UndoTimeline, type UndoTimelineSource } from './controller/undoTimeline'

export { tableSharedLocales, tableSharedZhCN, tableSharedEnUS } from './i18n'
export type { TableSharedLocale } from './i18n'

// 交互数据流探针（dev-only，宿主在 DEV 下 enableDataflowProbe 才启用）
export type {
  ProbeOrigin,
  ProbeComponent,
  ProbeHost,
  ProbeEvent,
  ProbeIntentDescriptor,
  ProbeSink,
  ProbeDumpFilter,
} from './probe/dataflowProbe'
export {
  enableDataflowProbe,
  isDataflowProbeEnabled,
  setProbeSink,
  recordProbeEvent,
  registerProbeIntent,
  unregisterProbeIntent,
  listProbeIntents,
  fireProbeIntent,
  dumpProbeEvents,
  clearProbeEvents,
  flushProbe,
  getProbeSessionId,
  resetDataflowProbe,
} from './probe/dataflowProbe'
export {
  buildGroupOrderSnapshot,
  type GroupOrderSnapshot,
  type GroupOrderSnapshotItem,
} from './probe/groupOrderSnapshot'
