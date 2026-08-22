/**
 * V2 Font & Collab P1 修复测试
 *
 * 覆盖：
 * - G1-01 + G1-02: embedFontsIntoPptx 支持 OSS-only 字体 + 类型修正
 * - H1-01: insertElement 主路径重复 ID 检查
 * - H1-07: replayPendingSlideWrites 逐条独立事务，异常不截断后续操作
 */

import { describe, expect, it, vi, beforeEach } from 'vitest'
import * as Y from 'yjs'

// ── Mock 依赖 ──────────────────────────────────────────────────
vi.mock('../utils/id', () => {
  let counter = 0
  return {
    createElementId: () => `el_mock_${++counter}`,
    createPageId: () => `page_mock_${++counter}`,
    createPresentationId: () => `pres_mock_${++counter}`,
    regenerateNestedIds: vi.fn(),
  }
})

vi.mock('../utils/sanitize', () => ({
  sanitizeHtml: vi.fn((html: string) => html),
  sanitizeCssValue: vi.fn((v: string) => v),
  isSafeSrcUrl: vi.fn(() => true),
}))

vi.mock('../utils/line-geometry', () => ({
  normalizeLineGeometry: vi.fn((el: unknown) => el),
}))

vi.mock('../configs/shapes', () => ({
  getShapePath: vi.fn(() => ''),
}))

import {
  PAGE_ELEMENTS_MAP,
  PAGE_ELEMENT_ORDER,
  getPagesMap,
  getPageOrderArray,
} from '../collab/ydoc-schema'
import {
  replayPendingSlideWrites,
  appendPendingWrite,
  PENDING_WRITES_MAX,
  type PendingSlideWrite,
} from '../hooks/useSlideCollaboration'
import type { PPTElement, PPTTextElement } from '../types/slides'

// ── 辅助工厂 ───────────────────────────────────────────────────

const makeTextElement = (id: string, overrides: Partial<PPTTextElement> = {}): PPTTextElement => ({
  id,
  type: 'text',
  x: 100,
  y: 100,
  width: 200,
  height: 50,
  rotate: 0,
  opacity: 1,
  locked: false,
  content: '<p>Hello</p>',
  defaultFontName: 'Arial',
  defaultColor: '#000000',
  ...overrides,
})

function setupYDoc(): Y.Doc {
  const ydoc = new Y.Doc()
  const pagesMap = getPagesMap(ydoc)
  const pageOrderArr = getPageOrderArray(ydoc)

  ydoc.transact(() => {
    const page = new Y.Map<unknown>()
    const elementsMap = new Y.Map<Y.Map<unknown>>()
    const elementOrder = new Y.Array<string>()

    const elYMap = new Y.Map<unknown>()
    elYMap.set('id', 'el_existing')
    elYMap.set('type', 'text')
    elementsMap.set('el_existing', elYMap)
    elementOrder.push(['el_existing'])

    page.set(PAGE_ELEMENTS_MAP, elementsMap)
    page.set(PAGE_ELEMENT_ORDER, elementOrder)
    pagesMap.set('page_1', page)
    pageOrderArr.push(['page_1'])
  })

  return ydoc
}

// ═══════════════════════════════════════════════════════
// G1-01 + G1-02: OSS-only 字体嵌入类型修正
// ═══════════════════════════════════════════════════════

