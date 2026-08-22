import { describe, expect, it } from 'vitest'
import {
  findDescendantGitTreeStatus,
  findGitTreeStatus,
} from './gitFilteredTree'

/**
 * Contract for TabCodeFileTree git highlights .
 * The tree must resolve status from the *current* status map on the same
 * render that toolbar counts update — not from a ref flushed in useEffect.
 */
describe('file tree git highlight status lookup ', () => {
  const statuses: Array<[string, string]> = [
    ['C:\\workspace\\test-git\\another new.txt', 'A'],
    ['C:\\workspace\\test-git\\temp\\测试\\111', 'M'],
    ['C:\\workspace\\test-git\\normal dir\\renamed_unstaged.txt', '?'],
  ]

  it('matches changed files on the same path shape the tree uses', () => {
    expect(findGitTreeStatus('C:/workspace/test-git/another new.txt', statuses)).toBe('A')
    expect(findGitTreeStatus('C:\\workspace\\test-git\\temp\\测试\\111', statuses)).toBe('M')
  })

  it('matches ancestor folders so folder color/dot can render', () => {
    expect(findDescendantGitTreeStatus('C:\\workspace\\test-git\\temp', statuses)).toBe('M')
    expect(findDescendantGitTreeStatus('C:/workspace/test-git/temp/测试', statuses)).toBe('M')
    expect(findDescendantGitTreeStatus('C:\\workspace\\test-git\\normal dir', statuses)).toBe('?')
  })
})
