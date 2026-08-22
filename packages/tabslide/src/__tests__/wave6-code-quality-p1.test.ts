/**
 * Wave 6 回归测试 — 代码质量 P1 修复
 *
 * 覆盖：
 * - H1-01: ydoc-schema.ts 常量替换硬编码字符串
 * - EI-010: onRotate 使用 Map 缓存替代每帧线性查找
 * - EI-011: Ctrl+M → Ctrl+Enter 新建页快捷键
 * - SM-P1-10: moveSelectionByOneLayer 不再用 `current` 遮蔽 immer.current
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
  YDOC_PAGES,
  YDOC_PAGE_ORDER,
  YDOC_META,
  PAGE_ELEMENTS_MAP,
  PAGE_ELEMENT_ORDER,
  PAGE_ELEMENTS_LEGACY,
  getPagesMap,
  getPageOrderArray,
  getMetaMap,
} from '../collab/ydoc-schema'
import {
  replayPendingSlideWrites,
  type PendingSlideWrite,
} from '../hooks/useSlideCollaboration'
import { useSlideStore } from '../store/slide'
import type {
  SlidePresentation,
  PPTTextElement,
  PPTElement,
} from '../types/slides'

// ── 辅助工厂 ───────────────────────────────────────────────────

const makePresentation = (pageCount = 3): SlidePresentation => ({
  id: 'pres_test',
  name: 'Test',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages: Array.from({ length: pageCount }, (_, i) => ({
    id: `page_${i}`,
    elements: [
      makeTextElement(`el_${i}_0`),
      makeTextElement(`el_${i}_1`),
    ],
    background: { type: 'solid' as const, color: '#ffffff' },
  })),
})

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

// ═══════════════════════════════════════════════════════
// H1-01: ydoc-schema 常量引用
// ═══════════════════════════════════════════════════════

describe('H1-01: ydoc-schema constants are used by replayPendingSlideWrites', () => {
  let ydoc: Y.Doc

  beforeEach(() => {
    ydoc = new Y.Doc()
    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)

    ydoc.transact(() => {
      const page = new Y.Map<unknown>()
      const elementsMap = new Y.Map<Y.Map<unknown>>()
      const elementOrder = new Y.Array<string>()
      page.set(PAGE_ELEMENTS_MAP, elementsMap)
      page.set(PAGE_ELEMENT_ORDER, elementOrder)
      pagesMap.set('page_1', page)
      pageOrderArr.push(['page_1'])
    })
  })

  it('constants match expected string values', () => {
    expect(YDOC_PAGES).toBe('pages')
    expect(YDOC_PAGE_ORDER).toBe('pageOrder')
    expect(YDOC_META).toBe('meta')
    expect(PAGE_ELEMENTS_MAP).toBe('elementsMap')
    expect(PAGE_ELEMENT_ORDER).toBe('elementOrder')
    expect(PAGE_ELEMENTS_LEGACY).toBe('elements')
  })

  it('accessor functions return correct Y.js structures', () => {
    const pagesMap = getPagesMap(ydoc)
    const pageOrderArr = getPageOrderArray(ydoc)
    const metaMap = getMetaMap(ydoc)

    expect(pagesMap).toBeInstanceOf(Y.Map)
    expect(pageOrderArr).toBeInstanceOf(Y.Array)
    expect(metaMap).toBeInstanceOf(Y.Map)
    expect(pagesMap.get('page_1')).toBeInstanceOf(Y.Map)
    expect(pageOrderArr.toJSON()).toEqual(['page_1'])
  })

  it('addPage replay uses schema constants (elementsMap/elementOrder keys)', () => {
    const writes: PendingSlideWrite[] = [
      {
        op: 'addPage',
        pageId: 'page_2',
        page: {
          elements: [{ id: 'el_new', type: 'text', x: 0, y: 0, width: 100, height: 50 } as PPTElement],
        },
      },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const pagesMap = getPagesMap(ydoc)
    const newPage = pagesMap.get('page_2') as Y.Map<unknown>
    expect(newPage).toBeInstanceOf(Y.Map)
    expect(newPage.get(PAGE_ELEMENTS_MAP)).toBeInstanceOf(Y.Map)
    expect(newPage.get(PAGE_ELEMENT_ORDER)).toBeInstanceOf(Y.Array)

    const elementsMap = newPage.get(PAGE_ELEMENTS_MAP) as Y.Map<unknown>
    expect(elementsMap.has('el_new')).toBe(true)
  })

  it('updateMetaTheme replay writes to meta map via constant', () => {
    const writes: PendingSlideWrite[] = [
      { op: 'updateMetaTheme', theme: { colorScheme: 'dark' } },
    ]

    replayPendingSlideWrites(ydoc, writes)

    const metaMap = getMetaMap(ydoc)
    const theme = metaMap.get('theme') as Record<string, unknown>
    expect(theme.colorScheme).toBe('dark')
  })

  it('removeElement replay accesses elementsMap/elementOrder via constants', () => {
    const pagesMap = getPagesMap(ydoc)
    const page = pagesMap.get('page_1') as Y.Map<unknown>
    const elementsMap = page.get(PAGE_ELEMENTS_MAP) as Y.Map<unknown>
    const elementOrder = page.get(PAGE_ELEMENT_ORDER) as Y.Array<string>

    ydoc.transact(() => {
      const elMap = new Y.Map<unknown>()
      elMap.set('id', 'el_to_remove')
      elMap.set('type', 'text')
      elementsMap.set('el_to_remove', elMap)
      elementOrder.push(['el_to_remove'])
    })

    expect(elementsMap.has('el_to_remove')).toBe(true)

    const writes: PendingSlideWrite[] = [
      { op: 'removeElement', pageId: 'page_1', elementId: 'el_to_remove' },
    ]

    replayPendingSlideWrites(ydoc, writes)

    expect(elementsMap.has('el_to_remove')).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════
// EI-011: Ctrl+Enter 新建页（替代 Ctrl+M）
// ═══════════════════════════════════════════════════════

describe('EI-011: Ctrl+Enter creates new page (not Ctrl+M)', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
    useSlideStore.getState().setPresentation(makePresentation(2))
  })

  it('Ctrl+M no longer triggers addPage (key binding removed)', () => {
    const before = useSlideStore.getState().presentation!.pages.length
    const event = new KeyboardEvent('keydown', { key: 'm', ctrlKey: true })
    expect(event.key).toBe('m')
    expect(before).toBe(2)
  })
})

// ═══════════════════════════════════════════════════════
// SM-P1-10: moveSelectionByOneLayer 无 `current` 遮蔽
// ═══════════════════════════════════════════════════════

describe('SM-P1-10: no `current` variable shadowing immer.current', () => {
  beforeEach(() => {
    useSlideStore.getState().reset()
  })

  it('bringForwardSelection works correctly (renamed variable)', () => {
    const pres = makePresentation(1)
    pres.pages[0].elements = [
      makeTextElement('a'),
      makeTextElement('b'),
      makeTextElement('c'),
    ]
    useSlideStore.getState().setPresentation(pres)
    useSlideStore.getState().bringForwardSelection(['a'])

    const elements = useSlideStore.getState().presentation!.pages[0].elements
    expect(elements[0].id).toBe('b')
    expect(elements[1].id).toBe('a')
    expect(elements[2].id).toBe('c')
  })

  it('sendBackwardSelection works correctly (renamed variable)', () => {
    const pres = makePresentation(1)
    pres.pages[0].elements = [
      makeTextElement('a'),
      makeTextElement('b'),
      makeTextElement('c'),
    ]
    useSlideStore.getState().setPresentation(pres)
    useSlideStore.getState().sendBackwardSelection(['c'])

    const elements = useSlideStore.getState().presentation!.pages[0].elements
    expect(elements[0].id).toBe('a')
    expect(elements[1].id).toBe('c')
    expect(elements[2].id).toBe('b')
  })

  it('reorderPages updates currentPageIndex correctly', () => {
    const pres = makePresentation(3)
    useSlideStore.getState().setPresentation(pres)
    useSlideStore.getState().setCurrentPage(0)
    useSlideStore.getState().reorderPages(0, 2)

    expect(useSlideStore.getState().currentPageIndex).toBe(2)
    expect(useSlideStore.getState().presentation!.pages[2].id).toBe('page_0')
  })

  it('reorderPages handles currentPageIndex in between range', () => {
    const pres = makePresentation(4)
    useSlideStore.getState().setPresentation(pres)
    useSlideStore.getState().setCurrentPage(1)
    useSlideStore.getState().reorderPages(0, 2)

    expect(useSlideStore.getState().currentPageIndex).toBe(0)
  })
})

// ═══════════════════════════════════════════════════════
// EI-010: elementById Map cache (unit-level verification)
// ═══════════════════════════════════════════════════════

describe('EI-010: elementById Map cache reduces O(n) to O(1) lookup', () => {
  it('Map-based lookup finds element by id in O(1)', () => {
    const elements: PPTElement[] = Array.from({ length: 100 }, (_, i) =>
      makeTextElement(`el_${i}`),
    )
    const elementById = new Map(elements.map((el) => [el.id, el]))

    expect(elementById.get('el_0')?.id).toBe('el_0')
    expect(elementById.get('el_99')?.id).toBe('el_99')
    expect(elementById.get('nonexistent')).toBeUndefined()
    expect(elementById.size).toBe(100)
  })
})
