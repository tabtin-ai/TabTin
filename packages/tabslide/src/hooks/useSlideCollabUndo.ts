import { useCallback, useEffect, useRef, useState } from 'react'
import * as Y from 'yjs'
import { useHistoryStore } from '../store/history'
import {
  getPagesMap,
  getPageOrderArray,
  getPageOrderMap,
} from '../collab/ydoc-schema'

export function useSlideCollabUndo(
  ydoc: Y.Doc | null,
  isFallback: boolean,
  canEdit: boolean = true,
): {
  collabUndo: () => void
  collabRedo: () => void
  collabCanUndo: boolean
  collabCanRedo: boolean
} {
  const undoManagerRef = useRef<Y.UndoManager | null>(null)

  useEffect(() => {
    if (!ydoc || isFallback) {
      undoManagerRef.current?.destroy()
      undoManagerRef.current = null
      return
    }

    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)
    const pageOrderMapForUndo = getPageOrderMap(ydoc)
    const undoManager = new Y.UndoManager([pagesMap, pageOrderArr, pageOrderMapForUndo], {
      trackedOrigins: new Set(['local']),
      captureTimeout: 500,
    })

    undoManagerRef.current = undoManager
    return () => {
      undoManager.destroy()
      undoManagerRef.current = null
    }
  }, [ydoc, isFallback])

  useEffect(() => {
    const undoManager = undoManagerRef.current
    if (!undoManager || isFallback || !canEdit) return
    useHistoryStore.getState().setCollabUndoRedo({
      undo: () => { if (canEdit) undoManager.undo() },
      redo: () => { if (canEdit) undoManager.redo() },
      canUndo: () => canEdit && undoManager.undoStack.length > 0,
      canRedo: () => canEdit && undoManager.redoStack.length > 0,
    })
    return () => {
      useHistoryStore.getState().setCollabUndoRedo(null)
    }
  }, [ydoc, isFallback, canEdit])

  const [undoRedoVersion, setUndoRedoVersion] = useState(0)
  useEffect(() => {
    const undoManager = undoManagerRef.current
    if (!undoManager) return
    const onStackChange = () => setUndoRedoVersion(v => v + 1)
    undoManager.on('stack-item-added', onStackChange)
    undoManager.on('stack-item-popped', onStackChange)
    return () => {
      undoManager.off('stack-item-added', onStackChange)
      undoManager.off('stack-item-popped', onStackChange)
    }
  }, [ydoc, isFallback])

  const collabUndo = useCallback(() => {
    if (canEdit) undoManagerRef.current?.undo()
  }, [canEdit])

  const collabRedo = useCallback(() => {
    if (canEdit) undoManagerRef.current?.redo()
  }, [canEdit])

  const undoManager = undoManagerRef.current
  void undoRedoVersion

  return {
    collabUndo,
    collabRedo,
    collabCanUndo: canEdit && undoManager ? undoManager.undoStack.length > 0 : false,
    collabCanRedo: canEdit && undoManager ? undoManager.redoStack.length > 0 : false,
  }
}
