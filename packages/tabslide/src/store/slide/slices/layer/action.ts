import { produce } from 'immer'
import type { PPTElement } from '../../../../types/slides'
import { createElementId } from '../../../../utils/id'
import {
  compactSelectionToContiguousBlock,
  ensureGroupContiguousBlock,
  expandIdsToAtomicBlocks,
  expandSelectionToWholeGroups,
  findGroupSpan,
  moveSelectionByOneLayer,
  moveSelectionToEdge,
  reorderGroupBlock,
  resolveMovableLayerIds,
} from '../../layer-operations'
import { applySaveState } from '../../store-helpers'
import type { SlideStoreGet, SlideStoreSet, SlideStoreState } from '../../slide-store-types'

type LayerMove = 'forward' | 'backward' | 'front' | 'back'

export type LayerAction = Pick<
  SlideStoreState,
  | 'bringForward'
  | 'sendBackward'
  | 'bringToFront'
  | 'sendToBack'
  | 'bringForwardSelection'
  | 'sendBackwardSelection'
  | 'bringSelectionToFront'
  | 'sendSelectionToBack'
  | 'toggleVisibility'
  | 'setVisibility'
  | 'toggleLock'
  | 'setLocked'
  | 'setGroupName'
  | 'reorderElements'
  | 'groupElements'
  | 'ungroupElements'
>

export const createLayerSlice = (
  set: SlideStoreSet,
  get: SlideStoreGet,
  _api?: unknown,
): LayerAction => new LayerActionImpl(set, get, _api)

export class LayerActionImpl {
  readonly #set: SlideStoreSet
  readonly #get: SlideStoreGet

  constructor(set: SlideStoreSet, get: SlideStoreGet, _api?: unknown) {
    void _api
    this.#set = set
    this.#get = get
  }

  bringForward = (id: string) => this.#get().bringForwardSelection([id])

  sendBackward = (id: string) => this.#get().sendBackwardSelection([id])

  bringToFront = (id: string) => this.#get().bringSelectionToFront([id])

  sendToBack = (id: string) => this.#get().sendSelectionToBack([id])

  bringForwardSelection = (ids: string[]) => this.#moveSelection(ids, 'forward')

  sendBackwardSelection = (ids: string[]) => this.#moveSelection(ids, 'backward')

  bringSelectionToFront = (ids: string[]) => this.#moveSelection(ids, 'front')

  sendSelectionToBack = (ids: string[]) => this.#moveSelection(ids, 'back')

