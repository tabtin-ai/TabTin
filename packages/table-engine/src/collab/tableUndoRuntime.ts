import * as Y from 'yjs'

import { YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_ROW_ORDER_MAP } from './ydoc-schema'

interface TableUndoRuntimeEntry {
  undoManager: Y.UndoManager
  leaseCount: number
}

export interface TableUndoRuntimeLease {
  undoManager: Y.UndoManager
  release(): void
}

const runtimeByDocument = new WeakMap<Y.Doc, TableUndoRuntimeEntry>()

export function acquireTableUndoRuntime(ydoc: Y.Doc): TableUndoRuntimeLease {
  let entry = runtimeByDocument.get(ydoc)
  if (!entry) {
    entry = {
      undoManager: new Y.UndoManager([
        ydoc.getMap(YDOC_RECORDS),
        ydoc.getArray<string>(YDOC_ROW_ORDER),
        ydoc.getMap<string>(YDOC_ROW_ORDER_MAP),
      ], {
        trackedOrigins: new Set(['local']),
        captureTimeout: 500,
      }),
      leaseCount: 0,
    }
    runtimeByDocument.set(ydoc, entry)
  }
  entry.leaseCount += 1

  let released = false
  return {
    undoManager: entry.undoManager,
    release() {
      if (released) return
      released = true
      entry!.leaseCount -= 1
      if (entry!.leaseCount > 0) return
      if (runtimeByDocument.get(ydoc) !== entry) return
      runtimeByDocument.delete(ydoc)
      entry!.undoManager.destroy()
    },
  }
}
