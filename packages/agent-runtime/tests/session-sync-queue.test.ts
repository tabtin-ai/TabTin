/**
 * FR-14（H2-D）：SyncQueue 行为单测。
 *
 * 覆盖：
 *   - enqueue + flushThreshold 触发即时 flush
 *   - uploadFn 缺失时 flush no-op（兼容 Phase 6 之前）
 *   - uploadFn 成功 → batch 上传 → 内存清空 → 不持久化
 *   - uploadFn 失败：retryDelaysMs 等待重试 → 全部失败后落 PersistentQueue
 *   - recover：成功路径回收 + 失败路径累计 attempts + TTL 归档
 *   - dispose 幂等
 *   - telemetry 事件按预期发出
 *
 * 用 fakeTimers 把 1s/5s/25s 的等待提前到测试帧内，避免单测真等 31s。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { SyncQueue, OwnerMismatchError } from '../src/session/sync.js';
import {
  InMemoryPersistentQueue,
  type PersistedEntry,
  type PersistedEntryOwner,
} from '../src/session/persistent-queue.js';
import {
  resetTelemetrySink,
  setTelemetrySink,
  type TelemetryRecord,
} from '../src/telemetry/index.js';
import { TelemetryEvents } from '../src/telemetry/events.js';
import type {
  TranscriptEntry,
} from '../src/engine/contracts/context-capability.js';

/**
 * 测试默认 owner（LH2-D3）。
 *
 * 用 stable 字符串 ID（不带 hyphen 也不带 dot）保证：
 *   1. 满足 `sync-account.ts.ACCOUNT_SEGMENT_RE` 校验 [A-Za-z0-9_-]
 *   2. 与生产 UUID 格式视觉上区分，便于失败定位
 */
const TEST_OWNER: PersistedEntryOwner = {
  userId: 'user-A',
  organizationId: 'wt-1',
  agentId: 'agent-A',
};

const TEST_OWNER_B: PersistedEntryOwner = {
  userId: 'user-B',
  organizationId: 'wt-2',
  agentId: 'agent-B',
};

function mkEntry(id: number): TranscriptEntry {
  return {
    type: 'user',
    timestamp: Date.now(),
    // §17.6 D4：TranscriptEntry.sessionId → threadId（业务对话 thread）。
    threadId: 's1',
    version: id,
    message: { role: 'user', content: `m-${id}` },
  };
}

/** 构造 PersistedEntry 测试 helper，默认带 TEST_OWNER。 */
function mkPersisted(
  partial: Partial<PersistedEntry<TranscriptEntry[]>> & {
    id: string;
    payload: TranscriptEntry[];
    createdAt: number;
    attempts: number;
  },
): PersistedEntry<TranscriptEntry[]> {
  return {
    lastAttemptAt: null,
    owner: TEST_OWNER,
    ...partial,
  };
}

let captured: TelemetryRecord[];

beforeEach(() => {
  captured = [];
  setTelemetrySink((r) => captured.push(r));
});

afterEach(() => {
  resetTelemetrySink();
  vi.useRealTimers();
});

function eventsOfType(name: string): TelemetryRecord[] {
  return captured.filter((r) => r.event_name === name);
}

// ─── 入队 / flush 基础 ────────────────────────────────────────────

