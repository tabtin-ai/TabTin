/**
 *  回归测试：版本还原 resync delta 的「权威覆盖」语义。
 *
 * 验证 computeResyncDelta 生成的 delta 应用到在线客户端文档后，
 * 客户端内容与还原目标完全一致——包括删除被还原删掉的条目（行 / 文本），
 * 而非像重连合并那样保留并发条目。
 */
import { describe, it, expect } from 'vitest'
import * as Y from 'yjs'
import { computeResyncDelta } from '../lib/resync.js'
import { replaceXmlFragment } from '../apply-ops/executor.js'

const RECORDS = 'records'
const ROW_ORDER_MAP = 'rowOrderMap'
const META = 'meta'

// 给每个测试 Y.Doc 指定唯一 clientID，避免随机 clientID 偶发碰撞导致
// target 结构被误判为「已存在」而跳过（Yjs 固有特性，与被测算法无关）。
let _clientIdSeq = 1000
function freshDoc(): Y.Doc {
  const doc = new Y.Doc()
  doc.clientID = ++_clientIdSeq
  return doc
}

/** 构建一个 table 形态的 Y.Doc（records Y.Map<id, Y.Map<field, value>> + rowOrderMap + meta）。 */
function buildTableDoc(
  records: Record<string, Record<string, unknown>>,
  rowOrder: string[],
  fields: unknown[],
): Y.Doc {
  const doc = freshDoc()
  doc.transact(() => {
    const recordsMap = doc.getMap(RECORDS)
    for (const [id, fieldValues] of Object.entries(records)) {
      const rec = new Y.Map<unknown>()
      for (const [k, v] of Object.entries(fieldValues)) rec.set(k, v)
      recordsMap.set(id, rec)
    }
    const rowOrderMap = doc.getMap<number>(ROW_ORDER_MAP)
    rowOrder.forEach((id, i) => rowOrderMap.set(id, i))
    doc.getMap(META).set('fields', fields)
  })
  return doc
}

function readTable(doc: Y.Doc): {
  records: Record<string, Record<string, unknown>>
  rowOrder: string[]
  fields: unknown
} {
  const recordsMap = doc.getMap(RECORDS)
  const records: Record<string, Record<string, unknown>> = {}
  recordsMap.forEach((value, id) => {
    if (value instanceof Y.Map) {
      const fieldValues: Record<string, unknown> = {}
      value.forEach((v, k) => { fieldValues[k] = v })
      records[id] = fieldValues
    }
  })
  const rowOrderMap = doc.getMap<number>(ROW_ORDER_MAP)
  const rowOrder: string[] = []
  rowOrderMap.forEach((_pos, id) => rowOrder.push(id))
  rowOrder.sort((a, b) => (rowOrderMap.get(a)! - rowOrderMap.get(b)!))
  return { records, rowOrder, fields: doc.getMap(META).get('fields') }
}

describe(' computeResyncDelta — table 权威覆盖', () => {
  it('删行 + 改格 + 加行：在线客户端收敛到还原目标', () => {
    // 当前在线内容：r1/r2/r3
    const live = buildTableDoc(
      { r1: { f0: 'a1' }, r2: { f0: 'b1' }, r3: { f0: 'c1' } },
      ['r1', 'r2', 'r3'],
      [{ id: 'f0' }],
    )
    // 模拟一个在线客户端，与服务端同步（共享 struct）
    const client = freshDoc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(live))

    // 还原目标（v5）：r2 被删，r1 改值，新增 r4；保留 r3
    const target = buildTableDoc(
      { r1: { f0: 'a1-restored' }, r3: { f0: 'c1' }, r4: { f0: 'd1' } },
      ['r1', 'r3', 'r4'],
      [{ id: 'f0' }],
    )
    const targetState = Y.encodeStateAsUpdate(target)

    const delta = computeResyncDelta(live, targetState)
    // 广播：客户端应用 delta
    Y.applyUpdate(client, delta)

    const result = readTable(client)
    expect(Object.keys(result.records).sort()).toEqual(['r1', 'r3', 'r4'])
    expect(result.records.r1.f0).toBe('a1-restored')
    expect(result.records.r2).toBeUndefined()
    expect(result.records.r4.f0).toBe('d1')
    expect(result.rowOrder).toEqual(['r1', 'r3', 'r4'])

    live.destroy(); client.destroy(); target.destroy()
  })

  it('删除字段：record 内多余字段被移除', () => {
    const live = buildTableDoc(
      { r1: { f0: 'x', f1: 'y', f2: 'z' } },
      ['r1'],
      [{ id: 'f0' }, { id: 'f1' }, { id: 'f2' }],
    )
    const client = freshDoc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(live))

    // 还原目标只保留 f0
    const target = buildTableDoc({ r1: { f0: 'x' } }, ['r1'], [{ id: 'f0' }])
    const delta = computeResyncDelta(live, Y.encodeStateAsUpdate(target))
    Y.applyUpdate(client, delta)

    const result = readTable(client)
    expect(result.records.r1).toEqual({ f0: 'x' })
    expect(result.fields).toEqual([{ id: 'f0' }])

    live.destroy(); client.destroy(); target.destroy()
  })

  it('delta 应用到服务端 live 文档自身也产生一致结果', () => {
    const live = buildTableDoc(
      { r1: { f0: 'a1' }, r2: { f0: 'b1' } },
      ['r1', 'r2'],
      [{ id: 'f0' }],
    )
    const target = buildTableDoc({ r1: { f0: 'a1' } }, ['r1'], [{ id: 'f0' }])
    const delta = computeResyncDelta(live, Y.encodeStateAsUpdate(target))
    Y.applyUpdate(live, delta)

    const result = readTable(live)
    expect(Object.keys(result.records)).toEqual(['r1'])
    expect(result.rowOrder).toEqual(['r1'])

    live.destroy(); target.destroy()
  })
})

