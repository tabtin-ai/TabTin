/**
 * 无人值守 stall 防护 — TabTinProxyProvider.createStream 总墙钟上限。
 *
 * 背景：单 attempt 有 5min HTTP 超时、30s 无字节 stall 兜底，但「慢速 runaway 流
 * + 5min abort 被判 retryable → 重试 → 新一轮 5min 流」会跨 attempt 累加到十几分钟，
 * query.ts 的 `for await` 拿不到正常结束 → 永不 emit message_stop → 落库失败，
 * 最终只能等 Django forward 1800s 外层超时（实测 run d743b9c5 持续 delta 11+ 分钟）。
 *
 * 本测试验证：当一条 LLM 调用（含全部重试）总耗时超过
 * `TABTIN_MAX_STREAM_WALL_MS` 上限时，createStream 按 **non-retryable** 终止
 * （details.wallTimeout=true），不再无限重试。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TabTinProxyProvider } from '../src/providers/proxy-provider.js';
import {
  AgentError,
} from '../src/engine/contracts/kernel.js';
import type {
  LLMRequest,
} from '../src/engine/contracts/model-llm.js';

function makeRequest(overrides: Partial<LLMRequest> = {}): LLMRequest {
  return {
    model: 'unit-test',
    messages: [{ role: 'user', content: 'hello' }],
    maxTokens: 64,
    ...overrides,
  };
}

async function drainExpectError(provider: TabTinProxyProvider, req: LLMRequest): Promise<unknown> {
  try {
    for await (const _ of provider.createStream(req)) {
      void _;
    }
    return null;
  } catch (err) {
    return err;
  }
}

describe('TabTinProxyProvider · 总墙钟上限（stall runaway 防护）', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;
  let prevEnv: string | undefined;

  beforeEach(() => {
    prevEnv = process.env.TABTIN_MAX_STREAM_WALL_MS;
    // 1ms 上限：第一次 retryable（503）错误后，elapsed（数 ms）即超限 → 立即墙钟终止。
    process.env.TABTIN_MAX_STREAM_WALL_MS = '1';
    // 每个 attempt 都返回 503（retryable）——模拟「会被重试」的失败流。
    fetchSpy = vi.fn(async () => new Response('upstream unavailable', { status: 503 }));
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    if (prevEnv === undefined) delete process.env.TABTIN_MAX_STREAM_WALL_MS;
    else process.env.TABTIN_MAX_STREAM_WALL_MS = prevEnv;
  });

  it('总耗时超 cap 时按 non-retryable 终止，不无限重试', async () => {
    const provider = new TabTinProxyProvider({
      proxyUrl: 'http://localhost:0/llm/proxy',
      deviceToken: 't',
      agentId: 'a',
      threadId: 's',
      maxRetries: 8,
      retryBaseDelayMs: 1,
    });

    const err = await drainExpectError(provider, makeRequest());

    expect(err).toBeInstanceOf(AgentError);
    const agentErr = err as AgentError;
    // 墙钟终止必须是 non-retryable（否则 query 层会继续重试，失去意义）。
    expect(agentErr.retryable).toBe(false);
    expect(agentErr.details?.wallTimeout).toBe(true);
    expect(agentErr.message).toMatch(/wall-time budget/i);
    // 1ms cap → 头一两个 attempt 内即墙钟终止，绝不会跑满 maxRetries+1=9 次。
    // （不断言恰好 1 次：首个 attempt 可能在同一毫秒内完成、elapsed=0 未超限，
    //  于是第 2 个 attempt 才触发——关键是「早停、不耗尽重试」。）
    expect(fetchSpy.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(fetchSpy.mock.calls.length).toBeLessThanOrEqual(2);
  });
});
