import { calculateVisibleRightActionCount } from './toolbarLayout'

describe('calculateVisibleRightActionCount', () => {
  it('moves optional actions into More when expanded search consumes the narrow toolbar budget', () => {
    expect(calculateVisibleRightActionCount(500, 4, true)).toBe(0)
  })

  it('keeps the existing compact-search budget when search is collapsed', () => {
    expect(calculateVisibleRightActionCount(500, 4, false)).toBe(4)
  })
})
