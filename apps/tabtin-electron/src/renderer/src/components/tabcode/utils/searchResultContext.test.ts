import { describe, expect, it } from 'vitest'
import { sliceSearchContextLines } from './searchResultContext'

describe('sliceSearchContextLines', () => {
  const lines = ['a', 'b', 'c', 'd', 'e', 'f', 'g']

  it('returns radius lines around the match', () => {
    expect(sliceSearchContextLines(lines, 4, 2)).toEqual([
      { lineNumber: 2, text: 'b', isMatch: false },
      { lineNumber: 3, text: 'c', isMatch: false },
      { lineNumber: 4, text: 'd', isMatch: true },
      { lineNumber: 5, text: 'e', isMatch: false },
      { lineNumber: 6, text: 'f', isMatch: false },
    ])
  })

  it('clamps at file start and end', () => {
    expect(sliceSearchContextLines(lines, 1, 2)).toEqual([
      { lineNumber: 1, text: 'a', isMatch: true },
      { lineNumber: 2, text: 'b', isMatch: false },
      { lineNumber: 3, text: 'c', isMatch: false },
    ])
    expect(sliceSearchContextLines(lines, 7, 2)).toEqual([
      { lineNumber: 5, text: 'e', isMatch: false },
      { lineNumber: 6, text: 'f', isMatch: false },
      { lineNumber: 7, text: 'g', isMatch: true },
    ])
  })

  it('returns null for out-of-range or invalid line', () => {
    expect(sliceSearchContextLines(lines, 0, 2)).toBeNull()
    expect(sliceSearchContextLines(lines, 8, 2)).toBeNull()
    expect(sliceSearchContextLines([], 1, 2)).toBeNull()
  })
})
