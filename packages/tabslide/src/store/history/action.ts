import {
  DEBOUNCE_MS,
  MAX_HISTORY,
  MAX_MEMORY_BYTES,
  trimStackByMemory,
} from './helpers'
import type {
  HistoryStoreGet,
  HistoryStoreSet,
  HistoryStoreState,
} from './history-store-types'

export type HistoryAction = Pick<
  HistoryStoreState,
  | 'canUndo'
  | 'canRedo'
  | 'pushSnapshot'
  | 'pushSnapshotDebounced'
  | 'undo'
  | 'redo'
  | 'clear'
  | 'setCollabUndoRedo'
>

export const createHistorySlice = (
  set: HistoryStoreSet,
  get: HistoryStoreGet,
  _api?: unknown,
): HistoryAction => new HistoryActionImpl(set, get, _api)

export class HistoryActionImpl {
  readonly #set: HistoryStoreSet
  readonly #get: HistoryStoreGet

  constructor(set: HistoryStoreSet, get: HistoryStoreGet, _api?: unknown) {
    void _api
    this.#set = set
    this.#get = get
  }

  canUndo = () => {
    const s = this.#get()
    if (s._collabCanUndoFn) return s._collabCanUndoFn()
    return s.undoStack.length > 0
  }

  canRedo = () => {
    const s = this.#get()
    if (s._collabCanRedoFn) return s._collabCanRedoFn()
    return s.redoStack.length > 0
  }

  pushSnapshot: HistoryStoreState['pushSnapshot'] = (pages) => {
    if (this.#get().isCollabMode) return

    this.#set((s) => {
      if (pages === s._lastPushedPages) {
        if (s.redoStack.length === 0) return s
        return { ...s, redoStack: [] }
      }
      const newUndoStack = trimStackByMemory(
        [...s.undoStack.slice(-(MAX_HISTORY - 1)), structuredClone(pages)],
        MAX_MEMORY_BYTES,
      )
      return {
        ...s,
        _lastPushedPages: pages,
        undoStack: newUndoStack,
        redoStack: [],
      }
    })
  }

  pushSnapshotDebounced: HistoryStoreState['pushSnapshotDebounced'] = (pages) => {
    const s = this.#get()
    if (s.isCollabMode) return

    if (!s._debounceLocked) {
      this.#set({ _debounceLocked: true })
      this.#get().pushSnapshot(pages)
    }

    const prevTimer = this.#get()._debounceTimer
    if (prevTimer) clearTimeout(prevTimer)
    const timer = setTimeout(() => {
      this.#set({ _debounceLocked: false, _debounceTimer: null })
    }, DEBOUNCE_MS)
    this.#set({ _debounceTimer: timer })
  }

  undo: HistoryStoreState['undo'] = (currentPages) => {
    const s = this.#get()
    if (s._collabUndoFn) {
      s._collabUndoFn()
      return null
    }

    const { undoStack, redoStack } = s
    if (undoStack.length === 0) return null
    const snapshot = undoStack[undoStack.length - 1]
    const newRedoStack = trimStackByMemory(
      [...redoStack.slice(-(MAX_HISTORY - 1)), structuredClone(currentPages)],
      MAX_MEMORY_BYTES,
    )
    this.#set({
      _lastPushedPages: null,
      undoStack: undoStack.slice(0, -1),
      redoStack: newRedoStack,
    })
    return structuredClone(snapshot)
  }

  redo: HistoryStoreState['redo'] = (currentPages) => {
    const s = this.#get()
    if (s._collabRedoFn) {
      s._collabRedoFn()
      return null
    }

    const { undoStack, redoStack } = s
    if (redoStack.length === 0) return null
    const snapshot = redoStack[redoStack.length - 1]
    const newUndoStack = trimStackByMemory(
      [...undoStack.slice(-(MAX_HISTORY - 1)), structuredClone(currentPages)],
      MAX_MEMORY_BYTES,
    )
    this.#set({
      _lastPushedPages: null,
      redoStack: redoStack.slice(0, -1),
      undoStack: newUndoStack,
    })
    return structuredClone(snapshot)
  }

  clear = () => {
    const prevTimer = this.#get()._debounceTimer
    if (prevTimer) clearTimeout(prevTimer)
    this.#set({
      undoStack: [],
      redoStack: [],
      _lastPushedPages: null,
      _debounceLocked: false,
      _debounceTimer: null,
    })
  }

  setCollabUndoRedo: HistoryStoreState['setCollabUndoRedo'] = (fns) => {
    if (fns) {
      const prevTimer = this.#get()._debounceTimer
      if (prevTimer) clearTimeout(prevTimer)
      this.#set({
        isCollabMode: true,
        undoStack: [],
        redoStack: [],
        _collabUndoFn: fns.undo,
        _collabRedoFn: fns.redo,
        _collabCanUndoFn: fns.canUndo,
        _collabCanRedoFn: fns.canRedo,
        _lastPushedPages: null,
        _debounceLocked: false,
        _debounceTimer: null,
      })
    } else {
      this.#set({
        isCollabMode: false,
        _collabUndoFn: null,
        _collabRedoFn: null,
        _collabCanUndoFn: null,
        _collabCanRedoFn: null,
      })
    }
  }
}
