import { describe, expect, it } from 'vitest'
import { GRID_DEFAULT } from '../configs'
import { getAppendColumnScreenX, isAppendColumnPointerHit } from './appendColumnLayout'

describe('getAppendColumnScreenX', () => {
  it('places append after columns when scrollLeft is 0', () => {
    expect(
      getAppendColumnScreenX({
        totalWidth: 300,
        scrollLeft: 0,
        freezeRegionWidth: 70,
        columnInitSize: 70,
        columnCount: 2,
      }),
    ).toBe(300)
  })

  it('hides when scroll pulls append onto the first data column (freeze=0)', () => {
    // freeze_columns=0 → freezeRegionWidth === columnInitSize
    // scrollLeft = Σ列宽 → naive x = columnInitSize，会盖住首列
    expect(
      getAppendColumnScreenX({
        totalWidth: 300,
        scrollLeft: 230,
        freezeRegionWidth: 70,
        columnInitSize: 70,
        columnCount: 2,
      }),
    ).toBeNull()
  })

  it('hides when scroll pulls append under a frozen first column', () => {
    expect(
      getAppendColumnScreenX({
        totalWidth: 300,
        scrollLeft: 250,
        freezeRegionWidth: 270,
        columnInitSize: 70,
        columnCount: 2,
      }),
    ).toBeNull()
  })

  it('keeps append visible while it remains to the right of freeze', () => {
    expect(
      getAppendColumnScreenX({
        totalWidth: 300,
        scrollLeft: 20,
        freezeRegionWidth: 70,
        columnInitSize: 70,
        columnCount: 2,
      }),
    ).toBe(280)
  })

  it('allows append at columnInitSize when there are no data columns (empty table)', () => {
    expect(
      getAppendColumnScreenX({
        totalWidth: 70,
        scrollLeft: 0,
        freezeRegionWidth: 70,
        columnInitSize: 70,
        columnCount: 0,
      }),
    ).toBe(70)
  })
})

describe('isAppendColumnPointerHit', () => {
  it('does not treat first-column clicks as append when scrolled (freeze=0)', () => {
    expect(
      isAppendColumnPointerHit({
        screenX: 100,
        scrollLeft: 230,
        totalWidth: 300,
        freezeRegionWidth: 70,
        columnInitSize: 70,
        columnCount: 2,
      }),
    ).toBe(false)
  })

  it('still hits append when pointer is in the append strip past columns', () => {
    expect(
      isAppendColumnPointerHit({
        screenX: 310,
        scrollLeft: 0,
        totalWidth: 300,
        freezeRegionWidth: 70,
        columnInitSize: 70,
        columnCount: 2,
        appendWidth: GRID_DEFAULT.columnAppendBtnWidth,
      }),
    ).toBe(true)
  })
})
