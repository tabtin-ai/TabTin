/**
 * FR-14（H2-D）：PersistentQueue 抽象与 InMemoryPersistentQueue 单测。
 *
 * 不包含 FilePersistentQueue 的 fs 集成（独立文件 `session-persistent-queue-file.test.ts`）。
 */

import { describe, it, expect } from 'vitest';
import {
  InMemoryPersistentQueue,
  type PersistedEntry,
} from '../src/session/persistent-queue.js';

function mkEntry(id: string, createdAt: number, payload = ['x']): PersistedEntry<string[]> {
  return { id, payload, createdAt, attempts: 0, lastAttemptAt: null };
}

describe('InMemoryPersistentQueue — base contract', () => {
  it('append + loadAll 返回 FIFO（按 createdAt 升序）', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    await q.append(mkEntry('b', 200));
    await q.append(mkEntry('a', 100));
    await q.append(mkEntry('c', 300));

    const all = await q.loadAll();
    expect(all.map((e) => e.id)).toEqual(['a', 'b', 'c']);
  });

  it('append 同 id 二次写覆盖（upsert 语义）', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    await q.append(mkEntry('a', 100, ['v1']));
    await q.append({ ...mkEntry('a', 100, ['v2']), attempts: 5, lastAttemptAt: 999 });

    const all = await q.loadAll();
    expect(all).toHaveLength(1);
    expect(all[0]!.payload).toEqual(['v2']);
    expect(all[0]!.attempts).toBe(5);
    expect(all[0]!.lastAttemptAt).toBe(999);
  });

  it('update == upsert（同 id 覆盖）', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    await q.append(mkEntry('a', 100));
    await q.update({ ...mkEntry('a', 100), attempts: 3, lastAttemptAt: 500 });

    const all = await q.loadAll();
    expect(all[0]!.attempts).toBe(3);
  });

  it('remove 幂等（不存在 id 不抛）', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    await expect(q.remove('not-exist')).resolves.toBeUndefined();

    await q.append(mkEntry('a', 100));
    await q.remove('a');
    expect(await q.loadAll()).toEqual([]);
    await expect(q.remove('a')).resolves.toBeUndefined();
  });

  it('archive 移到归档（loadAll 不再含），保留可审计', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    await q.append(mkEntry('a', 100));
    await q.append(mkEntry('b', 200));
    const all = await q.loadAll();
    await q.archive(all[0]!, 'ttl');

    expect(await q.loadAll()).toHaveLength(1);
    expect(q.archivedCount()).toBe(1);
    expect(q.archivedCount('ttl')).toBe(1);
    expect(q.archivedCount('max_attempts')).toBe(0);
    const snap = q.archivedSnapshot();
    expect(snap[0]?.entry.id).toBe('a');
  });

  it('loadAll 返回的是拷贝（外部修改不影响内部状态）', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    await q.append(mkEntry('a', 100));
    const all = await q.loadAll();
    all[0]!.attempts = 99;

    const reloaded = await q.loadAll();
    expect(reloaded[0]!.attempts).toBe(0);
  });

  it('dispose 后所有操作抛错', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    q.dispose();
    await expect(q.append(mkEntry('a', 100))).rejects.toThrow(/disposed/);
    await expect(q.loadAll()).rejects.toThrow(/disposed/);
    await expect(q.remove('a')).rejects.toThrow(/disposed/);
  });

  it('size() 测试辅助返回当前主队列大小', async () => {
    const q = new InMemoryPersistentQueue<string[]>();
    expect(q.size()).toBe(0);
    await q.append(mkEntry('a', 100));
    await q.append(mkEntry('b', 200));
    expect(q.size()).toBe(2);
    const all = await q.loadAll();
    await q.archive(all[0]!, 'ttl');
    expect(q.size()).toBe(1);
  });
});
