import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getSessionContext: vi.fn(),
  setGroupRuntimeForSession: vi.fn(),
  runtimeState: {
    agentModeBySessionId: {} as Record<string, string>,
    groupRuntimeBySessionId: {} as Record<string, unknown>,
  },
  spaceState: {
    selectedAgent: { id: 'agent-1', agent_config: { security: { allow_yolo_mode: true } } },
  },
}))

vi.mock('@/services/chatExtraApi', () => ({
  getSessionContext: (...args: unknown[]) => mocks.getSessionContext(...args),
}))

vi.mock('../../../useChatRuntimeStore', () => ({
  useChatRuntimeStore: Object.assign(
    (sel: (s: typeof mocks.runtimeState & { setGroupRuntimeForSession: typeof mocks.setGroupRuntimeForSession }) => unknown) =>
      sel({ ...mocks.runtimeState, setGroupRuntimeForSession: mocks.setGroupRuntimeForSession }),
    {
      getState: () => ({
        ...mocks.runtimeState,
        setGroupRuntimeForSession: mocks.setGroupRuntimeForSession,
      }),
      setState: (
        partial:
          | Partial<typeof mocks.runtimeState>
          | ((state: typeof mocks.runtimeState) => Partial<typeof mocks.runtimeState>),
      ) => {
        const next = typeof partial === 'function' ? partial(mocks.runtimeState) : partial
        Object.assign(mocks.runtimeState, next)
      },
    },
  ),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => mocks.spaceState,
  },
}))

vi.mock('../../session/agentModePreference', () => ({
  readAgentDefaultMode: () => null,
}))

import { ensureGroupRuntimeSynced } from '../groupRuntimeSessionSync'

describe('ensureGroupRuntimeSynced', () => {
  beforeEach(() => {
    mocks.getSessionContext.mockReset()
    mocks.setGroupRuntimeForSession.mockReset()
    mocks.runtimeState.agentModeBySessionId = {}
    mocks.runtimeState.groupRuntimeBySessionId = {}
    mocks.getSessionContext.mockImplementation(async () => ({
      group_runtime: { is_active: true, enabled: true },
    }))
  })

  it('同 session 并发只触发一次 getSessionContext', async () => {
    await Promise.all([
      ensureGroupRuntimeSynced('sess-a'),
      ensureGroupRuntimeSynced('sess-a'),
    ])
    expect(mocks.getSessionContext).toHaveBeenCalledTimes(1)
    expect(mocks.setGroupRuntimeForSession).toHaveBeenCalledWith(
      'sess-a',
      { is_active: true, enabled: true },
    )
  })

  it('无 existingMode 时种子 default，已有 mode 不被 default 覆盖', async () => {
    await ensureGroupRuntimeSynced('sess-seed')
    expect(mocks.runtimeState.agentModeBySessionId['sess-seed']).toBeTruthy()

    mocks.runtimeState.agentModeBySessionId = { 'sess-keep': 'plan' }
    mocks.getSessionContext.mockClear()
    // 清 in-flight：换 session id
    await ensureGroupRuntimeSynced('sess-keep')
    expect(mocks.runtimeState.agentModeBySessionId['sess-keep']).toBe('plan')
  })
})
