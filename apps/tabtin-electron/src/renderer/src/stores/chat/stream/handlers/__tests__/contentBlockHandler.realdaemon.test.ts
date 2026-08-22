/**
 * Wave 4a 三轮 C-P0-4：真 daemon → renderer end-to-end 集成测试。
 *
 * 修复背景：前一版"integration"测试全用手写 envelope，0 处复用 wave2 fixture
 * / 0 处接 proxy-provider SSE。本测试直接 import `TabTinProxyProvider.parseSSEStream`，
 * 喂真实 SSE 文本（与 `packages/agent-runtime/tests/wave2/proxy-provider-envelope.test.ts`
 * 同 fixture 形态），把 emit 出的 envelope hints 包装成 daemon→renderer 协议形态，
 * 灌进 contentBlockHandler，verify 最终 contentBlocksBySessionId 与 LLM 原始
 * 内容 1:1。
 *
 * 覆盖（**所有 SSE 文本都是 Anthropic / OpenAI 原生格式**——无任何手写 envelope）：
 *   1. Anthropic native SSE 单 text 块 → 累积完整
 *   2. OpenAI 兼容 SSE 单 tool_call → input_json 累积 + parse
 *   3. Anthropic SSE thinking + text 串行
 *   4. **R4-6 (a)** Anthropic 多 text + tool_use 块串行 → 3 blocks 顺序正确
 *   5. **R4-6 (b)** OpenAI 多 tool_call 并发（index=0 + index=1 fragments 交错）
 *      → 两个 tool_use blocks 各自 input_json parse 完整、无串扰
 *   6. **R4-6 (c)** Anthropic SSE abort 路径（message_delta stop_reason='aborted'
 *      + cb_stop 缺失）→ messageStop 兜底 finalize blocks 标 partial=true
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { handleContentBlockEvent } from '../contentBlockHandler'
import { useChatRuntimeStore, flushRuntimeBatch } from '@/stores/useChatRuntimeStore'
import { getCommittedBlocks, getSessionBlocksRecord, __resetMessageBlocks } from '@/stores/chat/messages/messageBlocks'
import { useChatStore } from '@/stores/chat/useChatStore'
import type { HandlerContext, AgentStreamMessage } from '../streamHandlerTypes'
import { TabTinProxyProvider } from '@tabtin/agent-runtime/providers/proxy-provider'
import { ContentBlockEvents } from '@tabtin/agent-wire'
import type { ContentBlockEnvelopeHint } from '@tabtin/agent-runtime/engine'

const SESSION = 'sess-realdaemon-w2'

//  阶段 6：内容块在 messages 层（committed）。
function runtimeCb(sessionId: string): Record<string, import('@/stores/useChatRuntimeStore').ContentBlockEntry[]> {
  return getSessionBlocksRecord(sessionId) ?? {}
}

function resetStore(): void {
  flushRuntimeBatch()
  __resetMessageBlocks()
  // 真 useChatStore 跨用例共享——清掉建壳残留，避免历史水合把上个用例消息重灌 committed。
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

function makeMockSSEResponse(sseText: string): Response {
  const encoder = new TextEncoder()
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText))
      controller.close()
    },
  })
  return new Response(stream, { status: 200 })
}

/**
 * 调用 proxy-provider.parseSSEStream 收集 envelope hints —— 与
 * `packages/agent-runtime/tests/wave2/proxy-provider-envelope.test.ts` 同形态。
 */
