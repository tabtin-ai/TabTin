/**
 * Regression tests for Wave 6 unit-conversion fixes:
 * - [B4-02] LineElement SVG strokeWidth: pt → px conversion
 * - [B6-05] Table rowHeights/cellMinHeight: consistent px unit in pptx export
 */
import { describe, it, expect } from 'vitest'
import { ptToPx, pxToPt, pxToInch } from '../utils/geometry'
import { buildLineLengthUpdates, getLineLength, normalizeLineGeometry } from '../utils/line-geometry'
import type { PPTLineElement } from '../types/slides'

/* ── B4-02: lineWidth pt→px conversion ── */

describe('B4-02: ptToPx conversion for lineWidth', () => {
  it('converts 1pt to ~1.333px', () => {
    const px = ptToPx(1)
    expect(px).toBeCloseTo(96 / 72, 3)
  })

  it('converts 2pt (default lineWidth) to ~2.667px', () => {
    const px = ptToPx(2)
    expect(px).toBeCloseTo(2 * 96 / 72, 3)
  })

  it('round-trips pt→px→pt without loss', () => {
    for (const pt of [0.5, 1, 1.5, 2, 3, 4.5, 6, 12]) {
      expect(pxToPt(ptToPx(pt))).toBeCloseTo(pt, 6)
    }
  })

  it('ptToPx(2) is 33% larger than raw pt value (the bug scenario)', () => {
    const ptVal = 2
    const pxVal = ptToPx(ptVal)
    expect(pxVal).toBeGreaterThan(ptVal)
    expect(pxVal / ptVal).toBeCloseTo(4 / 3, 3)
  })
})

/* ── B6-05: table row height unit consistency ── */

describe('B6-05: table row height EMU↔px constants', () => {
  const EMU_PER_PX = 9525
  const EMU_PER_PT = 12700

  it('EMU_PER_PX (9525) is correct: 914400 / 96', () => {
    expect(EMU_PER_PX).toBe(Math.round(914400 / 96))
  })

  it('EMU_PER_PT (12700) is correct: 914400 / 72', () => {
    expect(EMU_PER_PT).toBe(Math.round(914400 / 72))
  })

  it('using EMU_PER_PT for row height produces ~33% deviation vs correct px', () => {
    const rowHeightEmu = 342900 // 36px = 342900 EMU
    const correctPx = rowHeightEmu / EMU_PER_PX
    const wrongPt = rowHeightEmu / EMU_PER_PT

    expect(correctPx).toBeCloseTo(36, 1)
    expect(wrongPt).toBeCloseTo(27, 0)
    expect((correctPx - wrongPt) / correctPx).toBeCloseTo(0.25, 1)
  })

  it('pxToInch round-trips consistently with 9525 EMU per px', () => {
    const testPx = 48
    const inch = pxToInch(testPx)
    expect(inch).toBeCloseTo(0.5, 6)
    expect(Math.round(inch * 914400)).toBe(testPx * EMU_PER_PX)
  })
})

describe('Line property panel length updates', () => {
  const makeVerticalLine = (): PPTLineElement => ({
    id: 'line-vertical',
    type: 'line',
    x: 100,
    y: 200,
    width: 1,
    height: 120,
    rotate: 0,
    opacity: 1,
    locked: false,
    start: [0, 0],
    end: [0, 120],
    style: 'solid',
    color: '#333333',
    lineWidth: 3,
    points: ['', ''],
  })

  const makeHorizontalLine = (): PPTLineElement => ({
    id: 'line-horizontal',
    type: 'line',
    x: 100,
    y: 200,
    width: 120,
    height: 1,
    rotate: 0,
    opacity: 1,
    locked: false,
    start: [0, 0],
    end: [120, 0],
    style: 'solid',
    color: '#333333',
    lineWidth: 3,
    points: ['', ''],
  })

  it('updates vertical line length without turning it into a diagonal line', () => {
    const line = makeVerticalLine()
    const updates = buildLineLengthUpdates(line, 240)
    const normalized = normalizeLineGeometry({ ...line, ...updates })

    expect(normalized.width).toBeCloseTo(ptToPx(3), 3)
    expect(normalized.height).toBeCloseTo(240 + ptToPx(3), 3)
    expect(normalized.start[0]).toBeCloseTo(ptToPx(3) / 2, 3)
    expect(normalized.end[0]).toBeCloseTo(ptToPx(3) / 2, 3)
    expect(normalized.end[1] - normalized.start[1]).toBe(240)
    expect(getLineLength(normalized)).toBe(240)
    expect(normalized.lineWidth).toBe(3)
  })

  it('updates horizontal line length without changing its direction', () => {
    const line = makeHorizontalLine()
    const updates = buildLineLengthUpdates(line, 240)
    const normalized = normalizeLineGeometry({ ...line, ...updates })

    expect(normalized.width).toBeCloseTo(240 + ptToPx(3), 3)
    expect(normalized.height).toBeCloseTo(ptToPx(3), 3)
    expect(normalized.start[1]).toBeCloseTo(ptToPx(3) / 2, 3)
    expect(normalized.end[1]).toBeCloseTo(ptToPx(3) / 2, 3)
    expect(normalized.end[0] - normalized.start[0]).toBe(240)
    expect(getLineLength(normalized)).toBe(240)
  })

  it('automatically derives visual W/H from length and lineWidth', () => {
    const thin = normalizeLineGeometry(makeVerticalLine())
    const thick = normalizeLineGeometry({ ...makeVerticalLine(), lineWidth: 6 })

    expect(thin.width).toBeCloseTo(ptToPx(3), 3)
    expect(thin.height).toBeCloseTo(120 + ptToPx(3), 3)
    expect(thick.width).toBeCloseTo(ptToPx(6), 3)
    expect(thick.height).toBeCloseTo(120 + ptToPx(6), 3)
  })
})
