/**
 *  · 后台命令终态 `_terminal_update` tool_result 原地更新桥测试
 *
 * 场景链：Agent 跑 run_terminal_command（如文生图 `tabtin media image generate`），
 * wait_ms 耗尽返回 running 快照转后台；进程终结时 host 合成终态 mini-message
 * （role=user + content_block_start(tool_result, content 含 `_terminal_update:true`
 * + 终态 stdout)），renderer 经 WS 观察源 / 本机 publish 收到后，
 * `terminalToolResultUpdate` 必须把终态 content 原地 upsert 进既有 tool event——
 * 否则 MediaImageInlineCard 永远显示 running 快照转圈，只有重载才出图。
 *
 * 覆盖矩阵：
 *   1. 主路径：既有 tool event（phase='end'，output=running 快照）+ 终态 4 件套
 *      → output 变终态 content、progress 被清、durationMs 取 content 的
 *      duration_ms、runState.completedToolCalls 不变、不新增 ChatMessage、
 *      parseMediaImageGenerateResult(新 output) 能剥出成品图 URL；
 *   2. 回归：content 不含 `_terminal_update` 的普通 tool_result 块 → 仍被忽略；
 *   3. 无既有 tool event → no-op，不新建裸 event；
 *   4. content JSON 坏 / `_terminal_update` 非 true → no-op。
 *
 * mock 策略与 contentBlockHandler.test.ts 同源：useChatRuntimeStore /
 * useChatStore / useSpaceStore / logger 全部 mock；tool event upsert 用
 * **真 merge 语义**（字段级 undefined-保留，与 useChatRuntimeStore.ts 的
 * upsertToolEventForSession 一致）的 in-memory reducer。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { handleContentBlockEvent } from '../contentBlockHandler'
import { __resetStreamTokenUsageForTests } from '../streamTokenUsage'
import { parseMediaImageGenerateResult } from '@/components/chat/cards/parseMediaImageGenerateResult'
import type { AgentStreamMessage, HandlerContext, StreamHandlerStore } from './streamMessageHandler'
import type { ToolEvent } from '../../shared/types'

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() }),
  logger: { debug: vi.fn(), warn: vi.fn(), error: vi.fn(), info: vi.fn() },
}))

// useChatStore mock：in-memory messages——断言「终态 mini-message 不新增
// ChatMessage」（role=user 不建壳，tool_result 块不建容器）。
const _mockMessagesBySession: Record<string, Array<{ id: string; role: string }>> = {}
vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      ensureAssistantMessage: vi.fn((sessionId: string, message: { id: string; role: string }) => {
        const prev = _mockMessagesBySession[sessionId] ?? []
        if (prev.some(m => m.id === message.id)) return
        _mockMessagesBySession[sessionId] = [...prev, message]
      }),
      updateSessionMessages: vi.fn(),
      patchMessageById: vi.fn(),
      messagesBySessionId: _mockMessagesBySession,
      sessions: [],
      getSessionById: () => undefined,
    }),
  },
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({ selectedAgent: null }),
  },
}))

vi.mock('@/stores/useChatRuntimeStore', () => ({
  flushRuntimeBatch: () => {},
  TOOL_USE_PENDING_TOOL_CALL_ID: '__pending__',
  incrementDroppedEventCount: () => {},
  getDroppedEventCount: () => ({}),
}))

// message_stop 的 content 同步 helper 不在本测试 scope——spy 掉避免走入
// ChatMessage 写入路径（其自身行为由 syncMessageContent.test.ts 覆盖）。
vi.mock('../syncMessageContent', () => ({
  syncDerivedContentToChatMessage: vi.fn(),
}))

const SESSION = 'sess-terminal-update-test'
const MID = 'msg_terminal_update'
const TOOL_USE_ID = 'toolu_bg_terminal_1'

/** 终态 content：与 host 侧 buildBackgroundTaskTerminalContent 构造同构。 */
function terminalContentJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: 'completed',
    session_id: 'pty-session-1',
    exit_code: 0,
    exited_by: 'normal_exit',
    duration_ms: 116_000,
    stdout: JSON.stringify({ ok: true, data: { result_urls: ['https://example.com/x.jpeg'] } }),
    output_file: '/tmp/out.log',
    command: 'tabtin media image generate --prompt cat',
    cwd: '/tmp',
    _terminal_update: true,
    ...over,
  })
}

