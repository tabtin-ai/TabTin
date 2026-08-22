import type { ComponentType, CSSProperties } from 'react'

export type TableGridTheme = 'light' | 'dark'

export type TableGridEngineId = string

export type TableGridSelectionMode = 'none' | 'single' | 'multiple'

export type TableGridSelectionUnit = 'row' | 'cell' | 'range'

export type TableGridSelectionReason =
  | 'api'
  | 'mouse'
  | 'keyboard'
  | 'touch'
  | 'clipboard'
  | 'shortcut'
  | 'programmatic'

export type TableGridClipboardOperation = 'copy' | 'cut' | 'paste'

export type TableGridShortcutPhase = 'always' | 'gridFocused' | 'editing' | 'notEditing'

export type TableGridShortcutModifier = 'meta' | 'ctrl' | 'alt' | 'shift'

export type TableGridShortcutPlatform = 'mac' | 'windows' | 'linux' | 'all'

export interface TableGridKeyboardEventLike {
  key: string
  metaKey?: boolean
  ctrlKey?: boolean
  altKey?: boolean
  shiftKey?: boolean
}

export interface TableGridColumn {
  field: string
  headerName: string
  fieldId?: string
  width?: number
  minWidth?: number
  maxWidth?: number
  type?: string
  originalFieldType?: string
  isPrimaryField?: boolean
  description?: string
  editable?: boolean
  sortable?: boolean
  filter?: boolean
  pinned?: 'left' | 'right'
  valueFormatter?: (params: any) => string
  options?: Record<string, unknown>
  /** Cell editor name/type hint — e.g. 'selectCellEditor', 'checkboxCellEditor'. */
  cellEditor?: string
  /** Cell editor params — carries select choices ({ values: string[] }), rating max, etc. */
  cellEditorParams?: any
  /** Cell renderer params — carries field metadata. */
  cellRendererParams?: any
  /** 字段值的逻辑类型（Lookup 字段从目标字段继承），驱动渲染分支 */
  cellValueType?: 'string' | 'number' | 'boolean' | 'dateTime'
  /** Enable text wrapping within the cell */
  wrapText?: boolean
  /** Enable auto-height for the row based on cell content */
  autoHeight?: boolean
  /** Tooltip value getter for the cell */
  tooltipValueGetter?: (params: any) => string
  /** Cell style — static object or dynamic function returning CSS properties */
  cellStyle?: CSSProperties | ((params: any) => CSSProperties | undefined)
  /** 是否为 Lookup 字段 */
  /** 是否为多值字段（数组） */
  isMultipleCellValue?: boolean
  /** Lookup 配置（linkFieldId / lookupFieldId / foreignTableId） */
  lookupOptions?: Record<string, unknown>
  /** 目标字段的原始 field_type（Lookup 字段使用，用于继承目标字段的渲染方式） */
  lookupTargetFieldType?: string
  /** 字段是否有错误（如 Lookup 依赖的 Link 字段已被删除） */
  hasError?: boolean
  /** 字段验证规则（粘贴等旁路与格子编辑共用） */
  validation_rules?: Record<string, unknown>
}

export type TableGridRowType = 'draft' | 'add' | 'group_add' | 'group_header'

/**
 * Internal row identity key, isolated from business fields named `id`/`row_id`.
 * 业务字段可能自定义命名为 `id` 或 `row_id`，为避免与内部行标识冲突，
 * 引擎内部一律通过 `__recordId` 传递真实的记录/草稿标识。
 */
export const RECORD_IDENTITY_KEY = '__recordId' as const

