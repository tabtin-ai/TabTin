import { createContext, useContext } from 'react'
import type { UseUndoRedoResult } from '../../controller/useUndoRedo'

export type UndoRedoContextValue = Pick<
  UseUndoRedoResult,
  | 'handleUndo'
  | 'handleRedo'
  | 'canUndo'
  | 'canRedo'
  | 'isUndoing'
  | 'isRedoing'
  | 'refreshStacks'
  | 'recordBackendUndoable'
>

const UndoRedoContext = createContext<UndoRedoContextValue | null>(null)

export const UndoRedoProvider = UndoRedoContext.Provider

export function useUndoRedoContext(): UndoRedoContextValue | null {
  return useContext(UndoRedoContext)
}
