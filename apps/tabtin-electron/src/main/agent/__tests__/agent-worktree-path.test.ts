import path from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildManagedAgentWorktreeBasePath,
  chooseAvailableAgentWorktreePath,
} from '../agent-worktree-path'

describe('Agent managed worktree path', () => {
  it('builds the macOS/Linux path below the TabTin managed root', () => {
    expect(buildManagedAgentWorktreeBasePath({
      managedRoot: '/Users/me/.tabtin/worktrees',
      repositoryRoot: '/Users/me/projects/TabTin',
      branch: 'feat/10498 Agent Worktree',
    }, path.posix)).toBe(
      '/Users/me/.tabtin/worktrees/TabTin/wt-feat-10498-Agent-Worktree',
    )
  })

  it('uses native Windows separators and keeps the path below the user .tabtin root', () => {
    expect(buildManagedAgentWorktreeBasePath({
      managedRoot: 'C:\\Users\\me\\.tabtin\\worktrees',
      repositoryRoot: 'D:\\projects\\TabTin',
      branch: 'feat/10498 Agent Worktree',
    }, path.win32)).toBe(
      'C:\\Users\\me\\.tabtin\\worktrees\\TabTin\\wt-feat-10498-Agent-Worktree',
    )
  })

  it('avoids Windows-reserved and trailing-dot path segments', () => {
    expect(buildManagedAgentWorktreeBasePath({
      managedRoot: 'C:\\Users\\me\\.tabtin\\worktrees',
      repositoryRoot: 'D:\\projects\\CON',
      branch: 'NUL... ',
    }, path.win32)).toBe(
      'C:\\Users\\me\\.tabtin\\worktrees\\_CON\\wt-_NUL',
    )
  })

  it('adds a deterministic suffix without overwriting an occupied directory', () => {
    const base = '/Users/me/.tabtin/worktrees/TabTin/wt-feat-demo'
    const occupied = new Set([base, `${base}-2`])

    expect(chooseAvailableAgentWorktreePath(base, (candidate) => occupied.has(candidate)))
      .toBe(`${base}-3`)
  })
})