export interface TableGridRow {
  id?: string
  row_id?: string
  /** Internal row identity — see {@link RECORD_IDENTITY_KEY}. Never a business field value. */
  __recordId?: string
  __rowType?: TableGridRowType
  /** Sub-record tree depth (0 = root). Set when view has subRecordParentFieldId. */
  __treeDepth?: number
  /** Whether this record has child records */
  __treeHasChildren?: boolean
  /** Whether this record's children are currently expanded */
  __treeExpanded?: boolean
  /** Parent record ID (null for root records) */
  __treeParentId?: string | null
  /** 1-based display index counting only root-level records (undefined for child rows) */
  __treeRootIndex?: number
  /** Grouping: nesting level (0 = top-level group) */
  __groupLevel?: number
  /** Grouping: display label for the group header */
  __groupLabel?: string
  /** Grouping: raw field value used to resolve typed group header content */
  __groupValue?: unknown
  /** Grouping: record count in this group */
  __groupCount?: number
  /** Grouping: how many records from this group are currently loaded in the grid */
  __groupLoadedCount?: number
  /** Grouping: slash-delimited group path for collapse state tracking */
  __groupPath?: string
  /** Grouping: whether this group is collapsed */
  __groupCollapsed?: boolean
  /** Grouping: whether this is the deepest group level */
  __groupIsLeaf?: boolean
  /** Grouping: accumulated group field values for creating records within group context */
  __groupValues?: Record<string, unknown>
  /** Allow dynamic field-name keyed values (e.g. rowData[field.name]) */
  [key: string]: unknown
}

export type TableGridPinnedRow = 'top' | 'bottom'

export interface TableGridFocusedCell {
  rowIndex: number
  rowPinned?: TableGridPinnedRow | null
  field?: string | null
}

export interface TableGridRuntimeRow<Row extends TableGridRow = TableGridRow> {
  data?: Row
  setSelected?: (selected: boolean, clearSelection?: boolean) => void
}

export interface TableGridStartEditingCellInput {
  rowIndex: number
  colKey: string
  rowPinned?: TableGridPinnedRow
}

export interface TableGridFlashCellsInput<Row extends TableGridRow = TableGridRow> {
  rowNodes?: Array<TableGridRuntimeRow<Row>>
  flashDelay?: number
  fadeDelay?: number
}

export interface TableGridRuntimeApi<Row extends TableGridRow = TableGridRow> {
  clearFocusedCell?: () => void
  deselectAll?: () => void
  stopEditing?: () => void
  isOverlayTarget?: (target: EventTarget | null | undefined) => boolean
  getFocusedCell?: () => TableGridFocusedCell | null
  getDisplayedRowCount?: () => number
  getDisplayedRowAtIndex?: (index: number) => TableGridRuntimeRow<Row> | null | undefined
  getPinnedBottomRowCount?: () => number
  getPinnedBottomRow?: (index: number) => TableGridRuntimeRow<Row> | null | undefined
  startEditingCell?: (input: TableGridStartEditingCellInput) => void
  getEditingCells?: () => Array<unknown>
  ensureIndexVisible?: (index: number, position?: 'top' | 'middle' | 'bottom') => void
  setFocusedCell?: (rowIndex: number, colKey: string, rowPinned?: TableGridPinnedRow) => void
  flashCells?: (input: TableGridFlashCellsInput<Row>) => void
  applyColumnSort?: (field: string, direction: 'asc' | 'desc') => void
}

export interface TableGridCellAddress {
  rowIndex: number
  colIndex: number
  rowId?: string
  field?: string
}

export interface TableGridSelectionRange {
  start: TableGridCellAddress
  end: TableGridCellAddress
}

export interface TableGridSelectionState<Row extends TableGridRow = TableGridRow> {
  mode?: TableGridSelectionMode
  unit?: TableGridSelectionUnit
  selectedRowIds?: string[]
  selectedRows?: Row[]
  activeCell?: TableGridCellAddress | null
  anchorCell?: TableGridCellAddress | null
  ranges?: TableGridSelectionRange[]
}

export interface TableGridSelectionConfig {
  mode?: TableGridSelectionMode
  unit?: TableGridSelectionUnit
  enableClickSelection?: boolean
  enableRangeSelection?: boolean
  enableMultiSelectWithShift?: boolean
}

export interface TableGridSelectionChangeContext<Row extends TableGridRow = TableGridRow> {
  reason: TableGridSelectionReason
  previous: TableGridSelectionState<Row>
  next: TableGridSelectionState<Row>
  nativeEvent?: unknown
}

