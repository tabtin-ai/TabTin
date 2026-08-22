import { current, produce } from 'immer'
import type { PPTElement } from '../../../../types/slides'
import { createElementId, regenerateNestedIds } from '../../../../utils/id'
import { normalizeElementTransform, normalizeElementUpdates } from '../../element-normalization'
import { applySaveState } from '../../store-helpers'
import type { SlideStoreGet, SlideStoreSet, SlideStoreState } from '../../slide-store-types'

export type ElementAction = Pick<
  SlideStoreState,
  'addElement' | 'addElements' | 'updateElement' | 'updateElements' | 'deleteElements' | 'duplicateElements'
>

export const createElementSlice = (
  set: SlideStoreSet,
  get: SlideStoreGet,
  _api?: unknown,
): ElementAction => new ElementActionImpl(set, get, _api)

export class ElementActionImpl {
  readonly #set: SlideStoreSet

  constructor(set: SlideStoreSet, _get: SlideStoreGet, _api?: unknown) {
    void _get
    void _api
    this.#set = set
  }

  addElement: SlideStoreState['addElement'] = (element, pageIndex) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const idx = pageIndex ?? s.currentPageIndex
        const page = s.presentation?.pages[idx]
        if (!page) return
        const normalizedElement = normalizeElementTransform(element)
        page.elements.push(normalizedElement)
        s.selectedElementIds = [normalizedElement.id]
        applySaveState(s, 'unsaved')
      }),
    )

  addElements: SlideStoreState['addElements'] = (elements, pageIndex) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const idx = pageIndex ?? s.currentPageIndex
        const page = s.presentation?.pages[idx]
        if (!page) return
        const newIds: string[] = []
        for (const el of elements) {
          const normalized = normalizeElementTransform(el)
          page.elements.push(normalized)
          newIds.push(normalized.id)
        }
        s.selectedElementIds = newIds
        applySaveState(s, 'unsaved')
      }),
    )

  updateElement: SlideStoreState['updateElement'] = (id, updates) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        const el = page.elements.find((e) => e.id === id)
        if (!el) return
        Object.assign(el, normalizeMergedElement(el, updates))
        applySaveState(s, 'unsaved')
      }),
    )

  updateElements: SlideStoreState['updateElements'] = (items) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page || items.length === 0) return

        const mergedById = new Map<string, Partial<PPTElement>>()
        for (const item of items) {
          const prev = mergedById.get(item.id) || {}
          mergedById.set(item.id, { ...prev, ...item.updates } as Partial<PPTElement>)
        }
        if (mergedById.size === 0) return

        let changed = false
        for (const el of page.elements) {
          const updates = mergedById.get(el.id)
          if (!updates) continue
          Object.assign(el, normalizeMergedElement(el, updates))
          changed = true
        }

        if (changed) applySaveState(s, 'unsaved')
      }),
    )

  deleteElements: SlideStoreState['deleteElements'] = (ids) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        const idSet = new Set(ids)
        const deletableIdSet = new Set(
          page.elements
            .filter((el) => idSet.has(el.id) && !el.locked)
            .map((el) => el.id),
        )
        if (deletableIdSet.size === 0) return

        page.elements = page.elements.filter((e) => !deletableIdSet.has(e.id))
        if (page.animations) {
          page.animations = page.animations.filter((a) => !deletableIdSet.has(a.elId))
        }
        s.selectedElementIds = s.selectedElementIds.filter((id) => !deletableIdSet.has(id))
        applySaveState(s, 'unsaved')
      }),
    )

  duplicateElements: SlideStoreState['duplicateElements'] = (ids) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        const newIds: string[] = []
        const groupIdMap = new Map<string, string>()
        for (const id of ids) {
          const el = page.elements.find((e) => e.id === id)
          if (!el) continue
          const newEl = cloneElementForDuplicate(el, groupIdMap)
          const normalized = normalizeElementTransform(newEl)
          page.elements.push(normalized)
          newIds.push(newEl.id)
        }
        s.selectedElementIds = newIds
        applySaveState(s, 'unsaved')
      }),
    )
}

const normalizeMergedElement = (
  el: PPTElement,
  updates: Partial<PPTElement>,
): PPTElement => {
  const merged = {
    ...el,
    ...normalizeElementUpdates(el, updates),
  } as PPTElement
  return normalizeElementTransform(merged)
}

const cloneElementForDuplicate = (
  el: PPTElement,
  groupIdMap: Map<string, string>,
): PPTElement => {
  const newEl = structuredClone(current(el))
  newEl.id = createElementId()
  if (newEl.groupId) {
    if (!groupIdMap.has(newEl.groupId)) {
      groupIdMap.set(newEl.groupId, createElementId())
    }
    newEl.groupId = groupIdMap.get(newEl.groupId)!
  }
  regenerateNestedIds(newEl)
  if (newEl.type === 'line') {
    newEl.x += 20
  } else {
    newEl.x += 20
    newEl.y += 20
  }
  return newEl
}
