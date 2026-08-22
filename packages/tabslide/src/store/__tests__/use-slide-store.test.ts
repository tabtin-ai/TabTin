/**
 * useSlideStore 单元测试
 *
 * 覆盖范围（TC-04）：
 * - addElement / updateElement / deleteElements
 * - addPage / deletePage / reorderPages
 * - isDirty 标记逻辑
 * - markClean / setSaveStatus 后 dirty 重置
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── Mock 有副作用或 DOM 依赖的工具模块 ──────────────────────────
vi.mock('../../utils/id', () => {
  let counter = 0
  return {
    createElementId: () => `el_mock_${++counter}`,
    createPageId: () => `page_mock_${++counter}`,
    createPresentationId: () => `pres_mock_${++counter}`,
    regenerateNestedIds: vi.fn(),
  }
})

vi.mock('../../utils/sanitize', () => ({
  sanitizeHtml: vi.fn((html: string) => html),
  sanitizeCssValue: vi.fn((v: string) => v),
  isSafeSrcUrl: vi.fn(() => true),
}))

vi.mock('../../utils/line-geometry', () => ({
  normalizeLineGeometry: vi.fn((el: unknown) => el),
}))

vi.mock('../../configs/shapes', () => ({
  getShapePath: vi.fn(() => ''),
}))

// ── 被测模块（在 mock 之后导入） ─────────────────────────────────
import { useSlideStore } from '../slide'
import type {
  SlidePresentation,
  PPTTextElement,
} from '../../types/slides'

// ── 测试辅助 ────────────────────────────────────────────────────

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

/** 在每个测试开始前重置 store 到初始状态 */
const resetStore = () => {
  useSlideStore.getState().reset()
}

// ═══════════════════════════════════════════════════════════════
// 测试套件
// ═══════════════════════════════════════════════════════════════

