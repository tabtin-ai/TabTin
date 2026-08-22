import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAgentStreamingTailVisible } from '../useAgentStreamingTailVisible'

type MockChatState = {
  pendingApprovalBySessionId: Record<string, unknown>
  pendingAskUserBySessionId: Record<string, unknown>
}

type MockRuntimeState = {
  runStateBySessionId: Record<string, { suspended?: boolean }>
}

const SESSION = 'session-1'

const { mockChatState, mockRuntimeState, mockBusyState } = vi.hoisted(() => ({
  mockChatState: {
    pendingApprovalBySessionId: {} as Record<string, unknown>,
    pendingAskUserBySessionId: {} as Record<string, unknown>,
  } as MockChatState,
  mockRuntimeState: {
    runStateBySessionId: {} as Record<string, { suspended?: boolean }>,
  } as MockRuntimeState,
  // ：busy 改订阅执行态投影（useSessionBusy），mock 同步跟进。
  mockBusyState: { busyBySessionId: {} as Record<string, boolean> },
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: MockChatState) => unknown) => selector(mockChatState),
}))

vi.mock('@stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: (selector: (state: MockRuntimeState) => unknown) => selector(mockRuntimeState),
}))

vi.mock('@/stores/chat/execution/sessionRunProjection', () => ({
  useSessionBusy: (sessionId: string | null) =>
    sessionId ? !!mockBusyState.busyBySessionId[sessionId] : false,
}))

describe('useAgentStreamingTailVisible', () => {
  beforeEach(() => {
    mockBusyState.busyBySessionId = {}
    mockChatState.pendingApprovalBySessionId = {}
    mockChatState.pendingAskUserBySessionId = {}
    mockRuntimeState.runStateBySessionId = {}
  })

  it('streaming 且无 HITL 挂起 → true', () => {
    mockBusyState.busyBySessionId[SESSION] = true
    const { result } = renderHook(() => useAgentStreamingTailVisible(SESSION))
    expect(result.current).toBe(true)
  })

  it('非 streaming → false', () => {
    const { result } = renderHook(() => useAgentStreamingTailVisible(SESSION))
    expect(result.current).toBe(false)
  })

  it('审批等待 → false', () => {
    mockBusyState.busyBySessionId[SESSION] = true
    mockChatState.pendingApprovalBySessionId[SESSION] = { batchId: 'b1' }
    const { result } = renderHook(() => useAgentStreamingTailVisible(SESSION))
    expect(result.current).toBe(false)
  })

  it('askUser 等待 → false', () => {
    mockBusyState.busyBySessionId[SESSION] = true
    mockChatState.pendingAskUserBySessionId[SESSION] = { requestId: 'a1' }
    const { result } = renderHook(() => useAgentStreamingTailVisible(SESSION))
    expect(result.current).toBe(false)
  })

  it('runState suspended → false', () => {
    mockBusyState.busyBySessionId[SESSION] = true
    mockRuntimeState.runStateBySessionId[SESSION] = { suspended: true }
    const { result } = renderHook(() => useAgentStreamingTailVisible(SESSION))
    expect(result.current).toBe(false)
  })

  it('sessionId 为空 → false', () => {
    mockBusyState.busyBySessionId[SESSION] = true
    const { result } = renderHook(() => useAgentStreamingTailVisible(null))
    expect(result.current).toBe(false)
  })
})
