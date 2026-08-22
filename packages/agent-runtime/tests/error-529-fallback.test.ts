/**
 * 529 fallback integration tests — validates the complete path from
 * Provider-layer 529 counting through to query-layer model fallback.
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  AgentError,
} from '../src/engine/contracts/kernel.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMResponseChunk,
  LLMProvider,
} from '../src/engine/contracts/model-llm.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';

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
    provider: { async *createStream() { yield { type: 'text_delta', text: 'x' }; } },
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-529-fallback' },
    model: 'claude-opus-4-6',
    ...overrides,
  };
}

function findSystemNotice(events: StreamEvent[], noticeType: string): Record<string, unknown> | undefined {
  const evt = events.find(
    (e) => e.type === 'agent.stream.system_notice'
      && (e.payload as Record<string, unknown>).notice_type === noticeType,
  );
  return evt?.payload as Record<string, unknown> | undefined;
}

function findDone(events: StreamEvent[]): Record<string, unknown> {
  const done = events.find((e) => e.type === 'agent.stream.done');
  if (!done) throw new Error('no DONE event');
  return done.payload as Record<string, unknown>;
}

describe('529 fallback path', () => {
  it('529 needsFallback triggers model switch and continues', async () => {
    let callIndex = 0;
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        callIndex++;
        if (callIndex === 1) {
          throw new AgentError('529 overload threshold reached', 'LLM_ERROR', {
            statusCode: 529,
            retryable: false,
            details: { needsFallback: true },
          });
        }
        yield { type: 'text_delta', text: 'recovered with fallback' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const rt = createRuntime(makeConfig({ provider }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    expect(error).toBeUndefined();
    const notice = findSystemNotice(events, 'model_fallback');
    expect(notice).toBeDefined();
    expect(notice!.fallback_model).toBeTruthy();

    const done = findDone(events);
    expect(done.error).toBeUndefined();
  });

  it('529 fallback with fallbackChain uses configured chain', async () => {
    let callIndex = 0;
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        callIndex++;
        if (callIndex === 1) {
          throw new AgentError('529 overload threshold reached', 'LLM_ERROR', {
            statusCode: 529,
            retryable: false,
            details: { needsFallback: true },
          });
        }
        yield { type: 'text_delta', text: 'ok' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const rt = createRuntime(makeConfig({
      provider,
      model: 'claude-opus-4-6',
      fallbackChain: ['claude-opus-4-6', 'claude-sonnet-4-6', 'claude-haiku-4'],
    }));
    const { events } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));
    const notice = findSystemNotice(events, 'model_fallback');
    expect(notice).toBeDefined();
    expect(notice!.fallback_model).toBe('claude-sonnet-4-6');
  });

  it('529 with no fallback available errors out', async () => {
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        throw new AgentError('529 overload threshold reached', 'LLM_ERROR', {
          statusCode: 529,
          retryable: false,
          details: { needsFallback: true },
        });
      },
    };

    const rt = createRuntime(makeConfig({
      provider,
      model: 'claude-haiku-4',
    }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    expect(error).toBeInstanceOf(AgentError);
    const done = findDone(events);
    expect(done.error).toBe(true);
  });

  it('first 5xx triggers immediate fallback (DR-1: Provider retries exhausted)', async () => {
    let callIndex = 0;
    const provider: LLMProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        callIndex++;
        if (callIndex === 1) {
          throw new AgentError('Server error attempt 1', 'LLM_ERROR', {
            statusCode: 500,
            retryable: false,
          });
        }
        yield { type: 'text_delta', text: 'recovered with fallback' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const rt = createRuntime(makeConfig({ provider, model: 'claude-opus-4-6' }));
    const { events, error } = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'Hi' }));

    expect(error).toBeUndefined();
    const notice = findSystemNotice(events, 'model_fallback');
    expect(notice).toBeDefined();
  });

  it('AgentError statusCode is accessible at top level', () => {
    const err = new AgentError('test', 'LLM_ERROR', { statusCode: 529 });
    expect(err.statusCode).toBe(529);
    expect(err.retryable).toBe(false);
  });

  it('AgentError backwards compatible with details-only construction', () => {
    const err = new AgentError('test', 'LLM_ERROR', { status: 429, retryAfter: '5' });
    expect(err.statusCode).toBe(429);
    expect(err.details?.status).toBe(429);
    expect(err.details?.retryAfter).toBe('5');
  });

  it('AgentError new-style opts with details', () => {
    const err = new AgentError('test', 'LLM_ERROR', {
      statusCode: 502,
      retryable: true,
      retryAfterMs: 3000,
      details: { extra: 'info' },
    });
    expect(err.statusCode).toBe(502);
    expect(err.retryable).toBe(true);
    expect(err.retryAfterMs).toBe(3000);
    expect(err.details).toEqual({ extra: 'info' });
  });
});