describe('useSlideStore', () => {
  beforeEach(() => {
    resetStore()
  })

  // ─── 初始状态 ────────────────────────────────────────────────

  describe('初始状态', () => {
    it('presentation 为 null，isDirty 为 false', () => {
      const s = useSlideStore.getState()
      expect(s.presentation).toBeNull()
      expect(s.isDirty).toBe(false)
      expect(s.saveStatus).toBe('idle')
    })
  })

  // ─── setPresentation ────────────────────────────────────────

  describe('setPresentation', () => {
    it('设置 presentation 后 isDirty 保持 false', () => {
      const { setPresentation } = useSlideStore.getState()
      setPresentation(makePresentation())
      const s = useSlideStore.getState()
      expect(s.presentation).not.toBeNull()
      expect(s.isDirty).toBe(false)
      expect(s.currentPageIndex).toBe(0)
    })

    it('设置 presentation 后 pageCount 正确', () => {
      useSlideStore.getState().setPresentation(makePresentation(3))
      expect(useSlideStore.getState().pageCount()).toBe(3)
    })
  })

  // ─── addElement ──────────────────────────────────────────────

  describe('addElement', () => {
    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation())
    })

    it('添加元素后元素存在于当前页面', () => {
      const el = makeTextElement('el_a')
      useSlideStore.getState().addElement(el)

      const page = useSlideStore.getState().currentPage()
      expect(page?.elements).toHaveLength(1)
      expect(page?.elements[0]?.id).toBe('el_a')
    })

    it('addElement 后 isDirty 变为 true', () => {
      useSlideStore.getState().addElement(makeTextElement('el_b'))
      expect(useSlideStore.getState().isDirty).toBe(true)
      expect(useSlideStore.getState().saveStatus).toBe('unsaved')
    })

    it('addElement 后新元素成为选中状态', () => {
      useSlideStore.getState().addElement(makeTextElement('el_c'))
      expect(useSlideStore.getState().selectedElementIds).toContain('el_c')
    })

    it('addElement 到指定页', () => {
      useSlideStore.getState().setPresentation(makePresentation(2))
      useSlideStore.getState().addElement(makeTextElement('el_page1'), 1)
      const page1 = useSlideStore.getState().presentation?.pages[1]
      expect(page1?.elements).toHaveLength(1)
    })
  })

  // ─── updateElement ───────────────────────────────────────────

  describe('updateElement', () => {
    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation())
      useSlideStore.getState().addElement(makeTextElement('el_upd'))
      // 重置 dirty（模拟已保存状态）
      useSlideStore.getState().markClean()
    })

    it('updateElement 更新元素属性', () => {
      useSlideStore.getState().updateElement('el_upd', { x: 200 })
      const page = useSlideStore.getState().currentPage()
      expect(page?.elements.find((e) => e.id === 'el_upd')?.x).toBe(200)
    })

    it('updateElement 后 isDirty 变为 true', () => {
      expect(useSlideStore.getState().isDirty).toBe(false)
      useSlideStore.getState().updateElement('el_upd', { x: 300 })
      expect(useSlideStore.getState().isDirty).toBe(true)
    })

    it('更新不存在的元素不抛错且不改变 dirty', () => {
      expect(() => {
        useSlideStore.getState().updateElement('nonexistent', { x: 999 })
      }).not.toThrow()
      expect(useSlideStore.getState().isDirty).toBe(false)
    })
  })

  // ─── deleteElements ──────────────────────────────────────────

  describe('deleteElements', () => {
    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation())
      useSlideStore.getState().addElement(makeTextElement('el_del_a'))
      useSlideStore.getState().addElement(makeTextElement('el_del_b'))
      useSlideStore.getState().markClean()
    })

    it('deleteElements 删除指定元素', () => {
      useSlideStore.getState().deleteElements(['el_del_a'])
      const page = useSlideStore.getState().currentPage()
      expect(page?.elements.find((e) => e.id === 'el_del_a')).toBeUndefined()
      expect(page?.elements.find((e) => e.id === 'el_del_b')).toBeDefined()
    })

    it('deleteElements 后 isDirty 变为 true', () => {
      useSlideStore.getState().deleteElements(['el_del_a'])
      expect(useSlideStore.getState().isDirty).toBe(true)
    })

    it('locked 元素不可删除', () => {
      useSlideStore.getState().addElement(makeTextElement('el_locked', { locked: true }))
      useSlideStore.getState().markClean()

      useSlideStore.getState().deleteElements(['el_locked'])
      const page = useSlideStore.getState().currentPage()
      expect(page?.elements.find((e) => e.id === 'el_locked')).toBeDefined()
      expect(useSlideStore.getState().isDirty).toBe(false)
    })

    it('批量删除多个元素', () => {
      useSlideStore.getState().deleteElements(['el_del_a', 'el_del_b'])
      expect(useSlideStore.getState().currentPage()?.elements).toHaveLength(0)
    })
  })

  // ─── addPage ─────────────────────────────────────────────────

  describe('addPage', () => {
    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation())
    })

    it('addPage 增加一页', () => {
      expect(useSlideStore.getState().pageCount()).toBe(1)
      useSlideStore.getState().addPage()
      expect(useSlideStore.getState().pageCount()).toBe(2)
    })

    it('addPage 后 isDirty 变为 true', () => {
      useSlideStore.getState().markClean()
      useSlideStore.getState().addPage()
      expect(useSlideStore.getState().isDirty).toBe(true)
    })

    it('addPage(after) 在指定位置后插入', () => {
      useSlideStore.getState().setPresentation(makePresentation(3))
      const before = useSlideStore.getState().presentation!.pages.map((p) => p.id)

      useSlideStore.getState().addPage(0) // 在第一页后插入
      const after = useSlideStore.getState().presentation!.pages
      expect(after).toHaveLength(4)
      // 第 0 位仍是原来的第一页
      expect(after[0]!.id).toBe(before[0])
      // 第 1 位是新插入的空白页
      expect(after[1]!.elements).toHaveLength(0)
    })

    it('addPage 后 currentPageIndex 跳到新页', () => {
      useSlideStore.getState().addPage()
      expect(useSlideStore.getState().currentPageIndex).toBe(1)
    })
  })

  // ─── deletePage ──────────────────────────────────────────────

  describe('deletePage', () => {
    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation(3))
      useSlideStore.getState().markClean()
    })

    it('deletePage 减少页数', () => {
      useSlideStore.getState().deletePage(1)
      expect(useSlideStore.getState().pageCount()).toBe(2)
    })

    it('deletePage 后 isDirty 变为 true', () => {
      useSlideStore.getState().deletePage(1)
      expect(useSlideStore.getState().isDirty).toBe(true)
    })

    it('只有一页时 deletePage 无效', () => {
      useSlideStore.getState().setPresentation(makePresentation(1))
      useSlideStore.getState().markClean()
      useSlideStore.getState().deletePage(0)
      expect(useSlideStore.getState().pageCount()).toBe(1)
      expect(useSlideStore.getState().isDirty).toBe(false)
    })

    it('删除当前页后 currentPageIndex 不越界', () => {
      useSlideStore.getState().setCurrentPage(2)
      useSlideStore.getState().deletePage(2)
      expect(useSlideStore.getState().currentPageIndex).toBe(1)
    })
  })

  // ─── reorderPages ────────────────────────────────────────────

  describe('reorderPages', () => {
    let pageIds: string[]

    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation(3))
      pageIds = useSlideStore.getState().presentation!.pages.map((p) => p.id)
      useSlideStore.getState().markClean()
    })

    it('reorderPages 将第0页移到第2位', () => {
      // [page_0, page_1, page_2] → splice(0,1) → [page_1, page_2] → splice(2,0,page_0) → [page_1, page_2, page_0]
      useSlideStore.getState().reorderPages(0, 2)
      const pages = useSlideStore.getState().presentation!.pages
      expect(pages[0]!.id).toBe(pageIds[1])  // page_1 移上来
      expect(pages[1]!.id).toBe(pageIds[2])  // page_2 移上来
      expect(pages[2]!.id).toBe(pageIds[0])  // page_0 移到末尾
    })

    it('reorderPages 后 isDirty 变为 true', () => {
      useSlideStore.getState().reorderPages(0, 1)
      expect(useSlideStore.getState().isDirty).toBe(true)
    })

    it('from === to 不触发 dirty', () => {
      useSlideStore.getState().reorderPages(1, 1)
      expect(useSlideStore.getState().isDirty).toBe(false)
    })

    it('reorderPages 后当前页 index 跟随移动', () => {
      useSlideStore.getState().setCurrentPage(0)
      useSlideStore.getState().reorderPages(0, 2)
      expect(useSlideStore.getState().currentPageIndex).toBe(2)
    })
  })

  // ─── isDirty 标记逻辑 ────────────────────────────────────────

  describe('isDirty 标记逻辑', () => {
    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation())
    })

    it('markDirty 直接标记 dirty', () => {
      useSlideStore.getState().markDirty()
      expect(useSlideStore.getState().isDirty).toBe(true)
      expect(useSlideStore.getState().saveStatus).toBe('unsaved')
    })

    it('markClean 清除 dirty', () => {
      useSlideStore.getState().markDirty()
      useSlideStore.getState().markClean()
      expect(useSlideStore.getState().isDirty).toBe(false)
    })

    it('updatePresentationMeta 后 dirty = true', () => {
      useSlideStore.getState().markClean()
      useSlideStore.getState().updatePresentationMeta({ name: '新标题' })
      expect(useSlideStore.getState().isDirty).toBe(true)
    })
  })

  // ─── save 后 dirty 重置 ──────────────────────────────────────

  describe('save 后 dirty 重置', () => {
    beforeEach(() => {
      useSlideStore.getState().setPresentation(makePresentation())
    })

    it('setSaveStatus("saving") 将 isDirty 置为 false', () => {
      useSlideStore.getState().markDirty()
      useSlideStore.getState().setSaveStatus('saving')
      expect(useSlideStore.getState().isDirty).toBe(false)
      expect(useSlideStore.getState().saveStatus).toBe('saving')
    })

    it('setSaveStatus("saved") 将 saveStatus 置为 saved', () => {
      useSlideStore.getState().setSaveStatus('saving')
      useSlideStore.getState().setSaveStatus('saved')
      expect(useSlideStore.getState().saveStatus).toBe('saved')
    })

    it('保存后再 addElement isDirty 再次变为 true', () => {
      useSlideStore.getState().setSaveStatus('saving')
      useSlideStore.getState().setSaveStatus('saved')
      expect(useSlideStore.getState().isDirty).toBe(false)

      useSlideStore.getState().addElement(makeTextElement('el_post_save'))
      expect(useSlideStore.getState().isDirty).toBe(true)
    })

    it('setSaveStatus("error") 将 isDirty 重置为 true', () => {
      useSlideStore.getState().setSaveStatus('saving')
      useSlideStore.getState().setSaveStatus('error', '网络超时')
      expect(useSlideStore.getState().isDirty).toBe(true)
      expect(useSlideStore.getState().saveStatus).toBe('error')
      expect(useSlideStore.getState().saveError).toBe('网络超时')
    })
  })
})
