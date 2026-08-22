/**
 * 计费结算失败 vs 余额不足 vs 网络中断的错误语义回归。
 * （error-wave3 被 vitest exclude，本文件进默认 suite。）
 */
import { describe, expect, it } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import { AgentError } from '../src/engine/contracts/kernel.js';
import type { StreamEvent } from '../src/engine/contracts/wire-protocol.js';
import type { LLMResponseChunk, LLMProvider } from '../src/engine/contracts/model-llm.js';
import type { EngineConfig } from '../src/engine/contracts/kernel.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';

async function collectEventsSafe(
  gen: AsyncGenerator<StreamEvent>,
): Promise<{ events: StreamEvent[]; error?: Error }> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of gen) {
      events.push(event);
    }
  } catch (e) {
    return { events, error: e as Error };
  }
  return { events };
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: {
      async *createStream() {
        yield { type: 'text_delta', text: 'hi' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    },
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-billing-settlement' },
    model: 'test-model',
    ...overrides,
  };
}

function findDone(events: StreamEvent[]): Record<string, unknown> | undefined {
  const done = events.find((e) => e.type === 'agent.stream.done');
  return done?.payload as Record<string, unknown> | undefined;
}

describe('billing settlement error semantics', () => {
  it('结算基础设施失败：message_stop 不伪装 stream_interrupted，DONE 引导重试', async () => {
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw new AgentError(
          'LLM 调用已完成但计费结算失败，请稍后重试。',
          'LLM_ERROR',
          {
            retryable: false,
            details: {
              chargeStatus: 'failed',
              error_type: 'billing_charge_failed',
              error_category: 'billing_charge_failed',
              fromBillingTail: true,
            },
          },
        );
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));
    const done = findDone(events);
    const messageStops = events.filter((e) => e.type === 'agent.stream.message_stop');

    expect(done?.error_class).toBe('LLM_ERROR');
    expect(done?.suggested_action).toBe('retry_later');
    expect(done?.error_category).toBe('server_error');

    const stopWithError = messageStops.find((e) => {
      const payload = e.payload as { error_info?: { partial_reason?: string } };
      return Boolean(payload?.error_info?.partial_reason);
    });
    expect(stopWithError).toBeDefined();
    expect(
      (stopWithError!.payload as { error_info: { partial_reason: string } }).error_info.partial_reason,
    ).toBe('message_stop_fallback');
  });

  it('真实余额不足：DONE 走 check_billing，message_stop 仍非 stream_interrupted', async () => {
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw new AgentError('组织钱包余额不足，请充值后继续使用。', 'LLM_BILLING_ERROR', {
          statusCode: 402,
          retryable: false,
          details: {
            chargeStatus: 'failed',
            error_type: 'organization_insufficient_credits',
            error_category: 'organization_insufficient_credits',
            fromBillingTail: true,
          },
        });
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));
    const done = findDone(events);
    const messageStops = events.filter((e) => e.type === 'agent.stream.message_stop');

    expect(done?.error_class).toBe('LLM_BILLING_ERROR');
    expect(done?.suggested_action).toBe('check_billing');
    expect(done?.error_category).toBe('organization_insufficient_credits');

    const terminalPersist = events.find((event) => {
      if (event.type !== 'agent.stream.persist_message') return false;
      const payload = event.payload as { stop_reason?: string; partial?: boolean };
      return payload.stop_reason === 'error' && payload.partial === true;
    });
    expect(terminalPersist).toBeDefined();
    expect(terminalPersist?.payload.blocks_json).toEqual([]);
    expect(terminalPersist?.payload.error_info_json).toEqual(expect.objectContaining({
      error_class: 'LLM_BILLING_ERROR',
      category: 'organization_insufficient_credits',
      suggested_action: 'check_billing',
      error_extras: expect.objectContaining({
        error_type: 'organization_insufficient_credits',
      }),
    }));

    const stopWithError = messageStops.find((e) => {
      const payload = e.payload as { error_info?: { partial_reason?: string } };
      return Boolean(payload?.error_info?.partial_reason);
    });
    expect(stopWithError).toBeDefined();
    expect(
      (stopWithError!.payload as { error_info: { partial_reason: string } }).error_info.partial_reason,
    ).toBe('message_stop_fallback');
  });
});