export interface TableGridSortModelItem {
  field: string
  direction: 'asc' | 'desc'
}

export interface TableGridFilterModelItem {
  field: string
  operator: string
  value: unknown
}

export interface TableGridPagination {
  page: number
  pageSize: number
}

export interface TableGridRowMoveContext {
  /**
   * Drop target index in the current data-row linear list.
   * Matches the Canvas engine `onRowOrdered` drop index semantics.
   */
  dropRowIndex: number
  /**
   * How the row was dropped relative to the target row.
   * `inside` means "drop onto this row" and can be interpreted as making the
   * moved row a child of `targetRowIndex`.
   */
  dropMode?: 'before' | 'after' | 'inside'
  /** Target data-row index when `dropMode` points at a concrete row. */
  targetRowIndex?: number
  /** Target record id when the renderer can resolve it. */
  targetRowId?: string
}

export type TableGridRowControlType = 'checkbox' | 'drag' | 'expand'

export interface TableGridRowControlItem {
  type: TableGridRowControlType
  icon?: string
}

export interface TableGridHeaderContextMenuInfo {
  clientX: number
  clientY: number
  targetRect: DOMRect
  x?: number
  y?: number
  width?: number
  height?: number
  api?: any
}

export interface TableGridRowContextMenuInfo {
  clientX: number
  clientY: number
  targetRect: DOMRect
  rowIndex: number
  rowId?: string
  x?: number
  y?: number
  width?: number
  height?: number
  api?: any
}

export interface TableGridCellContextMenuInfo {
  clientX: number
  clientY: number
  targetRect: DOMRect
  rowIndex: number
  colIndex: number
  rowId?: string
  field: string
  value?: unknown
  displayValue?: string
  x?: number
  y?: number
  width?: number
  height?: number
  api?: any
}

export interface TableGridClipboardCell {
  rowIndex: number
  colIndex: number
  rowId?: string
  field: string
  value: unknown
  displayValue?: string
}

export interface TableGridClipboardPayload<Row extends TableGridRow = TableGridRow> {
  operation: TableGridClipboardOperation
  text: string
  html?: string
  cells: TableGridClipboardCell[]
  selection?: TableGridSelectionState<Row>
  /** 剪贴板包含文件但当前字段非 attachment 时标记，用于上层提示 */
  hasFiles?: boolean
  /** 粘贴时附件上传失败的错误信息，用于上层 toast */
  uploadError?: string
}

export interface TableGridClipboardConfig {
  enabled?: boolean
  copyHeaders?: boolean
  includeHtml?: boolean
  lineDelimiter?: string
  cellDelimiter?: string
}

export interface TableGridShortcutBinding {
  id: string
  key: string
  modifiers?: TableGridShortcutModifier[]
  phase?: TableGridShortcutPhase
  platform?: TableGridShortcutPlatform
  preventDefault?: boolean
  stopPropagation?: boolean
  description?: string
}

export interface TableGridShortcutConfig {
  enabled?: boolean
  disableDefaultBindings?: boolean
  bindings?: TableGridShortcutBinding[]
}

export interface TableGridShortcutTrigger<Row extends TableGridRow = TableGridRow> {
  binding: TableGridShortcutBinding
  nativeEvent: KeyboardEvent
  selection: TableGridSelectionState<Row>
  isEditing: boolean
}

export interface TableGridFreezeState {
  leftColumnFields?: string[]
  rightColumnFields?: string[]
  topRowIds?: string[]
  bottomRowIds?: string[]
  topRowCount?: number
  bottomRowCount?: number
}

export interface TableGridFreezeConfig {
  enabled?: boolean
  state?: TableGridFreezeState
}

export interface TableGridColumnStatistic {
  value?: string | number | null
  label?: string
  /** Aggregation function name (e.g. 'count', 'sum', 'average') for display in statistics bar */
  func?: string
  showAlways?: boolean
  /** Per-group aggregation values keyed by the group path used by grouped row renderers. */
  groupValues?: Record<string, string | number | null | undefined>
}