describe('SyncQueue — enqueue & flush basics', () => {
  it('uploadFn 未注入时 flush 不持久化、不报错（v1 兼容）', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const sq = new SyncQueue({ owner: TEST_OWNER, persistentQueue: persistent });
    sq.enqueue(mkEntry(1));
    sq.enqueue(mkEntry(2));
    await sq.flush();
    expect(sq.pendingCount).toBe(0);
    expect(persistent.size()).toBe(0);
    expect(eventsOfType(TelemetryEvents.SYNC_PERSISTED)).toHaveLength(0);
    await sq.dispose();
  });

  it('uploadFn 成功：batch 上传 + 内存清空 + 不持久化', async () => {
    const calls: TranscriptEntry[][] = [];
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async (entries) => {
        calls.push(entries);
      },
      persistentQueue: persistent,
    });
    sq.enqueue(mkEntry(1));
    sq.enqueue(mkEntry(2));
    await sq.flush();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.map((e) => e.version)).toEqual([1, 2]);
    expect(sq.pendingCount).toBe(0);
    expect(persistent.size()).toBe(0);
    expect(eventsOfType(TelemetryEvents.SYNC_QUEUED)).toHaveLength(2);
    await sq.dispose();
  });

  it('flushThreshold 达到时自动触发 flush', async () => {
    let flushed = 0;
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      flushThreshold: 3,
      uploadFn: async () => {
        flushed += 1;
      },
    });
    sq.enqueue(mkEntry(1));
    sq.enqueue(mkEntry(2));
    expect(flushed).toBe(0);
    sq.enqueue(mkEntry(3));
    // flushThreshold 触发是异步的，await 一帧让 microtask 跑完
    await new Promise((r) => setTimeout(r, 0));
    expect(flushed).toBe(1);
    await sq.dispose();
  });

  it('flush 重入保护：同时多次调用只跑一次', async () => {
    let flushed = 0;
    let releaseUpload!: () => void;
    const uploadGate = new Promise<void>((resolve) => {
      releaseUpload = resolve;
    });
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        flushed += 1;
        await uploadGate;
      },
    });
    sq.enqueue(mkEntry(1));
    const first = sq.flush();
    const second = sq.flush(); // 应被 flushing 锁吃掉
    releaseUpload();
    await Promise.all([first, second]);
    expect(flushed).toBe(1);
    await sq.dispose();
  });
});

// ─── 失败重试 + 持久化 ────────────────────────────────────────────

describe('SyncQueue — retry & persist', () => {
  it('uploadFn 始终失败：用尽 retryDelaysMs 后写持久化', async () => {
    vi.useFakeTimers();
    const err = new Error('upload boom');
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw err;
      },
      persistentQueue: persistent,
      retryDelaysMs: [10, 20, 30],
      newId: () => 'fixed-id',
    });
    sq.enqueue(mkEntry(1));

    const flushP = sq.flush();
    // 一次性把所有定时器拨完
    await vi.advanceTimersByTimeAsync(60);
    await flushP;

    expect(persistent.size()).toBe(1);
    const all = await persistent.loadAll();
    expect(all[0]!.id).toBe('fixed-id');
    expect(all[0]!.payload.map((e) => e.version)).toEqual([1]);

    const failedEvents = eventsOfType(TelemetryEvents.SYNC_FAILED);
    expect(failedEvents).toHaveLength(4); // 0 立即 + 3 退避
    expect(failedEvents[0]!.payload.attempt).toBe(1);
    expect(failedEvents[3]!.payload.attempt).toBe(4);

    const persistedEvents = eventsOfType(TelemetryEvents.SYNC_PERSISTED);
    expect(persistedEvents).toHaveLength(1);
    expect(persistedEvents[0]!.payload.id).toBe('fixed-id');

    await sq.dispose();
  });

  it('uploadFn 第二次成功：不进持久化', async () => {
    vi.useFakeTimers();
    let attempt = 0;
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        attempt += 1;
        if (attempt < 2) throw new Error('flaky');
      },
      persistentQueue: persistent,
      retryDelaysMs: [10, 20, 30],
    });
    sq.enqueue(mkEntry(1));
    const p = sq.flush();
    await vi.advanceTimersByTimeAsync(50);
    await p;

    expect(attempt).toBe(2);
    expect(persistent.size()).toBe(0);
    expect(eventsOfType(TelemetryEvents.SYNC_FAILED)).toHaveLength(1);
    expect(eventsOfType(TelemetryEvents.SYNC_PERSISTED)).toHaveLength(0);
    await sq.dispose();
  });

  it('telemetry context 贯穿（session_id / agent_id）', async () => {
    vi.useFakeTimers();
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('boom');
      },
      persistentQueue: new InMemoryPersistentQueue<TranscriptEntry[]>(),
      retryDelaysMs: [1],
      telemetryContext: { session_id: 'sess-1', agent_id: 'agent-1' },
    });
    sq.enqueue(mkEntry(1));
    const p = sq.flush();
    await vi.advanceTimersByTimeAsync(2);
    await p;
    const failed = eventsOfType(TelemetryEvents.SYNC_FAILED);
    expect(failed[0]!.session_id).toBe('sess-1');
    expect(failed[0]!.agent_id).toBe('agent-1');
    await sq.dispose();
  });
});

