/**
 * W2.3 — `cli/routes/storage.ts` 路由测试。
 *
 * 不起真实 HTTP server——直接调路由 handler 函数 + mock res/sendJSON。
 * 这跟其他 daemon 路由测试风格一致（避免引入 supertest 等依赖）。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// （os 已用于 tmpdir 与 R3 P0 测试 home 校验）
import {
  __resetForTesting,
  registerStorageBucket,
  type ClearResult,
} from '@tabtin/storage-manager';
import { handleStorageRoute as handleStorageRouteWithApplication } from '../src/transport/cli/routes/storage/index.js';
import { createDaemonStorageApplication } from '../src/application/storage/daemon-storage.js';
import { NodeStorageFileSystem } from '../src/platform/storage/node-storage-file-system.js';
import {
  DAEMON_BUCKET_IDS,
  registerDaemonStorageBuckets,
} from '../src/platform/storage/storage-bucket-registration.js';

let tmpHome: string;

const sendJSON = vi.fn();
const res = {} as unknown as import('node:http').ServerResponse;
const storageApplication = createDaemonStorageApplication(new NodeStorageFileSystem());
const handleStorageRoute = (
  ...args: Parameters<typeof handleStorageRouteWithApplication> extends [...infer Head, unknown] ? Head : never
) => handleStorageRouteWithApplication(...args, storageApplication);

function lastResponse(): { status: number; body: any } {
  expect(sendJSON).toHaveBeenCalled();
  const calls = sendJSON.mock.calls;
  const [, status, body] = calls[calls.length - 1];
  return { status, body };
}

async function withoutDaemonDiscovery<T>(run: () => Promise<T>): Promise<T> {
  const discoveryPath = path.join(os.homedir(), '.tabtin', 'daemon-server.json');
  const backup = fs.existsSync(discoveryPath) ? fs.readFileSync(discoveryPath, 'utf-8') : null;
  try {
    try { fs.unlinkSync(discoveryPath); } catch { /* already absent */ }
    return await run();
  } finally {
    if (backup !== null) fs.writeFileSync(discoveryPath, backup);
  }
}

beforeEach(() => {
  __resetForTesting();
  // R3 P0 修复：daemon_home 路径需在用户 home 子树下且名字含 .tabtin-daemon
  // 才能通过 storage 路由的白名单。tmp 目录放到 home 下满足该约束。
  tmpHome = fs.mkdtempSync(path.join(os.homedir(), '.tabtin-daemon-test-'));
  sendJSON.mockReset();
});

afterEach(() => {
  __resetForTesting();
  try {
    fs.rmSync(tmpHome, { recursive: true, force: true });
  } catch {
    /* best effort */
  }
});

