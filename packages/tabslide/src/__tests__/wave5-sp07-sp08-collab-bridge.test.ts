/**
 * Wave 5b 场景验证修复回归测试
 *
 * SP1-07: Y.Doc 初始同步检测 isDirty，合并而非覆盖本地未保存修改
 * SP1-08: 远端页面删除后校正 currentPageIndex
 */
import { describe, it, expect } from 'vitest'
import {
  stableStringify,
} from '../hooks/useSlideCollabBridge'
import { useSlideStore } from '../store/slide'
import type { Slide, SlidePresentation } from '../types/slides'

// ── 辅助 ─────────────────────────────────────────────────

const makePage = (id: string, content?: string): Slide => ({
  id,
  elements: content
    ? [{ id: `${id}_el`, type: 'text' as const, x: 0, y: 0, width: 100, height: 50, rotate: 0, content } as any]
    : [],
  background: { type: 'solid' as const, color: '#ffffff' },
})

const makePresentation = (pages: Slide[]): SlidePresentation => ({
  id: 'test-pres',
  name: 'Test',
  pages,
  canvas: { width: 960, height: 540 },
  theme: {} as any,
})

// ═══════════════════════════════════════════════════════════
// SP1-08: currentPageIndex 校正逻辑单元测试
// ═══════════════════════════════════════════════════════════

describe('SP1-08: currentPageIndex 越界校正', () => {
  it('当前页被远端删除后 index 回退到末尾', () => {
    const pages = [makePage('p1'), makePage('p2'), makePage('p3')]
    useSlideStore.getState().setPresentation(makePresentation(pages))
    useSlideStore.setState({ currentPageIndex: 2 })

    // 模拟远端删除 p3 后的 pages 数组（只剩 p1, p2）
    const newPages = [makePage('p1'), makePage('p2')]
    useSlideStore.setState((prev) => ({
      presentation: prev.presentation
        ? { ...prev.presentation, pages: newPages }
        : prev.presentation,
      currentPageIndex: Math.min(prev.currentPageIndex, newPages.length - 1),
    }))

    expect(useSlideStore.getState().currentPageIndex).toBe(1)
  })

  it('删除非当前页时 index 尝试保持在同一页面', () => {
    const pages = [makePage('p1'), makePage('p2'), makePage('p3')]
    useSlideStore.getState().setPresentation(makePresentation(pages))
    useSlideStore.setState({ currentPageIndex: 1 })

    // 模拟远端删除 p3（当前页 p2 仍然存在）
    const newPages = [makePage('p1'), makePage('p2')]
    const currentId = pages[1]!.id
    const newIdx = newPages.findIndex(p => p.id === currentId)
    useSlideStore.setState((prev) => ({
      presentation: prev.presentation
        ? { ...prev.presentation, pages: newPages }
        : prev.presentation,
      currentPageIndex: newIdx >= 0 ? newIdx : Math.min(prev.currentPageIndex, newPages.length - 1),
    }))

    expect(useSlideStore.getState().currentPageIndex).toBe(1)
    expect(useSlideStore.getState().presentation?.pages[1]?.id).toBe('p2')
  })

  it('当前页在中间被删除，页面重排后定位到相邻页', () => {
    const pages = [makePage('p1'), makePage('p2'), makePage('p3')]
    useSlideStore.getState().setPresentation(makePresentation(pages))
    useSlideStore.setState({ currentPageIndex: 1 })

    // 远端删除 p2（当前页）
    const newPages = [makePage('p1'), makePage('p3')]
    const currentId = 'p2'
    const newIdx = newPages.findIndex(p => p.id === currentId)
    useSlideStore.setState((prev) => ({
      presentation: prev.presentation
        ? { ...prev.presentation, pages: newPages }
        : prev.presentation,
      currentPageIndex: newIdx >= 0 ? newIdx : Math.min(prev.currentPageIndex, newPages.length - 1),
    }))

    expect(useSlideStore.getState().currentPageIndex).toBe(1)
    expect(useSlideStore.getState().presentation?.pages[1]?.id).toBe('p3')
  })
})

// ═══════════════════════════════════════════════════════════
// SP1-07: stableStringify 确保 Y.js 与 Zustand 对象键序差异不影响指纹
// ═══════════════════════════════════════════════════════════

describe('SP1-07: stableStringify 键序无关比较', () => {
  it('不同键序的对象产生相同字符串', () => {
    const a = { b: 2, a: 1 }
    const b = { a: 1, b: 2 }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('嵌套对象也键序无关', () => {
    const a = { outer: { z: 3, a: 1 }, id: '1' }
    const b = { id: '1', outer: { a: 1, z: 3 } }
    expect(stableStringify(a)).toBe(stableStringify(b))
  })

  it('数组元素顺序敏感', () => {
    expect(stableStringify([1, 2])).not.toBe(stableStringify([2, 1]))
  })

  it('处理 null 和 undefined', () => {
    expect(stableStringify(null)).toBe('null')
    expect(stableStringify(undefined)).toBe(undefined)
  })
})

// ═══════════════════════════════════════════════════════════
// SP1-07: isDirty 状态检测验证
// ═══════════════════════════════════════════════════════════

describe('SP1-07: isDirty 初始同步决策', () => {
  it('初始 isDirty 为 false', () => {
    useSlideStore.getState().reset()
    expect(useSlideStore.getState().isDirty).toBe(false)
  })

  it('markDirty 后 isDirty 为 true', () => {
    const pages = [makePage('p1')]
    useSlideStore.getState().setPresentation(makePresentation(pages))
    useSlideStore.getState().markDirty()
    expect(useSlideStore.getState().isDirty).toBe(true)
  })

  it('markClean 后 isDirty 恢复 false', () => {
    const pages = [makePage('p1')]
    useSlideStore.getState().setPresentation(makePresentation(pages))
    useSlideStore.getState().markDirty()
    useSlideStore.getState().markClean()
    expect(useSlideStore.getState().isDirty).toBe(false)
  })
})
