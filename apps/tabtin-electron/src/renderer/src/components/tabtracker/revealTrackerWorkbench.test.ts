import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  closeAppPage: vi.fn(),
  setCurrentTab: vi.fn(),
  resolveForegroundTabScopeKey: vi.fn(),
}))

vi.mock('@stores/useAppPageStore', () => ({
  useAppPageStore: {
    getState: () => ({ closeAppPage: mocks.closeAppPage }),
  },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({ setCurrentTab: mocks.setCurrentTab }),
  },
}))

vi.mock('@components/chat/subagent/openSubagentTab', () => ({
  resolveForegroundTabScopeKey: (...args: unknown[]) =>
    mocks.resolveForegroundTabScopeKey(...args),
}))

import { revealTrackerWorkbench } from './revealTrackerWorkbench'

describe('revealTrackerWorkbench', () => {
  beforeEach(() => {
    mocks.closeAppPage.mockClear()
    mocks.setCurrentTab.mockClear()
    mocks.resolveForegroundTabScopeKey.mockReset()
  })

  it('先关闭全屏 App 页并切回 agent，再返回前台 tab scope', () => {
    mocks.resolveForegroundTabScopeKey.mockReturnValue('desktop:org:user:space-1')

    const scope = revealTrackerWorkbench('space-1', 'fallback-scope')

    expect(scope).toBe('desktop:org:user:space-1')
    expect(mocks.closeAppPage).toHaveBeenCalledOnce()
    expect(mocks.setCurrentTab).toHaveBeenCalledWith('agent')
    expect(mocks.resolveForegroundTabScopeKey).toHaveBeenCalledWith('space-1')
    expect(mocks.closeAppPage.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.setCurrentTab.mock.invocationCallOrder[0])
    expect(mocks.setCurrentTab.mock.invocationCallOrder[0])
      .toBeLessThan(mocks.resolveForegroundTabScopeKey.mock.invocationCallOrder[0])
  })

  it('前台 scope 为空时回退 fallback，再回退 spaceId', () => {
    mocks.resolveForegroundTabScopeKey.mockReturnValue('')
    expect(revealTrackerWorkbench('space-1', 'fallback-scope')).toBe('fallback-scope')

    mocks.resolveForegroundTabScopeKey.mockReturnValue('')
    expect(revealTrackerWorkbench('space-1')).toBe('space-1')
  })
})
