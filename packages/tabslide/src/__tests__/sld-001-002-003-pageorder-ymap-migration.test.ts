/**
 * SLD-001/002/003 — TabSlide pageOrder Y.Array → Y.Map 迁移测试
 *
 * 验证：
 * SLD-001: getOrderedIds / setOrderedIds 工具函数正确性
 * SLD-002: readOrderedIdsWithFallback 向后兼容（Y.Map 优先，Y.Array fallback）
 * SLD-003: syncArrayToMap 幂等性（Y.Map 非空时不覆盖）
 */

import * as Y from 'yjs'
import { describe, it, expect } from 'vitest'
import {
  getOrderedIds,
  setOrderedIds,
  syncArrayToMap,
  readOrderedIdsWithFallback,
} from '../collab/utils'

// ─── SLD-001: 工具函数基础行为 ─────────────────────────────

describe('SLD-001: getOrderedIds / setOrderedIds', () => {
  it('getOrderedIds 按 position 升序返回 ID', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    doc.transact(() => {
      ymap.set('page-c', 2)
      ymap.set('page-a', 0)
      ymap.set('page-b', 1)
    })
    expect(getOrderedIds(ymap)).toEqual(['page-a', 'page-b', 'page-c'])
  })

  it('getOrderedIds position 相同时按 key 字典序稳定排序', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    doc.transact(() => {
      ymap.set('page-z', 0)
      ymap.set('page-a', 0)
      ymap.set('page-m', 0)
    })
    const result = getOrderedIds(ymap)
    expect(result).toEqual(['page-a', 'page-m', 'page-z'])
  })

  it('getOrderedIds 空 map 返回空数组', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    expect(getOrderedIds(ymap)).toEqual([])
  })

  it('setOrderedIds 写入正确的 position 映射', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    setOrderedIds(ymap, ['page-1', 'page-2', 'page-3'])
    const p1 = ymap.get('page-1') as string
    const p2 = ymap.get('page-2') as string
    const p3 = ymap.get('page-3') as string
    expect(typeof p1).toBe('string')
    expect(typeof p2).toBe('string')
    expect(typeof p3).toBe('string')
    expect(p1 < p2).toBe(true)
    expect(p2 < p3).toBe(true)
  })

  it('setOrderedIds 清除不在新列表中的旧 key', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<string>('test')
    setOrderedIds(ymap, ['page-1', 'page-2', 'page-3'])
    setOrderedIds(ymap, ['page-1', 'page-3'])
    expect(ymap.has('page-2')).toBe(false)
    const p1 = ymap.get('page-1') as string
    const p3 = ymap.get('page-3') as string
    expect(typeof p1).toBe('string')
    expect(typeof p3).toBe('string')
    expect(p1 < p3).toBe(true)
  })

  it('setOrderedIds 空列表清空 map', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    setOrderedIds(ymap, ['page-1', 'page-2'])
    setOrderedIds(ymap, [])
    expect(ymap.size).toBe(0)
  })

  it('setOrderedIds 在 Y.Doc transaction 内执行（原子性）', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    let transactionCount = 0
    doc.on('beforeTransaction', () => { transactionCount++ })
    setOrderedIds(ymap, ['a', 'b', 'c'])
    // 应该只产生一次 transaction（setOrderedIds 内部调用 doc.transact）
    expect(transactionCount).toBe(1)
  })

  it('setOrderedIds 写入后 getOrderedIds 能正确还原顺序', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('test')
    const ids = ['slide-3', 'slide-1', 'slide-2']
    setOrderedIds(ymap, ids)
    expect(getOrderedIds(ymap)).toEqual(ids)
  })
})

// ─── SLD-002: readOrderedIdsWithFallback 向后兼容 ──────────

describe('SLD-002: readOrderedIdsWithFallback', () => {
  it('Y.Map 非空时优先读 Y.Map', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')

    doc.transact(() => {
      ymap.set('page-map', 0)
      yarr.push(['page-arr'])
    })

    const result = readOrderedIdsWithFallback(ymap, yarr)
    expect(result).toEqual(['page-map'])
    expect(result).not.toContain('page-arr')
  })

  it('Y.Map 为空时 fallback 到 Y.Array', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')

    doc.transact(() => {
      yarr.push(['page-1', 'page-2'])
    })

    const result = readOrderedIdsWithFallback(ymap, yarr)
    expect(result).toEqual(['page-1', 'page-2'])
  })

  it('fallback 时自动同步 Y.Array 内容到 Y.Map', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')

    doc.transact(() => {
      yarr.push(['page-1', 'page-2', 'page-3'])
    })

    readOrderedIdsWithFallback(ymap, yarr)

    // 同步后 Y.Map 应该有数据（fractional index 字符串）
    expect(ymap.size).toBe(3)
    const p1 = ymap.get('page-1') as string
    const p2 = ymap.get('page-2') as string
    const p3 = ymap.get('page-3') as string
    expect(typeof p1).toBe('string')
    expect(p1 < p2).toBe(true)
    expect(p2 < p3).toBe(true)
  })

  it('两者都为空时返回空数组', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')
    expect(readOrderedIdsWithFallback(ymap, yarr)).toEqual([])
  })
})

