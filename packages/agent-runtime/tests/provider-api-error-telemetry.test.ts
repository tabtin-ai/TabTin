/**
 * FR-03 + H1-E：LLM Proxy API 错误埋点。
 *
 * 覆盖：
 *   - 400 → emit `api.error.400`，error_body 样本前 200 字符、长度、hash 均出现
 *   - 404 → emit `api.error.4xx`
 *   - 402 / 429 / 503 / 5xx → **不**发 api.error.*（各有专属 AgentErrorCode）
 *   - payload 不含敏感字段；session_id / agent_id 透传到 record 顶层
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelemetryRecord } from '../src/telemetry/index.js';
import {
  TelemetryEvents,
  resetTelemetrySink,
  setTelemetrySink,
} from '../src/telemetry/index.js';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import type {
  LLMRequest,
} from '../src/engine/contracts/model-llm.js';

function makeRequest(): LLMRequest {
  return {
    model: 'unit-test-model',
    messages: [{ role: 'user', content: 'hello' }],
    system: 'system prompt',
    maxTokens: 1024,
  };
}

function stubFetchOnce(status: number, body: string): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      return new Response(body, {
        status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

async function collectChunks(provider: TabTinProxyProvider, request: LLMRequest): Promise<void> {
  try {
    for await (const _ of provider.createStream(request)) {
      void _;
    }
  } catch {
    // expected
  }
}

describe('FR-03 / H1-E — TabTinProxyProvider api.error.* telemetry', () => {
  const records: TelemetryRecord[] = [];

  beforeEach(() => {
    records.length = 0;
    setTelemetrySink((r) => records.push(r));
  });

  afterEach(() => {
    resetTelemetrySink();
    vi.unstubAllGlobals();
  });

  it('HTTP 400 → emit api.error.400，带 status/model + redactErrorBody 衍生字段', async () => {
    const body =
      '{"error":"invalid_request","message":"Messages must alternate between user and assistant"}';
    stubFetchOnce(400, body);

    const provider = new TabTinProxyProvider({
      proxyUrl: 'https://example.com/llm/proxy',
      deviceToken: 'tok',
      agentId: 'agent-xyz',
      threadId: 'sess-abc',
      maxRetries: 0,
    });

    await collectChunks(provider, makeRequest());

    const matched = records.filter((r) => r.event_name === TelemetryEvents.API_ERROR_400);
    expect(matched).toHaveLength(1);
    const r = matched[0]!;
    expect(r.session_id).toBe('sess-abc');
    expect(r.agent_id).toBe('agent-xyz');

    const p = r.payload;
    expect(p.status).toBe(400);
    expect(p.model).toBe('unit-test-model');
    expect(p.error_body_len).toBe(body.length);
    expect(p.error_body_sample).toBe(body.slice(0, 200));
    expect(typeof p.error_body_hash).toBe('string');
    expect((p.error_body_hash as string).length).toBeGreaterThan(0);
  });

  it('HTTP 404 → emit api.error.4xx（不是 400）', async () => {
    stubFetchOnce(404, '{"error":"not_found"}');

    const provider = new TabTinProxyProvider({
      proxyUrl: 'https://example.com/llm/proxy',
      deviceToken: 'tok',
      maxRetries: 0,
    });

    await collectChunks(provider, makeRequest());

    expect(records.filter((r) => r.event_name === TelemetryEvents.API_ERROR_400)).toHaveLength(0);
    const m4xx = records.filter((r) => r.event_name === TelemetryEvents.API_ERROR_4XX);
    expect(m4xx).toHaveLength(1);
    expect(m4xx[0]!.payload.status).toBe(404);
  });

  it('HTTP 429 / 503 / 500 / 402 都不发 api.error.*', async () => {
    for (const status of [429, 503, 500, 402, 403]) {
      records.length = 0;
      stubFetchOnce(status, 'body');
      const provider = new TabTinProxyProvider({
        proxyUrl: 'https://example.com/llm/proxy',
        deviceToken: 'tok',
        maxRetries: 0,
      });
      await collectChunks(provider, makeRequest());
      const apiErrors = records.filter((r) =>
        r.event_name === TelemetryEvents.API_ERROR_400
        || r.event_name === TelemetryEvents.API_ERROR_4XX,
      );
      expect(apiErrors, `status=${status} 不应有 api.error.* 埋点`).toHaveLength(0);
    }
  });

  it('HTTP 400 的 body 超长时 sample 仍只截 200 字符', async () => {
    const longBody = 'X'.repeat(5000);
    stubFetchOnce(400, longBody);

    const provider = new TabTinProxyProvider({
      proxyUrl: 'https://example.com/llm/proxy',
      deviceToken: 'tok',
      maxRetries: 0,
    });

    await collectChunks(provider, makeRequest());
    const r = records.find((x) => x.event_name === TelemetryEvents.API_ERROR_400)!;
    expect((r.payload.error_body_sample as string).length).toBe(200);
    expect(r.payload.error_body_len).toBe(5000);
  });
});
