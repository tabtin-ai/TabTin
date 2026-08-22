import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { TableChromeMetrics } from './tableGeometry'

const runSeamInsert = vi.fn(() => true)
const selectTableColumn = vi.fn(() => true)
const selectTableRow = vi.fn(() => true)

const editorMock = {
  isEditable: true,
  view: {
    dom: document.createElement('div'),
  },
  state: {
    selection: {
      $from: {},
    },
  },
  on: vi.fn(),
  off: vi.fn(),
}

let metricsFixture: TableChromeMetrics | null = null
let tableLocation: { pos: number; node: unknown } | null = {
  pos: 0,
  node: {},
}

vi.mock('novel', () => ({
  useEditor: () => ({ editor: editorMock }),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string; index?: number }) => {
      if (opts?.defaultValue && opts.index != null) {
        return opts.defaultValue.replace('{{index}}', String(opts.index))
      }
      return opts?.defaultValue ?? key
    },
  }),
}))

vi.mock('../table-exit', () => ({
  findTableLocation: () => tableLocation,
}))

vi.mock('./tableGeometry', async () => {
  const actual = await vi.importActual<typeof import('./tableGeometry')>('./tableGeometry')
  return {
    ...actual,
    measureTableChrome: () => metricsFixture,
    runSeamInsert: (...args: unknown[]) => runSeamInsert(...args),
    selectTableColumn: (...args: unknown[]) => selectTableColumn(...args),
    selectTableRow: (...args: unknown[]) => selectTableRow(...args),
  }
})

import { TableChromeOverlay } from './TableChromeOverlay'

function buildMetrics(overrides?: Partial<TableChromeMetrics>): TableChromeMetrics {
  const tableRect = {
    left: 100,
    top: 200,
    width: 300,
    height: 120,
    right: 400,
    bottom: 320,
    x: 100,
    y: 200,
    toJSON: () => ({}),
  } as DOMRect

  return {
    tablePos: 0,
    tableNode: {} as TableChromeMetrics['tableNode'],
    tableRect,
    boundaryRect: { left: 80, top: 160, width: 360, height: 200, right: 440, bottom: 360 },
    visibleRect: { left: 100, top: 200, width: 300, height: 120, right: 400, bottom: 320 },
    colCount: 3,
    rowCount: 3,
    columns: [
      { left: 100, width: 100 },
      { left: 200, width: 100 },
      { left: 300, width: 100 },
    ],
    rows: [
      { top: 200, height: 40 },
      { top: 240, height: 40 },
      { top: 280, height: 40 },
    ],
    ...overrides,
  }
}

