/**
 * Wave 11 IPC 迁移：验证 approval / askUser slice 默认优先走本地 Runtime IPC。
 *
 * 业务契约：
 *   - 只要 `window.tabtin.agentEngine` 存在且用户没显式 `localStorage.tabtin_local_runtime='false'`，
 *     决策提交必须走 `agentEngine.submitHitlBatch` (approval) / `submitAskUserResponse` (askUser)
 *     而不是 `client.messages.*`；
 *   - Django `/api/orchestration/agent/{review,answer}` 在 Wave 11 已下线（urls_deferred.py L47-48）。
 *     因此 approval / askUser 在 IPC 不可用时只能提示"需要设备"，不能偷偷回退 HTTP。
 *
 * v0.4 W1.5（PRD §6.7 / §7.4）：approval 通道升级为 batch 形态：
 *   `submitHitlBatch(batchId, decisions: [{request_id, tool_call_id, outcome, scope?, rejection_message?}])`
 *
 * 本文件覆盖两类行为：
 *   1. IPC 可用时，提交必须走 `agentEngine.submitHitlBatch` / `submitAskUserResponse`
 *   2. IPC 不可用时，不得调用旧 HTTP client，而是回填"需要设备"提示
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatClient } from '@tabtin/chat-client'

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
    // （第二刀）：dismiss / skip 降级路径需要 cancelHitlInteraction。
    // 测试若挂了 stub 就用之，否则返 `{success: true}` 让 fire-and-forget 不抛。
    cancelHitlInteraction: (payload: unknown) => {
      const bridge = (globalThis as { window?: { tabtin?: { agentEngine?: { cancelHitlInteraction?: (p: unknown) => unknown } } } })
        .window?.tabtin?.agentEngine?.cancelHitlInteraction
      return typeof bridge === 'function'
        ? bridge(payload)
        : Promise.resolve({ success: true })
    },
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

interface TabtinStub {
  agentEngine?: {
    submitHitlBatch?: ReturnType<typeof vi.fn>
    submitAskUserResponse?: ReturnType<typeof vi.fn>
  }
  [key: string]: unknown
}

function installAgentEngineStub(): {
  submitHitlBatch: ReturnType<typeof vi.fn>
  submitAskUserResponse: ReturnType<typeof vi.fn>
} {
  const submitHitlBatch = vi.fn().mockResolvedValue({ success: true })
  const submitAskUserResponse = vi.fn().mockResolvedValue({ success: true })
  const currentTabtin = (globalThis as { window?: { tabtin?: TabtinStub } })
    .window?.tabtin ?? {}
  const nextTabtin: TabtinStub = {
    ...currentTabtin,
    agentEngine: { submitHitlBatch, submitAskUserResponse },
  }
  Object.defineProperty(window, 'tabtin', {
    value: nextTabtin,
    writable: true,
    configurable: true,
  })
  return { submitHitlBatch, submitAskUserResponse }
}

function removeAgentEngineStub() {
  const currentTabtin = (globalThis as { window?: { tabtin?: TabtinStub } })
    .window?.tabtin ?? {}
  const next: TabtinStub = { ...currentTabtin }
  delete next.agentEngine
  Object.defineProperty(window, 'tabtin', {
    value: next,
    writable: true,
    configurable: true,
  })
}

const buildPendingApproval = (overrides: Partial<ApprovalSliceStore['pendingApprovalBySessionId'][string]> = {}) => ({
  sessionId: 'session-a',
  threadId: 'thread-a',
  batchId: 'batch-a',
  actionRequests: [
    { request_id: 'req-1', tool_call_id: 'call-1', tool_name: 'list_directory' },
  ] as any,
  reviewConfigs: [],
  messageId: 'msg-a',
  message: 'approval a',
  ...overrides,
})

describe('Wave 11 HITL local-IPC routing', () => {
  beforeEach(() => {
    localStorage.removeItem('tabtin_local_runtime')
    removeAgentEngineStub()
  })

  afterEach(() => {
    removeAgentEngineStub()
    localStorage.removeItem('tabtin_local_runtime')
  })

  it('approval 默认走本地 IPC（submitHitlBatch），HTTP reviewAgent 完全不被调用', async () => {
    const { submitHitlBatch } = installAgentEngineStub()
    const reviewAgent = vi.fn()
    const addStreamingSession = vi.fn()

    const pending = buildPendingApproval()
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession,
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitApprovalDecisionsForSession('session-a', [
      { decision: 'approve', tool_call_id: 'call-1', scope: 'once' },
    ])

    expect(submitHitlBatch).toHaveBeenCalledTimes(1)
    expect(submitHitlBatch).toHaveBeenCalledWith(
      'batch-a',
      [{
        request_id: 'req-1',
        tool_call_id: 'call-1',
        outcome: 'allow',
        scope: 'once',
        rejection_message: undefined,
      }],
      'thread-a',
    )
    expect(reviewAgent).not.toHaveBeenCalled()
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
  })

  it('approval reject 默认走本地 IPC，outcome=deny', async () => {
    const { submitHitlBatch } = installAgentEngineStub()
    const reviewAgent = vi.fn()

    const pending = buildPendingApproval()
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitApprovalDecision('reject')

    expect(submitHitlBatch).toHaveBeenCalledWith(
      'batch-a',
      [{ request_id: 'req-1', tool_call_id: 'call-1', outcome: 'deny' }],
      'thread-a',
    )
    expect(reviewAgent).not.toHaveBeenCalled()
  })

  it('askUser submit 答案默认走本地 IPC（submitAskUserResponse 单 request 通道）', async () => {
    const { submitAskUserResponse } = installAgentEngineStub()
    const clientSubmit = vi.fn()

    const pending = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      questions: [],
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      message: 'ask a',
    }
    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingAskUser: pending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: { 'session-a': pending },
        askUserSubmittingBySessionId: {},
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { submitAskUserResponse: clientSubmit },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitAskUserAnswerForSession('session-a', [
      { question_id: 'q1', answer: 'yes' },
    ] as any)

    expect(submitAskUserResponse).toHaveBeenCalledTimes(1)
    expect(submitAskUserResponse).toHaveBeenCalledWith('interrupt-a', {
      answers: [{ question_id: 'q1', answer: 'yes' }],
    }, 'thread-a')
    expect(clientSubmit).not.toHaveBeenCalled()
    expect(stateRef.current.pendingAskUserBySessionId['session-a']).toBeUndefined()
  })

  it('askUser skip 默认走本地 IPC，且 skipped=true', async () => {
    const { submitAskUserResponse } = installAgentEngineStub()
    const clientSubmit = vi.fn()

    const pending = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      questions: [],
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      message: 'ask a',
    }
    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingAskUser: pending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: { 'session-a': pending },
        askUserSubmittingBySessionId: {},
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { submitAskUserResponse: clientSubmit },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.skipAskUserForSession('session-a')

    expect(submitAskUserResponse).toHaveBeenCalledWith('interrupt-a', { skipped: true }, 'thread-a')
    expect(clientSubmit).not.toHaveBeenCalled()
  })

  it('approval IPC 返回 success:false 时不清空面板且保留错误状态', async () => {
    const submitHitlBatch = vi.fn().mockResolvedValue({ success: false })
    const submitAskUserResponse = vi.fn()
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch, submitAskUserResponse } },
      writable: true,
      configurable: true,
    })
    const reviewAgent = vi.fn()

    const pending = buildPendingApproval()
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitApprovalDecision('approve')

    expect(submitHitlBatch).toHaveBeenCalledTimes(1)
    expect(reviewAgent).not.toHaveBeenCalled()
    // 关键断言：面板仍挂着 pending（防止用户误以为已通过）+ 记录错误文案
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeDefined()
    expect(stateRef.current.pendingApprovalBySessionId['session-a']?.submitError).toBeTruthy()
    expect(stateRef.current.approvalSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('approval 已被其它端处理时提交失败会清除本地 pending', async () => {
    const submitHitlBatch = vi.fn().mockResolvedValue({
      success: false,
      code: 'pending_not_found',
      error: 'No pending approval request on this runtime',
    })
    const submitAskUserResponse = vi.fn()
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch, submitAskUserResponse } },
      writable: true,
      configurable: true,
    })

    const pending = buildPendingApproval()
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: { 'session-a': true },
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent: vi.fn() },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitApprovalDecision('approve')

    expect(submitHitlBatch).toHaveBeenCalledTimes(1)
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.approvalSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('IPC 调用抛错时触发 catch 分支并记录 submitError（approval）', async () => {
    const submitHitlBatch = vi.fn().mockRejectedValue(new Error('IPC transport dead'))
    const submitAskUserResponse = vi.fn()
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch, submitAskUserResponse } },
      writable: true,
      configurable: true,
    })

    const pending = buildPendingApproval()
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent: vi.fn() },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitApprovalDecision('approve')

    expect(submitHitlBatch).toHaveBeenCalledTimes(1)
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeDefined()
    expect(stateRef.current.pendingApprovalBySessionId['session-a']?.submitError).toBe('IPC transport dead')
  })

  it('localStorage tabtin_local_runtime=false 时不走 IPC，并回填需要设备的提示（approval）', async () => {
    const { submitHitlBatch } = installAgentEngineStub()
    const reviewAgent = vi.fn().mockResolvedValue({ success: true })
    const updateSessionMessages = vi.fn()
    localStorage.setItem('tabtin_local_runtime', 'false')

    const pending = buildPendingApproval()
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages,
      },
    )

    await actions.submitApprovalDecision('approve')

    expect(submitHitlBatch).not.toHaveBeenCalled()
    expect(reviewAgent).not.toHaveBeenCalled()
    expect(updateSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('window.tabtin.agentEngine 不存在时回填需要设备的提示（preload 未注入场景）', async () => {
    removeAgentEngineStub()
    const reviewAgent = vi.fn().mockResolvedValue({ success: true })
    const updateSessionMessages = vi.fn()

    const pending = buildPendingApproval()
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: {},
      },
    }

    const actions = createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages,
      },
    )

    await actions.submitApprovalDecision('approve')

    expect(reviewAgent).not.toHaveBeenCalled()
    expect(updateSessionMessages).toHaveBeenCalledTimes(1)
  })

  it('askUser fields 模式在 IPC 可用时走 field_values IPC payload', async () => {
    const { submitAskUserResponse } = installAgentEngineStub()
    const clientSubmit = vi.fn()

    // 路径权限治理 W7 / A5 D6 真分立：pending 改为 discriminated union form fixture
    const pending = {
      kind: 'form' as const,
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      message: 'ask a',
      formMode: 'fields' as const,
      fields: [],
    }
    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingAskUser: pending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: { 'session-a': pending },
        askUserSubmittingBySessionId: {},
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { submitAskUserResponse: clientSubmit },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitAskUserFieldValuesForSession('session-a', {
      email: 'a@b.c',
      age: 42,
    })

    expect(submitAskUserResponse).toHaveBeenCalledWith('interrupt-a', {
      field_values: { email: 'a@b.c', age: 42 },
    }, 'thread-a')
    expect(clientSubmit).not.toHaveBeenCalled()
  })

  it('askUser text_fallback 模式在 IPC 可用时走 text IPC payload', async () => {
    const { submitAskUserResponse } = installAgentEngineStub()
    const clientSubmit = vi.fn()

    const pending = {
      kind: 'form' as const,
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      message: 'ask a',
      formMode: 'text_fallback' as const,
      fields: [],
    }
    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingAskUser: pending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: { 'session-a': pending },
        askUserSubmittingBySessionId: {},
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { submitAskUserResponse: clientSubmit },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitAskUserTextForSession('session-a', '请按这个方向继续')

    expect(submitAskUserResponse).toHaveBeenCalledWith('interrupt-a', {
      text: '请按这个方向继续',
    }, 'thread-a')
    expect(clientSubmit).not.toHaveBeenCalled()
    expect(stateRef.current.pendingAskUserBySessionId['session-a']).toBeUndefined()
  })

  it('askUser IPC 返回 success:false 时回填 submitError 并保留 pending', async () => {
    const submitAskUserResponse = vi.fn().mockResolvedValue({ success: false })
    const submitHitlBatch = vi.fn()
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch, submitAskUserResponse } },
      writable: true,
      configurable: true,
    })

    const pending = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      questions: [],
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      message: 'ask a',
    }
    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingAskUser: pending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: { 'session-a': pending },
        askUserSubmittingBySessionId: {},
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { submitAskUserResponse: vi.fn() },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitAskUserAnswerForSession('session-a', [])

    expect(submitAskUserResponse).toHaveBeenCalledTimes(1)
    expect(stateRef.current.pendingAskUserBySessionId['session-a']).toBeDefined()
    expect(stateRef.current.pendingAskUserBySessionId['session-a']?.submitError).toBeTruthy()
  })

  it('askUser 已被其它端处理时提交失败会清除本地 pending', async () => {
    const submitAskUserResponse = vi.fn().mockResolvedValue({
      success: false,
      code: 'pending_not_found',
      error: 'No pending ask_user request on this runtime',
    })
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch: vi.fn(), submitAskUserResponse } },
      writable: true,
      configurable: true,
    })

    const pending = {
      kind: 'form' as const,
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      formMode: 'fields' as const,
      fields: [],
    }
    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingAskUser: pending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: { 'session-a': pending },
        askUserSubmittingBySessionId: { 'session-a': true },
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { submitAskUserResponse: vi.fn() },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.submitAskUserFieldValuesForSession('session-a', {})

    expect(stateRef.current.pendingAskUserBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.askUserSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('askUser skip 未送达时也本地关闭 pending，避免僵尸弹窗', async () => {
    const submitAskUserResponse = vi.fn().mockResolvedValue({
      success: false,
      code: 'device_offline',
      error: 'No runtime device online for this session',
    })
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch: vi.fn(), submitAskUserResponse } },
      writable: true,
      configurable: true,
    })

    const pending = {
      sessionId: 'session-a',
      threadId: 'thread-a',
      interruptId: 'interrupt-a',
      questions: [],
      title: 'ask a',
      toolCallId: 'tool-a',
      messageId: 'msg-a',
      message: 'ask a',
    }
    const stateRef: { current: AskUserSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingAskUser: pending,
        isAskUserSubmitting: false,
        pendingAskUserBySessionId: { 'session-a': pending },
        askUserSubmittingBySessionId: { 'session-a': true },
      },
    }

    const actions = createAskUserActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { submitAskUserResponse: vi.fn() },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )

    await actions.skipAskUserForSession('session-a')

    expect(stateRef.current.pendingAskUserBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.askUserSubmittingBySessionId['session-a']).toBeUndefined()
  })
})

/**
 * ：审批提交失败状态机——区分「确认已失效需清」vs「未知错误保守保留」。
 *
 * 现象：用户点拒绝/允许 → WS 转发失败/超时 → renderer catch 拿到
 *   `{success:false, code:'WS_REQUEST_TIMEOUT'|'HITL_FORWARD_FAILED', error:'request timeout'}`
 *   → 旧 isAlreadyTerminalApprovalResponseError 不认这俩码 → 走 formatApprovalSubmitError
 *   只记 submitError 不清 pending → Composer 一直停在待确认态。
 *
 * 修复后三类分流：
 *   - terminal（pending_not_found 等）→ 清 pending（已有测试覆盖）
 *   - forward-failure（WS_REQUEST_TIMEOUT / HITL_FORWARD_FAILED / WS_IDLE_TIMEOUT）→ 清 pending
 *   - 未知（success:false 无 code / IPC 抛错无 code）→ 保留 pending + submitError（防假成功，
 *     兜底出口靠 ApprovalPanel 的 onDismiss 按钮调 dismissApprovalForSession）
 */
