/**
 * 用户停止必须真正 cancel 底层 fetch——不能只停本地 for-await。
 *
 * 回归：LLMRequest.signal 未接到 doRequest 时，proxy 用独立 AbortController
 * 只绑超时；用户 abort 后上游 SSE/计费仍继续。
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import { AgentError } from '../src/engine/contracts/kernel.js';
import type { LLMRequest } from '../src/engine/contracts/model-llm.js';

const encoder = new TextEncoder();

/** 模拟真实 fetch：signal abort 时打断已返回的 body reader。 */
function makeFetchThatHonorsSignal(
  onFetch: (signal: AbortSignal | undefined) => void,
): ReturnType<typeof vi.fn> {
  return vi.fn(async (_url: string, init?: RequestInit) => {
    const signal = init?.signal;
    onFetch(signal);
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('data: {"choices":[{"delta":{"content":"partial"}}]}\n\n'),
          );
          const fail = (): void => {
            try {
              controller.error(new DOMException('The operation was aborted.', 'AbortError'));
            } catch { /* already closed */ }
          };
          if (signal?.aborted) {
            fail();
            return;
          }
          signal?.addEventListener('abort', fail, { once: true });
        },
      }),
      { status: 200 },
    );
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

describe('proxy-provider · 用户 abort 掐断 fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('request.signal abort → fetch 的 signal 变为 aborted，抛 ABORT 且不重试', async () => {
    const userAbort = new AbortController();
    let fetchSignal: AbortSignal | undefined;
    const fetchSpy = makeFetchThatHonorsSignal((signal) => {
      fetchSignal = signal;
    });
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 't',
      agentId: 'a',
      threadId: 's',
      maxRetries: 3,
      retryBaseDelayMs: 1,
    });

    const consume = (async () => {
      let sawContent = false;
      for await (const chunk of provider.createStream(
        makeRequest({ signal: userAbort.signal }),
      )) {
        if (chunk.type === 'text_delta') {
          sawContent = true;
          userAbort.abort();
        }
      }
      expect(sawContent).toBe(true);
    })();

    await expect(consume).rejects.toMatchObject({
      name: 'AgentError',
      code: 'ABORT',
    });

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSignal).toBeDefined();
    expect(fetchSignal!.aborted).toBe(true);
  });

  it('构造前已 aborted 的 signal → 不发 fetch，直接 ABORT', async () => {
    const userAbort = new AbortController();
    userAbort.abort();
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 't',
      agentId: 'a',
      threadId: 's',
      maxRetries: 2,
      retryBaseDelayMs: 1,
    });

    await expect(async () => {
      for await (const _ of provider.createStream(
        makeRequest({ signal: userAbort.signal }),
      )) {
        // no-op
      }
    }).rejects.toBeInstanceOf(AgentError);

    await expect(async () => {
      for await (const _ of provider.createStream(
        makeRequest({ signal: userAbort.signal }),
      )) {
        // no-op
      }
    }).rejects.toMatchObject({ code: 'ABORT' });

    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
