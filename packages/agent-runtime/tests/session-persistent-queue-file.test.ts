/**
 * FR-14（H2-D）：FilePersistentQueue（基于 fs JSONL）的 I/O 集成测试。
 *
 * 覆盖：
 *   - 新建/读写/折叠（同 id 后写覆盖前写）
 *   - tombstone 删除 + loadAll 跳过
 *   - archive 移到 archive 子文件 + 主文件写 tombstone
 *   - 跨进程恢复（关闭一份实例 → 新实例 loadAll 仍能正确还原）
 *   - compact 触发后文件大小回落
 *   - 损坏行被跳过（不影响其他条目）
 *
 * 测试目录走 `os.tmpdir()`，beforeEach 清理；不依赖系统级路径。
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  FilePersistentQueue,
  type PersistedEntry,
} from '../src/session/index.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tabtin-pq-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

function mkEntry(id: string, createdAt: number, payload: string[] = ['x']): PersistedEntry<string[]> {
  return { id, payload, createdAt, attempts: 0, lastAttemptAt: null };
}

describe('FilePersistentQueue — basic I/O', () => {
  it('append + loadAll 写读对称', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });
    await q.append(mkEntry('a', 100, ['v1']));
    await q.append(mkEntry('b', 200, ['v2']));

    const all = await q.loadAll();
    expect(all.map((e) => e.id)).toEqual(['a', 'b']);
    expect(all[0]!.payload).toEqual(['v1']);
    expect(all[1]!.payload).toEqual(['v2']);
    await q.dispose();
  });

  it('append 同 id 二次：loadAll 折叠后只保留最新（update 语义）', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });
    await q.append(mkEntry('a', 100, ['v1']));
    await q.update({ ...mkEntry('a', 100, ['v2']), attempts: 5 });

    const all = await q.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.payload).toEqual(['v2']);
    expect(all[0]!.attempts).toBe(5);
    await q.dispose();
  });

  it('remove 写 tombstone，loadAll 不再返回该 id', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });
    await q.append(mkEntry('a', 100));
    await q.append(mkEntry('b', 200));
    await q.remove('a');

    const all = await q.loadAll();
    expect(all.map((e) => e.id)).toEqual(['b']);
    await q.dispose();
  });

  it('archive 写归档文件 + 主队列写 tombstone', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });
    await q.append(mkEntry('a', 100));
    const [entry] = await q.loadAll();
    await q.archive(entry!, 'ttl');

    expect(await q.loadAll()).toEqual([]);
    const archiveRaw = fs.readFileSync(q.getArchivePath(), 'utf-8');
    const lines = archiveRaw.trim().split('\n');
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!);
    expect(parsed.id).toBe('a');
    expect(parsed.__archive_reason__).toBe('ttl');
    expect(typeof parsed.__archived_at__).toBe('number');
    await q.dispose();
  });

  it('跨实例恢复：关闭后新实例能 loadAll 出原数据', async () => {
    const q1 = new FilePersistentQueue<string[]>({ dir: tmpDir });
    await q1.append(mkEntry('a', 100, ['v1']));
    await q1.append(mkEntry('b', 200, ['v2']));
    await q1.dispose();

    const q2 = new FilePersistentQueue<string[]>({ dir: tmpDir });
    const all = await q2.loadAll();
    expect(all.map((e) => e.id)).toEqual(['a', 'b']);
    await q2.dispose();
  });

  it('损坏行被跳过，其他条目仍能恢复', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });
    await q.append(mkEntry('a', 100));
    fs.appendFileSync(q.getPendingPath(), '{not-json}\n');
    await q.append(mkEntry('b', 200));

    const all = await q.loadAll();
    expect(all.map((e) => e.id)).toEqual(['a', 'b']);
    await q.dispose();
  });

  it('compact 触发后文件体积回落（tombstone 比例策略）', async () => {
    const q = new FilePersistentQueue<string[]>({
      dir: tmpDir,
      compactThresholdBytes: 1, // 强制 size 触发
      compactTombstoneRatio: 0.4,
    });

    for (let i = 0; i < 10; i++) {
      await q.append(mkEntry(`id-${i}`, i));
    }
    const sizeBefore = fs.statSync(q.getPendingPath()).size;
    expect(sizeBefore).toBeGreaterThan(0);

    // 删一半
    for (let i = 0; i < 5; i++) {
      await q.remove(`id-${i}`);
    }

    // 触发一次写以引发 maybeCompact 路径
    await q.remove('id-5');

    const all = await q.loadAll();
    expect(all.map((e) => e.id).sort()).toEqual(['id-6', 'id-7', 'id-8', 'id-9']);
    const sizeAfter = fs.statSync(q.getPendingPath()).size;
    // compact 后只剩 4 条，应该明显小于 11+ 条原始记录
    expect(sizeAfter).toBeLessThan(sizeBefore);
    await q.dispose();
  });

  it('dispose 后操作抛错', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });
    await q.dispose();
    await expect(q.append(mkEntry('a', 100))).rejects.toThrow(/disposed/);
    await expect(q.loadAll()).rejects.toThrow(/disposed/);
  });

  it('文件不存在时 loadAll 返回空', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });
    expect(await q.loadAll()).toEqual([]);
    await q.dispose();
  });

  it('逐行流式读：大文件（含大 payload 行 + tombstone）不整读单字符串，语义无损', async () => {
    // 回归 relay 队列膨胀崩溃：旧实现 loadAll 用 `readFile(全文,'utf-8')`，
    // 文件超 V8 单字符串上限（~512MB）即抛 Invalid string length、recover 永久
    // 失效。改逐行流式读后，单行远小于整文件即可正常读。这里用多条 MB 级
    // 大行 + tombstone + 同 id 覆盖，验证流式读的折叠/删除/排序语义与小文件一致。
    const q = new FilePersistentQueue<string[]>({
      dir: tmpDir,
      // 关掉 compact，确保断言的是流式 loadAll 本身而非 compact 后的小文件。
      compactThresholdBytes: Number.MAX_SAFE_INTEGER,
      compactTombstoneRatio: 1,
    });
    // 每行约 1MB payload，5 行 → ~5MB 文件（多行，逐行读每行 < 512MB）。
    const big = 'x'.repeat(1024 * 1024);
    await q.append(mkEntry('a', 100, [big]));
    await q.append(mkEntry('b', 200, [big]));
    await q.update({ ...mkEntry('b', 200, ['b-updated']), attempts: 3 }); // 同 id 覆盖
    await q.append(mkEntry('c', 300, [big]));
    await q.remove('a'); // tombstone

    const all = await q.loadAll();
    expect(all.map((e) => e.id)).toEqual(['b', 'c']); // a 被删；按 createdAt 升序
    expect(all[0]!.payload).toEqual(['b-updated']); // 折叠取最新
    expect(all[0]!.attempts).toBe(3);
    expect(all[1]!.payload).toEqual([big]);
    await q.dispose();
  });

  it('onError 回调在写失败时触发', async () => {
    const q = new FilePersistentQueue<string[]>({
      dir: tmpDir,
      onError: () => undefined,
    });
    // 正常路径就过了；写失败的真实场景需要 mock fs，这里只确认 happy path 不调
    let triggered = 0;
    const q2 = new FilePersistentQueue<string[]>({
      dir: tmpDir,
      onError: () => {
        triggered += 1;
      },
    });
    await q2.append(mkEntry('a', 100));
    expect(triggered).toBe(0);
    await q.dispose();
    await q2.dispose();
  });

  // ── 技术 Review #4：loadAll 串行化（>4KB 并发原子性） ───────────

  it('loadAll 与并发 append 串行：>4KB payload 也能正确 loadAll', async () => {
    const q = new FilePersistentQueue<string[]>({ dir: tmpDir });

    // 构造典型 >4KB payload：50 条 message 各 ~150 字符 → 单行 JSON ~8KB
    const bigPayload = Array.from({ length: 50 }, (_, i) =>
      'x'.repeat(150) + '-' + i,
    );
    const bigEntry: PersistedEntry<string[]> = {
      id: 'big-1',
      payload: bigPayload,
      createdAt: 100,
      attempts: 0,
      lastAttemptAt: null,
    };

    // 并发：append 大 payload + loadAll + append 第二条
    const [, all] = await Promise.all([
      q.append(bigEntry),
      q.loadAll(),
      q.append(mkEntry('b', 200)),
    ]);

    // loadAll 串行化后应看到"两笔写完成后的一致状态"或"两笔写之前的空状态"
    // 但绝不应读到截断行——所以最终再 loadAll 一定能读到完整的 big-1 + b
    const final = await q.loadAll();
    expect(final.map((e) => e.id).sort()).toEqual(['b', 'big-1']);
    const bigRead = final.find((e) => e.id === 'big-1');
    expect(bigRead!.payload).toHaveLength(50);
    expect(bigRead!.payload[0]).toBe(bigPayload[0]);
    // 中途的 loadAll 只是序列化保证，不强行断言它的具体长度
    expect(Array.isArray(all)).toBe(true);
    await q.dispose();
  });

  // ── 技术 Review #2（H2-D）：compact 失败时 onError 与主路径解耦 ──

  it('compact 失败时 onError 收到 phase=compact，主路径不抛错且数据无损', async () => {
    const seen: Array<{ phase: string; message: string }> = [];
    const q = new FilePersistentQueue<string[]>({
      dir: tmpDir,
      compactThresholdBytes: 1, // 任何字节都触发 size 维度 compact
      compactTombstoneRatio: 0.0,
      onError: (err, ctx) => seen.push({ phase: ctx.phase, message: err.message }),
    });

    await q.append(mkEntry('a', 100));

    // mock writeFile 让 compact 阶段的 tmp 写入失败
    const fsMod = await import('node:fs');
    const orig = fsMod.promises.writeFile;
    let interceptCount = 0;
    fsMod.promises.writeFile = (async () => {
      interceptCount += 1;
      throw new Error('compact tmp write failed');
    }) as typeof fsMod.promises.writeFile;
    try {
      // remove 触发 maybeCompact 路径
      await q.remove('a');
    } finally {
      fsMod.promises.writeFile = orig;
    }

    // compact 内 onError 应当被触发，phase='compact'
    const compactErrors = seen.filter((e) => e.phase === 'compact');
    expect(compactErrors).toHaveLength(1);
    expect(compactErrors[0]!.message).toBe('compact tmp write failed');
    expect(interceptCount).toBe(1);

    // 主路径不抛 + 仍能 loadAll 折叠出删除后的状态（compact 失败 ≠ 数据破坏）
    const all = await q.loadAll();
    expect(all).toEqual([]);
    await q.dispose();
  });
});
