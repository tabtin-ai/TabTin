/**
 * Wave 4 回归测试 — 状态管理模块 P1 修复
 *
 * 覆盖：
 * - SM-P1-04: reorderAnimations off-by-one
 * - SM-P1-01: pastePageAfter structuredClone on Immer proxy
 * - SM-P1-02: pastePageAfter insertAt 下界缺失
 * - SM-P1-03: pastePageAfter notes ID 重映射
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

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

import { useSlideStore } from '../store/slide'
import type {
  SlidePresentation,
  PPTTextElement,
  PPTAnimation,
  Slide,
} from '../types/slides'

// ── 辅助工厂 ───────────────────────────────────────────────────

const makePresentation = (pageCount = 1): SlidePresentation => ({
  id: 'pres_test',
  name: 'Test Presentation',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages: Array.from({ length: pageCount }, (_, i) => ({
    id: `page_${i}`,
    elements: [],
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

const makeAnimation = (id: string, elId: string): PPTAnimation => ({
  id,
  elId,
  type: 'in',
  effect: 'fadeIn',
  duration: 500,
  trigger: 'click',
})

const resetStore = () => {
  useSlideStore.getState().reset()
}

// ═══════════════════════════════════════════════════════════════
// SM-P1-04: reorderAnimations off-by-one
// ═══════════════════════════════════════════════════════════════

describe('SM-P1-04: reorderAnimations', () => {
  beforeEach(() => {
    resetStore()
    useSlideStore.getState().setPresentation(makePresentation())

    const page = useSlideStore.getState().presentation!.pages[0]!
    page.elements = [
      makeTextElement('elA'),
      makeTextElement('elB'),
      makeTextElement('elC'),
      makeTextElement('elD'),
      makeTextElement('elE'),
    ]
    page.animations = [
      makeAnimation('animA', 'elA'),
      makeAnimation('animB', 'elB'),
      makeAnimation('animC', 'elC'),
      makeAnimation('animD', 'elD'),
      makeAnimation('animE', 'elE'),
    ]
  })

  it('from < to: 将 idx=1 移到 idx=4 前面（非末尾后一位）', () => {
    // [A,B,C,D,E] → B 移到 E 的位置 → [A,C,D,B,E]
    useSlideStore.getState().reorderAnimations(1, 4)
    const anims = useSlideStore.getState().presentation!.pages[0]!.animations!
    expect(anims.map((a) => a.id)).toEqual(['animA', 'animC', 'animD', 'animB', 'animE'])
  })

  it('from > to: 将 idx=3 移到 idx=1', () => {
    // [A,B,C,D,E] → D 移到 B 的位置 → [A,D,B,C,E]
    useSlideStore.getState().reorderAnimations(3, 1)
    const anims = useSlideStore.getState().presentation!.pages[0]!.animations!
    expect(anims.map((a) => a.id)).toEqual(['animA', 'animD', 'animB', 'animC', 'animE'])
  })

  it('from === to: 不变更、不标脏', () => {
    useSlideStore.getState().markClean()
    useSlideStore.getState().reorderAnimations(2, 2)
    expect(useSlideStore.getState().isDirty).toBe(false)
  })

  it('越界参数提前退出', () => {
    useSlideStore.getState().markClean()
    useSlideStore.getState().reorderAnimations(-1, 2)
    expect(useSlideStore.getState().isDirty).toBe(false)
    useSlideStore.getState().reorderAnimations(0, 99)
    expect(useSlideStore.getState().isDirty).toBe(false)
  })
})

// ═══════════════════════════════════════════════════════════════
// SM-P1-01/02/03: pastePageAfter
// ═══════════════════════════════════════════════════════════════

describe('SM-P1-01/02/03: pastePageAfter', () => {
  beforeEach(() => {
    resetStore()
    const pres = makePresentation(3)
    pres.pages[1]!.elements = [makeTextElement('src_el1'), makeTextElement('src_el2')]
    pres.pages[1]!.animations = [
      makeAnimation('src_anim1', 'src_el1'),
      makeAnimation('src_anim2', 'src_el2'),
    ]
    ;(pres.pages[1] as Slide & { notes: unknown[] }).notes = [
      { id: 'note_1', content: '批注A', elId: 'src_el1' },
      { id: 'note_2', content: '批注B', elId: 'src_el2' },
      { id: 'note_3', content: '通用批注' },
    ]
    useSlideStore.getState().setPresentation(pres)
  })

  it('SM-P1-01: pastePageAfter 不抛 DataCloneError（Immer proxy 安全）', () => {
    useSlideStore.getState().copyPage(1)
    expect(() => {
      useSlideStore.getState().pastePageAfter(2)
    }).not.toThrow()
    expect(useSlideStore.getState().pageCount()).toBe(4)
  })

  it('SM-P1-02: afterIndex=-2 时 insertAt clamp 到 0', () => {
    useSlideStore.getState().copyPage(1)
    useSlideStore.getState().pastePageAfter(-2)
    expect(useSlideStore.getState().currentPageIndex).toBe(0)
    const pages = useSlideStore.getState().presentation!.pages
    expect(pages).toHaveLength(4)
    expect(pages[0]!.id).not.toBe('page_0')
  })

  it('SM-P1-03: 粘贴后 notes ID 被重新生成、elId 被重映射', () => {
    useSlideStore.getState().copyPage(1)
    useSlideStore.getState().pastePageAfter(2)

    const pasted = useSlideStore.getState().presentation!.pages[3]!
    const notes = (pasted as Slide & { notes?: Array<{ id: string; elId?: string; content: string }> }).notes
    expect(notes).toBeDefined()
    expect(notes).toHaveLength(3)

    const srcNoteIds = ['note_1', 'note_2', 'note_3']
    const srcElIds = ['src_el1', 'src_el2']
    for (const n of notes!) {
      expect(srcNoteIds).not.toContain(n.id)
    }
    const notesWithElId = notes!.filter((n) => n.elId !== undefined)
    expect(notesWithElId).toHaveLength(2)
    for (const n of notesWithElId) {
      expect(srcElIds).not.toContain(n.elId)
      expect(pasted.elements.some((el) => el.id === n.elId)).toBe(true)
    }
  })

  it('多次粘贴不产生重复 notes ID', () => {
    useSlideStore.getState().copyPage(1)
    useSlideStore.getState().pastePageAfter(0)
    useSlideStore.getState().pastePageAfter(0)

    const pages = useSlideStore.getState().presentation!.pages
    const allNoteIds = new Set<string>()
    for (const p of pages) {
      const notes = (p as Slide & { notes?: Array<{ id: string }> }).notes
      if (notes) {
        for (const n of notes) {
          expect(allNoteIds.has(n.id)).toBe(false)
          allNoteIds.add(n.id)
        }
      }
    }
  })
})

