/**
 * Widget Wave 1（widget RFC §4.1）— provider 层 tool_use args 流式增量。
 *
 * 验证两条流式协议下都能 yield `tool_use_delta` chunks：
 *   1. OpenAI-compatible（默认主流量）：delta.tool_calls[].function.arguments
 *      逐段到达，每段 yield 一条 tool_use_delta；finish_reason='tool_calls' 时
 *      flushToolAccumulators 再 yield 一条完整的 tool_use chunk
 *   2. Anthropic native：content_block_start (tool_use) →
 *      content_block_delta (input_json_delta) →  content_block_stop
 *
 * ：持久层 / chunk 上的 tool id 为 TabTin `tu_*`，同流内 delta 与 final 稳定一致。
 */

import { describe, expect, it } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import { isTabtinToolUseId } from '../src/engine/context/tool-id-mapper.js';
import type {
  ContentBlockEnvelopeHint,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';

function makeSSEStream(lines: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const line of lines) {
        controller.enqueue(encoder.encode(line));
      }
      controller.close();
    },
  });
}

function makeEnvelopeState() {
  return {
    onEvent: (_hint: ContentBlockEnvelopeHint) => {},
    blockIndex: -1,
    activeKind: null as 'text' | 'thinking' | 'tool_use' | null,
    activeBlockId: null as string | null,
    anthropicIndex: new Map<
      number,
      { myIndex: number; toolUseId: string; emittedDelta: boolean }
    >(),
    openaiToolEmitted: new Map<
      number,
      { myIndex: number; blockId: string; emittedDelta: boolean }
    >(),
    messageStartEmitted: false,
    messageDeltaEmitted: false,
    messageStopEmitted: false,
  };
}

async function collectChunks(
  provider: TabTinProxyProvider,
  sseLines: string[],
): Promise<LLMResponseChunk[]> {
  const stream = makeSSEStream(sseLines);
  // 须用真实 Response：parseSSEStream 会读 headers（telemetry）
  const fakeResponse = new Response(stream, { status: 200 });
  const envelopeState = makeEnvelopeState();
  const parse = (provider as unknown as {
    parseSSEStream: (
      resp: Response,
      state: typeof envelopeState,
      model: string,
    ) => AsyncIterable<LLMResponseChunk>;
  }).parseSSEStream.bind(provider);
  const chunks: LLMResponseChunk[] = [];
  for await (const chunk of parse(fakeResponse, envelopeState, 'kimi-k2.6')) {
    chunks.push(chunk);
  }
  return chunks;
}

const baseConfig = {
  proxyUrl: 'http://localhost:0/llm/proxy',
  deviceToken: 'token-abc',
  agentId: 'ag-x',
  threadId: 'ss-x',
  maxRetries: 0,
} as const;

describe('proxy-provider — OpenAI-compatible tool args delta', () => {
  it('args 逐段到达时 yield 多条 tool_use_delta，finish 时 yield 完整 tool_use', async () => {
    const provider = new TabTinProxyProvider(baseConfig);

    const lines = [
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_widget_1', function: { name: 'show_widget', arguments: '' } }] },
          finish_reason: null,
        }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{"format":' } }] },
          finish_reason: null,
        }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"svg",' } }] },
          finish_reason: null,
        }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '"code":"<svg/>"}' } }] },
          finish_reason: 'tool_calls',
        }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const chunks = await collectChunks(provider, lines);

    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
    const finals = chunks.filter((c) => c.type === 'tool_use');

    expect(deltas).toHaveLength(3);
    const tabtinId = finals[0]?.toolUse?.id;
    expect(tabtinId && isTabtinToolUseId(tabtinId)).toBe(true);
    expect(tabtinId).not.toBe('call_widget_1');
    expect(deltas[0].toolUseDelta?.id).toBe(tabtinId);
    expect(deltas[0].toolUseDelta?.name).toBe('show_widget');
    expect(deltas[0].toolUseDelta?.argDelta).toBe('{"format":');
    expect(deltas[1].toolUseDelta?.argDelta).toBe('"svg",');
    expect(deltas[2].toolUseDelta?.argDelta).toBe('"code":"<svg/>"}');
    expect(deltas[1].toolUseDelta?.id).toBe(tabtinId);
    expect(deltas[2].toolUseDelta?.id).toBe(tabtinId);

    const accumulated = deltas.map((d) => d.toolUseDelta?.argDelta).join('');
    expect(accumulated).toBe('{"format":"svg","code":"<svg/>"}');

    expect(finals).toHaveLength(1);
    expect(finals[0].toolUse).toEqual({
      id: tabtinId,
      name: 'show_widget',
      input: { format: 'svg', code: '<svg/>' },
    });
  });

  it('arguments 为空 / undefined 时不 yield 空 delta', async () => {
    const provider = new TabTinProxyProvider(baseConfig);

    const lines = [
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, id: 'call_x', function: { name: 'x' } }] },
          finish_reason: null,
        }],
      })}\n\n`,
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] },
          finish_reason: 'tool_calls',
        }],
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const chunks = await collectChunks(provider, lines);
    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].toolUseDelta?.argDelta).toBe('{}');
    expect(deltas[0].toolUseDelta?.id && isTabtinToolUseId(deltas[0].toolUseDelta.id)).toBe(true);
  });
});

describe('proxy-provider — Anthropic native input_json_delta', () => {
  it('content_block_start → input_json_delta * N → content_block_stop 期间 yield tool_use_delta', async () => {
    const provider = new TabTinProxyProvider(baseConfig);

    const lines = [
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 1,
        content_block: { type: 'tool_use', id: 'toolu_anthropic_1', name: 'show_widget' },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '{"format":' },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 1,
        delta: { type: 'input_json_delta', partial_json: '"svg"}' },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'content_block_stop',
        index: 1,
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const chunks = await collectChunks(provider, lines);
    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');

    expect(deltas).toHaveLength(2);
    const tabtinId = deltas[0].toolUseDelta?.id;
    expect(tabtinId && isTabtinToolUseId(tabtinId)).toBe(true);
    expect(tabtinId).not.toBe('toolu_anthropic_1');
    expect(deltas[0].toolUseDelta).toEqual({
      id: tabtinId,
      name: 'show_widget',
      argDelta: '{"format":',
    });
    expect(deltas[1].toolUseDelta).toEqual({
      id: tabtinId,
      name: 'show_widget',
      argDelta: '"svg"}',
    });
  });

  it('content_block_stop 后即使再来 input_json_delta 也不 yield（防止跨块串扰）', async () => {
    const provider = new TabTinProxyProvider(baseConfig);

    const lines = [
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'tool_use', id: 'toolu_a', name: 'tool_a' },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{}' },
      })}\n\n`,
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}\n\n`,
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: 'extra' },
      })}\n\n`,
      'data: [DONE]\n\n',
    ];

    const chunks = await collectChunks(provider, lines);
    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
    expect(deltas).toHaveLength(1);
    expect(deltas[0].toolUseDelta?.argDelta).toBe('{}');
    expect(deltas[0].toolUseDelta?.id && isTabtinToolUseId(deltas[0].toolUseDelta.id)).toBe(true);
  });
});
