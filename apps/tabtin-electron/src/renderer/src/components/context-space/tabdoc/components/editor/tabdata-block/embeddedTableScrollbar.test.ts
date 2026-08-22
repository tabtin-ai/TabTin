import { describe, expect, it } from 'vitest'

import { resolveStickyScrollbarOffset } from './embeddedTableScrollbar'

describe('resolveStickyScrollbarOffset', () => {
  it('keeps the scrollbar at the document viewport bottom while the table continues below it', () => {
    expect(resolveStickyScrollbarOffset({
      viewportBottom: 800,
      embedTop: 200,
      embedBottom: 1200,
      scrollbarHeight: 16,
    })).toBe(-400)
  })

  it('restores the scrollbar to the table bottom when that bottom enters the viewport', () => {
    expect(resolveStickyScrollbarOffset({
      viewportBottom: 800,
      embedTop: 200,
      embedBottom: 760,
      scrollbarHeight: 16,
    })).toBe(0)
  })

  it('never moves the scrollbar above the table', () => {
    expect(resolveStickyScrollbarOffset({
      viewportBottom: 800,
      embedTop: 790,
      embedBottom: 1200,
      scrollbarHeight: 16,
    })).toBe(-394)
  })
})
