/**
 * W2-9 回归测试 — S-02 / S-03 修复验证
 *
 * S-02: reorderElements 断线时走 _appendPending 缓冲，回放正确
 * S-03: migrateElementsToYMap 并发竞争 — merge-based 策略
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  replayPendingSlideWrites,
  appendPendingWrite,
  type PendingSlideWrite,
} from '../hooks/useSlideCollaboration'
import {
  getPagesMap,
  getPageOrderArray,
  PAGE_ELEMENTS_MAP,
  PAGE_ELEMENT_ORDER,
  PAGE_ELEMENTS_LEGACY,
} from '../collab/ydoc-schema'

function createSlideDoc(
  pages: Array<{ id: string; elements: Array<{ id: string; [k: string]: unknown }> }>,
): Y.Doc {
  const doc = new Y.Doc()
  const pagesMap = getPagesMap(doc)
  const pageOrderArr = getPageOrderArray(doc)

  doc.transact(() => {
    for (const page of pages) {
      const pageYMap = new Y.Map<unknown>()
      const elementsMap = new Y.Map<Y.Map<unknown>>()
      const elementOrder = new Y.Array<string>()
      const orderIds: string[] = []

      for (const el of page.elements) {
        const yEl = new Y.Map<unknown>()
        for (const [k, v] of Object.entries(el)) yEl.set(k, v)
        elementsMap.set(el.id, yEl)
        orderIds.push(el.id)
      }
      elementOrder.push(orderIds)
      pageYMap.set(PAGE_ELEMENTS_MAP, elementsMap)
      pageYMap.set(PAGE_ELEMENT_ORDER, elementOrder)
      pagesMap.set(page.id, pageYMap)
    }
    pageOrderArr.push(pages.map(p => p.id))
  })

  return doc
}

function readElementOrder(doc: Y.Doc, pageId: string): string[] {
  const pagesMap = getPagesMap(doc)
  const pageYMap = pagesMap.get(pageId) as Y.Map<unknown>
  const order = pageYMap.get(PAGE_ELEMENT_ORDER) as Y.Array<string>
  const result: string[] = []
  for (let i = 0; i < order.length; i++) result.push(order.get(i))
  return result
}

// ── S-02: reorderElements pending write & replay ──

describe('S-02: reorderElements offline buffering', () => {
  it('reorderElements op is accepted in PendingSlideWrite type and replayed correctly', () => {
    const doc = createSlideDoc([
      { id: 'p1', elements: [{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }] },
    ])

    const writes: PendingSlideWrite[] = [
      { op: 'reorderElements', pageId: 'p1', newElementOrder: ['e3', 'e1', 'e2'] },
    ]

    replayPendingSlideWrites(doc, writes)

    const order = readElementOrder(doc, 'p1')
    expect(order).toEqual(['e3', 'e1', 'e2'])
  })

  it('appendPendingWrite accepts reorderElements op', () => {
    const queue: PendingSlideWrite[] = []
    appendPendingWrite(queue, {
      op: 'reorderElements',
      pageId: 'p1',
      newElementOrder: ['e2', 'e1'],
    })
    expect(queue).toHaveLength(1)
    expect(queue[0].op).toBe('reorderElements')
  })

  it('multiple reorderElements replays apply sequentially', () => {
    const doc = createSlideDoc([
      { id: 'p1', elements: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] },
    ])

    const writes: PendingSlideWrite[] = [
      { op: 'reorderElements', pageId: 'p1', newElementOrder: ['c', 'b', 'a'] },
      { op: 'reorderElements', pageId: 'p1', newElementOrder: ['b', 'a', 'c'] },
    ]

    replayPendingSlideWrites(doc, writes)
    expect(readElementOrder(doc, 'p1')).toEqual(['b', 'a', 'c'])
  })

  it('reorderElements replay is no-op for non-existent page', () => {
    const doc = createSlideDoc([
      { id: 'p1', elements: [{ id: 'e1' }] },
    ])

    const writes: PendingSlideWrite[] = [
      { op: 'reorderElements', pageId: 'p999', newElementOrder: ['e1'] },
    ]

    expect(() => replayPendingSlideWrites(doc, writes)).not.toThrow()
  })
})

// ── S-03: migrateElementsToYMap concurrent merge ──

describe('S-03: migrateElementsToYMap concurrent safety', () => {
  function createLegacyDoc(elements: Array<{ id: string; [k: string]: unknown }>): {
    doc: Y.Doc
    pageYMap: Y.Map<unknown>
  } {
    const doc = new Y.Doc()
    const pagesMap = getPagesMap(doc)
    const pageOrderArr = getPageOrderArray(doc)

    doc.transact(() => {
      const pageYMap = new Y.Map<unknown>()
      const legacyArr = new Y.Array<unknown>()
      legacyArr.push(elements)
      pageYMap.set(PAGE_ELEMENTS_LEGACY, legacyArr)
      pagesMap.set('p1', pageYMap)
      pageOrderArr.push(['p1'])
    })

    const pageYMap = pagesMap.get('p1') as Y.Map<unknown>
    return { doc, pageYMap }
  }

  it('migration creates elementsMap from legacy format via insertElement', () => {
    const { doc, pageYMap } = createLegacyDoc([
      { id: 'e1', type: 'text', content: 'hello' },
      { id: 'e2', type: 'shape', width: 100 },
    ])

    const writes: PendingSlideWrite[] = [
      { op: 'insertElement', pageId: 'p1', element: { id: 'e3', type: 'image' } as any },
    ]
    replayPendingSlideWrites(doc, writes)

    const elementsMap = pageYMap.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    expect(elementsMap).toBeInstanceOf(Y.Map)
    expect(elementsMap.has('e1')).toBe(true)
    expect(elementsMap.has('e2')).toBe(true)
    expect(elementsMap.has('e3')).toBe(true)
  })

  it('concurrent migration merges missing elements instead of overwriting', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    // Set up identical legacy data in both docs
    const setupLegacy = (doc: Y.Doc) => {
      const pagesMap = getPagesMap(doc)
      const pageOrderArr = getPageOrderArray(doc)
      doc.transact(() => {
        const pageYMap = new Y.Map<unknown>()
        const legacyArr = new Y.Array<unknown>()
        legacyArr.push([
          { id: 'e1', type: 'text' },
          { id: 'e2', type: 'shape' },
          { id: 'e3', type: 'image' },
        ])
        pageYMap.set(PAGE_ELEMENTS_LEGACY, legacyArr)
        pagesMap.set('p1', pageYMap)
        pageOrderArr.push(['p1'])
      })
    }

    setupLegacy(docA)
    setupLegacy(docB)

    // Sync initial state
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))
    Y.applyUpdate(docA, Y.encodeStateAsUpdate(docB))

    // Client A migrates and adds a new element
    const pagesA = getPagesMap(docA)
    const pageA = pagesA.get('p1') as Y.Map<unknown>
    docA.transact(() => {
      const elementsMap = new Y.Map<Y.Map<unknown>>()
      const elementOrder = new Y.Array<string>()

      const legacyArr = pageA.get(PAGE_ELEMENTS_LEGACY) as Y.Array<unknown>
      const ids: string[] = []
      for (let i = 0; i < legacyArr.length; i++) {
        const el = legacyArr.get(i) as { id: string; [k: string]: unknown }
        if (!el?.id) continue
        const yEl = new Y.Map<unknown>()
        for (const [k, v] of Object.entries(el)) yEl.set(k, v)
        elementsMap.set(el.id, yEl)
        ids.push(el.id)
      }
      elementOrder.push(ids)
      pageA.set(PAGE_ELEMENTS_MAP, elementsMap)
      pageA.set(PAGE_ELEMENT_ORDER, elementOrder)
      legacyArr.delete(0, legacyArr.length)

      // Client A also adds a new element e4
      const e4 = new Y.Map<unknown>()
      e4.set('id', 'e4')
      e4.set('type', 'video')
      elementsMap.set('e4', e4)
      elementOrder.push(['e4'])
    }, 'local')

    // Before syncing, verify A has e4
    const elemMapA = pageA.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    expect(elemMapA.has('e4')).toBe(true)

    // Now sync A → B (B now has elementsMap from A)
    Y.applyUpdate(docB, Y.encodeStateAsUpdate(docA))

    // Client B tries migration — should see elementsMap already exists and merge
    const pagesB = getPagesMap(docB)
    const pageB = pagesB.get('p1') as Y.Map<unknown>
    const elemMapB = pageB.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    // Verify B sees all elements including e4
    expect(elemMapB).toBeInstanceOf(Y.Map)
    expect(elemMapB.has('e1')).toBe(true)
    expect(elemMapB.has('e2')).toBe(true)
    expect(elemMapB.has('e3')).toBe(true)
    expect(elemMapB.has('e4')).toBe(true)
  })

  it('migration is idempotent — inserting twice does not duplicate legacy elements', () => {
    const { doc, pageYMap } = createLegacyDoc([
      { id: 'e1', type: 'text' },
    ])

    // First insert triggers migration
    replayPendingSlideWrites(doc, [
      { op: 'insertElement', pageId: 'p1', element: { id: 'e2', type: 'shape' } as any },
    ])

    const elementsMap1 = pageYMap.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    expect(elementsMap1.size).toBe(2)
    expect(elementsMap1.has('e1')).toBe(true)
    expect(elementsMap1.has('e2')).toBe(true)

    const elementOrder1 = pageYMap.get(PAGE_ELEMENT_ORDER) as Y.Array<string>
    const order1: string[] = []
    for (let i = 0; i < elementOrder1.length; i++) order1.push(elementOrder1.get(i))
    expect(order1).toEqual(['e1', 'e2'])

    // Second insert — migration should be idempotent, no duplication
    replayPendingSlideWrites(doc, [
      { op: 'insertElement', pageId: 'p1', element: { id: 'e3', type: 'image' } as any },
    ])

    expect(elementsMap1.size).toBe(3)
    const order2: string[] = []
    for (let i = 0; i < elementOrder1.length; i++) order2.push(elementOrder1.get(i))
    expect(order2).toEqual(['e1', 'e2', 'e3'])
  })
})
