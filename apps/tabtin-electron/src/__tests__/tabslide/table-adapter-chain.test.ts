import { describe, expect, it } from 'vitest'
import {
  convertBackendPage,
  convertPagesToBackend,
} from '../../../../../packages/tabslide/src/exports/backend-adapter'
import type { PPTTableElement, Slide } from '../../../../../packages/tabslide/src/types/slides'

describe('TabSlide Table Adapter Chain', () => {
  it('convertBackendPage 应保留部分 colWidths 权重并规范化 theme 布尔字段', () => {
    const page = convertBackendPage({
      id: 'table-page-1',
      elements: [
        {
          id: 'tbl-1',
          type: 'table',
          x: 100,
          y: 120,
          width: 600,
          height: 240,
          zIndex: 0,
          props: {
            data: [[
              {
                text: 'A1',
                colspan: '1',
                rowspan: '1',
                style: {
                  bold: '1',
                  fontSize: '16',
                  align: 'center',
                  verticalAlign: 'middle',
                },
              },
              { text: '', colspan: '0', rowspan: '0' },
              { text: 'C1', colspan: 1, rowspan: 1 },
            ]],
            colWidths: [2, 1], // 第 3 列缺失时应补默认权重 1
            rowHeights: [60], // 会按元素高度归一到 240
            borders: {
              top: { style: 'dashed', width: '2', color: '#111111' },
              insideV: { style: 'solid', width: 0, color: '#222222' },
            },
            theme: {
              color: '#123456',
              headerRow: 'false',
              stripedRows: '1',
              lastCol: 'true',
            },
          },
        },
      ],
      background: { type: 'color', value: '#ffffff' },
      notes: '',
    })

    const table = page.elements[0] as PPTTableElement
    expect(table.type).toBe('table')
    expect(table.colWidths).toEqual([0.5, 0.25, 0.25])
    expect(table.rowHeights).toEqual([240])
    expect(table.borders).toEqual({
      top: { style: 'dashed', width: 2, color: '#111111' },
      insideV: { style: 'solid', width: 0, color: '#222222' },
    })
    expect(table.data[0]?.[0]?.colspan).toBe(1)
    expect(table.data[0]?.[0]?.rowspan).toBe(1)
    expect(table.data[0]?.[1]?.colspan).toBe(0)
    expect(table.data[0]?.[1]?.rowspan).toBe(0)
    expect(table.data[0]?.[0]?.style?.bold).toBe(true)
    expect(table.data[0]?.[0]?.style?.fontSize).toBe(16)
    expect(table.data[0]?.[0]?.style?.align).toBe('center')
    expect(table.theme).toEqual({
      color: '#123456',
      stripedRows: true,
      lastCol: true,
    })
  })

  it('B6-01/B6-02 回归: convertBackendPage 应保留 cellBgColor 和 verticalAlign', () => {
    const page = convertBackendPage({
      id: 'table-cellstyle-page',
      elements: [
        {
          id: 'tbl-cellstyle',
          type: 'table',
          x: 100,
          y: 120,
          width: 400,
          height: 200,
          zIndex: 0,
          props: {
            data: [[
              {
                text: 'Styled',
                colspan: '1',
                rowspan: '1',
                style: {
                  bgColor: '#ffcc00',
                  verticalAlign: 'bottom',
                  bold: '1',
                },
              },
              {
                text: 'Default',
                colspan: '1',
                rowspan: '1',
                style: {},
              },
            ]],
            colWidths: [1, 1],
            rowHeights: [200],
          },
        },
      ],
      background: { type: 'color', value: '#ffffff' },
      notes: '',
    })

    const table = page.elements[0] as PPTTableElement
    expect(table.data[0]?.[0]?.style?.bgColor).toBe('#ffcc00')
    expect(table.data[0]?.[0]?.style?.verticalAlign).toBe('bottom')
    expect(table.data[0]?.[0]?.style?.bold).toBe(true)
    expect(table.data[0]?.[1]?.style?.bgColor).toBeUndefined()
    expect(table.data[0]?.[1]?.style?.verticalAlign).toBeUndefined()
  })

  it('B6-01/B6-02 回归: convertPagesToBackend 应保留 cellBgColor 和 verticalAlign', () => {
    const table = {
      id: 'table-cellstyle-save',
      type: 'table',
      x: 100,
      y: 100,
      width: 400,
      height: 200,
      rotate: 0,
      opacity: 1,
      locked: false,
      data: [
        [
          {
            id: 'c11',
            text: 'Styled',
            colspan: 1,
            rowspan: 1,
            style: { bgColor: '#ff0000', verticalAlign: 'middle' as const },
          },
          { id: 'c12', text: 'Plain', colspan: 1, rowspan: 1 },
        ],
      ],
      colWidths: [0.5, 0.5],
      rowHeights: [200],
      cellMinHeight: 36,
    } as unknown as PPTTableElement

    const page: Slide = {
      id: 'cellstyle-page',
      elements: [table],
      background: { type: 'solid', color: '#ffffff' },
      remark: '',
    }

    const backendPages = convertPagesToBackend([page])
    const backendTable = backendPages[0]?.elements[0]
    const props = backendTable?.props as Record<string, unknown>
    const data = props.data as Array<Array<Record<string, unknown>>>
    const cellStyle = data[0]?.[0]?.style as Record<string, unknown> | undefined
    expect(cellStyle?.bgColor).toBe('#ff0000')
    expect(cellStyle?.verticalAlign).toBe('middle')
  })

  it('convertPagesToBackend 应规范化 table 的 colWidths/cellMinHeight/outline', () => {
    const table = {
      id: 'table-save-1',
      type: 'table',
      x: 100,
      y: 100,
      width: 600,
      height: 300,
      rotate: 0,
      opacity: 1,
      locked: false,
      data: [
        [
          { id: 'c11', text: 'A1', colspan: 1, rowspan: 1 },
          { id: 'c12', text: 'B1', colspan: 1, rowspan: 1 },
          { id: 'c13', text: 'C1', colspan: 1, rowspan: 1 },
        ],
        [
          { id: 'c21', text: 'A2', colspan: 1, rowspan: 1 },
          { id: 'c22', text: 'B2', colspan: 1, rowspan: 1 },
          { id: 'c23', text: 'C2', colspan: 1, rowspan: 1 },
        ],
      ],
      colWidths: [2, 1], // 第 3 列缺失
      rowHeights: [100, 50], // 归一到总高度 300 -> [200, 100]
      cellMinHeight: Number.NaN,
      outline: {
        style: 'solid',
        width: '2.5' as unknown as number,
        color: '  #ff0000  ',
      },
      borders: {
        top: { style: 'dotted', width: '3' as unknown as number, color: ' #010203 ' },
        insideH: { style: 'solid', width: 0, color: '#040506' },
      },
      theme: { color: '#5b9bd5', headerRow: true },
    } as unknown as PPTTableElement

    const page: Slide = {
      id: 'table-save-page',
      elements: [table],
      background: { type: 'solid', color: '#ffffff' },
      remark: '',
    }

    const backendPages = convertPagesToBackend([page])
    const backendTable = backendPages[0]?.elements[0]
    expect(backendTable?.type).toBe('table')

    const props = backendTable?.props as Record<string, unknown>
    expect(props.colWidths).toEqual([0.5, 0.25, 0.25])
    expect(props.rowHeights).toEqual([200, 100])
    expect(props.cellMinHeight).toBe(36)
    expect(props.outline).toEqual({
      style: 'solid',
      width: 2.5,
      color: '#ff0000',
    })
    expect(props.borders).toEqual({
      top: { style: 'dotted', width: 3, color: '#010203' },
      insideH: { style: 'solid', width: 0, color: '#040506' },
    })
  })
})
