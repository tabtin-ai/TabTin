// Canvas grid engine
export {
  CANVAS_TABLE_ENGINE,
  CANVAS_TABLE_ENGINE_ID,
  CanvasGridAdapter,
} from './CanvasGridAdapter'
export type { CanvasGridAdapterProps } from './CanvasGridAdapter'

// Backward-compatible aliases so existing consumers don't break
export { CanvasGridAdapter as CanvasDataGridExperimental } from './CanvasGridAdapter'
export type { CanvasGridAdapterProps as CanvasDataGridExperimentalProps } from './CanvasGridAdapter'

// Overlay components and store
export { useGridOverlayStore } from './overlays'
export type { IHeaderMenuData, IRecordMenuData, IStatisticMenuData } from './overlays'
export { RecordMenu } from './overlays'
export type { RecordMenuLabels } from './overlays'
export { FieldMenu } from './overlays'
export type { FieldMenuLabels, FieldMenuCallbacks } from './overlays'
export { StatisticMenu, StatFunc, getValidStatFuncs, defaultStatLabels } from './overlays'
export type { StatisticMenuLabels } from './overlays'
export { PrefillingRowContainer } from './overlays'

export {
  setCanvasGridLocale,
  getCanvasGridLocale,
} from './grid/shims/i18n'
export type { CanvasGridLocale } from './grid/shims/i18n'

// Re-export grid types for direct usage if needed
export type { IGridRef } from './grid/Grid'
export type { IGridColumn, ICell, ICellItem } from './grid/interface'
export type { IGridTheme } from './grid/configs/gridTheme'
export { GridAttachmentInlineEditor } from './grid/components/editor/GridAttachmentEditor'
export type {
  AttachmentPreviewDialogComponent,
  AttachmentPreviewDialogRef,
  AttachmentPreviewFile,
  AttachmentPreviewUi,
  GridAttachmentInlineEditorProps,
} from './grid/components/editor/GridAttachmentEditor'

// Legacy editor exports (still used by some consumers) — keep until fully migrated
export {
  CanvasEditorLayer,
  canSeedCanvasEditor,
  resolveCanvasEditorDescriptor,
} from './editor/CanvasEditorLayer'
export type {
  CanvasEditorDescriptor,
  CanvasEditorKind,
  CanvasEditorLayerLabels,
  CanvasEditorLayerProps,
  CanvasEditorOption,
  CanvasEditorRect,
  CanvasEditorSession,
} from './editor/CanvasEditorLayer'