describe('Approval submit failure state machine ', () => {
  beforeEach(() => {
    localStorage.removeItem('tabtin_local_runtime')
    removeAgentEngineStub()
  })

  afterEach(() => {
    removeAgentEngineStub()
    localStorage.removeItem('tabtin_local_runtime')
  })

  function buildState(pendingOverrides: Partial<ApprovalSliceStore['pendingApprovalBySessionId'][string]> = {}) {
    const pending = buildPendingApproval(pendingOverrides)
    const stateRef: { current: ApprovalSliceStore } = {
      current: {
        currentSessionId: 'session-a',
        pendingApproval: pending,
        isApprovalSubmitting: false,
        pendingApprovalBySessionId: { 'session-a': pending },
        approvalSubmittingBySessionId: { 'session-a': true },
      },
    }
    return { pending, stateRef }
  }

  function installFailingSubmitHitlBatch(resolved: unknown) {
    const submitHitlBatch = vi.fn().mockResolvedValue(resolved)
    const submitAskUserResponse = vi.fn()
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch, submitAskUserResponse } },
      writable: true,
      configurable: true,
    })
    return submitHitlBatch
  }

  function buildActions(stateRef: { current: ApprovalSliceStore }) {
    return createApprovalActions(
      () => stateRef.current,
      createMutableSet(stateRef),
      {
        getChatClient: () => ({
          isStreaming: vi.fn(() => true),
          messages: { reviewAgent: vi.fn() },
        } as unknown as ChatClient),
      },
      {
        addStreamingSession: vi.fn(),
        updateSessionMessages: vi.fn(),
      },
    )
  }

  it('WS_REQUEST_TIMEOUT（issue 现象 "request timeout"）→ 清 pending 恢复输入', async () => {
    const submitHitlBatch = installFailingSubmitHitlBatch({
      success: false,
      code: 'WS_REQUEST_TIMEOUT',
      error: 'request timeout',
    })
    const { stateRef } = buildState()

    await buildActions(stateRef).submitApprovalDecision('approve')

    expect(submitHitlBatch).toHaveBeenCalledTimes(1)
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.approvalSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('HITL_FORWARD_FAILED → 清 pending 恢复输入', async () => {
    installFailingSubmitHitlBatch({
      success: false,
      code: 'HITL_FORWARD_FAILED',
      error: '提交未送达 Agent，请确认执行设备在线后重试',
    })
    const { stateRef } = buildState()

    await buildActions(stateRef).submitApprovalDecision('reject')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.approvalSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('WS_IDLE_TIMEOUT → 清 pending 恢复输入', async () => {
    installFailingSubmitHitlBatch({
      success: false,
      code: 'WS_IDLE_TIMEOUT',
      error: 'ws idle',
    })
    const { stateRef } = buildState()

    await buildActions(stateRef).submitApprovalDecision('approve')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
  })

  it('DELIVERY_TIMEOUT（ 幽灵卡签收超时）→ 清 pending 恢复输入', async () => {
    installFailingSubmitHitlBatch({
      success: false,
      code: 'delivery_timeout',
      error: 'Timed out waiting for runtime delivery acknowledgement',
    })
    const { stateRef } = buildState()

    await buildActions(stateRef).submitApprovalDecision('approve')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.approvalSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('success:false 无 code 仍保留 pending（防假成功保守策略，不破坏既有契约）', async () => {
    installFailingSubmitHitlBatch({ success: false })
    const { stateRef } = buildState()

    await buildActions(stateRef).submitApprovalDecision('approve')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeDefined()
    expect(stateRef.current.pendingApprovalBySessionId['session-a']?.submitError).toBeTruthy()
    expect(stateRef.current.approvalSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('IPC 抛错无 code 仍保留 pending + 记 submitError（兜底出口靠 onDismiss）', async () => {
    installFailingSubmitHitlBatch(new Error('IPC transport dead'))
    // mockResolvedValue(Error) 不会抛——改 mockRejectedValue 才走 catch。
    const submitHitlBatch = vi.fn().mockRejectedValue(new Error('IPC transport dead'))
    const currentTabtin = (window as { tabtin?: TabtinStub }).tabtin ?? {}
    Object.defineProperty(window, 'tabtin', {
      value: { ...currentTabtin, agentEngine: { submitHitlBatch, submitAskUserResponse: vi.fn() } },
      writable: true,
      configurable: true,
    })
    const { stateRef } = buildState()

    await buildActions(stateRef).submitApprovalDecision('approve')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeDefined()
    expect(stateRef.current.pendingApprovalBySessionId['session-a']?.submitError).toBe('IPC transport dead')
  })

  it('dismissApprovalForSession(expired) 清 pending（onExpired 倒计时归零调入）', () => {
    const { stateRef } = buildState()
    const actions = buildActions(stateRef)

    actions.dismissApprovalForSession('session-a', 'expired')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
    expect(stateRef.current.approvalSubmittingBySessionId['session-a']).toBeUndefined()
  })

  it('dismissApprovalForSession(manual) 清 pending（用户点"放弃审批"按钮调入）', () => {
    const { stateRef } = buildState()
    const actions = buildActions(stateRef)

    actions.dismissApprovalForSession('session-a', 'manual')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
  })

  it('dismissApprovalForSession 幂等：pending 已清再调 no-op（防 onExpired tick 重入）', () => {
    const { stateRef } = buildState()
    const actions = buildActions(stateRef)

    actions.dismissApprovalForSession('session-a', 'expired')
    actions.dismissApprovalForSession('session-a', 'expired')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
  })

  it('dismissApproval 用 currentSessionId 路由到 dismissApprovalForSession', () => {
    const { stateRef } = buildState()
    const actions = buildActions(stateRef)

    actions.dismissApproval('manual')

    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
  })
})
