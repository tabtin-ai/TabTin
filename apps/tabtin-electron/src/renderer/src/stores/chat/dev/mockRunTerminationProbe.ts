/**
 * DEV-only：暴露活的 chat store + 模拟 run 终止 DONE，供 CDP / 控制台验证
 * 异常停止气泡。动态 import 可能拿到 HMR 分裂的空 store，必须走本探针。
 */
import type { ChatMessage } from '@tabtin/chat-client'
import { useChatStore } from '../useChatStore'
import { useChatRuntimeStore, flushRuntimeBatch } from '../../useChatRuntimeStore'
import { flushSubagentLiveBatch, useSubagentLiveStore } from '../../subagentLive'
import { useSubagentSessionStore } from '../../subagentSession'
import { finalizeDoneEvent } from '../stream/handlers/doneEventFinalizer'
import { endSessionRun } from '../stream/handlers/sessionCleanup'
import { applyRuntimeRunSync, isSessionBusy } from '../execution/sessionRunProjection'

export type MockRunTerminationResult = {
  ok: boolean
  reason?: string
  sid?: string
  assistantId?: string
  errorClass?: string
  aborted?: boolean
  errorMessage?: string
}

export type MockRunTerminationOptions = {
  /** 默认 true：清空当前会话消息，只留一条新 assistant，避免多卡叠在 DOM 里。 */
  isolate?: boolean
}

const DEFAULT_HARD_STOP_PAYLOAD: Record<string, unknown> = {
  error: false,
  error_class: 'text_loop_terminated',
  hard_stop_source: 'text_repetition',
}

/**  / 终止反馈：需逐条 live mock 的异常（含对照：ABORT 静默、UNKNOWN 兜底）。 */
export const RUN_TERMINATION_LIVE_CASES: Array<{
  id: string
  payload: Record<string, unknown>
  /** 期望出现的卡片标题；null 表示不应出 ErrorClassCard（仅灰色「已中断」）。 */
  expectTitle: string | null
  expectUnknown: boolean
  expectInterruptedBadge: boolean
  note?: string
}> = [
  {
    id: 'text_loop_terminated',
    payload: {
      error: false,
      error_class: 'text_loop_terminated',
      hard_stop_source: 'text_repetition',
    },
    expectTitle: '已自动停止',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'tool_loop_terminated',
    payload: {
      error: false,
      error_class: 'tool_loop_terminated',
      hard_stop_source: 'tool_failure_loop',
    },
    expectTitle: '已自动停止',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'MAX_CREDITS_EXCEEDED',
    payload: {
      error: false,
      error_class: 'MAX_CREDITS_EXCEEDED',
      suggested_action: 'check_billing',
    },
    expectTitle: '已达运行上限，已中止',
    expectUnknown: false,
    expectInterruptedBadge: false,
    note: '#5026 /  运行预算墙',
  },
  {
    id: 'ABORT',
    payload: {
      error: true,
      error_class: 'ABORT',
      error_message: 'Run aborted by user.',
    },
    expectTitle: null,
    expectUnknown: false,
    expectInterruptedBadge: true,
    note: '手动停止：静默 + 灰色已中断',
  },
  {
    id: 'LLM_PROVIDER_ERROR',
    payload: { error: true, error_class: 'LLM_PROVIDER_ERROR' },
    expectTitle: '模型服务暂时不可用',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'LLM_ERROR',
    payload: { error: true, error_class: 'LLM_ERROR' },
    expectTitle: '模型服务暂时不可用',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'NETWORK_ERROR',
    payload: { error: true, error_class: 'NETWORK_ERROR' },
    expectTitle: '网络连接异常',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'LLM_CAPABILITY_GATE',
    payload: {
      error: true,
      error_class: 'LLM_ERROR',
      suggested_action: 'switch_model',
      error_extras: { stage: 'capability_gate' },
    },
    expectTitle: '模型能力不匹配',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'LLM_IMAGE_FETCH_FAILED',
    payload: {
      error: true,
      error_class: 'LLM_ERROR',
      error_extras: { stage: 'image_fetch' },
    },
    expectTitle: '图片下载失败',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'CONTEXT_OVERFLOW',
    payload: { error: true, error_class: 'CONTEXT_OVERFLOW' },
    expectTitle: '对话内容过长',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'TOOL_EXECUTION_ERROR',
    payload: { error: true, error_class: 'TOOL_EXECUTION_ERROR' },
    expectTitle: '工具执行出错',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'iteration_budget_exhausted',
    payload: { error: true, error_class: 'iteration_budget_exhausted' },
    expectTitle: '任务已完成（达到执行上限）',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'token_budget_exhausted',
    payload: { error: true, error_class: 'token_budget_exhausted' },
    expectTitle: '对话用量已达上限',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'BUDGET_EXHAUSTED',
    payload: { error: true, error_class: 'BUDGET_EXHAUSTED' },
    expectTitle: '配额已用完',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'RATE_LIMITED',
    payload: { error: true, error_class: 'RATE_LIMITED' },
    expectTitle: '该模型暂无法使用',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'INTERNAL',
    payload: { error: true, error_class: 'INTERNAL' },
    expectTitle: '内部错误',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'LLM_KEY_EXHAUSTED',
    payload: { error: true, error_class: 'LLM_KEY_EXHAUSTED' },
    expectTitle: '当前渠道暂时不可用',
    expectUnknown: false,
    expectInterruptedBadge: false,
  },
  {
    id: 'UNKNOWN_FALLBACK',
    payload: { error: true, error_class: 'SOME_UNMAPPED_ERROR_CLASS_6116' },
    expectTitle: '出了点问题',
    expectUnknown: true,
    expectInterruptedBadge: false,
    note: '未映射 class → UNKNOWN 兜底',
  },
]

