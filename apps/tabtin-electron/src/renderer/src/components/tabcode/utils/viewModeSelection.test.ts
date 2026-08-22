import { describe, expect, it } from 'vitest'
import { resolveGitDiffModeForViewMode, resolveVisibleSelectedFileForViewMode } from './viewModeSelection'
import type { GitStatusMap } from '../components/TabCodeFileTree'

function statusMap(paths: string[]): GitStatusMap {
  return new Map(paths.map(path => [path, 'M']))
}

describe('resolveVisibleSelectedFileForViewMode', () => {
  const selectedFile = 'C:/workspace/project/src/App.tsx'

  it('keeps the selected file in all mode', () => {
    expect(resolveVisibleSelectedFileForViewMode({
      selectedFile,
      viewMode: 'all',
      stagedStatus: statusMap([]),
      unstagedStatus: statusMap([]),
    })).toBe(selectedFile)
  })

  it('clears the preview selection when staged mode has no matching file', () => {
    expect(resolveVisibleSelectedFileForViewMode({
      selectedFile,
      viewMode: 'staged',
      stagedStatus: statusMap([]),
      unstagedStatus: statusMap([selectedFile]),
    })).toBeNull()
  })

  it('keeps the selected file when it belongs to the current git filter', () => {
    expect(resolveVisibleSelectedFileForViewMode({
      selectedFile,
      viewMode: 'unstaged',
      stagedStatus: statusMap([]),
      unstagedStatus: statusMap([selectedFile]),
    })).toBe(selectedFile)
  })

  it('matches Windows selected paths against slash-normalized git status keys', () => {
    const windowsSelectedFile = 'C:\\workspace\\project\\src\\App.tsx'

    expect(resolveVisibleSelectedFileForViewMode({
      selectedFile: windowsSelectedFile,
      viewMode: 'staged',
      stagedStatus: statusMap(['C:/workspace/project/src/App.tsx']),
      unstagedStatus: statusMap([]),
    })).toBe(windowsSelectedFile)
  })

  it('keeps the selected file in combined changes mode when either git status contains it', () => {
    expect(resolveVisibleSelectedFileForViewMode({
      selectedFile,
      viewMode: 'changes',
      stagedStatus: statusMap([selectedFile]),
      unstagedStatus: statusMap([]),
    })).toBe(selectedFile)
  })

  it('prefers unstaged diff in combined changes mode for partially staged files', () => {
    expect(resolveGitDiffModeForViewMode({
      selectedFile,
      viewMode: 'changes',
      stagedStatus: statusMap([selectedFile]),
      unstagedStatus: statusMap([selectedFile]),
    })).toBe('unstaged')
  })
})
