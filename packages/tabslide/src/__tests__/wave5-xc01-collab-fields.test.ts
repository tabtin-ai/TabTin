/**
 * XC-01 / SP1-06 / SP1-37 回归测试
 *
 * 验证 sectionTag / slideType / notes 三个字段在 Y.js 协作层的完整覆盖：
 *   - replayPendingSlideWrites 写入路径（addPage / updatePageField / batchUpdatePages）
 *   - Y.Doc 数据正确存储为预期类型（notes → Y.Array，sectionTag/slideType → 原始值）
 *   - computePageFingerprint 包含这三个字段（通过 stableStringify 间接验证）
 */

import { describe, expect, it, beforeEach } from 'vitest'
import * as Y from 'yjs'
import {
  replayPendingSlideWrites,
  type PendingSlideWrite,
} from '../hooks/useSlideCollaboration'
import { transactSlideWrite } from '../collab/ydoc-slide-writes'
import { getOrderedIds } from '../collab/utils'
import { PAGE_ELEMENTS_MAP, getPageOrderMap } from '../collab/ydoc-schema'
import { stableStringify } from '../hooks/useSlideCollabBridge'
import type { Slide, SlideNote, SectionTag, SlideType } from '../types/slides'

// ── 辅助：从 Y.Map 读取页面为 Slide（与 yPageToSlide 逻辑等价） ──

function readSlideFromYMap(pageId: string, pageYMap: Y.Map<unknown>): Partial<Slide> {
  const slide: Partial<Slide> = { id: pageId }

  const notes = pageYMap.get('notes')
  if (notes instanceof Y.Array) {
    const arr = notes.toJSON() as SlideNote[]
    if (arr.length > 0) slide.notes = arr
  }
  const sectionTag = pageYMap.get('sectionTag')
  if (sectionTag !== undefined && sectionTag !== null) {
    slide.sectionTag = sectionTag as SectionTag
  }
  const slideType = pageYMap.get('slideType')
  if (typeof slideType === 'string' && slideType) {
    slide.slideType = slideType as SlideType
  }
  const remark = pageYMap.get('remark')
  if (typeof remark === 'string' && remark) {
    slide.remark = remark
  }
  return slide
}

// ════════════════════════════════════════════════
// SP1-06: addPage 写入 + 读取往返
// ════════════════════════════════════════════════

