import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import { replayPendingTableWrites, rowOrderHas, type PendingTableWrite } from '../useTableCollaboration'

function createDocWithRecords(
  records: Record<string, Record<string, unknown>>,
  rowOrder: string[] = []
): Y.Doc {
  const doc = new Y.Doc()
  const recordsMap = doc.getMap('records')
  const rowOrderArr = doc.getArray<string>('rowOrder')

  doc.transact(() => {
    for (const [id, fields] of Object.entries(records)) {
      const yMap = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(fields)) {
        yMap.set(k, v)
      }
      recordsMap.set(id, yMap)
    }
    if (rowOrder.length > 0) {
      rowOrderArr.push(rowOrder)
    }
  })

  return doc
}

describe('rowOrderHas', () => {
  it('returns true when id exists in array', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('test')
    arr.push(['a', 'b', 'c'])

    expect(rowOrderHas(arr, 'b')).toBe(true)
  })

  it('returns false when id does not exist', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('test')
    arr.push(['a', 'b'])

    expect(rowOrderHas(arr, 'z')).toBe(false)
  })

  it('returns false for empty array', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('test')

    expect(rowOrderHas(arr, 'a')).toBe(false)
  })
})

describe('replayPendingTableWrites', () => {
  it('does nothing for empty writes', () => {
    const doc = createDocWithRecords({ r1: { f1: 'hello' } }, ['r1'])
    replayPendingTableWrites(doc, [])

    const recordsMap = doc.getMap('records')
    const r1 = recordsMap.get('r1') as Y.Map<unknown>
    expect(r1.get('f1')).toBe('hello')
  })

  it('replays setCellValue on existing record', () => {
    const doc = createDocWithRecords({ r1: { f1: 'old' } }, ['r1'])

    replayPendingTableWrites(doc, [
      { op: 'setCellValue', recordId: 'r1', fieldId: 'f1', value: 'new' },
    ])

    const r1 = doc.getMap('records').get('r1') as Y.Map<unknown>
    expect(r1.get('f1')).toBe('new')
  })

  it('setCellValue creates record map if missing', () => {
    const doc = createDocWithRecords({}, [])

    replayPendingTableWrites(doc, [
      { op: 'setCellValue', recordId: 'r_new', fieldId: 'f1', value: 'val' },
    ])

    const r = doc.getMap('records').get('r_new') as Y.Map<unknown>
    expect(r).toBeDefined()
    expect(r.get('f1')).toBe('val')
  })

  it('replays batchSetCellValues', () => {
    const doc = createDocWithRecords({ r1: { f1: 'a' }, r2: { f1: 'b' } }, ['r1', 'r2'])

    replayPendingTableWrites(doc, [
      {
        op: 'batchSetCellValues',
        changes: [
          { recordId: 'r1', fieldId: 'f1', value: 'A' },
          { recordId: 'r2', fieldId: 'f1', value: 'B' },
        ],
      },
    ])

    const r1 = doc.getMap('records').get('r1') as Y.Map<unknown>
    const r2 = doc.getMap('records').get('r2') as Y.Map<unknown>
    expect(r1.get('f1')).toBe('A')
    expect(r2.get('f1')).toBe('B')
  })

  it('addRecord appends to rowOrder and sets fields', () => {
    const doc = createDocWithRecords({ r1: { f1: 'x' } }, ['r1'])

    replayPendingTableWrites(doc, [
      { op: 'addRecord', recordId: 'r2', fieldValues: { f1: 'hello' }, order: 2 },
    ])

    const r2 = doc.getMap('records').get('r2') as Y.Map<unknown>
    expect(r2.get('f1')).toBe('hello')
    expect(r2.get('__order')).toBe(2)

    const rowOrder = doc.getArray<string>('rowOrder')
    expect(rowOrder.get(1)).toBe('r2')
  })

  it('addRecord is idempotent — does not duplicate in rowOrder', () => {
    const doc = createDocWithRecords({ r1: { f1: 'x' } }, ['r1', 'r2'])
    const recordsMap = doc.getMap('records')
    const yR2 = new Y.Map<unknown>()
    yR2.set('f1', 'old')
    recordsMap.set('r2', yR2)

    replayPendingTableWrites(doc, [
      { op: 'addRecord', recordId: 'r2', fieldValues: { f1: 'new' }, order: 5 },
    ])

    const rowOrder = doc.getArray<string>('rowOrder')
    expect(rowOrder.length).toBe(2)

    const r2 = recordsMap.get('r2') as Y.Map<unknown>
    expect(r2.get('f1')).toBe('new')
  })

  it('multiple addRecords are sorted by order', () => {
    const doc = createDocWithRecords({}, [])

    const writes: PendingTableWrite[] = [
      { op: 'addRecord', recordId: 'r3', fieldValues: {}, order: 30 },
      { op: 'addRecord', recordId: 'r1', fieldValues: {}, order: 10 },
      { op: 'addRecord', recordId: 'r2', fieldValues: {}, order: 20 },
    ]
    replayPendingTableWrites(doc, writes)

    const rowOrder = doc.getArray<string>('rowOrder')
    expect(rowOrder.get(0)).toBe('r1')
    expect(rowOrder.get(1)).toBe('r2')
    expect(rowOrder.get(2)).toBe('r3')
  })

  it('deleteRecord removes from both records and rowOrder', () => {
    const doc = createDocWithRecords({ r1: { f1: 'a' }, r2: { f1: 'b' } }, ['r1', 'r2'])

    replayPendingTableWrites(doc, [
      { op: 'deleteRecord', recordId: 'r1' },
    ])

    expect(doc.getMap('records').has('r1')).toBe(false)
    const rowOrder = doc.getArray<string>('rowOrder')
    expect(rowOrder.length).toBe(1)
    expect(rowOrder.get(0)).toBe('r2')
  })

  it('mixed operations replay in correct order', () => {
    const doc = createDocWithRecords({ r1: { f1: 'old' } }, ['r1'])

    replayPendingTableWrites(doc, [
      { op: 'setCellValue', recordId: 'r1', fieldId: 'f1', value: 'updated' },
      { op: 'addRecord', recordId: 'r2', fieldValues: { f1: 'new' }, order: 5 },
      { op: 'deleteRecord', recordId: 'r1' },
    ])

    expect(doc.getMap('records').has('r1')).toBe(false)
    const r2 = doc.getMap('records').get('r2') as Y.Map<unknown>
    expect(r2.get('f1')).toBe('new')
    expect(doc.getArray<string>('rowOrder').length).toBe(1)
  })
})