/** running 快照 output（run_terminal_command wait_ms 耗尽时的返回形态）。 */
function runningSnapshotJson(): string {
  return JSON.stringify({
    status: 'running',
    session_id: 'pty-session-1',
    stdout: '',
    command: 'tabtin media image generate --prompt cat',
  })
}

// ─── in-memory tool event store（真 merge 语义）─────────────────────────

interface Harness {
  toolEvents: Record<string, ToolEvent[]>
  updateRunStateSpy: ReturnType<typeof vi.fn>
  pushAgentStepSpy: ReturnType<typeof vi.fn>
  updateAgentStepSpy: ReturnType<typeof vi.fn>
  contentBlockStartSpy: ReturnType<typeof vi.fn>
  contentBlockStopSpy: ReturnType<typeof vi.fn>
  buildStore: () => StreamHandlerStore
  makeCtx: () => HandlerContext
}

function createHarness(): Harness {
  const toolEvents: Record<string, ToolEvent[]> = {}
  const messageMeta: Record<string, Record<string, { role: string; finalized: boolean }>> = {}
  const updateRunStateSpy = vi.fn()
  const pushAgentStepSpy = vi.fn()
  const updateAgentStepSpy = vi.fn()
  const contentBlockStartSpy = vi.fn()
  const contentBlockStopSpy = vi.fn()

  function buildStore(): StreamHandlerStore {
    return {
      messageMetaBySessionId: messageMeta,
      contentBlocksLastSeqBySessionId: {},
      // mini-message 的 message_start/cb_start/cb_stop/message_stop 仍走 store
      // CRUD——本测试不验块时间轴，轻 stub 只记 meta（role 供容器守门读取）。
      messageStart: (sessionId: string, messageId: string, meta: { role: string }) => {
        const sessionMeta = messageMeta[sessionId] ?? {}
        messageMeta[sessionId] = { ...sessionMeta, [messageId]: { ...meta, finalized: false } }
      },
      messageDelta: () => false,
      messageStop: () => {},
      contentBlockStart: contentBlockStartSpy,
      contentBlockDelta: () => {},
      contentBlockStop: contentBlockStopSpy,
      clearContentBlocksForSession: () => {},
      agentStepsBySessionId: {},
      toolEventsBySessionId: toolEvents,
      assistantEventsBySessionId: {},
      subagentRunsBySessionId: {},
      runStateBySessionId: {
        [SESSION]: { phase: 'tool_calls', completedToolCalls: 3, totalToolCalls: 5 },
      },
      todosBySessionId: {},
      agentModeBySessionId: {},
      cancellingBySessionId: {},
      updateRunStateForSession: updateRunStateSpy,
      setCancellingForSession: () => {},
      pushAgentStepForSession: pushAgentStepSpy,
      updateAgentStepForSession: updateAgentStepSpy,
      // 与 useChatRuntimeStore.upsertToolEventForSession 字段级 merge 语义一致：
      // 未传字段沿用旧值；显式 `progress: undefined` 经 spread 擦掉旧值。
      upsertToolEventForSession: (sessionId: string, event: ToolEvent) => {
        const prev = toolEvents[sessionId] ?? []
        const existing = prev.find(i => i.id === event.id)
        const merged: ToolEvent = existing
          ? {
              ...existing,
              ...event,
              input: event.input !== undefined ? event.input : existing.input,
              inputSummary: event.inputSummary !== undefined ? event.inputSummary : existing.inputSummary,
              runId: event.runId !== undefined ? event.runId : existing.runId,
              startedAt: event.startedAt !== undefined ? event.startedAt : existing.startedAt,
              presentation: event.presentation !== undefined ? event.presentation : existing.presentation,
              budgetSkipped: event.budgetSkipped !== undefined ? event.budgetSkipped : existing.budgetSkipped,
            }
          : event
        toolEvents[sessionId] = [...prev.filter(i => i.id !== event.id), merged]
      },
      getEffectiveToolEventForSession: (sessionId: string, eventId: string) =>
        (toolEvents[sessionId] ?? []).find(e => e.id === eventId),
      upsertAssistantEventForSession: () => {},
      resetAssistantDeltasForSession: () => {},
      upsertSubagentRunForSession: () => {},
      setTodosForSession: () => {},
      appendRichContentBlocks: () => {},
      upsertRichContentBlocksByToolCallId: () => {},
      clearRichContentBlocks: () => {},
      markStreamingWidgetsInterruptedAndClearOthers: () => {},
      pushSnapshotForSession: () => {},
    } as unknown as StreamHandlerStore
  }

  function makeCtx(): HandlerContext {
    return {
      sessionId: SESSION,
      notifyPrefix: '',
      get: () => buildStore(),
      set: vi.fn(),
      addStreamingSession: vi.fn(),
      removeStreamingSession: vi.fn(),
      client: { sessions: { get: vi.fn() } },
      updateSessionTokenUsageInCaches: vi.fn(),
      updateSessionInCaches: vi.fn(),
      onLifecycleEnd: vi.fn(),
    } as unknown as HandlerContext
  }

  return {
    toolEvents,
    updateRunStateSpy,
    pushAgentStepSpy,
    updateAgentStepSpy,
    contentBlockStartSpy,
    contentBlockStopSpy,
    buildStore,
    makeCtx,
  }
}

