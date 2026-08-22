import { describe, expect, it } from 'vitest'
import fs from 'fs'
import path from 'path'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

describe('#649: 插入面板内部响应式', () => {
  it('右侧插入面板让展开子面板跟随容器宽度', () => {
    const src = readSrc('panels/right-sidebar/SlideInsertPanel.tsx')

    expect(src).toContain("const INLINE_PANEL_WIDTH = '100%' as const")
    expect(src).toContain('style={{ gridTemplateColumns: `repeat(auto-fit, minmax(${INSERT_CARD_MIN_WIDTH}px, 1fr))` }}')
    expect(src).toContain('<ShapePanel width={INLINE_PANEL_WIDTH}')
    expect(src).toContain('<LinePanel width={INLINE_PANEL_WIDTH}')
    expect(src).toContain('<TableGridPicker width={INLINE_PANEL_WIDTH}')
    expect(src).toContain('<ChartPanel width={INLINE_PANEL_WIDTH}')
    expect(src).toContain('<LatexPanel width={INLINE_PANEL_WIDTH}')
  })

  it('旧工具栏插入弹出层仍保留默认定宽路径', () => {
    const src = readSrc('toolbar/InsertToolbar.tsx')

    expect(src).toContain('<ShapePanel onInsert=')
    expect(src).toContain('<LinePanel onInsert=')
    expect(src).toContain('<TableGridPicker onInsert=')
    expect(src).toContain('<ChartPanel onInsert=')
    expect(src).toContain('<LatexPanel onInsert=')
    expect(src).not.toContain('width={INLINE_PANEL_WIDTH}')
  })

  it('插入子面板默认宽度不变，但允许调用方传入容器宽度', () => {
    const shared = readSrc('toolbar/insert-panels/shared.tsx')
    const shape = readSrc('toolbar/insert-panels/ShapePanel.tsx')
    const line = readSrc('toolbar/insert-panels/LinePanel.tsx')
    const table = readSrc('toolbar/insert-panels/TableGridPicker.tsx')
    const chart = readSrc('toolbar/insert-panels/ChartPanel.tsx')
    const latex = readSrc('toolbar/insert-panels/LatexPanel.tsx')

    expect(shared).toContain("width?: React.CSSProperties['width']")
    expect(shared).toContain("maxWidth: '100%'")
    expect(shape).toContain('width = SHAPE_PANEL_WIDTH')
    expect(line).toContain('width = LINE_PANEL_WIDTH')
    expect(table).toContain('width = TABLE_PANEL_WIDTH')
    expect(chart).toContain('width = CHART_PANEL_WIDTH')
    expect(latex).toContain('width = LATEX_PANEL_WIDTH')
  })
})