export type TableGridColumnStatistics = Record<
  string,
  TableGridColumnStatistic | string | number | null | undefined
>

export interface TableGridCanvasOverlayCell {
  rowIndex: number
  colIndex: number
}

export interface TableGridCanvasOverlayCollaboratorCell extends TableGridCanvasOverlayCell {
  color?: string
}

/** 协作者光标信息（基于 recordId + fieldId，由 Canvas 渲染层匹配 cell.id） */
export interface TableGridCollaboratorCursor {
  /** 协作者 ID */
  userId: string
  /** 协作者名称 */
  userName: string
  /** 边框颜色 */
  borderColor: string
  /** 协作者头像 URL */
  avatar?: string
  /** 活跃单元格 [recordId, fieldId] */
  activeCellId: [recordId: string, fieldId: string]
  /** 时间戳（用于冲突排序，最新的优先） */
  timeStamp: number
}

export interface TableGridCanvasPrefillingOverlayConfig {
  visible?: boolean
  isLoading?: boolean
  title?: string
  cancelLabel?: string
  onCancel?: () => void
  onClickOutside?: () => void
}

export interface TableGridCanvasFieldMenuLabels {
  editField?: string
  duplicateField?: string
  insertFieldLeft?: string
  insertFieldRight?: string
  sortField?: string
  filterField?: string
  groupField?: string
  freezeField?: string
  setPrimaryField?: string
  primaryField?: string
  hideField?: string
  hideAllSelectedFields?: string
  deleteField?: string
  deleteAllSelectedFields?: string
}

export interface TableGridCanvasRecordMenuLabels {
  insertAbove?: string
  insertBelow?: string
  rowUnit?: string
  duplicate?: string
  copyLink?: string
  comment?: string
  viewHistory?: string
  sendToChat?: string
  sendMultipleToChat?: string
  delete?: string
  deleteMultiple?: string
  addSubRecord?: string
}

export interface TableGridCanvasStatisticMenuLabels {
  none?: string
  [key: string]: string | undefined
}

export interface TableGridCanvasEditorLabels {
  selectSearchPlaceholder?: string
  /** 字段尚无任何选项时的搜索框占位 */
  selectSearchPlaceholderEmpty?: string
  selectNoResults?: string
  /** 字段尚无任何选项时的空态提示 */
  selectEmptyHint?: string
  /** 「创建 "xxx"」前缀文案，默认 "Create" */
  selectAddOption?: string
  /** 多选模式的 Done 按钮文案，默认 "Done" */
  selectDoneLabel?: string
  attachmentUpload?: string
  attachmentUploading?: string
  attachmentUploadHint?: string
  attachmentEmpty?: string
  attachmentDownloadAll?: string
  attachmentRemove?: string
  attachmentFileTypeNotAllowed?: string
}

export interface TableGridCanvasOverlayConfig {
  errorMessage?: string
  searchCursor?: TableGridCanvasOverlayCell | null
  searchTargets?: TableGridCanvasOverlayCell[]
  /**
   * 搜索命中索引列表（基于 recordId + fieldId），用于在 Canvas 中精确高亮匹配的单元格。
   * 通过 cell.id（格式 "recordId-fieldId"）匹配命中的搜索结果并绘制高亮。
   */
  searchHitIndex?: { fieldId: string; recordId: string }[]
  collaborators?: TableGridCollaboratorCursor[]
  statisticSummaryLabel?: string
  editorShiftEnterHint?: string
  editorLabels?: TableGridCanvasEditorLabels
  prefilling?: TableGridCanvasPrefillingOverlayConfig
  fieldMenuLabels?: TableGridCanvasFieldMenuLabels
  recordMenuLabels?: TableGridCanvasRecordMenuLabels
  statisticMenuLabels?: TableGridCanvasStatisticMenuLabels
  allRecordsCheckboxTooltip?: string
}

