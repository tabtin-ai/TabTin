import { describe, expect, it } from 'vitest'
import { Schema } from '@tiptap/pm/model'

import {
  TABLE_CHROME_GAP,
  canDeleteColumnAt,
  canDeleteRowAt,
  canInsertAtSeam,
  findCellPos,
  getColInsertEdge,
  getColSelectHitRect,
  getColSeamHitRect,
  getColSeamX,
  getRowInsertEdge,
  getRowSelectHitRect,
  getRowSeamHitRect,
  getRowSeamY,
  getSeamInsertMeta,
  getTableChromeBoundaryRect,
} from './tableGeometry'

const nodes = {
  doc: { content: 'block+' },
  paragraph: { content: 'inline*', group: 'block' },
  text: { group: 'inline' },
  table: {
    content: 'tableRow+',
    group: 'block',
    isolating: true,
    tableRole: 'table',
  },
  tableRow: {
    content: '(tableCell | tableHeader)+',
    tableRole: 'row',
  },
  tableCell: {
    content: 'block+',
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
    tableRole: 'cell',
  },
  tableHeader: {
    content: 'block+',
    attrs: {
      colspan: { default: 1 },
      rowspan: { default: 1 },
      colwidth: { default: null },
    },
    tableRole: 'header_cell',
  },
}

const schema = new Schema({ nodes })

function cell(text = '') {
  return schema.node('tableCell', null, [
    schema.node('paragraph', null, text ? [schema.text(text)] : []),
  ])
}

describe('findCellPos', () => {
  it('returns positions for a 2x2 table', () => {
    const table = schema.node('table', null, [
      schema.node('tableRow', null, [cell('a'), cell('b')]),
      schema.node('tableRow', null, [cell('c'), cell('d')]),
    ])
    const doc = schema.node('doc', null, [table])
    const tablePos = 0

    expect(findCellPos(table, tablePos, 0, 0)).toBe(2)
    const pos01 = findCellPos(table, tablePos, 0, 1)
    const pos10 = findCellPos(table, tablePos, 1, 0)
    const pos11 = findCellPos(table, tablePos, 1, 1)
    expect(pos01).toBeGreaterThan(findCellPos(table, tablePos, 0, 0)!)
    expect(pos10).toBeGreaterThan(pos01!)
    expect(pos11).toBeGreaterThan(pos10!)

    const cellNode = doc.nodeAt(pos11!)
    expect(cellNode?.type.name).toBe('tableCell')
    expect(cellNode?.textContent).toBe('d')
  })

  it('returns null for out-of-range indices', () => {
    const table = schema.node('table', null, [
      schema.node('tableRow', null, [cell()]),
    ])
    expect(findCellPos(table, 0, 0, 1)).toBeNull()
    expect(findCellPos(table, 0, 1, 0)).toBeNull()
  })
})

describe('getSeamInsertMeta + canInsertAtSeam', () => {
  it('maps column seams including before-first', () => {
    expect(canInsertAtSeam('col', -1, 3)).toBe(true)
    expect(getSeamInsertMeta('col', -1, 3)).toMatchObject({
      placement: 'before-first',
      command: 'addColumnBefore',
    })
    expect(getSeamInsertMeta('col', 1, 3)).toMatchObject({
      placement: 'middle',
      command: 'addColumnAfter',
      displayIndex: 2,
    })
    expect(getSeamInsertMeta('col', 2, 3)).toMatchObject({
      placement: 'at-end',
      command: 'addColumnAfter',
    })
  })

  it('rejects inserting a row before the first row', () => {
    expect(canInsertAtSeam('row', -1, 3)).toBe(false)
    expect(getSeamInsertMeta('row', -1, 3)).toBeNull()
    expect(getSeamInsertMeta('row', 0, 3)).toMatchObject({
      placement: 'middle',
      command: 'addRowAfter',
      displayIndex: 1,
    })
    expect(getSeamInsertMeta('row', 2, 3)).toMatchObject({
      placement: 'at-end',
      command: 'addRowAfter',
    })
  })
})

