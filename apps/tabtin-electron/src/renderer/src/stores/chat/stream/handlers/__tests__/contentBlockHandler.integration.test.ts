/**
 * Wave 4a · ContentBlock handler ↔ wave2 真实 daemon trace 集成测试
 * （W4a 二轮 R1-P0-3 + R3-P0-3 修复产物）
 *
 * 修复背景：前一版单测全用手写 minimal envelope，从未跑过
 * `packages/agent-runtime/tests/wave2/` 真实 daemon trace。OpenAI 多 tool_call
 * 并发的串行重排、Anthropic abort 路径、tool_use 多轮 message 等真实场景
 * 0 覆盖（独立 Review R1-P0-3 + R3-P0-3 联合标记 P0）。
 *
 * 本测试构造与 wave2 真实 daemon 输出**形态一致**的 envelope event 序列
 * （含完整 envelope 公共字段：protocol_version/_seq/trace_id/thread_id/
 * message_id），feed 给 contentBlockHandler，verify renderer 端 store state
 * 与 daemon emit 语义一致。
 *
 * 3 个用例对应 wave2/ 下 3 个 reference 测试：
 *   1. proxy-provider-envelope.test.ts — OpenAI 多 tool_call 并发
 *   2. query-abort-envelope.test.ts — abort 路径 message_delta(aborted)
 *   3. query-content-block-events.test.ts — tool_use 多轮 message
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleContentBlockEvent } from '../contentBlockHandler'
import { useChatRuntimeStore, flushRuntimeBatch } from '@/stores/useChatRuntimeStore'
import { getCommittedBlocks, getSessionBlocksRecord, __resetMessageBlocks } from '@/stores/chat/messages/messageBlocks'
import { useChatStore } from '@/stores/chat/useChatStore'
import type { HandlerContext, AgentStreamMessage } from '../streamHandlerTypes'

const SESSION = 'sess-integration-w2'

//  阶段 6：内容块在 messages 层（committed）。
function runtimeCb(sessionId: string): Record<string, import('@/stores/useChatRuntimeStore').ContentBlockEntry[]> {
  return getSessionBlocksRecord(sessionId) ?? {}
}

function resetStore(): void {
  flushRuntimeBatch()
  __resetMessageBlocks()
  // 真 useChatStore 跨用例共享——handleMessageStart 会往它建壳；不清则消息累积，
  // 历史水合会把上个用例遗留消息的 content_blocks_json 再灌进 committed（污染断言）。
  useChatStore.setState({ messagesBySessionId: {} })
  useChatRuntimeStore.setState({
    messageMetaBySessionId: {},
    contentBlocksLastSeqBySessionId: {},
    agentStepsBySessionId: {},
    runStateBySessionId: {},
    richContentBlocksBySessionId: {},
  })
}

async function awaitRaf(): Promise<void> {
  await new Promise<void>((r) => requestAnimationFrame(() => r()))
}

function makeCtx(): HandlerContext {
  return {
    sessionId: SESSION,
    notifyPrefix: '',
    get: () => useChatRuntimeStore.getState() as unknown as ReturnType<HandlerContext['get']>,
    set: vi.fn(),
    addStreamingSession: vi.fn(),
    removeStreamingSession: vi.fn(),
    client: { sessions: { get: vi.fn() } },
    updateSessionTokenUsageInCaches: vi.fn(),
    updateSessionInCaches: vi.fn(),
    onLifecycleEnd: vi.fn(),
  } as unknown as HandlerContext
}

// ─── Envelope 构造 helpers（与 daemon emit 格式 1:1）────────────────────

const TRACE_ID = 'trace-w2-integration'
const THREAD_ID = 'thread-w2-integration'
const RUN_ID = 'run-w2-integration'

function envBase(seq: number) {
  return {
    protocol_version: 'v2' as const,
    min_compatible_version: 'v2' as const,
    trace_id: TRACE_ID,
    _seq: seq,
    thread_id: THREAD_ID,
  }
}

function msgStart(messageId: string, seq: number, startedAtMs = seq * 1000): AgentStreamMessage {
  return {
    type: 'agent.stream.message_start',
    payload: {
      ...envBase(seq),
      message_id: messageId,
      role: 'assistant',
      model_id: 'claude-3-5-sonnet-20241022',
      model_name: 'Claude 3.5 Sonnet',
      started_at: new Date(startedAtMs).toISOString(),
      run_id: RUN_ID,
    },
  }
}

function msgDelta(
  messageId: string,
  seq: number,
  delta: Record<string, unknown>,
  usage?: { input_tokens: number; output_tokens: number },
): AgentStreamMessage {
  return {
    type: 'agent.stream.message_delta',
    payload: {
      ...envBase(seq),
      message_id: messageId,
      delta,
      ...(usage ? { usage } : {}),
    },
  }
}

function msgStop(messageId: string, seq: number): AgentStreamMessage {
  return {
    type: 'agent.stream.message_stop',
    payload: { ...envBase(seq), message_id: messageId },
  }
}

function cbStart(
  messageId: string,
  index: number,
  blockId: string,
  block: unknown,
  seq: number,
): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_start',
    payload: { ...envBase(seq), message_id: messageId, index, block_id: blockId, block },
  }
}

function cbDelta(
  messageId: string,
  index: number,
  delta: Record<string, unknown>,
  seq: number,
): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_delta',
    payload: { ...envBase(seq), message_id: messageId, index, delta },
  }
}

function cbStop(messageId: string, index: number, seq: number): AgentStreamMessage {
  return {
    type: 'agent.stream.content_block_stop',
    payload: { ...envBase(seq), message_id: messageId, index },
  }
}

// ═══════════════════════════════════════════════════════════════════════
// Case 1 · OpenAI compat SSE — 多 tool_call 并发串行重排
// ═══════════════════════════════════════════════════════════════════════
//
// 参考 wave2/proxy-provider-envelope.test.ts:237 "OpenAI compat 多 tool_call"
// 用例：proxy-provider 把 OpenAI 同时返回的 3 个 function call 重排成串行
// envelope（每个 tool_use 一对 cb_start/delta/stop）。本测试 feed 完整序列
// 给 handler，verify 最终 contentBlocks 含 3 个 finalized tool_use。
//
// 重要不变量（v2 §2.3.3）：同 message 内 content_block_* 严格串行——start(N)
// 之后必须 stop(N) 才能 start(N+1)。前端 handler 不重排，仅按收到顺序累积。

describe('Wave 4a integration · OpenAI 多 tool_call 并发（wave2 真实 fixture 1）', () => {
  beforeEach(resetStore)

  it('3 个 tool_call 串行 cb_start/delta/stop → contentBlocks 含 3 个 finalized tool_use', async () => {
    const MID = 'msg_openai_multi'
    const events: AgentStreamMessage[] = [
      msgStart(MID, 1),
      // tool_call 0: shell
      cbStart(MID, 0, 'blk_call_a', { type: 'tool_use', id: 'call_a', name: 'shell', input: {} }, 2),
      cbDelta(MID, 0, { type: 'input_json_delta', partial_json: '{"cmd":"ls"}' }, 3),
      cbStop(MID, 0, 4),
      // tool_call 1: read_file
      cbStart(MID, 1, 'blk_call_b', { type: 'tool_use', id: 'call_b', name: 'read_file', input: {} }, 5),
      cbDelta(MID, 1, { type: 'input_json_delta', partial_json: '{"path":"/tmp/x"}' }, 6),
      cbStop(MID, 1, 7),
      // tool_call 2: web_search
      cbStart(MID, 2, 'blk_call_c', { type: 'tool_use', id: 'call_c', name: 'web_search', input: {} }, 8),
      cbDelta(MID, 2, { type: 'input_json_delta', partial_json: '{"q":"foo"}' }, 9),
      cbStop(MID, 2, 10),
      // message_delta(stop_reason='tool_use')
      msgDelta(MID, 11, { stop_reason: 'tool_use' }, { input_tokens: 200, output_tokens: 50 }),
      msgStop(MID, 12),
    ]

    const ctx = makeCtx()
    for (const ev of events) handleContentBlockEvent(ev, ctx)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(3)

    // 按 index 严格排序
    expect(blocks[0].index).toBe(0)
    expect(blocks[1].index).toBe(1)
    expect(blocks[2].index).toBe(2)

    // 每个 tool_use 都 finalized + input 完整解析
    expect(blocks[0].finalized).toBe(true)
    expect(blocks[1].finalized).toBe(true)
    expect(blocks[2].finalized).toBe(true)

    const ids = blocks.map(b => (b.block as { type: string; id?: string }).id)
    expect(ids).toEqual(['call_a', 'call_b', 'call_c'])

    const inputs = blocks.map(b => (b.block as { type: string; input: unknown }).input)
    expect(inputs[0]).toEqual({ cmd: 'ls' })
    expect(inputs[1]).toEqual({ path: '/tmp/x' })
    expect(inputs[2]).toEqual({ q: 'foo' })

    // message 元信息
    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.finalized).toBe(true)
    expect(meta?.stop_reason).toBe('tool_use')
    expect(meta?.usage?.input_tokens).toBe(200)
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Case 2 · Anthropic abort 路径
// ═══════════════════════════════════════════════════════════════════════
//
// 参考 wave2/query-abort-envelope.test.ts：abort 触发时 query.ts emit
// message_delta(stop_reason='aborted') 紧跟 message_stop。partial text 仍以
// content_block_delta(text_delta) 累积——前端表现：finalize 时 entry.partial=true
// + meta.stop_reason='aborted'。
//
// 关键场景：用户中途按 cancel 后，已部分流出的内容仍能稳定显示，不被擦除。

describe('Wave 4a integration · abort 路径（wave2 真实 fixture 2）', () => {
  beforeEach(resetStore)

  it('abort 触发：message_delta(aborted) + message_stop → entry.partial=true + meta.stop_reason=aborted', async () => {
    const MID = 'msg_abort_partial'
    const events: AgentStreamMessage[] = [
      msgStart(MID, 1),
      cbStart(MID, 0, 'blk_abort_text', { type: 'text', text: '' }, 2),
      cbDelta(MID, 0, { type: 'text_delta', text: 'Let me start by analyzing...' }, 3),
      cbDelta(MID, 0, { type: 'text_delta', text: ' First, I notice...' }, 4),
      // 中途 abort —— 注意此处**没有** content_block_stop（W2 §2.3.3 abort 时 daemon 不发 cb_stop）
      msgDelta(MID, 5, { stop_reason: 'aborted', stop_sequence: null }),
      msgStop(MID, 6),
    ]

    const ctx = makeCtx()
    for (const ev of events) handleContentBlockEvent(ev, ctx)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(1)

    // message_stop 时强制 finalize 未完成的 block + 标 partial=true
    expect(blocks[0].finalized).toBe(true)
    expect(blocks[0].partial).toBe(true)
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe(
      'Let me start by analyzing... First, I notice...',
    )

    // meta.stop_reason='aborted' 让 UI 区分"正常完成"vs"用户中断"
    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID]
    expect(meta?.stop_reason).toBe('aborted')
    expect(meta?.finalized).toBe(true)
  })

  it('abort 在 tool_use input 流式中途 → tool_use block 也被强制 finalize + parseError 落字段', async () => {
    const MID = 'msg_abort_tool'
    const events: AgentStreamMessage[] = [
      msgStart(MID, 1),
      cbStart(MID, 0, 'blk_abort_tool', { type: 'tool_use', id: 'tu_abort', name: 'write_file', input: {} }, 2),
      // partial JSON 没流完
      cbDelta(MID, 0, { type: 'input_json_delta', partial_json: '{"path":"/tmp/aborted",' }, 3),
      // 直接 abort
      msgDelta(MID, 4, { stop_reason: 'aborted' }),
      msgStop(MID, 5),
    ]

    const ctx = makeCtx()
    for (const ev of events) handleContentBlockEvent(ev, ctx)
    await awaitRaf()

    const block = runtimeCb(SESSION)?.[MID]?.[0]
    expect(block?.finalized).toBe(true)
    expect(block?.partial).toBe(true)
    const tu = block?.block as {
      type: 'tool_use'
      input: Record<string, unknown>
      input_parse_error?: { message: string; partial: string }
    }
    expect(tu.type).toBe('tool_use')
    expect(tu.input).toEqual({}) // partial JSON 解析失败回退到空对象
    expect(tu.input_parse_error).toBeDefined()
    expect(tu.input_parse_error!.partial).toContain('"path":"/tmp/aborted"')
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Case 3 · tool_use 多轮 message
// ═══════════════════════════════════════════════════════════════════════
//
// 参考 wave2/query-content-block-events.test.ts："双 message 场景"——
// 第一轮 LLM 输出 tool_use + message_stop → daemon 执行工具 → 第二轮 LLM
// 输出 text 答复（新的 message_id）。前端必须为每个 message_id 独立累积
// blocks（contentBlocksBySessionId[sid] 是 Record<messageId, blocks[]>），
// 不能在同一个 messageId 内堆 N 个 message 的内容。

describe('Wave 4a integration · tool_use 多轮 message（wave2 真实 fixture 3）', () => {
  beforeEach(resetStore)

  it('双 message：第一轮 tool_use + 第二轮 text → 两个独立 messageMeta + 各自 blocks', async () => {
    const MID_1 = 'msg_round_1'
    const MID_2 = 'msg_round_2'

    const events: AgentStreamMessage[] = [
      // Round 1: tool_use
      msgStart(MID_1, 1),
      cbStart(MID_1, 0, 'blk_1_text', { type: 'text', text: '' }, 2),
      cbDelta(MID_1, 0, { type: 'text_delta', text: "I'll read the file first." }, 3),
      cbStop(MID_1, 0, 4),
      cbStart(MID_1, 1, 'blk_1_tool', { type: 'tool_use', id: 'tu_read1', name: 'read_file', input: {} }, 5),
      cbDelta(MID_1, 1, { type: 'input_json_delta', partial_json: '{"path":"/etc/hosts"}' }, 6),
      cbStop(MID_1, 1, 7),
      msgDelta(MID_1, 8, { stop_reason: 'tool_use' }),
      msgStop(MID_1, 9),

      // Round 2: text answer (after tool result fed back to LLM)
      msgStart(MID_2, 10, 10_000),
      cbStart(MID_2, 0, 'blk_2_text', { type: 'text', text: '' }, 11),
      cbDelta(MID_2, 0, { type: 'text_delta', text: 'The file contains: 127.0.0.1 localhost' }, 12),
      cbStop(MID_2, 0, 13),
      msgDelta(MID_2, 14, { stop_reason: 'end_turn' }, { input_tokens: 150, output_tokens: 25 }),
      msgStop(MID_2, 15),
    ]

    const ctx = makeCtx()
    for (const ev of events) handleContentBlockEvent(ev, ctx)
    await awaitRaf()

    const sessionBlocks = runtimeCb(SESSION) ?? {}
    expect(Object.keys(sessionBlocks).sort()).toEqual([MID_1, MID_2].sort())

    // Round 1: text + tool_use 两个 block
    const round1 = sessionBlocks[MID_1] ?? []
    expect(round1).toHaveLength(2)
    expect(round1[0].block.type).toBe('text')
    expect((round1[0].block as { type: 'text'; text: string }).text).toBe("I'll read the file first.")
    expect(round1[1].block.type).toBe('tool_use')
    expect((round1[1].block as { type: 'tool_use'; input: unknown }).input).toEqual({ path: '/etc/hosts' })

    // Round 2: text 单 block
    const round2 = sessionBlocks[MID_2] ?? []
    expect(round2).toHaveLength(1)
    expect((round2[0].block as { type: 'text'; text: string }).text).toBe('The file contains: 127.0.0.1 localhost')

    // 两轮 meta 独立
    const meta1 = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID_1]
    const meta2 = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[MID_2]
    expect(meta1?.stop_reason).toBe('tool_use')
    expect(meta2?.stop_reason).toBe('end_turn')
    expect(meta1?.finalized).toBe(true)
    expect(meta2?.finalized).toBe(true)
    expect(meta2?.usage?.input_tokens).toBe(150)

    // lastSeq 也按 message 独立
    const lastSeq = useChatRuntimeStore.getState().contentBlocksLastSeqBySessionId[SESSION] ?? {}
    expect(lastSeq[MID_1]).toBe(9)
    expect(lastSeq[MID_2]).toBe(15)
  })

  it('tool_use thinking → text 三 block 串联（典型 Anthropic 扩展思考形态）', async () => {
    const MID = 'msg_thinking_tool_text'

    const events: AgentStreamMessage[] = [
      msgStart(MID, 1),
      // thinking 块
      cbStart(MID, 0, 'blk_think', { type: 'thinking', thinking: '', signature: '' }, 2),
      cbDelta(MID, 0, { type: 'thinking_delta', thinking: 'I need to check the file structure.' }, 3),
      cbDelta(MID, 0, { type: 'signature_delta', signature: 'sig_abc' }, 4),
      cbStop(MID, 0, 5),
      // text 块
      cbStart(MID, 1, 'blk_text', { type: 'text', text: '' }, 6),
      cbDelta(MID, 1, { type: 'text_delta', text: 'Let me investigate.' }, 7),
      cbStop(MID, 1, 8),
      // tool_use 块
      cbStart(MID, 2, 'blk_tool', { type: 'tool_use', id: 'tu_glob', name: 'glob_search', input: {} }, 9),
      cbDelta(MID, 2, { type: 'input_json_delta', partial_json: '{"glob_pattern":"**/*.ts"}' }, 10),
      cbStop(MID, 2, 11),
      msgDelta(MID, 12, { stop_reason: 'tool_use' }),
      msgStop(MID, 13),
    ]

    const ctx = makeCtx()
    for (const ev of events) handleContentBlockEvent(ev, ctx)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(3)

    // index 0: thinking + signature
    expect(blocks[0].block.type).toBe('thinking')
    const thinkingBlock = blocks[0].block as { type: 'thinking'; thinking: string; signature: string }
    expect(thinkingBlock.thinking).toBe('I need to check the file structure.')
    expect(thinkingBlock.signature).toBe('sig_abc')

    // R2-P1-4 升 P0：thinking 镜像到 agentStepsBySessionId
    const steps = useChatRuntimeStore.getState().agentStepsBySessionId[SESSION] ?? []
    const thinkingStep = steps.find(s => s.id === `thinking-${MID}-0`)
    expect(thinkingStep).toBeDefined()
    expect(thinkingStep?.type).toBe('thinking')
    expect(thinkingStep?.status).toBe('done')
    expect(thinkingStep?.detail).toContain('check the file structure')

    // index 1: text
    expect(blocks[1].block.type).toBe('text')
    expect((blocks[1].block as { type: 'text'; text: string }).text).toBe('Let me investigate.')

    // index 2: tool_use
    expect(blocks[2].block.type).toBe('tool_use')
    expect((blocks[2].block as { type: 'tool_use'; input: unknown }).input).toEqual({ glob_pattern: '**/*.ts' })
  })
})

