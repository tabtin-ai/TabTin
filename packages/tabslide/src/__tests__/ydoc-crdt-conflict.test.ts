/**
 * J2-20: Y.js CRDT 冲突解决测试
 *
 * 使用两个独立 Y.Doc + applyUpdate 模拟双端并发编辑，
 * 验证应用层合并行为的正确性。
 */

import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import {
  getPagesMap,
  getPageOrderArray,
  getMetaMap,
  PAGE_ELEMENTS_MAP,
  PAGE_ELEMENT_ORDER,
} from '../collab/ydoc-schema'

// ── 工具函数 ──

function createDocWithPage(pageId: string, elements: Array<{ id: string; [k: string]: unknown }>) {
  const doc = new Y.Doc()
  const pages = getPagesMap(doc)
  const order = getPageOrderArray(doc)

  doc.transact(() => {
    const pageMap = new Y.Map<unknown>()
    const elemMap = new Y.Map<Y.Map<unknown>>()
    const elemOrder = new Y.Array<string>()

    for (const el of elements) {
      const yEl = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(el)) {
        yEl.set(k, v)
      }
      elemMap.set(el.id, yEl)
    }
    elemOrder.push(elements.map((e) => e.id))

    pageMap.set(PAGE_ELEMENTS_MAP, elemMap)
    pageMap.set(PAGE_ELEMENT_ORDER, elemOrder)
    pages.set(pageId, pageMap)
    order.push([pageId])
  })

  return doc
}

function syncDocs(source: Y.Doc, target: Y.Doc) {
  const sv = Y.encodeStateVector(target)
  const update = Y.encodeStateAsUpdate(source, sv)
  Y.applyUpdate(target, update)
}

function fullSync(docA: Y.Doc, docB: Y.Doc) {
  syncDocs(docA, docB)
  syncDocs(docB, docA)
}

function readElements(doc: Y.Doc, pageId: string): Record<string, Record<string, unknown>> {
  const pages = getPagesMap(doc)
  const page = pages.get(pageId) as Y.Map<unknown>
  const elemMap = page.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
  const result: Record<string, Record<string, unknown>> = {}
  elemMap.forEach((yEl, id) => {
    const obj: Record<string, unknown> = {}
    yEl.forEach((v, k) => {
      obj[k] = v instanceof Y.Map ? v.toJSON() : v
    })
    result[id] = obj
  })
  return result
}

function readElementOrder(doc: Y.Doc, pageId: string): string[] {
  const pages = getPagesMap(doc)
  const page = pages.get(pageId) as Y.Map<unknown>
  const order = page.get(PAGE_ELEMENT_ORDER) as Y.Array<string>
  return order.toArray()
}

// ── 测试用例 ──

