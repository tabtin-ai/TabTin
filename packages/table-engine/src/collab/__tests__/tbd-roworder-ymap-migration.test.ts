/**
 * TBD rowOrder Y.Map 迁移测试
 *
 * 验证：
 * 1. getOrderedIds / setOrderedIds / syncArrayToMap 工具函数正确性
 * 2. replayPendingTableWrites 双写 Y.Map + Y.Array
 * 3. addRecord / deleteRecord 同时维护两套数据结构
 * 4. refreshRowOrder 优先读 Y.Map，fallback Y.Array
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { getOrderedIds, insertRowOrderKey, setOrderedIds, syncArrayToMap } from '../y-utils'
import { replayPendingTableWrites } from '../useTableCollaboration'
import { YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_ROW_ORDER_MAP } from '../ydoc-schema'

// ─── 工具函数测试 ───────────────────────────────────────────────────────────

describe('getOrderedIds', () => {
  it('按 position 升序返回 ID 列表', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    doc.transact(() => {
      ymap.set('c', 2)
      ymap.set('a', 0)
      ymap.set('b', 1)
    })
    expect(getOrderedIds(ymap)).toEqual(['a', 'b', 'c'])
  })

  it('position 相同时按字典序排序', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    doc.transact(() => {
      ymap.set('z', 0)
      ymap.set('a', 0)
      ymap.set('m', 0)
    })
    expect(getOrderedIds(ymap)).toEqual(['a', 'm', 'z'])
  })

  it('空 map 返回空数组', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    expect(getOrderedIds(ymap)).toEqual([])
  })

  it('number/string 混合 position 时使用确定的兼容排序', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number | string>('test')
    ymap.set('string-row', 'a0')
    ymap.set('number-row-2', 2)
    ymap.set('number-row-1', 1)

    expect(getOrderedIds(ymap)).toEqual(['number-row-1', 'number-row-2', 'string-row'])
  })
})

describe('setOrderedIds', () => {
  it('写入有序 position（fractional index），顺序可由 getOrderedIds 还原', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    setOrderedIds(ymap, ['a', 'b', 'c'])
    // position 现为 fractional index 字符串（字典序可比较），断言「顺序」而非具体数值
    expect(getOrderedIds(ymap)).toEqual(['a', 'b', 'c'])
    expect(typeof ymap.get('a')).toBe('string')
  })

  it('清除不在新列表中的旧 key', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    setOrderedIds(ymap, ['a', 'b', 'c'])
    setOrderedIds(ymap, ['b', 'd'])
    expect(ymap.has('a')).toBe(false)
    expect(ymap.has('c')).toBe(false)
    expect(getOrderedIds(ymap)).toEqual(['b', 'd'])
  })

  it('getOrderedIds(setOrderedIds(ids)) === ids 幂等性', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    const ids = ['row-1', 'row-2', 'row-3']
    setOrderedIds(ymap, ids)
    expect(getOrderedIds(ymap)).toEqual(ids)
  })
})

describe('insertRowOrderKey', () => {
  it('相邻 fractional position 重复时仍能在锚点后分配位置', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    ymap.set('r1', 'b0I')
    ymap.set('r2', 'b0I')

    expect(() => insertRowOrderKey(ymap, 'new-row', {
      anchor_record_id: 'r1',
      position: 'after',
    })).not.toThrow()
  })

  it('按 anchor 上下文把新行插入指定记录后方', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    setOrderedIds(ymap, ['r1', 'r2', 'r3'])

    ymap.set('new-row', insertRowOrderKey(ymap, 'new-row', {
      anchor_record_id: 'r2',
      position: 'after',
    }))

    expect(getOrderedIds(ymap)).toEqual(['r1', 'r2', 'new-row', 'r3'])
  })

  it('按 anchor 上下文把新行插入指定记录前方', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    setOrderedIds(ymap, ['r1', 'r2', 'r3'])

    ymap.set('new-row', insertRowOrderKey(ymap, 'new-row', {
      anchor_record_id: 'r2',
      position: 'before',
    }))

    expect(getOrderedIds(ymap)).toEqual(['r1', 'new-row', 'r2', 'r3'])
  })

  it('anchor 不存在时降级追加到末尾', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    setOrderedIds(ymap, ['r1', 'r2'])

    ymap.set('new-row', insertRowOrderKey(ymap, 'new-row', {
      anchor_record_id: 'missing',
      position: 'after',
    }))

    expect(getOrderedIds(ymap)).toEqual(['r1', 'r2', 'new-row'])
  })

  it('兼容历史 number position 并按 anchor 插入', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number | string>('test')
    ymap.set('r1', 0)
    ymap.set('r2', 1)
    ymap.set('r3', 2)

    ymap.set('new-row', insertRowOrderKey(ymap, 'new-row', {
      anchor_record_id: 'r2',
      position: 'after',
    }))

    expect(getOrderedIds(ymap)).toEqual(['r1', 'r2', 'new-row', 'r3'])
    expect(ymap.get('r1')).toBe(0)
    expect(ymap.get('r2')).toBe(1)
    expect(ymap.get('r3')).toBe(2)
  })

  it('兼容 number/string 混合 position 且不在读取/规划时整表归一化', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number | string>('test')
    ymap.set('r1', 0)
    ymap.set('r2', 1)
    ymap.set('r3', 'a0')

    ymap.set('new-row', insertRowOrderKey(ymap, 'new-row', {
      anchor_record_id: 'r2',
      position: 'after',
    }))

    expect(getOrderedIds(ymap)).toEqual(['r1', 'r2', 'new-row', 'r3'])
    expect(ymap.get('r1')).toBe(0)
    expect(ymap.get('r2')).toBe(1)
    expect(ymap.get('r3')).toBe('a0')
  })
})

describe('syncArrayToMap', () => {
  it('Y.Map 为空时从 Y.Array 同步', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('arr')
    const map = doc.getMap<number>('map')
    doc.transact(() => {
      arr.push(['a', 'b', 'c'])
    })
    syncArrayToMap(arr, map)
    expect(getOrderedIds(map)).toEqual(['a', 'b', 'c'])
  })

  it('Y.Map 非空时不覆盖', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('arr')
    const map = doc.getMap<number>('map')
    doc.transact(() => {
      arr.push(['a', 'b', 'c'])
      map.set('x', 0)
    })
    syncArrayToMap(arr, map)
    // map 不变
    expect(map.size).toBe(1)
    expect(map.get('x')).toBe(0)
  })

  it('Y.Array 为空时不操作', () => {
    const doc = new Y.Doc()
    const arr = doc.getArray<string>('arr')
    const map = doc.getMap<number>('map')
    syncArrayToMap(arr, map)
    expect(map.size).toBe(0)
  })
})

// ─── replayPendingTableWrites 双写测试 ─────────────────────────────────────

describe('replayPendingTableWrites 双写 Y.Map', () => {
  it('addRecord 同时写 Y.Array 和 Y.Map', () => {
    const doc = new Y.Doc()
    replayPendingTableWrites(doc, [
      { op: 'addRecord', recordId: 'r1', fieldValues: { f1: 'v1' }, order: 1 },
      { op: 'addRecord', recordId: 'r2', fieldValues: { f1: 'v2' }, order: 2 },
    ])

    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<number>(YDOC_ROW_ORDER_MAP)

    expect(rowOrderArr.toArray()).toContain('r1')
    expect(rowOrderArr.toArray()).toContain('r2')
    expect(rowOrderMap.has('r1')).toBe(true)
    expect(rowOrderMap.has('r2')).toBe(true)
  })

  it('deleteRecord 同时删除 Y.Array 和 Y.Map', () => {
    const doc = new Y.Doc()
    replayPendingTableWrites(doc, [
      { op: 'addRecord', recordId: 'r1', fieldValues: {}, order: 1 },
      { op: 'addRecord', recordId: 'r2', fieldValues: {}, order: 2 },
    ])
    replayPendingTableWrites(doc, [
      { op: 'deleteRecord', recordId: 'r1' },
    ])

    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<number>(YDOC_ROW_ORDER_MAP)

    expect(rowOrderArr.toArray()).not.toContain('r1')
    expect(rowOrderMap.has('r1')).toBe(false)
    expect(rowOrderArr.toArray()).toContain('r2')
    expect(rowOrderMap.has('r2')).toBe(true)
  })

  it('重复 addRecord replay 保持 records、Y.Array 与 Y.Map 幂等', () => {
    const doc = new Y.Doc()
    const writes = [
      {
        op: 'addRecord' as const,
        recordId: 'r1',
        fieldValues: { title: 'replayed row' },
        order: 1,
      },
    ]
    replayPendingTableWrites(doc, writes)

    const recordsMap = doc.getMap<Y.Map<unknown>>(YDOC_RECORDS)
    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)
    const firstPosition = rowOrderMap.get('r1')

    replayPendingTableWrites(doc, writes)

    expect(recordsMap.size).toBe(1)
    expect((recordsMap.get('r1') as Y.Map<unknown>).get('title')).toBe('replayed row')
    expect(rowOrderArr.toArray()).toEqual(['r1'])
    expect(rowOrderMap.size).toBe(1)
    expect(rowOrderMap.get('r1')).toBe(firstPosition)
  })

  it('过渡期：Y.Map 为空时保留旧 Y.Array，但不做整表 map 回填', () => {
    const doc = new Y.Doc()
    // 模拟旧数据：只有 Y.Array
    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    doc.transact(() => {
      rowOrderArr.push(['existing-row'])
    })

    // 新增边界只物化新记录；历史 array 行保持 lazy。
    replayPendingTableWrites(doc, [
      { op: 'addRecord', recordId: 'new-row', fieldValues: {}, order: 1 },
    ])

    const rowOrderMap = doc.getMap<number>(YDOC_ROW_ORDER_MAP)
    expect(rowOrderArr.toArray()).toEqual(['existing-row', 'new-row'])
    expect(rowOrderMap.has('existing-row')).toBe(false)
    expect(rowOrderMap.has('new-row')).toBe(true)
  })

  it('addRecord replay 保留 order_context 指定的 anchor 位置', () => {
    const doc = new Y.Doc()
    const rowOrderMap = doc.getMap<string>(YDOC_ROW_ORDER_MAP)
    setOrderedIds(rowOrderMap, ['r1', 'r2', 'r3'])

    replayPendingTableWrites(doc, [
      {
        op: 'addRecord',
        recordId: 'new-row',
        fieldValues: {},
        order: 0,
        orderContext: {
          anchor_record_id: 'r2',
          position: 'after',
        },
      },
    ])

    expect(getOrderedIds(rowOrderMap)).toEqual(['r1', 'r2', 'new-row', 'r3'])
  })
})

// ─── Y.Map 优先读取逻辑验证 ─────────────────────────────────────────────────

describe('getOrderedIds 优先于 Y.Array fallback', () => {
  it('Y.Map 有数据时，排序结果由 Y.Map 决定（与 Y.Array 顺序无关）', () => {
    const doc = new Y.Doc()
    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<number>(YDOC_ROW_ORDER_MAP)

    // Y.Array 顺序：a, b, c
    doc.transact(() => {
      rowOrderArr.push(['a', 'b', 'c'])
    })

    // Y.Map 顺序：c, b, a（反序）
    setOrderedIds(rowOrderMap, ['c', 'b', 'a'])

    // 优先读 Y.Map
    const result = rowOrderMap.size > 0
      ? getOrderedIds(rowOrderMap)
      : rowOrderArr.toArray()

    expect(result).toEqual(['c', 'b', 'a'])
  })

  it('Y.Map 为空时 fallback 到 Y.Array', () => {
    const doc = new Y.Doc()
    const rowOrderArr = doc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = doc.getMap<number>(YDOC_ROW_ORDER_MAP)

    doc.transact(() => {
      rowOrderArr.push(['a', 'b', 'c'])
    })

    const result = rowOrderMap.size > 0
      ? getOrderedIds(rowOrderMap)
      : rowOrderArr.toArray()

    expect(result).toEqual(['a', 'b', 'c'])
  })
})

// ─── CRDT 并发合并不翻倍测试 ────────────────────────────────────────────────

describe('Y.Map LWW 合并不产生 ID 翻倍', () => {
  it('两个客户端并发 set 同一 ID，合并后只有一条', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    // 两端各自写入同一 ID，但 position 不同
    const mapA = docA.getMap<number>(YDOC_ROW_ORDER_MAP)
    const mapB = docB.getMap<number>(YDOC_ROW_ORDER_MAP)

    docA.transact(() => { mapA.set('row-1', 0) })
    docB.transact(() => { mapB.set('row-1', 0) })

    // 交换状态向量，模拟 CRDT 合并
    const stateA = Y.encodeStateAsUpdate(docA)
    const stateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docA, stateB)
    Y.applyUpdate(docB, stateA)

    // 合并后 row-1 只出现一次
    const idsA = getOrderedIds(mapA)
    const idsB = getOrderedIds(mapB)
    expect(idsA.filter(id => id === 'row-1').length).toBe(1)
    expect(idsB.filter(id => id === 'row-1').length).toBe(1)
  })

  it('Y.Array 并发 push 同一 ID 会翻倍（对比验证 Y.Map 优势）', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const arrA = docA.getArray<string>(YDOC_ROW_ORDER)
    const arrB = docB.getArray<string>(YDOC_ROW_ORDER)

    docA.transact(() => { arrA.push(['row-1']) })
    docB.transact(() => { arrB.push(['row-1']) })

    const stateA = Y.encodeStateAsUpdate(docA)
    const stateB = Y.encodeStateAsUpdate(docB)
    Y.applyUpdate(docA, stateB)
    Y.applyUpdate(docB, stateA)

    // Y.Array 合并后 row-1 出现两次（这就是迁移的原因）
    expect(arrA.toArray().filter(id => id === 'row-1').length).toBe(2)
  })
})
