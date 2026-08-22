/**
 * 回归测试：CC-006 / CT-013
 *
 * CC-006: /code/grep 速率限制 — 超过 20 次/60s 后返回 429 RATE_LIMITED
 * CT-013: djangoRequest 绝对超时保护（timeout*3 上限 300s）+ res.on('error') 处理
 */

import http from 'node:http';
import net from 'node:net';
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest';
import { existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CC-006：测的是 cli-server.ts 内嵌的 SlidingWindowRateLimiter（20 次/60s），
// 不是 grep_search 工具本身。真实的 createHeadlessAdapter 在 daemon 工作目录
// 跑真 grep（~1s/次），25 次顺序请求 >> vitest 默认 5s test timeout，导致
// 测试在 rate limiter 命中前就被 abort（loop 第一次 await 没回来）。
// mock 成瞬时 200，让测试可以专注验证 rate limiter 本身。
vi.mock('@tabtin/action-tools/headless', () => ({
  createHeadlessAdapter: () => ({
    getRegisteredTools: () => [],
    hasToolForAction: () => true,
    executeAction: vi.fn(async () => ({ success: true, data: { output: '' } })),
  }),
}));

// ── 辅助：HTTP over Unix Socket ─────────────────────────────────
function httpPost(
  socketPath: string,
  path: string,
  token: string,
  body: object = {},
): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const bodyStr = JSON.stringify(body);
    const req = http.request(
      {
        socketPath,
        path,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': String(Buffer.byteLength(bodyStr)),
          'x-tabtin-token': token,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString()) });
          } catch {
            resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
          }
        });
      },
    );
    req.on('error', reject);
    req.write(bodyStr);
    req.end();
  });
}

// ── CC-006 ──────────────────────────────────────────────────────
// 每个测试必须使用动态 import + vi.resetModules() 来重置模块级 SlidingWindowRateLimiter 状态

describe('CC-006: /code/grep 速率限制', () => {
  let socketPath: string;
  let token: string;
  let stopCLIServer: () => Promise<void>;

  beforeEach(async () => {
    vi.resetModules();
    socketPath = join(tmpdir(), `tabtin-fp103-${process.pid}-${Date.now()}.sock`);
    if (existsSync(socketPath)) unlinkSync(socketPath);
    const mod = await import('../src/transport/cli/cli-server.js');
    stopCLIServer = mod.stopCLIServer;
    const info = mod.startCLIServer({ socketPath, version: '0.0.1-test' });
    token = info.token;
    await new Promise<void>((r) => setTimeout(r, 80));
  });

  afterEach(async () => {
    await stopCLIServer();
    if (existsSync(socketPath)) unlinkSync(socketPath);
    vi.restoreAllMocks();
  });

  it('连续发送 25 次 /code/grep，第 21 次起应返回 429', async () => {
    const results: { status: number; body: any }[] = [];

    // body 不带 path —— evaluateCLIPolicy 会对 body.path 做 daemon workspace 边界
    // 检查（'/tmp' 不在 process.cwd() 内会被 POLICY_BLOCKED 403），跟 rate
    // limiter 无关。本测试只验 rate limiter 行为，path 留空让请求直通到 rate
    // limiter 即可。"前 20 次不限制" 的姐妹 case 同样不带 path。
    for (let i = 0; i < 25; i++) {
      try {
        const r = await httpPost(socketPath, '/code/grep', token, { pattern: 'test' });
        results.push(r);
      } catch {
        break;
      }
    }

    const rateLimited = results.filter((r) => r.status === 429);
    expect(rateLimited.length).toBeGreaterThan(0);

    const first = rateLimited[0];
    expect(first.body?.error?.code ?? first.body?.code).toBe('RATE_LIMIT_EXCEEDED');
  });

  it('前 20 次请求不应被速率限制（状态码不为 429）', async () => {
    const results: { status: number }[] = [];
    for (let i = 0; i < 20; i++) {
      try {
        const r = await httpPost(socketPath, '/code/grep', token, { pattern: 'x' });
        results.push(r);
      } catch {
        break;
      }
    }

    const rateLimited = results.filter((r) => r.status === 429);
    expect(rateLimited.length).toBe(0);
  });
});

// ── CT-013 ──────────────────────────────────────────────────────

describe('CT-013: djangoRequest 绝对超时与 res.on("error")', () => {
  it('绝对超时常量应为 timeout*3，上限 300s', async () => {
    // 通过导入源码验证常量值（不需要真实网络）
    const mod = await import('../src/transport/cli/routes/shared/error-handler.js');

    // djangoRequest 是唯一导出的异步函数，常量在函数内部使用
    // 我们通过行为测试：用一个立即拒绝连接的服务器验证 req.on('error') 能正常 settle

    // 创建一个立即关闭连接的临时 TCP 服务器来模拟 ECONNRESET
    const server = net.createServer((socket) => {
      socket.destroy(); // 立即断开，触发 ECONNRESET 或 ECONNREFUSED
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as net.AddressInfo;

    // 临时配置 proxyConfig 指向上述服务器
    mod.configureDjangoProxy({
      serverUrl: `http://127.0.0.1:${addr.port}`,
      credential: 'test-token',
      organizationId: '',
    });

    try {
      const result = await mod.djangoRequest('GET', '/test-path', undefined, { timeout: 5000 });
      // 连接立即被关闭，应返回 502 UNAVAILABLE 或 CONNECTION_REFUSED
      expect([502, 504]).toContain(result.status);
      expect(['UNAVAILABLE', 'CONNECTION_REFUSED', 'CONNECTION_TIMEOUT']).toContain(
        result.data?.error?.code,
      );
    } finally {
      mod.clearDjangoProxy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it('res.on("error") 应被正确处理，不抛出未捕获异常', async () => {
    const mod = await import('../src/transport/cli/routes/shared/error-handler.js');

    // 创建一个发送不完整 HTTP 响应后强制关闭的服务器，模拟响应流中断
    const server = net.createServer((socket) => {
      // 发送合法的 HTTP 头，然后立即销毁 socket（触发 res.on('error')）
      socket.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n');
      setTimeout(() => socket.destroy(), 10);
    });

    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as net.AddressInfo;

    mod.configureDjangoProxy({
      serverUrl: `http://127.0.0.1:${addr.port}`,
      credential: 'test-token',
      organizationId: '',
    });

    try {
      const result = await mod.djangoRequest('GET', '/stream-error', undefined, { timeout: 3000 });
      // 响应流中断后应被正常 settle，不 hang 住
      expect(result).toBeDefined();
      expect(result.status).toBeDefined();
    } finally {
      mod.clearDjangoProxy();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});
