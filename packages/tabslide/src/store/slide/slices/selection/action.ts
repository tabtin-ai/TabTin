import type { SlideStoreGet, SlideStoreSet, SlideStoreState } from '../../slide-store-types'

export type SelectionAction = Pick<
  SlideStoreState,
  'selectElement' | 'selectElements' | 'selectAll' | 'clearSelection' | 'resetStore'
>

export const createSelectionSlice = (
  set: SlideStoreSet,
  get: SlideStoreGet,
  _api?: unknown,
): SelectionAction => new SelectionActionImpl(set, get, _api)

export class SelectionActionImpl {
  readonly #set: SlideStoreSet
  readonly #get: SlideStoreGet

  constructor(set: SlideStoreSet, get: SlideStoreGet, _api?: unknown) {
    void _api
    this.#set = set
    this.#get = get
  }

  selectElement: SlideStoreState['selectElement'] = (id, append = false) =>
    this.#set((s) => {
      const page = s.presentation?.pages[s.currentPageIndex]
      if (!page) return { selectedElementIds: [id] }

      const clickedEl = page.elements.find((e) => e.id === id)
      const groupId = clickedEl?.groupId

      if (append) {
        if (groupId) {
          const groupMemberIds = page.elements
            .filter((e) => e.groupId === groupId)
            .map((e) => e.id)
          const allInSelection = groupMemberIds.every((gid) =>
            s.selectedElementIds.includes(gid),
          )
          if (allInSelection) {
            const idSet = new Set(groupMemberIds)
            return {
              selectedElementIds: s.selectedElementIds.filter((i) => !idSet.has(i)),
            }
          }
          return {
            selectedElementIds: [...new Set([...s.selectedElementIds, ...groupMemberIds])],
          }
        }
        const ids = s.selectedElementIds.includes(id)
          ? s.selectedElementIds.filter((i) => i !== id)
          : [...s.selectedElementIds, id]
        return { selectedElementIds: ids }
      }

      if (groupId) {
        const groupMemberIds = page.elements
          .filter((e) => e.groupId === groupId)
          .map((e) => e.id)
        return {
          selectedElementIds: groupMemberIds,
          isEditing: false,
          editingElementId: null,
        }
      }
      return { selectedElementIds: [id], isEditing: false, editingElementId: null }
    })

  selectElements: SlideStoreState['selectElements'] = (ids) => this.#set({ selectedElementIds: ids })

  selectAll = () => {
    const page = this.#get().currentPage()
    if (!page) return
    this.#set({
      selectedElementIds: page.elements.filter((e) => !e.locked && e.visible !== false).map((e) => e.id),
      isEditing: false,
      editingElementId: null,
    })
  }

  clearSelection = () => this.#set({ selectedElementIds: [], isEditing: false, editingElementId: null })

  resetStore = () => this.#set({
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
    version: 0,
  })
}