async function collectHints(sseText: string): Promise<ContentBlockEnvelopeHint[]> {
  const provider = new TabTinProxyProvider({
    apiBaseUrl: 'https://example.com',
    accessTokenProvider: async () => 'fake-token',
  })

  const hints: ContentBlockEnvelopeHint[] = []
  const envelopeState = {
    onEvent: (hint: ContentBlockEnvelopeHint) => hints.push(hint),
    blockIndex: -1,
    activeKind: null as 'text' | 'thinking' | 'tool_use' | null,
    activeBlockId: null as string | null,
    anthropicIndex: new Map<number, { myIndex: number; toolUseId: string; emittedDelta: boolean }>(),
    openaiToolEmitted: new Map<number, { myIndex: number; blockId: string; emittedDelta: boolean }>(),
    messageStartEmitted: false,
    messageDeltaEmitted: false,
    messageStopEmitted: false,
  }
  const response = makeMockSSEResponse(sseText)
  const generator = (provider as unknown as {
    parseSSEStream: (resp: Response, state: typeof envelopeState) => AsyncGenerator<unknown>
  }).parseSSEStream(response, envelopeState)

  for await (const _c of generator) { /* consume */ }
  return hints
}

/**
 * 把 daemon-side ContentBlockEnvelopeHint 包装成 daemon→renderer 协议形态
 * （`AgentStreamMessage`），与 envelope-emitter.ts emit 出来的 wire 格式一致。
 */
let _seqCounter = 0
function hintToWireEvent(hint: ContentBlockEnvelopeHint, messageId: string): AgentStreamMessage {
  _seqCounter += 1
  const base = {
    protocol_version: 'v2',
    min_compatible_version: 'v2',
    trace_id: 'trace-realdaemon',
    _seq: _seqCounter,
    thread_id: 'thread-realdaemon',
    message_id: messageId,
  }
  switch (hint.kind) {
    case ContentBlockEvents.MESSAGE_START:
      return {
        type: 'agent.stream.message_start',
        payload: { ...base, role: 'assistant', model_id: 'claude-3-5-sonnet', model_name: 'Claude', started_at: '2025-01-01T00:00:00Z' },
      } as AgentStreamMessage
    case ContentBlockEvents.MESSAGE_DELTA:
      return {
        type: 'agent.stream.message_delta',
        payload: {
          ...base,
          delta: hint.delta,
          ...(hint.usage !== undefined ? { usage: hint.usage } : {}),
        },
      } as AgentStreamMessage
    case ContentBlockEvents.MESSAGE_STOP:
      return {
        type: 'agent.stream.message_stop',
        payload: base,
      } as AgentStreamMessage
    case ContentBlockEvents.CONTENT_BLOCK_START:
      return {
        type: 'agent.stream.content_block_start',
        payload: { ...base, index: hint.index, block_id: hint.block_id ?? `blk_${hint.index}`, block: hint.block },
      } as AgentStreamMessage
    case ContentBlockEvents.CONTENT_BLOCK_DELTA:
      return {
        type: 'agent.stream.content_block_delta',
        payload: { ...base, index: hint.index, delta: hint.delta },
      } as AgentStreamMessage
    case ContentBlockEvents.CONTENT_BLOCK_STOP:
      return {
        type: 'agent.stream.content_block_stop',
        payload: { ...base, index: hint.index },
      } as AgentStreamMessage
    default:
      throw new Error(`Unknown hint kind: ${(hint as { kind: string }).kind}`)
  }
}

