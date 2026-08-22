/**
 * FR-14（H2-D）：Daemon 侧 SyncQueue + FilePersistentQueue 跨实例恢复集成测试。
 *
 * 该测试不构造完整 DaemonAgentHost（避免拖入 gateway / mkdir / Logger 副
 * 作用），而是直接对 `FilePersistentQueue` + `SyncQueue` 在自定义临时目录
 * 跑端到端：
 *   1. 上传持续失败 → batch 落盘
 *   2. dispose 模拟"Daemon 关闭"
 *   3. 新建 FilePersistentQueue 实例（同目录）+ 新 SyncQueue → recover
 *   4. recover 路径上传成功 → 磁盘条目被删除
 *
 * 这一组测试代表"DaemonAgentHost.start() 时 bootstrap.recover()"的真实
 * I/O 行为；DaemonAgentHost 自身的接线由 host-knobs 单测 + 代码 review
 * 覆盖。
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  SyncQueue,
  FilePersistentQueue,
  buildSyncAccountDir,
  clearSyncAccountDir,
  OwnerMismatchError,
  type TranscriptEntry,
  type PersistedEntryOwner,
} from '@tabtin/agent-runtime';
import {
  resetTelemetrySink,
  setTelemetrySink,
  TelemetryEvents,
  type TelemetryRecord,
} from '@tabtin/agent-runtime';

const TEST_OWNER: PersistedEntryOwner = {
  userId: 'user-daemon-A',
  organizationId: 'wt-daemon-1',
  agentId: 'agent-A',
};

const TEST_OWNER_B: PersistedEntryOwner = {
  userId: 'user-daemon-B',
  organizationId: 'wt-daemon-2',
};

let tmpDir: string;
let captured: TelemetryRecord[];

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-daemon-sync-'));
  captured = [];
  setTelemetrySink((r) => captured.push(r));
});

afterEach(() => {
  resetTelemetrySink();
  vi.useRealTimers();
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mkEntry(version: number): TranscriptEntry {
  return {
    type: 'user',
    timestamp: Date.now(),
    sessionId: 'sess-daemon',
    version,
    message: { role: 'user', content: `m-${version}` },
  };
}

describe('Daemon SyncQueue persistence — cross-instance recovery', () => {
  it('uploadFn 三次失败 → 落 disk JSONL → 新实例 recover 上传成功', async () => {
    vi.useFakeTimers();

    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER);
    // ── 第一阶段：模拟 Daemon 运行，uploadFn 一直失败 ────────────────
    const persistent1 = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir });
    const sq1 = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        throw new Error('network down');
      },
      persistentQueue: persistent1,
      retryDelaysMs: [10, 10, 10],
      newId: () => 'persisted-1',
    });
    sq1.enqueue(mkEntry(1));
    sq1.enqueue(mkEntry(2));
    const flushP = sq1.flush();
    await vi.advanceTimersByTimeAsync(50);
    await flushP;

    // 已落盘：磁盘 JSONL 里应有一条
    expect(fs.readFileSync(persistent1.getPendingPath(), 'utf-8'))
      .toMatch(/persisted-1/);

    await sq1.dispose();
    await persistent1.dispose();

    // ── 第二阶段：模拟 Daemon 重启，新实例从同目录 recover ────────────
    let uploadedBatch: TranscriptEntry[] | null = null;
    const persistent2 = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir });
    const sq2 = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async (batch) => {
        uploadedBatch = batch;
        // 第二阶段网络已恢复
      },
      persistentQueue: persistent2,
      retryDelaysMs: [10],
    });

    const result = await sq2.recover();
    expect(result).toEqual({ recovered: 1, archived: 0, failed: 0 });
    expect(uploadedBatch).not.toBeNull();
    expect(uploadedBatch!.map((e) => e.version)).toEqual([1, 2]);

    // 磁盘条目应已被 tombstone 删除
    const reloaded = await persistent2.loadAll();
    expect(reloaded).toEqual([]);

    await sq2.dispose();
    await persistent2.dispose();

    // ── telemetry 事件应当出现 sync.persisted + sync.recovered ────────
    const persistedEvents = captured.filter(
      (r) => r.event_name === TelemetryEvents.SYNC_PERSISTED,
    );
    const recoveredEvents = captured.filter(
      (r) => r.event_name === TelemetryEvents.SYNC_RECOVERED,
    );
    expect(persistedEvents).toHaveLength(1);
    expect(recoveredEvents).toHaveLength(1);
    expect(recoveredEvents[0]!.payload.id).toBe('persisted-1');
  });

  it('TTL 超时的旧条目在 recover 时被归档而非重试', async () => {
    let nowMs = 1_700_000_000_000;

    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER);
    // 直接预置一个 8 天前的 entry 到磁盘（模拟"Daemon 离线 8 天后启动"）
    const persistent = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir });
    await persistent.append({
      id: 'stale-1',
      payload: [mkEntry(1)],
      createdAt: nowMs - 8 * 24 * 3600 * 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    await persistent.dispose();

    // 重启
    let uploadCalls = 0;
    const persistent2 = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir });
    const sq = new SyncQueue({
      owner: TEST_OWNER,
      uploadFn: async () => {
        uploadCalls += 1;
      },
      persistentQueue: persistent2,
      ttlMs: 7 * 24 * 3600 * 1000,
      now: () => nowMs,
    });

    const result = await sq.recover();
    expect(result).toEqual({ recovered: 0, archived: 1, failed: 0 });
    expect(uploadCalls).toBe(0);
    expect(await persistent2.loadAll()).toEqual([]);

    // archive 子文件应有一条带 reason=ttl 的记录
    const archiveContent = fs.readFileSync(persistent2.getArchivePath(), 'utf-8');
    expect(archiveContent).toMatch(/__archive_reason__/);
    expect(archiveContent).toMatch(/ttl/);

    await sq.dispose();
    await persistent2.dispose();
  });

  it('磁盘队列与 M1B-2 pendingSyncQueue 物理隔离：写到独立目录，互不干扰', async () => {
    // M1B-2 跑在 renderer 的浏览器 IndexedDB（DB name: tabtin-pending-sync）；
    // Runtime 跑在 daemon main process 的 fs（dir 由调用方提供）。本测试验证
    // 我们只触碰自己的 dir 下的文件，不会污染（也无法）IndexedDB。
    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER);
    const persistent = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir });
    await persistent.append({
      id: 'iso-1',
      payload: [mkEntry(99)],
      createdAt: Date.now(),
      attempts: 1,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    await persistent.dispose();

    const files = fs.readdirSync(ownerDir);
    expect(files).toContain('pending.jsonl');
    // 确保不会意外写到非 dir 路径
    expect(files.every((f) => /jsonl$/.test(f) || f === 'pending.jsonl')).toBe(true);
  });

  // 技术 Review #2（H2-D）：bootstrap recover 失败的可观测性
  // 模拟 DaemonAgentHost.start() 的 bootstrap onError 接线——loadAll 抛错应转
  // SYNC_BOOTSTRAP_RECOVER_FAILED telemetry。
  it('bootstrap onError 注入：recover 内 loadAll 失败时发 sync.bootstrap_recover_failed', async () => {
    const ownerDir = buildSyncAccountDir(tmpDir, TEST_OWNER);
    const persist = new FilePersistentQueue<TranscriptEntry[]>({ dir: ownerDir });
    persist.loadAll = async () => {
      throw new Error('daemon disk read-only');
    };

    const bootstrap = new SyncQueue({
      owner: TEST_OWNER,
      persistentQueue: persist,
      ownsPersistentQueue: false,
      onError: (err, ctx) => {
        const message = err instanceof Error ? err.message : String(err);
        captured.push({
          event_name: TelemetryEvents.SYNC_BOOTSTRAP_RECOVER_FAILED,
          payload: { host: 'daemon', phase: ctx.phase, error_message: message },
        } as TelemetryRecord);
      },
    });

    const result = await bootstrap.recover();
    expect(result).toEqual({ recovered: 0, archived: 0, failed: 0 });

    const events = captured.filter(
      (r) => r.event_name === TelemetryEvents.SYNC_BOOTSTRAP_RECOVER_FAILED,
    );
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      host: 'daemon',
      phase: 'recover',
      error_message: 'daemon disk read-only',
    });

    await bootstrap.dispose();
    await persist.dispose();
  });

  // ── LH2-D1 / LH2-D2 / LH2-D3：账号分桶端到端 ─────────────────────────

  it('LH2-D1：A 账号 batch 落 disk 后，B 账号在自己桶里看不到 A 的 entry', async () => {
    const dirA = buildSyncAccountDir(tmpDir, TEST_OWNER);
    const persistA = new FilePersistentQueue<TranscriptEntry[]>({ dir: dirA });
    await persistA.append({
      id: 'A-1',
      payload: [mkEntry(1)],
      createdAt: Date.now() - 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    await persistA.dispose();

    // B 进入：构造 B 桶（不会触碰 A 的目录）
    const dirB = buildSyncAccountDir(tmpDir, TEST_OWNER_B);
    expect(fs.existsSync(dirA)).toBe(true);
    expect(fs.existsSync(dirB)).toBe(false);

    const persistB = new FilePersistentQueue<TranscriptEntry[]>({ dir: dirB });
    expect(await persistB.loadAll()).toEqual([]);

    // A 的目录还在，数据保留
    const persistA2 = new FilePersistentQueue<TranscriptEntry[]>({ dir: dirA });
    const all = await persistA2.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.id).toBe('A-1');

    await persistA2.dispose();
    await persistB.dispose();
  });

  it('LH2-D2：clearSyncAccountDir 只清当前 owner 目录，其他 owner 保留', async () => {
    const dirA = buildSyncAccountDir(tmpDir, TEST_OWNER);
    const dirB = buildSyncAccountDir(tmpDir, TEST_OWNER_B);
    fs.mkdirSync(dirA, { recursive: true });
    fs.mkdirSync(dirB, { recursive: true });
    fs.writeFileSync(path.join(dirA, 'pending.jsonl'), 'A pending\n');
    fs.writeFileSync(path.join(dirB, 'pending.jsonl'), 'B pending\n');

    await clearSyncAccountDir(tmpDir, TEST_OWNER);

    expect(fs.existsSync(dirA)).toBe(false);
    expect(fs.existsSync(dirB)).toBe(true);
    expect(fs.readFileSync(path.join(dirB, 'pending.jsonl'), 'utf-8')).toBe('B pending\n');
  });

  it('LH2-D3：模拟"恶意拷贝 A 的 entry 到 B 桶" → B recover 时 owner mismatch 拒绝上传', async () => {
    // A 写入合法 entry
    const dirA = buildSyncAccountDir(tmpDir, TEST_OWNER);
    const persistA = new FilePersistentQueue<TranscriptEntry[]>({ dir: dirA });
    await persistA.append({
      id: 'leaked-1',
      payload: [mkEntry(42)],
      createdAt: Date.now() - 1000,
      attempts: 4,
      lastAttemptAt: null,
      owner: TEST_OWNER,
    });
    await persistA.dispose();

    // 恶意拷贝到 B 桶
    const dirB = buildSyncAccountDir(tmpDir, TEST_OWNER_B);
    fs.mkdirSync(dirB, { recursive: true });
    fs.copyFileSync(path.join(dirA, 'pending.jsonl'), path.join(dirB, 'pending.jsonl'));

    // B 起 recover：必须拒绝
    const persistB = new FilePersistentQueue<TranscriptEntry[]>({ dir: dirB });
    let bUploaded = 0;
    const seenErrors: OwnerMismatchError[] = [];
    const sqB = new SyncQueue({
      owner: TEST_OWNER_B,
      uploadFn: async () => { bUploaded += 1; },
      persistentQueue: persistB,
      onError: (err) => {
        if (err instanceof OwnerMismatchError) seenErrors.push(err);
      },
    });
    const result = await sqB.recover();
    expect(result.failed).toBe(1);
    expect(bUploaded).toBe(0);
    expect(seenErrors).toHaveLength(1);
    expect(seenErrors[0]!.entryOwner.userId).toBe(TEST_OWNER.userId);
    // entry 仍在磁盘
    expect(await persistB.loadAll()).toHaveLength(1);
    await sqB.dispose();
    await persistB.dispose();
  });
});
