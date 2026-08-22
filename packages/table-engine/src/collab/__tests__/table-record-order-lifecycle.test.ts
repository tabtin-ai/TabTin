import { describe, expect, it } from 'vitest'
import * as Y from 'yjs'

import { RECORD_POSITION_FIELD } from '../record-position'
import {
  applyTableRecordOrderPlan,
  getEffectiveTableRecordOrder,
  insertTableRecordAtomically,
  planLegacyTableRecordOrderReconcile,
  planTableRecordOrderReconcile,
  reorderTableRecordsAtomically,
  resolveLegacyTableRecordOrderIntent,
} from '../table-record-order'
import { acquireTableUndoRuntime } from '../tableUndoRuntime'
import { getOrderedIds, setOrderedIds } from '../y-utils'
import { YDOC_META, YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_ROW_ORDER_MAP } from '../ydoc-schema'

const COLLAB_ORIGIN_LOCAL = 'local'

describe('协作记录顺序的 Undo/Redo 生命周期', () => {
  it('b0I/b0I 新增先分配再原子写入，不再把重复 legacy bound 交给 FI', () => {
    const doc = new Y.Doc()
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrder = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)
    doc.transact(() => {
      for (const [recordId, order] of [['r1', 1], ['r2', 2]] as const) {
        const record = new Y.Map<unknown>()
        record.set('__order', order)
        records.set(recordId, record)
      }
      rowOrder.push(['r1', 'r2'])
      rowOrderMap.set('r1', 'b0I')
      rowOrderMap.set('r2', 'b0I')
    }, 'seed')

    expect(() => insertTableRecordAtomically(doc, {
      recordId: 'new-row',
      fieldValues: { title: 'new' },
      orderContext: { anchor_record_id: 'r1', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })).not.toThrow()
    expect((records.get('new-row') as Y.Map<unknown>).get(RECORD_POSITION_FIELD))
      .toMatch(/^p1:/)
    expect(getEffectiveTableRecordOrder(doc)).toEqual(['r1', 'new-row', 'r2'])
    expect(getOrderedIds(rowOrderMap)).toEqual(['r1', 'new-row', 'r2'])
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD))
      .toMatch(/^p1:/)
  })

  it('reprojects only the numeric duplicate suffix when rowOrderMap bounds are distinct', () => {
    const doc = new Y.Doc()
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrder = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)
    const rows = [
      ['left', 1, 'b0G'],
      ['right-a', 1, 'b0I'],
      ['right-b', 1, 'b0K'],
      ['tail', 2, 'b0M'],
      ['far-tail', 3, 'b0O'],
    ] as const
    for (const [recordId, order, mapPosition] of rows) {
      const record = new Y.Map<unknown>()
      record.set('__order', order)
      records.set(recordId, record)
      rowOrderMap.set(recordId, mapPosition)
    }
    rowOrder.push(rows.map(([recordId]) => recordId))

    insertTableRecordAtomically(doc, {
      recordId: 'new-row',
      fieldValues: {},
      orderContext: { anchor_record_id: 'left', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })

    const expectedOrder = ['left', 'new-row', 'right-a', 'right-b', 'tail', 'far-tail']
    expect(getEffectiveTableRecordOrder(doc)).toEqual(expectedOrder)
    const legacyOrders = expectedOrder.map(recordId =>
      (records.get(recordId) as Y.Map<unknown>).get('__order') as number,
    )
    expect(legacyOrders.every((order, index) => index === 0 || legacyOrders[index - 1] < order))
      .toBe(true)
    expect((records.get('left') as Y.Map<unknown>).get('__order')).toBe(1)
    expect((records.get('tail') as Y.Map<unknown>).get('__order')).toBe(2)
    expect((records.get('far-tail') as Y.Map<unknown>).get('__order')).toBe(3)
    expect(rowOrderMap.get('left')).toBe('b0G')
    expect(rowOrderMap.get('tail')).toBe('b0M')
    expect(rowOrderMap.get('far-tail')).toBe('b0O')
    expect((records.get('right-a') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toMatch(/^p1:/)
    expect((records.get('right-b') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toMatch(/^p1:/)
    expect((records.get('far-tail') as Y.Map<unknown>).has(RECORD_POSITION_FIELD)).toBe(false)
    expect(getOrderedIds(rowOrderMap)).toEqual(expectedOrder)
  })

  it('无 anchor 的 before intent 表示插入首位', () => {
    const doc = new Y.Doc()
    for (const [index, recordId] of ['r1', 'r2'].entries()) {
      const record = new Y.Map<unknown>()
      record.set('__order', index)
      doc.getMap<Y.Map<unknown>>(YDOC_RECORDS).set(recordId, record)
      doc.getMap<number>(YDOC_ROW_ORDER_MAP).set(recordId, index)
    }
    doc.getArray<string>(YDOC_ROW_ORDER).push(['r1', 'r2'])

    insertTableRecordAtomically(doc, {
      recordId: 'front',
      fieldValues: {},
      orderContext: { position: 'before' },
      origin: COLLAB_ORIGIN_LOCAL,
    })

    expect(getEffectiveTableRecordOrder(doc)).toEqual(['front', 'r1', 'r2'])
  })

  it('rejects the unknown tail of a truncated snapshot without blocking loaded gaps', () => {
    const doc = new Y.Doc()
    for (const [index, recordId] of ['loaded-a', 'loaded-tail'].entries()) {
      const record = new Y.Map<unknown>()
      record.set('__order', index + 1)
      doc.getMap<Y.Map<unknown>>(YDOC_RECORDS).set(recordId, record)
      doc.getMap<number>(YDOC_ROW_ORDER_MAP).set(recordId, index + 1)
    }
    doc.getArray<string>(YDOC_ROW_ORDER).push(['loaded-a', 'loaded-tail'])
    doc.getMap(YDOC_META).set('is_truncated', true)
    doc.getMap(YDOC_META).set('total_records', 5_001)

    expect(() => insertTableRecordAtomically(doc, {
      recordId: 'unsafe-tail',
      fieldValues: {},
      orderContext: { anchor_record_id: 'loaded-tail', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })).toThrow('unknown tail of a truncated snapshot')
    expect(doc.getMap(YDOC_RECORDS).has('unsafe-tail')).toBe(false)

    expect(() => insertTableRecordAtomically(doc, {
      recordId: 'safe-gap',
      fieldValues: {},
      orderContext: { anchor_record_id: 'loaded-a', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })).not.toThrow()
    expect(getEffectiveTableRecordOrder(doc)).toEqual(['loaded-a', 'safe-gap', 'loaded-tail'])
  })

  it('duplicate-gap boundary materialization survives a Yjs restart unchanged', () => {
    const beforeRestart = new Y.Doc()
    const records = beforeRestart.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrderMap = beforeRestart.getMap<string>(YDOC_ROW_ORDER_MAP)
    for (const recordId of ['r1', 'r2']) {
      const record = new Y.Map<unknown>()
      record.set('__order', recordId === 'r1' ? 1 : 2)
      records.set(recordId, record)
      rowOrderMap.set(recordId, 'b0I')
    }
    insertTableRecordAtomically(beforeRestart, {
      recordId: 'new-row',
      fieldValues: {},
      orderContext: { anchor_record_id: 'r1', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })
    const expectedPositions = Object.fromEntries(
      ['r1', 'new-row', 'r2'].map(recordId => [
        recordId,
        (records.get(recordId) as Y.Map<unknown>).get(RECORD_POSITION_FIELD),
      ]),
    )

    const afterRestart = new Y.Doc()
    Y.applyUpdate(afterRestart, Y.encodeStateAsUpdate(beforeRestart))
    const restartedRecords = afterRestart.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    expect(getEffectiveTableRecordOrder(afterRestart)).toEqual(['r1', 'new-row', 'r2'])
    expect(getOrderedIds(afterRestart.getMap<string>(YDOC_ROW_ORDER_MAP)))
      .toEqual(['r1', 'new-row', 'r2'])
    expect(Object.fromEntries(
      ['r1', 'new-row', 'r2'].map(recordId => [
        recordId,
        (restartedRecords.get(recordId) as Y.Map<unknown>).get(RECORD_POSITION_FIELD),
      ]),
    )).toEqual(expectedPositions)
  })

  it('materializes only distinct NULL bounds and keeps a five-row snapshot order stable', () => {
    const liveDoc = new Y.Doc()
    const records = liveDoc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrder = liveDoc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = liveDoc.getMap<number | string>(YDOC_ROW_ORDER_MAP)
    const historicalRows = [
      ['far-left', 'b0G'],
      ['left', 'b0I'],
      ['right', 'b0K'],
      ['far-right', 'b0M'],
      ['tail', 'b0O'],
    ] as const
    for (const [index, [recordId, position]] of historicalRows.entries()) {
      const record = new Y.Map<unknown>()
      record.set('__order', (index + 1) * 1000)
      records.set(recordId, record)
      rowOrderMap.set(recordId, position)
    }
    rowOrder.push(historicalRows.map(([recordId]) => recordId))

    insertTableRecordAtomically(liveDoc, {
      recordId: 'between',
      fieldValues: {},
      orderContext: { anchor_record_id: 'left', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })
    expect((records.get('left') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toMatch(/^p1:/)
    expect((records.get('right') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toMatch(/^p1:/)
    for (const recordId of ['far-left', 'far-right', 'tail']) {
      expect((records.get(recordId) as Y.Map<unknown>).has(RECORD_POSITION_FIELD)).toBe(false)
    }

    // Django snapshots rebuild the legacy scalar projection from row_order.
    const expectedOrder = ['far-left', 'left', 'between', 'right', 'far-right', 'tail']
    const restarted = new Y.Doc()
    const restartedRecords = restarted.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    for (const recordId of expectedOrder) {
      const source = records.get(recordId) as Y.Map<unknown>
      const record = new Y.Map<unknown>()
      record.set('__order', source.get('__order'))
      if (source.has(RECORD_POSITION_FIELD)) {
        record.set(RECORD_POSITION_FIELD, source.get(RECORD_POSITION_FIELD))
      }
      restartedRecords.set(recordId, record)
    }
    setOrderedIds(
      restarted.getMap<string>(YDOC_ROW_ORDER_MAP),
      expectedOrder,
    )
    restarted.getArray<string>(YDOC_ROW_ORDER).push(expectedOrder)

    expect(getEffectiveTableRecordOrder(restarted)).toEqual(expectedOrder)
  })

  it('rowOrder projection moves only the changed Y.Array items', () => {
    const doc = new Y.Doc()
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrder = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)
    for (const [index, recordId] of ['r1', 'r2', 'r3', 'r4'].entries()) {
      const record = new Y.Map<unknown>()
      record.set('__order', index)
      records.set(recordId, record)
    }
    rowOrder.push(['r1', 'r2', 'r3', 'r4'])
    setOrderedIds(rowOrderMap, rowOrder.toArray())
    const deltas: Array<Array<{ insert?: string[]; delete?: number; retain?: number }>> = []
    rowOrder.observe(event => deltas.push(event.delta as typeof deltas[number]))

    reorderTableRecordsAtomically(doc, ['r2'], 2, COLLAB_ORIGIN_LOCAL)

    expect(rowOrder.toArray()).toEqual(['r1', 'r3', 'r2', 'r4'])
    expect(deltas.flat().reduce((sum, delta) => sum + (delta.delete ?? 0), 0)).toBe(1)
    expect(deltas.flat().reduce((sum, delta) => sum + (delta.insert?.length ?? 0), 0)).toBe(1)
  })

  it('array-only reconcile recalculates only moved rows and necessary bounds', () => {
    const doc = new Y.Doc()
    for (const recordId of ['r1', 'r2', 'r3', 'r4']) {
      insertTableRecordAtomically(doc, {
        recordId,
        fieldValues: {},
        orderContext: { position: 'end' },
        origin: COLLAB_ORIGIN_LOCAL,
      })
    }
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const before = Object.fromEntries(['r1', 'r2', 'r3', 'r4'].map(recordId => [
      recordId,
      (records.get(recordId) as Y.Map<unknown>).get(RECORD_POSITION_FIELD),
    ]))

    const plan = planTableRecordOrderReconcile(doc, ['r1', 'r3', 'r2', 'r4'])
    expect(plan.allocations.filter(allocation => !allocation.preserveLegacyProjection)
      .map(allocation => allocation.recordId)).toEqual(['r2'])
    doc.transact(() => applyTableRecordOrderPlan(doc, plan), 'legacy-position-reconcile')

    expect(getEffectiveTableRecordOrder(doc)).toEqual(['r1', 'r3', 'r2', 'r4'])
    expect((records.get('r1') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(before.r1)
    expect((records.get('r3') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(before.r3)
    expect((records.get('r4') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(before.r4)
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).not.toBe(before.r2)
  })

  it('legacy rowOrderMap-only intent is reconciled into stable __order coordinates', () => {
    const doc = new Y.Doc()
    for (const [index, recordId] of ['r1', 'r2', 'r3'].entries()) {
      const record = new Y.Map<unknown>()
      record.set('__order', index + 1)
      doc.getMap<Y.Map<unknown>>(YDOC_RECORDS).set(recordId, record)
    }
    setOrderedIds(doc.getMap<string>(YDOC_ROW_ORDER_MAP), ['r1', 'r2', 'r3'])
    doc.getArray<string>(YDOC_ROW_ORDER).push(['r1', 'r2', 'r3'])

    const desiredOrder = ['r2', 'r3', 'r1']
    const plan = planTableRecordOrderReconcile(doc, desiredOrder)
    doc.transact(() => applyTableRecordOrderPlan(doc, plan), 'legacy-position-reconcile')

    expect(getEffectiveTableRecordOrder(doc)).toEqual(desiredOrder)
    const moved = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS).get('r1') as Y.Map<unknown>
    expect(moved.get(RECORD_POSITION_FIELD)).toMatch(/^p1:/)
    expect(typeof moved.get('__order')).toBe('number')
  })

  it('legacy __order intent recalculates the changed row instead of keeping its stale PositionId', () => {
    const doc = new Y.Doc()
    for (const recordId of ['r1', 'r2', 'r3']) {
      insertTableRecordAtomically(doc, {
        recordId,
        fieldValues: {},
        orderContext: { position: 'end' },
        origin: COLLAB_ORIGIN_LOCAL,
      })
    }
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const before = Object.fromEntries(['r1', 'r2', 'r3'].map(recordId => [
      recordId,
      (records.get(recordId) as Y.Map<unknown>).get(RECORD_POSITION_FIELD),
    ]))
    ;(records.get('r1') as Y.Map<unknown>).set('__order', 1000)
    ;(records.get('r2') as Y.Map<unknown>).set('__order', 500)
    ;(records.get('r3') as Y.Map<unknown>).set('__order', 3000)

    const plan = planLegacyTableRecordOrderReconcile(doc, ['r2'])
    doc.transact(() => applyTableRecordOrderPlan(doc, plan), 'legacy-position-reconcile')

    expect(getEffectiveTableRecordOrder(doc)).toEqual(['r2', 'r1', 'r3'])
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).not.toBe(before.r2)
    expect((records.get('r1') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(before.r1)
    expect((records.get('r3') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(before.r3)
  })

  it('legacy rowOrderMap intent prefers the record actually changed by the old client', () => {
    const doc = new Y.Doc()
    for (const recordId of ['r1', 'r2', 'r3']) {
      insertTableRecordAtomically(doc, {
        recordId,
        fieldValues: {},
        orderContext: { position: 'end' },
        origin: COLLAB_ORIGIN_LOCAL,
      })
    }
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const before = Object.fromEntries(['r1', 'r2', 'r3'].map(recordId => [
      recordId,
      (records.get(recordId) as Y.Map<unknown>).get(RECORD_POSITION_FIELD),
    ]))

    const plan = planTableRecordOrderReconcile(doc, ['r2', 'r1', 'r3'], ['r2'])
    doc.transact(() => applyTableRecordOrderPlan(doc, plan), 'legacy-position-reconcile')

    expect(getEffectiveTableRecordOrder(doc)).toEqual(['r2', 'r1', 'r3'])
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).not.toBe(before.r2)
    expect((records.get('r1') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(before.r1)
    expect((records.get('r3') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(before.r3)
  })

  it('resolves missing and malformed legacy orders identically across insertion histories', () => {
    const resolve = (insertionOrder: readonly string[], missingOrder: unknown) => {
      const doc = new Y.Doc()
      const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
      const positions = { a: 'p1:a0', b: 'p1:a1', c: 'p1:a2' }
      const orders: Record<string, unknown> = { a: 3, b: missingOrder, c: 1 }
      for (const recordId of insertionOrder) {
        const record = new Y.Map<unknown>()
        record.set(RECORD_POSITION_FIELD, positions[recordId as keyof typeof positions])
        if (orders[recordId] !== undefined) record.set('__order', orders[recordId])
        records.set(recordId, record)
      }
      return resolveLegacyTableRecordOrderIntent(doc)
    }

    for (const insertionOrder of [
      ['a', 'b', 'c'],
      ['b', 'c', 'a'],
      ['c', 'a', 'b'],
    ]) {
      expect(resolve(insertionOrder, undefined)).toEqual(['c', 'a', 'b'])
      expect(resolve(insertionOrder, Number.NaN)).toEqual(['c', 'a', 'b'])
    }
  })

  it('分配失败时 records、rowOrder 与 rowOrderMap 均保持未写状态', () => {
    const doc = new Y.Doc()
    const oversizedRecordId = 'x'.repeat(400)

    expect(() => insertTableRecordAtomically(doc, {
      recordId: oversizedRecordId,
      fieldValues: { title: 'must not leak' },
      origin: COLLAB_ORIGIN_LOCAL,
    })).toThrow(/allocation limit/)
    expect(doc.getMap(YDOC_RECORDS).size).toBe(0)
    expect(doc.getArray(YDOC_ROW_ORDER).length).toBe(0)
    expect(doc.getMap(YDOC_ROW_ORDER_MAP).size).toBe(0)
  })

  it('纯读取 historical NULL PositionId 不产生任何 Yjs update', () => {
    const doc = new Y.Doc()
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)
    const record = new Y.Map<unknown>()
    record.set('__order', 1)
    records.set('legacy', record)
    rowOrderMap.set('legacy', 'b0I')
    const before = Y.encodeStateAsUpdate(doc)

    expect(getEffectiveTableRecordOrder(doc)).toEqual(['legacy'])
    expect(Y.encodeStateAsUpdate(doc)).toEqual(before)
    expect(record.has(RECORD_POSITION_FIELD)).toBe(false)
  })

  it('同一 gap 并发新增合并后 PositionId 唯一且两端顺序收敛', () => {
    const docA = new Y.Doc()
    const recordsA = docA.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrderA = docA.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMapA = docA.getMap<string>(YDOC_ROW_ORDER_MAP)
    docA.transact(() => {
      for (const [recordId, order] of [['left', 1], ['right', 2]] as const) {
        const record = new Y.Map<unknown>()
        record.set('__order', order)
        recordsA.set(recordId, record)
      }
      rowOrderA.push(['left', 'right'])
      rowOrderMapA.set('left', 'b0I')
      rowOrderMapA.set('right', 'b0I')
    }, 'seed')
    const docB = new Y.Doc()
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

    insertTableRecordAtomically(docA, {
      recordId: 'concurrent-a',
      fieldValues: {},
      orderContext: { anchor_record_id: 'left', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })
    insertTableRecordAtomically(docB, {
      recordId: 'concurrent-b',
      fieldValues: {},
      orderContext: { anchor_record_id: 'left', position: 'after' },
      origin: COLLAB_ORIGIN_LOCAL,
    })

    const updateA = Y.encodeStateAsUpdate(docA, Y.encodeStateVector(docB))
    const updateB = Y.encodeStateAsUpdate(docB, Y.encodeStateVector(docA))
    Y.applyUpdate(docA, updateB)
    Y.applyUpdate(docB, updateA)

    const positions = ['concurrent-a', 'concurrent-b'].map(recordId =>
      (docA.getMap(YDOC_RECORDS).get(recordId) as Y.Map<unknown>).get(RECORD_POSITION_FIELD),
    )
    expect(new Set(positions).size).toBe(2)
    expect(getEffectiveTableRecordOrder(docA)).toEqual(getEffectiveTableRecordOrder(docB))
  })

  it('新增、移动、删除后可恢复 PositionId 与 legacy 顺序', () => {
    const doc = new Y.Doc()
    const records = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrder = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)

    doc.transact(() => {
      const first = new Y.Map<unknown>()
      first.set('__order', 1)
      first.set('title', 'first')
      records.set('r1', first)
      rowOrder.push(['r1'])
      setOrderedIds(rowOrderMap, ['r1'])
    }, 'seed')

    const undoRuntime = acquireTableUndoRuntime(doc)
    const undoManager = undoRuntime.undoManager
    undoManager.clear()

    const addResult = insertTableRecordAtomically(doc, {
      recordId: 'r2',
      fieldValues: { title: 'second' },
      orderContext: { position: 'end' },
      origin: COLLAB_ORIGIN_LOCAL,
    })
    const addedPosition = addResult.allocation?.legacyPosition
    const addedPositionId = addResult.allocation?.positionId
    undoManager.stopCapturing()

    reorderTableRecordsAtomically(doc, ['r2'], 0, COLLAB_ORIGIN_LOCAL)
    undoManager.stopCapturing()
    const movedPosition = rowOrderMap.get('r2')
    const movedPositionId = (records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)
    expect(movedPosition).not.toBe(addedPosition)
    expect(movedPositionId).not.toBe(addedPositionId)

    doc.transact(() => {
      records.delete('r2')
      rowOrder.delete(rowOrder.toArray().indexOf('r2'), 1)
      rowOrderMap.delete('r2')
    }, COLLAB_ORIGIN_LOCAL)
    undoManager.stopCapturing()

    expect(records.has('r2')).toBe(false)
    expect(rowOrder.toArray()).toEqual(['r1'])
    expect(rowOrderMap.has('r2')).toBe(false)

    undoManager.undo()
    expect((records.get('r2') as Y.Map<unknown>).get('__order')).toBe(0)
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(movedPositionId)
    expect(rowOrder.toArray()).toEqual(['r2', 'r1'])
    expect(rowOrderMap.get('r2')).toBe(movedPosition)

    undoManager.undo()
    expect((records.get('r2') as Y.Map<unknown>).get('__order')).toBe(2)
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(addedPositionId)
    expect(rowOrder.toArray()).toEqual(['r1', 'r2'])
    expect(rowOrderMap.get('r2')).toBe(addedPosition)

    undoManager.undo()
    expect(records.has('r2')).toBe(false)
    expect(rowOrder.toArray()).toEqual(['r1'])
    expect(rowOrderMap.has('r2')).toBe(false)

    undoManager.redo()
    expect((records.get('r2') as Y.Map<unknown>).get('__order')).toBe(2)
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(addedPositionId)
    expect(rowOrder.toArray()).toEqual(['r1', 'r2'])
    expect(rowOrderMap.get('r2')).toBe(addedPosition)

    undoManager.redo()
    expect(rowOrderMap.get('r2')).toBe(movedPosition)
    expect((records.get('r2') as Y.Map<unknown>).get(RECORD_POSITION_FIELD)).toBe(movedPositionId)

    undoManager.redo()
    expect(records.has('r2')).toBe(false)
    expect(rowOrder.toArray()).toEqual(['r1'])
    expect(rowOrderMap.has('r2')).toBe(false)

    undoRuntime.release()
    doc.destroy()
  })
})
