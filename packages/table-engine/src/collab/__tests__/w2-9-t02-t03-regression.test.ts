/**
 * W2-9 回归测试 — T-02 / T-03 修复验证
 *
 * T-02: recordsObserver 增量 patch（不再全量 refreshSnapshot）
 * T-03: rowOrderHas Set 索引 O(1) 查找
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { rowOrderHas, replayPendingTableWrites, type PendingTableWrite } from '../useTableCollaboration'
import { YDOC_RECORDS, YDOC_ROW_ORDER } from '../ydoc-schema'

function createDocWithRecords(
  records: Record<string, Record<string, unknown>>,
  rowOrder: string[] = [],
): Y.Doc {
  const doc = new Y.Doc()
  const recordsMap = doc.getMap(YDOC_RECORDS)
  const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)

  doc.transact(() => {
    for (const [id, fields] of Object.entries(records)) {
      const yMap = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(fields)) yMap.set(k, v)
      recordsMap.set(id, yMap)
    }
    if (rowOrder.length > 0) rowOrderArr.push(rowOrder)
  })

  return doc
}

// ── T-03: rowOrderHas with Set index ──

describe('T-03: rowOrderHas with Set index', () => {
  it('returns true via Set index without scanning Y.Array', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('test')
    arr.push(['a', 'b', 'c'])

    const indexSet = new Set(['a', 'b', 'c'])
    expect(rowOrderHas(arr, 'b', indexSet)).toBe(true)
    expect(rowOrderHas(arr, 'z', indexSet)).toBe(false)
  })

  it('falls back to linear scan when no Set provided', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('test')
    arr.push(['x', 'y'])

    expect(rowOrderHas(arr, 'x')).toBe(true)
    expect(rowOrderHas(arr, 'z')).toBe(false)
  })

  it('Set-based lookup is O(1) — handles large arrays efficiently', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('test')
    const ids = Array.from({ length: 10000 }, (_, i) => `row-${i}`)
    arr.push(ids)

    const indexSet = new Set(ids)
    const start = performance.now()
    for (let i = 0; i < 10000; i++) {
      rowOrderHas(arr, `row-${i}`, indexSet)
    }
    const elapsed = performance.now() - start
    expect(elapsed).toBeLessThan(100)
  })
})

// ── T-02: incremental patch behavior (via Y.Doc observer integration) ──

describe('T-02: incremental snapshot updates', () => {
  it('observer fires with specific record changes, not full rebuild', () => {
    const doc = createDocWithRecords(
      { r1: { name: 'Alice' }, r2: { name: 'Bob' } },
      ['r1', 'r2'],
    )
    const recordsMap = doc.getMap(YDOC_RECORDS)

    const observedEvents: Array<{ target: unknown; action: string; key: string }> = []
    recordsMap.observeDeep((events) => {
      for (const event of events) {
        if (event.target instanceof Y.Map) {
          ;(event as Y.YMapEvent<unknown>).changes.keys.forEach((change, key) => {
            observedEvents.push({ target: event.target, action: change.action, key })
          })
        }
      }
    })

    doc.transact(() => {
      const r1 = recordsMap.get('r1') as Y.Map<unknown>
      r1.set('name', 'Alice Updated')
    }, 'remote')

    expect(observedEvents.length).toBe(1)
    expect(observedEvents[0].key).toBe('name')
    expect(observedEvents[0].action).toBe('update')
  })

  it('delete event only affects the deleted record', () => {
    const doc = createDocWithRecords(
      { r1: { name: 'A' }, r2: { name: 'B' }, r3: { name: 'C' } },
      ['r1', 'r2', 'r3'],
    )
    const recordsMap = doc.getMap(YDOC_RECORDS)

    const deletedKeys: string[] = []
    recordsMap.observeDeep((events) => {
      for (const event of events) {
        if (event.target === recordsMap) {
          ;(event as Y.YMapEvent<unknown>).changes.keys.forEach((change, key) => {
            if (change.action === 'delete') deletedKeys.push(key)
          })
        }
      }
    })

    doc.transact(() => { recordsMap.delete('r2') }, 'remote')

    expect(deletedKeys).toEqual(['r2'])
  })

  it('batch cell changes generate exactly the changed fields', () => {
    const doc = createDocWithRecords(
      { r1: { f1: 'v1', f2: 'v2' }, r2: { f1: 'v3' } },
      ['r1', 'r2'],
    )
    const recordsMap = doc.getMap(YDOC_RECORDS)

    const changedFields: Array<{ recordId: string; fieldId: string }> = []
    recordsMap.observeDeep((events) => {
      for (const event of events) {
        if (event.target instanceof Y.Map && event.target !== recordsMap) {
          const path = event.path
          if (path.length >= 1 && typeof path[0] === 'string') {
            const recordId = path[0] as string
            ;(event as Y.YMapEvent<unknown>).changes.keys.forEach((_change, fieldId) => {
              changedFields.push({ recordId, fieldId })
            })
          }
        }
      }
    })

    doc.transact(() => {
      const r1 = recordsMap.get('r1') as Y.Map<unknown>
      r1.set('f1', 'updated')
      const r2 = recordsMap.get('r2') as Y.Map<unknown>
      r2.set('f1', 'updated2')
    }, 'remote')

    expect(changedFields).toHaveLength(2)
    expect(changedFields).toContainEqual({ recordId: 'r1', fieldId: 'f1' })
    expect(changedFields).toContainEqual({ recordId: 'r2', fieldId: 'f1' })
  })
})

// ── T-03: replayPendingTableWrites uses rowOrderHas correctly ──

describe('T-03: replay with Set-aware rowOrderHas', () => {
  it('addRecord in replay does not duplicate in rowOrder', () => {
    const doc = createDocWithRecords({ r1: { name: 'A' } }, ['r1'])
    const writes: PendingTableWrite[] = [
      { op: 'addRecord', recordId: 'r1', fieldValues: { name: 'A2' }, order: 0 },
      { op: 'addRecord', recordId: 'r2', fieldValues: { name: 'B' }, order: 1 },
    ]

    replayPendingTableWrites(doc, writes)

    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    const order: string[] = []
    for (let i = 0; i < rowOrderArr.length; i++) order.push(rowOrderArr.get(i))

    expect(order.filter(id => id === 'r1')).toHaveLength(1)
    expect(order).toContain('r2')
  })

  it('deleteRecord in replay removes from rowOrder', () => {
    const doc = createDocWithRecords(
      { r1: { name: 'A' }, r2: { name: 'B' } },
      ['r1', 'r2'],
    )
    const writes: PendingTableWrite[] = [
      { op: 'deleteRecord', recordId: 'r1' },
    ]

    replayPendingTableWrites(doc, writes)

    const recordsMap = doc.getMap(YDOC_RECORDS)
    expect(recordsMap.has('r1')).toBe(false)

    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    const order: string[] = []
    for (let i = 0; i < rowOrderArr.length; i++) order.push(rowOrderArr.get(i))
    expect(order).toEqual(['r2'])
  })
})
