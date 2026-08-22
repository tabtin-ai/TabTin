/**
 * Context Tier header 透传测试
 *
 * 验证 TabTinProxyProvider.buildHeaders 把 contextTierId（字符串 / 函数形式）
 * 转成 `X-TabTin-Context-Tier` 透给 Django 代理，Django 侧再把档位的
 * extra_headers 合并到上游（如 `anthropic-beta: context-1m-2025-08-07`）。
 *
 * 这是整条 1M 上下文链路的客户端入口，断点的任一侧都会让用户没拿到
 * 承诺的 1M 而又不自知。
 */

import { describe, expect, it } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import type {
  LLMRequest,
} from '../src/engine/contracts/model-llm.js';

type HeaderBuilder = (request: LLMRequest, token: string, attemptIndex?: number) => Record<string, string>;

function headersOf(
  provider: TabTinProxyProvider,
  requestOverrides: Partial<LLMRequest> = {},
): Record<string, string> {
  const request: LLMRequest = {
    model: 'unit-test',
    messages: [{ role: 'user', content: 'hi' }],
    maxTokens: 32,
    ...requestOverrides,
  };
  const build = (provider as unknown as { buildHeaders: HeaderBuilder }).buildHeaders.bind(
    provider,
  );
  return build(request, 'token-abc');
}

describe('TabTinProxyProvider context tier header', () => {
  it('静态 contextTierId 注入 X-TabTin-Context-Tier', () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      agentId: 'ag-x',
      threadId: 'ss-x',
      contextTierId: 'long_1m',
      maxRetries: 0,
    });

    const headers = headersOf(provider);
    expect(headers['X-TabTin-Context-Tier']).toBe('long_1m');
  });

  it('函数型 contextTierId 每次取值（支持 session 切档后立即生效）', () => {
    let current: string | undefined = 'standard';
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      agentId: 'ag-x',
      threadId: 'ss-x',
      contextTierId: () => current,
      maxRetries: 0,
    });

    expect(headersOf(provider)['X-TabTin-Context-Tier']).toBe('standard');

    current = 'long_1m';
    expect(headersOf(provider)['X-TabTin-Context-Tier']).toBe('long_1m');

    current = undefined;
    expect(headersOf(provider)['X-TabTin-Context-Tier']).toBeUndefined();
  });

  it('未配置 contextTierId 时不注入 header（保持默认档行为）', () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      agentId: 'ag-x',
      threadId: 'ss-x',
      maxRetries: 0,
    });

    expect(headersOf(provider)['X-TabTin-Context-Tier']).toBeUndefined();
  });

  it('空字符串 contextTierId 视为未设置（避免把 falsy 值透传成"切到 id=空串"）', () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      agentId: 'ag-x',
      threadId: 'ss-x',
      contextTierId: '',
      maxRetries: 0,
    });

    expect(headersOf(provider)['X-TabTin-Context-Tier']).toBeUndefined();
  });

  it('用逻辑 LLM 调用键派生 attempt 计费键', () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      maxRetries: 0,
    });

    const headers = headersOf(provider, {
      billingIdempotencyKey: 'agent-turn:job-1:_main_chat:0',
    });

    expect(headers['X-TabTin-Billing-Logical-Key']).toBe('agent-turn:job-1:_main_chat:0');
    expect(headers['X-TabTin-Billing-Idempotency-Key']).toBe(
      'agent-turn:job-1:_main_chat:0:attempt:0',
    );
    expect(headers['X-TabTin-Billing-Attempt-Key']).toBe(
      'agent-turn:job-1:_main_chat:0:attempt:0',
    );
    expect(headers['X-TabTin-Billing-Attempt-Index']).toBe('0');
  });
});