// ─── SLD-003: syncArrayToMap 幂等性 ──────────────────────

describe('SLD-003: syncArrayToMap 幂等性', () => {
  it('Y.Map 为空时从 Y.Array 同步', () => {
    const doc = new Y.Doc()
    // 使用不同 key 名避免 Y.js 同名类型冲突
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')

    doc.transact(() => {
      yarr.push(['a', 'b', 'c'])
    })

    syncArrayToMap(yarr, ymap)
    const pa = ymap.get('a') as string
    const pb = ymap.get('b') as string
    const pc = ymap.get('c') as string
    expect(typeof pa).toBe('string')
    expect(pa < pb).toBe(true)
    expect(pb < pc).toBe(true)
  })

  it('Y.Map 非空时不覆盖（幂等保护）', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')

    doc.transact(() => {
      ymap.set('existing', 99)
      yarr.push(['from-array'])
    })

    syncArrayToMap(yarr, ymap)

    // Y.Map 已有数据，不应被覆盖
    expect(ymap.get('existing')).toBe(99)
    expect(ymap.has('from-array')).toBe(false)
  })

  it('Y.Array 为空时不执行同步', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')

    syncArrayToMap(yarr, ymap)
    expect(ymap.size).toBe(0)
  })

  it('多次调用 syncArrayToMap 结果一致（幂等）', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')
    const yarr = doc.getArray<string>('pageOrder')

    doc.transact(() => {
      yarr.push(['x', 'y'])
    })

    syncArrayToMap(yarr, ymap)
    const firstResult = getOrderedIds(ymap)

    // 第二次调用：Y.Map 已非空，不应改变
    syncArrayToMap(yarr, ymap)
    const secondResult = getOrderedIds(ymap)

    expect(firstResult).toEqual(secondResult)
  })
})

// ─── SLD-004: 双写场景模拟 ────────────────────────────────

describe('SLD-004: 双写场景（Y.Array + Y.Map 同时维护）', () => {
  it('并发 setOrderedIds 使用 LWW 语义，不产生翻倍', () => {
    // 模拟两个客户端并发设置 pageOrderMap
    const doc1 = new Y.Doc()
    const doc2 = new Y.Doc()

    const ymap1 = doc1.getMap<number>('pageOrderMap')
    const ymap2 = doc2.getMap<number>('pageOrderMap')

    // 客户端1 设置顺序
    setOrderedIds(ymap1, ['page-a', 'page-b'])

    // 客户端2 设置不同顺序（并发）
    setOrderedIds(ymap2, ['page-b', 'page-a'])

    // 合并两个 doc 的更新
    const update1 = Y.encodeStateAsUpdate(doc1)
    const update2 = Y.encodeStateAsUpdate(doc2)

    Y.applyUpdate(doc1, update2)
    Y.applyUpdate(doc2, update1)

    // 合并后两个 doc 的 Y.Map 应该一致（LWW，不翻倍）
    const result1 = getOrderedIds(ymap1)
    const result2 = getOrderedIds(ymap2)

    expect(result1).toEqual(result2)
    // 关键：没有重复 ID
    expect(new Set(result1).size).toBe(result1.length)
    expect(result1.length).toBe(2)
  })

  it('Y.Map 中删除 key 后 position 归一化', () => {
    const doc = new Y.Doc()
    const ymap = doc.getMap<number>('pageOrderMap')

    setOrderedIds(ymap, ['page-1', 'page-2', 'page-3'])

    // 删除 page-2 并重新归一化
    doc.transact(() => {
      ymap.delete('page-2')
      const remaining = getOrderedIds(ymap)
      for (let i = 0; i < remaining.length; i++) {
        ymap.set(remaining[i], i)
      }
    })

    const result = getOrderedIds(ymap)
    expect(result).toEqual(['page-1', 'page-3'])
    expect(ymap.get('page-1')).toBe(0)
    expect(ymap.get('page-3')).toBe(1)
  })
})
