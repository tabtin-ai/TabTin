import type { StateCreator } from 'zustand'
import type {
  EditorConfig,
  PPTAnimation,
  PPTElement,
  Slide,
  SlideBackground,
  SlideLayoutRef,
  SlidePresentation,
  TurningMode,
} from '../../types/slides'

export type SaveStatusType = 'idle' | 'unsaved' | 'saving' | 'saved' | 'error'

export interface ProjectSaveEntry {
  status: SaveStatusType
  error: string | null
  dirty: boolean
}

export interface SlideStoreState {
  // ── 数据 ──
  presentation: SlidePresentation | null
  currentPageIndex: number
  selectedElementIds: string[]

  // ── 视口 ──
  zoom: number
  panX: number
  panY: number

  // ── 编辑器状态 ──
  /** 是否处于文本编辑模式（双击文本框后） */
  isEditing: boolean
  /** 正在编辑的文本元素 ID */
  editingElementId: string | null
  isDirty: boolean
  /** 自动保存状态：idle=未编辑 | unsaved=有未保存变更 | saving=保存中 | saved=已保存 | error=保存失败 */
  saveStatus: SaveStatusType
  /** 保存失败时的错误描述 */
  saveError: string | null
  editorConfig: EditorConfig
  /** 多 keepAlive tab 时，按 projectId 独立跟踪保存状态 */
  _projectSaveState: Record<string, ProjectSaveEntry>

  // ── 计算属性 ──
  currentPage: () => Slide | null
  selectedElements: () => PPTElement[]
  pageCount: () => number

  // ── 项目操作 ──
  setPresentation: (p: SlidePresentation) => void
  updatePresentationMeta: (meta: Partial<Pick<SlidePresentation, 'name' | 'theme'>>) => void
  reset: () => void

  // ── 页面操作 ──
  setCurrentPage: (index: number) => void
  addPage: (after?: number) => void
  deletePage: (index: number) => void
  duplicatePage: (index: number) => void
  reorderPages: (from: number, to: number) => void
  updatePageBackground: (pageIndex: number, bg: SlideBackground) => void
  updatePageLayout: (pageIndex: number, layout?: SlideLayoutRef) => void
  updatePageTurningMode: (pageIndex: number, turningMode?: TurningMode) => void
  updatePageMasterElements: (pageIndex: number, elements?: PPTElement[]) => void
  updatePageRemark: (pageIndex: number, remark: string) => void

  // ── 页面剪贴板 ──
  pageClipboard: Slide | null
  copyPage: (index: number) => void
  cutPage: (index: number) => void
  pastePageAfter: (afterIndex: number) => void

  // ── 选择操作 ──
  selectElement: (id: string, append?: boolean) => void
  selectElements: (ids: string[]) => void
  selectAll: () => void
  clearSelection: () => void
  /** C1-04: 卸载编辑器时清理全局单例状态 */
  resetStore: () => void

  // ── 元素 CRUD ──
  addElement: (element: PPTElement, pageIndex?: number) => void
  addElements: (elements: PPTElement[], pageIndex?: number) => void
  updateElement: (id: string, updates: Partial<PPTElement>) => void
  updateElements: (items: Array<{ id: string; updates: Partial<PPTElement> }>) => void
  deleteElements: (ids: string[]) => void
  duplicateElements: (ids: string[]) => void

  // ── 图层操作 ──
  bringForward: (id: string) => void
  sendBackward: (id: string) => void
  bringToFront: (id: string) => void
  sendToBack: (id: string) => void
  bringForwardSelection: (ids: string[]) => void
  sendBackwardSelection: (ids: string[]) => void
  bringSelectionToFront: (ids: string[]) => void
  sendSelectionToBack: (ids: string[]) => void
  toggleVisibility: (id: string) => void
  setVisibility: (ids: string[], visible: boolean) => void
  toggleLock: (id: string) => void
  setLocked: (ids: string[], locked: boolean) => void
  setGroupName: (ids: string[], groupName: string) => void
  /** 重新排列元素数组（用于拖拽排序图层列表），from/to 为数组索引 */
  reorderElements: (from: number, to: number) => void
  /** 将选中的元素组合 */
  groupElements: (ids: string[]) => void
  /** 取消选中元素的组合 */
  ungroupElements: (ids: string[]) => void

  // ── 动画操作 ──
  addAnimation: (anim: PPTAnimation) => void
  updateAnimation: (animId: string, updates: Partial<PPTAnimation>) => void
  removeAnimation: (animId: string) => void
  reorderAnimations: (from: number, to: number) => void

  // ── 历史恢复 ──
  /** H2-02: 统一历史恢复入口，走 normalizeElementTransform 保持一致性 */
  applyHistoryPages: (pages: Slide[]) => void

  // ── 视口操作 ──
  setZoom: (zoom: number) => void
  setPan: (x: number, y: number) => void
  zoomToFit: () => void

  // ── 编辑器状态 ──
  setEditing: (elementId: string | null) => void
  updateEditorConfig: (updates: Partial<EditorConfig>) => void
  resetEditorConfig: () => void
  markDirty: () => void
  markClean: () => void
  setSaveStatus: (status: SaveStatusType, error?: string, projectId?: string) => void

  // ── 版本追踪（CAS 乐观锁） ──
  version: number
  setVersion: (v: number) => void
}

export type SlideStoreSet = Parameters<StateCreator<SlideStoreState>>[0]
export type SlideStoreGet = () => SlideStoreState
