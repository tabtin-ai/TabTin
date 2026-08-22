import { describe, expect, it } from 'vitest'
import { buildWidgetFileRefDragArtifacts } from '../widgetFileRefDrag'

describe('buildWidgetFileRefDragArtifacts', () => {
  it('完整 SVG code 优先于 image_url，保证文档与对话同源', () => {
    const result = buildWidgetFileRefDragArtifacts({
      imageUrl: 'https://cdn.example/widget.png',
      finalCode: '<svg viewBox="0 0 100 200"></svg>',
      format: 'svg',
      title: '架构图',
    })
    expect(result?.input).toMatchObject({
      name: '架构图.svg',
      mimeType: 'image/svg+xml',
      width: 100,
    })
    expect(result?.input.url).toMatch(/^data:image\/svg\+xml/)
    expect(result?.file).toBeInstanceOf(File)
  })

  it('SVG code 缺失时回退到 image_url', () => {
    const result = buildWidgetFileRefDragArtifacts({
      imageUrl: 'https://cdn.example/widget.png',
      format: 'svg',
      title: '架构图',
    })
    expect(result?.input).toMatchObject({
      url: 'https://cdn.example/widget.png',
      name: '架构图.png',
      mimeType: 'image/png',
    })
    expect(result?.file).toBeUndefined()
  })

  it('无烤图时用 SVG code 生成 File + data URL，并带展示宽度', () => {
    const svg = '<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'
    const result = buildWidgetFileRefDragArtifacts({
      finalCode: svg,
      format: 'svg',
      summary: 'flow',
    })
    expect(result?.file).toBeInstanceOf(File)
    expect(result?.file?.name).toBe('flow.svg')
    expect(result?.file?.type).toBe('image/svg+xml')
    expect(result?.input.url).toMatch(/^data:image\/svg\+xml/)
    expect(result?.input.mimeType).toBe('image/svg+xml')
    expect(result?.input.width).toBe(10)
    expect(result?.input.height).toBeUndefined()
  })

  it('百分比宽高的 SVG 按 viewBox 规范化后再拖', () => {
    const result = buildWidgetFileRefDragArtifacts({
      finalCode: '<svg width="100%" height="100%" viewBox="0 0 200 300"><rect/></svg>',
      format: 'svg',
      title: 's',
    })
    expect(result?.input.width).toBe(200)
    expect(decodeURIComponent(result!.input.url!.replace(/^data:image\/svg\+xml;charset=utf-8,/, ''))).toContain('width="200"')
  })

  it('HTML / 流式未完成 / 非 SVG mermaid 不可拖', () => {
    expect(buildWidgetFileRefDragArtifacts({
      finalCode: '<div>hi</div>',
      format: 'html',
      title: 'x',
    })).toBeNull()
    expect(buildWidgetFileRefDragArtifacts({
      format: 'svg',
      title: 'x',
    })).toBeNull()
    expect(buildWidgetFileRefDragArtifacts({
      finalCode: 'graph TD; A-->B',
      format: 'mermaid',
      title: 'x',
    })).toBeNull()
  })

  it('mermaid 已渲染成 SVG 时可拖', () => {
    const result = buildWidgetFileRefDragArtifacts({
      finalCode: '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
      format: 'mermaid',
      title: 'm',
    })
    expect(result?.file?.type).toBe('image/svg+xml')
  })
})
