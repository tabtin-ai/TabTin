import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/utils/resolveSpaceExecutionPath', () => ({
  resolveSpaceExecutionPath: vi.fn(),
}))

vi.mock('@/utils/canonicalPath', () => ({
  resolveRealPath: vi.fn(async (path: string) => path),
}))

import { resolveSpaceExecutionPath } from '@/utils/resolveSpaceExecutionPath'
import { resolveRealPath } from '@/utils/canonicalPath'
import { useSessionBoundCodeRootStore } from '@stores/useSessionBoundCodeRootStore'
import { resolveSessionCodeRoot, resolveSessionExecutionPath } from './resolveSessionCodeRoot'

beforeEach(() => {
  useSessionBoundCodeRootStore.setState({ bindingsBySessionId: {}, nextRevision: 1 })
  vi.mocked(resolveSpaceExecutionPath).mockReset()
  vi.mocked(resolveRealPath).mockReset()
  vi.mocked(resolveRealPath).mockImplementation(async (path: string) => path)
})

describe('resolveSessionCodeRoot（优先级）', () => {
  it('显式绑定 status=active 时优先返回绑定根', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('session-1', { rootPath: '/repo/bound' })

    expect(
      resolveSessionCodeRoot('session-1', { spaceWorkingDir: '/space/working-dir' }),
    ).toBe('/repo/bound')
  })

  it('绑定 status 不可用（tab_closed）时回退 spaceWorkingDir', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('session-1', { rootPath: '/repo/bound' })
    useSessionBoundCodeRootStore.getState().markTabClosed('session-1')

    expect(
      resolveSessionCodeRoot('session-1', { spaceWorkingDir: '/space/working-dir' }),
    ).toBe('/space/working-dir')
  })

  it('绑定 status 不可用（path_missing）时回退 spaceWorkingDir', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('session-1', { rootPath: '/repo/bound' })
    useSessionBoundCodeRootStore.getState().markPathMissing('session-1')

    expect(
      resolveSessionCodeRoot('session-1', { spaceWorkingDir: '/space/working-dir' }),
    ).toBe('/space/working-dir')
  })

  it('无绑定且无 spaceWorkingDir 时返回 null', () => {
    expect(resolveSessionCodeRoot('session-1')).toBeNull()
  })

  it('无自身绑定时按 parentSessionId 继承 subagent parent 的绑定', () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('parent-1', { rootPath: '/repo/parent' })

    expect(
      resolveSessionCodeRoot('subagent-1', { parentSessionId: 'parent-1', spaceWorkingDir: '/space/working-dir' }),
    ).toBe('/repo/parent')
  })
})

describe('resolveSessionExecutionPath', () => {
  it('有可用绑定时经 resolveRealPath 收敛后返回', async () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('session-1', { rootPath: '/repo/bound' })
    vi.mocked(resolveRealPath).mockResolvedValue('/repo/bound-real')

    await expect(resolveSessionExecutionPath('session-1')).resolves.toBe('/repo/bound-real')
    expect(resolveSpaceExecutionPath).not.toHaveBeenCalled()
  })

  it('无可用绑定时复用 resolveSpaceExecutionPath', async () => {
    vi.mocked(resolveSpaceExecutionPath).mockResolvedValue('/space/working-dir')

    await expect(resolveSessionExecutionPath('session-1')).resolves.toBe('/space/working-dir')
    expect(resolveSpaceExecutionPath).toHaveBeenCalledTimes(1)
  })

  it('绑定 status 不可用时复用 resolveSpaceExecutionPath 而非绑定根', async () => {
    useSessionBoundCodeRootStore.getState().setBindingLocal('session-1', { rootPath: '/repo/bound' })
    useSessionBoundCodeRootStore.getState().markPathMissing('session-1')
    vi.mocked(resolveSpaceExecutionPath).mockResolvedValue('/space/working-dir')

    await expect(resolveSessionExecutionPath('session-1')).resolves.toBe('/space/working-dir')
    expect(resolveRealPath).not.toHaveBeenCalled()
  })
})
