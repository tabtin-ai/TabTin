import { describe, expect, it } from 'vitest';
import { LocalCodexResponsesProvider } from '../src/providers/local-codex-responses-provider.js';
import type { LLMRequest, LLMResponseChunk } from '../src/engine/contracts/model-llm.js';

/**
 * ：本地 ChatGPT Codex 通道的 usage 解析契约。
 *
 * Responses API 把缓存/推理明细放在 `input_tokens_details.cached_tokens` /
 * `output_tokens_details.reasoning_tokens` 子对象里。旧实现只保留
 * input/output/total 三字段，缓存命中完全不可观测（ 根因 2）；
 * 本测试锁定明细字段归一化到 UsageReport 既有字段的行为。
 */

function sseResponse(events: string[]): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const encoder = new TextEncoder();
      for (const event of events) {
        controller.enqueue(encoder.encode(`data: ${event}\n\n`));
      }
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/event-stream' },
  });
}

async function collectChunks(events: string[]): Promise<LLMResponseChunk[]> {
  const provider = new LocalCodexResponsesProvider({
    resolveAuth: async () => ({ accessToken: 'test-token', accountId: 'test-account' }),
    fetchImpl: async () => sseResponse(events),
  });
  const request: LLMRequest = {
    model: 'gpt-5.6-sol',
    messages: [{ role: 'user', content: 'hi' }],
  } as LLMRequest;
  const chunks: LLMResponseChunk[] = [];
  for await (const chunk of provider.createStream(request)) chunks.push(chunk);
  return chunks;
}

describe('LocalCodexResponsesProvider usage 解析', () => {
  it('归一化明细缓存字段，并把 OpenAI 含缓存的 input 换算为 Anthropic 口径（不含缓存）', async () => {
    const chunks = await collectChunks([
      JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            // OpenAI Responses 口径：input_tokens 已含 cached_tokens。
            input_tokens: 120_000,
            input_tokens_details: { cached_tokens: 110_000 },
            output_tokens: 900,
            output_tokens_details: { reasoning_tokens: 300 },
            total_tokens: 120_900,
          },
        },
      }),
    ]);

    const usageChunk = chunks.find((chunk) => chunk.type === 'usage');
    expect(usageChunk?.usage).toEqual({
      // 内部 UsageReport 是 Anthropic 口径：input 不含缓存读（120000 - 110000）。
      input_tokens: 10_000,
      output_tokens: 900,
      total_tokens: 120_900,
      cache_read_input_tokens: 110_000,
      reasoning_tokens: 300,
    });
  });

  it('归一化 GPT-5.6 cache_write_tokens，且不与新增输入重复计数', async () => {
    const chunks = await collectChunks([
      JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 120_000,
            input_tokens_details: {
              cached_tokens: 80_000,
              cache_write_tokens: 30_000,
            },
            output_tokens: 900,
            total_tokens: 120_900,
          },
        },
      }),
    ]);

    const usageChunk = chunks.find((chunk) => chunk.type === 'usage');
    expect(usageChunk?.usage).toEqual({
      input_tokens: 10_000,
      output_tokens: 900,
      total_tokens: 120_900,
      cache_read_input_tokens: 80_000,
      cache_creation_input_tokens: 30_000,
    });
  });

  it('顶层 cache_read_input_tokens（Anthropic 口径）不做 input 换算', async () => {
    const chunks = await collectChunks([
      JSON.stringify({
        type: 'response.completed',
        response: {
          usage: {
            input_tokens: 10_000,
            cache_read_input_tokens: 110_000,
            output_tokens: 900,
            total_tokens: 120_900,
          },
        },
      }),
    ]);

    const usageChunk = chunks.find((chunk) => chunk.type === 'usage');
    expect(usageChunk?.usage).toEqual({
      input_tokens: 10_000,
      output_tokens: 900,
      total_tokens: 120_900,
      cache_read_input_tokens: 110_000,
    });
  });

  it('无明细字段时保持三字段形态（向后兼容）', async () => {
    const chunks = await collectChunks([
      JSON.stringify({
        type: 'response.completed',
        response: {
          usage: { input_tokens: 100, output_tokens: 10, total_tokens: 110 },
        },
      }),
    ]);

    const usageChunk = chunks.find((chunk) => chunk.type === 'usage');
    expect(usageChunk?.usage).toEqual({
      input_tokens: 100,
      output_tokens: 10,
      total_tokens: 110,
    });
  });
});
