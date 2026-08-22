/**
 * V2 panels-lower W2-07 fixes:
 * - D5-02: turningModeToTracks 补充 scaleX/scaleY/slideX3D/slideY3D/random 翻页模式
 * - D8-02: 形状插入尺寸约束 MAX_SHAPE_SIZE + 居中
 * - D7-02: 协作远端主题更新级联 bg.theme.color
 * - D7-01: 前端 PPTX 导入主题色解析（parseThemeXml）
 * - D8-01: LaTeX 插入 await 前固定 targetPageIndex 确认
 */
import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'
import { parseThemeXml } from '../exports/import-pptx'

const readSrc = (relativePath: string) =>
  fs.readFileSync(path.resolve(__dirname, '..', relativePath), 'utf-8')

// ═══════════════════════════════════════════════════
// D8-02: 形状插入尺寸约束
// ═══════════════════════════════════════════════════

describe('D8-02: insertShape enforces MAX_SHAPE_SIZE and centering', () => {
  const src = readSrc('toolbar/InsertToolbar.tsx')

  it('insertShape 包含 MAX_SHAPE_SIZE 常量', () => {
    expect(src).toContain('MAX_SHAPE_SIZE')
  })

  it('insertShape 使用 Math.min 约束尺寸而非直接使用 viewBox', () => {
    const insertShapeBlock = src.slice(
      src.indexOf('const insertShape'),
      src.indexOf('const insertLine'),
    )
    expect(insertShapeBlock).toContain('Math.min(')
    expect(insertShapeBlock).not.toMatch(/x:\s*400/)
  })

  it('insertShape 使用画布居中定位', () => {
    const insertShapeBlock = src.slice(
      src.indexOf('const insertShape'),
      src.indexOf('const insertLine'),
    )
    expect(insertShapeBlock).toContain('canvasW')
    expect(insertShapeBlock).toContain('canvasH')
    expect(insertShapeBlock).toMatch(/\(canvasW\s*-\s*w\)\s*\/\s*2/)
  })
})

// ═══════════════════════════════════════════════════
// D7-02: 协作远端主题更新级联 bg.theme.color
// ═══════════════════════════════════════════════════

describe('D7-02: collab bridge cascades bg.theme.color on remote theme update', () => {
  const src = readSrc('hooks/useSlideCollabBridge.ts')

  it('导入 resolveThemeColorByKey', () => {
    expect(src).toContain("import { resolveThemeColorByKey }")
  })

  it('远端 theme 更新后遍历 pages 级联 bg.theme.color', () => {
    expect(src).toContain("bg?.type === 'theme'")
    expect(src).toContain('bg.theme?.key')
    expect(src).toContain('resolveThemeColorByKey(bg.theme.key')
  })

  it('级联逻辑在 metaTheme 变更检测为 true 时执行', () => {
    expect(src).toContain('themeChanged')
    expect(src).toContain('if (themeChanged)')
  })
})

// ═══════════════════════════════════════════════════
// D7-01: 前端 PPTX 导入解析 theme1.xml 主题色
// ═══════════════════════════════════════════════════

