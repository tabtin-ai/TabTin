import { describe, expect, it } from 'vitest';
import { AgentError } from '../src/engine/contracts/kernel.js';
import type { LLMResponseChunk } from '../src/engine/contracts/model-llm.js';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import { classifyError } from '../src/engine/errors/error-classifier.js';

function collectBillingChunks(
  provider: TabTinProxyProvider,
  payload: string,
): { chunks: LLMResponseChunk[]; thrown?: unknown } {
  const processBillingEvent = (provider as unknown as {
    processBillingEvent: (payload: string) => Generator<LLMResponseChunk, void, undefined>;
  }).processBillingEvent.bind(provider);
  const chunks: LLMResponseChunk[] = [];
  try {
    for (const chunk of processBillingEvent(payload)) {
      chunks.push(chunk);
    }
    return { chunks };
  } catch (thrown) {
    return { chunks, thrown };
  }
}

describe('proxy-provider billing tail frames', () => {
  it('charge_status=failed 且无 error_category → 结算基础设施失败（可提示重试，非余额不足）', async () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      maxRetries: 0,
    });

    const { chunks, thrown } = collectBillingChunks(
      provider,
      '{"charge_status":"failed","credits_charged":0}',
    );

    expect(chunks.find((chunk) => (
      chunk.type === 'usage' && chunk.usage.charge_status === 'failed'
    ))).toBeDefined();
    expect(thrown).toBeInstanceOf(AgentError);
    const err = thrown as AgentError;
    expect(err.code).toBe('LLM_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.details?.error_type).toBe('billing_charge_failed');
    expect(err.details?.fromBillingTail).toBe(true);

    const classified = classifyError(err);
    expect(classified.category).toBe('server_error');
    expect(classified.retryable).toBe(true);
    expect(classified.suggestedAction).toBe('retry_later');
    expect(classified.userMessage).toContain('结算异常');
    expect(classified.userMessage).not.toContain('余额不足');
  });

  it('charge_status=failed + organization_insufficient_credits → 余额不足不可重试', async () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      maxRetries: 0,
    });

    const { thrown } = collectBillingChunks(
      provider,
      JSON.stringify({
        charge_status: 'failed',
        credits_charged: 0,
        error_category: 'organization_insufficient_credits',
      }),
    );

    expect(thrown).toBeInstanceOf(AgentError);
    const err = thrown as AgentError;
    expect(err.code).toBe('LLM_BILLING_ERROR');
    expect(err.retryable).toBe(false);
    expect(err.message).toContain('组织钱包余额不足');

    const classified = classifyError(err);
    expect(classified.category).toBe('organization_insufficient_credits');
    expect(classified.retryable).toBe(false);
    expect(classified.suggestedAction).toBe('check_billing');
  });

  it('charge_status=failed + billing_charge_failed → 结算异常可重试', async () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 'token-abc',
      maxRetries: 0,
    });

    const { thrown } = collectBillingChunks(
      provider,
      JSON.stringify({
        charge_status: 'failed',
        credits_charged: 0,
        error_category: 'billing_charge_failed',
      }),
    );

    const err = thrown as AgentError;
    expect(err.code).toBe('LLM_ERROR');
    const classified = classifyError(err);
    expect(classified.suggestedAction).toBe('retry_later');
    expect(classified.userMessage).toBe('服务结算异常，请稍后重试');
  });
});
