/**
 * 回归测试 — DF-08 / DF-09
 *
 * DF-08: TableCellStyle.fontFamily → fontName 统一
 *   - 读取时兼容旧的 fontFamily 字段
 *   - 写入时同时输出 fontName 和 fontFamily（双写兼容）
 *   - 新数据仅使用 fontName
 *
 * DF-09: ChartType bar/column 命名与业界相反
 *   - 注释修正，不改变运行时行为
 *   - 类型系统保持 bar/column 枚举值
 */
import { describe, it, expect } from 'vitest'
import { convertBackendPage, convertPagesToBackend } from '../backend-adapter'
import type { BackendSlidePage } from '../backend-adapter'
import type { Slide, PPTTableElement, PPTChartElement, ChartType, TableCellStyle } from '../../types/slides'

// ═══════════════════════════════════════════════
// DF-08: fontFamily → fontName 向后兼容
// ═══════════════════════════════════════════════

describe('DF-08: TableCellStyle fontName / fontFamily 兼容', () => {
  const makeBackendTablePage = (cellStyle: Record<string, unknown>): BackendSlidePage => ({
    id: 'page-1',
    elements: [{
      id: 'table-1',
      type: 'table',
      x: 0,
      y: 0,
      width: 400,
      height: 200,
      rotate: 0,
      zIndex: 0,
      props: {
        data: [[{
          id: 'cell-1',
          text: 'hello',
          colspan: 1,
          rowspan: 1,
          style: cellStyle,
        }]],
        colWidths: [1],
        cellMinHeight: 36,
        outline: { style: 'solid', width: 1, color: '#d0d0d0' },
      },
    }],
    background: { type: 'color', value: '#ffffff' },
  })

  it('读取旧数据：fontFamily 应迁移到 fontName', () => {
    const page = convertBackendPage(makeBackendTablePage({ fontFamily: 'Arial' }))
    const table = page.elements[0] as PPTTableElement
    const style = table.data[0][0].style!

    expect(style.fontName).toBe('Arial')
  })

  it('读取新数据：fontName 优先于 fontFamily', () => {
    const page = convertBackendPage(makeBackendTablePage({
      fontName: 'Inter',
      fontFamily: 'Arial',
    }))
    const table = page.elements[0] as PPTTableElement
    const style = table.data[0][0].style!

    expect(style.fontName).toBe('Inter')
  })

  it('读取新数据：仅 fontName 正常工作', () => {
    const page = convertBackendPage(makeBackendTablePage({ fontName: 'PingFang SC' }))
    const table = page.elements[0] as PPTTableElement
    const style = table.data[0][0].style!

    expect(style.fontName).toBe('PingFang SC')
  })

  it('读取无字体数据：fontName 为 undefined', () => {
    const page = convertBackendPage(makeBackendTablePage({ bold: true }))
    const table = page.elements[0] as PPTTableElement
    const style = table.data[0][0].style

    expect(style?.fontName).toBeUndefined()
    expect(style?.fontFamily).toBeUndefined()
  })

  it('写入时双写 fontName 和 fontFamily', () => {
    const tableEl: PPTTableElement = {
      id: 'table-1',
      type: 'table',
      x: 0, y: 0, width: 400, height: 200,
      rotate: 0, opacity: 1, locked: false,
      data: [[{
        id: 'cell-1',
        text: 'hello',
        colspan: 1,
        rowspan: 1,
        style: { fontName: 'Inter' },
      }]],
      colWidths: [1],
      cellMinHeight: 36,
      outline: { style: 'solid', width: 1, color: '#d0d0d0' },
    }
    const slide: Slide = { id: 'page-1', elements: [tableEl] }

    const [backendPage] = convertPagesToBackend([slide])
    const backendTableProps = backendPage.elements[0]?.props as Record<string, unknown>
    const backendData = backendTableProps?.data as Record<string, unknown>[][]
    const cellFlat = backendData[0][0] as Record<string, unknown>

    expect(cellFlat.fontName).toBe('Inter')
    expect(cellFlat.fontFamily).toBe('Inter')
  })

  it('写入时旧 fontFamily 也迁移为双写', () => {
    const tableEl: PPTTableElement = {
      id: 'table-1',
      type: 'table',
      x: 0, y: 0, width: 400, height: 200,
      rotate: 0, opacity: 1, locked: false,
      data: [[{
        id: 'cell-1',
        text: 'hello',
        colspan: 1,
        rowspan: 1,
        style: { fontFamily: 'Arial' } as TableCellStyle,
      }]],
      colWidths: [1],
      cellMinHeight: 36,
      outline: { style: 'solid', width: 1, color: '#d0d0d0' },
    }
    const slide: Slide = { id: 'page-1', elements: [tableEl] }

    const [backendPage] = convertPagesToBackend([slide])
    const backendTableProps = backendPage.elements[0]?.props as Record<string, unknown>
    const backendData = backendTableProps?.data as Record<string, unknown>[][]
    const cellFlat = backendData[0][0] as Record<string, unknown>

    expect(cellFlat.fontName).toBe('Arial')
    expect(cellFlat.fontFamily).toBe('Arial')
  })

  it('往返一致性：fontName 写入 → 读取保持', () => {
    const tableEl: PPTTableElement = {
      id: 'table-1',
      type: 'table',
      x: 0, y: 0, width: 400, height: 200,
      rotate: 0, opacity: 1, locked: false,
      data: [[{
        id: 'cell-1',
        text: 'roundtrip',
        colspan: 1,
        rowspan: 1,
        style: { fontName: 'Noto Sans SC', fontSize: 14, bold: true },
      }]],
      colWidths: [1],
      cellMinHeight: 36,
      outline: { style: 'solid', width: 1, color: '#d0d0d0' },
    }
    const slide: Slide = { id: 'page-1', elements: [tableEl] }

    const [backendPage] = convertPagesToBackend([slide])
    const restored = convertBackendPage(backendPage)
    const restoredTable = restored.elements[0] as PPTTableElement
    const restoredStyle = restoredTable.data[0][0].style!

    expect(restoredStyle.fontName).toBe('Noto Sans SC')
    expect(restoredStyle.fontSize).toBe(14)
    expect(restoredStyle.bold).toBe(true)
  })

  it('无字体时不写入 fontName/fontFamily', () => {
    const tableEl: PPTTableElement = {
      id: 'table-1',
      type: 'table',
      x: 0, y: 0, width: 400, height: 200,
      rotate: 0, opacity: 1, locked: false,
      data: [[{
        id: 'cell-1',
        text: 'no-font',
        colspan: 1,
        rowspan: 1,
        style: { bold: true },
      }]],
      colWidths: [1],
      cellMinHeight: 36,
      outline: { style: 'solid', width: 1, color: '#d0d0d0' },
    }
    const slide: Slide = { id: 'page-1', elements: [tableEl] }

    const [backendPage] = convertPagesToBackend([slide])
    const backendTableProps = backendPage.elements[0]?.props as Record<string, unknown>
    const backendData = backendTableProps?.data as Record<string, unknown>[][]
    const cellFlat = backendData[0][0] as Record<string, unknown>

    expect(cellFlat.fontName).toBeUndefined()
    expect(cellFlat.fontFamily).toBeUndefined()
  })
})