// ─── recover：启动时回放 ──────────────────────────────────────────

describe('SyncQueue — recover', () => {
  it('recover 成功路径：上传成功后从持久化删除', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const seed: PersistedEntry<TranscriptEntry[]> = {
      id: 'seed-1',
      payload: [mkEntry(1), mkEntry(2)],
      createdAt: Date.now() - 1000,
      attempts: 4,
      lastAttemptAt: Date.now() - 100,
      owner: TEST_OWNER,
    };
    await persistent.append(seed);

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persistent,
      retryDelaysMs: [10],
    });

    const result = await sq.recover();
    expect(result).toEqual({ recovered: 1, archived: 0, failed: 0 });
    expect(persistent.size()).toBe(0);

    const recovered = eventsOfType(TelemetryEvents.SYNC_RECOVERED);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]!.payload.id).toBe('seed-1');
    expect(recovered[0]!.payload.previous_attempts).toBe(4);
    await sq.dispose();
  });

  it('recover 仍失败：累计 attempts = totalAttemptsPerRun（含立即一次）', async () => {
    vi.useFakeTimers();
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const seed: PersistedEntry<TranscriptEntry[]> = {
      id: 'seed-1',
      payload: [mkEntry(1)],
      createdAt: Date.now() - 1000,
      attempts: 4,
      lastAttemptAt: Date.now() - 100,
      owner: TEST_OWNER,
    };
    await persistent.append(seed);

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('still down');
      },
      persistentQueue: persistent,
      retryDelaysMs: [5, 5],
    });

    const p = sq.recover();
    await vi.advanceTimersByTimeAsync(20);
    const result = await p;

    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    const remaining = await persistent.loadAll();
    expect(remaining).toHaveLength(1);
    // 2 退避 + 1 立即 = totalAttemptsPerRun=3。技术 Review #2 修复 off-by-one。
    expect(remaining[0]!.attempts).toBe(4 + 3);
    await sq.dispose();
  });

  it('TTL 超时归档：不再尝试上传', async () => {
    let nowMs = 1_000_000_000_000;
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const seed: PersistedEntry<TranscriptEntry[]> = {
      id: 'old-1',
      payload: [mkEntry(1)],
      createdAt: nowMs - 8 * 24 * 3600 * 1000, // 8 天前
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    };
    await persistent.append(seed);

    let uploadCalls = 0;
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        uploadCalls += 1;
      },
      persistentQueue: persistent,
      retryDelaysMs: [1],
      ttlMs: 7 * 24 * 3600 * 1000,
      now: () => nowMs,
    });

    const result = await sq.recover();
    expect(result).toEqual({ recovered: 0, archived: 1, failed: 0 });
    expect(uploadCalls).toBe(0);
    expect(persistent.size()).toBe(0);
    expect(persistent.archivedCount('ttl')).toBe(1);

    const archived = eventsOfType(TelemetryEvents.SYNC_ARCHIVED);
    expect(archived).toHaveLength(1);
    expect(archived[0]!.payload.reason).toBe('ttl');
    expect(archived[0]!.payload.id).toBe('old-1');
    await sq.dispose();
  });

  it('recover 时 uploadFn 未注入：保留磁盘条目，不归档（除非 TTL）', async () => {
    let nowMs = 1_000_000_000_000;
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    await persistent.append({
      id: 'fresh',
      payload: [mkEntry(1)],
      createdAt: nowMs - 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    await persistent.append({
      id: 'old',
      payload: [mkEntry(2)],
      createdAt: nowMs - 9 * 24 * 3600 * 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      persistentQueue: persistent,
      ttlMs: 7 * 24 * 3600 * 1000,
      now: () => nowMs,
    });

    const result = await sq.recover();
    expect(result).toEqual({ recovered: 0, archived: 1, failed: 0 });
    expect(persistent.size()).toBe(1); // 'fresh' 保留
    await sq.dispose();
  });

  // ── 技术 Review #2（H2-D）：TTL 临界点 ─────────────────────────────

  it('TTL 临界：createdAt = now - ttlMs（恰好 TTL）→ 不归档（< 严格小于）', async () => {
    const nowMs = 1_700_000_000_000;
    const ttlMs = 7 * 24 * 3600 * 1000;
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    await persistent.append({
      id: 'edge-eq',
      payload: [mkEntry(1)],
      createdAt: nowMs - ttlMs, // ttlCutoff = now - ttlMs；createdAt < ttlCutoff 才归档
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persistent,
      ttlMs,
      now: () => nowMs,
    });

    const result = await sq.recover();
    // 恰好等于 TTL 的条目按"严格小于 ttlCutoff 才归档"语义不归档，应被尝试上传
    expect(result.archived).toBe(0);
    expect(result.recovered).toBe(1);
    await sq.dispose();
  });

  it('TTL 临界：createdAt = now - ttlMs - 1（刚过 TTL）→ 归档', async () => {
    const nowMs = 1_700_000_000_000;
    const ttlMs = 7 * 24 * 3600 * 1000;
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    await persistent.append({
      id: 'edge-just-over',
      payload: [mkEntry(1)],
      createdAt: nowMs - ttlMs - 1, // 严格小于 ttlCutoff，应归档
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });

    let uploadCalls = 0;
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        uploadCalls += 1;
      },
      persistentQueue: persistent,
      ttlMs,
      now: () => nowMs,
    });

    const result = await sq.recover();
    expect(result.archived).toBe(1);
    expect(result.recovered).toBe(0);
    expect(uploadCalls).toBe(0); // 归档前不再尝试上传
    await sq.dispose();
  });
});

