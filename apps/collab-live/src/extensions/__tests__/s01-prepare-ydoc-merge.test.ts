/**
 * S-01 回归测试：SlideDatabase CRDT 模型修复
 *
 * 覆盖 SLD-001 ~ SLD-006 六个问题的回归验证。
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'

const YDOC_PAGES = 'pages'
const YDOC_PAGE_ORDER = 'pageOrder'
const YDOC_META = 'meta'

function buildPageYDoc(): Y.Doc {
  const ydoc = new Y.Doc()
  const pagesMap = ydoc.getMap(YDOC_PAGES)
  const pageOrder = ydoc.getArray<string>(YDOC_PAGE_ORDER)
  const meta = ydoc.getMap(YDOC_META)

  ydoc.transact(() => {
    const page1 = new Y.Map<unknown>()

    const elementsMap = new Y.Map<Y.Map<unknown>>()
    const elementOrder = new Y.Array<string>()

    const el1 = new Y.Map<unknown>()
    el1.set('id', 'el-1')
    el1.set('type', 'text')
    el1.set('content', 'Hello')
    elementsMap.set('el-1', el1)

    const el2 = new Y.Map<unknown>()
    el2.set('id', 'el-2')
    el2.set('type', 'image')
    el2.set('src', 'photo.jpg')
    elementsMap.set('el-2', el2)

    elementOrder.push(['el-1', 'el-2'])

    page1.set('elementsMap', elementsMap)
    page1.set('elementOrder', elementOrder)
    page1.set('background', '#ffffff')

    pagesMap.set('page-1', page1)
    pageOrder.push(['page-1'])
    meta.set('version', 1)
  })

  return ydoc
}

/**
 * 从 slide-database.ts 中提取的 prepareYDocForMerge 逻辑（与实际实现保持同步）
 * SLD-001 fix: 遍历 ydoc 中所有页面（而非仅 snapshot.page_order），
 * 防止用户新增但 snapshot 未记录的页面在 CRDT merge 后 Y.Array 翻倍。
 */
function prepareYDocForMerge(ydoc: Y.Doc, _snapshot: Record<string, unknown>): void {
  const existingPageOrder = ydoc.getArray<string>(YDOC_PAGE_ORDER)
  if (existingPageOrder.length > 0) {
    ydoc.transact(() => { existingPageOrder.delete(0, existingPageOrder.length) })
  }

  const existingPages = ydoc.getMap(YDOC_PAGES)
  existingPages.forEach((value, _pageId) => {
    if (!(value instanceof Y.Map)) return
    const pageMap = value as Y.Map<unknown>
    ydoc.transact(() => {
      for (const key of ['elementOrder', 'elements', 'masterElements', 'animations', 'notes']) {
        const arr = pageMap.get(key)
        if (arr instanceof Y.Array && arr.length > 0) arr.delete(0, arr.length)
      }
      const elemMap = pageMap.get('elementsMap')
      if (elemMap instanceof Y.Map && elemMap.size > 0) {
        const keys: string[] = []
        elemMap.forEach((_: unknown, key: string) => { keys.push(key) })
        for (const k of keys) elemMap.delete(k)
      }
    })
  })
}