// ═══════════════════════════════════════════════
// DF-09: ChartType bar/column 运行时行为不变
// ═══════════════════════════════════════════════

describe('DF-09: ChartType bar/column 枚举值运行时行为不变', () => {
  it('bar 类型正常序列化和反序列化', () => {
    const chartEl: PPTChartElement = {
      id: 'chart-1',
      type: 'chart',
      x: 0, y: 0, width: 400, height: 300,
      rotate: 0, opacity: 1, locked: false,
      chartType: 'bar',
      data: { labels: ['A', 'B'], legends: ['S1'], series: [[1, 2]] },
      themeColors: ['#4F46E5'],
    }
    const slide: Slide = { id: 'page-1', elements: [chartEl] }

    const [backendPage] = convertPagesToBackend([slide])
    const restored = convertBackendPage(backendPage)
    const restoredChart = restored.elements[0] as PPTChartElement

    expect(restoredChart.chartType).toBe('bar')
  })

  it('column 类型正常序列化和反序列化', () => {
    const chartEl: PPTChartElement = {
      id: 'chart-2',
      type: 'chart',
      x: 0, y: 0, width: 400, height: 300,
      rotate: 0, opacity: 1, locked: false,
      chartType: 'column',
      data: { labels: ['X', 'Y'], legends: ['S1'], series: [[3, 4]] },
      themeColors: ['#4F46E5'],
    }
    const slide: Slide = { id: 'page-1', elements: [chartEl] }

    const [backendPage] = convertPagesToBackend([slide])
    const restored = convertBackendPage(backendPage)
    const restoredChart = restored.elements[0] as PPTChartElement

    expect(restoredChart.chartType).toBe('column')
  })

  it('所有 ChartType 值应被类型系统接受', () => {
    const allTypes: ChartType[] = ['bar', 'column', 'line', 'area', 'pie', 'ring', 'radar', 'scatter']
    for (const ct of allTypes) {
      const chartEl: PPTChartElement = {
        id: `chart-${ct}`,
        type: 'chart',
        x: 0, y: 0, width: 400, height: 300,
        rotate: 0, opacity: 1, locked: false,
        chartType: ct,
        data: { labels: ['A'], legends: ['S1'], series: [[1]] },
        themeColors: [],
      }
      expect(chartEl.chartType).toBe(ct)
    }
  })

  it('未知 chartType 应降级为 bar', () => {
    const page: BackendSlidePage = {
      id: 'page-1',
      elements: [{
        id: 'chart-unknown',
        type: 'chart',
        x: 0, y: 0, width: 400, height: 300,
        rotate: 0, zIndex: 0,
        props: {
          chartType: 'unknown_type',
          data: { labels: ['A'], legends: ['S1'], series: [[1]] },
          themeColors: [],
        },
      }],
      background: { type: 'color', value: '#ffffff' },
    }
    const restored = convertBackendPage(page)
    const chart = restored.elements[0] as PPTChartElement

    expect(chart.chartType).toBe('bar')
  })
})
