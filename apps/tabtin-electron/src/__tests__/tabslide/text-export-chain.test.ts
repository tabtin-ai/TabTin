import { describe, expect, it } from 'vitest'
import JSZip from '../../../../../packages/tabslide/node_modules/jszip'
import { exportToPPTXBlob } from '../../../../../packages/tabslide/src/exports/pptx'
import type { SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'
const NS_RELS = 'http://schemas.openxmlformats.org/package/2006/relationships'

describe('TabSlide Text Export Chain', () => {
  it('paragraphSpace 作为元素级属性时，导出应回写段后间距', async () => {
    const presentation: SlidePresentation = {
      id: 'pres-text-1',
      name: 'text-para-space',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [
        {
          id: 'slide-1',
          background: { type: 'solid', color: '#ffffff' },
          remark: '',
          elements: [
            {
              id: 'text-1',
              type: 'text',
              x: 120,
              y: 120,
              width: 720,
              height: 280,
              rotate: 0,
              opacity: 1,
              locked: false,
              content: '<p>第一段</p><p>第二段</p>',
              defaultFontName: 'Microsoft YaHei',
              defaultFontSize: 18,
              defaultColor: '#333333',
              paragraphSpace: 6.25,
            },
          ],
        },
      ],
    }

    const blob = await exportToPPTXBlob(presentation)
    const zip = await JSZip.loadAsync(blob)
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string')
    expect(slideXml).toBeTruthy()
    if (!slideXml) return

    const doc = new DOMParser().parseFromString(slideXml, 'application/xml')
    const pPrNodes = Array.from(doc.getElementsByTagNameNS(NS_A, 'pPr'))
    expect(pPrNodes.length).toBeGreaterThan(0)

    const paraSpaceAfterVals = pPrNodes
      .map((pPr) => pPr.getElementsByTagNameNS(NS_A, 'spcAft')[0])
      .filter(Boolean)
      .map((spcAft) => spcAft.getElementsByTagNameNS(NS_A, 'spcPts')[0]?.getAttribute('val'))
      .filter((val): val is string => !!val)

    // 6.25pt -> 625 (OOXML 单位为 1/100 pt)
    expect(paraSpaceAfterVals).toContain('625')
  })

  it('defaultColorThemeKey 导出时应写入 schemeClr 主题色', async () => {
    const presentation: SlidePresentation = {
      id: 'pres-text-theme-1',
      name: 'text-theme-color',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [
        {
          id: 'slide-1',
          background: { type: 'solid', color: '#ffffff' },
          remark: '',
          elements: [
            {
              id: 'text-theme-1',
              type: 'text',
              x: 120,
              y: 120,
              width: 720,
              height: 220,
              rotate: 0,
              opacity: 1,
              locked: false,
              content: '<p>主题色文本</p>',
              defaultFontName: 'Microsoft YaHei',
              defaultFontSize: 18,
              defaultColor: '#4472C4',
              defaultColorThemeKey: 'accent1',
            },
          ],
        },
      ],
    }

    const blob = await exportToPPTXBlob(presentation)
    const zip = await JSZip.loadAsync(blob)
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string')
    expect(slideXml).toBeTruthy()
    if (!slideXml) return

    const doc = new DOMParser().parseFromString(slideXml, 'application/xml')
    const schemeNodes = Array.from(doc.getElementsByTagNameNS(NS_A, 'schemeClr'))
    const schemeVals = schemeNodes
      .map((node) => (node.getAttribute('val') || '').toLowerCase())
      .filter(Boolean)

    expect(schemeVals).toContain('accent1')
  })

  it('文本内 #page-N 链接导出应写入 slide 内部跳转关系', async () => {
    const presentation: SlidePresentation = {
      id: 'pres-text-slide-link-1',
      name: 'text-slide-link',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [
        {
          id: 'slide-1',
          background: { type: 'solid', color: '#ffffff' },
          remark: '',
          elements: [
            {
              id: 'text-slide-link-1',
              type: 'text',
              x: 120,
              y: 120,
              width: 720,
              height: 220,
              rotate: 0,
              opacity: 1,
              locked: false,
              content: '<p><a href="#page-2">跳转到下一页</a></p>',
              defaultFontName: 'Microsoft YaHei',
              defaultFontSize: 18,
              defaultColor: '#333333',
            },
          ],
        },
        {
          id: 'slide-2',
          background: { type: 'solid', color: '#ffffff' },
          remark: '',
          elements: [],
        },
      ],
    }

    const blob = await exportToPPTXBlob(presentation)
    const zip = await JSZip.loadAsync(blob)
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string')
    const relsXml = await zip.file('ppt/slides/_rels/slide1.xml.rels')?.async('string')
    expect(slideXml).toBeTruthy()
    expect(relsXml).toBeTruthy()
    if (!slideXml || !relsXml) return

    const slideDoc = new DOMParser().parseFromString(slideXml, 'application/xml')
    const hlinkNodes = Array.from(slideDoc.getElementsByTagNameNS(NS_A, 'hlinkClick'))
    expect(hlinkNodes.length).toBeGreaterThan(0)
    const rid = hlinkNodes[0]?.getAttributeNS(NS_R, 'id') || hlinkNodes[0]?.getAttribute('r:id')
    expect(rid).toBeTruthy()
    if (!rid) return

    const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml')
    const relNodes = Array.from(relsDoc.getElementsByTagNameNS(NS_RELS, 'Relationship'))
    const targetRel = relNodes.find((node) => node.getAttribute('Id') === rid)
    expect(targetRel).toBeTruthy()
    expect(targetRel?.getAttribute('Type') || '').toContain('/slide')
    expect((targetRel?.getAttribute('Target') || '').toLowerCase()).toContain('slide2.xml')
  })

  it('表格 richText 内 #page-N 链接导出应写入 slide 内部跳转关系', async () => {
    const presentation: SlidePresentation = {
      id: 'pres-table-slide-link-1',
      name: 'table-slide-link',
      preset: '16:9',
      canvasWidth: 1920,
      canvasHeight: 1080,
      pages: [
        {
          id: 'slide-1',
          background: { type: 'solid', color: '#ffffff' },
          remark: '',
          elements: [
            {
              id: 'table-slide-link-1',
              type: 'table',
              x: 120,
              y: 200,
              width: 700,
              height: 220,
              rotate: 0,
              opacity: 1,
              locked: false,
              data: [[{
                id: 'c11',
                text: '跳转',
                richText: '<p><a href="#page-2">跳转</a></p>',
                colspan: 1,
                rowspan: 1,
              }]],
              colWidths: [1],
              cellMinHeight: 28,
              outline: { style: 'solid', width: 1, color: '#000000' },
            },
          ],
        },
        {
          id: 'slide-2',
          background: { type: 'solid', color: '#ffffff' },
          remark: '',
          elements: [],
        },
      ],
    }

    const blob = await exportToPPTXBlob(presentation)
    const zip = await JSZip.loadAsync(blob)
    const slideXml = await zip.file('ppt/slides/slide1.xml')?.async('string')
    const relsXml = await zip.file('ppt/slides/_rels/slide1.xml.rels')?.async('string')
    expect(slideXml).toBeTruthy()
    expect(relsXml).toBeTruthy()
    if (!slideXml || !relsXml) return

    const slideDoc = new DOMParser().parseFromString(slideXml, 'application/xml')
    const hlinkNodes = Array.from(slideDoc.getElementsByTagNameNS(NS_A, 'hlinkClick'))
    expect(hlinkNodes.length).toBeGreaterThan(0)
    const rid = hlinkNodes[0]?.getAttributeNS(NS_R, 'id') || hlinkNodes[0]?.getAttribute('r:id')
    expect(rid).toBeTruthy()
    if (!rid) return

    const relsDoc = new DOMParser().parseFromString(relsXml, 'application/xml')
    const relNodes = Array.from(relsDoc.getElementsByTagNameNS(NS_RELS, 'Relationship'))
    const targetRel = relNodes.find((node) => node.getAttribute('Id') === rid)
    expect(targetRel).toBeTruthy()
    expect(targetRel?.getAttribute('Type') || '').toContain('/slide')
    expect((targetRel?.getAttribute('Target') || '').toLowerCase()).toContain('slide2.xml')
  })
})