export interface TableGridConfig {
  pagination?: {
    enabled?: boolean
    pageSize?: number
    pageSizeOptions?: number[]
    page?: number
    total?: number
  }
  selection?: TableGridSelectionConfig
  sorting?: TableGridSortModelItem[]
  filters?: TableGridFilterModelItem[]
  selectedRows?: string[]
  clipboard?: TableGridClipboardConfig
  shortcuts?: TableGridShortcutConfig
  freeze?: TableGridFreezeConfig
  rowHeight?: number
  headerHeight?: number
  canvasOverlay?: TableGridCanvasOverlayConfig
}

export interface TableGridAttachmentUploadContext<Row extends TableGridRow = TableGridRow> {
  rowData: Row
  field: string
  fieldId?: string
  files: File[]
  currentValue: unknown
  onProgress?: (items: TableGridAttachmentUploadProgressItem[]) => void
}

export interface TableGridAttachmentUploadProgressItem {
  uploadItemId: string
  file: File
  fileName: string
  status: 'pending' | 'uploading' | 'completed' | 'error' | 'cancelled'
  progress: number
  error?: string
}

export type TableGridAttachmentUploadHandler<Row extends TableGridRow = TableGridRow> = (
  context: TableGridAttachmentUploadContext<Row>
) => Promise<unknown[] | void> | unknown[] | void

/** 跨应用文件引用（对话 → 附件字段），与 application/x-tabtin-file-ref 对齐 */
export interface TableGridAttachmentFileRef {
  name: string
  file_id?: string
  url?: string
  mime_type?: string
  size?: number
}

export interface TableGridAttachmentFileRefContext<Row extends TableGridRow = TableGridRow> {
  rowData: Row
  field: string
  fieldId?: string
  fileRefs: TableGridAttachmentFileRef[]
  currentValue: unknown
}

export type TableGridAttachmentFileRefHandler<Row extends TableGridRow = TableGridRow> = (
  context: TableGridAttachmentFileRefContext<Row>
) => Promise<unknown[] | void> | unknown[] | void

/** 附件下载项（Electron 宿主注入，绕开跨域 `<a target=_blank>`） */
export interface TableGridAttachmentAccessContext {
  referenceId?: string
  tableId?: string
  fieldId?: string
  recordId?: string
}

export interface TableGridAttachmentDownloadItem {
  url: string
  name: string
  fileId?: string
  accessContext?: TableGridAttachmentAccessContext
}

export type TableGridAttachmentDownloadHandler = (
  item: TableGridAttachmentDownloadItem,
) => void | Promise<void>

export type TableGridAttachmentDownloadAllHandler = (
  items: TableGridAttachmentDownloadItem[],
) => void | Promise<void>

export interface TableGridVisibleRegion {
  startRowIndex: number
  stopRowIndex: number
  rowCount: number
}

