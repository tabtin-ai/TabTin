import { describe, expect, it } from 'vitest'
import {
  findDescendantGitTreeStatus,
  findGitTreeStatus,
  isSameGitTreeFilterPath,
} from './gitFilteredTree'

describe('gitFilteredTree', () => {
  it('compares selected paths with normalized separators', () => {
    expect(isSameGitTreeFilterPath(
      'C:\\repo\\packages\\app\\index.ts',
      'C:/repo/packages/app/index.ts',
    )).toBe(true)
    expect(isSameGitTreeFilterPath(
      'C:\\repo\\packages\\app\\index.ts',
      'C:/repo/packages/app/other.ts',
    )).toBe(false)
  })

  it('finds exact git status with normalized separators', () => {
    expect(findGitTreeStatus('C:\\repo\\src\\index.ts', [
      ['C:/repo/src/index.ts', 'M'],
    ])).toBe('M')
  })

  it('finds descendant git status for changed folders', () => {
    expect(findDescendantGitTreeStatus('C:/repo/apps', [
      ['C:\\repo\\apps\\tabtin-electron\\src\\main.ts', 'M'],
      ['C:\\repo\\packages\\core\\index.ts', 'A'],
    ])).toBe('M')
  })

  it('does not match sibling paths with the same prefix', () => {
    expect(findDescendantGitTreeStatus('/repo/app', [
      ['/repo/application/src/main.ts', 'M'],
    ])).toBeNull()
  })

  it('uses the first descendant change in tree order for folder color', () => {
    expect(findDescendantGitTreeStatus('/repo/src/utils', [
      ['/repo/src/utils/gitCompactTree.test.ts', 'A'],
      ['/repo/src/utils/gitCompactTree.ts', '?'],
      ['/repo/src/utils/path.ts', 'M'],
    ])).toBe('A')
  })
})
