import { DEFAULT_EDITOR_CONFIG } from '../../../../types/slides'
import { normalizeElementTransform, sanitizeEditorConfig } from '../../element-normalization'
import type {
  ProjectSaveEntry,
  SlideStoreGet,
  SlideStoreSet,
  SlideStoreState,
} from '../../slide-store-types'

export type EditorAction = Pick<
  SlideStoreState,
  | 'applyHistoryPages'
  | 'setZoom'
  | 'setPan'
  | 'zoomToFit'
  | 'setEditing'
  | 'updateEditorConfig'
  | 'resetEditorConfig'
  | 'markDirty'
  | 'markClean'
  | 'setSaveStatus'
  | 'setVersion'
>

export const createEditorSlice = (
  set: SlideStoreSet,
  get: SlideStoreGet,
  _api?: unknown,
): EditorAction => new EditorActionImpl(set, get, _api)

export class EditorActionImpl {
  readonly #set: SlideStoreSet
  readonly #get: SlideStoreGet

  constructor(set: SlideStoreSet, get: SlideStoreGet, _api?: unknown) {
    void _api
    this.#set = set
    this.#get = get
  }

  applyHistoryPages: SlideStoreState['applyHistoryPages'] = (pages) => {
    this.#set((prev) => {
      if (!prev.presentation) return prev
      const normalizedPages = pages.map((page) => ({
        ...page,
        elements: page.elements.map((el) => normalizeElementTransform(el)),
        ...(page.masterElements
          ? { masterElements: page.masterElements.map((el) => normalizeElementTransform(el)) }
          : {}),
      }))
      const nextPageCount = normalizedPages.length
      const nextIndex = nextPageCount > 0
        ? Math.min(prev.currentPageIndex, nextPageCount - 1)
        : 0
      return {
        presentation: { ...prev.presentation, pages: normalizedPages },
        currentPageIndex: nextIndex,
        selectedElementIds: [],
        isEditing: false,
        editingElementId: null,
        isDirty: true,
        saveStatus: 'unsaved' as const,
        saveError: null,
        version: 0,
      }
    })
  }

  setZoom: SlideStoreState['setZoom'] = (zoom) => {
    const { minZoom, maxZoom } = this.#get().editorConfig
    this.#set({ zoom: Math.min(Math.max(zoom, minZoom), maxZoom) })
  }

  setPan: SlideStoreState['setPan'] = (x, y) => this.#set({ panX: x, panY: y })

  zoomToFit = () => {
    // 重置平移，zoom 由 Canvas 的 fitToContainer 处理
    this.#set({ panX: 0, panY: 0 })
  }

  setEditing: SlideStoreState['setEditing'] = (elementId) =>
    this.#set((s) => {
      if (elementId === null) {
        return {
          isEditing: false,
          editingElementId: null,
        }
      }
      const page = s.presentation?.pages[s.currentPageIndex]
      const target = page?.elements.find((el) => el.id === elementId)
      if (!target || target.locked || target.visible === false) {
        return {
          isEditing: false,
          editingElementId: null,
        }
      }
      return {
        isEditing: true,
        editingElementId: elementId,
      }
    })

  updateEditorConfig: SlideStoreState['updateEditorConfig'] = (updates) =>
    this.#set((s) => ({
      editorConfig: sanitizeEditorConfig(s.editorConfig, updates),
    }))

  resetEditorConfig = () => this.#set({ editorConfig: { ...DEFAULT_EDITOR_CONFIG } })

  markDirty = () => {
    const pid = this.#get().presentation?.id
    if (pid) {
      const newMap = { ...this.#get()._projectSaveState, [pid]: { status: 'unsaved' as const, error: null, dirty: true } }
      this.#set({ _projectSaveState: newMap, isDirty: true, saveStatus: 'unsaved', saveError: null })
    } else {
      this.#set({ isDirty: true, saveStatus: 'unsaved', saveError: null })
    }
  }

  markClean = () => {
    const pid = this.#get().presentation?.id
    if (pid) {
      const newMap = { ...this.#get()._projectSaveState, [pid]: { status: 'saved' as const, error: null, dirty: false } }
      this.#set({ _projectSaveState: newMap, isDirty: false, saveStatus: 'saved', saveError: null })
    } else {
      this.#set({ isDirty: false, saveStatus: 'saved', saveError: null })
    }
  }

  setSaveStatus: SlideStoreState['setSaveStatus'] = (status, error, projectId) => {
    const state = this.#get()
    const currentPid = state.presentation?.id
    const targetPid = projectId ?? currentPid
    if (!targetPid) return

    const entry: ProjectSaveEntry = {
      status,
      error: error ?? null,
      dirty: status === 'error' || status === 'unsaved',
    }
    const newMap = { ...state._projectSaveState, [targetPid]: entry }

    if (targetPid !== currentPid) {
      this.#set({ _projectSaveState: newMap })
      return
    }

    switch (status) {
      case 'saving':
        this.#set({ _projectSaveState: newMap, isDirty: false, saveStatus: 'saving', saveError: null })
        break
      case 'saved':
        if (state.saveStatus === 'saving') {
          this.#set({ _projectSaveState: newMap, saveStatus: 'saved', saveError: null })
        } else {
          this.#set({ _projectSaveState: newMap })
        }
        break
      case 'error':
        this.#set({ _projectSaveState: newMap, isDirty: true, saveStatus: 'error', saveError: error || null })
        break
      case 'unsaved':
        this.#set({ _projectSaveState: newMap, isDirty: true, saveStatus: 'unsaved', saveError: null })
        break
      default:
        this.#set({ _projectSaveState: newMap, saveStatus: status, saveError: error || null })
    }
  }

  setVersion: SlideStoreState['setVersion'] = (v) => this.#set({ version: v })
}