describe('TableChromeOverlay', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.useFakeTimers()
    editorMock.isEditable = true
    tableLocation = { pos: 0, node: {} }
    metricsFixture = buildMetrics()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  async function clickReady(el: Element) {
    fireEvent.click(el)
    await act(async () => {
      vi.advanceTimersByTime(220)
    })
  }

  it('does not render chrome when selection is outside a table', () => {
    tableLocation = null
    render(<TableChromeOverlay />)
    expect(screen.queryByTestId('tabdoc-table-chrome')).toBeNull()
  })

  it('does not render legacy edge add buttons', () => {
    render(<TableChromeOverlay />)
    expect(document.querySelector('.tabdoc-table-chrome__edge-btn')).toBeNull()
  })

  it('shows plus + edge highlight only while hovering an insert seam', () => {
    render(<TableChromeOverlay />)
    const midSeam = screen.getByTestId('tabdoc-table-chrome-col-seam-0')
    const midSeamButton = midSeam.querySelector('button')!
    expect(midSeamButton.getAttribute('title')).toBeNull()
    expect(midSeamButton.getAttribute('aria-label')).toBe('在第 1 列后插入列')
    expect(midSeam.querySelector('svg')).toBeNull()
    expect(screen.queryByTestId('tabdoc-table-chrome-preview-edge')).toBeNull()
    expect(screen.queryByTestId('tabdoc-table-chrome-preview-band')).toBeNull()

    fireEvent.mouseEnter(midSeam)
    expect(midSeam.className).toContain('is-active')
    expect(midSeam.querySelector('svg')).toBeTruthy()
    expect(screen.getByRole('tooltip').textContent).toContain('在第 1 列后插入列')
    expect(screen.getByTestId('tabdoc-table-chrome-preview-edge')).toBeTruthy()
    expect(screen.queryByTestId('tabdoc-table-chrome-preview-band')).toBeNull()

    fireEvent.mouseLeave(midSeam)
    expect(screen.queryByTestId('tabdoc-table-chrome-preview-edge')).toBeNull()
  })

  it('does not render insert seam before the first row', () => {
    render(<TableChromeOverlay />)
    expect(screen.queryByTestId('tabdoc-table-chrome-row-seam--1')).toBeNull()
    const firstRowSeam = screen.getByTestId('tabdoc-table-chrome-row-seam-0')
    const firstRowSeamButton = firstRowSeam.querySelector('button')!
    expect(firstRowSeamButton.getAttribute('title')).toBeNull()
    expect(firstRowSeamButton.getAttribute('aria-label')).toBe('在第 1 行后插入行')
  })

  it('runs insert commands for first/middle/end column seams and row after first', async () => {
    render(<TableChromeOverlay />)

    await clickReady(
      screen.getByTestId('tabdoc-table-chrome-col-seam--1').querySelector('button')!,
    )
    expect(runSeamInsert).toHaveBeenCalledWith(
      editorMock,
      0,
      metricsFixture!.tableNode,
      'col',
      -1,
    )

    await clickReady(
      screen.getByTestId('tabdoc-table-chrome-col-seam-2').querySelector('button')!,
    )
    expect(runSeamInsert).toHaveBeenCalledWith(
      editorMock,
      0,
      metricsFixture!.tableNode,
      'col',
      2,
    )

    await clickReady(
      screen.getByTestId('tabdoc-table-chrome-row-seam-2').querySelector('button')!,
    )
    expect(runSeamInsert).toHaveBeenCalledWith(
      editorMock,
      0,
      metricsFixture!.tableNode,
      'row',
      2,
    )
  })

  it('keeps iconless selection strips for every row and leaves deletion to the toolbar', async () => {
    render(<TableChromeOverlay />)
    expect(screen.getByTestId('tabdoc-table-chrome-select-col-1').textContent).toBe('')
    expect(screen.getByTestId('tabdoc-table-chrome-select-row-1').textContent).toBe('')
    expect(screen.getByTestId('tabdoc-table-chrome-select-row-0').textContent).toBe('')
    expect(screen.getByTestId('tabdoc-table-chrome-select-row-2').textContent).toBe('')
    expect(screen.queryByTestId('tabdoc-table-chrome-delete')).toBeNull()

    const rowSelect = screen.getByTestId('tabdoc-table-chrome-select-row-1')
    expect(rowSelect.getAttribute('title')).toBeNull()
    expect(rowSelect.getAttribute('data-tooltip')).toBe('选中此行')

    await clickReady(screen.getByTestId('tabdoc-table-chrome-select-col-1'))
    expect(screen.getByTestId('tabdoc-table-chrome-select-col-1').className).toContain('is-selected')
    expect(screen.queryByTestId('tabdoc-table-chrome-delete')).toBeNull()
  })

  it('clips the body portal layer to the current document host boundary', () => {
    render(<TableChromeOverlay />)

    expect(screen.getByTestId('tabdoc-table-chrome').style.clipPath).toBe(
      'inset(160px 584px 408px 80px)',
    )
  })

  it('does not render controls for columns outside the visible table viewport', () => {
    metricsFixture = buildMetrics({
      visibleRect: { left: 100, top: 200, width: 100, height: 120, right: 200, bottom: 320 },
    })
    render(<TableChromeOverlay />)
    expect(screen.getByTestId('tabdoc-table-chrome-select-col-0')).toBeTruthy()
    expect(screen.queryByTestId('tabdoc-table-chrome-select-col-1')).toBeNull()
    expect(screen.queryByTestId('tabdoc-table-chrome-col-seam-1')).toBeNull()
  })

  it('keeps column seam hits above the table body', () => {
    render(<TableChromeOverlay />)
    const seam = screen.getByTestId('tabdoc-table-chrome-col-seam-0')
    const top = Number.parseFloat((seam as HTMLElement).style.top)
    expect(top).toBeLessThan(200)
  })

  it('hides body portal chrome while suspended and restores when reactivated ', () => {
    const { rerender } = render(<TableChromeOverlay active />)
    expect(screen.getByTestId('tabdoc-table-chrome')).toBeTruthy()

    rerender(<TableChromeOverlay active={false} />)
    expect(screen.queryByTestId('tabdoc-table-chrome')).toBeNull()
    expect(document.querySelector('.tabdoc-table-chrome')).toBeNull()

    rerender(<TableChromeOverlay active />)
    expect(screen.getByTestId('tabdoc-table-chrome')).toBeTruthy()
  })
})