  toggleVisibility: SlideStoreState['toggleVisibility'] = (id) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        const el = page.elements.find((e) => e.id === id)
        if (!el) return
        const nextVisible = el.visible === false
        el.visible = nextVisible ? undefined : false
        if (!nextVisible) clearHiddenSelection(s, new Set([id]))
        applySaveState(s, 'unsaved')
      }),
    )

  setVisibility: SlideStoreState['setVisibility'] = (ids, visible) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page || ids.length === 0) return
        const normalizedIds = new Set(expandIdsToAtomicBlocks(page.elements, ids))
        let changed = false
        for (const el of page.elements) {
          if (!normalizedIds.has(el.id)) continue
          const next = visible ? undefined : false
          if (el.visible !== next) {
            el.visible = next
            changed = true
          }
        }
        if (!changed) return
        if (!visible) clearHiddenSelection(s, normalizedIds)
        applySaveState(s, 'unsaved')
      }),
    )

  toggleLock: SlideStoreState['toggleLock'] = (id) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        const el = page.elements.find((e) => e.id === id)
        if (!el) return
        el.locked = !el.locked
        applySaveState(s, 'unsaved')
      }),
    )

  setLocked: SlideStoreState['setLocked'] = (ids, locked) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page || ids.length === 0) return
        const normalizedIds = new Set(expandIdsToAtomicBlocks(page.elements, ids))
        let changed = false
        for (const el of page.elements) {
          if (!normalizedIds.has(el.id)) continue
          if (el.locked !== locked) {
            el.locked = locked
            changed = true
          }
        }
        if (!changed) return
        applySaveState(s, 'unsaved')
      }),
    )

  setGroupName: SlideStoreState['setGroupName'] = (ids, groupName) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page || ids.length === 0) return
        const normalizedIds = new Set(expandIdsToAtomicBlocks(page.elements, ids))
        if (normalizedIds.size === 0) return
        const nextGroupName = groupName.trim()
        const next = nextGroupName ? nextGroupName : undefined
        let changed = false
        for (const el of page.elements) {
          if (!normalizedIds.has(el.id)) continue
          if (el.groupName !== next) {
            el.groupName = next
            changed = true
          }
        }
        if (!changed) return
        applySaveState(s, 'unsaved')
      }),
    )

  reorderElements: SlideStoreState['reorderElements'] = (from, to) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        if (from === to) return
        const els = page.elements
        if (from < 0 || from >= els.length || to < 0 || to >= els.length) return
        const moving = els[from]
        if (!moving || moving.locked) return
        if (moving.groupId) {
          const span = findGroupSpan(els, moving.groupId)
          if (span && span.members.length > 1) {
            if (span.members.some((member) => member.locked)) return
            if (reorderGroupBlock(els, moving.groupId, to)) applySaveState(s, 'unsaved')
            return
          }
        }
        const [moved] = els.splice(from, 1)
        els.splice(to, 0, moved)
        applySaveState(s, 'unsaved')
      }),
    )

  groupElements: SlideStoreState['groupElements'] = (ids) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return
        const normalizedIds = expandSelectionToWholeGroups(page, ids)
        if (normalizedIds.length < 2) return

        const selectedSet = new Set(normalizedIds)
        compactSelectionToContiguousBlock(page, selectedSet)

        const groupId = createElementId()
        for (const el of page.elements) {
          if (selectedSet.has(el.id)) {
            el.groupId = groupId
            el.groupName = undefined
          }
        }
        s.selectedElementIds = page.elements
          .filter((el) => selectedSet.has(el.id))
          .map((el) => el.id)
        applySaveState(s, 'unsaved')
      }),
    )

  ungroupElements: SlideStoreState['ungroupElements'] = (ids) =>
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page) return

        const normalizedIds = expandSelectionToWholeGroups(page, ids)
        if (normalizedIds.length === 0) return
        const idSet = new Set(normalizedIds)
        let changed = false

        for (const el of page.elements) {
          if (idSet.has(el.id) && el.groupId) {
            el.groupId = undefined
            el.groupName = undefined
            changed = true
          }
        }
        if (!changed) return
        s.selectedElementIds = page.elements
          .filter((el) => idSet.has(el.id))
          .map((el) => el.id)
        applySaveState(s, 'unsaved')
      }),
    )

  #moveSelection(ids: string[], move: LayerMove) {
    this.#set(
      produce((s: SlideStoreState) => {
        const page = s.presentation?.pages[s.currentPageIndex]
        if (!page || ids.length === 0) return

        const selectedIds = expandIdsToAtomicBlocks(page.elements, ids)
        if (selectedIds.length === 0) return
        const movableIds = resolveMovableLayerIds(page.elements, ids)
        if (movableIds.length === 0) return

        const selectedSet = new Set(movableIds)
        normalizeSelectedGroups(page.elements, selectedSet)

        const changed = move === 'forward' || move === 'backward'
          ? moveSelectionByOneLayer(page.elements, selectedSet, move)
          : moveSelectionToEdge(page.elements, selectedSet, move)
        if (!changed) return

        const selectedIdsSet = new Set(selectedIds)
        s.selectedElementIds = page.elements
          .filter((el) => selectedIdsSet.has(el.id))
          .map((el) => el.id)
        applySaveState(s, 'unsaved')
      }),
    )
  }
}

const normalizeSelectedGroups = (
  elements: PPTElement[],
  selectedSet: Set<string>,
) => {
  const groupIds = new Set<string>()
  for (const el of elements) {
    if (selectedSet.has(el.id) && el.groupId) {
      groupIds.add(el.groupId)
    }
  }
  for (const gid of groupIds) {
    ensureGroupContiguousBlock(elements, gid)
  }
}

const clearHiddenSelection = (s: SlideStoreState, hiddenIds: Set<string>) => {
  s.selectedElementIds = s.selectedElementIds.filter((selectedId) => !hiddenIds.has(selectedId))
  if (s.selectedElementIds.length === 0) {
    s.isEditing = false
    s.editingElementId = null
  }
}