describe('external gutter geometry', () => {
  const metrics = {
    boundaryRect: { left: 60, top: 160, width: 380, height: 200, right: 440, bottom: 360 },
    visibleRect: { left: 100, top: 200, width: 300, height: 120, right: 400, bottom: 320 },
    tableRect: {
      left: 100,
      top: 200,
      width: 300,
      height: 120,
      right: 400,
      bottom: 320,
      x: 100,
      y: 200,
      toJSON: () => ({}),
    } as DOMRect,
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
  }

  it('keeps seam hit rects outside the table body', () => {
    const colHit = getColSeamHitRect(metrics, 0)!
    expect(colHit.bottom).toBeLessThanOrEqual(metrics.tableRect.top - TABLE_CHROME_GAP + 0.001)
    expect(colHit.width).toBe(14)

    const rowHit = getRowSeamHitRect(metrics, 1)!
    expect(rowHit.right).toBeLessThanOrEqual(metrics.tableRect.left - TABLE_CHROME_GAP + 0.001)
    expect(rowHit.height).toBe(14)
  })

  it('clamps edge seam controls fully into the visible viewport', () => {
    const clipped = {
      ...metrics,
      visibleRect: { left: 150, top: 220, width: 100, height: 80, right: 250, bottom: 300 },
    }
    const colHit = getColSeamHitRect(clipped, -1)!
    expect(colHit.left).toBeGreaterThanOrEqual(clipped.visibleRect.left)
    expect(colHit.right).toBeLessThanOrEqual(clipped.visibleRect.right)

    const rowHit = getRowSeamHitRect(clipped, 2)!
    expect(rowHit.top).toBeGreaterThanOrEqual(clipped.visibleRect.top)
    expect(rowHit.bottom).toBeLessThanOrEqual(clipped.visibleRect.bottom)
  })

  it('clips insert preview edges at the visible viewport boundary', () => {
    const clipped = {
      ...metrics,
      visibleRect: { left: 200, top: 240, width: 100, height: 40, right: 300, bottom: 280 },
    }
    const colEdge = getColInsertEdge(clipped, 0)!
    expect(colEdge.left).toBeGreaterThanOrEqual(clipped.visibleRect.left)
    expect(colEdge.right).toBeLessThanOrEqual(clipped.visibleRect.right)

    const rowEdge = getRowInsertEdge(clipped, 0)!
    expect(rowEdge.top).toBeGreaterThanOrEqual(clipped.visibleRect.top)
    expect(rowEdge.bottom).toBeLessThanOrEqual(clipped.visibleRect.bottom)
  })

  it('keeps selection anchors and seam hits inside the document host boundary', () => {
    const boundaryRect = {
      left: 96,
      top: 196,
      width: 304,
      height: 124,
      right: 400,
      bottom: 320,
    }
    const bounded = { ...metrics, boundaryRect }

    const rowSelect = getRowSelectHitRect(bounded, 0)!
    expect(rowSelect.left).toBe(boundaryRect.left)
    expect(rowSelect.right).toBeLessThanOrEqual(boundaryRect.right)

    const colSelect = getColSelectHitRect(bounded, 0)!
    expect(colSelect.top).toBe(boundaryRect.top)
    expect(colSelect.bottom).toBeLessThanOrEqual(boundaryRect.bottom)

    expect(getRowSeamHitRect(bounded, 0)).toBeNull()
  })

  it('builds edge-only insert previews without full bands', () => {
    expect(getColSeamX(metrics.columns, -1)).toBe(100)
    expect(getColSeamX(metrics.columns, 2)).toBe(400)
    expect(getRowSeamY(metrics.rows, 0)).toBe(240)

    const colEdge = getColInsertEdge(metrics, 0)!
    expect(colEdge.width).toBe(2)
    expect(colEdge.height).toBe(120)
    expect(colEdge.left).toBeCloseTo(199, 0)

    const rowEdge = getRowInsertEdge(metrics, 1)!
    expect(rowEdge.height).toBe(2)
    expect(rowEdge.width).toBe(300)
    expect(rowEdge.top).toBeCloseTo(279, 0)
  })
})

describe('table chrome portal boundary', () => {
  it('intersects clipping ancestors per axis instead of using global body bounds', () => {
    const outer = document.createElement('div')
    const horizontalScroller = document.createElement('div')
    const editor = document.createElement('div')
    outer.style.overflow = 'hidden'
    horizontalScroller.style.overflowX = 'auto'
    horizontalScroller.style.overflowY = 'visible'
    outer.append(horizontalScroller)
    horizontalScroller.append(editor)
    document.body.append(outer)

    outer.getBoundingClientRect = () => ({
      left: 40, top: 60, width: 500, height: 400, right: 540, bottom: 460,
      x: 40, y: 60, toJSON: () => ({}),
    } as DOMRect)
    horizontalScroller.getBoundingClientRect = () => ({
      left: 100, top: 0, width: 300, height: 700, right: 400, bottom: 700,
      x: 100, y: 0, toJSON: () => ({}),
    } as DOMRect)

    expect(getTableChromeBoundaryRect(editor)).toEqual({
      left: 100,
      top: 60,
      width: 300,
      height: 400,
      right: 400,
      bottom: 460,
    })

    outer.remove()
  })
})

describe('delete guards', () => {
  it('keeps every row and column deletable while preserving one-cell tables', () => {
    expect(canDeleteColumnAt(0, 3)).toBe(true)
    expect(canDeleteColumnAt(2, 3)).toBe(true)
    expect(canDeleteColumnAt(0, 1)).toBe(false)

    expect(canDeleteRowAt(0, 3)).toBe(true)
    expect(canDeleteRowAt(1, 3)).toBe(true)
    expect(canDeleteRowAt(2, 3)).toBe(true)
    expect(canDeleteRowAt(1, 2)).toBe(true)
    expect(canDeleteRowAt(0, 1)).toBe(false)
  })
})