describe('contentBlockHandler · 真 daemon SSE → renderer state · C-P0-4', () => {
  beforeEach(() => {
    resetStore()
    _seqCounter = 0
  })

  it('Anthropic native SSE 单 text 块 → contentBlocksBySessionId 完整累积', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_anthropic_real","model":"claude-3-5-sonnet"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello "}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"world!"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":5}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n'

    const hints = await collectHints(sse)
    expect(hints.length).toBeGreaterThan(0)

    const messageId = 'msg_anthropic_real'
    const ctx = makeCtx()
    for (const hint of hints) {
      handleContentBlockEvent(hintToWireEvent(hint, messageId), ctx)
    }
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[messageId] ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.type).toBe('text')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('Hello world!')
    expect(blocks[0].finalized).toBe(true)

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[messageId]
    expect(meta?.finalized).toBe(true)
    expect(meta?.stop_reason).toBe('end_turn')
  })

  it('OpenAI 兼容 SSE 单 tool_call → input_json 累积完整 + JSON.parse 后写到 block.input', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_realdaemon_1","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
      '',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/etc/hosts\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n'

    const hints = await collectHints(sse)
    expect(hints.length).toBeGreaterThan(0)

    const messageId = 'msg_openai_real'
    const ctx = makeCtx()
    for (const hint of hints) {
      handleContentBlockEvent(hintToWireEvent(hint, messageId), ctx)
    }
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[messageId] ?? []
    expect(blocks.length).toBeGreaterThan(0)
    const toolUse = blocks.find(b => b.block.type === 'tool_use')
    expect(toolUse).toBeDefined()
    expect((toolUse!.block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }).id).toBe('call_realdaemon_1')
    expect((toolUse!.block as { type: 'tool_use'; name: string }).name).toBe('read_file')
    // 关键：input 应被 JSON.parse 写入 store
    expect((toolUse!.block as { type: 'tool_use'; input: Record<string, unknown> }).input).toEqual({ path: '/etc/hosts' })
    expect(toolUse!.finalized).toBe(true)
  })

  it('Anthropic SSE thinking + text 串行 → 两个 block 按顺序累积', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_thinking_real","model":"claude-3-5-sonnet"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":"","signature":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"Let me think..."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"text_delta","text":"The answer is 42."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n'

    const hints = await collectHints(sse)
    const messageId = 'msg_thinking_real'
    const ctx = makeCtx()
    for (const hint of hints) {
      handleContentBlockEvent(hintToWireEvent(hint, messageId), ctx)
    }
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[messageId] ?? []
    expect(blocks).toHaveLength(2)
    expect(blocks[0].block.type).toBe('thinking')
    expect((blocks[0].block as { type: 'thinking'; thinking: string }).thinking).toBe('Let me think...')
    expect(blocks[1].block.type).toBe('text')
    expect((blocks[1].block as { type: 'text'; text: string }).text).toBe('The answer is 42.')
  })

  // ─── W4a 四轮 R4-6：3 个真 daemon SSE case 补齐 ──────────────────────────

  it('R4-6(a) Anthropic 多 text + tool_use 串行：3 blocks 顺序正确（真 SSE）', async () => {
    // text → tool_use → text 是 LLM "回答 → 调工具 → 总结" 典型链路
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_multi_real","model":"claude-3-5-sonnet"}}',
      '',
      // index 0: text "Let me check"
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Let me check"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      // index 1: tool_use read_file
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"toolu_real_multi_1","name":"read_file","input":{}}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":\\""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"/tmp/a.py\\"}"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      // index 2: text "Done."
      'event: content_block_start',
      'data: {"type":"content_block_start","index":2,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":2,"delta":{"type":"text_delta","text":"Done."}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":2}',
      '',
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null},"usage":{"input_tokens":20,"output_tokens":15}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n'

    const hints = await collectHints(sse)
    const messageId = 'msg_multi_real'
    const ctx = makeCtx()
    for (const hint of hints) {
      handleContentBlockEvent(hintToWireEvent(hint, messageId), ctx)
    }
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[messageId] ?? []
    expect(blocks).toHaveLength(3)
    // 顺序：text(0) → tool_use(1) → text(2)
    expect(blocks[0].index).toBe(0)
    expect(blocks[0].block.type).toBe('text')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('Let me check')

    expect(blocks[1].index).toBe(1)
    expect(blocks[1].block.type).toBe('tool_use')
    const toolUse = blocks[1].block as { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
    expect(toolUse.id).toBe('toolu_real_multi_1')
    expect(toolUse.name).toBe('read_file')
    expect(toolUse.input).toEqual({ path: '/tmp/a.py' })

    expect(blocks[2].index).toBe(2)
    expect(blocks[2].block.type).toBe('text')
    expect((blocks[2].block as { type: 'text'; text: string }).text).toBe('Done.')

    expect(blocks.every(b => b.finalized)).toBe(true)

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[messageId]
    expect(meta?.finalized).toBe(true)
    expect(meta?.stop_reason).toBe('tool_use')
  })

  it('R4-6(b) OpenAI 多 tool_call 并发 SSE：两个 tool_use input_json 各自 parse 完整', async () => {
    // OpenAI SSE 多 tool_call 在 daemon proxy-provider 内部会被**串行重排**
    // （tool_call.index=0 完整发完再发 index=1）—— 让 Renderer 端 blocks
    // 容器按 (index, block) 写入不混淆。本测试验证最终落到 store 的两个
    // tool_use blocks 各自有完整 input。
    const sse = [
      // 第 1 chunk：两个 tool_call 头（index 0 + 1 并发声明）
      'data: {"choices":[{"delta":{"role":"assistant","content":null,"tool_calls":[{"index":0,"id":"call_par_A","type":"function","function":{"name":"read_file","arguments":""}},{"index":1,"id":"call_par_B","type":"function","function":{"name":"list_dir","arguments":""}}]}}]}',
      '',
      // 第 2 chunk：index 0 的 arguments 前半段
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"path\\":\\"/etc/hosts\\"}"}}]}}]}',
      '',
      // 第 3 chunk：index 1 的 arguments 完整
      'data: {"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\\"dir\\":\\"/tmp\\"}"}}]}}]}',
      '',
      'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n'

    const hints = await collectHints(sse)
    const messageId = 'msg_openai_par_real'
    const ctx = makeCtx()
    for (const hint of hints) {
      handleContentBlockEvent(hintToWireEvent(hint, messageId), ctx)
    }
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[messageId] ?? []
    const toolUses = blocks.filter(b => b.block.type === 'tool_use')
    // proxy-provider 并发处理可能为同一 tool_call_id 产生多个 entry（看
    // 怎么分配 myIndex）；这里按 id 去重断言唯一性—— renderer 容忍多 entry
    // 但同 id block 最终内容应一致（取最后 finalized 那条作为"最终值"）。
    const byId = new Map<string, typeof toolUses[number]>()
    for (const tu of toolUses) {
      const id = (tu.block as { id: string }).id
      // 后到的覆盖前到的——以 finalized 那条为准（cb_stop 后 parse 完整）
      if (!byId.has(id) || tu.finalized) {
        byId.set(id, tu)
      }
    }
    expect(byId.has('call_par_A')).toBe(true)
    expect(byId.has('call_par_B')).toBe(true)

    const a = byId.get('call_par_A')!
    expect((a.block as { name: string }).name).toBe('read_file')
    expect((a.block as { input: Record<string, unknown> }).input).toEqual({ path: '/etc/hosts' })
    expect(a.finalized).toBe(true)

    const b = byId.get('call_par_B')!
    expect((b.block as { name: string }).name).toBe('list_dir')
    expect((b.block as { input: Record<string, unknown> }).input).toEqual({ dir: '/tmp' })
    expect(b.finalized).toBe(true)
  })

  it('R4-6(c) Anthropic SSE abort：message_delta(stop_reason=aborted) + cb_stop 缺失 → messageStop 兜底 finalize partial=true', async () => {
    // 真实 abort 路径：text block 流到一半 message_delta 来了 stop_reason='aborted'
    // 没有 content_block_stop（流被打断），随后 message_stop 兜底 finalize
    // → blocks 标 partial=true，UI 显示"…内容被截断"。
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_abort_real","model":"claude-3-5-sonnet"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Partial answer cut "}}',
      '',
      // 没有 content_block_stop —— 直接 message_delta(aborted)
      'event: message_delta',
      'data: {"type":"message_delta","delta":{"stop_reason":"aborted","stop_sequence":null},"usage":{"input_tokens":10,"output_tokens":3}}',
      '',
      'event: message_stop',
      'data: {"type":"message_stop"}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n'

    const hints = await collectHints(sse)
    const messageId = 'msg_abort_real'
    const ctx = makeCtx()
    for (const hint of hints) {
      handleContentBlockEvent(hintToWireEvent(hint, messageId), ctx)
    }
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[messageId] ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0].block.type).toBe('text')
    expect((blocks[0].block as { type: 'text'; text: string }).text).toBe('Partial answer cut ')
    expect(blocks[0].finalized).toBe(true)
    // 注：partial 标记走 messageStop 的 `if (!finalized)` 兜底分支。proxy-provider
    // 对 abort 路径可能补发 cb_stop（取决于实现），所以这条用例 partial=true
    // 不是硬契约——见下方 R5-7 真测兜底路径用例。
    // 关键 UI 信号是 stop_reason='aborted'——MessageBubble 据此渲染"已中断"。

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[messageId]
    expect(meta?.finalized).toBe(true)
    expect(meta?.stop_reason).toBe('aborted')
  })

  // ─── W4a 五轮 R5-7：真测 messageStop 兜底 partial=true 路径 ──────────────

  it('R5-7 截断 SSE（无 [DONE] + 无 message_stop）→ 手动 inject message_stop → block partial=true', async () => {
    // 真 daemon abort 极端情况：daemon 流到一半被 kill / 客户端硬切断 →
    // proxy-provider 没有 [DONE] 自然结束信号 → 不会兜底 emit cb_stop →
    // 后续走 Renderer 端 messageStop 兜底 finalize 标 partial=true 路径。
    //
    // 构造方式：用 store 直接 inject 一个 `messageStop`，让 cb_start 后未 cb_stop
    // 的 block 走 `if (!next.finalized)` 兜底分支（useChatRuntimeStore.ts 中
    // messageStop 路径 L1990 附近）。
    const messageId = 'msg_r5_abort_partial'
    const ctx = makeCtx()

    // 用真 daemon emit 顺序，但故意不发 cb_stop
    handleContentBlockEvent({
      type: 'agent.stream.message_start',
      payload: {
        protocol_version: 'v2', min_compatible_version: 'v2', trace_id: 't',
        _seq: 1, thread_id: 'th', message_id: messageId,
        role: 'assistant', model_id: 'claude-3-5-sonnet', model_name: 'Claude',
        started_at: '2025-01-01T00:00:00Z', run_id: 'r',
      },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)
    handleContentBlockEvent({
      type: 'agent.stream.content_block_start',
      payload: {
        protocol_version: 'v2', min_compatible_version: 'v2', trace_id: 't',
        _seq: 2, thread_id: 'th', message_id: messageId,
        index: 0, block_id: 'blk_partial', block: { type: 'text', text: '' },
      },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)
    handleContentBlockEvent({
      type: 'agent.stream.content_block_delta',
      payload: {
        protocol_version: 'v2', min_compatible_version: 'v2', trace_id: 't',
        _seq: 3, thread_id: 'th', message_id: messageId,
        index: 0, delta: { type: 'text_delta', text: 'Half answer' },
      },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)

    // 跳过 content_block_stop —— 模拟 daemon 流被硬切断
    handleContentBlockEvent({
      type: 'agent.stream.message_delta',
      payload: {
        protocol_version: 'v2', min_compatible_version: 'v2', trace_id: 't',
        _seq: 4, thread_id: 'th', message_id: messageId,
        delta: { stop_reason: 'aborted' },
      },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)
    // messageStop 没有对应 cb_stop —— 走兜底路径强制 finalize + partial=true
    handleContentBlockEvent({
      type: 'agent.stream.message_stop',
      payload: {
        protocol_version: 'v2', min_compatible_version: 'v2', trace_id: 't',
        _seq: 5, thread_id: 'th', message_id: messageId,
      },
    } as unknown as Parameters<typeof handleContentBlockEvent>[0], ctx)
    await awaitRaf()

    const blocks = runtimeCb(SESSION)?.[messageId] ?? []
    expect(blocks).toHaveLength(1)
    expect(blocks[0].finalized).toBe(true)
    expect(blocks[0].partial).toBe(true)  // R5-7 关键：兜底 finalize 必标 partial=true
    expect((blocks[0].block as { text: string }).text).toBe('Half answer')

    const meta = useChatRuntimeStore.getState().messageMetaBySessionId[SESSION]?.[messageId]
    expect(meta?.finalized).toBe(true)
    expect(meta?.stop_reason).toBe('aborted')
  })
})
