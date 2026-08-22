/**
 * Regression tests for Wave 5 — 面板工具栏(上) P1 fixes:
 * - P1-04: reorderPages 中 current 变量不再遮蔽 Immer current 导入
 * - P1-05: duplicatePage / pastePageAfter 重生成 masterElements 的元素 ID
 * - P1-06: FillEditor pattern 上传走 resolveImageSrc 而非直接 base64
 */
import { beforeEach, describe, it, expect, vi } from 'vitest'
import fs from 'fs'
import path from 'path'

// ── Store 测试需要的 mock ──
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
import type { SlidePresentation, PPTElement } from '../types/slides'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

const makePresentation = (pageCount = 1): SlidePresentation => ({
  id: 'pres_test',
  name: 'Test',
  preset: '16:9',
  canvasWidth: 1920,
  canvasHeight: 1080,
  pages: Array.from({ length: pageCount }, (_, i) => ({
    id: `page_${i}`,
    elements: [
      { id: `el_${i}_a`, type: 'text', x: 0, y: 0, width: 100, height: 50, rotate: 0, opacity: 1, locked: false, content: '' } as PPTElement,
    ],
    masterElements: [
      { id: `master_${i}_a`, type: 'shape', x: 0, y: 0, width: 100, height: 50, rotate: 0, opacity: 1, locked: false } as PPTElement,
      { id: `master_${i}_b`, type: 'text', x: 50, y: 50, width: 100, height: 50, rotate: 0, opacity: 1, locked: false, content: '' } as PPTElement,
    ],
    background: { type: 'solid' as const, color: '#ffffff' },
  })),
})

const resetStore = () => useSlideStore.getState().reset()

// ═══════════════════════════════════════════════════
// P1-04: reorderPages 变量遮蔽修复
// ═══════════════════════════════════════════════════

describe('P1-04: reorderPages 不再使用 current 变量名遮蔽 Immer current', () => {
  const src = readSrc('store/slide/slices/page/action.ts')

  it('reorderPages 函数体内不存在 const current = 赋值', () => {
    const lines = src.split('\n')
    const startIdx = lines.findIndex((l) => l.includes("reorderPages: SlideStoreState['reorderPages']"))
    expect(startIdx).toBeGreaterThan(0)
    const block = lines.slice(startIdx, startIdx + 30).join('\n')
    expect(block).not.toMatch(/const current\s*=/)
    expect(block).toMatch(/const prevIndex\s*=/)
  })

  it('页面 slice 顶部仍导入 Immer current', () => {
    expect(src).toMatch(/import\s*\{[^}]*current[^}]*\}\s*from\s*['"]immer['"]/)
  })

  it('reorderPages 正确调整 currentPageIndex', () => {
    resetStore()
    useSlideStore.getState().setPresentation(makePresentation(4))
    useSlideStore.getState().setCurrentPage(0)

    useSlideStore.getState().reorderPages(0, 2)
    expect(useSlideStore.getState().currentPageIndex).toBe(2)

    resetStore()
    useSlideStore.getState().setPresentation(makePresentation(4))
    useSlideStore.getState().setCurrentPage(2)
    useSlideStore.getState().reorderPages(0, 2)
    expect(useSlideStore.getState().currentPageIndex).toBe(1)

    resetStore()
    useSlideStore.getState().setPresentation(makePresentation(4))
    useSlideStore.getState().setCurrentPage(1)
    useSlideStore.getState().reorderPages(3, 1)
    expect(useSlideStore.getState().currentPageIndex).toBe(2)
  })
})

// ═══════════════════════════════════════════════════
// P1-05: masterElements ID 重生成
// ═══════════════════════════════════════════════════