describe('Y.js CRDT 冲突解决', () => {
  it('双端修改同一元素的不同属性 → 合并后两个属性都保留', () => {
    const docA = createDocWithPage('p1', [
      { id: 'el1', type: 'text', left: 0, top: 0, width: 100, height: 50, content: 'hello' },
    ])

    const docB = new Y.Doc()
    fullSync(docA, docB)

    // A 修改 left，B 修改 top
    const pagesA = getPagesMap(docA)
    const pageA = pagesA.get('p1') as Y.Map<unknown>
    const elemMapA = pageA.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    const pagesB = getPagesMap(docB)
    const pageB = pagesB.get('p1') as Y.Map<unknown>
    const elemMapB = pageB.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    docA.transact(() => {
      elemMapA.get('el1')!.set('left', 200)
    })

    docB.transact(() => {
      elemMapB.get('el1')!.set('top', 300)
    })

    fullSync(docA, docB)

    const elA = readElements(docA, 'p1')['el1']
    const elB = readElements(docB, 'p1')['el1']

    expect(elA.left).toBe(200)
    expect(elA.top).toBe(300)
    expect(elB.left).toBe(200)
    expect(elB.top).toBe(300)
  })

  it('双端修改同一元素的同一属性 → 两端收敛到相同值（LWW）', () => {
    const docA = createDocWithPage('p1', [
      { id: 'el1', type: 'text', left: 0, content: 'original' },
    ])
    const docB = new Y.Doc()
    fullSync(docA, docB)

    const pagesA = getPagesMap(docA)
    const elemMapA = (pagesA.get('p1') as Y.Map<unknown>).get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    const pagesB = getPagesMap(docB)
    const elemMapB = (pagesB.get('p1') as Y.Map<unknown>).get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    docA.transact(() => {
      elemMapA.get('el1')!.set('content', 'from A')
    })
    docB.transact(() => {
      elemMapB.get('el1')!.set('content', 'from B')
    })

    fullSync(docA, docB)

    const elA = readElements(docA, 'p1')['el1']
    const elB = readElements(docB, 'p1')['el1']

    // CRDT LWW: 两端必须收敛到同一值
    expect(elA.content).toBe(elB.content)
  })

  it('双端同时添加不同元素 → 合并后两个元素都存在', () => {
    const docA = createDocWithPage('p1', [
      { id: 'el1', type: 'text', content: 'base' },
    ])
    const docB = new Y.Doc()
    fullSync(docA, docB)

    const pagesA = getPagesMap(docA)
    const pageA = pagesA.get('p1') as Y.Map<unknown>
    const elemMapA = pageA.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    const elemOrderA = pageA.get(PAGE_ELEMENT_ORDER) as Y.Array<string>

    const pagesB = getPagesMap(docB)
    const pageB = pagesB.get('p1') as Y.Map<unknown>
    const elemMapB = pageB.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    const elemOrderB = pageB.get(PAGE_ELEMENT_ORDER) as Y.Array<string>

    docA.transact(() => {
      const newEl = new Y.Map<unknown>()
      newEl.set('id', 'el2')
      newEl.set('type', 'shape')
      elemMapA.set('el2', newEl)
      elemOrderA.push(['el2'])
    })

    docB.transact(() => {
      const newEl = new Y.Map<unknown>()
      newEl.set('id', 'el3')
      newEl.set('type', 'image')
      elemMapB.set('el3', newEl)
      elemOrderB.push(['el3'])
    })

    fullSync(docA, docB)

    const elemsA = readElements(docA, 'p1')
    const elemsB = readElements(docB, 'p1')

    expect(Object.keys(elemsA)).toContain('el1')
    expect(Object.keys(elemsA)).toContain('el2')
    expect(Object.keys(elemsA)).toContain('el3')
    expect(Object.keys(elemsB)).toContain('el1')
    expect(Object.keys(elemsB)).toContain('el2')
    expect(Object.keys(elemsB)).toContain('el3')

    const orderA = readElementOrder(docA, 'p1')
    const orderB = readElementOrder(docB, 'p1')
    expect(orderA).toEqual(orderB)
    expect(orderA).toContain('el1')
    expect(orderA).toContain('el2')
    expect(orderA).toContain('el3')
  })

  it('一端删除元素 + 另一端修改该元素 → 合并后元素被删除', () => {
    const docA = createDocWithPage('p1', [
      { id: 'el1', type: 'text', content: 'to be deleted' },
      { id: 'el2', type: 'text', content: 'keep' },
    ])
    const docB = new Y.Doc()
    fullSync(docA, docB)

    const pagesA = getPagesMap(docA)
    const pageA = pagesA.get('p1') as Y.Map<unknown>
    const elemMapA = pageA.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    const elemOrderA = pageA.get(PAGE_ELEMENT_ORDER) as Y.Array<string>

    const pagesB = getPagesMap(docB)
    const pageB = pagesB.get('p1') as Y.Map<unknown>
    const elemMapB = pageB.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    // A 删除 el1
    docA.transact(() => {
      elemMapA.delete('el1')
      for (let i = 0; i < elemOrderA.length; i++) {
        if (elemOrderA.get(i) === 'el1') {
          elemOrderA.delete(i, 1)
          break
        }
      }
    })

    // B 修改 el1
    docB.transact(() => {
      elemMapB.get('el1')!.set('content', 'modified by B')
    })

    fullSync(docA, docB)

    const elemsA = readElements(docA, 'p1')
    const elemsB = readElements(docB, 'p1')

    // Y.Map.delete 删除的是父 map 的 key，sub-key set 修改的是子 map 的属性，
    // 两者操作不同层级，delete 优先：el1 应被删除。
    // 核心断言：两端收敛 + el1 被删除
    expect(Object.keys(elemsA).sort()).toEqual(Object.keys(elemsB).sort())
    expect(elemsA['el1']).toBeUndefined()
    expect(elemsA['el2']).toBeDefined()
  })

  it('双端同时添加不同页面 → 合并后两个页面都存在', () => {
    const docA = createDocWithPage('p1', [{ id: 'el1', type: 'text' }])
    const docB = new Y.Doc()
    fullSync(docA, docB)

    const pagesA = getPagesMap(docA)
    const orderA = getPageOrderArray(docA)
    const pagesB = getPagesMap(docB)
    const orderB = getPageOrderArray(docB)

    docA.transact(() => {
      const p2 = new Y.Map<unknown>()
      p2.set(PAGE_ELEMENTS_MAP, new Y.Map())
      p2.set(PAGE_ELEMENT_ORDER, new Y.Array())
      pagesA.set('p2', p2)
      orderA.push(['p2'])
    })

    docB.transact(() => {
      const p3 = new Y.Map<unknown>()
      p3.set(PAGE_ELEMENTS_MAP, new Y.Map())
      p3.set(PAGE_ELEMENT_ORDER, new Y.Array())
      pagesB.set('p3', p3)
      orderB.push(['p3'])
    })

    fullSync(docA, docB)

    const pageKeysA = Array.from((pagesA as any).keys())
    const pageKeysB = Array.from((pagesB as any).keys())
    expect(pageKeysA.sort()).toEqual(pageKeysB.sort())
    expect(pageKeysA).toContain('p1')
    expect(pageKeysA).toContain('p2')
    expect(pageKeysA).toContain('p3')
  })

  it('双端同时修改 meta 的不同字段 → 合并后都保留', () => {
    const docA = new Y.Doc()
    const docB = new Y.Doc()

    const metaA = getMetaMap(docA)
    docA.transact(() => {
      metaA.set('version', 1)
      metaA.set('project_name', 'test')
    })

    fullSync(docA, docB)

    const metaB = getMetaMap(docB)

    docA.transact(() => {
      metaA.set('version', 2)
    })
    docB.transact(() => {
      metaB.set('project_name', 'renamed')
    })

    fullSync(docA, docB)

    expect(metaA.get('version')).toBe(2)
    expect(metaA.get('project_name')).toBe('renamed')
    expect(metaB.get('version')).toBe(2)
    expect(metaB.get('project_name')).toBe('renamed')
  })

  it('双端同时修改同一元素的嵌套对象属性 → 不同子字段自动合并', () => {
    const docA = createDocWithPage('p1', [
      { id: 'el1', type: 'text', left: 0, top: 0 },
    ])

    // 给 el1 添加一个嵌套 shadow 对象
    const pagesInit = getPagesMap(docA)
    const pageInit = pagesInit.get('p1') as Y.Map<unknown>
    const elemMapInit = pageInit.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    docA.transact(() => {
      const shadowMap = new Y.Map<unknown>()
      shadowMap.set('h', 2)
      shadowMap.set('v', 2)
      shadowMap.set('blur', 4)
      shadowMap.set('color', 'rgba(0,0,0,0.2)')
      elemMapInit.get('el1')!.set('shadow', shadowMap)
    })

    const docB = new Y.Doc()
    fullSync(docA, docB)

    const pagesA = getPagesMap(docA)
    const elemMapA = (pagesA.get('p1') as Y.Map<unknown>).get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    const pagesB = getPagesMap(docB)
    const elemMapB = (pagesB.get('p1') as Y.Map<unknown>).get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    // A 修改 shadow.h，B 修改 shadow.blur
    docA.transact(() => {
      const shadow = elemMapA.get('el1')!.get('shadow') as Y.Map<unknown>
      shadow.set('h', 10)
    })
    docB.transact(() => {
      const shadow = elemMapB.get('el1')!.get('shadow') as Y.Map<unknown>
      shadow.set('blur', 8)
    })

    fullSync(docA, docB)

    const shadowA = (elemMapA.get('el1')!.get('shadow') as Y.Map<unknown>).toJSON()
    const shadowB = (elemMapB.get('el1')!.get('shadow') as Y.Map<unknown>).toJSON()

    expect(shadowA).toEqual({ h: 10, v: 2, blur: 8, color: 'rgba(0,0,0,0.2)' })
    expect(shadowB).toEqual(shadowA)
  })

  it('pageOrder 并发 insert 后两端收敛到相同顺序', () => {
    const docA = new Y.Doc()
    const orderA = getPageOrderArray(docA)
    docA.transact(() => { orderA.push(['p1']) })

    const docB = new Y.Doc()
    fullSync(docA, docB)
    const orderB = getPageOrderArray(docB)

    docA.transact(() => { orderA.push(['p2']) })
    docB.transact(() => { orderB.push(['p3']) })

    fullSync(docA, docB)

    const resultA = orderA.toArray()
    const resultB = orderB.toArray()

    expect(resultA).toEqual(resultB)
    expect(resultA).toContain('p1')
    expect(resultA).toContain('p2')
    expect(resultA).toContain('p3')
  })

  it('observe 回调仅对远端事务触发（origin != "local"）', () => {
    const docA = createDocWithPage('p1', [{ id: 'el1', type: 'text' }])
    const docB = new Y.Doc()
    fullSync(docA, docB)

    const remoteChanges: string[] = []
    const pagesB = getPagesMap(docB)
    pagesB.observeDeep((events, txn) => {
      if (txn.origin === 'local') return
      remoteChanges.push('remote-change')
    })

    // 本地事务不应触发回调
    const pageB = pagesB.get('p1') as Y.Map<unknown>
    const elemMapB = pageB.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    docB.transact(() => {
      elemMapB.get('el1')!.set('left', 999)
    }, 'local')

    expect(remoteChanges).toHaveLength(0)

    // 来自 docA 的远端变更应触发回调
    const pagesA = getPagesMap(docA)
    const elemMapA = (pagesA.get('p1') as Y.Map<unknown>).get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    docA.transact(() => {
      elemMapA.get('el1')!.set('left', 500)
    })
    syncDocs(docA, docB)

    expect(remoteChanges).toHaveLength(1)
  })
})
