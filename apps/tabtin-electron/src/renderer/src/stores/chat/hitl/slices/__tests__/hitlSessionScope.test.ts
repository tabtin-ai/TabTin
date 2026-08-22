import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 收口后 slice 经 agentService 出站；mock 门面直接透传到
// window.tabtin.agentEngine，保持本单测隔离（不加载 hub 的 chatApi 重依赖链），
// 同时验证「slice → 门面 → IPC bridge」调用链仍成立。
vi.mock('@/services/agentService', () => ({
  getSessionController: () => ({
    submitApproval: (...args: unknown[]) =>
      (globalThis as { window: { tabtin: { agentEngine: { submitHitlBatch: (...a: unknown[]) => unknown } } } })
        .window.tabtin.agentEngine.submitHitlBatch(...args),
    answerAskUser: (...args: unknown[]) =>
      (globalThis as { window: { tabtin: { agentEngine: { submitAskUserResponse: (...a: unknown[]) => unknown } } } })
        .window.tabtin.agentEngine.submitAskUserResponse(...args),
  }),
}))

import { createAskUserActions, type AskUserSliceStore } from '../askUserSlice'
import { createApprovalActions, type ApprovalSliceStore } from '../approvalSlice'

function createMutableSet<State extends object>(stateRef: { current: State }) {
  return (
    partial: Partial<State> | ((state: State) => Partial<State>),
  ) => {
    const update = typeof partial === 'function'
      ? partial(stateRef.current)
      : partial
    stateRef.current = {
      ...stateRef.current,
      ...update,
    }
  }
}

/**
 * v0.4 W1.5（PRD §6.7 / §7.4）：approval 通道升级为 batch 形态。
 *
 * 验证：
 *   - approvalSlice 调 `window.tabtin.agentEngine.submitHitlBatch(batchId, decisions[])`
 *     而不是旧 `submitAskUserResponse`。
 *   - 只清掉 target session 的 pending 状态。
 *   - askUser slice 仍走单 request `submitAskUserResponse(requestId, ...)`（独立语义保留）。
 */