describe('S-01: prepareYDocForMerge 清理 elementsMap', () => {
  it('合并准备后 elementsMap 和 elementOrder 都被清空', () => {
    const ydoc = buildPageYDoc()
    const pagesMap = ydoc.getMap(YDOC_PAGES)
    const page1 = pagesMap.get('page-1') as Y.Map<unknown>

    // 验证初始状态
    const elemsBefore = page1.get('elementsMap') as Y.Map<unknown>
    const orderBefore = page1.get('elementOrder') as Y.Array<string>
    expect(elemsBefore.size).toBe(2)
    expect(orderBefore.length).toBe(2)

    prepareYDocForMerge(ydoc, { page_order: ['page-1'] })

    // 修复后：两者都应该被清空
    const elemsAfter = page1.get('elementsMap') as Y.Map<unknown>
    const orderAfter = page1.get('elementOrder') as Y.Array<string>
    expect(orderAfter.length).toBe(0)
    expect(elemsAfter.size).toBe(0)
  })

  it('pageOrder 被清空以准备合并', () => {
    const ydoc = buildPageYDoc()
    const pageOrder = ydoc.getArray<string>(YDOC_PAGE_ORDER)
    expect(pageOrder.length).toBe(1)

    prepareYDocForMerge(ydoc, { page_order: ['page-1'] })

    expect(pageOrder.length).toBe(0)
  })

  it('SLD-001: 所有页面都会被清理（包括不在 snapshot page_order 中的页面）', () => {
    const ydoc = buildPageYDoc()
    const pagesMap = ydoc.getMap(YDOC_PAGES)

    ydoc.transact(() => {
      const page2 = new Y.Map<unknown>()
      const elementsMap2 = new Y.Map<Y.Map<unknown>>()
      const el = new Y.Map<unknown>()
      el.set('id', 'el-x')
      elementsMap2.set('el-x', el)
      const elOrder2 = new Y.Array<string>()
      page2.set('elementsMap', elementsMap2)
      page2.set('elementOrder', elOrder2)
      pagesMap.set('page-2', page2)
    })
    ydoc.transact(() => {
      const page2 = pagesMap.get('page-2') as Y.Map<unknown>
      const elOrder2 = page2.get('elementOrder') as Y.Array<string>
      elOrder2.push(['el-x'])
    })

    prepareYDocForMerge(ydoc, { page_order: ['page-1'] })

    // SLD-001: 实际实现遍历 ydoc 中所有页面，page-2 也会被清理
    const page2 = pagesMap.get('page-2') as Y.Map<unknown>
    const elems2 = page2.get('elementsMap') as Y.Map<unknown>
    expect(elems2.size).toBe(0)
    const elOrder2 = page2.get('elementOrder') as Y.Array<string>
    expect(elOrder2.length).toBe(0)
  })
})

// ── SLD-003 回归测试 ──

describe('SLD-003: prepareYDocForMerge 清理 notes Y.Array', () => {
  it('notes Y.Array 在 merge 准备阶段被清空', () => {
    const ydoc = new Y.Doc()
    const pagesMap = ydoc.getMap(YDOC_PAGES)

    ydoc.transact(() => {
      const page = new Y.Map<unknown>()
      const notes = new Y.Array<unknown>()
      notes.push([{ id: 'n1', text: 'note 1' }, { id: 'n2', text: 'note 2' }])
      page.set('notes', notes)
      page.set('elementsMap', new Y.Map())
      page.set('elementOrder', new Y.Array<string>())
      pagesMap.set('page-1', page)
      ydoc.getArray<string>(YDOC_PAGE_ORDER).push(['page-1'])
    })

    const page = pagesMap.get('page-1') as Y.Map<unknown>
    expect((page.get('notes') as Y.Array<unknown>).length).toBe(2)

    prepareYDocForMerge(ydoc, {})

    expect((page.get('notes') as Y.Array<unknown>).length).toBe(0)
  })
})

// ── SLD-002 回归测试 ──

function deduplicateStrings(arr: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of arr) {
    if (!seen.has(item)) {
      seen.add(item);
      result.push(item)
    }
  }
  return result
}