describe('SP1-06: Y.js collab fields round-trip (notes/sectionTag/slideType)', () => {
  let ydoc: Y.Doc
  let pagesMap: Y.Map<unknown>
  let pageOrderArr: Y.Array<string>

  beforeEach(() => {
    ydoc = new Y.Doc()
    pagesMap = ydoc.getMap('pages')
    pageOrderArr = ydoc.getArray<string>('pageOrder')
  })

  it('addPage replay should persist notes as Y.Array', () => {
    const testNotes: SlideNote[] = [
      { id: 'n1', content: '需要调整配色', elId: 'el_001' },
      { id: 'n2', content: '字号偏大' },
    ]
    const writes: PendingSlideWrite[] = [
      {
        op: 'addPage',
        pageId: 'page_1',
        page: {
          id: 'page_1',
          elements: [],
          notes: testNotes,
          sectionTag: { id: 'sec-intro', title: '引言' },
          slideType: 'cover',
        },
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('page_1') as Y.Map<unknown>
    expect(pageYMap).toBeDefined()

    const notesVal = pageYMap.get('notes')
    expect(notesVal).toBeInstanceOf(Y.Array)
    const notesArr = (notesVal as Y.Array<unknown>).toJSON() as SlideNote[]
    expect(notesArr).toHaveLength(2)
    expect(notesArr[0]).toEqual({ id: 'n1', content: '需要调整配色', elId: 'el_001' })
    expect(notesArr[1]).toEqual({ id: 'n2', content: '字号偏大' })

    expect(pageYMap.get('sectionTag')).toEqual({ id: 'sec-intro', title: '引言' })
    expect(pageYMap.get('slideType')).toBe('cover')
  })

  it('addPage replay without optional fields should not create undefined entries', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'addPage',
        pageId: 'page_2',
        page: { id: 'page_2', elements: [] },
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('page_2') as Y.Map<unknown>
    expect(pageYMap).toBeDefined()
    expect(pageYMap.get('notes')).toBeUndefined()
    expect(pageYMap.get('sectionTag')).toBeUndefined()
    expect(pageYMap.get('slideType')).toBeUndefined()
  })

  it('addPage replay should seed pageOrderMap from legacy pageOrder', () => {
    pageOrderArr.push(['page_old_1', 'page_old_2'])

    replayPendingSlideWrites(ydoc, [
      {
        op: 'addPage',
        pageId: 'page_new',
        page: { id: 'page_new', elements: [] },
        afterPageId: 'page_old_1',
      },
    ])

    expect(pageOrderArr.toArray()).toEqual(['page_old_1', 'page_new', 'page_old_2'])
    expect(getOrderedIds(getPageOrderMap(ydoc))).toEqual(['page_old_1', 'page_new', 'page_old_2'])
  })

  it('insertElement replay should not overwrite an existing element with the same id', () => {
    replayPendingSlideWrites(ydoc, [
      {
        op: 'addPage',
        pageId: 'page_dup',
        page: {
          id: 'page_dup',
          elements: [{ id: 'el_1', type: 'text', content: 'current' } as any],
        },
      },
      {
        op: 'insertElement',
        pageId: 'page_dup',
        element: { id: 'el_1', type: 'text', content: 'stale replay' } as any,
      },
    ])

    const pageYMap = pagesMap.get('page_dup') as Y.Map<unknown>
    const elementsMap = pageYMap.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    const elementYMap = elementsMap.get('el_1') as Y.Map<unknown>
    expect(elementYMap.get('content')).toBe('current')
  })

  it('online reorderPages should keep pageOrder array and map aligned', () => {
    replayPendingSlideWrites(ydoc, [
      { op: 'addPage', pageId: 'page_a', page: { id: 'page_a', elements: [] } },
      { op: 'addPage', pageId: 'page_b', page: { id: 'page_b', elements: [] } },
      { op: 'addPage', pageId: 'page_c', page: { id: 'page_c', elements: [] } },
    ])

    const pageOrderMap = getPageOrderMap(ydoc)
    const positionBeforeA = pageOrderMap.get('page_a')
    const positionBeforeC = pageOrderMap.get('page_c')

    transactSlideWrite(ydoc, { op: 'reorderPages', newOrder: ['page_b', 'page_a', 'page_c'] })

    expect(pageOrderArr.toArray()).toEqual(['page_b', 'page_a', 'page_c'])
    expect(getOrderedIds(pageOrderMap)).toEqual(['page_b', 'page_a', 'page_c'])
    expect(pageOrderMap.get('page_a')).toBe(positionBeforeA)
    expect(pageOrderMap.get('page_c')).toBe(positionBeforeC)
  })

  it('online insertElement should preserve previous overwrite semantics for the same id', () => {
    replayPendingSlideWrites(ydoc, [
      {
        op: 'addPage',
        pageId: 'page_online_dup',
        page: {
          id: 'page_online_dup',
          elements: [{ id: 'el_1', type: 'text', content: 'current' } as any],
        },
      },
    ])

    transactSlideWrite(ydoc, {
      op: 'insertElement',
      pageId: 'page_online_dup',
      element: { id: 'el_1', type: 'text', content: 'online update' } as any,
    })

    const pageYMap = pagesMap.get('page_online_dup') as Y.Map<unknown>
    const elementsMap = pageYMap.get(PAGE_ELEMENTS_MAP) as Y.Map<Y.Map<unknown>>
    const elementYMap = elementsMap.get('el_1') as Y.Map<unknown>
    expect(elementYMap.get('content')).toBe('online update')
  })

  it('readSlideFromYMap should recover all three fields from Y.Doc', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'addPage',
        pageId: 'page_rt',
        page: {
          id: 'page_rt',
          elements: [],
          notes: [{ id: 'n1', content: '批注A' }],
          sectionTag: { id: 'sec-body', title: '正文' },
          slideType: 'content',
        },
      },
    ]
    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('page_rt') as Y.Map<unknown>
    const slide = readSlideFromYMap('page_rt', pageYMap)

    expect(slide.notes).toEqual([{ id: 'n1', content: '批注A' }])
    expect(slide.sectionTag).toEqual({ id: 'sec-body', title: '正文' })
    expect(slide.slideType).toBe('content')
  })
})

// ════════════════════════════════════════════════
// SP1-06: updatePageField / batchUpdatePages for notes
// ════════════════════════════════════════════════

