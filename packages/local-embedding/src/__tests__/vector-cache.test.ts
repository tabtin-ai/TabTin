import { describe, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { VectorCache } from '../vector-cache.js';
import { MANIFEST_FILENAME, VECTORS_FILENAME } from '../constants.js';

const DIMS = 4;
const MODEL = 'test-model';

async function tmpDir(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), 'vector-cache-test-'));
}

function vec(...values: number[]): Float32Array {
  return new Float32Array(values);
}

describe('VectorCache 落盘与重载', () => {
  it('set + flush 后新实例 load 能读回相同向量', async () => {
    const dir = await tmpDir();
    const cache = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    cache.set('h1', vec(1, 2, 3, 4));
    cache.set('h2', vec(5, 6, 7, 8));
    await cache.flush();

    const reloaded = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    await reloaded.load();
    expect(Array.from(reloaded.get('h1')!)).toEqual([1, 2, 3, 4]);
    expect(Array.from(reloaded.get('h2')!)).toEqual([5, 6, 7, 8]);
  });

  it('flush 合并磁盘快照——不清掉其他进程写的条目', async () => {
    const dir = await tmpDir();
    // 进程 A 写入并落盘
    const procA = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    procA.set('from-a', vec(1, 1, 1, 1));
    await procA.flush();

    // 进程 B（未 load 到 A 的条目也一样）只写自己的条目后 flush
    const procB = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    procB.set('from-b', vec(2, 2, 2, 2));
    await procB.flush();

    // 两方条目都应存活
    const reader = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    await reader.load();
    expect(reader.get('from-a')).toBeDefined();
    expect(reader.get('from-b')).toBeDefined();
  });

  it('超过 TTL 未使用的条目随快照重写清除', async () => {
    const dir = await tmpDir();
    const first = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    first.set('stale', vec(2, 2, 2, 2));
    await first.flush();

    // 把磁盘上 stale 的 lastUsedAt 改成远古时间，模拟过期
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.entries[0].lastUsedAt = 1;
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const second = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    await second.load();
    second.set('fresh', vec(3, 3, 3, 3));
    await second.flush();

    const third = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    await third.load();
    expect(third.get('fresh')).toBeDefined();
    expect(third.get('stale')).toBeUndefined();
  });

  it('modelId 不匹配的快照按冷启动处理', async () => {
    const dir = await tmpDir();
    const cache = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    cache.set('h1', vec(1, 2, 3, 4));
    await cache.flush();

    const other = new VectorCache({ dir, modelId: 'other-model', dims: DIMS });
    await other.load();
    expect(other.get('h1')).toBeUndefined();
  });

  it('manifest 损坏时 load 不抛错、按空缓存继续', async () => {
    const dir = await tmpDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, MANIFEST_FILENAME), '{broken json');
    await fs.writeFile(path.join(dir, VECTORS_FILENAME), Buffer.alloc(16));

    const cache = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    await expect(cache.load()).resolves.toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('manifest 槽位越界的条目被跳过，其余正常', async () => {
    const dir = await tmpDir();
    const cache = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    cache.set('good', vec(1, 2, 3, 4));
    await cache.flush();
    // 篡改 manifest：加一个指向越界槽位的条目
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
    manifest.entries.push({ hash: 'out-of-range', slot: 99 });
    await fs.writeFile(manifestPath, JSON.stringify(manifest));

    const reloaded = new VectorCache({ dir, modelId: MODEL, dims: DIMS });
    await reloaded.load();
    expect(reloaded.get('good')).toBeDefined();
    expect(reloaded.get('out-of-range')).toBeUndefined();
  });
});
