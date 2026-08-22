import { describe, expect, it } from 'vitest'
import {
  isValidTabKey,
  parseTabKey,
  buildResourceTabKey,
  buildTableKey,
  buildActiveKeyFromLegacy,
  isSameMeta,
  isSameItem,
  shallowEqualItemSets,
  normalizeItems,
  normalizeTabKeys,
  normalizePersistedState,
  deriveDisplayKey,
  patchDisplayRecord,
  mergeSyncedTabOrder,
} from '../helpers'
import type { ContextItemRecord } from '../types'

const isTabDocPersistOnly = (tabKey: string) => tabKey.startsWith('tabdoc:')

// ---------------------------------------------------------------------------
// isValidTabKey
// ---------------------------------------------------------------------------

describe('isValidTabKey', () => {
  it('合法 tabKey：type:id 格式', () => {
    expect(isValidTabKey('tabdata:abc123')).toBe(true)
    expect(isValidTabKey('tabweb:view-1')).toBe(true)
    expect(isValidTabKey('a:b')).toBe(true)
  })

  it('冒号在首位 → 非法', () => {
    expect(isValidTabKey(':abc')).toBe(false)
  })

  it('冒号在末位 → 非法', () => {
    expect(isValidTabKey('tabdata:')).toBe(false)
  })

  it('无冒号 → 非法', () => {
    expect(isValidTabKey('nodash')).toBe(false)
  })

  it('空字符串 → 非法', () => {
    expect(isValidTabKey('')).toBe(false)
  })

  it('含多个冒号 → 合法（只看第一个冒号位置）', () => {
    expect(isValidTabKey('tabweb:http://example.com')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// parseTabKey / buildResourceTabKey 往返一致性
// ---------------------------------------------------------------------------

describe('parseTabKey', () => {
  it('解析正常 tabKey', () => {
    expect(parseTabKey('tabdata:tbl-1')).toEqual({ type: 'tabdata', id: 'tbl-1' })
  })

  it('id 含冒号时保留完整 id', () => {
    expect(parseTabKey('tabweb:http://example.com')).toEqual({
      type: 'tabweb',
      id: 'http://example.com',
    })
  })

  it('冒号在首位 → null', () => {
    expect(parseTabKey(':abc')).toBeNull()
  })

  it('冒号在末位 → null', () => {
    expect(parseTabKey('abc:')).toBeNull()
  })

  it('无冒号 → null', () => {
    expect(parseTabKey('nocoron')).toBeNull()
  })
})

describe('buildResourceTabKey + parseTabKey 往返一致性', () => {
  const cases = [
    { type: 'tabdata', id: 'table-42' },
    { type: 'tabweb', id: 'view-uuid-abc' },
    { type: 'tabdoc', id: 'doc-1' },
  ]
  cases.forEach(({ type, id }) => {
    it(`${type}:${id} 往返一致`, () => {
      const tabKey = buildResourceTabKey(type, id)
      const parsed = parseTabKey(tabKey)
      expect(parsed).toEqual({ type, id })
    })
  })
})

describe('buildTableKey', () => {
  it('生成 tabdata: 前缀', () => {
    expect(buildTableKey('tbl-99')).toBe('tabdata:tbl-99')
  })
})

// ---------------------------------------------------------------------------
// buildActiveKeyFromLegacy
// ---------------------------------------------------------------------------

describe('buildActiveKeyFromLegacy', () => {
  it('tabweb 类型 + viewId → tabweb:viewId', () => {
    expect(buildActiveKeyFromLegacy({ type: 'tabweb', viewId: 'v1' })).toBe('tabweb:v1')
  })

  it('tabdata 类型 + tableId → tabdata:tableId', () => {
    expect(buildActiveKeyFromLegacy({ type: 'tabdata', tableId: 't1' })).toBe('tabdata:t1')
  })

  it('null 输入 → null', () => {
    expect(buildActiveKeyFromLegacy(null)).toBeNull()
  })

  it('非对象 → null', () => {
    expect(buildActiveKeyFromLegacy('string')).toBeNull()
  })

  it('未知 type → null', () => {
    expect(buildActiveKeyFromLegacy({ type: 'unknown', id: 'x' })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// isSameMeta
// ---------------------------------------------------------------------------

describe('isSameMeta', () => {
  it('相同引用 → true', () => {
    const meta = { a: 1 }
    expect(isSameMeta(meta, meta)).toBe(true)
  })

  it('相同值 → true', () => {
    expect(isSameMeta({ a: 1, b: 'x' }, { a: 1, b: 'x' })).toBe(true)
  })

  it('键数量不同 → false', () => {
    expect(isSameMeta({ a: 1 }, { a: 1, b: 2 })).toBe(false)
  })

  it('值不同 → false', () => {
    expect(isSameMeta({ a: 1 }, { a: 2 })).toBe(false)
  })

  it('prev 为 undefined → false', () => {
    expect(isSameMeta(undefined, { a: 1 })).toBe(false)
  })

  it('next 为 undefined → false', () => {
    expect(isSameMeta({ a: 1 }, undefined)).toBe(false)
  })

  it('双方都为 undefined → true（引用相同）', () => {
    expect(isSameMeta(undefined, undefined)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// isSameItem
// ---------------------------------------------------------------------------

describe('isSameItem', () => {
  const base: ContextItemRecord = {
    tabKey: 'tabdata:t1',
    type: 'tabdata',
    id: 't1',
    title: 'Table 1',
    meta: { color: 'red' },
  }

  it('完全相同 → true', () => {
    expect(isSameItem({ ...base }, { ...base })).toBe(true)
  })

  it('prev 为 undefined → false', () => {
    expect(isSameItem(undefined, base)).toBe(false)
  })

  it('tabKey 不同 → false', () => {
    expect(isSameItem(base, { ...base, tabKey: 'tabdata:t2' })).toBe(false)
  })

  it('type 不同 → false', () => {
    expect(isSameItem(base, { ...base, type: 'tabdoc' })).toBe(false)
  })

  it('id 不同 → false', () => {
    expect(isSameItem(base, { ...base, id: 't2' })).toBe(false)
  })

  it('title 不同 → false', () => {
    expect(isSameItem(base, { ...base, title: 'Other' })).toBe(false)
  })

  it('meta 值变化 → false', () => {
    expect(isSameItem(base, { ...base, meta: { color: 'blue' } })).toBe(false)
  })

  it('meta 新增字段 → false', () => {
    expect(isSameItem(base, { ...base, meta: { color: 'red', size: 10 } })).toBe(false)
  })

  it('originTabKey 差异不影响比较', () => {
    expect(
      isSameItem(base, { ...base, originTabKey: 'old:key' }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// shallowEqualItemSets
// ---------------------------------------------------------------------------

describe('shallowEqualItemSets', () => {
  const mkItem = (tabKey: string): ContextItemRecord => ({
    tabKey,
    type: tabKey.split(':')[0],
    id: tabKey.split(':')[1],
  })

  it('空集 → true', () => {
    expect(shallowEqualItemSets([], [])).toBe(true)
  })

  it('相同内容不同顺序 → true', () => {
    const a = mkItem('tabdata:1')
    const b = mkItem('tabdata:2')
    expect(shallowEqualItemSets([a, b], [b, a])).toBe(true)
  })

  it('相同内容相同顺序 → true', () => {
    const a = mkItem('tabdata:1')
    const b = mkItem('tabdata:2')
    expect(shallowEqualItemSets([a, b], [a, b])).toBe(true)
  })

  it('长度不同 → false', () => {
    expect(shallowEqualItemSets([mkItem('tabdata:1')], [])).toBe(false)
  })

  it('一个多一个少 → false', () => {
    const a = mkItem('tabdata:1')
    const b = mkItem('tabdata:2')
    const c = mkItem('tabdata:3')
    expect(shallowEqualItemSets([a, b], [a, c])).toBe(false)
  })

  it('相同 tabKey 但 title 不同 → false', () => {
    const a: ContextItemRecord = { tabKey: 'tabdata:1', type: 'tabdata', id: '1', title: 'A' }
    const b: ContextItemRecord = { tabKey: 'tabdata:1', type: 'tabdata', id: '1', title: 'B' }
    expect(shallowEqualItemSets([a], [b])).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// normalizeItems
// ---------------------------------------------------------------------------

describe('normalizeItems', () => {
  const validItem: ContextItemRecord = { tabKey: 'tabdata:1', type: 'tabdata', id: '1' }

  it('Array 输入 → 过滤非法项', () => {
    expect(normalizeItems([validItem, 'bad', null, 42])).toEqual([validItem])
  })

  it('Map 输入 → 取 values', () => {
    const m = new Map([['k1', validItem]])
    expect(normalizeItems(m)).toEqual([validItem])
  })

  it('Object 输入 → 取 Object.values', () => {
    expect(normalizeItems({ a: validItem })).toEqual([validItem])
  })

  it('null → 空数组', () => {
    expect(normalizeItems(null)).toEqual([])
  })

  it('undefined → 空数组', () => {
    expect(normalizeItems(undefined)).toEqual([])
  })

  it('非法类型（number） → 空数组', () => {
    expect(normalizeItems(42)).toEqual([])
  })

  it('过滤缺少 tabKey 的项', () => {
    expect(normalizeItems([{ type: 'tabdata', id: '1' }])).toEqual([])
  })

  it('过滤缺少 type 的项', () => {
    expect(normalizeItems([{ tabKey: 'tabdata:1', id: '1' }])).toEqual([])
  })

  it('过滤缺少 id 的项', () => {
    expect(normalizeItems([{ tabKey: 'tabdata:1', type: 'tabdata' }])).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// normalizeTabKeys
// ---------------------------------------------------------------------------

describe('normalizeTabKeys', () => {
  it('Array → 去重 + 过滤非法 key', () => {
    expect(normalizeTabKeys(['tabdata:1', 'bad', 'tabdata:1', 'tabweb:v1'])).toEqual([
      'tabdata:1',
      'tabweb:v1',
    ])
  })

  it('Set 输入', () => {
    expect(normalizeTabKeys(new Set(['tabdata:1', 'tabweb:v1']))).toEqual([
      'tabdata:1',
      'tabweb:v1',
    ])
  })

  it('null → 空数组', () => {
    expect(normalizeTabKeys(null)).toEqual([])
  })

  it('undefined → 空数组', () => {
    expect(normalizeTabKeys(undefined)).toEqual([])
  })

  it('非法类型（number） → null', () => {
    expect(normalizeTabKeys(42)).toBeNull()
  })

  it('Object keys 为合法 tabKey → 使用 keys', () => {
    expect(normalizeTabKeys({ 'tabdata:1': true, 'tabweb:v1': true })).toEqual([
      'tabdata:1',
      'tabweb:v1',
    ])
  })

  it('Object values 为 string tabKey → 使用 values', () => {
    expect(normalizeTabKeys({ a: 'tabdata:1', b: 'tabweb:v1' })).toEqual([
      'tabdata:1',
      'tabweb:v1',
    ])
  })

  it('Map keys 为 string → 使用 keys', () => {
    const m = new Map<string, number>([['tabdata:1', 1], ['tabweb:v1', 2]])
    expect(normalizeTabKeys(m)).toEqual(['tabdata:1', 'tabweb:v1'])
  })
})

// ---------------------------------------------------------------------------
// deriveDisplayKey
// ---------------------------------------------------------------------------

describe('deriveDisplayKey', () => {
  it('tabweb: 前缀 → 透传', () => {
    expect(deriveDisplayKey('tabweb:v1')).toBe('tabweb:v1')
  })

  it('非 tabweb → null', () => {
    expect(deriveDisplayKey('tabdata:t1')).toBeNull()
  })

  it('null 输入 → null', () => {
    expect(deriveDisplayKey(null)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// patchDisplayRecord
// ---------------------------------------------------------------------------

describe('patchDisplayRecord', () => {
  it('tabweb activeKey → 写入 displayKey', () => {
    const result = patchDisplayRecord({}, 'sp1', 'tabweb:v1')
    expect(result).toEqual({ sp1: 'tabweb:v1' })
  })

  it('非 tabweb → 删除已有 displayKey', () => {
    const result = patchDisplayRecord({ sp1: 'tabweb:v1' }, 'sp1', 'tabdata:t1')
    expect(result).not.toHaveProperty('sp1')
  })

  it('已相同 → 返回同一引用', () => {
    const prev = { sp1: 'tabweb:v1' }
    const result = patchDisplayRecord(prev, 'sp1', 'tabweb:v1')
    expect(result).toBe(prev)
  })

  it('null activeKey + 无已有记录 → 返回同一引用', () => {
    const prev = {}
    const result = patchDisplayRecord(prev, 'sp1', null)
    expect(result).toBe(prev)
  })
})

// ---------------------------------------------------------------------------
// normalizePersistedState
// ---------------------------------------------------------------------------

describe('normalizePersistedState', () => {
  it('空输入 → 全为空对象', () => {
    const result = normalizePersistedState({})
    expect(result).toEqual({
      activeKeyBySpace: {},
      displayKeyBySpace: {},
      tabOrderBySpace: {},
      itemsBySpace: {},
      // P2-13：parentSessionId → runId 持久化映射，normalizePersistedState 一并归一。
      lastActiveSubagentByParentSession: {},
    })
  })

  it('activeKey 不在 tabOrder 中 → 保留给 restore coordinator 裁决', () => {
    const result = normalizePersistedState({
      activeKeyBySpace: { sp1: 'tabdata:t1' },
      tabOrderBySpace: { sp1: ['tabdata:t2'] },
      itemsBySpace: {
        sp1: {
          'tabdata:t2': { tabKey: 'tabdata:t2', type: 'tabdata', id: 't2' },
        },
      },
    })
    expect(result.activeKeyBySpace['sp1']).toBe('tabdata:t1')
  })

  it('activeKey 在 tabOrder 中 → 保留', () => {
    const result = normalizePersistedState({
      activeKeyBySpace: { sp1: 'tabdata:t1' },
      tabOrderBySpace: { sp1: ['tabdata:t1', 'tabdata:t2'] },
      itemsBySpace: {},
    })
    expect(result.activeKeyBySpace['sp1']).toBe('tabdata:t1')
  })

  it('browser: 前缀迁移为 tabweb:', () => {
    const result = normalizePersistedState({
      activeKeyBySpace: { sp1: 'browser:v1' },
      tabOrderBySpace: { sp1: ['browser:v1'] },
      itemsBySpace: {
        sp1: {
          'browser:v1': { tabKey: 'browser:v1', type: 'browser', id: 'v1' },
        },
      },
    })
    expect(result.tabOrderBySpace['sp1']).toEqual(['tabweb:v1'])
    expect(result.activeKeyBySpace['sp1']).toBe('tabweb:v1')
    expect(result.itemsBySpace['sp1']['tabweb:v1']).toBeDefined()
    expect(result.itemsBySpace['sp1']['tabweb:v1'].type).toBe('tabweb')
  })

  it('tabweb activeKey → displayKey 自动派生', () => {
    const result = normalizePersistedState({
      activeKeyBySpace: { sp1: 'tabweb:v1' },
      tabOrderBySpace: { sp1: ['tabweb:v1'] },
      itemsBySpace: {},
    })
    expect(result.displayKeyBySpace['sp1']).toBe('tabweb:v1')
  })

  it('非 tabweb activeKey → displayKey 不写入', () => {
    const result = normalizePersistedState({
      activeKeyBySpace: { sp1: 'tabdata:t1' },
      tabOrderBySpace: { sp1: ['tabdata:t1'] },
      itemsBySpace: {},
    })
    expect(result.displayKeyBySpace).not.toHaveProperty('sp1')
  })

  it('非法 activeKey → 置 null', () => {
    const result = normalizePersistedState({
      activeKeyBySpace: { sp1: 'badkey' },
      tabOrderBySpace: { sp1: ['tabdata:t1'] },
      itemsBySpace: {},
    })
    expect(result.activeKeyBySpace['sp1']).toBeNull()
  })

  it('items 中非法 tabKey 被过滤', () => {
    const result = normalizePersistedState({
      tabOrderBySpace: {},
      itemsBySpace: {
        sp1: {
          'bad': { tabKey: 'bad', type: 'tabdata', id: '1' },
          'tabdata:1': { tabKey: 'tabdata:1', type: 'tabdata', id: '1' },
        },
      },
    })
    expect(Object.keys(result.itemsBySpace['sp1'])).toEqual(['tabdata:1'])
  })

  it('tabOrder 去重', () => {
    const result = normalizePersistedState({
      tabOrderBySpace: { sp1: ['tabdata:1', 'tabdata:1', 'tabweb:v1'] },
      itemsBySpace: {
        sp1: {
          'tabdata:1': { tabKey: 'tabdata:1', type: 'tabdata', id: '1' },
          'tabweb:v1': { tabKey: 'tabweb:v1', type: 'tabweb', id: 'v1' },
        },
      },
    })
    expect(result.tabOrderBySpace['sp1']).toEqual(['tabdata:1', 'tabweb:v1'])
  })

  it('items 中的 originTabKey 被保留', () => {
    const result = normalizePersistedState({
      tabOrderBySpace: {},
      itemsBySpace: {
        sp1: {
          'tabdata:new1': {
            tabKey: 'tabdata:new1',
            type: 'tabdata',
            id: 'new1',
            originTabKey: 'tabdata:old1',
          },
        },
      },
    })
    expect(result.itemsBySpace['sp1']['tabdata:new1'].originTabKey).toBe('tabdata:old1')
  })

  it('tabOrderBySpace/itemsBySpace 为非对象时不崩溃', () => {
    const result = normalizePersistedState({
      tabOrderBySpace: 'invalid' as any,
      itemsBySpace: null as any,
    })
    expect(result.tabOrderBySpace).toEqual({})
    expect(result.itemsBySpace).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// mergeSyncedTabOrder
// ---------------------------------------------------------------------------

describe('mergeSyncedTabOrder', () => {
  it('空 incoming + items 仍有 tabdoc → 保留 order 中的 persistOnly', () => {
    const result = mergeSyncedTabOrder({
      existingOrder: ['tabdoc:d1', 'tabweb:v1'],
      incomingKeys: [],
      items: {
        'tabdoc:d1': { tabKey: 'tabdoc:d1', type: 'tabdoc', id: 'd1' },
      },
      isPersistOnlyKey: isTabDocPersistOnly,
    })
    expect(result.next).toEqual(['tabdoc:d1'])
    expect(result.preservedPersistOnly).toEqual(['tabdoc:d1'])
    expect(result.removed).toEqual(['tabweb:v1'])
  })

  it('order 已被掏空但 items 仍有 tabdoc → 从 items 回补', () => {
    const result = mergeSyncedTabOrder({
      existingOrder: [],
      incomingKeys: [],
      items: {
        'tabdoc:d1': { tabKey: 'tabdoc:d1', type: 'tabdoc', id: 'd1' },
      },
      isPersistOnlyKey: isTabDocPersistOnly,
    })
    expect(result.next).toEqual(['tabdoc:d1'])
    expect(result.preservedPersistOnly).toEqual(['tabdoc:d1'])
  })

  it('items 已无 persistOnly → 允许从 order 删除', () => {
    const result = mergeSyncedTabOrder({
      existingOrder: ['tabdoc:d1', 'tabweb:v1'],
      incomingKeys: ['tabweb:v1'],
      items: {},
      isPersistOnlyKey: isTabDocPersistOnly,
    })
    expect(result.next).toEqual(['tabweb:v1'])
    expect(result.removed).toEqual(['tabdoc:d1'])
    expect(result.preservedPersistOnly).toEqual([])
  })

  it('仅 live keys 增减与现网一致', () => {
    const result = mergeSyncedTabOrder({
      existingOrder: ['tabweb:v1'],
      incomingKeys: ['tabweb:v1', 'tabweb:v2'],
      items: {},
      isPersistOnlyKey: isTabDocPersistOnly,
      activeKey: 'tabweb:v1',
    })
    expect(result.next).toEqual(['tabweb:v1', 'tabweb:v2'])
    expect(result.added).toEqual(['tabweb:v2'])
  })

  it('discarded persistOnly 不保留', () => {
    const result = mergeSyncedTabOrder({
      existingOrder: ['tabdoc:d1'],
      incomingKeys: [],
      items: {
        'tabdoc:d1': {
          tabKey: 'tabdoc:d1',
          type: 'tabdoc',
          id: 'd1',
          meta: { discarded: true },
        },
      },
      isPersistOnlyKey: isTabDocPersistOnly,
    })
    expect(result.next).toEqual([])
  })
})
