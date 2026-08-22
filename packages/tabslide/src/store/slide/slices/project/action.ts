import { produce } from 'immer'
import { DEFAULT_EDITOR_CONFIG } from '../../../../types/slides'
import { applyPresentationTheme, applySaveState, normalizePresentation } from '../../store-helpers'
import type { SlideStoreGet, SlideStoreSet, SlideStoreState } from '../../slide-store-types'

export type ProjectAction = Pick<
  SlideStoreState,
  | 'currentPage'
  | 'selectedElements'
  | 'pageCount'
  | 'setPresentation'
  | 'updatePresentationMeta'
  | 'reset'
>

export const createProjectSlice = (
  set: SlideStoreSet,
  get: SlideStoreGet,
  _api?: unknown,
): ProjectAction => new ProjectActionImpl(set, get, _api)

export class ProjectActionImpl {
  readonly #set: SlideStoreSet
  readonly #get: SlideStoreGet

  constructor(set: SlideStoreSet, get: SlideStoreGet, _api?: unknown) {
    void _api
    this.#set = set
    this.#get = get
  }

  currentPage = () => {
    const { presentation, currentPageIndex } = this.#get()
    return presentation?.pages[currentPageIndex] ?? null
  }

  selectedElements = () => {
    const page = this.#get().currentPage()
    if (!page) return []
    const ids = new Set(this.#get().selectedElementIds)
    return page.elements.filter((el) => ids.has(el.id))
  }

  pageCount = () => this.#get().presentation?.pages.length ?? 0

  setPresentation = (p: Parameters<SlideStoreState['setPresentation']>[0]) => {
    const normalizedPresentation = normalizePresentation(p)
    const saved = this.#get()._projectSaveState[normalizedPresentation.id]
    this.#set({
      presentation: normalizedPresentation,
      currentPageIndex: 0,
      selectedElementIds: [],
      zoom: 1,
      panX: 0,
      panY: 0,
      isEditing: false,
      editingElementId: null,
      isDirty: saved?.dirty ?? false,
      saveStatus: saved?.status ?? 'idle',
      saveError: saved?.error ?? null,
      version: 0,
    })
  }

  updatePresentationMeta: SlideStoreState['updatePresentationMeta'] = (meta) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation) return
        Object.assign(s.presentation, meta)
        if (meta.theme) applyPresentationTheme(s.presentation)
        applySaveState(s, 'unsaved')
      }),
    )

  reset = () =>
    this.#set({
      presentation: null,
      currentPageIndex: 0,
      selectedElementIds: [],
      zoom: 1,
      panX: 0,
      panY: 0,
      isEditing: false,
      editingElementId: null,
      isDirty: false,
      saveStatus: 'idle',
      saveError: null,
      editorConfig: { ...DEFAULT_EDITOR_CONFIG },
      _projectSaveState: {},
      version: 0,
    })
}
