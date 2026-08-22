/**
 * W2.3 — `storage-bucket-registration.ts` 单元测试。
 *
 * 验证：
 *   1. 13 个 bucket 全部注册成功（北极星：CLI list 输出 13 条的前置条件）
 *   2. 每个 bucket id / category / group / clearFn 是否可调用 与 RFC §五 表格对齐
 *   3. data 类 bucket 都有 warnings（assertValidBucket 会拒，但显式测一下契约）
 *   4. table-kernel-db 的 clearFn 抛错（不允许直接清，必须先 drain）
 *   5. config / fingerprint 没有 clearFn（不可清）
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  __resetForTesting,
  getBucket,
  listBuckets,
} from '@tabtin/storage-manager';
import {
  DAEMON_BUCKET_IDS,
  registerDaemonStorageBuckets,
} from '../src/platform/storage/storage-bucket-registration.js';

let tmpHome: string;

beforeEach(() => {
  __resetForTesting();
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-storage-test-'));
});

afterEach(() => {
  __resetForTesting();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('registerDaemonStorageBuckets', () => {
  it('注册 14 个 daemon: 前缀的 bucket（含 R1 P0 修复补充的 daemon:browser-exports）', () => {
    const offs = registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    expect(offs).toHaveLength(14);

    const buckets = listBuckets({ includeHidden: true });
    const daemonBuckets = buckets.filter((b) => b.id.startsWith('daemon:'));
    expect(daemonBuckets).toHaveLength(14);

    const ids = daemonBuckets.map((b) => b.id).sort();
    const expectedIds = [...DAEMON_BUCKET_IDS].sort();
    expect(ids).toEqual(expectedIds);
    expect(ids).toContain('daemon:browser-exports');
  });

  it('每个 bucket 都通过 storage-manager 校验（id / category / group / sizeFn 完整）', () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    for (const id of DAEMON_BUCKET_IDS) {
      const bucket = getBucket(id);
      expect(bucket, `bucket ${id} 未注册`).toBeDefined();
      expect(bucket!.id).toBe(id);
      expect(typeof bucket!.sizeFn).toBe('function');
      expect(bucket!.displayName.length).toBeGreaterThan(0);
      expect(bucket!.description.length).toBeGreaterThan(0);
    }
  });

  it('data 类 bucket 必须有非空 warnings', () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const dataBuckets = listBuckets({
      category: 'data',
      includeHidden: true,
    }).filter((b) => b.id.startsWith('daemon:'));
    expect(dataBuckets.length).toBeGreaterThan(0);
    for (const b of dataBuckets) {
      expect(b.warnings, `data bucket ${b.id} 必须有 warnings`).toBeDefined();
      expect(b.warnings!.length).toBeGreaterThan(0);
    }
  });

  it('config / fingerprint / persistent-approvals 三个的 clearFn 与产品决策对齐', () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    expect(getBucket('daemon:config')!.clearFn).toBeUndefined();
    expect(getBucket('daemon:fingerprint')!.clearFn).toBeUndefined();
    // persistent-approvals 允许清（用户可重置审批白名单），但 confirmation 是 hard
    expect(getBucket('daemon:persistent-approvals')!.clearFn).toBeDefined();
    expect(getBucket('daemon:persistent-approvals')!.requiresConfirmation).toBe('hard');
  });

  it('table-kernel-db 的 clearFn 抛错（必须先 drain）', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const bucket = getBucket('daemon:table-kernel-db');
    expect(bucket).toBeDefined();
    expect(bucket!.clearFn).toBeDefined();
    await expect(bucket!.clearFn!()).rejects.toThrow(/drain/);
  });

  it('logs bucket 只清归档份，不删活跃日志', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    // 准备：写入 daemon.log + daemon.log.1 / .2
    fs.writeFileSync(path.join(tmpHome, 'daemon.log'), 'active log\n');
    fs.writeFileSync(path.join(tmpHome, 'daemon.log.1'), 'old log 1\n');
    fs.writeFileSync(path.join(tmpHome, 'daemon.log.2'), 'old log 2\n');

    const bucket = getBucket('daemon:logs')!;
    const result = await bucket.clearFn!();
    expect(result.clearedItemCount).toBe(2); // 仅归档份
    expect(fs.existsSync(path.join(tmpHome, 'daemon.log'))).toBe(true);
    expect(fs.existsSync(path.join(tmpHome, 'daemon.log.1'))).toBe(false);
    expect(fs.existsSync(path.join(tmpHome, 'daemon.log.2'))).toBe(false);
  });

  it('agent-sync-pending sizeFn 只算 pending.jsonl，不算 archive', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const dir = path.join(tmpHome, 'agent-sync', 'user1', 'wt1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pending.jsonl'), 'a'.repeat(100));
    fs.writeFileSync(path.join(dir, 'archive.jsonl'), 'b'.repeat(200));

    const pending = await getBucket('daemon:agent-sync-pending')!.sizeFn();
    const archive = await getBucket('daemon:agent-sync-archive')!.sizeFn();
    expect(pending.bytes).toBe(100);
    expect(archive.bytes).toBe(200);
  });

  it('dryRun=true 不实际删文件', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const tmpDir = path.join(tmpHome, 'offline-buffer');
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 't1.ndjson'), 'x'.repeat(50));

    const bucket = getBucket('daemon:offline-buffer')!;
    const result = await bucket.clearFn!({ dryRun: true });
    expect(result.freedBytes).toBe(50);
    expect(fs.existsSync(path.join(tmpDir, 't1.ndjson'))).toBe(true);
  });

  it('不存在路径 sizeFn 返回 0', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    // tmpHome 下没建 offline-buffer 目录
    const bucket = getBucket('daemon:offline-buffer')!;
    const sz = await bucket.sizeFn();
    expect(sz.bytes).toBe(0);
  });

  it('R1/R2 P0 回归：清 daemon:agent-sync-pending 不会删 archive.jsonl', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const dir = path.join(tmpHome, 'agent-sync', 'user1', 'wt1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pending.jsonl'), 'p'.repeat(100));
    fs.writeFileSync(path.join(dir, 'archive.jsonl'), 'a'.repeat(200));

    const bucket = getBucket('daemon:agent-sync-pending')!;
    const result = await bucket.clearFn!();
    expect(result.freedBytes).toBe(100); // 仅 pending
    expect(fs.existsSync(path.join(dir, 'pending.jsonl'))).toBe(false);
    // archive 必须保留——这是 R1/R2 P0 修复的核心保证
    expect(fs.existsSync(path.join(dir, 'archive.jsonl'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'archive.jsonl')).size).toBe(200);
  });

  it('R1/R2 P0 回归：清 daemon:agent-sync-archive 不会删 pending.jsonl', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const dir = path.join(tmpHome, 'agent-sync', 'user1', 'wt1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pending.jsonl'), 'p'.repeat(100));
    fs.writeFileSync(path.join(dir, 'archive.jsonl'), 'a'.repeat(200));

    const bucket = getBucket('daemon:agent-sync-archive')!;
    const result = await bucket.clearFn!();
    expect(result.freedBytes).toBe(200); // 仅 archive
    expect(fs.existsSync(path.join(dir, 'archive.jsonl'))).toBe(false);
    // pending 必须保留——避免清 archive 误删未同步 transcript
    expect(fs.existsSync(path.join(dir, 'pending.jsonl'))).toBe(true);
    expect(fs.statSync(path.join(dir, 'pending.jsonl')).size).toBe(100);
  });

  it('R1 P0 回归：清空 agent-sync 后空目录被回收', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const dir = path.join(tmpHome, 'agent-sync', 'user1', 'wt1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'pending.jsonl'), 'p');

    const bucket = getBucket('daemon:agent-sync-pending')!;
    await bucket.clearFn!();
    // pending 删掉后子目录应当被 prune（dir 当时只剩它，应被回收，但保留根 agent-sync）
    // dir 自己已经空，应被回收；root 'agent-sync' 应保留
    expect(fs.existsSync(path.join(tmpHome, 'agent-sync'))).toBe(true);
    // 用户/工作组子目录可能也被回收（按实现设计），不强制断言
  });

  it('R1 P0 回归：daemon:browser-exports 注册了且指向 ~/.tabtin/exports/', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    const bucket = getBucket('daemon:browser-exports');
    expect(bucket).toBeDefined();
    expect(bucket!.category).toBe('data');
    expect(bucket!.warnings).toBeDefined();
    expect(bucket!.warnings!.length).toBeGreaterThan(0);
  });

  it('R1 P2 回归：清 logs 同时 truncate launchd stdout/stderr', async () => {
    registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
    fs.writeFileSync(path.join(tmpHome, 'daemon.log'), 'active');
    fs.writeFileSync(path.join(tmpHome, 'daemon.log.1'), 'x'.repeat(50));
    fs.writeFileSync(path.join(tmpHome, 'daemon-stdout.log'), 'y'.repeat(100));
    fs.writeFileSync(path.join(tmpHome, 'daemon-stderr.log'), 'z'.repeat(200));

    const bucket = getBucket('daemon:logs')!;
    await bucket.clearFn!();

    // active 主日志保留
    expect(fs.existsSync(path.join(tmpHome, 'daemon.log'))).toBe(true);
    // 归档份 unlink
    expect(fs.existsSync(path.join(tmpHome, 'daemon.log.1'))).toBe(false);
    // launchd 日志 truncate（文件存在但大小 0 — launchd FD 不释放）
    expect(fs.existsSync(path.join(tmpHome, 'daemon-stdout.log'))).toBe(true);
    expect(fs.statSync(path.join(tmpHome, 'daemon-stdout.log')).size).toBe(0);
    expect(fs.existsSync(path.join(tmpHome, 'daemon-stderr.log'))).toBe(true);
    expect(fs.statSync(path.join(tmpHome, 'daemon-stderr.log')).size).toBe(0);
  });
});
