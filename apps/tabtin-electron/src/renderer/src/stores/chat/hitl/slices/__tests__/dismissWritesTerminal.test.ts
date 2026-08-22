/**
 * （第二刀）：renderer dismiss → cancel-hitl IPC 路由验证。
 *
 * 覆盖两条 dismiss 路径：
 *   1. `approvalSlice.dismissApprovalForSession(sessionId, 'expired' | 'manual')`
 *      → 触发 `agentEngine.cancelHitlInteraction({ kind: 'approval', requestKey: batchId })`
 *      → 让 runtime 发 HitlInteractionEvent(status='cancelled')，让 Django + 其它端
 *      的 hitl_interaction 消息终态与本地 UI 对齐。
 *   2. `askUserSlice.skipAskUserForSession(sessionId)` 的 IPC 失败降级路径
 *      → catch 里补一次 `cancelHitlInteraction({ kind: 'ask', requestKey: interruptId })`
 *      → 收敛 pending 为 cancelled 终态。
 *
 * 与既有 `hitlLocalIpcRouting.test.ts` 的分工：该文件验「submit 走 IPC」，
 * 本文件验「dismiss 也走 IPC 写回终态」——第二刀新增的行为。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatClient } from '@tabtin/chat-client'

vi.mock('@/services/agentService', () => ({
  getSessionController: () => ({
    submitApproval: (...args: unknown[]) =>
      (globalThis as { window: { tabtin: { agentEngine: { submitHitlBatch: (...a: unknown[]) => unknown } } } })
        .window.tabtin.agentEngine.submitHitlBatch(...args),
    answerAskUser: (...args: unknown[]) =>
      (globalThis as { window: { tabtin: { agentEngine: { submitAskUserResponse: (...a: unknown[]) => unknown } } } })
        .window.tabtin.agentEngine.submitAskUserResponse(...args),
    cancelHitlInteraction: (payload: unknown) =>
      (globalThis as { window: { tabtin: { agentEngine: { cancelHitlInteraction: (p: unknown) => unknown } } } })
        .window.tabtin.agentEngine.cancelHitlInteraction(payload),
  }),
}))

import { createAskUserActions, type AskUserSliceStore } from '../askUserSlice'
import { createApprovalActions, type ApprovalSliceStore } from '../approvalSlice'

function createMutableSet<State extends object>(stateRef: { current: State }) {
  return (partial: Partial<State> | ((state: State) => Partial<State>)) => {
    const update = typeof partial === 'function' ? partial(stateRef.current) : partial
    stateRef.current = { ...stateRef.current, ...update }
  }
}

interface TabtinStub {
  agentEngine?: {
    submitHitlBatch?: ReturnType<typeof vi.fn>
    submitAskUserResponse?: ReturnType<typeof vi.fn>
    cancelHitlInteraction?: ReturnType<typeof vi.fn>
  }
  [key: string]: unknown
}

function installStub(overrides: {
  submitAskUserResponse?: ReturnType<typeof vi.fn>
  cancelHitlInteraction?: ReturnType<typeof vi.fn>
} = {}) {
  const submitHitlBatch = vi.fn().mockResolvedValue({ success: true })
  const submitAskUserResponse = overrides.submitAskUserResponse
    ?? vi.fn().mockResolvedValue({ success: true })
  const cancelHitlInteraction = overrides.cancelHitlInteraction
    ?? vi.fn().mockResolvedValue({ success: true })
  const currentTabtin = (globalThis as { window?: { tabtin?: TabtinStub } })
    .window?.tabtin ?? {}
  const nextTabtin: TabtinStub = {
    ...currentTabtin,
    agentEngine: { submitHitlBatch, submitAskUserResponse, cancelHitlInteraction },
  }
  Object.defineProperty(window, 'tabtin', {
    value: nextTabtin,
    writable: true,
    configurable: true,
  })
  return { submitHitlBatch, submitAskUserResponse, cancelHitlInteraction }
}

function removeStub() {
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

const buildPendingApproval = () => ({
  sessionId: 'session-a',
  threadId: 'thread-a',
  batchId: 'batch-a',
  actionRequests: [
    { request_id: 'req-1', tool_call_id: 'call-1', tool_name: 'list_directory' },
  ] as any,
  reviewConfigs: [],
  messageId: 'msg-a',
  message: 'approval a',
})

describe(' 第二刀 · dismiss 写回 HITL 终态', () => {
  beforeEach(() => {
    localStorage.removeItem('tabtin_local_runtime')
    removeStub()
  })
  afterEach(() => {
    removeStub()
    localStorage.removeItem('tabtin_local_runtime')
  })

  it('approval 手动 dismiss → 调 cancelHitlInteraction(kind=approval)', () => {
    const { cancelHitlInteraction } = installStub()
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
      { getChatClient: () => ({} as unknown as ChatClient) },
      { addStreamingSession: vi.fn(), updateSessionMessages: vi.fn() },
    )
    actions.dismissApprovalForSession('session-a', 'manual')

    expect(cancelHitlInteraction).toHaveBeenCalledTimes(1)
    expect(cancelHitlInteraction).toHaveBeenCalledWith({
      kind: 'approval',
      requestKey: 'batch-a',
      reason: 'User dismissed the approval panel manually.',
    })
    // 本地 UI 状态也清了（不因等 IPC 而卡死 Composer）
    expect(stateRef.current.pendingApprovalBySessionId['session-a']).toBeUndefined()
  })

  it('approval 自然过期 dismiss → 走 cancelHitlInteraction + reason=timeout 语义', () => {
    const { cancelHitlInteraction } = installStub()
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
      { getChatClient: () => ({} as unknown as ChatClient) },
      { addStreamingSession: vi.fn(), updateSessionMessages: vi.fn() },
    )
    actions.dismissApprovalForSession('session-a', 'expired')

    expect(cancelHitlInteraction).toHaveBeenCalledWith({
      kind: 'approval',
      requestKey: 'batch-a',
      reason: 'Approval panel timed out on the client UI.',
    })
  })

  it('askUser skip IPC 失败 → catch 里补一次 cancelHitlInteraction(kind=ask)', async () => {
    const submitAskUserResponse = vi.fn().mockRejectedValueOnce(new Error('boom'))
    const { cancelHitlInteraction } = installStub({ submitAskUserResponse })

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
      { getChatClient: () => ({ isStreaming: vi.fn(() => false) } as unknown as ChatClient) },
      { addStreamingSession: vi.fn(), updateSessionMessages: vi.fn() },
    )

    await actions.skipAskUserForSession('session-a')

    expect(submitAskUserResponse).toHaveBeenCalledWith(
      'interrupt-a',
      { skipped: true },
      'thread-a',
    )
    // skip IPC 失败后 cancel-hitl 兜底
    expect(cancelHitlInteraction).toHaveBeenCalledWith({
      kind: 'ask',
      requestKey: 'interrupt-a',
      reason: 'Ask panel closed locally after skip IPC failed.',
    })
    // 面板同步清（对齐 skipAskUser 原语义：本机关掉但不确认 Agent 收到）
    expect(stateRef.current.pendingAskUserBySessionId['session-a']).toBeUndefined()
  })
})
