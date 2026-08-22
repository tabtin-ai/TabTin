/**
 *  P0 — 流中途断网（连接被杀）必须进入重试管线。
 *
 * 背景：`parseSSEStream` 里 `reader.read()` 的 rejection 是 undici 原生错误
 * （`TypeError: terminated`、cause=ECONNRESET/ENETDOWN 等），不是 AgentError。
 * `isRetryableError()` 第一行 `if (!(err instanceof AgentError)) return false`
 * → 中途断线直接判 non-retryable，整轮立即失败，重试机制根本没启动——
 * 用户网络恢复后自然"不继续输出"。
 *
 * 修复：readWithStallCheck 把非 AgentError 的读错误包成 retryable AgentError，
 * 且带 stall 语义（details.stall=true）让 query.ts 走既有 stall-retry 恢复
 * 路径（丢弃 partial 累积 + 切新 message 边界），details.connectionLost=true
 * 供 telemetry 区分真·30s 无数据 stall。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import {
  AgentError,
} from '../src/engine/contracts/kernel.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';

const encoder = new TextEncoder();

/** SSE 流：先吐 partial 文本，然后连接层报错（模拟断网 RST）。 */
function makeBrokenStream(errToThrow: Error): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"部分输出"}}]}\n\n'),
      );
      controller.error(errToThrow);
    },
  });
}

/** SSE 流：完整成功输出 + [DONE]。 */
function makeSuccessStream(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: {"choices":[{"delta":{"content":${JSON.stringify(text)}}}]}\n\n`),
      );
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n'),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'unit-test',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 64,
    ...overrides,
  };
}

function makeProvider(maxRetries: number): TabTinProxyProvider {
  return new TabTinProxyProvider({
    proxyUrl: 'http://localhost:0/llm/proxy',
    deviceToken: 't',
    agentId: 'a',
    threadId: 's',
    maxRetries,
    retryBaseDelayMs: 1,
  });
}

describe(' · 流中途连接断开走重试管线', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('mid-stream 读错误（非 AgentError）→ 重试 → 第二次成功拿到完整输出', async () => {
    // undici 断网的真实形态：TypeError('terminated')，非 AgentError。
    const rawNetError = new TypeError('terminated');
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call++;
      return new Response(
        call === 1 ? makeBrokenStream(rawNetError) : makeSuccessStream('恢复后的完整回复'),
        { status: 200 },
      );
    });
    vi.stubGlobal('fetch', fetchSpy);

    const retries: Array<{ isStallRetry: boolean }> = [];
    const provider = makeProvider(3);
    const chunks: LLMResponseChunk[] = [];
    for await (const chunk of provider.createStream(
      makeRequest({
        onRetryAttempt: (info) => {
          retries.push({ isStallRetry: info.isStallRetry ?? false });
        },
      }),
    )) {
      chunks.push(chunk);
    }

    // 断线后发生了恰好一次重试，且第二个 attempt 成功收尾。
    expect(fetchSpy.mock.calls.length).toBe(2);
    expect(retries.length).toBe(1);
    // stall=true → query.ts 按 stall-retry 路径重置 partial 累积 + 切 message 边界。
    expect(retries[0]!.isStallRetry).toBe(true);

    const texts = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => (c as { text?: string }).text)
      .join('');
    expect(texts).toContain('恢复后的完整回复');
    expect(chunks.some((c) => c.type === 'stop')).toBe(true);
  });

  it('断网持续超过重试预算 → 以 retryable AgentError(connectionLost) 终止', async () => {
    const rawNetError = new TypeError('terminated');
    const fetchSpy = vi.fn(async () => new Response(makeBrokenStream(rawNetError), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const provider = makeProvider(2);
    let thrown: unknown = null;
    try {
      for await (const _ of provider.createStream(makeRequest())) {
        void _;
      }
    } catch (err) {
      thrown = err;
    }

    // 每个 attempt 都中途断线 → 烧完预算（maxRetries=2 → 3 个 attempt）后抛出。
    expect(fetchSpy.mock.calls.length).toBe(3);
    expect(thrown).toBeInstanceOf(AgentError);
    const agentErr = thrown as AgentError;
    expect(agentErr.message).toMatch(/connection lost/i);
    expect(agentErr.details?.connectionLost).toBe(true);
    expect(agentErr.details?.stall).toBe(true);
  });

  it('AgentError 形态的读错误（如 stall 超时）不被二次包装', async () => {
    // stall 路径本身 reject 的是 AgentError——包装逻辑必须原样透传，
    // 否则 details.stall 之外还会叠一层 connectionLost 语义污染 telemetry。
    const stallErr = new AgentError('LLM stream stalled (no data for 30s)', 'LLM_ERROR', {
      retryable: true,
      details: { retryable: true, stall: true },
    });
    const fetchSpy = vi.fn(async () => new Response(makeBrokenStream(stallErr), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);

    const provider = makeProvider(0);
    let thrown: unknown = null;
    try {
      for await (const _ of provider.createStream(makeRequest())) {
        void _;
      }
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(AgentError);
    const agentErr = thrown as AgentError;
    expect(agentErr.message).toMatch(/stalled/);
    expect(agentErr.details?.connectionLost).toBeUndefined();
  });

  it('SSE error chunk 502（发版/网关切断）→ 重开流后成功', async () => {
    let call = 0;
    const fetchSpy = vi.fn(async () => {
      call++;
      if (call === 1) {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  'data: {"error":{"message":"Bad Gateway","status":502,"type":"upstream_error"}}\n\n',
                ),
              );
              controller.enqueue(encoder.encode('data: [DONE]\n\n'));
              controller.close();
            },
          }),
          { status: 200 },
        );
      }
      return new Response(makeSuccessStream('发版后重开的回复'), { status: 200 });
    });
    vi.stubGlobal('fetch', fetchSpy);

    const retries: Array<{ isStallRetry: boolean }> = [];
    const provider = makeProvider(3);
    const chunks: LLMResponseChunk[] = [];
    for await (const chunk of provider.createStream(
      makeRequest({
        onRetryAttempt: (info) => {
          retries.push({ isStallRetry: info.isStallRetry ?? false });
        },
      }),
    )) {
      chunks.push(chunk);
    }

    expect(fetchSpy.mock.calls.length).toBe(2);
    expect(retries.length).toBe(1);
    expect(retries[0]!.isStallRetry).toBe(true);
    const texts = chunks
      .filter((c) => c.type === 'text_delta')
      .map((c) => (c as { text?: string }).text)
      .join('');
    expect(texts).toContain('发版后重开的回复');
  });
});