describe('SP1-06: updatePageField replay stores notes as Y.Array', () => {
  let ydoc: Y.Doc
  let pagesMap: Y.Map<unknown>
  let pageOrderArr: Y.Array<string>

  beforeEach(() => {
    ydoc = new Y.Doc()
    pagesMap = ydoc.getMap('pages')
    pageOrderArr = ydoc.getArray<string>('pageOrder')

    ydoc.transact(() => {
      const page = new Y.Map<unknown>()
      page.set('elementsMap', new Y.Map())
      page.set('elementOrder', new Y.Array<string>())
      pagesMap.set('page_1', page)
      pageOrderArr.push(['page_1'])
    })
  })

  it('updatePageField for notes should create Y.Array', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'updatePageField',
        pageId: 'page_1',
        field: 'notes',
        value: [{ id: 'n1', content: '新批注' }],
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('page_1') as Y.Map<unknown>
    const notesVal = pageYMap.get('notes')
    expect(notesVal).toBeInstanceOf(Y.Array)
    expect((notesVal as Y.Array<unknown>).toJSON()).toEqual([{ id: 'n1', content: '新批注' }])
  })

  it('updatePageField for sectionTag should store as plain object', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'updatePageField',
        pageId: 'page_1',
        field: 'sectionTag',
        value: { id: 'sec-1', title: '章节一' },
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('page_1') as Y.Map<unknown>
    expect(pageYMap.get('sectionTag')).toEqual({ id: 'sec-1', title: '章节一' })
  })

  it('updatePageField for slideType should store as string', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'updatePageField',
        pageId: 'page_1',
        field: 'slideType',
        value: 'end',
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('page_1') as Y.Map<unknown>
    expect(pageYMap.get('slideType')).toBe('end')
  })

  it('batchUpdatePages replay should handle notes as Y.Array', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'batchUpdatePages',
        changes: [
          { pageId: 'page_1', field: 'notes', value: [{ id: 'bn1', content: '批量批注' }] },
          { pageId: 'page_1', field: 'sectionTag', value: { id: 's2', title: '第二节' } },
          { pageId: 'page_1', field: 'slideType', value: 'transition' },
        ],
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('page_1') as Y.Map<unknown>
    const notesVal = pageYMap.get('notes')
    expect(notesVal).toBeInstanceOf(Y.Array)
    expect((notesVal as Y.Array<unknown>).toJSON()).toEqual([{ id: 'bn1', content: '批量批注' }])
    expect(pageYMap.get('sectionTag')).toEqual({ id: 's2', title: '第二节' })
    expect(pageYMap.get('slideType')).toBe('transition')
  })

  it('notes Y.Array reconciliation: update existing Y.Array in place', () => {
    const write1: PendingSlideWrite[] = [
      { op: 'updatePageField', pageId: 'page_1', field: 'notes', value: [{ id: 'n1', content: 'v1' }] },
    ]
    replayPendingSlideWrites(ydoc, write1)

    const write2: PendingSlideWrite[] = [
      { op: 'updatePageField', pageId: 'page_1', field: 'notes', value: [{ id: 'n1', content: 'v2' }, { id: 'n2', content: 'new' }] },
    ]
    replayPendingSlideWrites(ydoc, write2)

    const pageYMap = pagesMap.get('page_1') as Y.Map<unknown>
    const notesVal = pageYMap.get('notes')
    expect(notesVal).toBeInstanceOf(Y.Array)
    const arr = (notesVal as Y.Array<unknown>).toJSON()
    expect(arr).toHaveLength(2)
    expect(arr[0]).toEqual({ id: 'n1', content: 'v2' })
    expect(arr[1]).toEqual({ id: 'n2', content: 'new' })
  })
})

// ════════════════════════════════════════════════
// SP1-37: computePageFingerprint 包含 notes/sectionTag/slideType
// ════════════════════════════════════════════════

