import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useSessionChatSurface } from '../useSessionChatSurface'

const submitApprovalDecisionsForSession = vi.fn()
const dismissApprovalForSession = vi.fn()
const loadSessionMessages = vi.fn()
const chatState = {
  messagesBySessionId: {
    'sess-a': [{ id: 'm1', role: 'user', content: 'hi' }],
  } as Record<string, unknown[]>,
  hasMoreBySessionId: { 'sess-a': true } as Record<string, boolean>,
  isLoadingMoreBySessionId: { 'sess-a': false } as Record<string, boolean>,
  pendingApprovalBySessionId: {
    'sess-a': { batchId: 'batch-a' },
  } as Record<string, unknown>,
  approvalSubmittingBySessionId: {} as Record<string, boolean>,
  pendingAskUserBySessionId: {} as Record<string, unknown>,
  askUserSubmittingBySessionId: {} as Record<string, boolean>,
  sessions: [
    { id: 'sess-a', rollback_state: { revert_active: true } },
  ],
  hostPendingSendsBySessionId: {} as Record<string, unknown[]>,
  sendInFlightBySessionId: {} as Record<string, boolean>,
  loadMoreMessages: vi.fn(),
  loadSessionMessages,
  submitApprovalDecisionsForSession,
  submitAskUserAnswerForSession: vi.fn(),
  submitAskUserTextForSession: vi.fn(),
  submitAskUserFieldValuesForSession: vi.fn(),
  submitAskUserApprovalForSession: vi.fn(),
  skipAskUserForSession: vi.fn(),
  dismissApprovalForSession,
}

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (sel: (s: typeof chatState) => unknown) => sel(chatState),
}))

vi.mock('@/stores/chat/execution/sessionRunProjection', () => ({
  useSessionBusy: () => false,
  useSessionRunProjection: (sessionId: string | null) => (
    sessionId ? { queuedRunIds: ['run-1'] } : undefined
  ),
}))

vi.mock('@/hooks/useChatSessionEventStream', () => ({
  useChatSessionEventStream: () => {},
}))

vi.mock('@/stores/chat/checkpoint/handlers/checkpointHandler', () => ({
  applyDecisionSummaryUpdate: vi.fn(),
}))

describe('useSessionChatSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    chatState.messagesBySessionId = {
      'sess-a': [{ id: 'm1', role: 'user', content: 'hi' }],
    }
  })

  it('页面恢复时只有 sessionId、消息尚未 hydrate，主动加载会话时间线', () => {
    delete chatState.messagesBySessionId['sess-a']

    const { result } = renderHook(() => useSessionChatSurface('sess-a'))

    expect(result.current.messages).toEqual([])
    expect(result.current.isMessagesLoading).toBe(true)
    expect(loadSessionMessages).toHaveBeenCalledWith('sess-a')
  })

  it('会话消息已在内存时不重复 hydrate', () => {
    renderHook(() => useSessionChatSurface('sess-a'))

    expect(loadSessionMessages).not.toHaveBeenCalled()
  })

  it('queueCount 只认 run_sync 投影，HostPending 孤儿不抬停止铬', () => {
    chatState.hostPendingSendsBySessionId = {
      'sess-a': [{ runId: 'run-orphan', sessionId: 'sess-a', queuePosition: 1, userMessage: { content: 'queued' } }],
    }
    chatState.sendInFlightBySessionId = {}
    const { result } = renderHook(() => useSessionChatSurface('sess-a'))
    // mock 投影仍有 run-1 → 计 1；与 HostPending 条数解耦
    expect(result.current.queueCount).toBe(1)
  })

  it('#9345 sendInFlight 映射到表面', () => {
    chatState.hostPendingSendsBySessionId = {}
    chatState.sendInFlightBySessionId = { 'sess-a': true }
    const { result } = renderHook(() => useSessionChatSurface('sess-a'))
    expect(result.current.isSendInFlight).toBe(true)
  })

  it('按 session 过滤消息 / 回退态，HITL 走 ForSession，排队来自投影', () => {
    chatState.hostPendingSendsBySessionId = {
      'sess-a': [{ runId: 'run-pending', sessionId: 'sess-a', queuePosition: 1, userMessage: { content: 'queued' } }],
    }
    chatState.sendInFlightBySessionId = {}
    const { result } = renderHook(() => useSessionChatSurface('sess-a'))

    expect(result.current.messages).toEqual([{ id: 'm1', role: 'user', content: 'hi' }])
    expect(result.current.hasMore).toBe(true)
    expect(result.current.isReverted).toBe(true)
    expect(result.current.queueCount).toBe(1)
    expect(result.current.isSendInFlight).toBe(false)
    expect(result.current.hitlProps.pendingApproval).toEqual({ batchId: 'batch-a' })
  })

  it('sessionId 为空时返回空表面，不触发 HITL', async () => {
    const { result } = renderHook(() => useSessionChatSurface(null))

    expect(result.current.messages).toEqual([])
    expect(result.current.queueCount).toBe(0)
    expect(result.current.isReverted).toBe(false)
    expect(result.current.hitlProps.pendingApproval).toBeNull()

    await act(async () => {
      await result.current.hitlProps.onApprovalSubmit?.([
        { tool_call_id: 'c1', decision: 'approve', scope: 'once' },
      ])
    })
    expect(submitApprovalDecisionsForSession).not.toHaveBeenCalled()
  })

  it('HITL 回调绑定当前 session', async () => {
    const { result } = renderHook(() => useSessionChatSurface('sess-a'))

    await act(async () => {
      await result.current.hitlProps.onApprovalSubmit?.([
        { tool_call_id: 'c1', decision: 'approve', scope: 'once' },
      ])
    })
    expect(submitApprovalDecisionsForSession).toHaveBeenCalledWith('sess-a', [
      { tool_call_id: 'c1', decision: 'approve', scope: 'once' },
    ])

    act(() => {
      result.current.hitlProps.onApprovalDismiss?.('manual')
    })
    expect(dismissApprovalForSession).toHaveBeenCalledWith('sess-a', 'manual')
  })
})
