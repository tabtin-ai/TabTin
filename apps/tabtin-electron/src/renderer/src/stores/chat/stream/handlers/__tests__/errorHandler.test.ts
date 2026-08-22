/**
 * errorHandler 单测 —  后仅 telemetry，不再 inject 气泡。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  extractProxyErrorMessage,
  isFromProxySSEError,
  injectSystemBubbleIfNeeded,
  handleError,
} from '../errorHandler'
import { registerChatStoreCallbacks } from '../../../shared/storeAccessRegistry'

vi.mock('@tabtin/ws-gateway-client', () => ({
  AgentStreamEvents: {
    DONE: 'agent.stream.done',
    LIFECYCLE: 'agent.stream.lifecycle',
  },
}))

const mockUpdateSessionMessages = vi.fn()

function registerMockCallbacks() {
  registerChatStoreCallbacks({
    isSessionBusy: () => false,
    getStreamingSessionIds: () => [],
    getCurrentSessionId: () => null,
    syncSessionMessagesFromServer: () => {},
    getSessionsBySpaceId: () => ({}),
    updateSessionTitleInCaches: vi.fn(),
    upsertSessionInSpace: vi.fn(),
    injectErrorBubble: (sid: string, message: ChatMessage) =>
      mockUpdateSessionMessages(sid, (prev: ChatMessage[]) => [...prev, message]),
    upsertObservedUserMessage: vi.fn(),
    linkServerMessageId: vi.fn(),
    rebindMessageIds: vi.fn(),
  })
}

vi.mock('@/i18n', () => ({
  default: { t: (key: string) => key },
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(),
  }),
}))

function makeCtx() {
  return {
    sessionId: 'sess-test-1234',
    spaceId: 'space-1',
    notifyPrefix: '',
    sessionTitle: '',
    get: () => ({
      agentStepsBySessionId: {},
      toolEventsBySessionId: {},
      assistantEventsBySessionId: {},
      subagentRunsBySessionId: {},
      runStateBySessionId: {},
      todosBySessionId: {},
      agentModeBySessionId: {},
      cancellingBySessionId: {},
    } as any),
    set: vi.fn() as any,
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: { sessions: { get: vi.fn() } } as any,
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
  } as any
}

beforeEach(() => {
  mockUpdateSessionMessages.mockReset()
  registerMockCallbacks()
})

describe('extractProxyErrorMessage', () => {
  it('优先 error_message', () => {
    expect(extractProxyErrorMessage({
      error_message: '点券已用完',
      error: 'fallback',
    })).toBe('点券已用完')
  })

  it('回落 errorMessage / detail / error 字符串', () => {
    expect(extractProxyErrorMessage({ errorMessage: 'a' })).toBe('a')
    expect(extractProxyErrorMessage({ detail: 'b' })).toBe('b')
    expect(extractProxyErrorMessage({ error: 'c' })).toBe('c')
  })
})

describe('isFromProxySSEError', () => {
  it('LLM_BILLING_ERROR + 组织文案 → true', () => {
    expect(isFromProxySSEError({
      error_class: 'LLM_BILLING_ERROR',
      error_message: '[organization_insufficient_credits] 本月 LLM 点券已用完，请联系组织管理员',
    })).toBe(true)
  })

  it('非 LLM_* 类 → false', () => {
    expect(isFromProxySSEError({
      error_class: 'ABORT',
      error_message: '组织点券',
    })).toBe(false)
  })
})

describe('injectSystemBubbleIfNeeded ·  no-op', () => {
  it('不再调用 injectErrorBubble', async () => {
    injectSystemBubbleIfNeeded(
      {
        type: 'agent.stream.lifecycle',
        payload: {
          phase: 'error',
          error_class: 'LLM_BILLING_ERROR',
          error_message: '本月 LLM 点券已用完，请联系组织管理员',
        },
      } as any,
      makeCtx(),
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(mockUpdateSessionMessages).not.toHaveBeenCalled()
  })
})

describe('handleError ·  telemetry only', () => {
  it('phase=error 不 inject 气泡', async () => {
    handleError(
      {
        type: 'agent.stream.lifecycle',
        payload: {
          phase: 'error',
          error_class: 'LLM_BILLING_ERROR',
          error_message: '本月 LLM 点券已用完，请联系组织管理员',
        },
      } as any,
      makeCtx(),
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(mockUpdateSessionMessages).not.toHaveBeenCalled()
  })

  it('DONE 错误也不 inject（写手是 finalizeDoneEvent）', async () => {
    handleError(
      {
        type: 'agent.stream.done',
        payload: {
          error: true,
          error_class: 'LLM_ERROR',
          error_message: '上游服务返回错误(502)。',
        },
      } as any,
      makeCtx(),
    )
    await new Promise((r) => setTimeout(r, 30))
    expect(mockUpdateSessionMessages).not.toHaveBeenCalled()
  })
})