describe('D7-01: parseThemeXml extracts theme colors from XML', () => {
  const sampleThemeXml = `
    <a:theme xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
      <a:themeElements>
        <a:clrScheme name="CustomBrand">
          <a:dk1><a:sysClr val="windowText" lastClr="1A1A2E"/></a:dk1>
          <a:lt1><a:sysClr val="window" lastClr="FAFAFA"/></a:lt1>
          <a:dk2><a:srgbClr val="16213E"/></a:dk2>
          <a:lt2><a:srgbClr val="E8E8E8"/></a:lt2>
          <a:accent1><a:srgbClr val="0F3460"/></a:accent1>
          <a:accent2><a:srgbClr val="E94560"/></a:accent2>
          <a:accent3><a:srgbClr val="533483"/></a:accent3>
          <a:accent4><a:srgbClr val="FF6F3C"/></a:accent4>
          <a:accent5><a:srgbClr val="2ECC71"/></a:accent5>
          <a:accent6><a:srgbClr val="3498DB"/></a:accent6>
          <a:hlink><a:srgbClr val="0078D4"/></a:hlink>
          <a:folHlink><a:srgbClr val="7B2D8E"/></a:folHlink>
        </a:clrScheme>
        <a:fontScheme name="Office">
          <a:majorFont><a:latin typeface="Calibri Light"/></a:majorFont>
          <a:minorFont><a:latin typeface="Noto Sans SC"/></a:minorFont>
        </a:fontScheme>
      </a:themeElements>
    </a:theme>
  `

  it('提取全部 12 个颜色槽位', () => {
    const { colors } = parseThemeXml(sampleThemeXml)
    expect(colors.dk1).toBe('#1A1A2E')
    expect(colors.lt1).toBe('#FAFAFA')
    expect(colors.dk2).toBe('#16213E')
    expect(colors.lt2).toBe('#E8E8E8')
    expect(colors.accent1).toBe('#0F3460')
    expect(colors.accent2).toBe('#E94560')
    expect(colors.accent3).toBe('#533483')
    expect(colors.accent4).toBe('#FF6F3C')
    expect(colors.accent5).toBe('#2ECC71')
    expect(colors.accent6).toBe('#3498DB')
    expect(colors.hlink).toBe('#0078D4')
    expect(colors.folHlink).toBe('#7B2D8E')
  })

  it('设置 bg1/bg2/tx1/tx2 别名', () => {
    const { colors } = parseThemeXml(sampleThemeXml)
    expect(colors.bg1).toBe(colors.lt1)
    expect(colors.bg2).toBe(colors.lt2)
    expect(colors.tx1).toBe(colors.dk1)
    expect(colors.tx2).toBe(colors.dk2)
  })

  it('提取 minorFont 字体名', () => {
    const { fontName } = parseThemeXml(sampleThemeXml)
    expect(fontName).toBe('Noto Sans SC')
  })

  it('提取 minorFont 东亚字体，避免只剩西文 latin', () => {
    const xml = `
      <a:theme>
        <a:fontScheme>
          <a:majorFont>
            <a:latin typeface="Arial"/>
            <a:ea typeface="Microsoft YaHei"/>
          </a:majorFont>
          <a:minorFont>
            <a:latin typeface="Arial"/>
            <a:ea typeface="Microsoft YaHei"/>
          </a:minorFont>
        </a:fontScheme>
      </a:theme>
    `
    const parsed = parseThemeXml(xml)
    expect(parsed.fontName).toBe('Arial')
    expect(parsed.eastAsianFontName).toBe('Microsoft YaHei')
    expect(parsed.majorLatin).toBe('Arial')
    expect(parsed.majorEastAsian).toBe('Microsoft YaHei')
  })

  it('sysClr 使用 lastClr 属性', () => {
    const xml = `<a:clrScheme><a:dk1><a:sysClr val="windowText" lastClr="222222"/></a:dk1></a:clrScheme>`
    const { colors } = parseThemeXml(xml)
    expect(colors.dk1).toBe('#222222')
  })

  it('空 XML 返回空 colors 对象', () => {
    const { colors, fontName } = parseThemeXml('<a:theme></a:theme>')
    expect(Object.keys(colors)).toHaveLength(0)
    expect(fontName).toBeUndefined()
  })

  it('部分颜色缺失只返回已解析的槽位', () => {
    const partialXml = `
      <a:clrScheme name="Partial">
        <a:accent1><a:srgbClr val="FF0000"/></a:accent1>
        <a:accent2><a:srgbClr val="00FF00"/></a:accent2>
      </a:clrScheme>
    `
    const { colors } = parseThemeXml(partialXml)
    expect(colors.accent1).toBe('#FF0000')
    expect(colors.accent2).toBe('#00FF00')
    expect(colors.accent3).toBeUndefined()
    expect(colors.dk1).toBeUndefined()
  })
})

describe('D7-01: importPPTXFromBuffer uses parsed theme (source analysis)', () => {
  const src = readSrc('exports/import-pptx/index.ts')

  it('读取 ppt/theme/theme1.xml', () => {
    expect(src).toContain("ppt/theme/theme1.xml")
  })

  it('调用 parseThemeXml 解析主题色', () => {
    expect(src).toContain('parseThemeXml(themeXml)')
  })

  it('使用 buildThemeFromColors 构建主题对象', () => {
    expect(src).toContain('buildThemeFromColors')
  })

  it('schemeColorMap 为局部变量（PP-004 修复后不再使用全局变量）', () => {
    expect(src).toContain('const schemeColorMap')
    expect(src).not.toContain('_activeSchemeColorMap')
  })
})

// ═══════════════════════════════════════════════════
// D8-01: LaTeX 插入 await 前固定 targetPageIndex 确认
// ═══════════════════════════════════════════════════

describe('D8-01: insertLatex page index capture (confirmation)', () => {
  const src = readSrc('toolbar/InsertToolbar.tsx')

  it('insertLatex 在异步操作前捕获 currentPageIndex', () => {
    const fnMatch = src.match(/const insertLatex[\s\S]*?(?=\n  const \w|\n  return\b)/)
    expect(fnMatch).not.toBeNull()
    const fnBody = fnMatch![0]
    const capturePos = fnBody.indexOf('targetPageIndex')
    const awaitPos = fnBody.indexOf('await')
    expect(capturePos).toBeGreaterThan(-1)
    expect(awaitPos).toBeGreaterThan(-1)
    expect(capturePos).toBeLessThan(awaitPos)
  })

  it('addElement 接受 pageIndex 参数', () => {
    expect(src).toMatch(/addElement\(el,\s*targetPageIndex\)/)
  })
})
