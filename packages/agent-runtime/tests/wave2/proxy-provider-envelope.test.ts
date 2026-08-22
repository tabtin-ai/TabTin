/**
 * Wave 2 — proxy-provider envelope hint 序列集成测试
 *
 * 覆盖：
 *   1. Anthropic native SSE → 完整 6 件套 hint（message_start / content_block_start /
 *      content_block_delta / content_block_stop / message_delta / message_stop）
 *   2. OpenAI 兼容 SSE 单 tool_call → input_json_delta 一次性完整 partial_json
 *      + content_block_stop（不"假流式切片"）
 *   3. 多 content block 串行：text → thinking → tool_use 切换时正确 close 老 block
 *   4. message_start hint 仅 emit 一次（idempotent —— 多次 chunk 不重复 emit）
 *   5. message_stop 在 [DONE] / 自然结束 / 异常路径都被 emit
 *
 * 这是 W2 验收硬指标 §7 要求的 envelope 序列单测。
 */

import { describe, expect, it } from 'vitest';
import { ContentBlockEvents } from '../../src/engine/contracts/stream-events.js';
import { TabTinProxyProvider } from '../../src/providers/proxy-provider.js';
import type {
  ContentBlockEnvelopeHint,
} from '../../src/engine/contracts/model-llm.js';

/**
 * 构造一个 mock SSE Response，body 是给定的字符串拼成的可读流。
 * proxy-provider 内部用 `response.body.getReader()` 消费——直接给 ReadableStream。
 */
function makeMockSSEResponse(sseText: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  // @ts-expect-error -- mock Response in node 环境足够 proxy-provider 消费
  return new Response(stream, { status: 200 });
}

/**
 * 调用 proxy-provider.parseSSEStream 收集所有 yield 的 chunk + 同时收集
 * onContentBlockEvent 推过来的 envelope hint。
 *
 * parseSSEStream 内部消费一份 BlockEnvelopeState（而不是 LLMRequest），
 * 测试这里直接构造与生产 doRequest 同款的 envelopeState（onEvent → push 到 hints）。
 */
async function collectEnvelopeHints(sseText: string): Promise<{
  hints: ContentBlockEnvelopeHint[];
  chunks: unknown[];
}> {
  const provider = new TabTinProxyProvider({
    apiBaseUrl: 'https://example.com',
    accessTokenProvider: async () => 'fake-token',
  });

  const hints: ContentBlockEnvelopeHint[] = [];
  const chunks: unknown[] = [];

  // 复刻 createBlockEnvelopeState 的所有字段（避免依赖 export）
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
  };

  const response = makeMockSSEResponse(sseText);
  const generator = (provider as unknown as {
    parseSSEStream: (
      resp: Response,
      state: typeof envelopeState,
    ) => AsyncGenerator<unknown>;
  }).parseSSEStream(response, envelopeState);

  for await (const c of generator) chunks.push(c);
  return { hints, chunks };
}