describe('P1-05: duplicatePage / pastePageAfter 重生成 masterElements ID', () => {
  beforeEach(resetStore)

  it('duplicatePage 生成新的 masterElements ID', () => {
    useSlideStore.getState().setPresentation(makePresentation(1))
    const originalPage = useSlideStore.getState().presentation!.pages[0]
    const originalMasterIds = originalPage.masterElements!.map((el) => el.id)

    useSlideStore.getState().duplicatePage(0)

    const duplicated = useSlideStore.getState().presentation!.pages[1]
    expect(duplicated.masterElements).toBeDefined()
    expect(duplicated.masterElements!.length).toBe(originalMasterIds.length)

    const newMasterIds = duplicated.masterElements!.map((el) => el.id)
    for (const origId of originalMasterIds) {
      expect(newMasterIds).not.toContain(origId)
    }
  })

  it('pastePageAfter 生成新的 masterElements ID', () => {
    useSlideStore.getState().setPresentation(makePresentation(1))
    const originalPage = useSlideStore.getState().presentation!.pages[0]
    const originalMasterIds = originalPage.masterElements!.map((el) => el.id)

    useSlideStore.getState().copyPage(0)
    useSlideStore.getState().pastePageAfter(0)

    const pasted = useSlideStore.getState().presentation!.pages[1]
    expect(pasted.masterElements).toBeDefined()
    expect(pasted.masterElements!.length).toBe(originalMasterIds.length)

    const newMasterIds = pasted.masterElements!.map((el) => el.id)
    for (const origId of originalMasterIds) {
      expect(newMasterIds).not.toContain(origId)
    }
  })

  it('duplicatePage 后两个页面间无 masterElements ID 重复', () => {
    useSlideStore.getState().setPresentation(makePresentation(1))
    useSlideStore.getState().duplicatePage(0)

    const pages = useSlideStore.getState().presentation!.pages
    const allMasterIds = pages.flatMap((p) => (p.masterElements || []).map((el) => el.id))
    const uniqueIds = new Set(allMasterIds)
    expect(uniqueIds.size).toBe(allMasterIds.length)
  })
})

// ═══════════════════════════════════════════════════
// P1-06: FillEditor pattern 上传走 resolveImageSrc
// ═══════════════════════════════════════════════════

describe('P1-06: FillEditor pattern 上传使用 resolveImageSrc', () => {
  const src = readSrc('panels/right-sidebar/editors/FillEditor.tsx')

  it('导入 resolveImageSrc', () => {
    expect(src).toContain('resolveImageSrc')
  })

  it('不再直接使用 FileReader.readAsDataURL', () => {
    expect(src).not.toContain('readAsDataURL')
    expect(src).not.toContain('new FileReader')
  })

  it('接受 onUploadImage 可选 prop', () => {
    expect(src).toMatch(/onUploadImage\?\s*:\s*\(file:\s*File\)\s*=>\s*Promise<string>/)
  })

  it('调用 resolveImageSrc 时传入 onUploadImage', () => {
    expect(src).toMatch(/resolveImageSrc\(file,\s*onUploadImage\)/)
  })
})

describe('P1-06: onUploadImage 传递链路完整', () => {
  it('StyleEditor 接受 onUploadImage prop', () => {
    const src = readSrc('panels/right-sidebar/editors/style-editor/index.tsx')
    expect(src).toMatch(/onUploadImage\?/)
  })

  it('PropertiesTab 接受并传递 onUploadImage', () => {
    const src = readSrc('panels/right-sidebar/PropertiesTab.tsx')
    expect(src).toContain('onUploadImage')
    expect(src).toMatch(/<StyleEditor[\s\S]*?onUploadImage/)
  })

  it('SlideTab 接受并传递 onUploadImage', () => {
    const src = readSrc('panels/right-sidebar/SlideTab.tsx')
    expect(src).toContain('onUploadImage')
    expect(src).toMatch(/<FillEditor[\s\S]*?onUploadImage/)
  })

  it('RightSidebar 向 SlideTab 和 PropertiesTab 传递 onUploadImage', () => {
    const src = readSrc('panels/right-sidebar/RightSidebar.tsx')
    expect(src).toMatch(/<PropertiesTab[\s\S]*?onUploadImage/)
    expect(src).toMatch(/<SlideTab[\s\S]*?onUploadImage/)
  })
})
