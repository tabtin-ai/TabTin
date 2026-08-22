import { beforeEach, describe, expect, it, vi } from 'vitest'

const bindSessionCodeRoot = vi.fn()
const pruneCodeRefsForRootChange = vi.fn()
const markCodeRootSwitched = vi.fn()
const silentlyRebindSessionTabCodeRoot = vi.fn()
const redirectCodeChangesTabsToRoot = vi.fn()
const appendSessionAllowedPath = vi.fn(async () => undefined)

vi.mock('@/services/sessionCodeRootBinding', () => ({
  bindSessionCodeRoot: (...args: unknown[]) => bindSessionCodeRoot(...args),
}))

vi.mock('@stores/useContextInjectionStore', () => ({
  useContextInjectionStore: {
    getState: () => ({ pruneCodeRefsForRootChange }),
  },
}))

vi.mock('../agentTurnDiffSnapshots', () => ({
  useAgentTurnDiffStore: {
    getState: () => ({ markCodeRootSwitched }),
  },
}))

vi.mock('../codeWorkspaceTab', () => ({
  silentlyRebindSessionTabCodeRoot: (...args: unknown[]) =>
    silentlyRebindSessionTabCodeRoot(...args),
  redirectCodeChangesTabsToRoot: (...args: unknown[]) =>
    redirectCodeChangesTabsToRoot(...args),
}))

import { switchSessionWorktree } from '../switchSessionWorktree'

describe('switchSessionWorktree', () => {
  beforeEach(() => {
    bindSessionCodeRoot.mockReset()
    pruneCodeRefsForRootChange.mockReset()
    markCodeRootSwitched.mockReset()
    silentlyRebindSessionTabCodeRoot.mockReset()
    redirectCodeChangesTabsToRoot.mockReset()
    appendSessionAllowedPath.mockClear()
    Object.defineProperty(window, 'tabtin', {
      value: {
        workspace: { appendSessionAllowedPath },
      },
      writable: true,
      configurable: true,
    })
  })

  it('绑定成功后静默切 TabCode，并在新根重建已打开的 Changes', async () => {
    bindSessionCodeRoot.mockResolvedValue({
      success: true,
      rootPath: '/repo/wt',
    })

    const result = await switchSessionWorktree({
      sessionId: 's1',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:s1',
      rootPath: '/repo/wt',
      previousRootPath: '/repo',
      branch: 'feat/wt',
    })

    expect(result.success).toBe(true)
    expect(appendSessionAllowedPath).toHaveBeenCalledWith({
      spaceId: 'space-1',
      sessionId: 's1',
      path: '/repo/wt',
    })
    expect(pruneCodeRefsForRootChange).toHaveBeenCalledWith('s1', '/repo/wt')
    expect(markCodeRootSwitched).toHaveBeenCalledWith('s1')
    expect(silentlyRebindSessionTabCodeRoot).toHaveBeenCalledWith({
      tabScopeKey: 'conversation:s1',
      previousRootPath: '/repo',
      nextRootPath: '/repo/wt',
      spaceId: 'space-1',
    })
    expect(redirectCodeChangesTabsToRoot).toHaveBeenCalledWith(
      expect.objectContaining({
        nextRootPath: '/repo/wt',
      }),
    )
  })

  it('绑定失败时不切 TabCode、不重定向 Changes', async () => {
    bindSessionCodeRoot.mockResolvedValue({
      success: false,
      reason: 'not_git_worktree',
      error: 'nope',
    })

    const result = await switchSessionWorktree({
      sessionId: 's1',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:s1',
      rootPath: '/repo/wt',
      previousRootPath: '/repo',
    })

    expect(result.success).toBe(false)
    expect(silentlyRebindSessionTabCodeRoot).not.toHaveBeenCalled()
    expect(redirectCodeChangesTabsToRoot).not.toHaveBeenCalled()
  })

  it('无旧根时跳过 TabCode 静默切换', async () => {
    bindSessionCodeRoot.mockResolvedValue({
      success: true,
      rootPath: '/repo/wt',
    })

    await switchSessionWorktree({
      sessionId: 's1',
      spaceId: 'space-1',
      tabScopeKey: 'conversation:s1',
      rootPath: '/repo/wt',
    })

    expect(silentlyRebindSessionTabCodeRoot).not.toHaveBeenCalled()
    expect(redirectCodeChangesTabsToRoot).toHaveBeenCalled()
  })
})
