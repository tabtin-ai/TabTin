/**
 * 回归测试 — IE-016 / IE-017
 *
 * IE-016: extractPosition 支持负坐标（PPTX 合法负 x/y）
 * IE-017: extractTextContent 每个 <a:p> 生成独立 <p>，保留对齐/间距
 */
import { describe, it, expect } from 'vitest'
import { extractPosition, extractTextContent, importPPTXFromFile } from '../import-pptx'

// ═══════════════════════════════════════════════
// IE-016: 负坐标元素不被丢弃
// ═══════════════════════════════════════════════

describe('IE-016: extractPosition 负坐标', () => {
  it('正坐标正常解析', () => {
    const xml = `
      <p:sp>
        <p:spPr>
          <a:xfrm>
            <a:off x="914400" y="457200"/>
            <a:ext cx="1828800" cy="914400"/>
          </a:xfrm>
        </p:spPr>
      </p:sp>
    `
    const pos = extractPosition(xml)
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(96, 0)
    expect(pos!.y).toBeCloseTo(48, 0)
    expect(pos!.width).toBeCloseTo(192, 0)
    expect(pos!.height).toBeCloseTo(96, 0)
  })

  it('负 x 坐标不被丢弃', () => {
    const xml = `
      <p:sp>
        <p:spPr>
          <a:xfrm>
            <a:off x="-914400" y="457200"/>
            <a:ext cx="1828800" cy="914400"/>
          </a:xfrm>
        </p:spPr>
      </p:sp>
    `
    const pos = extractPosition(xml)
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeCloseTo(-96, 0)
    expect(pos!.y).toBeCloseTo(48, 0)
  })

  it('负 y 坐标不被丢弃', () => {
    const xml = `
      <p:sp>
        <p:spPr>
          <a:xfrm>
            <a:off x="0" y="-457200"/>
            <a:ext cx="914400" cy="914400"/>
          </a:xfrm>
        </p:spPr>
      </p:sp>
    `
    const pos = extractPosition(xml)
    expect(pos).not.toBeNull()
    expect(pos!.y).toBeCloseTo(-48, 0)
  })

  it('x 和 y 同时为负', () => {
    const xml = `
      <a:off x="-100000" y="-200000"/>
      <a:ext cx="500000" cy="300000"/>
    `
    const pos = extractPosition(xml)
    expect(pos).not.toBeNull()
    expect(pos!.x).toBeLessThan(0)
    expect(pos!.y).toBeLessThan(0)
    expect(pos!.width).toBeGreaterThan(0)
    expect(pos!.height).toBeGreaterThan(0)
  })

  it('旋转角度支持负值（已有能力，回归保护）', () => {
    const xml = `
      <a:xfrm rot="-5400000">
        <a:off x="100" y="200"/>
        <a:ext cx="500000" cy="300000"/>
      </a:xfrm>
    `
    const pos = extractPosition(xml)
    expect(pos).not.toBeNull()
    expect(pos!.rotate).toBe(-90)
  })

  it('零坐标正常解析', () => {
    const xml = `<a:off x="0" y="0"/><a:ext cx="914400" cy="914400"/>`
    const pos = extractPosition(xml)
    expect(pos).not.toBeNull()
    expect(pos!.x).toBe(0)
    expect(pos!.y).toBe(0)
  })
})

describe('PPTX import adapter requirement', () => {
  it('does not fall back to client-side parsing without an adapter', async () => {
    const file = new File(['not-a-pptx'], 'fallback-test.pptx', {
      type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    })

    const result = await importPPTXFromFile(file)

    expect(result.success).toBe(false)
    expect(result.error).toContain('后端解析 adapter')
  })
})

// ═══════════════════════════════════════════════
// IE-017: 多段落文本保留排版
// ═══════════════════════════════════════════════