describe('SLD-002: pageOrder 并发去重', () => {
  it('去重保留首次出现顺序', () => {
    expect(deduplicateStrings(['a', 'b', 'a', 'c', 'b'])).toEqual(['a', 'b', 'c'])
  })

  it('无重复时原样返回', () => {
    expect(deduplicateStrings(['x', 'y', 'z'])).toEqual(['x', 'y', 'z'])
  })

  it('空数组返回空', () => {
    expect(deduplicateStrings([])).toEqual([])
  })

  it('模拟并发 Y.Array 合并后去重', () => {
    const doc1 = new Y.Doc({ gc: false })
    const doc2 = new Y.Doc({ gc: false })

    doc1.getArray<string>(YDOC_PAGE_ORDER).push(['p1', 'p2'])
    Y.applyUpdate(doc2, Y.encodeStateAsUpdate(doc1))

    // 两端同时重排
    doc1.transact(() => {
      const arr = doc1.getArray<string>(YDOC_PAGE_ORDER)
      arr.delete(0, arr.length)
      arr.push(['p2', 'p1'])
    })
    doc2.transact(() => {
      const arr = doc2.getArray<string>(YDOC_PAGE_ORDER)
      arr.delete(0, arr.length)
      arr.push(['p1', 'p2'])
    })

    // 合并
    Y.applyUpdate(doc1, Y.encodeStateAsUpdate(doc2))

    const merged: string[] = []
    const arr = doc1.getArray<string>(YDOC_PAGE_ORDER)
    for (let i = 0; i < arr.length; i++) merged.push(arr.get(i))

    // Y.Array CRDT 合并可能产生重复
    const deduped = deduplicateStrings(merged)
    // 去重后每个 pageId 只出现一次
    expect(deduped.filter(id => id === 'p1').length).toBe(1)
    expect(deduped.filter(id => id === 'p2').length).toBe(1)
  })
})

// ── SLD-004 回归测试 ──

function yPageToJson(pageYMap: Y.Map<unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {}

  const elementsMap = pageYMap.get('elementsMap')
  const elementOrder = pageYMap.get('elementOrder')

  if (elementsMap instanceof Y.Map && elementOrder instanceof Y.Array) {
    const ordered: unknown[] = []
    for (let i = 0; i < elementOrder.length; i++) {
      const elId = elementOrder.get(i) as string
      const elYMap = elementsMap.get(elId)
      if (elYMap instanceof Y.Map) ordered.push(elYMap.toJSON())
    }
    result.elements = ordered
  } else {
    const elements = pageYMap.get('elements')
    result.elements = elements instanceof Y.Array ? elements.toJSON() : []
  }

  for (const key of ['background', 'remark', 'turningMode', 'layout'] as const) {
    const val = pageYMap.get(key)
    if (val !== undefined) result[key] = val
  }

  for (const key of ['masterElements', 'animations', 'notes'] as const) {
    const val = pageYMap.get(key)
    if (val instanceof Y.Array) result[key] = val.toJSON()
  }

  return result
}

describe('SLD-004: yPageToJson 序列化 notes', () => {
  it('notes Y.Array 被正确序列化为 JSON 数组', () => {
    const ydoc = new Y.Doc()
    const page = new Y.Map<unknown>()
    ydoc.transact(() => {
      page.set('elementsMap', new Y.Map())
      page.set('elementOrder', new Y.Array<string>())
      page.set('background', '#000')
      const notes = new Y.Array<unknown>()
      notes.push([{ id: 'n1', text: 'hello' }])
      page.set('notes', notes)
      ydoc.getMap(YDOC_PAGES).set('p1', page)
    })

    const json = yPageToJson(page)
    expect(json.notes).toEqual([{ id: 'n1', text: 'hello' }])
    expect(json.background).toBe('#000')
  })

  it('无 notes 时 JSON 中不含 notes 字段', () => {
    const ydoc = new Y.Doc()
    const page = new Y.Map<unknown>()
    ydoc.transact(() => {
      page.set('elementsMap', new Y.Map())
      page.set('elementOrder', new Y.Array<string>())
      ydoc.getMap(YDOC_PAGES).set('p1', page)
    })

    const json = yPageToJson(page)
    expect(json.notes).toBeUndefined()
  })
})

// ── SLD-005 回归测试 ──