// ═══════════════════════════════════════════════════════════════════════
// Bonus · daemon retry 攻击场景（R1-P0-1 + R1-P0-2 联动）
// ═══════════════════════════════════════════════════════════════════════

describe('Wave 4a integration · daemon retry 攻击（R1-P0 联动）', () => {
  beforeEach(resetStore)

  it('attempt1 完整 finalize → attempt2 同 messageId 重发 → 槽位重置 + 第二轮独立累积', async () => {
    const MID = 'msg_retry_target'

    // attempt 1：完整序列
    const attempt1: AgentStreamMessage[] = [
      msgStart(MID, 1),
      cbStart(MID, 0, 'blk_a1', { type: 'text', text: '' }, 2),
      cbDelta(MID, 0, { type: 'text_delta', text: 'attempt-1' }, 3),
      cbStop(MID, 0, 4),
      msgDelta(MID, 5, { stop_reason: 'end_turn' }),
      msgStop(MID, 6),
    ]

    // attempt 2：retry 重发同 messageId（譬如 WS 重连 + relay 回放）
    const attempt2: AgentStreamMessage[] = [
      msgStart(MID, 10),
      cbStart(MID, 0, 'blk_a2', { type: 'text', text: '' }, 11),
      cbDelta(MID, 0, { type: 'text_delta', text: 'attempt-2' }, 12),
      cbStop(MID, 0, 13),
      msgDelta(MID, 14, { stop_reason: 'end_turn' }),
      msgStop(MID, 15),
    ]

    const ctx = makeCtx()
    for (const ev of [...attempt1, ...attempt2]) handleContentBlockEvent(ev, ctx)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[MID] ?? []
    expect(blocks).toHaveLength(1) // 不是 2 个、不是混在一起
    expect(blocks[0].block_id).toBe('blk_a2')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('attempt-2')
  })
})
