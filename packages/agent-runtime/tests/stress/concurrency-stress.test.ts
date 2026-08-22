/**
 * Wave 2c: 子 Agent 并发压测
 *
 * 验证 30-50 个并发子 Agent 不会死锁、不会泄漏资源、不会丢事件。
 *
 * Layer 1: 纯 BudgetTracker scheduler 高并发正确性
 *   — trySubmit / releaseChildAgent / cancelAllByParent / onActivate
 *   在大规模并发下的状态机正确性、无死锁、无计数泄漏。
 *
 * Layer 2: createAgentTool 完整路径（mock LLM）
 *   — 30 个 agent tool 并行 execute，验证 SUBAGENT_STARTED / COMPLETED /
 *   FAILED 事件计数一致、budget slot 全回收、无 unhandled rejection。
 */

import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BudgetTracker, type SchedulerStats } from '../../src/engine/guards/budget-tracker.js';
import { createAgentTool, type AgentToolConfig } from '../../src/subagent/agent-tool.js';
import { StreamEvents } from '../../src/engine/contracts/stream-events.js';
import {
  createMockPermissionHandler,
  createMockToolProvider,
} from '../test-utils.js';
import type {
  StreamEvent,
} from '../../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMResponseChunk,
} from '../../src/engine/contracts/model-llm.js';
import type {
  ToolResult,
} from '../../src/engine/contracts/tools.js';
import {
  setTelemetrySink,
  resetTelemetrySink,
} from '../../src/telemetry/index.js';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { setMaxListeners } from 'node:events';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeContext(overrides: Record<string, unknown> = {}) {
  return {
    threadId: 'stress-thread',
    runtimeId: 'stress-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  };
}

/**
 * Mock LLM provider — 无限次 createStream 调用均返回同一简单响应。
 * 子 Agent query 循环收到 end_turn 后自动结束，单次 < 1ms。
 */
function createConcurrentProvider(): LLMProvider {
  return {
    async *createStream(): AsyncIterable<LLMResponseChunk> {
      yield { type: 'text_delta', text: 'child task completed' };
      yield {
        type: 'usage',
        usage: { input_tokens: 10, output_tokens: 5 } as Record<string, unknown> as LLMResponseChunk['usage'],
      };
      yield { type: 'stop', stopReason: 'end_turn' };
    },
  };
}

const sessionDirsToClean: string[] = [];

function tmpSessionDir(): string {
  const dir = path.join(
    os.tmpdir(),
    `tabtin-stress-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  sessionDirsToClean.push(dir);
  return dir;
}

afterAll(async () => {
  await Promise.all(
    sessionDirsToClean.map((d) => fs.rm(d, { recursive: true, force: true }).catch(() => {})),
  );
});

function expectStats(bt: BudgetTracker, expected: Partial<SchedulerStats>, label?: string) {
  const stats = bt.getSchedulerStats();
  const prefix = label ? `[${label}] ` : '';
  if (expected.activeCount !== undefined) {
    expect(stats.activeCount, `${prefix}activeCount`).toBe(expected.activeCount);
  }
  if (expected.queuedCount !== undefined) {
    expect(stats.queuedCount, `${prefix}queuedCount`).toBe(expected.queuedCount);
  }
}

function createStressTool(
  bt: BudgetTracker,
  provider: LLMProvider = createConcurrentProvider(),
  sessionLabel = 'stress',
): ReturnType<typeof createAgentTool> {
  return createAgentTool({
    provider,
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: tmpSessionDir(), threadId: sessionLabel },
    model: 'mock-model',
    budgetTracker: bt,
  });
}

/**
 * 从 SUBAGENT_STARTED / COMPLETED / FAILED 事件中提取 run_id 集合，
 * 验证 STARTED 的 run_id 集合 === COMPLETED ∪ FAILED 的 run_id 集合。
 */
function assertEventPairing(events: StreamEvent[], label?: string) {
  const started = events.filter((e) => e.type === StreamEvents.SUBAGENT_STARTED);
  const completed = events.filter((e) => e.type === StreamEvents.SUBAGENT_COMPLETED);
  const failed = events.filter((e) => e.type === StreamEvents.SUBAGENT_FAILED);

  const startedIds = new Set(started.map((e) => (e.payload as Record<string, unknown>).run_id));
  const endedIds = new Set(
    [...completed, ...failed].map((e) => (e.payload as Record<string, unknown>).run_id),
  );

  const prefix = label ? `[${label}] ` : '';
  expect(started.length, `${prefix}STARTED === COMPLETED + FAILED count`).toBe(
    completed.length + failed.length,
  );
  expect(startedIds, `${prefix}STARTED childIds === ended childIds`).toEqual(endedIds);

  return { started, completed, failed };
}

// ═══════════════════════════════════════════════════════════════════════
// Layer 1: BudgetTracker scheduler 高并发
// ═══════════════════════════════════════════════════════════════════════

describe('Layer 1: BudgetTracker scheduler 高并发', () => {
  // ── 场景 1: 30 并发无死锁 ──────────────────────────────────────────

  it('30 并发全部 active — 提交 + 释放后无残留', () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 30,
      maxQueueSize: 40,
    });

    const ids = Array.from({ length: 30 }, (_, i) => `child-${i}`);

    for (const id of ids) {
      const r = bt.trySubmit({ speakerId: id });
      expect(r.accepted).toBe(true);
      expect(r.state).toBe('active');
    }

    expectStats(bt, { activeCount: 30, queuedCount: 0 }, '提交 30 后');

    for (const id of ids) {
      bt.releaseChildAgent(id);
    }

    expectStats(bt, { activeCount: 0, queuedCount: 0 }, '全部释放后');
  });

  // ── 场景 2: 50 并发 queue backpressure ─────────────────────────────

  it('50 并发 queue backpressure (active=10, queue=40) — 全部完成', async () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 10,
      maxQueueSize: 40,
    });

    const queuedDone: Promise<void>[] = [];

    for (let i = 0; i < 50; i++) {
      const id = `child-${i}`;
      const r = bt.trySubmit({ speakerId: id });
      expect(r.accepted).toBe(true);

      if (r.state === 'queued') {
        queuedDone.push(
          new Promise<void>((resolve) => {
            bt.onActivate(id, () => {
              bt.releaseChildAgent(id);
              resolve();
            });
          }),
        );
      }
    }

    expectStats(bt, { activeCount: 10, queuedCount: 40 }, '提交 50 后');

    for (let i = 0; i < 10; i++) {
      bt.releaseChildAgent(`child-${i}`);
    }

    await Promise.all(queuedDone);

    expectStats(bt, { activeCount: 0, queuedCount: 0 }, '全链路 drain 后');
  });

  // ── 场景 3: 父取消级联 ─────────────────────────────────────────────

  it('父取消级联 — 30 个子 Agent 全部取消 + slot 回收 + callback 全触发', () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 10,
      maxQueueSize: 40,
    });

    const queuedCallbacks: ReturnType<typeof vi.fn>[] = [];

    for (let i = 0; i < 30; i++) {
      const id = `child-${i}`;
      bt.trySubmit({ speakerId: id });
      if (i >= 10) {
        const cb = vi.fn();
        bt.onActivate(id, cb);
        queuedCallbacks.push(cb);
      }
    }

    expectStats(bt, { activeCount: 10, queuedCount: 20 }, '取消前');

    bt.cancelAllByParent();

    expectStats(bt, { activeCount: 0, queuedCount: 0 }, '取消后');

    for (const cb of queuedCallbacks) {
      expect(cb).toHaveBeenCalledOnce();
    }
  });

  // ── 场景 4: queue 满拒绝 ──────────────────────────────────────────

  it('queue 满拒绝 — active=10 queue=40, 第 51 个返回 rejected', () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 10,
      maxQueueSize: 40,
    });

    for (let i = 0; i < 50; i++) {
      const r = bt.trySubmit({ speakerId: `child-${i}` });
      expect(r.accepted).toBe(true);
    }

    expectStats(bt, { activeCount: 10, queuedCount: 40 }, '50 提交后');

    const r51 = bt.trySubmit({ speakerId: 'child-50' });
    expect(r51).toMatchObject({ accepted: false, state: 'rejected', reason: 'queue_full' });
  });

  // ── 场景 5: 计数一致性 ─────────────────────────────────────────────

  it('30 并发完成后 getSchedulerStats() 全归零', async () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 10,
      maxQueueSize: 40,
    });

    const drainPromises: Promise<void>[] = [];

    for (let i = 0; i < 30; i++) {
      const id = `child-${i}`;
      const r = bt.trySubmit({ speakerId: id });
      expect(r.accepted).toBe(true);

      if (r.state === 'queued') {
        drainPromises.push(
          new Promise<void>((resolve) => {
            bt.onActivate(id, () => {
              bt.releaseChildAgent(id);
              resolve();
            });
          }),
        );
      }
    }

    for (let i = 0; i < 10; i++) {
      bt.releaseChildAgent(`child-${i}`);
    }

    await Promise.all(drainPromises);

    expectStats(bt, { activeCount: 0, queuedCount: 0 }, '30 并发 drain 后');
  });

  // ── 场景 6: release → drain 精确性 ────────────────────────────────

  it('10 active + 20 queued, release 一个 → 恰好一个激活', () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 10,
      maxQueueSize: 40,
    });

    for (let i = 0; i < 30; i++) {
      bt.trySubmit({ speakerId: `child-${i}` });
    }

    expectStats(bt, { activeCount: 10, queuedCount: 20 }, 'release 前');

    const activated: string[] = [];
    for (let i = 10; i < 30; i++) {
      bt.onActivate(`child-${i}`, () => {
        activated.push(`child-${i}`);
      });
    }

    bt.releaseChildAgent('child-0');

    expect(activated).toHaveLength(1);
    expect(activated[0]).toBe('child-10');
    expectStats(bt, { activeCount: 10, queuedCount: 19 }, 'release 一个后');
  });

  // ── 场景 7: 高速 submit/release 交错不混乱 ──────────────────────────

  it('50 次快速 submit → release 交错 — 最终计数归零', () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 5,
      maxQueueSize: 10,
    });

    for (let round = 0; round < 50; round++) {
      const id = `r${round}`;
      const r = bt.trySubmit({ speakerId: id });
      if (r.accepted && r.state === 'active') {
        bt.releaseChildAgent(id);
      } else if (r.accepted && r.state === 'queued') {
        bt.releaseChildAgent(id);
      }
    }

    expectStats(bt, { activeCount: 0, queuedCount: 0 }, '50 轮交错后');
  });

  // ── 场景 8: FIFO drain 全链路验证 ────────────────────────────────

  it('40 queued 按 FIFO 顺序依次激活', async () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 1,
      maxQueueSize: 40,
    });

    bt.trySubmit({ speakerId: 'active-0' });

    const activationOrder: string[] = [];
    const allDrained = new Promise<void>((resolve) => {
      let drained = 0;
      for (let i = 1; i <= 40; i++) {
        const id = `queued-${i}`;
        bt.trySubmit({ speakerId: id });
        bt.onActivate(id, () => {
          activationOrder.push(id);
          bt.releaseChildAgent(id);
          drained++;
          if (drained === 40) resolve();
        });
      }
    });

    bt.releaseChildAgent('active-0');
    await allDrained;

    const expected = Array.from({ length: 40 }, (_, i) => `queued-${i + 1}`);
    expect(activationOrder).toEqual(expected);
    expectStats(bt, { activeCount: 0, queuedCount: 0 }, 'FIFO drain 后');
  });

  // ── 场景 9: budget exhausted 后 queue flush 全触发 ─────────────

  it('release 触发 drain 时 budget 已 exhausted → queue 全 flush + 全 callback 触发', () => {
    const bt = new BudgetTracker({
      maxTotalTokens: 100,
      maxConcurrentChildren: 2,
      maxQueueSize: 20,
    });

    bt.trySubmit({ speakerId: 'a1' });
    bt.trySubmit({ speakerId: 'a2' });
    for (let i = 0; i < 20; i++) {
      bt.trySubmit({ speakerId: `q${i}` });
    }

    const flushed: string[] = [];
    for (let i = 0; i < 20; i++) {
      bt.onActivate(`q${i}`, () => flushed.push(`q${i}`));
    }

    expect(bt.getSchedulerStats().queuedCount).toBe(20);

    bt.recordUsage(80, 30);
    expect(bt.isExhausted()).toBe(true);

    bt.releaseChildAgent('a1');

    expect(flushed, 'budget exhausted 后所有 queue callback 应触发').toHaveLength(20);
    expectStats(bt, { queuedCount: 0, activeCount: 1 }, 'flush 后');
  });

  // ── 场景 10: 大批量 submit + cancelAllByParent 多轮无泄漏 ───

  it('5 轮 submit(30) + cancelAllByParent — 无累积泄漏', () => {
    const bt = new BudgetTracker({
      maxConcurrentChildren: 5,
      maxQueueSize: 25,
    });

    for (let round = 0; round < 5; round++) {
      for (let i = 0; i < 30; i++) {
        bt.trySubmit({ speakerId: `r${round}-c${i}` });
      }
      bt.cancelAllByParent();

      expectStats(bt, { activeCount: 0, queuedCount: 0 }, `轮 ${round} cancel 后`);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Layer 2: createAgentTool 完整路径（mock LLM）
// ═══════════════════════════════════════════════════════════════════════

describe('Layer 2: createAgentTool 完整路径高并发', () => {
  let rejections: unknown[];
  let onReject: (err: unknown) => void;

  beforeEach(() => {
    setTelemetrySink(() => {});
    rejections = [];
    onReject = (err: unknown) => rejections.push(err);
    process.on('unhandledRejection', onReject);
  });
  afterEach(() => {
    process.removeListener('unhandledRejection', onReject);
    resetTelemetrySink();
    expect(rejections, 'should have no unhandled rejections').toHaveLength(0);
  });

  it(
    '30 并发子 Agent 全部完成 — 事件不丢 + budget slot 全回收',
    { timeout: 10_000 },
    async () => {
      const bt = new BudgetTracker({ maxConcurrentChildren: 30, maxQueueSize: 40 });
      const events: StreamEvent[] = [];
      const emitter = (e: StreamEvent) => events.push(e);

      const tool = createStressTool(bt);

      const ac = new AbortController();
      setMaxListeners(50, ac.signal);
      const startTime = Date.now();

      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          tool.execute(
            { prompt: `stress task #${i}` },
            makeContext({ emitStreamEvent: emitter, abortSignal: ac.signal }),
          ),
        ),
      );

      const elapsed = Date.now() - startTime;

      expect(results).toHaveLength(30);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(30);

      for (const r of fulfilled) {
        const value = (r as PromiseFulfilledResult<ToolResult>).value;
        expect(value.isError).toBeFalsy();
      }

      const { started, completed } = assertEventPairing(events, '30 并发全部完成');
      expect(started).toHaveLength(30);
      expect(completed).toHaveLength(30);

      expect(bt.getActiveChildrenCount(), '无 running 残留').toBe(0);
      expectStats(bt, { activeCount: 0, queuedCount: 0 }, '全部完成后');

      expect(elapsed, 'mock 场景 30 并发应 < 5 秒').toBeLessThan(5_000);
    },
  );

  it(
    '父 abort → 30 个子 Agent 全部终止 + budget slot 全回收',
    { timeout: 10_000 },
    async () => {
      const bt = new BudgetTracker({ maxConcurrentChildren: 30, maxQueueSize: 40 });
      const events: StreamEvent[] = [];
      const emitter = (e: StreamEvent) => events.push(e);

      let resolveBarrier!: () => void;
      const barrier = new Promise<void>((r) => { resolveBarrier = r; });
      let childrenStarted = 0;

      const slowProvider: LLMProvider = {
        async *createStream(): AsyncIterable<LLMResponseChunk> {
          childrenStarted++;
          if (childrenStarted === 1) resolveBarrier();
          yield { type: 'text_delta', text: 'working...' };
          await new Promise((r) => setTimeout(r, 50));
          yield { type: 'text_delta', text: 'still working...' };
          await new Promise((r) => setTimeout(r, 50));
          yield { type: 'stop', stopReason: 'end_turn' };
        },
      };

      const tool = createStressTool(bt, slowProvider, 'stress-abort');

      const ac = new AbortController();
      setMaxListeners(50, ac.signal);

      const promises = Array.from({ length: 30 }, (_, i) =>
        tool.execute(
          { prompt: `abort task #${i}` },
          makeContext({ emitStreamEvent: emitter, abortSignal: ac.signal }),
        ),
      );

      await barrier;
      ac.abort();

      const results = await Promise.allSettled(promises);

      expect(results).toHaveLength(30);
      const fulfilled = results.filter((r) => r.status === 'fulfilled');

      for (const r of fulfilled) {
        const value = (r as PromiseFulfilledResult<ToolResult>).value;
        expect(typeof value.content).toBe('string');
      }

      expect(bt.getActiveChildrenCount(), 'abort 后无 active 残留').toBe(0);
      expectStats(bt, { activeCount: 0, queuedCount: 0 }, 'abort 后');

      assertEventPairing(events, '父 abort 后事件配平');
    },
  );

  it(
    'maxConcurrentChildren=10 时 30 并发 — 20 个立即被拒 + 10 个完成',
    { timeout: 10_000 },
    async () => {
      const bt = new BudgetTracker({ maxConcurrentChildren: 10, maxQueueSize: 0 });
      const events: StreamEvent[] = [];
      const emitter = (e: StreamEvent) => events.push(e);

      const tool = createStressTool(bt, createConcurrentProvider(), 'stress-limited');

      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          tool.execute(
            { prompt: `limited task #${i}` },
            makeContext({ emitStreamEvent: emitter }),
          ),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(30);

      const values = fulfilled.map(
        (r) => (r as PromiseFulfilledResult<ToolResult>).value,
      );

      const succeeded = values.filter((v) => !v.isError);
      const rejected = values.filter((v) => v.isError);

      expect(succeeded, '前 10 个拿到 slot').toHaveLength(10);
      expect(rejected, '后 20 个立即被拒（maxQueueSize=0 禁用排队）').toHaveLength(20);

      for (const r of rejected) {
        // W4 (2026-05-26)：旧英文文案 "concurrency limit reached" 改成中文化
        // queue_full 文案——"任务队列已满"是 D2 决策的核心用户引导词。
        expect(r.content).toContain('任务队列已满');
      }

      expect(bt.getActiveChildrenCount(), 'slot 全回收').toBe(0);

      const { started, completed } = assertEventPairing(events, '限流场景');
      expect(started).toHaveLength(10);
      expect(completed).toHaveLength(10);
    },
  );

  it(
    'LLM provider 抛异常 — 30 并发全部返回 error + slot 全回收 + 无泄漏',
    { timeout: 10_000 },
    async () => {
      const bt = new BudgetTracker({ maxConcurrentChildren: 30, maxQueueSize: 40 });
      const events: StreamEvent[] = [];
      const emitter = (e: StreamEvent) => events.push(e);

      const explodingProvider: LLMProvider = {
        async *createStream(): AsyncIterable<LLMResponseChunk> {
          yield { type: 'text_delta', text: 'about to fail' };
          throw new Error('simulated LLM explosion');
        },
      };

      const tool = createStressTool(bt, explodingProvider, 'stress-error');

      const ac = new AbortController();
      setMaxListeners(50, ac.signal);

      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          tool.execute(
            { prompt: `error task #${i}` },
            makeContext({ emitStreamEvent: emitter, abortSignal: ac.signal }),
          ),
        ),
      );

      expect(results).toHaveLength(30);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(30);

      for (const r of fulfilled) {
        const value = (r as PromiseFulfilledResult<ToolResult>).value;
        expect(value.isError, 'provider 抛异常应返回 error').toBe(true);
      }

      expect(bt.getActiveChildrenCount(), 'slot 全回收 — 即使 provider 炸了').toBe(0);
      expectStats(bt, { activeCount: 0, queuedCount: 0 }, 'provider 异常后');

      const { started, failed } = assertEventPairing(events, 'provider 异常');
      expect(started).toHaveLength(30);
      expect(failed).toHaveLength(30);
    },
  );

  it(
    '混合成功/失败 — slot 全回收 + 事件配平',
    { timeout: 10_000 },
    async () => {
      const bt = new BudgetTracker({ maxConcurrentChildren: 30, maxQueueSize: 40 });
      const events: StreamEvent[] = [];
      const emitter = (e: StreamEvent) => events.push(e);

      // callCount++ 在 JS 单线程下是安全的，但 30 并发 async 协程到达
      // createStream 的顺序不确定，因此成功/失败的具体数量不可预测。
      let callCount = 0;
      const mixedProvider: LLMProvider = {
        async *createStream(): AsyncIterable<LLMResponseChunk> {
          const idx = callCount++;
          if (idx % 2 === 0) {
            yield { type: 'text_delta', text: 'success' };
            yield {
              type: 'usage',
              usage: { input_tokens: 10, output_tokens: 5 } as Record<string, unknown> as LLMResponseChunk['usage'],
            };
            yield { type: 'stop', stopReason: 'end_turn' };
          } else {
            throw new Error(`fail-${idx}`);
          }
        },
      };

      const tool = createStressTool(bt, mixedProvider, 'stress-mixed');

      const ac = new AbortController();
      setMaxListeners(50, ac.signal);

      const results = await Promise.allSettled(
        Array.from({ length: 30 }, (_, i) =>
          tool.execute(
            { prompt: `mixed task #${i}` },
            makeContext({ emitStreamEvent: emitter, abortSignal: ac.signal }),
          ),
        ),
      );

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      expect(fulfilled).toHaveLength(30);

      const values = fulfilled.map(
        (r) => (r as PromiseFulfilledResult<ToolResult>).value,
      );
      const succeeded = values.filter((v) => !v.isError);
      const errored = values.filter((v) => v.isError);
      expect(succeeded.length + errored.length).toBe(30);
      expect(succeeded.length, '应有至少一个成功').toBeGreaterThan(0);
      expect(errored.length, '应有至少一个失败').toBeGreaterThan(0);

      expect(bt.getActiveChildrenCount(), 'slot 全回收').toBe(0);
      expectStats(bt, { activeCount: 0 }, '混合场景完成后');

      assertEventPairing(events, '混合成功/失败');
    },
  );
});
