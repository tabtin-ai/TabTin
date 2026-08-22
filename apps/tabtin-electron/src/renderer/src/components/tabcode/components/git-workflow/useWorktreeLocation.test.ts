import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useWorktreeLocation } from './useWorktreeLocation'

describe('useWorktreeLocation', () => {
  it('默认跟分支建议目录名，改名后不再被分支覆盖', () => {
    const { result, rerender } = renderHook(
      ({ branch }) =>
        useWorktreeLocation({
          repoRoot: '/Users/me/project/TabTin',
          branch,
          existingPaths: [],
        }),
      { initialProps: { branch: 'feat/a' } },
    )

    expect(result.current.folderName).toBe('TabTin-feat-a')
    expect(result.current.fullPath).toBe('/Users/me/project/TabTin-feat-a')
    expect(result.current.followsSuggestion).toBe(true)

    act(() => {
      result.current.setFolderName('custom-copy')
    })
    rerender({ branch: 'feat/b' })

    expect(result.current.folderName).toBe('custom-copy')
    expect(result.current.fullPath).toBe('/Users/me/project/custom-copy')
    expect(result.current.followsSuggestion).toBe(false)
  })

  it('改父目录不影响已定的目录名', () => {
    const { result } = renderHook(() =>
      useWorktreeLocation({
        repoRoot: '/Users/me/project/TabTin',
        branch: 'feat/login',
        existingPaths: [],
      }),
    )

    act(() => {
      result.current.setParent('/tmp/worktrees')
    })

    expect(result.current.folderName).toBe('TabTin-feat-login')
    expect(result.current.fullPath).toBe('/tmp/worktrees/TabTin-feat-login')
  })

  it('resetKey 变化后恢复跟随建议', () => {
    const { result, rerender } = renderHook(
      ({ resetKey, branch }) =>
        useWorktreeLocation({
          repoRoot: '/Users/me/project/TabTin',
          branch,
          existingPaths: [],
          resetKey,
        }),
      { initialProps: { resetKey: 1, branch: 'feat/a' } },
    )

    act(() => {
      result.current.setFolderName('custom-copy')
    })
    rerender({ resetKey: 2, branch: 'feat/b' })

    expect(result.current.folderName).toBe('TabTin-feat-b')
    expect(result.current.followsSuggestion).toBe(true)
    expect(result.current.locationOpen).toBe(false)
  })
})
