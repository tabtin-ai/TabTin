import { describe, expect, it } from 'vitest'
import JSZip from '../../../../../packages/tabslide/node_modules/jszip'
import { exportToPPTXBlob } from '../../../../../packages/tabslide/src/exports/pptx'
import { postProcessPptxBlob } from '../../../../../packages/tabslide/src/exports/pptx-postprocess'
import type { SlidePresentation } from '../../../../../packages/tabslide/src/types/slides'

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main'
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main'

function buildMinimalSlideXml(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:cSld>
    <p:spTree>
      <p:nvGrpSpPr>
        <p:cNvPr id="1" name=""/>
        <p:cNvGrpSpPr/>
        <p:nvPr/>
      </p:nvGrpSpPr>
      <p:grpSpPr>
        <a:xfrm>
          <a:off x="0" y="0"/>
          <a:ext cx="0" cy="0"/>
          <a:chOff x="0" y="0"/>
          <a:chExt cx="0" cy="0"/>
        </a:xfrm>
      </p:grpSpPr>
      <p:sp>
        <p:nvSpPr>
          <p:cNvPr id="2" name="Shape 1"/>
          <p:cNvSpPr/>
          <p:nvPr/>
        </p:nvSpPr>
        <p:spPr>
          <a:xfrm>
            <a:off x="914400" y="914400"/>
            <a:ext cx="1828800" cy="914400"/>
          </a:xfrm>
          <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
          <a:solidFill><a:srgbClr val="FF0000"/></a:solidFill>
        </p:spPr>
      </p:sp>
    </p:spTree>
  </p:cSld>
</p:sld>`
}

describe('TabSlide Shape Export Chain', () => {
  it('postProcessPptxBlob 应在渐变注入时保留元素 opacity', async () => {
    const zip = new JSZip()
    zip.file('ppt/slides/slide1.xml', buildMinimalSlideXml())
    const rawBlob = await zip.generateAsync({ type: 'blob' })

    const presentation: SlidePresentation = {
      id: 'pres-1',
      name: 'shape-opacity',
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
              id: 'shape-1',
              type: 'shape',
              x: 96,
              y: 96,
              width: 192,
              height: 96,
              rotate: 0,
              opacity: 0.5,
              locked: false,
              fill: '#ff0000',
              fixedRatio: false,
              viewBox: [192, 96],
              path: 'M 0 0 L 192 0 L 192 96 L 0 96 Z',
              gradient: {
                type: 'linear',
                rotate: 30,
                colors: [
                  { pos: 0, color: '#ff0000' },
                  { pos: 1, color: 'rgba(0,0,255,0.4)' },
                ],
              },
            },
          ],
        },
      ],
    }

    const patched = await postProcessPptxBlob(rawBlob, presentation)
    const outZip = await JSZip.loadAsync(patched)
    const outXml = await outZip.file('ppt/slides/slide1.xml')?.async('string')
    expect(outXml).toBeTruthy()
    if (!outXml) return

    const doc = new DOMParser().parseFromString(outXml, 'application/xml')
    const gradFill = doc.getElementsByTagNameNS(NS_A, 'gradFill')[0]
    expect(gradFill).toBeTruthy()
    const solidFill = doc.getElementsByTagNameNS(NS_A, 'solidFill')[0]
    expect(solidFill).toBeFalsy()

    const stops = Array.from(doc.getElementsByTagNameNS(NS_A, 'gs'))
    expect(stops.length).toBeGreaterThanOrEqual(2)

    const firstAlpha = stops[0]?.getElementsByTagNameNS(NS_A, 'alpha')[0]?.getAttribute('val')
    const secondAlpha = stops[1]?.getElementsByTagNameNS(NS_A, 'alpha')[0]?.getAttribute('val')

    // 第一段无原始 alpha，叠乘元素 opacity=0.5 后应写入 50000。
    expect(firstAlpha).toBe('50000')
    // 第二段原始 alpha=0.4，叠乘 0.5 后应为 0.2 -> 20000。
    expect(secondAlpha).toBe('20000')
  })

  it('roundRect 四角不一致应导出为 custGeom，一致时应导出为 roundRect 预设', async () => {
    const presentation: SlidePresentation = {
      id: 'pres-roundrect-corners',
      name: 'roundrect-corners',
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
              id: 'shape-non-uniform',
              type: 'shape',
              x: 120,
              y: 120,
              width: 320,
              height: 180,
              rotate: 0,
              opacity: 1,
              locked: false,
              fill: '#3b82f6',
              fixedRatio: false,
              viewBox: [320, 180],
              path: 'M 18 0 L 300 0 Q 320 0 320 18 L 320 162 Q 320 180 302 180 L 20 180 Q 0 180 0 162 L 0 18 Q 0 0 18 0 Z',
              pathFormula: 'roundRect',
              pptxShapeType: 'roundRect',
              keypoints: [0.2, 0.05, 0.3, 0.1],
            },
            {
              id: 'shape-uniform',
              type: 'shape',
              x: 520,
              y: 120,
              width: 320,
              height: 180,
              rotate: 0,
              opacity: 1,
              locked: false,
              fill: '#10b981',
              fixedRatio: false,
              viewBox: [320, 180],
              path: 'M 18 0 L 302 0 Q 320 0 320 18 L 320 162 Q 320 180 302 180 L 18 180 Q 0 180 0 162 L 0 18 Q 0 0 18 0 Z',
              pathFormula: 'roundRect',
              pptxShapeType: 'roundRect',
              keypoints: [0.2, 0.2, 0.2, 0.2],
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
    const shapes = Array.from(doc.getElementsByTagNameNS(NS_P, 'sp'))
    expect(shapes.length).toBeGreaterThanOrEqual(2)

    const firstSpPr = shapes[0]?.getElementsByTagNameNS(NS_P, 'spPr')[0]
    const secondSpPr = shapes[1]?.getElementsByTagNameNS(NS_P, 'spPr')[0]
    expect(firstSpPr).toBeTruthy()
    expect(secondSpPr).toBeTruthy()
    if (!firstSpPr || !secondSpPr) return

    expect(firstSpPr.getElementsByTagNameNS(NS_A, 'custGeom').length).toBeGreaterThan(0)
    expect(secondSpPr.getElementsByTagNameNS(NS_A, 'prstGeom').length).toBeGreaterThan(0)
    const secondPrst = secondSpPr.getElementsByTagNameNS(NS_A, 'prstGeom')[0]
    expect(secondPrst?.getAttribute('prst')).toBe('roundRect')
  })

  it('形状填充与描边应保留独立透明度（fill/outline alpha 分离）', async () => {
    const presentation: SlidePresentation = {
      id: 'pres-alpha-separate',
      name: 'alpha-separate',
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
              id: 'shape-alpha',
              type: 'shape',
              x: 120,
              y: 120,
              width: 320,
              height: 180,
              rotate: 0,
              opacity: 1,
              locked: false,
              fill: 'rgba(74,109,140,0.35)',
              fixedRatio: false,
              viewBox: [320, 180],
              path: 'M 0 0 L 320 0 L 320 180 L 0 180 Z',
              pptxShapeType: 'rect',
              outline: {
                style: 'solid',
                width: 2,
                color: 'rgba(74,109,140,0.8)',
              },
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
    const sp = doc.getElementsByTagNameNS(NS_P, 'sp')[0]
    expect(sp).toBeTruthy()
    if (!sp) return

    const fillAlpha = sp
      .getElementsByTagNameNS(NS_A, 'solidFill')[0]
      ?.getElementsByTagNameNS(NS_A, 'alpha')[0]
      ?.getAttribute('val')

    const lineAlpha = sp
      .getElementsByTagNameNS(NS_A, 'ln')[0]
      ?.getElementsByTagNameNS(NS_A, 'alpha')[0]
      ?.getAttribute('val')

    expect(fillAlpha).toBe('35000')
    expect(lineAlpha).toBe('80000')
  })
})
