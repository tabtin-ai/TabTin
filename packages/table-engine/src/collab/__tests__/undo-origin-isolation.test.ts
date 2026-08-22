/**
 * : mirror / replay 写入不得进入 Yjs UndoManager
 *
 * UndoManager.trackedOrigins 只含 'local'；系统同步用 'mirror'。
 */

import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import {
  replayPendingTableWrites,
  COLLAB_ORIGIN_LOCAL,
  COLLAB_ORIGIN_MIRROR,
  type PendingTableWrite,
} from '../useTableCollaboration'
import { YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_ROW_ORDER_MAP } from '../ydoc-schema'

function createTrackedDoc(): { doc: Y.Doc; um: Y.UndoManager } {
  const doc = new Y.Doc()
  const recordsMap = doc.getMap(YDOC_RECORDS)
  const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
  const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)
  const um = new Y.UndoManager([recordsMap, rowOrderArr, rowOrderMap], {
    trackedOrigins: new Set([COLLAB_ORIGIN_LOCAL]),
    captureTimeout: 0,
  })
  return { doc, um }
}

describe('#4159 UndoManager origin isolation', () => {
  it('local origin cell edit enters undo stack', () => {
    const { doc, um } = createTrackedDoc()
    const recordsMap = doc.getMap(YDOC_RECORDS)

    doc.transact(() => {
      const record = new Y.Map<unknown>()
      record.set('f1', 'v1')
      recordsMap.set('r1', record)
    }, COLLAB_ORIGIN_LOCAL)

    expect(um.undoStack.length).toBeGreaterThan(0)
    um.destroy()
  })

  it('mirror origin cell edit does not enter undo stack', () => {
    const { doc, um } = createTrackedDoc()
    const recordsMap = doc.getMap(YDOC_RECORDS)

    doc.transact(() => {
      const record = new Y.Map<unknown>()
      record.set('f1', 'mirrored')
      recordsMap.set('r1', record)
    }, COLLAB_ORIGIN_MIRROR)

    expect(um.undoStack.length).toBe(0)
    um.destroy()
  })

  it('replayPendingTableWrites uses mirror origin and does not pollute undo', () => {
    const { doc, um } = createTrackedDoc()

    const writes: PendingTableWrite[] = [
      { op: 'setCellValue', recordId: 'r1', fieldId: 'f1', value: 'replayed' },
      {
        op: 'batchSetCellValues',
        changes: [{ recordId: 'r2', fieldId: 'f1', value: 'batch' }],
      },
      { op: 'addRecord', recordId: 'r3', fieldValues: { f1: 'new' }, order: 1 },
    ]
    replayPendingTableWrites(doc, writes)

    expect(um.undoStack.length).toBe(0)

    const recordsMap = doc.getMap(YDOC_RECORDS)
    expect((recordsMap.get('r1') as Y.Map<unknown>).get('f1')).toBe('replayed')
    expect((recordsMap.get('r2') as Y.Map<unknown>).get('f1')).toBe('batch')
    expect((recordsMap.get('r3') as Y.Map<unknown>).get('f1')).toBe('new')
    um.destroy()
  })

  it('clear() empties undo/redo stacks after local edits', () => {
    const { doc, um } = createTrackedDoc()
    const recordsMap = doc.getMap(YDOC_RECORDS)

    doc.transact(() => {
      const record = new Y.Map<unknown>()
      record.set('f1', 'v1')
      recordsMap.set('r1', record)
    }, COLLAB_ORIGIN_LOCAL)
    expect(um.undoStack.length).toBeGreaterThan(0)

    um.undo()
    expect(um.redoStack.length).toBeGreaterThan(0)

    um.clear()
    expect(um.undoStack.length).toBe(0)
    expect(um.redoStack.length).toBe(0)
    um.destroy()
  })
})
