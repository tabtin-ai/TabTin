/**
 *  — 入站 SSE tool id 映射为 TabTin 权威 `tu_*`（默认 vitest 套件必跑）。
 *
 * 钉住：
 * - OpenAI / Anthropic 两条路径的 tool_use id 均为 `tu_*`
 * - 同流内 delta 与最终 tool_use 共用同一 tabtin id（不回落到上游 id）
 * - 同流内重复出现的上游 id 稳定映射；跨 parseSSEStream 调用不撞号
 */

import { describe, expect, it } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import { isTabtinToolUseId } from '../src/engine/context/tool-id-mapper.js';
import type {
  ContentBlockEnvelopeHint,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';

function makeMockSSEResponse(sseText: string): Response {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(sseText));
      controller.close();
    },
  });
  return new Response(stream, { status: 200 });
}

function makeEnvelopeState() {
  const hints: ContentBlockEnvelopeHint[] = [];
  return {
    hints,
    state: {
      onEvent: (hint: ContentBlockEnvelopeHint) => hints.push(hint),
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
    },
  };
}

async function collectChunks(sseText: string): Promise<LLMResponseChunk[]> {
  const provider = new TabTinProxyProvider({
    proxyUrl: 'http://localhost:0/llm/proxy',
    deviceToken: 'token-7033',
    agentId: 'ag-7033',
    threadId: 'ss-7033',
    maxRetries: 0,
  });
  const { state } = makeEnvelopeState();
  const response = makeMockSSEResponse(sseText);
  const generator = (
    provider as unknown as {
      parseSSEStream: (
        resp: Response,
        envelopeState: typeof state,
        model: string,
      ) => AsyncGenerator<LLMResponseChunk>;
    }
  ).parseSSEStream(response, state, 'kimi-k2.6');

  const chunks: LLMResponseChunk[] = [];
  for await (const c of generator) chunks.push(c);
  return chunks;
}

describe('proxy-provider tool id remap ', () => {
  it('OpenAI tool_calls：delta 与最终 tool_use 均为 tu_* 且同流稳定', async () => {
    const sse = [
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'run_terminal_command_41',
              function: { name: 'run_terminal_command', arguments: '' },
            }],
          },
          finish_reason: null,
        }],
      })}`,
      '',
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              function: { arguments: '{"command":"echo hi"}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const chunks = await collectChunks(sse);
    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
    const finals = chunks.filter((c) => c.type === 'tool_use');

    expect(deltas.length).toBeGreaterThanOrEqual(1);
    expect(finals).toHaveLength(1);

    const id = finals[0]?.toolUse?.id;
    expect(id).toBeTruthy();
    expect(isTabtinToolUseId(id!)).toBe(true);
    expect(id).not.toBe('run_terminal_command_41');
    for (const d of deltas) {
      expect(d.toolUseDelta?.id).toBe(id);
    }
    expect(finals[0]?.toolUse?.name).toBe('run_terminal_command');
  });

  it('Anthropic tool_use：start/delta 均为 tu_*，不回写上游 toolu_*', async () => {
    const sse = [
      'event: content_block_start',
      `data: ${JSON.stringify({
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: 'toolu_anthropic_1',
          name: 'show_widget',
        },
      })}`,
      '',
      'event: content_block_delta',
      `data: ${JSON.stringify({
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: '{"format":"svg"}' },
      })}`,
      '',
      'event: content_block_stop',
      `data: ${JSON.stringify({ type: 'content_block_stop', index: 0 })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const chunks = await collectChunks(sse);
    const deltas = chunks.filter((c) => c.type === 'tool_use_delta');
    expect(deltas.length).toBeGreaterThanOrEqual(1);

    const id = deltas[0]?.toolUseDelta?.id;
    expect(id).toBeTruthy();
    expect(isTabtinToolUseId(id!)).toBe(true);
    expect(id).not.toBe('toolu_anthropic_1');
    for (const d of deltas) {
      expect(d.toolUseDelta?.id).toBe(id);
    }
  });

  it('独立 parseSSEStream 对相同上游 id 分配不同 tu_*（防跨轮撞号）', async () => {
    const line = [
      `data: ${JSON.stringify({
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: 0,
              id: 'run_terminal_command_41',
              function: { name: 'run_terminal_command', arguments: '{}' },
            }],
          },
          finish_reason: 'tool_calls',
        }],
      })}`,
      '',
      'data: [DONE]',
      '',
    ].join('\n');

    const a = (await collectChunks(line)).find((c) => c.type === 'tool_use')?.toolUse?.id;
    const b = (await collectChunks(line)).find((c) => c.type === 'tool_use')?.toolUse?.id;
    expect(a && isTabtinToolUseId(a)).toBe(true);
    expect(b && isTabtinToolUseId(b)).toBe(true);
    expect(a).not.toBe(b);
  });
});