describe('IE-017: extractTextContent 多段落', () => {
  it('单段落行为不变', () => {
    const xml = `
      <p:txBody>
        <a:p><a:r><a:t>Hello World</a:t></a:r></a:p>
      </p:txBody>
    `
    expect(extractTextContent(xml)).toBe('<p>Hello World</p>')
  })

  it('多段落生成独立 <p>', () => {
    const xml = `
      <p:txBody>
        <a:p><a:r><a:t>第一段</a:t></a:r></a:p>
        <a:p><a:r><a:t>第二段</a:t></a:r></a:p>
        <a:p><a:r><a:t>第三段</a:t></a:r></a:p>
      </p:txBody>
    `
    const result = extractTextContent(xml)
    expect(result).toBe('<p>第一段</p><p>第二段</p><p>第三段</p>')
  })

  it('保留居中对齐', () => {
    const xml = `
      <p:txBody>
        <a:p><a:pPr algn="ctr"/><a:r><a:t>居中标题</a:t></a:r></a:p>
      </p:txBody>
    `
    const result = extractTextContent(xml)
    expect(result).toContain('text-align: center')
    expect(result).toContain('居中标题')
  })

  it('保留右对齐', () => {
    const xml = `
      <p:txBody>
        <a:p><a:pPr algn="r"/><a:r><a:t>右对齐</a:t></a:r></a:p>
      </p:txBody>
    `
    expect(extractTextContent(xml)).toContain('text-align: right')
  })

  it('保留两端对齐（just）', () => {
    const xml = `
      <p:txBody>
        <a:p><a:pPr algn="just"/><a:r><a:t>两端对齐</a:t></a:r></a:p>
      </p:txBody>
    `
    expect(extractTextContent(xml)).toContain('text-align: justify')
  })

  it('保留段前/段后间距', () => {
    const xml = `
      <p:txBody>
        <a:p>
          <a:pPr>
            <a:spcBef><a:spcPts val="1200"/></a:spcBef>
            <a:spcAft><a:spcPts val="600"/></a:spcAft>
          </a:pPr>
          <a:r><a:t>有间距的段落</a:t></a:r>
        </a:p>
      </p:txBody>
    `
    const result = extractTextContent(xml)
    expect(result).toContain('margin-top: 12pt')
    expect(result).toContain('margin-bottom: 6pt')
  })

  it('混合对齐 + 间距的多段落', () => {
    const xml = `
      <p:txBody>
        <a:p>
          <a:pPr algn="ctr">
            <a:spcAft><a:spcPts val="800"/></a:spcAft>
          </a:pPr>
          <a:r><a:t>标题</a:t></a:r>
        </a:p>
        <a:p>
          <a:pPr algn="l"/>
          <a:r><a:t>正文内容</a:t></a:r>
        </a:p>
      </p:txBody>
    `
    const result = extractTextContent(xml)
    expect(result).toContain('<p style="text-align: center; margin-bottom: 8pt">标题</p>')
    expect(result).toContain('<p style="text-align: left">正文内容</p>')
  })

  it('空段落生成空 <p>（保留换行）', () => {
    const xml = `
      <p:txBody>
        <a:p><a:r><a:t>前文</a:t></a:r></a:p>
        <a:p></a:p>
        <a:p><a:r><a:t>后文</a:t></a:r></a:p>
      </p:txBody>
    `
    const result = extractTextContent(xml)
    expect(result).toBe('<p>前文</p><p></p><p>后文</p>')
  })

  it('多 run 同段落拼接', () => {
    const xml = `
      <p:txBody>
        <a:p>
          <a:r><a:t>Hello </a:t></a:r>
          <a:r><a:t>World</a:t></a:r>
        </a:p>
      </p:txBody>
    `
    expect(extractTextContent(xml)).toBe('<p>Hello World</p>')
  })

  it('无 <a:p> 时降级为单个 <p>（兼容旧行为）', () => {
    const xml = `<a:r><a:t>裸文本</a:t></a:r>`
    expect(extractTextContent(xml)).toBe('<p>裸文本</p>')
  })

  it('无任何文本返回空字符串', () => {
    const xml = `<p:txBody></p:txBody>`
    expect(extractTextContent(xml)).toBe('')
  })

  it('dist 对齐映射为 justify', () => {
    const xml = `
      <p:txBody>
        <a:p><a:pPr algn="dist"/><a:r><a:t>分散对齐</a:t></a:r></a:p>
      </p:txBody>
    `
    expect(extractTextContent(xml)).toContain('text-align: justify')
  })

  it('直接 <a:t>（无 <a:r> 包裹）也能提取', () => {
    const xml = `
      <p:txBody>
        <a:p><a:t>直接文本</a:t></a:p>
      </p:txBody>
    `
    expect(extractTextContent(xml)).toBe('<p>直接文本</p>')
  })
})
