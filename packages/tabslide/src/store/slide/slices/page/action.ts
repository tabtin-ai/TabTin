import { current, produce } from 'immer'
import type { PPTAnimation, Slide } from '../../../../types/slides'
import { normalizeElementTransform, normalizeLayoutRef } from '../../element-normalization'
import {
  applySaveState,
  cloneSlideWithRegeneratedIds,
  createBlankPage,
  resetPageInteractionState,
} from '../../store-helpers'
import type { SlideStoreGet, SlideStoreSet, SlideStoreState } from '../../slide-store-types'

export type PageAction = Pick<
  SlideStoreState,
  | 'setCurrentPage'
  | 'addPage'
  | 'deletePage'
  | 'duplicatePage'
  | 'reorderPages'
  | 'updatePageBackground'
  | 'updatePageLayout'
  | 'updatePageTurningMode'
  | 'updatePageMasterElements'
  | 'updatePageRemark'
  | 'copyPage'
  | 'cutPage'
  | 'pastePageAfter'
>

export const createPageSlice = (
  set: SlideStoreSet,
  get: SlideStoreGet,
  _api?: unknown,
): PageAction => new PageActionImpl(set, get, _api)

export class PageActionImpl {
  readonly #set: SlideStoreSet

  constructor(set: SlideStoreSet, _get: SlideStoreGet, _api?: unknown) {
    void _get
    void _api
    this.#set = set
  }

  setCurrentPage: SlideStoreState['setCurrentPage'] = (index) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation) return
        const count = s.presentation.pages.length
        if (index < 0 || index >= count) return

        s.currentPageIndex = index
        resetPageInteractionState(s)
      }),
    )

  addPage: SlideStoreState['addPage'] = (after) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation) return
        const pageCount = s.presentation.pages.length
        const rawInsertAt = after !== undefined ? after + 1 : pageCount
        const insertAt = Math.min(Math.max(rawInsertAt, 0), pageCount)
        s.presentation.pages.splice(insertAt, 0, createBlankPage())
        s.currentPageIndex = insertAt
        resetPageInteractionState(s)
        applySaveState(s, 'unsaved')
      }),
    )

  deletePage: SlideStoreState['deletePage'] = (index) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation || s.presentation.pages.length <= 1) return
        const pages = s.presentation.pages
        if (index < 0 || index >= pages.length) return

        const prevCurrentIndex = s.currentPageIndex
        pages.splice(index, 1)

        if (prevCurrentIndex > index) {
          s.currentPageIndex = prevCurrentIndex - 1
        } else if (prevCurrentIndex === index) {
          s.currentPageIndex = Math.min(index, pages.length - 1)
        }

        resetPageInteractionState(s)
        applySaveState(s, 'unsaved')
      }),
    )

  duplicatePage: SlideStoreState['duplicatePage'] = (index) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation) return
        const pages = s.presentation.pages
        if (index < 0 || index >= pages.length) return

        const src = pages[index]
        if (!src) return

        pages.splice(index + 1, 0, cloneSlideWithRegeneratedIds(src))
        s.currentPageIndex = index + 1
        resetPageInteractionState(s)
        applySaveState(s, 'unsaved')
      }),
    )

  reorderPages: SlideStoreState['reorderPages'] = (from, to) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation) return
        const pages = s.presentation.pages
        if (from === to) return
        if (from < 0 || from >= pages.length || to < 0 || to >= pages.length) return

        const [moved] = pages.splice(from, 1)
        if (!moved) return
        pages.splice(to, 0, moved)

        const prevIndex = s.currentPageIndex
        if (prevIndex === from) {
          s.currentPageIndex = to
        } else if (from < prevIndex && prevIndex <= to) {
          s.currentPageIndex = prevIndex - 1
        } else if (to <= prevIndex && prevIndex < from) {
          s.currentPageIndex = prevIndex + 1
        }

        s.isEditing = false
        s.editingElementId = null
        applySaveState(s, 'unsaved')
      }),
    )

  updatePageBackground: SlideStoreState['updatePageBackground'] = (pageIndex, bg) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation?.pages[pageIndex]) return
        s.presentation.pages[pageIndex].background = bg
        applySaveState(s, 'unsaved')
      }),
    )

  updatePageLayout: SlideStoreState['updatePageLayout'] = (pageIndex, layout) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation?.pages[pageIndex]) return
        s.presentation.pages[pageIndex].layout = normalizeLayoutRef(layout)
        applySaveState(s, 'unsaved')
      }),
    )

  updatePageTurningMode: SlideStoreState['updatePageTurningMode'] = (pageIndex, turningMode) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation?.pages[pageIndex]) return
        const page = s.presentation.pages[pageIndex]
        page.turningMode = !turningMode || turningMode === 'no' ? undefined : turningMode
        applySaveState(s, 'unsaved')
      }),
    )

  updatePageMasterElements: SlideStoreState['updatePageMasterElements'] = (pageIndex, elements) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation?.pages[pageIndex]) return
        const page = s.presentation.pages[pageIndex]
        if (!elements || elements.length === 0) {
          page.masterElements = undefined
          applySaveState(s, 'unsaved')
          return
        }
        page.masterElements = elements.map((el) => normalizeElementTransform(el))
        applySaveState(s, 'unsaved')
      }),
    )

  updatePageRemark: SlideStoreState['updatePageRemark'] = (pageIndex, remark) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation?.pages[pageIndex]) return
        s.presentation.pages[pageIndex].remark = remark
        applySaveState(s, 'unsaved')
      }),
    )

  copyPage: SlideStoreState['copyPage'] = (index) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation) return
        const page = s.presentation.pages[index]
        if (!page) return
        s.pageClipboard = structuredClone(current(page))
      }),
    )

  cutPage: SlideStoreState['cutPage'] = (index) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation || s.presentation.pages.length <= 1) return
        const page = s.presentation.pages[index]
        if (!page) return
        s.pageClipboard = structuredClone(current(page))
        s.presentation.pages.splice(index, 1)
        if (s.currentPageIndex > index) {
          s.currentPageIndex = s.currentPageIndex - 1
        } else if (s.currentPageIndex === index) {
          s.currentPageIndex = Math.min(index, s.presentation.pages.length - 1)
        }
        resetPageInteractionState(s)
        applySaveState(s, 'unsaved')
      }),
    )

  pastePageAfter: SlideStoreState['pastePageAfter'] = (afterIndex) =>
    this.#set(
      produce((s: SlideStoreState) => {
        if (!s.presentation || !s.pageClipboard) return
        const duplicated = cloneSlideWithRegeneratedIds(s.pageClipboard)
        restoreLegacyStringNotes(duplicated, s.pageClipboard)

        const insertAt = Math.max(0, Math.min(afterIndex + 1, s.presentation.pages.length))
        s.presentation.pages.splice(insertAt, 0, duplicated)
        s.currentPageIndex = insertAt
        resetPageInteractionState(s)
        applySaveState(s, 'unsaved')
      }),
    )
}

const restoreLegacyStringNotes = (duplicated: Slide, source: Slide) => {
  const rawNotes = (source as { notes?: unknown }).notes
  if (typeof rawNotes === 'string') {
    ;(duplicated as { notes?: unknown }).notes = rawNotes
  }
}
