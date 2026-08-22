import { beforeEach, describe, expect, it, vi } from 'vitest'

const switchSessionWorktree = vi.fn()
const createWorktree = vi.fn()
const appendSessionAllowedPath = vi.fn(async () => undefined)

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('../switchSessionWorktree', () => ({
  switchSessionWorktree: (...args: unknown[]) => switchSessionWorktree(...args),
}))

import { createSessionWorktree } from '../createSessionWorktree'

const baseInput = {
  sessionId: 's1',
  spaceId: 'space-1',
  tabScopeKey: 'conversation:s1',
  repoRoot: '/repo',
  previousRootPath: '/repo',
  path: '/repo-wt',
  branch: 'feat/demo-wt',
  createBranch: true,
  baseBranch: 'main',
  currentBranch: 'feat/demo',
  existingBranchNames: ['main', 'feat/demo'],
}

describe('createSessionWorktree', () => {
  beforeEach(() => {
    switchSessionWorktree.mockReset()
    createWorktree.mockReset()
    appendSessionAllowedPath.mockReset()
    appendSessionAllowedPath.mockResolvedValue(undefined)
    createWorktree.mockResolvedValue({ success: true })
    switchSessionWorktree.mockResolvedValue({ success: true, rootPath: '/repo-wt' })
    Object.defineProperty(window, 'tabtin', {
      value: {
        git: { createWorktree },
        workspace: { appendSessionAllowedPath },
      },
      writable: true,
      configurable: true,
    })
  })

  it('validates before touching git', async () => {
    const result = await createSessionWorktree({
      ...baseInput,
      path: '',
    })
    expect(result).toEqual({ ok: false, phase: 'validate', reason: 'path_required' })
    expect(appendSessionAllowedPath).not.toHaveBeenCalled()
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('authorizes, creates, then switches', async () => {
    const result = await createSessionWorktree(baseInput)
    expect(result).toEqual({
      ok: true,
      created: true,
      switched: true,
      rootPath: '/repo-wt',
    })
    expect(appendSessionAllowedPath.mock.invocationCallOrder[0]).toBeLessThan(
      createWorktree.mock.invocationCallOrder[0],
    )
    expect(appendSessionAllowedPath).toHaveBeenCalledWith({
      spaceId: 'space-1',
      sessionId: 's1',
      path: '/repo-wt',
    })
    expect(createWorktree.mock.invocationCallOrder[0]).toBeLessThan(
      switchSessionWorktree.mock.invocationCallOrder[0],
    )
    expect(createWorktree).toHaveBeenCalledWith('/repo', {
      path: '/repo-wt',
      branch: 'feat/demo-wt',
      createBranch: true,
      baseBranch: 'main',
    })
  })

  it('keeps the created directory when switching fails', async () => {
    switchSessionWorktree.mockResolvedValue({
      success: false,
      reason: 'session_busy',
    })
    const result = await createSessionWorktree(baseInput)
    expect(result).toEqual({
      ok: true,
      created: true,
      switched: false,
      rootPath: '/repo-wt',
      switchResult: { success: false, reason: 'session_busy' },
    })
    expect(createWorktree).toHaveBeenCalledOnce()
  })

  it('stops on authorize failure', async () => {
    appendSessionAllowedPath.mockRejectedValue(new Error('denied'))
    const result = await createSessionWorktree(baseInput)
    expect(result).toEqual({ ok: false, phase: 'authorize' })
    expect(createWorktree).not.toHaveBeenCalled()
  })

  it('returns git create errors', async () => {
    createWorktree.mockResolvedValue({ success: false, error: 'already exists' })
    const result = await createSessionWorktree(baseInput)
    expect(result).toEqual({
      ok: false,
      phase: 'create',
      error: 'already exists',
    })
    expect(switchSessionWorktree).not.toHaveBeenCalled()
  })

  it('keeps the created directory when switching throws', async () => {
    switchSessionWorktree.mockRejectedValue(new Error('post-bind exploded'))
    const result = await createSessionWorktree(baseInput)
    expect(result).toEqual({
      ok: true,
      created: true,
      switched: false,
      rootPath: '/repo-wt',
      switchResult: {
        success: false,
        error: 'post-bind exploded',
        reason: 'ipc_unavailable',
      },
    })
    expect(createWorktree).toHaveBeenCalledOnce()
  })
})