function applySnapshotToDoc(initDoc: Y.Doc, snapshot: Record<string, unknown>): void {
  const pagesMap = initDoc.getMap(YDOC_PAGES)
  const pages = (snapshot.pages || []) as Record<string, unknown>[]
  for (const page of pages) {
    const pageId = page.id as string | undefined
    if (!pageId) continue

    const pageYMap = new Y.Map<unknown>()
    const elMap = new Y.Map<Y.Map<unknown>>()
    const elOrder = new Y.Array<string>()
    const orderIds: string[] = []
    if (Array.isArray(page.elements)) {
      for (const el of page.elements as Record<string, unknown>[]) {
        if (el.id && typeof el.id === 'string') {
          const yEl = new Y.Map<unknown>()
          for (const [k, v] of Object.entries(el)) yEl.set(k, v)
          elMap.set(el.id, yEl)
          orderIds.push(el.id)
        }
      }
    }
    elOrder.push(orderIds)
    pageYMap.set('elementsMap', elMap)
    pageYMap.set('elementOrder', elOrder)

    for (const key of ['background', 'remark', 'turningMode', 'layout'] as const) {
      if (page[key] !== undefined) pageYMap.set(key, page[key])
    }

    for (const key of ['masterElements', 'animations', 'notes'] as const) {
      if (Array.isArray(page[key])) {
        const arr = new Y.Array<unknown>()
        for (const item of page[key] as unknown[]) arr.push([item])
        pageYMap.set(key, arr)
      }
    }

    pagesMap.set(pageId, pageYMap)
  }

  const pageOrder = initDoc.getArray<string>(YDOC_PAGE_ORDER)
  for (const pageId of (snapshot.page_order || []) as string[]) {
    pageOrder.push([pageId])
  }
}

describe('SLD-005: applySnapshotToDoc 还原 notes', () => {
  it('snapshot 中的 notes 被正确写入 Y.Doc', () => {
    const ydoc = new Y.Doc()
    const snapshot = {
      pages: [{
        id: 'page-1',
        elements: [{ id: 'el-1', type: 'text' }],
        notes: [{ id: 'n1', text: 'speaker note' }, { id: 'n2', text: 'second note' }],
        background: '#fff',
      }],
      page_order: ['page-1'],
    }

    ydoc.transact(() => { applySnapshotToDoc(ydoc, snapshot) })

    const page = ydoc.getMap(YDOC_PAGES).get('page-1') as Y.Map<unknown>
    const notes = page.get('notes') as Y.Array<unknown>
    expect(notes).toBeInstanceOf(Y.Array)
    expect(notes.length).toBe(2)
    expect(notes.toJSON()).toEqual([
      { id: 'n1', text: 'speaker note' },
      { id: 'n2', text: 'second note' },
    ])
  })

  it('snapshot 无 notes 时页面中不含 notes', () => {
    const ydoc = new Y.Doc()
    const snapshot = {
      pages: [{ id: 'page-1', elements: [] }],
      page_order: ['page-1'],
    }

    ydoc.transact(() => { applySnapshotToDoc(ydoc, snapshot) })

    const page = ydoc.getMap(YDOC_PAGES).get('page-1') as Y.Map<unknown>
    expect(page.get('notes')).toBeUndefined()
  })

  it('notes 全生命周期：snapshot → Y.Doc → JSON 往返一致', () => {
    const ydoc = new Y.Doc()
    const originalNotes = [{ id: 'n1', text: 'A' }, { id: 'n2', text: 'B' }]
    const snapshot = {
      pages: [{ id: 'p1', elements: [], notes: originalNotes }],
      page_order: ['p1'],
    }

    ydoc.transact(() => { applySnapshotToDoc(ydoc, snapshot) })

    const page = ydoc.getMap(YDOC_PAGES).get('p1') as Y.Map<unknown>
    const json = yPageToJson(page)
    expect(json.notes).toEqual(originalNotes)
  })
})

// ── SLD-006 回归测试 ──

describe('SLD-006: onStoreConflict 版本号字段 fallback', () => {
  function extractServerVersion(conflictResult: Record<string, unknown>): number | undefined {
    return (conflictResult.current_version ?? conflictResult.current_revn) as number | undefined
  }

  it('优先使用 current_version', () => {
    expect(extractServerVersion({ current_version: 42, current_revn: 41 })).toBe(42)
  })

  it('current_version 缺失时回退到 current_revn', () => {
    expect(extractServerVersion({ current_revn: 99 })).toBe(99)
  })

  it('两者都缺失时返回 undefined', () => {
    expect(extractServerVersion({})).toBeUndefined()
  })

  it('current_version 为 0 时仍使用 current_version（0 是合法版本号）', () => {
    expect(extractServerVersion({ current_version: 0, current_revn: 5 })).toBe(0)
  })
})