function createMockAssistant(label: string): ChatMessage {
  const id = `mock-asst-6116-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  return {
    id,
    role: 'assistant',
    content: label,
    content_blocks_json: [{ type: 'text', text: label }],
    created_at: new Date().toISOString(),
  } as ChatMessage
}

function ensureAssistantMessage(sessionId: string, isolate: boolean): string {
  if (isolate) {
    const assistant = createMockAssistant('【6116-termination-mock】半截回复')
    useChatStore.setState(state => ({
      messagesBySessionId: {
        ...state.messagesBySessionId,
        [sessionId]: [assistant],
      },
    }))
    return assistant.id
  }

  const messages = useChatStore.getState().messagesBySessionId[sessionId] ?? []
  const existing = [...messages].reverse().find(message => message.role === 'assistant')
  if (existing?.id) return existing.id

  const assistant = createMockAssistant('【6116-hardstop-mock】半截回复 1\n2\n3')
  useChatStore.setState(state => ({
    messagesBySessionId: {
      ...state.messagesBySessionId,
      [sessionId]: [...(state.messagesBySessionId[sessionId] ?? []), assistant],
    },
  }))
  return assistant.id
}

export function mockRunTermination(
  payload: Record<string, unknown> = DEFAULT_HARD_STOP_PAYLOAD,
  options: MockRunTerminationOptions = {},
): MockRunTerminationResult {
  const isolate = options.isolate !== false
  const sid = useChatStore.getState().currentSessionId
  if (!sid) return { ok: false, reason: 'NO_SESSION' }

  const assistantId = ensureAssistantMessage(sid, isolate)
  finalizeDoneEvent(sid, payload)

  // ABORT：补 intent，与 abortStream 打标对齐，保证灰色徽标路径可测。
  if (payload.error_class === 'ABORT') {
    useChatStore.setState(state => ({
      messagesBySessionId: {
        ...state.messagesBySessionId,
        [sid]: (state.messagesBySessionId[sid] ?? []).map(message =>
          message.id === assistantId
            ? { ...message, intent: 'interrupted' as const }
            : message,
        ),
      },
    }))
  }

  const messages = useChatStore.getState().messagesBySessionId[sid] ?? []
  const assistant = messages.find(message => message.id === assistantId) as
    | (ChatMessage & { metadata?: Record<string, unknown> })
    | undefined
  const meta = (assistant?.metadata ?? {}) as Record<string, unknown>

  return {
    ok: true,
    sid,
    assistantId,
    errorClass: typeof meta.errorClass === 'string' ? meta.errorClass : undefined,
    aborted: meta.aborted === true,
    errorMessage: typeof meta.errorMessage === 'string' ? meta.errorMessage : undefined,
  }
}

/**
 *  DEV live：在**同一模块图**内对比「只 removeStreamingSession」vs endSessionRun，
 * 避免 CDP `import('/src/...')` 命中 Vite HMR 分裂 store（本文件头注释同款约束）。
 */
export function probeEndSessionRunStopsTimer(sessionId?: string): {
  ok: boolean
  reason?: string
  sid?: string
  bugStillReproducibleViaRemoveOnly?: boolean
  fixStopsTimer?: boolean
  afterRemoveOnly?: { busy: boolean; startedAt: number | null; endedAt: number | null }
  afterEnd?: { busy: boolean; startedAt: number | null; endedAt: number | null; phase: string | null }
} {
  const sid = sessionId ?? useChatStore.getState().currentSessionId
  if (!sid) return { ok: false, reason: 'NO_SESSION' }

  const remove = useChatStore.getState().removeStreamingSession
  const T0 = Date.now() - 12_000

  applyRuntimeRunSync(sid, {
    session_id: sid,
    run_id: 'probe-run',
    status: 'running',
    seq: 1,
    queued_run_ids: [],
  })
  useChatRuntimeStore.getState().updateRunStateForSession(sid, {
    startedAt: T0,
    endedAt: null,
    phase: 'planning',
  })
  flushRuntimeBatch()
  remove(sid)
  flushRuntimeBatch()
  const rsA = useChatRuntimeStore.getState().runStateBySessionId[sid]
  const afterRemoveOnly = {
    busy: isSessionBusy(sid),
    startedAt: rsA?.startedAt ?? null,
    endedAt: rsA?.endedAt ?? null,
  }
  const isRunningAfterRemoveOnly =
    afterRemoveOnly.startedAt != null && afterRemoveOnly.endedAt == null

  applyRuntimeRunSync(sid, {
    session_id: sid,
    run_id: 'probe-run',
    status: 'running',
    seq: 2,
    queued_run_ids: [],
  })
  useChatRuntimeStore.getState().updateRunStateForSession(sid, {
    startedAt: T0,
    endedAt: null,
    phase: 'planning',
  })
  flushRuntimeBatch()
  endSessionRun({
    sessionId: sid,
    status: 'cancelled',
    removeStreamingSession: remove,
  })
  flushRuntimeBatch()
  const rsB = useChatRuntimeStore.getState().runStateBySessionId[sid]
  const afterEnd = {
    busy: isSessionBusy(sid),
    startedAt: rsB?.startedAt ?? null,
    endedAt: rsB?.endedAt ?? null,
    phase: (rsB?.phase as string | undefined) ?? null,
  }
  const isRunningAfterEnd = afterEnd.startedAt != null && afterEnd.endedAt == null

  return {
    ok: true,
    sid,
    afterRemoveOnly,
    afterEnd,
    bugStillReproducibleViaRemoveOnly:
      isRunningAfterRemoveOnly === true && afterRemoveOnly.busy === false,
    fixStopsTimer:
      isRunningAfterEnd === false &&
      afterEnd.busy === false &&
      typeof afterEnd.endedAt === 'number',
  }
}

export function bootstrapMockRunTerminationProbe(): void {
  if (!import.meta.env.DEV) return
  // Window 类型只暴露 getState（CDP 读会话）；避免 Zustand setState 重载拖垮 assign。
  window.__TABTIN_CHAT_STORE__ = { getState: () => useChatStore.getState() }
  window.__TABTIN_CHAT_RUNTIME_STORE__ = { getState: () => useChatRuntimeStore.getState() }
  //  dogfood：子代理 live / 归档必须挂应用内同实例；CDP 动态 import 会命中 HMR 空 store。
  window.__TABTIN_SUBAGENT_LIVE_STORE__ = useSubagentLiveStore
  window.__TABTIN_SUBAGENT_SESSION_STORE__ = useSubagentSessionStore
  window.__TABTIN_FLUSH_SUBAGENT_LIVE__ = flushSubagentLiveBatch
  window.__TABTIN_MOCK_RUN_TERMINATION__ = mockRunTermination
  window.__TABTIN_RUN_TERMINATION_LIVE_CASES__ = RUN_TERMINATION_LIVE_CASES
  window.__TABTIN_PROBE_6529_END_SESSION_RUN__ = probeEndSessionRunStopsTimer
}

export function teardownMockRunTerminationProbe(): void {
  if (!import.meta.env.DEV) return
  delete window.__TABTIN_CHAT_STORE__
  delete window.__TABTIN_CHAT_RUNTIME_STORE__
  delete window.__TABTIN_SUBAGENT_LIVE_STORE__
  delete window.__TABTIN_SUBAGENT_SESSION_STORE__
  delete window.__TABTIN_FLUSH_SUBAGENT_LIVE__
  delete window.__TABTIN_MOCK_RUN_TERMINATION__
  delete window.__TABTIN_RUN_TERMINATION_LIVE_CASES__
  delete window.__TABTIN_PROBE_6529_END_SESSION_RUN__
}