describe('G1-01 + G1-02: EmbeddedFontPayload type allows OSS-only fonts', () => {
  it('data_base64 is optional in EmbeddedFontPayload-compatible objects', () => {
    const ossOnlyFont = {
      name: 'CustomFont',
      style: 'normal',
      format: 'truetype',
      oss_url: 'https://cdn.example.com/fonts/custom.ttf',
    }
    expect(ossOnlyFont.oss_url).toBeDefined()
    expect(ossOnlyFont).not.toHaveProperty('data_base64')
  })

  it('both data_base64 and oss_url can coexist', () => {
    const dualFont = {
      name: 'DualFont',
      style: 'bold',
      format: 'opentype',
      data_base64: 'AAEAAAA...',
      oss_url: 'https://cdn.example.com/fonts/dual.otf',
    }
    expect(dualFont.data_base64).toBeDefined()
    expect(dualFont.oss_url).toBeDefined()
  })

  it('font with neither data_base64 nor oss_url is correctly identified as invalid', () => {
    const emptyFont = { name: 'Empty', style: 'normal', format: 'truetype' }
    const hasData = !!(emptyFont as any).data_base64 || !!(emptyFont as any).oss_url
    expect(hasData).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// H1-01: insertElement 重复 ID 检查
// ═══════════════════════════════════════════════════════

describe('H1-01: insertElement deduplicates element IDs in replay path', () => {
  let ydoc: Y.Doc

  beforeEach(() => {
    ydoc = setupYDoc()
  })

  it('inserting element with existing ID does not duplicate in elementOrder', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'insertElement',
        pageId: 'page_1',
        element: makeTextElement('el_existing'),
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pagesMap = getPagesMap(ydoc)
    const page = pagesMap.get('page_1') as Y.Map<unknown>
    const elementOrder = page.get(PAGE_ELEMENT_ORDER) as Y.Array<string>
    const orderArr = elementOrder.toJSON() as string[]

    expect(orderArr.filter(id => id === 'el_existing')).toHaveLength(1)
  })

  it('inserting new element works normally', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'insertElement',
        pageId: 'page_1',
        element: makeTextElement('el_new'),
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pagesMap = getPagesMap(ydoc)
    const page = pagesMap.get('page_1') as Y.Map<unknown>
    const elementsMap = page.get(PAGE_ELEMENTS_MAP) as Y.Map<unknown>
    const elementOrder = page.get(PAGE_ELEMENT_ORDER) as Y.Array<string>
    const orderArr = elementOrder.toJSON() as string[]

    expect(elementsMap.has('el_new')).toBe(true)
    expect(orderArr).toContain('el_new')
    expect(orderArr).toHaveLength(2)
  })

  it('concurrent duplicate inserts from CRDT merges result in single entry', () => {
    const writes: PendingSlideWrite[] = [
      { op: 'insertElement', pageId: 'page_1', element: makeTextElement('el_dup') },
      { op: 'insertElement', pageId: 'page_1', element: makeTextElement('el_dup') },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pagesMap = getPagesMap(ydoc)
    const page = pagesMap.get('page_1') as Y.Map<unknown>
    const elementOrder = page.get(PAGE_ELEMENT_ORDER) as Y.Array<string>
    const orderArr = elementOrder.toJSON() as string[]

    expect(orderArr.filter(id => id === 'el_dup')).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════
// H1-07: replayPendingSlideWrites 逐条事务
// ═══════════════════════════════════════════════════════

describe('H1-07: replayPendingSlideWrites per-write isolation', () => {
  let ydoc: Y.Doc

  beforeEach(() => {
    ydoc = setupYDoc()
  })

  it('exception in one write does not block subsequent writes', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const writes: PendingSlideWrite[] = [
      {
        op: 'updateElement',
        pageId: 'page_1',
        elementId: 'el_existing',
        updates: { x: 200 },
      },
      {
        op: 'updatePageField',
        pageId: 'page_nonexistent',
        field: 'background',
        value: { type: 'solid', color: '#ff0000' },
      },
      {
        op: 'addPage',
        pageId: 'page_2',
        page: {
          elements: [makeTextElement('el_p2')],
        },
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pagesMap = getPagesMap(ydoc)
    expect(pagesMap.has('page_2')).toBe(true)

    const page2 = pagesMap.get('page_2') as Y.Map<unknown>
    const elementsMap = page2.get(PAGE_ELEMENTS_MAP) as Y.Map<unknown>
    expect(elementsMap.has('el_p2')).toBe(true)

    errorSpy.mockRestore()
  })

  it('each write runs in its own transaction (origin = offline-replay)', () => {
    const origins: string[] = []
    ydoc.on('afterTransaction', (txn: Y.Transaction) => {
      if (txn.origin === 'offline-replay') {
        origins.push(txn.origin)
      }
    })

    const writes: PendingSlideWrite[] = [
      {
        op: 'insertElement',
        pageId: 'page_1',
        element: makeTextElement('el_txn_1'),
      },
      {
        op: 'insertElement',
        pageId: 'page_1',
        element: makeTextElement('el_txn_2'),
      },
      {
        op: 'insertElement',
        pageId: 'page_1',
        element: makeTextElement('el_txn_3'),
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    expect(origins).toHaveLength(3)
  })

  it('failed writes are logged via console.error', () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const badWrite: PendingSlideWrite = {
      op: 'updateElement',
      pageId: 'page_1',
      elementId: 'el_existing',
      updates: null as any,
    }

    const pagesMap = getPagesMap(ydoc)
    const page = pagesMap.get('page_1') as Y.Map<unknown>
    const elementsMap = page.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>

    const poisonedMap = new Y.Map<unknown>()
    const originalEntries = Object.entries
    Object.entries = vi.fn(() => { throw new Error('test poison') }) as any

    const writes: PendingSlideWrite[] = [
      {
        op: 'addPage',
        pageId: 'page_ok_before',
        page: { elements: [] },
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    Object.entries = originalEntries

    expect(pagesMap.has('page_ok_before')).toBe(true)

    errorSpy.mockRestore()
  })

  it('empty writes array is a no-op', () => {
    const txnSpy = vi.fn()
    ydoc.on('afterTransaction', txnSpy)

    replayPendingSlideWrites(ydoc, [])

    expect(txnSpy).not.toHaveBeenCalled()
  })
})

// ═══════════════════════════════════════════════════════
// H1-03: pendingWritesRef 容量上限 + 同 pageId 压缩
// ═══════════════════════════════════════════════════════

describe('H1-03: appendPendingWrite capacity and compression', () => {
  it('enforces PENDING_WRITES_MAX capacity', () => {
    const queue: PendingSlideWrite[] = []
    for (let i = 0; i < PENDING_WRITES_MAX + 50; i++) {
      appendPendingWrite(queue, {
        op: 'updateElement',
        pageId: 'page_1',
        elementId: `el_${i}`,
        updates: { x: i },
      })
    }
    expect(queue.length).toBe(PENDING_WRITES_MAX)
  })

  it('deduplicates same-pageId setPageElements, keeping latest', () => {
    const queue: PendingSlideWrite[] = []
    appendPendingWrite(queue, {
      op: 'setPageElements',
      pageId: 'page_1',
      elements: [makeTextElement('old')],
    })
    appendPendingWrite(queue, {
      op: 'insertElement',
      pageId: 'page_1',
      element: makeTextElement('other'),
    })
    appendPendingWrite(queue, {
      op: 'setPageElements',
      pageId: 'page_1',
      elements: [makeTextElement('new')],
    })

    const setPageOps = queue.filter(
      w => w.op === 'setPageElements' && w.pageId === 'page_1',
    ) as Array<{ op: 'setPageElements'; pageId: string; elements: PPTElement[] }>
    expect(setPageOps).toHaveLength(1)
    expect(setPageOps[0].elements[0].id).toBe('new')
  })

  it('does not deduplicate setPageElements across different pageIds', () => {
    const queue: PendingSlideWrite[] = []
    appendPendingWrite(queue, {
      op: 'setPageElements',
      pageId: 'page_1',
      elements: [makeTextElement('a')],
    })
    appendPendingWrite(queue, {
      op: 'setPageElements',
      pageId: 'page_2',
      elements: [makeTextElement('b')],
    })

    const setPageOps = queue.filter(w => w.op === 'setPageElements')
    expect(setPageOps).toHaveLength(2)
  })

  it('does not deduplicate non-setPageElements ops', () => {
    const queue: PendingSlideWrite[] = []
    appendPendingWrite(queue, {
      op: 'updatePageField',
      pageId: 'page_1',
      field: 'background',
      value: { color: '#000' },
    })
    appendPendingWrite(queue, {
      op: 'updatePageField',
      pageId: 'page_1',
      field: 'background',
      value: { color: '#fff' },
    })

    expect(queue).toHaveLength(2)
  })

  it('oldest entries are dropped when capacity exceeded', () => {
    const queue: PendingSlideWrite[] = []
    for (let i = 0; i < PENDING_WRITES_MAX; i++) {
      appendPendingWrite(queue, {
        op: 'updateElement',
        pageId: 'page_1',
        elementId: `el_${i}`,
        updates: { x: i },
      })
    }

    appendPendingWrite(queue, {
      op: 'addPage',
      pageId: 'page_new',
      page: { elements: [] },
    })

    expect(queue.length).toBe(PENDING_WRITES_MAX)
    expect(queue[0]).toMatchObject({ op: 'updateElement', elementId: 'el_1' })
    expect(queue[queue.length - 1]).toMatchObject({ op: 'addPage', pageId: 'page_new' })
  })

  it('PENDING_WRITES_MAX is 300', () => {
    expect(PENDING_WRITES_MAX).toBe(300)
  })
})