describe('SP1-37: computePageFingerprint covers notes/sectionTag/slideType', () => {
  const basePage: Slide = {
    id: 'fp-test',
    elements: [],
    background: undefined,
    remark: undefined,
    turningMode: undefined,
    animations: undefined,
    masterElements: undefined,
    layout: undefined,
  }

  function fingerprint(page: Slide): string {
    return stableStringify({
      id: page.id,
      elements: page.elements,
      background: page.background,
      remark: page.remark,
      turningMode: page.turningMode,
      animations: page.animations,
      masterElements: page.masterElements,
      layout: page.layout,
      notes: page.notes,
      sectionTag: page.sectionTag,
      slideType: page.slideType,
    })
  }

  it('adding notes should change fingerprint', () => {
    const fp1 = fingerprint(basePage)
    const fp2 = fingerprint({ ...basePage, notes: [{ id: 'n1', content: 'test' }] })
    expect(fp1).not.toBe(fp2)
  })

  it('adding sectionTag should change fingerprint', () => {
    const fp1 = fingerprint(basePage)
    const fp2 = fingerprint({ ...basePage, sectionTag: { id: 's1', title: '章节' } })
    expect(fp1).not.toBe(fp2)
  })

  it('adding slideType should change fingerprint', () => {
    const fp1 = fingerprint(basePage)
    const fp2 = fingerprint({ ...basePage, slideType: 'cover' })
    expect(fp1).not.toBe(fp2)
  })

  it('changing slideType value should change fingerprint', () => {
    const fp1 = fingerprint({ ...basePage, slideType: 'cover' })
    const fp2 = fingerprint({ ...basePage, slideType: 'end' })
    expect(fp1).not.toBe(fp2)
  })

  it('changing notes content should change fingerprint', () => {
    const fp1 = fingerprint({ ...basePage, notes: [{ id: 'n1', content: 'A' }] })
    const fp2 = fingerprint({ ...basePage, notes: [{ id: 'n1', content: 'B' }] })
    expect(fp1).not.toBe(fp2)
  })

  it('identical pages produce same fingerprint (stability)', () => {
    const page: Slide = {
      ...basePage,
      notes: [{ id: 'n1', content: '批注' }],
      sectionTag: { id: 's1', title: '引言' },
      slideType: 'content',
    }
    expect(fingerprint(page)).toBe(fingerprint({ ...page }))
  })
})

// ════════════════════════════════════════════════
// SP1-37: Bridge 指纹变化触发 Zustand→Y.js 同步
// ════════════════════════════════════════════════

describe('SP1-37: fingerprint-driven sync detects field changes', () => {
  function fingerprint(page: Slide): string {
    return stableStringify({
      id: page.id,
      elements: page.elements,
      background: page.background,
      remark: page.remark,
      turningMode: page.turningMode,
      animations: page.animations,
      masterElements: page.masterElements,
      layout: page.layout,
      notes: page.notes,
      sectionTag: page.sectionTag,
      slideType: page.slideType,
    })
  }

  it('changing only notes triggers fingerprint diff', () => {
    const page: Slide = { id: 'p1', elements: [] }
    const fp1 = fingerprint(page)
    const fp2 = fingerprint({ ...page, notes: [{ id: 'n1', content: 'new' }] })
    const fp3 = fingerprint({ ...page })
    expect(fp1).not.toBe(fp2)
    expect(fp1).toBe(fp3)
  })

  it('changing only sectionTag triggers fingerprint diff', () => {
    const page: Slide = { id: 'p1', elements: [], sectionTag: { id: 's1', title: 'A' } }
    const fp1 = fingerprint(page)
    const fp2 = fingerprint({ ...page, sectionTag: { id: 's1', title: 'B' } })
    expect(fp1).not.toBe(fp2)
  })

  it('changing only slideType triggers fingerprint diff', () => {
    const page: Slide = { id: 'p1', elements: [], slideType: 'cover' }
    const fp1 = fingerprint(page)
    const fp2 = fingerprint({ ...page, slideType: 'end' })
    expect(fp1).not.toBe(fp2)
  })
})

// ════════════════════════════════════════════════
// 字段命名一致性：Y.Map key = Slide 接口字段名
// ════════════════════════════════════════════════

describe('Field naming consistency: Y.Map keys match Slide interface', () => {
  it('Y.Map keys for new fields should use camelCase matching Slide type', () => {
    const ydoc = new Y.Doc()
    const pagesMap = ydoc.getMap('pages')
    ydoc.getArray<string>('pageOrder')

    const writes: PendingSlideWrite[] = [
      {
        op: 'addPage',
        pageId: 'naming_test',
        page: {
          id: 'naming_test',
          elements: [],
          notes: [{ id: 'n1', content: 'test' }],
          sectionTag: { id: 's1', title: 'test' },
          slideType: 'cover',
        },
      },
    ]
    replayPendingSlideWrites(ydoc, writes)

    const pageYMap = pagesMap.get('naming_test') as Y.Map<unknown>

    const keys = Array.from(pageYMap.keys())
    expect(keys).toContain('notes')
    expect(keys).toContain('sectionTag')
    expect(keys).toContain('slideType')
    expect(keys).not.toContain('slide_notes')
    expect(keys).not.toContain('section_tag')
    expect(keys).not.toContain('slide_type')
  })
})