describe('handleStorageRoute', () => {
  describe('/storage/list', () => {
    it('返回所有 daemon: 前缀的 bucket descriptor', async () => {
      registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });

      await handleStorageRoute('/storage/list', 'POST', {}, res, sendJSON);
      const r = lastResponse();
      expect(r.status).toBe(200);
      expect(r.body.ok).toBe(true);
      // R1 P0 修复后：14 个 bucket（含补充的 daemon:browser-exports）
      expect(r.body.data.count).toBe(14);
      const ids = r.body.data.buckets.map((b: any) => b.id).sort();
      expect(ids).toEqual([...DAEMON_BUCKET_IDS].sort());
      // 每个 descriptor 都打了 source: 'daemon'
      for (const b of r.body.data.buckets) {
        expect(b.source).toBe('daemon');
      }
    });

    it('支持按 category 过滤', async () => {
      registerDaemonStorageBuckets({ daemonHomeDir: tmpHome });
      await handleStorageRoute(
        '/storage/list',
        'POST',
        { filter: { category: 'cache' } },
        res,
        sendJSON,
      );
      const r = lastResponse();
      // RFC §五 W2.3 表里 cache 类只有 daemon:tmp 一个
      expect(r.body.data.buckets.map((b: any) => b.id)).toEqual(['daemon:tmp']);
    });

    it('非 POST 方法返回 405', async () => {
      await handleStorageRoute('/storage/list', 'GET', {}, res, sendJSON);
      expect(lastResponse().status).toBe(405);
    });
  });

  describe('/storage/size', () => {
    it('单 bucket 模式', async () => {
      registerStorageBucket({
        id: 'test:simple',
        category: 'cache',
        group: 'cache',
        displayName: '测试',
        description: '测试',
        sizeFn: async () => ({ bytes: 1024, itemCount: 5 }),
      });
      await handleStorageRoute(
        '/storage/size',
        'POST',
        { bucket: 'test:simple' },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        id: 'test:simple',
        bytes: 1024,
        itemCount: 5,
      });
    });

    it('全量模式：含错误的 bucket 不影响其他', async () => {
      registerStorageBucket({
        id: 'test:ok',
        category: 'cache',
        group: 'cache',
        displayName: 'ok',
        description: 'ok',
        sizeFn: async () => ({ bytes: 100 }),
      });
      registerStorageBucket({
        id: 'test:bad',
        category: 'cache',
        group: 'cache',
        displayName: 'bad',
        description: 'bad',
        sizeFn: async () => {
          throw new Error('intentional');
        },
      });

      await handleStorageRoute('/storage/size', 'POST', {}, res, sendJSON);
      const r = lastResponse();
      expect(r.status).toBe(200);
      const sizes = r.body.data.sizes as any[];
      const ok = sizes.find((s) => s.id === 'test:ok');
      const bad = sizes.find((s) => s.id === 'test:bad');
      expect(ok.bytes).toBe(100);
      expect(bad.error).toContain('intentional');
      expect(r.body.data.totalBytes).toBe(100);
    });

    it('未知 bucket 返回 404', async () => {
      await handleStorageRoute(
        '/storage/size',
        'POST',
        { bucket: 'nonexistent' },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(404);
    });
  });

  describe('/storage/list-items', () => {
    it('未实现 listFn 返回 NOT_IMPLEMENTED', async () => {
      registerStorageBucket({
        id: 'test:no-list',
        category: 'cache',
        group: 'cache',
        displayName: 'x',
        description: 'x',
        sizeFn: async () => ({ bytes: 0 }),
      });
      await handleStorageRoute(
        '/storage/list-items',
        'POST',
        { bucket: 'test:no-list' },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
      expect(lastResponse().body.error.code).toBe('NOT_IMPLEMENTED');
    });

    it('正常返回 items', async () => {
      registerStorageBucket({
        id: 'test:list-ok',
        category: 'cache',
        group: 'cache',
        displayName: 'x',
        description: 'x',
        sizeFn: async () => ({ bytes: 0 }),
        listFn: async () => [{ id: 'a', label: 'A', bytes: 10 }],
      });
      await handleStorageRoute(
        '/storage/list-items',
        'POST',
        { bucket: 'test:list-ok' },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(200);
      expect(r.body.data.items).toEqual([{ id: 'a', label: 'A', bytes: 10 }]);
    });
  });

  describe('/storage/clear', () => {
    it('单 bucket 清理成功', async () => {
      const clearFn = vi.fn(
        async (): Promise<ClearResult> => ({
          clearedItemCount: 3,
          freedBytes: 1024,
        }),
      );
      registerStorageBucket({
        id: 'test:clear',
        category: 'cache',
        group: 'cache',
        displayName: 'x',
        description: 'x',
        sizeFn: async () => ({ bytes: 1024 }),
        clearFn,
      });
      await handleStorageRoute(
        '/storage/clear',
        'POST',
        { bucket: 'test:clear', options: { dryRun: true } },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(200);
      expect(r.body.data.dryRun).toBe(true);
      expect(r.body.data.clearedItemCount).toBe(3);
      expect(clearFn).toHaveBeenCalledWith({ dryRun: true });
    });

    it('bucket clearFn 抛错 → 400', async () => {
      registerStorageBucket({
        id: 'test:clear-err',
        category: 'data',
        group: 'system',
        displayName: 'x',
        description: 'x',
        warnings: ['warn'],
        sizeFn: async () => ({ bytes: 0 }),
        clearFn: async () => {
          throw new Error('drain first');
        },
      });
      await handleStorageRoute(
        '/storage/clear',
        'POST',
        { bucket: 'test:clear-err' },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(400);
      expect(r.body.error.message).toContain('drain first');
    });

    it('整 category 模式：跳过未实现 clearFn 的 bucket', async () => {
      registerStorageBucket({
        id: 'test:cache-1',
        category: 'cache',
        group: 'cache',
        displayName: 'x',
        description: 'x',
        sizeFn: async () => ({ bytes: 0 }),
        clearFn: async () => ({ clearedItemCount: 1, freedBytes: 100 }),
      });
      registerStorageBucket({
        id: 'test:cache-2',
        category: 'cache',
        group: 'cache',
        displayName: 'y',
        description: 'y',
        sizeFn: async () => ({ bytes: 0 }),
        // 没有 clearFn
      });
      await handleStorageRoute(
        '/storage/clear',
        'POST',
        { category: 'cache' },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(200);
      const reports = r.body.data.reports as any[];
      const c1 = reports.find((x) => x.id === 'test:cache-1');
      const c2 = reports.find((x) => x.id === 'test:cache-2');
      expect(c1.cleared).toBe(true);
      expect(c2.cleared).toBe(false);
      expect(c2.skipped).toBe('no-clear-fn');
    });

    it('bucket 与 category 同传 → 400', async () => {
      await handleStorageRoute(
        '/storage/clear',
        'POST',
        { bucket: 'x', category: 'cache' },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
    });
  });

  describe('/storage/export', () => {
    it('未实现 exportFn 返回 NOT_IMPLEMENTED', async () => {
      registerStorageBucket({
        id: 'test:no-export',
        category: 'cache',
        group: 'cache',
        displayName: 'x',
        description: 'x',
        sizeFn: async () => ({ bytes: 0 }),
      });
      await handleStorageRoute(
        '/storage/export',
        'POST',
        { bucket: 'test:no-export' },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
    });

    it('正常 export 字符串 payload', async () => {
      registerStorageBucket({
        id: 'test:export-ok',
        category: 'data',
        group: 'system',
        displayName: 'x',
        description: 'x',
        warnings: ['warn'],
        sizeFn: async () => ({ bytes: 0 }),
        exportFn: async () => ({
          filename: 'test.json',
          data: '{"hello":"world"}',
          mimeType: 'application/json',
        }),
      });
      await handleStorageRoute(
        '/storage/export',
        'POST',
        { bucket: 'test:export-ok' },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(200);
      expect(r.body.data).toMatchObject({
        filename: 'test.json',
        data: '{"hello":"world"}',
        encoding: 'utf-8',
        mimeType: 'application/json',
      });
    });

    it('Uint8Array payload 走 base64 编码', async () => {
      const bytes = new Uint8Array([1, 2, 3, 4, 5]);
      registerStorageBucket({
        id: 'test:export-bin',
        category: 'data',
        group: 'system',
        displayName: 'x',
        description: 'x',
        warnings: ['warn'],
        sizeFn: async () => ({ bytes: 5 }),
        exportFn: async () => ({
          filename: 'b.bin',
          data: bytes,
          mimeType: 'application/octet-stream',
        }),
      });
      await handleStorageRoute(
        '/storage/export',
        'POST',
        { bucket: 'test:export-bin' },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(200);
      expect(r.body.data.encoding).toBe('base64');
      expect(Buffer.from(r.body.data.data, 'base64').toString('hex')).toBe(
        '0102030405',
      );
    });
  });

  describe('/storage/vacuum', () => {
    it('R3 P0 回归：按 persistent-queue-file 真实字段名 __archived_at__ 老化', async () => {
      // **关键回归**：persistent-queue-file.ts:156 写的是 `__archived_at__`
      // 而不是 `archived_at`。旧代码读错字段→所有行 ts=0→全部清空。
      const agentSyncDir = path.join(tmpHome, 'agent-sync', 'u1', 'wt1');
      fs.mkdirSync(agentSyncDir, { recursive: true });
      const recent = Date.now() - 1 * 24 * 60 * 60 * 1000;
      const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
      const lines = [
        JSON.stringify({ __archived_at__: recent, __archive_reason__: 'ttl', msg: 'keep' }),
        JSON.stringify({ __archived_at__: old, msg: 'remove' }),
        JSON.stringify({ __archived_at__: old, msg: 'remove2' }),
      ];
      fs.writeFileSync(
        path.join(agentSyncDir, 'archive.jsonl'),
        lines.join('\n') + '\n',
      );

      await handleStorageRoute(
        '/storage/vacuum',
        'POST',
        { agentSync: true, retainDays: 90, daemon_home: tmpHome },
        res,
        sendJSON,
      );
      const r = lastResponse();
      expect(r.status).toBe(200);
      expect(r.body.data.scannedFiles).toBe(1);
      expect(r.body.data.totalLines).toBe(3);
      expect(r.body.data.removedLines).toBe(2);

      const remaining = fs
        .readFileSync(path.join(agentSyncDir, 'archive.jsonl'), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      expect(remaining).toHaveLength(1);
      expect(remaining[0]).toContain('keep');
    });

    it('R3 P0 回归：解析失败 / 缺字段的行被保留（旧逻辑会误清）', async () => {
      const agentSyncDir = path.join(tmpHome, 'agent-sync', 'u1', 'wt1');
      fs.mkdirSync(agentSyncDir, { recursive: true });
      const lines = [
        '<<not json at all>>',
        JSON.stringify({ no_archived_at: 'present', body: 'mystery' }),
        JSON.stringify({ __archived_at__: Date.now() - 100 * 24 * 60 * 60 * 1000, msg: 'old' }),
      ];
      fs.writeFileSync(path.join(agentSyncDir, 'archive.jsonl'), lines.join('\n') + '\n');

      await handleStorageRoute(
        '/storage/vacuum',
        'POST',
        { agentSync: true, retainDays: 90, daemon_home: tmpHome },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(200);
      // 损坏行 + 缺字段行都应保留，仅老化的 1 行被清
      expect(lastResponse().body.data.removedLines).toBe(1);
      const remaining = fs
        .readFileSync(path.join(agentSyncDir, 'archive.jsonl'), 'utf-8')
        .split('\n')
        .filter((l) => l.length > 0);
      expect(remaining).toHaveLength(2);
    });

    it('支持兼容旧字段名 archived_at（迁移友好）', async () => {
      const agentSyncDir = path.join(tmpHome, 'agent-sync', 'u1', 'wt1');
      fs.mkdirSync(agentSyncDir, { recursive: true });
      const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
      const lines = [JSON.stringify({ archived_at: old, msg: 'legacy-old' })];
      fs.writeFileSync(path.join(agentSyncDir, 'archive.jsonl'), lines.join('\n') + '\n');

      await handleStorageRoute(
        '/storage/vacuum',
        'POST',
        { agentSync: true, retainDays: 90, daemon_home: tmpHome },
        res,
        sendJSON,
      );
      expect(lastResponse().body.data.removedLines).toBe(1);
    });

    it('dryRun=true 不实际改文件', async () => {
      const agentSyncDir = path.join(tmpHome, 'agent-sync', 'u1', 'wt1');
      fs.mkdirSync(agentSyncDir, { recursive: true });
      const old = Date.now() - 100 * 24 * 60 * 60 * 1000;
      const original = JSON.stringify({ archived_at: old, msg: 'remove' }) + '\n';
      fs.writeFileSync(path.join(agentSyncDir, 'archive.jsonl'), original);

      await handleStorageRoute(
        '/storage/vacuum',
        'POST',
        { agentSync: true, retainDays: 90, dryRun: true, daemon_home: tmpHome },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(200);
      const after = fs.readFileSync(
        path.join(agentSyncDir, 'archive.jsonl'),
        'utf-8',
      );
      expect(after).toBe(original);
    });

    it('agentSync=false 暂不支持 → 400', async () => {
      await handleStorageRoute(
        '/storage/vacuum',
        'POST',
        { agentSync: false },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
    });
  });

  describe('/storage/drain', () => {
    it('state.json 不存在 → 503', async () => {
      // 用允许 daemon_home 路径但 state.json 不存在，确保 503 分支
      const allowed = path.join(os.homedir(), `.tabtin-daemon-503-test-${process.pid}`);
      fs.mkdirSync(allowed, { recursive: true });
      try {
        await handleStorageRoute(
          '/storage/drain',
          'POST',
          { observeOnly: true, daemon_home: allowed },
          res,
          sendJSON,
        );
        expect(lastResponse().status).toBe(503);
      } finally {
        fs.rmSync(allowed, { recursive: true, force: true });
      }
    });

    it('observeOnly 模式：active=0 时返回 complete=true，含 R2 P0 _warning 字段', async () => {
      // tmpHome 在 /tmp/，drain 路由不调 resolveDaemonHome 的强校验？
      // ——drain 路由确实校验 daemon_home，所以这里改用允许的路径
      const allowed = path.join(os.homedir(), `.tabtin-daemon-drain-test-${process.pid}`);
      fs.mkdirSync(allowed, { recursive: true });
      try {
        fs.writeFileSync(
          path.join(allowed, 'state.json'),
          JSON.stringify({ active_actions: 0, offline_buffer_pending: 0 }),
        );
        await handleStorageRoute(
          '/storage/drain',
          'POST',
          { observeOnly: true, daemon_home: allowed },
          res,
          sendJSON,
        );
        const r = lastResponse();
        expect(r.status).toBe(200);
        expect(r.body.data.complete).toBe(true);
        expect(r.body.data.observeOnly).toBe(true);
        // R2 P0 修复：必须含 _warning 字段告知调用方语义边界
        expect(r.body.data._warning).toBeDefined();
        expect(r.body.data._warning).toMatch(/outbox|table-kernel-db/);
      } finally {
        fs.rmSync(allowed, { recursive: true, force: true });
      }
    });

    it('R3 P0 回归：drain 路由也校验 daemon_home 白名单', async () => {
      await handleStorageRoute(
        '/storage/drain',
        'POST',
        { observeOnly: true, daemon_home: '/tmp/attack' },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
    });

    it('R3 R2 回归：阻塞 drain 在 timeout 内返回 timeout: true', async () => {
      const allowed = path.join(os.homedir(), `.tabtin-daemon-drain-timeout-${process.pid}`);
      fs.mkdirSync(allowed, { recursive: true });
      try {
        // 写一个永远不归 0 的 state.json，让 drain 路由轮询到 timeout
        fs.writeFileSync(
          path.join(allowed, 'state.json'),
          JSON.stringify({ active_actions: 5, offline_buffer_pending: 3 }),
        );
        await handleStorageRoute(
          '/storage/drain',
          'POST',
          { timeoutMs: 1500, daemon_home: allowed }, // 1.5 秒超时，足够轮询 1 次
          res,
          sendJSON,
        );
        const r = lastResponse();
        expect(r.status).toBe(200);
        expect(r.body.data.complete).toBe(false);
        expect(r.body.data.timeout).toBe(true);
        expect(r.body.data.activeActions).toBe(5);
        expect(r.body.data._warning).toBeDefined();
      } finally {
        fs.rmSync(allowed, { recursive: true, force: true });
      }
    }, 8000);
  });

  describe('/storage/purge', () => {
    it('未传 confirm → 400', async () => {
      await handleStorageRoute(
        '/storage/purge',
        'POST',
        { daemon_home: tmpHome },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
    });

    it('R3 P0 回归：daemon_home 指向用户 home 之外 / 未含 .tabtin → 400', async () => {
      // tmpHome 形如 /tmp/daemon-storage-route-XXXX，不在 home 子树下，必须拒绝
      await handleStorageRoute(
        '/storage/purge',
        'POST',
        { confirm: 'yes-i-am-sure', daemon_home: '/tmp/some-attack' },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
      expect(lastResponse().body.error.message).toMatch(/tabtin|home/i);
    });

    it('R3 P0 回归：daemon_home 在 home 但不含 .tabtin → 400', async () => {
      const fakeDaemon = path.join(os.homedir(), 'Documents', 'fake-attack');
      await handleStorageRoute(
        '/storage/purge',
        'POST',
        { confirm: 'yes-i-am-sure', daemon_home: fakeDaemon },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
    });

    it('R3 Round 2 P1 回归：daemon_home 严格匹配 .tabtin-daemon[-suffix]——.tabtin-foo 等过宽命名 → 400', async () => {
      const fake = path.join(os.homedir(), '.tabtin-foo');
      await handleStorageRoute(
        '/storage/purge',
        'POST',
        { confirm: 'yes-i-am-sure', daemon_home: fake },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
      expect(lastResponse().body.error.message).toMatch(/严格匹配|.tabtin-daemon/);
    });

    it('R3 Round 2 P1 回归：daemon_home 显式拒绝共享根 ~/.tabtin', async () => {
      const sharedRoot = path.join(os.homedir(), '.tabtin');
      await handleStorageRoute(
        '/storage/purge',
        'POST',
        { confirm: 'yes-i-am-sure', daemon_home: sharedRoot },
        res,
        sendJSON,
      );
      expect(lastResponse().status).toBe(400);
      expect(lastResponse().body.error.message).toMatch(/共享根|Electron/);
    });

    it('R3 Round 2 P2 回归：daemon 在跑（discovery 文件 + alive pid）时 purge 返回 409', async () => {
      // 模拟"daemon 在跑"：写一个指向父进程 pid 的 daemon-server.json
      // （父进程一定 alive 且 != process.pid，避开 storage.ts 里 "skip if pid===process.pid" 的自我保护逻辑）
      const allowed = path.join(os.homedir(), `.tabtin-daemon-purge-conflict-${process.pid}`);
      fs.mkdirSync(allowed, { recursive: true });
      const sharedRoot = path.join(os.homedir(), '.tabtin');
      fs.mkdirSync(sharedRoot, { recursive: true });
      const discoveryPath = path.join(sharedRoot, 'daemon-server.json');
      const backup = fs.existsSync(discoveryPath)
        ? fs.readFileSync(discoveryPath, 'utf-8')
        : null;
      const fakePid = process.ppid;
      try {
        fs.writeFileSync(
          discoveryPath,
          JSON.stringify({ pid: fakePid, sock: '/tmp/x', token: 't' }),
        );
        await handleStorageRoute(
          '/storage/purge',
          'POST',
          {
            confirm: 'yes-i-am-sure',
            deleteHomeDir: true,
            daemon_home: allowed,
          },
          res,
          sendJSON,
        );
        expect(lastResponse().status).toBe(409);
        expect(lastResponse().body.error.code).toBe('CONFLICT');
      } finally {
        if (backup !== null) fs.writeFileSync(discoveryPath, backup);
        else try { fs.unlinkSync(discoveryPath); } catch { /* ignore */ }
        fs.rmSync(allowed, { recursive: true, force: true });
      }
    });

    it('R3 P0 回归：daemon_home 在 home 且名字含 .tabtin-daemon → 通过白名单', async () => {
      // 用户 home 下做一个测试目录命名带 .tabtin-daemon 后缀
      const allowed = path.join(os.homedir(), `.tabtin-daemon-test-${process.pid}`);
      fs.mkdirSync(allowed, { recursive: true });
      try {
        await withoutDaemonDiscovery(() => handleStorageRoute(
          '/storage/purge', 'POST', {
            confirm: 'yes-i-am-sure', deleteHomeDir: true, daemon_home: allowed,
          }, res, sendJSON,
        ));
        expect(lastResponse().status).toBe(200);
        // 目录被删
        expect(fs.existsSync(allowed)).toBe(false);
      } finally {
        try {
          fs.rmSync(allowed, { recursive: true, force: true });
        } catch { /* ignore */ }
      }
    });

    it('confirm + deleteHomeDir=false 只删数据子目录', async () => {
      // 准备
      fs.writeFileSync(path.join(tmpHome, 'config.json'), '{}');
      fs.mkdirSync(path.join(tmpHome, 'agent-sync'), { recursive: true });
      fs.mkdirSync(path.join(tmpHome, 'offline-buffer'), { recursive: true });
      fs.mkdirSync(path.join(tmpHome, 'table-kernel-db'), { recursive: true });

      await withoutDaemonDiscovery(() => handleStorageRoute(
        '/storage/purge',
        'POST',
        {
          confirm: 'yes-i-am-sure',
          deleteHomeDir: false,
          daemon_home: tmpHome,
        },
        res,
        sendJSON,
      ));
      const r = lastResponse();
      expect(r.status).toBe(200);
      // config.json 保留
      expect(fs.existsSync(path.join(tmpHome, 'config.json'))).toBe(true);
      // 数据子目录被删
      expect(fs.existsSync(path.join(tmpHome, 'agent-sync'))).toBe(false);
      expect(fs.existsSync(path.join(tmpHome, 'offline-buffer'))).toBe(false);
      expect(fs.existsSync(path.join(tmpHome, 'table-kernel-db'))).toBe(false);
    });

    it('confirm + deleteHomeDir=true 删整个 home 目录', async () => {
      fs.writeFileSync(path.join(tmpHome, 'config.json'), '{}');
      await withoutDaemonDiscovery(() => handleStorageRoute(
        '/storage/purge',
        'POST',
        {
          confirm: 'yes-i-am-sure',
          deleteHomeDir: true,
          daemon_home: tmpHome,
        },
        res,
        sendJSON,
      ));
      expect(lastResponse().status).toBe(200);
      expect(fs.existsSync(tmpHome)).toBe(false);
    });
  });

  describe('未知子路由', () => {
    it('返回 404 + 提示可用子命令', async () => {
      await handleStorageRoute('/storage/foo', 'POST', {}, res, sendJSON);
      const r = lastResponse();
      expect(r.status).toBe(404);
      expect(r.body.error.code).toBe('UNKNOWN_ROUTE');
      expect(r.body.error.suggestions[0]).toContain('list');
    });
  });
});