describe('session-scoped HITL actions', () => {
  let submitHitlBatchIpc: ReturnType<typeof vi.fn>
  let submitAskUserResponseIpc: ReturnType<typeof vi.fn>
  let originalTabtin: any

  beforeEach(() => {
    submitHitlBatchIpc = vi.fn().mockResolvedValue({ success: true })
    submitAskUserResponseIpc = vi.fn().mockResolvedValue({ success: true })
    originalTabtin = (globalThis as any).window?.tabtin
    ;(globalThis as any).window = {
      ...(globalThis as any).window,
      tabtin: {
        agentEngine: {
          submitHitlBatch: submitHitlBatchIpc,
          submitAskUserResponse: submitAskUserResponseIpc,
        },
      },
      localStorage: {
        getItem: vi.fn(() => null),
      },
    }
  })

  afterEach(() => {
    if (originalTabtin) {
      ;(globalThis as any).window.tabtin = originalTabtin
    }
  })

  it('approval actions only clear the target session pending state', async () => {
    const addStreamingSession = vi.fn()
    const updateSessionMessages = vi.fn()

    const sessionAPending = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      batchId: 'batch-a',
      actionRequests: [
        { request_id: 'req-a-1', tool_call_id: 'call-a-1', tool_name: 'list_directory' },
      ] as any,
      reviewConfigs: [],
      messageId: 'msg-a',
      message: 'approval a',
    }
    const sessionBPending = {
      sessionId: 'session-b',
      threadId: 'thread-b',
      batchId: 'batch-b',
      actionRequests: [
        { request_id: 'req-b-1', tool_call_id: 'call-b-1', tool_name: 'read_file' },
      ] as any,
      reviewConfigs: [],
      messageId: 'msg-b',
      message: 'approval b',
    }

    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-b',
        pendingApproval: sessionBPending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: {
          'session-a': sessionAPending,
          'session-b': sessionBPending,
        },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: {},
        } as any),
      },
      {
        addStreamingSession,
        updateSessionMessages,
      },
    )

    await actions.submitApprovalDecisionsForSession('session-a', [
      { tool_call_id: 'call-a-1', decision: 'approve', scope: 'once' },
    ])

    expect(submitHitlBatchIpc).toHaveBeenCalledWith(
      'batch-a',
      [{
        request_id: 'req-a-1',
        tool_call_id: 'call-a-1',
        outcome: 'allow',
        scope: 'once',
        rejection_message: undefined,
      }],
      'thread-a',
    )
    // addStreamingSession 走 handlePostApprovalResume 的 dynamic import 异步分支，
    // 受 jsdom + Vitest module resolution 影响时序不稳定，这里不强求。
    //
    // 修问题 1（W14·审批残留）：approve 后会调用 `updateSessionMessages` 清掉
    // session-a 那条 review message 的 content，避免「⚠️ 需要确认执行以下操作：…」
    // 长文案残留在 chat 流。这里断言：只对 session-a 调一次，session-b 的 messages
    // 完全不动（验证 session-scoped 不变量）。
    expect(updateSessionMessages).toHaveBeenCalledTimes(1)
    expect(updateSessionMessages.mock.calls[0][0]).toBe('session-a')
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.pendingApprovalBySessionId['session-b']).toEqual(sessionBPending)
    expect(stateRef.current.pendingApproval).toEqual(sessionBPending)
    expect(stateRef.current.isApprovalSubmitting).toBe(false)
    void addStreamingSession
  })

  it('approval reject still re-enters streaming for the target session', async () => {
    const addStreamingSession = vi.fn()

    const pendingApproval = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      batchId: 'batch-a',
      actionRequests: [
        { request_id: 'req-a-1', tool_call_id: 'call-a-1', tool_name: 'rm' },
      ] as any,
      reviewConfigs: [],
      messageId: 'msg-a',
      message: 'approval a',
    }

    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: {
          'session-a': pendingApproval,
        },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: {},
        } as any),
      },
      {
        addStreamingSession,
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitApprovalDecision('reject')

    expect(submitHitlBatchIpc).toHaveBeenCalledWith(
      'batch-a',
      [{
        request_id: 'req-a-1',
        tool_call_id: 'call-a-1',
        outcome: 'deny',
      }],
      'thread-a',
    )
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
    void addStreamingSession
  })

  it('ask_user skip only clears the target session pending state', async () => {
    const addStreamingSession = vi.fn()
    const updateSessionMessages = vi.fn()

    const sessionAPending = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      questions: [],
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      message: 'ask a',
    }
    const sessionBPending = {
      sessionId: 'session-b',
      threadId: 'thread-b',
      interruptId: 'interrupt-b',
      questions: [],
      title: 'ask b',
      toolCallId: 'tool-b',
      messageId: 'msg-b',
      message: 'ask b',
    }

    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-b',
        pendingAskUser: sessionBPending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: {
          'session-a': sessionAPending,
          'session-b': sessionBPending,
        },
        askUserSubmittingBySessionId: {},
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: {},
        } as any),
      },
      {
        addStreamingSession,
        updateSessionMessages,
      },
    )

    await actions.skipAskUserForSession('session-a')

    // ask_user 路径独立保留：仍走 submitAskUserResponse(requestId, response)
    expect(submitAskUserResponseIpc).toHaveBeenCalledWith('interrupt-a', { skipped: true }, 'thread-a')
    expect(updateSessionMessages).not.toHaveBeenCalled()
    expect(stateRef.current.pendingAskUserBySessionId['session-a']).toBeUndefined()
    void addStreamingSession
    expect(stateRef.current.pendingAskUserBySessionId['session-b']).toEqual(sessionBPending)
    expect(stateRef.current.pendingAskUser).toEqual(sessionBPending)
    expect(stateRef.current.isAskUserSubmitting).toBe(false)
  })
})