export interface TableGridRendererProps<Row extends TableGridRow = TableGridRow> {
  columns: TableGridColumn[]
  rows: Row[]
  rowControls?: TableGridRowControlItem[]
  rowIndexVisible?: boolean
  commentCountMap?: Record<string, number>
  columnStatistics?: TableGridColumnStatistics
  config?: TableGridConfig
  className?: string
  theme?: TableGridTheme
  isLoading?: boolean
  emptyStateTitle?: string
  emptyStateDescription?: string
  noDataTitle?: string
  noDataDescription?: string
  singleClickEdit?: boolean
  style?: CSSProperties
  onGridReady?: (params: any) => void
  onFirstDataRendered?: (params: any) => void
  onSelectionChanged?: (selectedRows: Row[]) => void
  onSelectionStateChange?: (
    state: TableGridSelectionState<Row>,
    context: TableGridSelectionChangeContext<Row>
  ) => void
  onSortChanged?: (sortModel: TableGridSortModelItem[]) => void
  onFilterChanged?: (filterModel: TableGridFilterModelItem[]) => void
  onPaginationChanged?: (pagination: TableGridPagination) => void
  onCellValueChanged?: (rowData: Row, field: string, newValue: unknown, oldValue: unknown) => void
  onAttachmentUpload?: TableGridAttachmentUploadHandler<Row>
  onAttachmentFileRef?: TableGridAttachmentFileRefHandler<Row>
  /** Electron：单附件下载（绕开跨域 `<a target=_blank>`） */
  onDownloadAttachment?: TableGridAttachmentDownloadHandler
  /** Electron：全部下载；优先于逐个 onDownloadAttachment */
  onDownloadAllAttachments?: TableGridAttachmentDownloadAllHandler
  loadAttachmentPreviewUi?: () => Promise<unknown>
  /** Called when user creates a new select option from the dropdown editor */
  onSelectOptionAdd?: (fieldName: string, optionName: string) => void | Promise<void>
  onCellEditingStopped?: (params: any) => void
  onTableApiReady?: (api: TableGridRuntimeApi<Row> | null) => void
  onRowExpand?: (rowData: Row) => void
  /** Opens record detail with its comments panel expanded. */
  onCommentCountClick?: (rowData: Row) => void
  /** Opens record detail from the record-menu comment action. */
  onRecordComment?: (rowData: Row) => void
  onRowAppend?: (context?: {
    /** Index in the renderer's public rows model, including group/add virtual rows. */
    rowIndex?: number
    rowData?: Row | null
    groupPath?: string | null
    groupValues?: Record<string, unknown>
  }) => void
  onRowDoubleClicked?: (rowData: Row) => void
  onColumnAppend?: () => void
  onColumnHeaderContextMenu?: (field: string, info: TableGridHeaderContextMenuInfo) => void
  onColumnStatisticClick?: (field: string, info: TableGridHeaderContextMenuInfo) => void
  onRowContextMenu?: (rowData: Row, info: TableGridRowContextMenuInfo) => void
  /** Called when user clicks "Add sub-record" in the record context menu */
  onInsertSubRecord?: (parentRowId: string) => Promise<void>
  /** Delete record(s) from the record context menu */
  onDeleteRecords?: (recordIds: string[]) => Promise<void>
  /** Duplicate a record from the record context menu */
  onDuplicateRecord?: (recordId: string) => Promise<void>
  /** Insert record above/below from the record context menu */
  onInsertRecord?: (position: 'before' | 'after', anchorRowIndex: number, count: number) => void
  /** Copy record URL to clipboard from the record context menu */
  onCopyRecordUrl?: (recordId: string) => Promise<void>
  /** Called when user clicks the tree expand/collapse arrow on a row */
  onTreeToggle?: (rowId: string) => void
  onCellContextMenu?: (rowData: Row, field: string, info: TableGridCellContextMenuInfo) => void
  onRowMoved?: (rowIds: string[], context?: TableGridRowMoveContext) => void
  /**
   * Invoked after column drag completes.
   * `fieldKeys` represents the full visible column order after reordering.
   * Prefer `fieldId`; fallback to `field` when id is unavailable.
   */
  onColumnMoved?: (fieldKeys: string[]) => void
  onColumnResized?: (fieldWidths: Record<string, number>) => void
  onClipboardCopy?: (payload: TableGridClipboardPayload<Row>) => void
  onClipboardCut?: (payload: TableGridClipboardPayload<Row>) => void
  onClipboardPaste?: (payload: TableGridClipboardPayload<Row>) => void
  onShortcutTriggered?: (payload: TableGridShortcutTrigger<Row>) => void
  onFreezeStateChange?: (nextState: TableGridFreezeState) => void
  /** Called when user clicks a link cell to expand/edit linked records */
  onLinkCellExpand?: (recordId: string, fieldId: string, column: TableGridColumn) => void
  /** Called when user clicks a specific link tag (pill) inside a Link cell */
  onLinkTagClick?: (recordId: string, fieldId: string, linkedRecordId: string) => void
  /**
   * Called when user clicks a URL field cell.
   * 宿主据此把 http(s) 链接在当前 Space 内置浏览器（tabweb）打开，而非 `<a target=_blank>`
   * 直跳系统浏览器。未提供时回退到默认外链行为。
   */
  onUrlCellClick?: (url: string) => void
  /** Reports the current virtual-scroll row window to the host. */
  onVisibleRegionChanged?: (region: TableGridVisibleRegion) => void
  /**
   * Organization 成员列表，供 user 字段单元格渲染（id→姓名解析）与内联编辑器复用。
   * 用内联结构而非从 smartsheet-ui 引类型，避免 table-engine 反向依赖 UI 包。
   */
  organizationMembers?: Array<{ id: string; name: string; email?: string; avatarUrl?: string }>
  /** 只用于用户字段展示的 ID→名称映射，可包含已经离开组织、不可再选择的成员。 */
  userDisplayNameById?: ReadonlyMap<string, string>
  /**
   * 当前视图的子记录父链 link 字段 id（来自 view.config.subRecordParentFieldId）。
   * 用于：① 屏蔽父记录单元格点击弹窗（该弹窗属已隐藏的问题功能）；
   * ② 父链值只有裸 id 时按记录主字段兜底解析显示标题。
   */
  subRecordParentFieldId?: string | null
  pinnedBottomRowData?: Row[]
  isFullWidthRow?: (params: any) => boolean
  fullWidthCellRenderer?: unknown
  fullWidthCellRendererParams?: unknown
  postSortRows?: (params: any) => void
}

