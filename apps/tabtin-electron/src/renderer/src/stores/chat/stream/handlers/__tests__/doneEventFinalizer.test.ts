/**
 * ：DONE 收尾对硬停 / ABORT 的 metadata 写入。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'

const storeState = {
  messagesBySessionId: {} as Record<string, ChatMessage[]>,
  ensureAssistantMessage: (sessionId: string, message: ChatMessage) => {
    const prev = storeState.messagesBySessionId[sessionId] ?? []
    if (prev.some((m) => m.id === message.id)) return
    storeState.messagesBySessionId = {
      ...storeState.messagesBySessionId,
      [sessionId]: [...prev, message],
    }
  },
  patchMessageById: (
    sessionId: string,
    messageId: string,
    patcher: (message: ChatMessage) => ChatMessage,
  ) => {
    const prev = storeState.messagesBySessionId[sessionId] ?? []
    storeState.messagesBySessionId = {
      ...storeState.messagesBySessionId,
      [sessionId]: prev.map((m) => (m.id === messageId ? patcher(m) : m)),
    }
  },
}

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector?: (s: typeof storeState) => unknown) => (
      typeof selector === 'function' ? selector(storeState) : storeState
    ),
    {
      getState: () => storeState,
      setState: (updater: (s: typeof storeState) => Partial<typeof storeState> | typeof storeState) => {
        const next = typeof updater === 'function' ? updater(storeState) : updater
        Object.assign(storeState, next)
      },
    },
  ),
}))

vi.mock('@tabtin/agent-host/delivery/usage-metadata-projection', () => ({
  projectUsageMetadata: () => ({}),
}))

vi.mock('../../../messages/actions/sendDispatchInputs', () => ({
  buildLiveUsageJsonFromDoneUsage: () => undefined,
}))

vi.mock('../assistantSessionState', () => ({
  consumeAssistantErrorMeta: () => undefined,
}))

import {
  __resetActiveRunBindingsForTest,
  bindActiveRun,
  snapshotInterruptedBinding,
} from '../../../execution/activeRunBinding'
import { finalizeDoneEvent } from '../doneEventFinalizer'

describe('finalizeDoneEvent · ', () => {
  beforeEach(() => {
    __resetActiveRunBindingsForTest()
    storeState.messagesBySessionId = {
      'session-1': [
        {
          id: 'user-1',
          role: 'user',
          content: '提问',
          created_at: '2026-07-20T00:00:00.000Z',
          client_event_id: '11111111-1111-4111-8111-111111111111',
          sendStatus: 'sending',
        } as ChatMessage,
        {
          id: 'ai-1',
          role: 'assistant',
          content: '半截回复',
          created_at: '2026-07-20T00:00:00.000Z',
        } as ChatMessage,
      ],
    }
  })

  it('#6714：只认 source_client_event_id；trace_id ≠ client 时也能标 sent', () => {
    finalizeDoneEvent('session-1', {
      error: false,
      trace_id: '9796076a-2faa-48ba-957b-ea76667a05be',
      source_client_event_id: '11111111-1111-4111-8111-111111111111',
    })
    const user = storeState.messagesBySessionId['session-1'][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sent')
  })

  it('#6714 反例：仅有 trace_id 且等于 client 也不标 sent（禁止错键）', () => {
    finalizeDoneEvent('session-1', {
      error: false,
      // 刻意等于 client_event_id——旧逻辑会误标；新逻辑要求 source_client_event_id
      trace_id: '11111111-1111-4111-8111-111111111111',
    })
    const user = storeState.messagesBySessionId['session-1'][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sending')
  })

  it('text_loop_terminated（error:false）写入 errorClass，供 warning 卡渲染', () => {
    finalizeDoneEvent('session-1', {
      error: false,
      error_class: 'text_loop_terminated',
      hard_stop_source: 'text_repetition',
      content: '',
    })
    const ai = storeState.messagesBySessionId['session-1'].find(m => m.role === 'assistant') as ChatMessage & {
      metadata?: Record<string, unknown>
    }
    expect(ai.metadata?.errorClass).toBe('text_loop_terminated')
    expect(ai.metadata?.hardStopSource).toBe('text_repetition')
    expect(ai.metadata?.aborted).toBeUndefined()
    expect(ai.metadata?.isErrorMessage).toBe(true)
  })

  it('父 DONE 收尾只写主 Agent assistant，不污染最后一条子 Agent transcript', () => {
    storeState.messagesBySessionId['session-1'] = [
      {
        id: 'user-1',
        role: 'user',
        content: '提问',
        created_at: '2026-07-20T00:00:00.000Z',
      } as ChatMessage,
      {
        id: 'ai-parent',
        role: 'assistant',
        content: '主线回复',
        created_at: '2026-07-20T00:00:01.000Z',
      } as ChatMessage,
      {
        id: 'ai-child',
        role: 'assistant',
        content: '子代理详情',
        created_at: '2026-07-20T00:00:02.000Z',
        subagent_run_id: 'subagent-run-1',
      } as ChatMessage,
    ]

    finalizeDoneEvent('session-1', {
      error: false,
      error_class: 'text_loop_terminated',
    })

    const parent = storeState.messagesBySessionId['session-1'].find(m => m.id === 'ai-parent') as ChatMessage & {
      metadata?: Record<string, unknown>
    }
    const child = storeState.messagesBySessionId['session-1'].find(m => m.id === 'ai-child') as ChatMessage & {
      metadata?: Record<string, unknown>
    }
    expect(parent.metadata?.errorClass).toBe('text_loop_terminated')
    expect(child.metadata?.errorClass).toBeUndefined()
  })

  it('ABORT 写入 errorClass + aborted，不落 Run aborted 文案（ 静默+徽标）', () => {
    finalizeDoneEvent('session-1', {
      error: true,
      error_class: 'ABORT',
      error_message: 'Run aborted by user',
    })
    const ai = storeState.messagesBySessionId['session-1'].find(m => m.role === 'assistant') as ChatMessage & {
      metadata?: Record<string, unknown>
    }
    expect(ai.metadata?.errorClass).toBe('ABORT')
    expect(ai.metadata?.aborted).toBe(true)
    expect(ai.metadata?.errorMessage).toBeUndefined()
    // ABORT 不算 isErrorMessage（与历史 onDone 语义一致）
    expect(ai.metadata?.isErrorMessage).toBeUndefined()
  })

  it.each([
    ['tool_loop_terminated', 'tool_failure_loop'],
    ['MAX_CREDITS_EXCEEDED', undefined],
  ] as const)('%s（error:false）写入 errorClass 且非 aborted', (errorClass, hardStop) => {
    finalizeDoneEvent('session-1', {
      error: false,
      error_class: errorClass,
      ...(hardStop ? { hard_stop_source: hardStop } : {}),
    })
    const ai = storeState.messagesBySessionId['session-1'].find(m => m.role === 'assistant') as ChatMessage & {
      metadata?: Record<string, unknown>
    }
    expect(ai.metadata?.errorClass).toBe(errorClass)
    expect(ai.metadata?.aborted).toBeUndefined()
    expect(ai.metadata?.isErrorMessage).toBe(true)
    if (hardStop) expect(ai.metadata?.hardStopSource).toBe(hardStop)
  })

  it('#9341 无助手壳时 LLM_BILLING_ERROR 创建载体并写 error_info_json', () => {
    storeState.messagesBySessionId['session-1'] = [
      {
        id: 'user-1',
        role: 'user',
        content: '提问',
        created_at: '2026-07-20T00:00:00.000Z',
      } as ChatMessage,
    ]
    finalizeDoneEvent('session-1', {
      error: true,
      error_class: 'LLM_BILLING_ERROR',
      error_category: 'organization_insufficient_credits',
      error_message: '[organization_insufficient_credits] 本月 LLM 点券已用完',
      suggested_action: 'check_billing',
      client_event_id: 'assistant-terminal-1',
    })
    const assistants = storeState.messagesBySessionId['session-1'].filter(m => m.role === 'assistant')
    expect(assistants).toHaveLength(1)
    expect(assistants[0]?.id).toBe('assistant-terminal-1')
    const ai = assistants[0] as ChatMessage & {
      metadata?: Record<string, unknown>
      error_info_json?: Record<string, unknown>
    }
    expect(ai.metadata?.isErrorMessage).toBe(true)
    expect(ai.metadata?.errorClass).toBe('LLM_BILLING_ERROR')
    expect(ai.metadata?.errorCategory).toBe('organization_insufficient_credits')
    expect(ai.error_info_json?.error_class).toBe('LLM_BILLING_ERROR')
    expect(ai.error_info_json?.category).toBe('organization_insufficient_credits')
    expect(ai.error_info_json?.partial_reason).toBe('message_stop_fallback')
  })

  it('#9341 多轮对话当前轮无助手壳时保留历史回复并创建当前轮载体', () => {
    storeState.messagesBySessionId['session-1'] = [
      {
        id: 'user-previous',
        role: 'user',
        content: '上一轮提问',
        created_at: '2026-07-20T00:00:00.000Z',
      } as ChatMessage,
      {
        id: 'assistant-previous',
        role: 'assistant',
        content: '上一轮正常回复',
        created_at: '2026-07-20T00:00:01.000Z',
      } as ChatMessage,
      {
        id: 'user-current',
        role: 'user',
        content: '本轮提问',
        created_at: '2026-07-20T00:00:02.000Z',
      } as ChatMessage,
    ]

    finalizeDoneEvent('session-1', {
      error: true,
      error_class: 'LLM_BILLING_ERROR',
      error_category: 'organization_insufficient_credits',
      error_message: '[organization_insufficient_credits] 本月 LLM 点券已用完',
      client_event_id: 'assistant-current',
    })

    const messages = storeState.messagesBySessionId['session-1']
    const previous = messages.find((message) => message.id === 'assistant-previous')
    const current = messages.find((message) => message.id === 'assistant-current')
    expect(previous?.content).toBe('上一轮正常回复')
    expect(previous?.error_info_json).toBeUndefined()
    expect(current?.error_info_json?.error_class).toBe('LLM_BILLING_ERROR')
    expect(messages.filter((message) => message.role === 'assistant')).toHaveLength(2)
  })

  it('#9341 ABORT 且无助手壳时不造气泡', () => {
    storeState.messagesBySessionId['session-1'] = [
      {
        id: 'user-1',
        role: 'user',
        content: '提问',
        created_at: '2026-07-20T00:00:00.000Z',
      } as ChatMessage,
    ]
    finalizeDoneEvent('session-1', {
      error: true,
      error_class: 'ABORT',
      error_message: 'Run aborted by user',
    })
    expect(storeState.messagesBySessionId['session-1'].filter(m => m.role === 'assistant')).toHaveLength(0)
  })
})

describe('finalizeDoneEvent ·  sendStatus', () => {
  beforeEach(() => {
    storeState.messagesBySessionId = {
      'session-1': [
        {
          id: '41319f8c-adb8-484e-8c6d-20d815b8b6bd',
          role: 'user',
          content: '你好',
          created_at: '2026-07-22T00:00:00.000Z',
          metadata: { client_message_id: '41319f8c-adb8-484e-8c6d-20d815b8b6bd' },
          sendStatus: 'sending',
        } as ChatMessage,
        {
          id: 'ai-1',
          role: 'assistant',
          content: '你好！',
          created_at: '2026-07-22T00:00:01.000Z',
        } as ChatMessage,
      ],
    }
  })

  it('source_client_event_id 匹配时将用户消息标 sent（即使 trace_id 不同）', () => {
    finalizeDoneEvent('session-1', {
      trace_id: '7819e4b7-aaaa-bbbb-cccc-ddddeeeeffff',
      source_client_event_id: '41319f8c-adb8-484e-8c6d-20d815b8b6bd',
    })
    const user = storeState.messagesBySessionId['session-1'][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sent')
  })

  it('仅有与 client_message_id 不等的 trace_id 时保持 sending（禁止假匹配）', () => {
    finalizeDoneEvent('session-1', {
      trace_id: '7819e4b7-aaaa-bbbb-cccc-ddddeeeeffff',
    })
    const user = storeState.messagesBySessionId['session-1'][0] as ChatMessage & {
      sendStatus?: string
    }
    expect(user.sendStatus).toBe('sending')
  })
})

describe('finalizeDoneEvent ·  ActiveRunBinding ABORT', () => {
  beforeEach(() => {
    __resetActiveRunBindingsForTest()
    storeState.messagesBySessionId = {
      'session-1': [
        {
          id: 'ai-old',
          role: 'assistant',
          content: '旧半截',
          created_at: '2026-07-20T00:00:00.000Z',
          agent_run_id: 'run-old',
        } as ChatMessage,
        {
          id: 'user-2',
          role: 'user',
          content: '插队',
          created_at: '2026-07-20T00:00:01.000Z',
        } as ChatMessage,
        {
          id: 'ai-new',
          role: 'assistant',
          content: '',
          created_at: '2026-07-20T00:00:02.000Z',
          agent_run_id: 'run-new',
        } as ChatMessage,
      ],
    }
  })

  it('ABORT DONE 无 message_id 时标 interrupted 快照对应泡，不标最后一条', () => {
    bindActiveRun('session-1', { runId: 'run-old', assistantMessageId: 'ai-old' })
    snapshotInterruptedBinding('session-1')
    bindActiveRun('session-1', { runId: 'run-new', assistantMessageId: 'ai-new' })

    finalizeDoneEvent('session-1', {
      run_id: 'run-old',
      error: true,
      error_class: 'ABORT',
      stop_reason: 'aborted',
    })

    const msgs = storeState.messagesBySessionId['session-1']
    const oldMsg = msgs.find((m) => m.id === 'ai-old') as ChatMessage & {
      metadata?: { aborted?: boolean }
    }
    const newMsg = msgs.find((m) => m.id === 'ai-new') as ChatMessage & {
      metadata?: { aborted?: boolean }
    }
    expect(oldMsg.metadata?.aborted).toBe(true)
    expect(newMsg.metadata?.aborted).toBeUndefined()
  })
})