describe(' computeResyncDelta — 多层嵌套（slide/canvas 形态）', () => {
  // pages: Y.Map<pageId, Y.Map{ elementsMap: Y.Map<elId, Y.Map>, elementOrder: Y.Array }>
  function buildSlideDoc(spec: Record<string, string[]>): Y.Doc {
    const doc = freshDoc()
    doc.transact(() => {
      const pages = doc.getMap('pages')
      const pageOrder = doc.getArray<string>('pageOrder')
      for (const [pageId, elementIds] of Object.entries(spec)) {
        const page = new Y.Map<unknown>()
        const elementsMap = new Y.Map<Y.Map<unknown>>()
        const elementOrder = new Y.Array<string>()
        for (const elId of elementIds) {
          const el = new Y.Map<unknown>()
          el.set('id', elId)
          el.set('content', `c-${elId}`)
          elementsMap.set(elId, el)
        }
        elementOrder.push(elementIds)
        page.set('elementsMap', elementsMap)
        page.set('elementOrder', elementOrder)
        pages.set(pageId, page)
        pageOrder.push([pageId])
      }
    })
    return doc
  }

  function readSlide(doc: Y.Doc): Record<string, string[]> {
    const out: Record<string, string[]> = {}
    const pages = doc.getMap('pages')
    pages.forEach((page, pageId) => {
      if (!(page instanceof Y.Map)) return
      const order = page.get('elementOrder')
      out[pageId] = order instanceof Y.Array ? (order.toArray() as string[]) : []
    })
    return out
  }

  it('删除整页 + 页内删元素 + 改元素，客户端收敛到目标', () => {
    const live = buildSlideDoc({ p1: ['e1', 'e2'], p2: ['e3'] })
    const client = freshDoc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(live))

    // 还原目标：删 p2，p1 删 e2、保留 e1
    const target = buildSlideDoc({ p1: ['e1'] })
    const delta = computeResyncDelta(live, Y.encodeStateAsUpdate(target))
    Y.applyUpdate(client, delta)

    const result = readSlide(client)
    expect(Object.keys(result).sort()).toEqual(['p1'])
    expect(result.p1).toEqual(['e1'])
    const p1 = (client.getMap('pages').get('p1') as Y.Map<unknown>)
    const elementsMap = p1.get('elementsMap') as Y.Map<unknown>
    expect([...elementsMap.keys()].sort()).toEqual(['e1'])

    live.destroy(); client.destroy(); target.destroy()
  })
})

describe(' computeResyncDelta — docs (XmlFragment) 文本替换', () => {
  it('段落内容整体替换为还原目标', () => {
    const live = freshDoc()
    const liveFrag = live.getXmlFragment('default')
    live.transact(() => {
      const p1 = new Y.XmlElement('paragraph')
      p1.insert(0, [new Y.XmlText('current line 1')])
      const p2 = new Y.XmlElement('paragraph')
      p2.insert(0, [new Y.XmlText('current line 2')])
      liveFrag.insert(0, [p1, p2])
    })
    const client = freshDoc()
    Y.applyUpdate(client, Y.encodeStateAsUpdate(live))

    // 还原目标：单段落不同文本
    const target = freshDoc()
    target.transact(() => {
      const p = new Y.XmlElement('paragraph')
      p.insert(0, [new Y.XmlText('restored content')])
      target.getXmlFragment('default').insert(0, [p])
    })

    const delta = computeResyncDelta(live, Y.encodeStateAsUpdate(target))
    Y.applyUpdate(client, delta)

    const frag = client.getXmlFragment('default')
    expect(frag.length).toBe(1)
    expect(frag.get(0).toString()).toContain('restored content')
    expect(JSON.stringify(frag.toJSON())).not.toContain('current line')

    live.destroy(); client.destroy(); target.destroy()
  })
})

describe(' docs resync — 同源历史快照（VH binary 因果子集）', () => {
  it('computeResyncDelta 拒绝同源快照；replaceXmlFragment 正确还原', () => {
    const live = freshDoc()
    live.transact(() => {
      const p1 = new Y.XmlElement('paragraph')
      p1.insert(0, [new Y.XmlText('version 1 line')])
      live.getXmlFragment('default').insert(0, [p1])
    })
    const historicalSnapshot = Y.encodeStateAsUpdate(live)

    live.transact(() => {
      const p2 = new Y.XmlElement('paragraph')
      p2.insert(0, [new Y.XmlText('version 3 extra line')])
      live.getXmlFragment('default').insert(1, [p2])
    })

    expect(() => computeResyncDelta(live, historicalSnapshot))
      .toThrow('unsafe resync target clientIDs')

    const liveFixed = freshDoc()
    Y.applyUpdate(liveFixed, Y.encodeStateAsUpdate(live))
    liveFixed.transact(() => {
      replaceXmlFragment(
        liveFixed,
        'default',
        Buffer.from(historicalSnapshot).toString('base64'),
      )
    })

    const frag = liveFixed.getXmlFragment('default')
    expect(frag.length).toBe(1)
    expect(frag.get(0).toString()).toContain('version 1 line')
    expect(JSON.stringify(frag.toJSON())).not.toContain('version 3 extra')

    live.destroy()
    liveFixed.destroy()
  })
})