export interface TableGridEngineCapabilities {
  supportsPinnedBottomRows: boolean
  supportsFullWidthRows: boolean
  supportsColumnResize: boolean
  supportsColumnReorder: boolean
  supportsVirtualScroll: boolean
  supportsCellEditing: boolean
  supportsGroupingVisualRows: boolean
  supportsRangeSelection: boolean
  supportsClipboard: boolean
  supportsKeyboardShortcuts: boolean
  supportsFrozenColumns: boolean
  supportsFrozenRows: boolean
}

export interface TableGridEngine<Row extends TableGridRow = TableGridRow> {
  id: TableGridEngineId
  label: string
  experimental?: boolean
  capabilities: TableGridEngineCapabilities
  component: ComponentType<TableGridRendererProps<Row>>
}

/**
 * Resolve a row's internal record/draft identity.
 *
 * Prefers `__recordId` (isolated from business fields). Falls back to legacy
 * keys (`id`, `row_id`, `record_id`, `_id`, `__id`) only when `opts.allowLegacy`
 * is not explicitly `false`, to keep backward compatibility with call sites
 * that haven't migrated to `__recordId` yet.
 */
export function resolveRecordId(row: unknown, opts?: { allowLegacy?: boolean }): string | null {
  if (!row || typeof row !== 'object') return null
  const r = row as Record<string, unknown>
  // Skip non-data structural rows except draft (draft has __recordId)
  if (typeof r.__rowType === 'string' && r.__rowType.length > 0 && r.__rowType !== 'draft') {
    return null
  }
  const internal = r[RECORD_IDENTITY_KEY]
  if (typeof internal === 'string' && internal.length > 0) return internal
  if (opts?.allowLegacy === false) return null
  for (const key of ['id', 'row_id', 'record_id', '_id', '__id'] as const) {
    const v = r[key]
    if (typeof v === 'string' && v.length > 0) return v
  }
  return null
}

/** Whether a row represents the transient "new record" draft row. */
export function isDraftGridRow(row: unknown, draftId = '__draft_row__'): boolean {
  if (!row || typeof row !== 'object') return false
  const r = row as Record<string, unknown>
  if (r.__rowType === 'draft') return true
  return resolveRecordId(row) === draftId
}

export const DEFAULT_TABLE_GRID_ENGINE_CAPABILITIES: Readonly<TableGridEngineCapabilities> = {
  supportsPinnedBottomRows: false,
  supportsFullWidthRows: false,
  supportsColumnResize: false,
  supportsColumnReorder: false,
  supportsVirtualScroll: true,
  supportsCellEditing: false,
  supportsGroupingVisualRows: false,
  supportsRangeSelection: false,
  supportsClipboard: false,
  supportsKeyboardShortcuts: false,
  supportsFrozenColumns: false,
  supportsFrozenRows: false,
}
