import type { HistoryStoreState } from './history-store-types'

export const initialHistoryStoreState = {
  undoStack: [],
  redoStack: [],
  isCollabMode: false,
  _collabUndoFn: null,
  _collabRedoFn: null,
  _collabCanUndoFn: null,
  _collabCanRedoFn: null,
  _lastPushedPages: null,
  _debounceLocked: false,
  _debounceTimer: null,
} satisfies Pick<
  HistoryStoreState,
  | 'undoStack'
  | 'redoStack'
  | 'isCollabMode'
  | '_collabUndoFn'
  | '_collabRedoFn'
  | '_collabCanUndoFn'
  | '_collabCanRedoFn'
  | '_lastPushedPages'
  | '_debounceLocked'
  | '_debounceTimer'
>
