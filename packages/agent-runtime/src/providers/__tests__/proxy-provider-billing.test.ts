import { afterEach, describe, expect, it, vi } from 'vitest';
import type { LLMRequest } from '../../engine/contracts/model-llm.js';
import { TabTinProxyProvider } from '../proxy-provider.js';

type HeaderBuilder = {
  buildHeaders(request: LLMRequest, token: string, attemptIndex?: number): Record<string, string>;
};

const baseRequest: LLMRequest = {
  model: 'test-model',
  messages: [],
  maxTokens: 128,
};
const encoder = new TextEncoder();

function createHeaderBuilder(): HeaderBuilder {
  return new TabTinProxyProvider({
    proxyUrl: 'http://127.0.0.1:6060/api/llm/proxy',
    deviceToken: 'device-token',
  }) as unknown as HeaderBuilder;
}

function makeSuccessStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode('data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'),
      );
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

describe('TabTinProxyProvider billing headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('uses one logical billing key and different attempt keys across retries', () => {
    const provider = createHeaderBuilder();
    const request = {
      ...baseRequest,
      logicalBillingKey: 'agent-turn:a:b:1',
      billingIdempotencyKey: 'agent-turn:a:b:1',
    } as LLMRequest & { logicalBillingKey: string };

    const attempt0 = provider.buildHeaders(request, 'token', 0);
    const attempt1 = provider.buildHeaders(request, 'token', 1);

    expect(attempt0['X-TabTin-Billing-Logical-Key']).toBe('agent-turn:a:b:1');
    expect(attempt1['X-TabTin-Billing-Logical-Key']).toBe('agent-turn:a:b:1');
    expect(attempt0['X-TabTin-Billing-Attempt-Key']).toBe('agent-turn:a:b:1:attempt:0');
    expect(attempt1['X-TabTin-Billing-Attempt-Key']).toBe('agent-turn:a:b:1:attempt:1');
    expect(attempt0['X-TabTin-Billing-Idempotency-Key']).toBe('agent-turn:a:b:1:attempt:0');
    expect(attempt1['X-TabTin-Billing-Idempotency-Key']).toBe('agent-turn:a:b:1:attempt:1');
  });

  it('passes the retry attempt index through createStream headers', async () => {
    const fetchSpy = vi
      .fn()
      .mockResolvedValueOnce(new Response('retryable', { status: 503 }))
      .mockResolvedValueOnce(new Response(makeSuccessStream(), { status: 200 }));
    vi.stubGlobal('fetch', fetchSpy);
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://127.0.0.1:6060/api/llm/proxy',
      deviceToken: 'device-token',
      maxRetries: 1,
      retryBaseDelayMs: 1,
    });
    const request = {
      ...baseRequest,
      logicalBillingKey: 'agent-turn:a:b:1',
      billingIdempotencyKey: 'agent-turn:a:b:1',
    } as LLMRequest & { logicalBillingKey: string };

    for await (const _chunk of provider.createStream(request)) {
      // drain stream
    }

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    const attempt0 = fetchSpy.mock.calls[0]?.[1]?.headers as Record<string, string>;
    const attempt1 = fetchSpy.mock.calls[1]?.[1]?.headers as Record<string, string>;
    expect(attempt0['X-TabTin-Billing-Logical-Key']).toBe('agent-turn:a:b:1');
    expect(attempt1['X-TabTin-Billing-Logical-Key']).toBe('agent-turn:a:b:1');
    expect(attempt0['X-TabTin-Billing-Attempt-Key']).toBe('agent-turn:a:b:1:attempt:0');
    expect(attempt1['X-TabTin-Billing-Attempt-Key']).toBe('agent-turn:a:b:1:attempt:1');
    expect(attempt0['X-TabTin-Billing-Attempt-Index']).toBe('0');
    expect(attempt1['X-TabTin-Billing-Attempt-Index']).toBe('1');
  });

  it('emits attempt index 0 when there is no retry', () => {
    const provider = createHeaderBuilder();
    const request = {
      ...baseRequest,
      logicalBillingKey: 'agent-turn:a:b:1',
      billingIdempotencyKey: 'agent-turn:a:b:1',
    } as LLMRequest & { logicalBillingKey: string };

    const headers = provider.buildHeaders(request, 'token');

    expect(headers['X-TabTin-Billing-Attempt-Index']).toBe('0');
    expect(headers['X-TabTin-Billing-Attempt-Key']).toBe('agent-turn:a:b:1:attempt:0');
  });

  it('treats legacy billingIdempotencyKey as the logical billing key', () => {
    const provider = createHeaderBuilder();
    const request = {
      ...baseRequest,
      billingIdempotencyKey: 'legacy-key',
    };

    const headers = provider.buildHeaders(request, 'token', 0);

    expect(headers['X-TabTin-Billing-Logical-Key']).toBe('legacy-key');
    expect(headers['X-TabTin-Billing-Attempt-Key']).toBe('legacy-key:attempt:0');
    expect(headers['X-TabTin-Billing-Idempotency-Key']).toBe('legacy-key:attempt:0');
  });
});