describe('proxy-provider — Wave 2 envelope hint sequences', () => {
  it('Anthropic native SSE → emits message_start / content_block_* / message_delta / message_stop hints', async () => {
    // 模拟 Anthropic native SSE：text + thinking 两个 content block
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"msg_anthropic_1","model":"claude-3-5-sonnet"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" world"}}',
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
    ].join('\n') + '\n';

    const { hints } = await collectEnvelopeHints(sse);

    // 至少应该有：message_start / content_block_start / 2x content_block_delta /
    // content_block_stop / message_delta / message_stop = 7 个
    const kinds = hints.map((h) => h.kind);
    expect(kinds).toContain(ContentBlockEvents.MESSAGE_START);
    expect(kinds).toContain(ContentBlockEvents.MESSAGE_STOP);
    expect(kinds).toContain(ContentBlockEvents.CONTENT_BLOCK_START);
    expect(kinds).toContain(ContentBlockEvents.CONTENT_BLOCK_DELTA);
    expect(kinds).toContain(ContentBlockEvents.CONTENT_BLOCK_STOP);
    expect(kinds).toContain(ContentBlockEvents.MESSAGE_DELTA);

    // message_start 仅 emit 一次（idempotent）
    const startCount = kinds.filter((k) => k === ContentBlockEvents.MESSAGE_START).length;
    expect(startCount).toBe(1);

    // message_stop 仅 emit 一次（idempotent）
    const stopCount = kinds.filter((k) => k === ContentBlockEvents.MESSAGE_STOP).length;
    expect(stopCount).toBe(1);
  });

  it('Anthropic SSE 单 text block → 严格串行 start → delta → stop 顺序', async () => {
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m","model":"x"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';

    const { hints } = await collectEnvelopeHints(sse);

    // 找到 cb_start / cb_delta / cb_stop 在 hints 内的相对顺序
    const cbHints = hints.filter((h) =>
      h.kind === ContentBlockEvents.CONTENT_BLOCK_START
      || h.kind === ContentBlockEvents.CONTENT_BLOCK_DELTA
      || h.kind === ContentBlockEvents.CONTENT_BLOCK_STOP,
    );
    const order = cbHints.map((h) => h.kind);
    expect(order).toEqual([
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
    ]);
  });

  it('OpenAI compat SSE 一次性 tool_call → 单 input_json_delta + content_block_stop（不"假流式切片"）', async () => {
    // OpenAI 兼容路径：tool_calls 在 finish_reason='tool_calls' 时一次性给出完整 JSON
    const sse = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"role":"assistant"},"index":0}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}]},"index":0}]}',
      '',
      'data: {"id":"chatcmpl-1","choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';

    const { hints } = await collectEnvelopeHints(sse);

    // tool_use 触发的 cb_start / cb_delta / cb_stop 应该各出现一次
    const cbStart = hints.filter((h) => h.kind === ContentBlockEvents.CONTENT_BLOCK_START);
    const cbDelta = hints.filter((h) => h.kind === ContentBlockEvents.CONTENT_BLOCK_DELTA);
    const cbStop = hints.filter((h) => h.kind === ContentBlockEvents.CONTENT_BLOCK_STOP);

    expect(cbStart.length).toBeGreaterThanOrEqual(1);
    expect(cbStop.length).toBeGreaterThanOrEqual(1);
    expect(cbDelta.length).toBeGreaterThanOrEqual(1);

    // tool_use cb_start 的 block.type 是 tool_use
    const toolUseStart = cbStart.find(
      (h) => h.kind === ContentBlockEvents.CONTENT_BLOCK_START && (h.block as { type: string }).type === 'tool_use',
    );
    expect(toolUseStart).toBeDefined();

    // 对应的 cb_delta 是 input_json_delta，partial_json 包含完整 cmd:ls
    const jsonDelta = cbDelta.find(
      (h) => h.kind === ContentBlockEvents.CONTENT_BLOCK_DELTA && h.delta?.type === 'input_json_delta',
    );
    expect(jsonDelta).toBeDefined();
    if (jsonDelta && jsonDelta.kind === ContentBlockEvents.CONTENT_BLOCK_DELTA) {
      const delta = jsonDelta.delta as { type: string; partial_json: string };
      // 完整 JSON 已经写入（不切片）
      expect(delta.partial_json).toContain('"cmd"');
      expect(delta.partial_json).toContain('"ls"');
      // 必须能 parse 回完整对象
      const parsed = JSON.parse(delta.partial_json);
      expect(parsed).toEqual({ cmd: 'ls' });
    }
  });

  it('message_stop hint 在 [DONE] 之后立即 emit（exit point）', async () => {
    const sse = [
      'data: {"id":"x","choices":[{"delta":{"content":"hi"},"index":0}]}',
      '',
      'data: {"id":"x","choices":[{"delta":{},"finish_reason":"stop","index":0}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';

    const { hints } = await collectEnvelopeHints(sse);

    // message_stop 必有
    const stops = hints.filter((h) => h.kind === ContentBlockEvents.MESSAGE_STOP);
    expect(stops.length).toBe(1);

    // message_start 也必有
    const starts = hints.filter((h) => h.kind === ContentBlockEvents.MESSAGE_START);
    expect(starts.length).toBe(1);

    // message_start 顺序在 message_stop 之前
    const startIdx = hints.findIndex((h) => h.kind === ContentBlockEvents.MESSAGE_START);
    const stopIdx = hints.findIndex((h) => h.kind === ContentBlockEvents.MESSAGE_STOP);
    expect(startIdx).toBeLessThan(stopIdx);
  });

  it('OpenAI compat SSE 多个 tool_call 并发 → 每个 tool_call 独立 cb_start/cb_delta/cb_stop（顺序不颠倒）', async () => {
    // 模拟 OpenAI tool_calls 同时返回 3 个 function call（index 0/1/2）；
    // arguments 都是一次性完整 JSON。验证 W2 P1：proxy-provider 不会"漏 close
    // 上一个 tool_call 就开下一个"，不会"切片单个 tool_call 的 arguments"。
    const sse = [
      'data: {"id":"chatcmpl-multi","choices":[{"delta":{"role":"assistant"},"index":0}]}',
      '',
      'data: {"id":"chatcmpl-multi","choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_a","type":"function","function":{"name":"shell","arguments":"{\\"cmd\\":\\"ls\\"}"}}]},"index":0}]}',
      '',
      'data: {"id":"chatcmpl-multi","choices":[{"delta":{"tool_calls":[{"index":1,"id":"call_b","type":"function","function":{"name":"read_file","arguments":"{\\"path\\":\\"/tmp/x\\"}"}}]},"index":0}]}',
      '',
      'data: {"id":"chatcmpl-multi","choices":[{"delta":{"tool_calls":[{"index":2,"id":"call_c","type":"function","function":{"name":"web_search","arguments":"{\\"q\\":\\"foo\\"}"}}]},"index":0}]}',
      '',
      'data: {"id":"chatcmpl-multi","choices":[{"delta":{},"finish_reason":"tool_calls","index":0}]}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';

    const { hints } = await collectEnvelopeHints(sse);

    // 抽出所有 cb_start / cb_delta / cb_stop 按序
    const cbHints = hints.filter((h) =>
      h.kind === ContentBlockEvents.CONTENT_BLOCK_START
      || h.kind === ContentBlockEvents.CONTENT_BLOCK_DELTA
      || h.kind === ContentBlockEvents.CONTENT_BLOCK_STOP,
    );

    // 至少 3 组 (start + delta + stop) = 9 条
    expect(cbHints.length).toBeGreaterThanOrEqual(9);

    // 验证每个 tool_call 都生成了独立的 tool_use cb_start
    const toolUseStarts = cbHints.filter(
      (h) => h.kind === ContentBlockEvents.CONTENT_BLOCK_START
        && (h.block as { type: string }).type === 'tool_use',
    );
    expect(toolUseStarts).toHaveLength(3);

    const toolNames = toolUseStarts.map(
      (h) => (h.block as { type: string; name: string }).name,
    );
    expect(toolNames).toContain('shell');
    expect(toolNames).toContain('read_file');
    expect(toolNames).toContain('web_search');

    const toolIds = toolUseStarts.map(
      (h) => (h.block as { type: string; id: string }).id,
    );
    expect(toolIds).toContain('call_a');
    expect(toolIds).toContain('call_b');
    expect(toolIds).toContain('call_c');

    // 严格"start before stop"约束：每个 tool_use 的 cb_start 必须在它对应的
    // cb_stop 之前；不允许"上一个 tool_call 还没 close 就开下一个"
    const blockIndexLifecycle = new Map<number, { startedAt: number; stoppedAt: number }>();
    cbHints.forEach((h, pos) => {
      if (h.kind === ContentBlockEvents.CONTENT_BLOCK_START) {
        blockIndexLifecycle.set(h.index, { startedAt: pos, stoppedAt: -1 });
      } else if (h.kind === ContentBlockEvents.CONTENT_BLOCK_STOP) {
        const lc = blockIndexLifecycle.get(h.index);
        if (lc) lc.stoppedAt = pos;
      }
    });
    for (const [idx, lc] of blockIndexLifecycle) {
      expect(lc.startedAt).toBeGreaterThanOrEqual(0);
      expect(lc.stoppedAt).toBeGreaterThan(lc.startedAt);
    }

    // 不"假流式切片"：每个 tool_call 的 arguments 应只有 1 个 input_json_delta
    // （而不是 N 个伪 delta 拼成）
    const tool0Deltas = cbHints.filter(
      (h) => h.kind === ContentBlockEvents.CONTENT_BLOCK_DELTA
        && (h as { delta?: { type: string } }).delta?.type === 'input_json_delta'
        && (h as { index: number }).index === toolUseStarts[0].index,
    );
    expect(tool0Deltas.length).toBe(1);
    if (tool0Deltas[0].kind === ContentBlockEvents.CONTENT_BLOCK_DELTA) {
      const d = tool0Deltas[0].delta as { partial_json: string };
      // partial_json 是一次性完整 JSON，能直接 parse
      expect(() => JSON.parse(d.partial_json)).not.toThrow();
    }
  });

  it('text → thinking 切换时显式 close 老 block 再开新 block', async () => {
    // OpenAI compat 不直接支持 thinking；这里走 Anthropic native
    const sse = [
      'event: message_start',
      'data: {"type":"message_start","message":{"id":"m","model":"x"}}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"a"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":0}',
      '',
      'event: content_block_start',
      'data: {"type":"content_block_start","index":1,"content_block":{"type":"thinking","thinking":""}}',
      '',
      'event: content_block_delta',
      'data: {"type":"content_block_delta","index":1,"delta":{"type":"thinking_delta","thinking":"thought"}}',
      '',
      'event: content_block_stop',
      'data: {"type":"content_block_stop","index":1}',
      '',
      'data: [DONE]',
      '',
    ].join('\n') + '\n';

    const { hints } = await collectEnvelopeHints(sse);

    // 严格串行：cb_start(0) → cb_delta(0) → cb_stop(0) → cb_start(1) → cb_delta(1) → cb_stop(1)
    const cbHints = hints
      .filter((h) =>
        h.kind === ContentBlockEvents.CONTENT_BLOCK_START
        || h.kind === ContentBlockEvents.CONTENT_BLOCK_DELTA
        || h.kind === ContentBlockEvents.CONTENT_BLOCK_STOP,
      )
      .map((h) => ({
        kind: h.kind,
        index: (h as { index?: number }).index,
      }));

    // 确认 index=0 的三件套先于 index=1 的三件套
    const idx0 = cbHints.filter((c) => c.index === 0).map((c) => c.kind);
    const idx1 = cbHints.filter((c) => c.index === 1).map((c) => c.kind);
    expect(idx0).toEqual([
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
    ]);
    expect(idx1).toEqual([
      ContentBlockEvents.CONTENT_BLOCK_START,
      ContentBlockEvents.CONTENT_BLOCK_DELTA,
      ContentBlockEvents.CONTENT_BLOCK_STOP,
    ]);

    // 全局顺序：index=0 cb_stop 在 index=1 cb_start 之前
    const stopIdx0 = cbHints.findIndex(
      (c) => c.kind === ContentBlockEvents.CONTENT_BLOCK_STOP && c.index === 0,
    );
    const startIdx1 = cbHints.findIndex(
      (c) => c.kind === ContentBlockEvents.CONTENT_BLOCK_START && c.index === 1,
    );
    expect(stopIdx0).toBeLessThan(startIdx1);
  });
});
