import { describe, expect, it } from 'vitest'
import {
  isPathInside,
  joinPath,
  getParentPath,
  canMoveEntryToDir,
} from '../path-ops'

describe('path-ops', () => {
  it('isPathInside detects self and descendants', () => {
    expect(isPathInside('/proj', '/proj')).toBe(true)
    expect(isPathInside('/proj', '/proj/src')).toBe(true)
    expect(isPathInside('/proj', '/project')).toBe(false)
  })

  it('joinPath and getParentPath', () => {
    expect(joinPath('/proj/', 'a.ts')).toBe('/proj/a.ts')
    expect(getParentPath('/proj/src/a.ts')).toBe('/proj/src')
    expect(joinPath('C:\\Users\\me\\proj\\', 'a.ts')).toBe('C:/Users/me/proj/a.ts')
    expect(getParentPath('C:\\Users\\me\\proj\\src\\a.ts')).toBe('C:/Users/me/proj/src')
  })

  it('canMoveEntryToDir blocks invalid moves', () => {
    expect(canMoveEntryToDir('/proj/a.ts', '/proj')).toBe(false)
    expect(canMoveEntryToDir('/proj', '/proj/src')).toBe(false)
    expect(canMoveEntryToDir('/proj/a.ts', '/proj/src')).toBe(true)
    expect(canMoveEntryToDir('/proj/a.ts', '/other')).toBe(true)
  })

  it('canMoveEntryToDir normalizes Windows separators', () => {
    expect(canMoveEntryToDir('C:\\proj\\a.ts', 'C:\\proj')).toBe(false)
    expect(canMoveEntryToDir('C:\\proj', 'C:\\proj\\src')).toBe(false)
    expect(canMoveEntryToDir('C:\\proj\\a.ts', 'C:\\other')).toBe(true)
  })
})