// ─── wire 事件构造（对齐 host 4 件套形态）────────────────────────────────

function envelopeBase(seq: number) {
  return {
    protocol_version: 'v2' as const,
    min_compatible_version: 'v2' as const,
    trace_id: `trace-${seq}`,
    _seq: seq,
    thread_id: SESSION,
  }
}

function messageStartMsg(seq: number): AgentStreamMessage {
  return {
    type: 'agent.stream.message_start',
    payload: {
      ...envelopeBase(seq),
      message_id: MID,
      role: 'user',
      model_id: 'tabtin-tool-runtime',
      model_name: 'tabtin-tool-runtime',
      started_at: new Date(seq * 1000).toISOString(),
      run_id: 'bg-terminal-test',
      message_kind: 'llm',
    },
  }
}

function toolResultStartMsg(seq: number, content: unknown): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_start',
    payload: {
      ...envelopeBase(seq),
      message_id: MID,
      index: 0,
      block_id: 'blk_terminal_0',
      block: { type: 'tool_result', tool_use_id: TOOL_USE_ID, content },
    },
  }
}

function contentBlockStopMsg(seq: number): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_stop',
    payload: { ...envelopeBase(seq), message_id: MID, index: 0 },
  }
}

function messageStopMsg(seq: number): AgentStreamMessage {
  return {
    type: 'agent.stream.message_stop',
    payload: { ...envelopeBase(seq), message_id: MID },
  }
}

/** 喂入完整终态 4 件套（message_start → cb_start → cb_stop → message_stop）。 */
function feedTerminalMiniMessage(ctx: HandlerContext, content: unknown): void {
  handleContentBlockEvent(messageStartMsg(1), ctx)
  handleContentBlockEvent(toolResultStartMsg(2, content), ctx)
  handleContentBlockEvent(contentBlockStopMsg(3), ctx)
  handleContentBlockEvent(messageStopMsg(4), ctx)
}

// ═══════════════════════════════════════════════════════════════════