// ─── dispose / 边界 ──────────────────────────────────────────────

describe('SyncQueue — dispose & edge cases', () => {
  it('dispose 后 enqueue / flush no-op，多次 dispose 不抛', async () => {
    const sq = new SyncQueue({ owner: TEST_OWNER, uploadFn: async () => undefined });
    await sq.dispose();
    await sq.dispose(); // 幂等

    sq.enqueue(mkEntry(1));
    expect(sq.pendingCount).toBe(0);
    await sq.flush();
    await sq.recover();
  });

  it('空 retryDelaysMs 兜底为默认序列', async () => {
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      retryDelaysMs: [],
    });
    sq.enqueue(mkEntry(1));
    await sq.flush();
    expect(sq.pendingCount).toBe(0);
    await sq.dispose();
  });

  // ── 技术 Review #1：ownsPersistentQueue 契约 ─────────────────────

  it('外部传入 persistentQueue 时默认不拥有：dispose 不释放共享实例', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    let disposed = false;
    const origDispose = persistent.dispose.bind(persistent);
    persistent.dispose = () => {
      disposed = true;
      origDispose();
    };

    const sq = new SyncQueue({ owner: TEST_OWNER, persistentQueue: persistent });
    await sq.dispose();
    expect(disposed).toBe(false);
    // 共享实例仍可继续工作
    await persistent.append({
      id: 'x',
      payload: [mkEntry(1)],
      createdAt: Date.now(),
      attempts: 0,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    expect(persistent.size()).toBe(1);
  });

  it('未传 persistentQueue 时默认拥有：dispose 释放内部 InMemory 实例', async () => {
    const sq = new SyncQueue({ owner: TEST_OWNER });
    sq.enqueue(mkEntry(1));
    await sq.dispose();
    // 内部实例已 dispose；后续 enqueue / flush no-op，但不抛错
    sq.enqueue(mkEntry(2));
    await sq.flush();
  });

  it('显式 ownsPersistentQueue: true 强制释放外部传入', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    let disposed = false;
    const origDispose = persistent.dispose.bind(persistent);
    persistent.dispose = () => {
      disposed = true;
      origDispose();
    };

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      persistentQueue: persistent,
      ownsPersistentQueue: true,
    });
    await sq.dispose();
    expect(disposed).toBe(true);
  });

  // ── 产品 Review：recover 一致性 ─────────────────────────────────

  it('recover 上传成功但 remove 失败：不计 recovered，不发 sync.recovered', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    persistent.remove = async () => {
      throw new Error('disk locked');
    };
    await persistent.append({
      id: 'r-1',
      payload: [mkEntry(1)],
      createdAt: Date.now() - 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persistent,
      retryDelaysMs: [10],
    });

    const result = await sq.recover();
    expect(result.recovered).toBe(0);
    expect(result.failed).toBe(1);
    expect(eventsOfType(TelemetryEvents.SYNC_RECOVERED)).toHaveLength(0);
    await sq.dispose();
  });

  // ── 产品 Review：persistBatch 失败显式发事件 ────────────────────

  it('persistBatch 失败时发 sync.persist_failed（数据丢失但运维可见）', async () => {
    vi.useFakeTimers();
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    persistent.append = async () => {
      throw new Error('disk full');
    };
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('network down');
      },
      persistentQueue: persistent,
      retryDelaysMs: [5],
      newId: () => 'lost-batch-1',
    });
    sq.enqueue(mkEntry(1));
    const p = sq.flush();
    await vi.advanceTimersByTimeAsync(20);
    await p;

    const persistFailed = eventsOfType(TelemetryEvents.SYNC_PERSIST_FAILED);
    expect(persistFailed).toHaveLength(1);
    expect(persistFailed[0]!.payload.id).toBe('lost-batch-1');
    expect(persistFailed[0]!.payload.error_message).toBe('disk full');
    await sq.dispose();
  });

  // ── 技术 Review #2：recover 失败 attempts 累加正确（不再 off-by-one）─

  it('recover 失败累加 attempts = totalAttemptsPerRun = retryDelaysMs.length + 1', async () => {
    vi.useFakeTimers();
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    await persistent.append({
      id: 'fix-attempts',
      payload: [mkEntry(1)],
      createdAt: Date.now() - 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('still down');
      },
      persistentQueue: persistent,
      retryDelaysMs: [5, 5, 5], // 3 退避 + 1 立即 = 4 次
    });

    const p = sq.recover();
    await vi.advanceTimersByTimeAsync(20);
    await p;

    const remaining = await persistent.loadAll();
    expect(remaining[0]!.attempts).toBe(4 + 4); // off-by-one 修复后是 +4，不是 +3
    await sq.dispose();
  });

  // ── 技术 Review #3：dispose 中断 retry sleep（Window-D 修复） ────

  it('dispose 中断 retry sleep：不卡 25s，batch 落 persist 而非丢失', async () => {
    vi.useFakeTimers();
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    let uploadCalls = 0;
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        uploadCalls += 1;
        throw new Error('always down');
      },
      persistentQueue: persistent,
      retryDelaysMs: [25_000, 25_000, 25_000], // 故意拉长，模拟生产 25s 退避
      newId: () => 'window-d-batch',
    });
    sq.enqueue(mkEntry(1));

    const flushP = sq.flush();
    // 第 0 次立即跑 → 失败 → 进入 25s sleep
    await vi.advanceTimersByTimeAsync(0);
    expect(uploadCalls).toBe(1);

    // 模拟宿主 stop()：dispose 期间 sleep 立即被 abort，flush 完成 persistBatch
    const disposeP = sq.dispose();
    await vi.advanceTimersByTimeAsync(0);
    await Promise.all([flushP, disposeP]);

    // 关键验证：
    // 1. uploadFn 没被反复调用（abort 后立即跳出 retry）
    expect(uploadCalls).toBe(1);
    // 2. batch 已落到 persistent（dispose 之前 persist 已写）
    expect(persistent.size()).toBe(1);
    const all = await persistent.loadAll();
    expect(all[0]!.id).toBe('window-d-batch');
    expect(all[0]!.payload.map((e) => e.version)).toEqual([1]);
  });

  it('dispose 在没有 in-flight flush 时立即完成（向后兼容）', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persistent,
    });
    const start = Date.now();
    await sq.dispose();
    expect(Date.now() - start).toBeLessThan(50);
  });

  // ── 技术 Review #2（H2-D）：bootstrap onError 子阶段失败可观测 ────

  it('recover 时 loadAll 失败：onError 收到 phase=recover（宿主可转 telemetry）', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    persistent.loadAll = async () => {
      throw new Error('disk corrupted');
    };
    const seenErrors: Array<{ phase: string; message: string }> = [];
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persistent,
      onError: (err, ctx) =>
        seenErrors.push({ phase: ctx.phase, message: err.message }),
    });

    // recover 即使 loadAll 抛错也不应抛错——保 startup 不被阻塞
    const result = await sq.recover();
    expect(result).toEqual({ recovered: 0, archived: 0, failed: 0 });

    // onError 必须收到 phase=recover 的失败信号
    expect(seenErrors).toHaveLength(1);
    expect(seenErrors[0]!.phase).toBe('recover');
    expect(seenErrors[0]!.message).toBe('disk corrupted');
    await sq.dispose();
  });

  it('recover 时 archive 失败：onError 收到 phase=archive，不影响其他条目', async () => {
    let nowMs = 1_000_000_000_000;
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    // 一条已超 TTL（应归档）+ 一条新鲜的
    await persistent.append({
      id: 'old-1',
      payload: [mkEntry(1)],
      createdAt: nowMs - 8 * 24 * 3600 * 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    await persistent.append({
      id: 'fresh-1',
      payload: [mkEntry(2)],
      createdAt: nowMs - 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    persistent.archive = async () => {
      throw new Error('archive disk write failed');
    };

    const seenErrors: Array<{ phase: string; message: string }> = [];
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persistent,
      ttlMs: 7 * 24 * 3600 * 1000,
      now: () => nowMs,
      onError: (err, ctx) =>
        seenErrors.push({ phase: ctx.phase, message: err.message }),
    });

    const result = await sq.recover();
    // archive 失败 → failed += 1；fresh 上传成功 → recovered += 1
    expect(result.failed).toBe(1);
    expect(result.recovered).toBe(1);

    const archiveErrors = seenErrors.filter((e) => e.phase === 'archive');
    expect(archiveErrors).toHaveLength(1);
    expect(archiveErrors[0]!.message).toBe('archive disk write failed');
    await sq.dispose();
  });
});

