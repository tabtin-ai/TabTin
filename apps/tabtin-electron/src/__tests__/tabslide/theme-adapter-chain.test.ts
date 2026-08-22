import { describe, expect, it } from 'vitest'
import { convertBackendToPresentation, convertPagesToBackend, type BackendProjectDetail } from '../../../../../packages/tabslide/src/exports/backend-adapter'
import { resolveBackgroundColor } from '../../../../../packages/tabslide/src/utils/background'

function makeBackendProject(
  theme?: Record<string, unknown>,
  background?: BackendProjectDetail['pages'][number]['background'],
): BackendProjectDetail {
  return {
    id: 'ppt-theme-1',
    name: 'theme-adapter',
    canvas_width: 1920,
    canvas_height: 1080,
    theme,
    pages: [
      {
        id: 'page-1',
        elements: [],
        background: background || {
          type: 'theme',
          theme: { key: 'accent3' },
        },
      },
    ],
  }
}

describe('TabSlide Theme Adapter Chain', () => {
  it('后端 theme JSON 应完整映射到前端 SlideTheme', () => {
    const presentation = convertBackendToPresentation(
      makeBackendProject({
        backgroundColor: '#101010',
        fontColor: '#f4f4f4',
        themeColors: ['#111111', '#222222', '#333333', '#444444', '#555555', '#666666'],
        fontName: 'Body Font',
        headingFontName: 'Heading Font',
      }),
    )

    expect(presentation.theme?.backgroundColor).toBe('#101010')
    expect(presentation.theme?.fontColor).toBe('#f4f4f4')
    expect(presentation.theme?.themeColors).toEqual([
      '#111111',
      '#222222',
      '#333333',
      '#444444',
      '#555555',
      '#666666',
    ])
    expect(presentation.theme?.fontName).toBe('Body Font')
    expect(presentation.theme?.headingFontName).toBe('Heading Font')
  })

  it('后端给出主题背景显式颜色时，前端应保持一致渲染', () => {
    const presentation = convertBackendToPresentation(
      makeBackendProject({
        backgroundColor: '#ffffff',
        fontColor: '#000000',
        themeColors: ['#ff0000', '#00ff00', '#123456', '#444444', '#555555', '#666666'],
        fontName: 'Body Font',
      }, {
        type: 'theme',
        value: '#123456',
        theme: { key: 'accent3', color: '#123456' },
      }),
    )

    const pageBg = presentation.pages[0]?.background
    const resolved = resolveBackgroundColor(pageBg, presentation.theme)
    expect(resolved.toLowerCase()).toBe('#123456')
  })

  it('shape/line/table 的主题色 token 在适配层应保留', () => {
    const presentation = convertBackendToPresentation({
      id: 'ppt-theme-token-1',
      name: 'theme-token',
      canvas_width: 1920,
      canvas_height: 1080,
      theme: {
        backgroundColor: '#ffffff',
        fontColor: '#000000',
        themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
        fontName: 'Body Font',
      },
      pages: [
        {
          id: 'page-1',
          background: { type: 'color', value: '#ffffff' },
          elements: [
            {
              id: 'shape-1',
              type: 'shape',
              x: 80,
              y: 80,
              width: 200,
              height: 100,
              zIndex: 0,
              props: {
                viewBox: [200, 100],
                path: 'M 0 0 L 200 0 L 200 100 L 0 100 Z',
                fill: '#4472C4',
                fillThemeKey: 'accent1',
                outline: { style: 'solid', width: 2, color: '#ED7D31', themeKey: 'accent2' },
              },
            },
            {
              id: 'line-1',
              type: 'line',
              x: 300,
              y: 120,
              width: 200,
              height: 80,
              zIndex: 1,
              props: {
                start: [0, 0],
                end: [200, 80],
                style: 'solid',
                color: '#A5A5A5',
                colorThemeKey: 'accent3',
                lineWidth: 2,
                points: ['', ''],
              },
            },
            {
              id: 'table-1',
              type: 'table',
              x: 80,
              y: 240,
              width: 300,
              height: 120,
              zIndex: 2,
              props: {
                data: [[{
                  text: 'cell',
                  colspan: 1,
                  rowspan: 1,
                  style: {
                    color: '#70AD47',
                    colorThemeKey: 'accent6',
                    bgColor: '#FFC000',
                    bgColorThemeKey: 'accent4',
                  },
                }]],
                colWidths: [1],
                cellMinHeight: 36,
                outline: { style: 'solid', width: 1, color: '#5B9BD5', themeKey: 'accent5' },
                theme: { color: '#5B9BD5', colorThemeKey: 'accent5', headerRow: true },
              },
            },
          ],
        },
      ],
    } as BackendProjectDetail)

    const page = presentation.pages[0]
    const shape = page.elements.find((el) => el.type === 'shape') as Extract<typeof page.elements[number], { type: 'shape' }>
    const line = page.elements.find((el) => el.type === 'line') as Extract<typeof page.elements[number], { type: 'line' }>
    const table = page.elements.find((el) => el.type === 'table') as Extract<typeof page.elements[number], { type: 'table' }>

    expect(shape.fillThemeKey).toBe('accent1')
    expect(shape.outline?.themeKey).toBe('accent2')
    expect(line.colorThemeKey).toBe('accent3')
    expect(table.outline?.themeKey).toBe('accent5')
    expect(table.theme?.colorThemeKey).toBe('accent5')
    expect(table.data[0][0].style?.colorThemeKey).toBe('accent6')
    expect(table.data[0][0].style?.bgColorThemeKey).toBe('accent4')
  })

  it('chart 的主题色 token 在适配层应按索引保留', () => {
    const presentation = convertBackendToPresentation({
      id: 'ppt-theme-chart-token-1',
      name: 'theme-chart-token',
      canvas_width: 1920,
      canvas_height: 1080,
      theme: {
        backgroundColor: '#ffffff',
        fontColor: '#000000',
        themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
        fontName: 'Body Font',
      },
      pages: [
        {
          id: 'page-1',
          background: { type: 'color', value: '#ffffff' },
          elements: [
            {
              id: 'chart-1',
              type: 'chart',
              x: 80,
              y: 80,
              width: 900,
              height: 500,
              zIndex: 0,
              props: {
                chartType: 'bar',
                data: {
                  labels: ['Q1', 'Q2', 'Q3'],
                  legends: ['A', 'B', 'C'],
                  series: [[10, 20, 30], [12, 22, 32], [8, 18, 28]],
                },
                themeColors: ['#4472C4', '#ED7D31', '#A5A5A5'],
                themeColorKeys: ['accent1', null, 'accent3'],
              },
            },
          ],
        },
      ],
    } as BackendProjectDetail)

    const page = presentation.pages[0]
    const chart = page.elements.find((el) => el.type === 'chart') as Extract<typeof page.elements[number], { type: 'chart' }>
    expect(chart.themeColors).toEqual(['#4472C4', '#ED7D31', '#A5A5A5'])
    expect(chart.themeColorKeys).toEqual(['accent1', null, 'accent3'])
  })

  it('chart 颜色与主题 key 不一致时，导出应仅清理不匹配 key 并保留索引对齐', () => {
    const pages = [{
      id: 'page-1',
      background: { type: 'solid', color: '#ffffff' } as const,
      elements: [
        {
          id: 'chart-1',
          type: 'chart',
          x: 80,
          y: 80,
          width: 900,
          height: 500,
          rotate: 0,
          opacity: 1,
          locked: false,
          chartType: 'bar' as const,
          data: {
            labels: ['Q1', 'Q2', 'Q3'],
            legends: ['A', 'B', 'C'],
            series: [[10, 20, 30], [12, 22, 32], [8, 18, 28]],
          },
          themeColors: ['#4472C4', '#123456', '#A5A5A5'],
          themeColorKeys: ['accent1', 'accent2', 'accent3'],
        },
      ],
    }]

    const backendPages = convertPagesToBackend(
      pages as any,
      {
        backgroundColor: '#ffffff',
        fontColor: '#000000',
        themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
        fontName: 'Body Font',
      },
    )

    const beChart = backendPages[0].elements[0]
    const beProps = beChart.props as Record<string, unknown>
    expect(beProps.themeColors).toEqual(['#4472C4', '#123456', '#A5A5A5'])
    expect(beProps.themeColorKeys).toEqual(['accent1', null, 'accent3'])
  })

  it('前端颜色与主题 key 不一致时，保存到后端应自动清理陈旧 key', () => {
    const pages = [{
      id: 'page-1',
      background: { type: 'solid', color: '#ffffff' } as const,
      elements: [
        {
          id: 'shape-1',
          type: 'shape',
          x: 80,
          y: 80,
          width: 200,
          height: 100,
          rotate: 0,
          opacity: 1,
          locked: false,
          viewBox: [200, 100] as [number, number],
          path: 'M 0 0 L 200 0 L 200 100 L 0 100 Z',
          fixedRatio: false,
          fill: '#ff0000',
          fillThemeKey: 'accent1',
          outline: { style: 'solid' as const, width: 1, color: '#00ff00', themeKey: 'accent2' },
        },
      ],
    }]

    const backendPages = convertPagesToBackend(
      pages as any,
      {
        backgroundColor: '#ffffff',
        fontColor: '#000000',
        themeColors: ['#4472C4', '#ED7D31', '#A5A5A5', '#FFC000', '#5B9BD5', '#70AD47'],
        fontName: 'Body Font',
      },
    )

    const beShape = backendPages[0].elements[0]
    expect((beShape.props as Record<string, unknown>).fillThemeKey).toBeUndefined()
    expect(((beShape.props as Record<string, unknown>).outline as Record<string, unknown>).themeKey).toBeUndefined()
  })
})