describe('terminalToolResultUpdate ·  后台命令终态原地更新', () => {
  beforeEach(() => {
    __resetStreamTokenUsageForTests()
    for (const key of Object.keys(_mockMessagesBySession)) delete _mockMessagesBySession[key]
  })

  it('终态 4 件套 → 既有 tool event output 换为终态 content，卡片可剥出成品图 URL', () => {
    const harness = createHarness()
    const startedAt = Date.now() - 120_000
    // 既有 tool event：run_terminal_command 已 phase='end'，output 是 running
    // 快照；progress 残留 running 期间的 tool_progress 中间帧。
    harness.toolEvents[SESSION] = [{
      id: TOOL_USE_ID,
      toolName: 'run_terminal_command',
      phase: 'end',
      input: { command: 'tabtin media image generate --prompt cat' },
      inputSummary: 'tabtin media image generate --prompt cat',
      output: runningSnapshotJson(),
      outputSummary: 'running',
      timestamp: startedAt,
      startedAt,
      progress: { stdout: 'partial', outputBytes: 7, truncated: false, capturedAt: startedAt },
    }]
    const ctx = harness.makeCtx()

    feedTerminalMiniMessage(ctx, terminalContentJson())

    const updated = harness.toolEvents[SESSION]?.find(e => e.id === TOOL_USE_ID)
    expect(updated).toBeDefined()
    // output 变为终态 content 原样字符串
    expect(typeof updated!.output).toBe('string')
    const parsedOutput = JSON.parse(updated!.output as string) as Record<string, unknown>
    expect(parsedOutput._terminal_update).toBe(true)
    expect(parsedOutput.status).toBe('completed')
    // MediaImageInlineCard 重解析：递归剥 stdout 层拿到 result_urls
    expect(parseMediaImageGenerateResult(updated!.output)).toBe('https://example.com/x.jpeg')
    // progress 被显式擦掉（不与终态 output 并存过期中间帧）
    expect(updated!.progress).toBeUndefined()
    // durationMs 取终态 content 的 duration_ms；startedAt / input / summary 沿用旧值
    expect(updated!.durationMs).toBe(116_000)
    expect(updated!.startedAt).toBe(startedAt)
    expect(updated!.input).toEqual({ command: 'tabtin media image generate --prompt cat' })
    expect(updated!.inputSummary).toBe('tabtin media image generate --prompt cat')
    expect(updated!.phase).toBe('end')

    // 不动任何计数 / 步骤 / 消息
    expect(harness.updateRunStateSpy).not.toHaveBeenCalled()
    expect(harness.pushAgentStepSpy).not.toHaveBeenCalled()
    expect(harness.updateAgentStepSpy).not.toHaveBeenCalled()
    expect(_mockMessagesBySession[SESSION] ?? []).toHaveLength(0)
  })

  it('IPC 与 WS 重放同一终态载体时不写入不可展示的 user content block', () => {
    const harness = createHarness()
    harness.toolEvents[SESSION] = [{
      id: TOOL_USE_ID,
      toolName: 'run_terminal_command',
      phase: 'end',
      output: runningSnapshotJson(),
      timestamp: Date.now(),
    }]
    const ctx = harness.makeCtx()

    feedTerminalMiniMessage(ctx, terminalContentJson())
    feedTerminalMiniMessage(ctx, terminalContentJson())

    expect(harness.contentBlockStartSpy).not.toHaveBeenCalled()
    expect(harness.contentBlockStopSpy).not.toHaveBeenCalled()
    expect(_mockMessagesBySession[SESSION] ?? []).toHaveLength(0)
  })

  it('回归：content 不含 _terminal_update 的普通 tool_result 块 → 仍被忽略', () => {
    const harness = createHarness()
    const existingOutput = runningSnapshotJson()
    harness.toolEvents[SESSION] = [{
      id: TOOL_USE_ID,
      toolName: 'run_terminal_command',
      phase: 'end',
      output: existingOutput,
      timestamp: Date.now(),
    }]
    const ctx = harness.makeCtx()

    feedTerminalMiniMessage(ctx, JSON.stringify({ success: true, stdout: 'done' }))

    const updated = harness.toolEvents[SESSION]?.find(e => e.id === TOOL_USE_ID)
    expect(updated!.output).toBe(existingOutput)
  })

  it('无既有 tool event → no-op，不新建裸 event', () => {
    const harness = createHarness()
    const ctx = harness.makeCtx()

    feedTerminalMiniMessage(ctx, terminalContentJson())

    expect(harness.toolEvents[SESSION] ?? []).toHaveLength(0)
    expect(_mockMessagesBySession[SESSION] ?? []).toHaveLength(0)
  })

  it('content JSON 坏 / _terminal_update 非 true → no-op', () => {
    const harness = createHarness()
    const existingOutput = runningSnapshotJson()
    harness.toolEvents[SESSION] = [{
      id: TOOL_USE_ID,
      toolName: 'run_terminal_command',
      phase: 'end',
      output: existingOutput,
      timestamp: Date.now(),
    }]
    const ctx = harness.makeCtx()

    // 含标记子串但 JSON 坏
    feedTerminalMiniMessage(ctx, '{"_terminal_update":true,"status":')
    // JSON 合法但标记非 true
    feedTerminalMiniMessage(ctx, JSON.stringify({ _terminal_update: false, status: 'completed' }))
    // content 非 string（叶子块数组形态）
    feedTerminalMiniMessage(ctx, [{ type: 'text', text: '"_terminal_update":true' }])

    const updated = harness.toolEvents[SESSION]?.find(e => e.id === TOOL_USE_ID)
    expect(updated!.output).toBe(existingOutput)
  })
})