// ─── LH2-D3：owner 校验 + 多账号场景 ────────────────────────────────

describe('SyncQueue — LH2-D3 owner enforcement', () => {
  it('构造时 owner 必填：缺失抛 Error（防止"unknown owner"持久化通路失效）', () => {
    expect(
      () =>
        new SyncQueue(
          // @ts-expect-error 故意省略 owner 验证编译期约束
          { uploadFn: async () => undefined },
        ),
    ).toThrow(/owner/i);
  });

  it('owner.userId 为空字符串：构造时抛错（assertValidOwner 屏障）', () => {
    expect(
      () =>
        new SyncQueue({
          owner: { userId: '', organizationId: 'wt-1' },
          uploadFn: async () => undefined,
        }),
    ).toThrow(/userId/);
  });

  it('owner.organizationId 含路径分隔符：构造时抛错（防 path traversal）', () => {
    expect(
      () =>
        new SyncQueue({
          owner: { userId: 'user-A', organizationId: '../escape' },
          uploadFn: async () => undefined,
        }),
    ).toThrow(/organizationId/);
  });

  it('persistBatch 自动注入 owner：磁盘 entry 带本 SyncQueue 的 owner', async () => {
    vi.useFakeTimers();
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('always down');
      },
      persistentQueue: persistent,
      retryDelaysMs: [10],
      newId: () => 'auto-owner-batch',
    });
    sq.enqueue(mkEntry(1));
    const p = sq.flush();
    await vi.advanceTimersByTimeAsync(20);
    await p;

    const all = await persistent.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.owner).toEqual(TEST_OWNER);
    await sq.dispose();
  });

  it('recover 时 owner mismatch：拒绝上传、不删除、不归档、计 failed', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    // 预置一条属于 user-B 的 entry（模拟其他账号的残留 batch）
    await persistent.append(
      mkPersisted({
        id: 'foreign-1',
        payload: [mkEntry(1)],
        createdAt: Date.now() - 1000,
        attempts: 4,
        owner: TEST_OWNER_B,
      }),
    );

    let uploadCalls = 0;
    const seenErrors: Array<{ phase: string; err: Error }> = [];
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        uploadCalls += 1;
      },
      persistentQueue: persistent,
      onError: (err, ctx) => seenErrors.push({ phase: ctx.phase, err }),
    });

    const result = await sq.recover();
    expect(result).toEqual({ recovered: 0, archived: 0, failed: 1 });
    expect(uploadCalls).toBe(0); // 关键：根本没尝试上传
    // entry 仍然在磁盘上（不删除、不归档）
    const remaining = await persistent.loadAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('foreign-1');

    // onError 收到 OwnerMismatchError，phase=recover
    expect(seenErrors).toHaveLength(1);
    expect(seenErrors[0]!.phase).toBe('recover');
    expect(seenErrors[0]!.err).toBeInstanceOf(OwnerMismatchError);
    expect((seenErrors[0]!.err as OwnerMismatchError).entryId).toBe('foreign-1');
    expect((seenErrors[0]!.err as OwnerMismatchError).entryOwner).toEqual(TEST_OWNER_B);
    expect((seenErrors[0]!.err as OwnerMismatchError).currentOwner).toEqual(TEST_OWNER);

    await sq.dispose();
  });

  it('recover 时部分 owner mismatch：自己的 entry 仍上传，别人的拒绝', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    await persistent.append(
      mkPersisted({
        id: 'mine-1',
        payload: [mkEntry(1)],
        createdAt: Date.now() - 1000,
        attempts: 4,
        owner: TEST_OWNER,
      }),
    );
    await persistent.append(
      mkPersisted({
        id: 'foreign-1',
        payload: [mkEntry(2)],
        createdAt: Date.now() - 1000,
        attempts: 4,
        owner: TEST_OWNER_B,
      }),
    );

    let uploaded: TranscriptEntry[][] = [];
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async (batch) => {
        uploaded.push(batch);
      },
      persistentQueue: persistent,
    });

    const result = await sq.recover();
    expect(result).toEqual({ recovered: 1, archived: 0, failed: 1 });
    // 自己的被上传 + 删除
    expect(uploaded).toHaveLength(1);
    expect(uploaded[0]!.map((e) => e.version)).toEqual([1]);
    // 别人的仍在磁盘
    const remaining = await persistent.loadAll();
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe('foreign-1');
    await sq.dispose();
  });

  it('recover 时遇到 LH2-D3 之前的"无 owner 字段"老 entry：当作 mismatch 拒绝', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    // 模拟旧版本写入：append 后把 owner 字段强行删掉
    await persistent.append(
      mkPersisted({
        id: 'legacy-1',
        payload: [mkEntry(1)],
        createdAt: Date.now() - 1000,
        attempts: 4,
        owner: TEST_OWNER, // 必填字段，先正常 append
      }),
    );
    // 然后绕开类型把 owner 抹掉，模拟老格式
    const stored = await persistent.loadAll();
    delete (stored[0] as unknown as { owner?: unknown }).owner;
    await persistent.update(stored[0]! as unknown as PersistedEntry<TranscriptEntry[]>);

    let uploadCalls = 0;
    const seenErrors: OwnerMismatchError[] = [];
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        uploadCalls += 1;
      },
      persistentQueue: persistent,
      onError: (err) => {
        if (err instanceof OwnerMismatchError) seenErrors.push(err);
      },
    });

    const result = await sq.recover();
    expect(result.failed).toBe(1);
    expect(uploadCalls).toBe(0);
    expect(seenErrors).toHaveLength(1);
    // 历史 entry 的 entryOwner 兜底为 unknown / unknown
    expect(seenErrors[0]!.entryOwner).toEqual({ userId: 'unknown', organizationId: 'unknown' });
    await sq.dispose();
  });

  it('agentId 不参与 owner 比对：(user, organization) 相同就算 match', async () => {
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();
    await persistent.append(
      mkPersisted({
        id: 'cross-agent-1',
        payload: [mkEntry(1)],
        createdAt: Date.now() - 1000,
        attempts: 4,
        owner: { ...TEST_OWNER, agentId: 'agent-A' },
      }),
    );

    let uploaded = 0;
    const sq = new SyncQueue({
      // 同 user+organization，但 agentId 不同——按设计应当视为 match
      owner: { userId: TEST_OWNER.userId, organizationId: TEST_OWNER.organizationId, agentId: 'agent-Z' },
      uploadFn: async () => {
        uploaded += 1;
      },
      persistentQueue: persistent,
    });

    const result = await sq.recover();
    expect(result.recovered).toBe(1);
    expect(uploaded).toBe(1);
    await sq.dispose();
  });

  it('LH2-D3 follow-up：mismatch + 已超 TTL → 归档到 owner_mismatch_ttl，不重复占盘', async () => {
    const nowMs = 1_700_000_000_000;
    const ttlMs = 7 * 24 * 3600 * 1000;
    const persistent = new InMemoryPersistentQueue<TranscriptEntry[]>();

    // 一条 owner 是 B 的、且超 TTL 的孤儿
    await persistent.append(
      mkPersisted({
        id: 'orphan-old',
        payload: [mkEntry(1)],
        createdAt: nowMs - ttlMs - 1,
        attempts: 4,
        owner: TEST_OWNER_B,
      }),
    );
    // 一条 owner 是 B 的、未超 TTL → 应保留等正确账号登录
    await persistent.append(
      mkPersisted({
        id: 'orphan-fresh',
        payload: [mkEntry(2)],
        createdAt: nowMs - 1000,
        attempts: 4,
        owner: TEST_OWNER_B,
      }),
    );
    // 一条 owner 缺失（历史 entry）且超 TTL → 归档到 owner_mismatch_ttl
    await persistent.append(
      mkPersisted({
        id: 'legacy-old',
        payload: [mkEntry(3)],
        createdAt: nowMs - ttlMs - 100,
        attempts: 4,
        owner: TEST_OWNER, // 先合法 append
      }),
    );
    const stored = await persistent.loadAll();
    const legacyEntry = stored.find((e) => e.id === 'legacy-old')!;
    delete (legacyEntry as unknown as { owner?: unknown }).owner;
    await persistent.update(legacyEntry as unknown as PersistedEntry<TranscriptEntry[]>);

    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => undefined,
      persistentQueue: persistent,
      ttlMs,
      now: () => nowMs,
    });

    const result = await sq.recover();
    // 计数语义（与代码顺序一致）：
    // - 三条 mismatch entry 都进 failed（mismatch 拒绝 = recover 失败）→ failed=3
    // - 其中两条已超 TTL → 同时进 archived → archived=2
    // - 失败但未归档的（orphan-fresh 未超 TTL）保留在 pending
    expect(result.archived).toBe(2);
    expect(result.failed).toBe(3);
    expect(result.recovered).toBe(0);

    // 归档计数 + reason 校验
    expect(persistent.archivedCount('owner_mismatch_ttl')).toBe(2);
    expect(persistent.archivedCount('ttl')).toBe(0);

    // pending 应仅剩 fresh 那一条
    const remaining = await persistent.loadAll();
    expect(remaining.map((e) => e.id)).toEqual(['orphan-fresh']);

    // telemetry：sync.archived 事件应有 reason='owner_mismatch_ttl' 与 entry_owner_* 字段
    const archivedEvents = eventsOfType(TelemetryEvents.SYNC_ARCHIVED);
    expect(archivedEvents).toHaveLength(2);
    for (const ev of archivedEvents) {
      expect(ev.payload.reason).toBe('owner_mismatch_ttl');
      expect(ev.payload.entry_owner_user_id).toBeDefined();
    }

    await sq.dispose();
  });

  it('owner 信息进入 telemetry payload：dashboard 可按 user/organization 聚合', async () => {
    vi.useFakeTimers();
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('boom');
      },
      persistentQueue: new InMemoryPersistentQueue<TranscriptEntry[]>(),
      retryDelaysMs: [1],
    });
    sq.enqueue(mkEntry(1));
    const p = sq.flush();
    await vi.advanceTimersByTimeAsync(2);
    await p;

    const failed = eventsOfType(TelemetryEvents.SYNC_FAILED);
    expect(failed.length).toBeGreaterThan(0);
    expect(failed[0]!.payload.owner_user_id).toBe(TEST_OWNER.userId);
    expect(failed[0]!.payload.owner_organization_id).toBe(TEST_OWNER.organizationId);
    expect(failed[0]!.payload.owner_agent_id).toBe(TEST_OWNER.agentId);
    await sq.dispose();
  });
});
