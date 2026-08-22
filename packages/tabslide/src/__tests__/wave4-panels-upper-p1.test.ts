/**
 * Regression tests for Wave 4 — 面板工具栏(上) P1 fixes:
 * - P1-01: updatePageBg must use runWithHistory for undo support
 * - P1-02: RightSidebar must not double-wrap SlideTab in ScrollArea
 * - P1-03: PageList key must not contain array index prefix
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

describe('P1-01: background changes support undo (SlideTab)', () => {
  const src = readSrc('panels/right-sidebar/SlideTab.tsx')

  it('updatePageBg calls runWithHistory', () => {
    const match = src.match(/const updatePageBg[\s\S]*?(?=\n\s*const |$)/)
    expect(match).toBeTruthy()
    expect(match![0]).toContain('runWithHistory')
  })

  it('updatePageBg does NOT call updatePageBackground directly without history wrapper', () => {
    const lines = src.split('\n')
    const directCalls = lines.filter(
      (line) =>
        line.includes('updatePageBackground(') &&
        !line.includes('runWithHistory') &&
        !line.includes('useSlideStore'),
    )
    const directCallsOutsideHook = directCalls.filter(
      (line) => !line.trim().startsWith('const') || !line.includes('=> s.'),
    )
    expect(directCallsOutsideHook.length).toBe(0)
  })
})

describe('P1-02: no double ScrollArea wrapping SlideTab (RightSidebar)', () => {
  const src = readSrc('panels/right-sidebar/RightSidebar.tsx')

  it('edit tab does not wrap SlideTab in ScrollArea', () => {
    const editCase = src.match(/case 'edit':[\s\S]*?(?=case |default:)/)?.[0]
    expect(editCase).toBeTruthy()
    expect(editCase).not.toMatch(/<ScrollArea[\s\S]*?<SlideTab/)
  })

  it('SlideTab has its own internal ScrollArea', () => {
    const slideTabSrc = readSrc('panels/right-sidebar/SlideTab.tsx')
    expect(slideTabSrc).toContain('<ScrollArea')
  })
})

describe('P1-03: PageList key does not contain array index prefix (PageList)', () => {
  const src = readSrc('panels/PageList.tsx')

  it('render key uses page.id without idx prefix', () => {
    const keyMatch = src.match(/key=\{[^}]+\}/g) || []
    const pageItemKeys = keyMatch.filter((k) => k.includes('page.id') || k.includes('idx'))
    for (const k of pageItemKeys) {
      expect(k).not.toMatch(/`\$\{idx\}-/)
    }
  })

  it('key has page.id as primary identifier', () => {
    expect(src).toContain('key={page.id')
  })
})
