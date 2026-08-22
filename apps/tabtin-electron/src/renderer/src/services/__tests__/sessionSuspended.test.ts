import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockState = vi.hoisted(() => ({
  addSuspendedSession: vi.fn(),
  removeSuspendedSession: vi.fn(),
  updateRunStateForSession: vi.fn(),
}))

vi.mock('@/stores/useWsConnectionStore', () => ({
  useWsConnectionStore: {
    getState: () => ({
      addSuspendedSession: mockState.addSuspendedSession,
      removeSuspendedSession: mockState.removeSuspendedSession,
    }),
  },
}))

vi.mock('@/stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      updateRunStateForSession: mockState.updateRunStateForSession,
    }),
  },
}))

let markSessionSuspended: typeof import('../sessionSuspended').markSessionSuspended
let markSessionsSuspended: typeof import('../sessionSuspended').markSessionsSuspended

beforeEach(async () => {
  vi.resetModules()
  mockState.addSuspendedSession = vi.fn()
  mockState.removeSuspendedSession = vi.fn()
  mockState.updateRunStateForSession = vi.fn()

  const mod = await import('../sessionSuspended')
  markSessionSuspended = mod.markSessionSuspended
  markSessionsSuspended = mod.markSessionsSuspended
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('markSessionSuspended', () => {
  it('suspended=true → 同时调 addSuspendedSession 和 updateRunStateForSession({suspended:true})', () => {
    markSessionSuspended('s1', true)
    expect(mockState.addSuspendedSession).toHaveBeenCalledWith('s1')
    expect(mockState.removeSuspendedSession).not.toHaveBeenCalled()
    expect(mockState.updateRunStateForSession).toHaveBeenCalledWith('s1', { suspended: true })
  })

  it('suspended=false → 同时调 removeSuspendedSession 和 updateRunStateForSession({suspended:false})', () => {
    markSessionSuspended('s1', false)
    expect(mockState.removeSuspendedSession).toHaveBeenCalledWith('s1')
    expect(mockState.addSuspendedSession).not.toHaveBeenCalled()
    expect(mockState.updateRunStateForSession).toHaveBeenCalledWith('s1', { suspended: false })
  })

  it('空 sessionId → no-op，不调用任何 store', () => {
    markSessionSuspended('', true)
    expect(mockState.addSuspendedSession).not.toHaveBeenCalled()
    expect(mockState.removeSuspendedSession).not.toHaveBeenCalled()
    expect(mockState.updateRunStateForSession).not.toHaveBeenCalled()
  })
})

describe('markSessionsSuspended', () => {
  it('批量 true → 对每个 session 调 add + updateRunState', () => {
    markSessionsSuspended(['s1', 's2', 's3'], true)
    expect(mockState.addSuspendedSession).toHaveBeenCalledTimes(3)
    expect(mockState.addSuspendedSession).toHaveBeenNthCalledWith(1, 's1')
    expect(mockState.addSuspendedSession).toHaveBeenNthCalledWith(2, 's2')
    expect(mockState.addSuspendedSession).toHaveBeenNthCalledWith(3, 's3')
    expect(mockState.updateRunStateForSession).toHaveBeenCalledTimes(3)
    for (const sid of ['s1', 's2', 's3']) {
      expect(mockState.updateRunStateForSession).toHaveBeenCalledWith(sid, { suspended: true })
    }
  })

  it('批量 false → 对每个 session 调 remove + updateRunState({suspended:false})', () => {
    markSessionsSuspended(['s1', 's2'], false)
    expect(mockState.removeSuspendedSession).toHaveBeenCalledTimes(2)
    expect(mockState.removeSuspendedSession).toHaveBeenNthCalledWith(1, 's1')
    expect(mockState.removeSuspendedSession).toHaveBeenNthCalledWith(2, 's2')
    expect(mockState.updateRunStateForSession).toHaveBeenCalledTimes(2)
  })

  it('空数组 → 不调任何 store getState（性能优化）', () => {
    markSessionsSuspended([], true)
    expect(mockState.addSuspendedSession).not.toHaveBeenCalled()
    expect(mockState.removeSuspendedSession).not.toHaveBeenCalled()
    expect(mockState.updateRunStateForSession).not.toHaveBeenCalled()
  })

  it('数组里有空字符串 → 跳过，不影响其他 sid', () => {
    markSessionsSuspended(['s1', '', 's2'], true)
    expect(mockState.addSuspendedSession).toHaveBeenCalledTimes(2)
    expect(mockState.addSuspendedSession).toHaveBeenNthCalledWith(1, 's1')
    expect(mockState.addSuspendedSession).toHaveBeenNthCalledWith(2, 's2')
  })
})
