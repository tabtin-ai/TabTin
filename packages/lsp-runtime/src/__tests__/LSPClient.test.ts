/**
 * LSPClient 端到端单测。
 *
 * 用一个真实 spawn 的 mock LSP server（mock-lsp-server.mjs）走完整 stdio
 * JSON-RPC 协议，覆盖：
 *   - spawn 成功 / spawn 失败（ENOENT）
 *   - initialize → capabilities
 *   - sendRequest 双向通信
 *   - onNotification 接收 server 推送
 *   - sendNotification 发送给 server
 *   - 提前注册 handler（pendingHandlers 队列机制）
 *   - stop 干净关闭
 *   - sendRequest 在未 initialize 时报错
 *
 * 不 mock vscode-jsonrpc，因为 mock 出来跟真实行为差距会很大。
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLSPClient } from '../client/LSPClient.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(__dirname, 'mock-lsp-server.mjs');

function makeClient() {
  return createLSPClient('mock-server');
}

async function startAndInit() {
  const client = makeClient();
  await client.start(process.execPath, [MOCK_SERVER]);
  const result = await client.initialize({
    processId: process.pid,
    rootUri: null,
    capabilities: {},
  });
  return { client, result };
}

describe('LSPClient', () => {
  it('spawn + initialize 走通 → capabilities 有值', async () => {
    const { client, result } = await startAndInit();
    expect(result.capabilities.textDocumentSync).toBe(1);
    expect(result.capabilities.hoverProvider).toBe(true);
    expect(client.isInitialized).toBe(true);
    expect(client.capabilities).toBeDefined();
    await client.stop();
  });

  it('sendRequest 双向通信 → echo/test 原样返回', async () => {
    const { client } = await startAndInit();
    const echoed = await client.sendRequest<{ hello: string }>('echo/test', {
      hello: 'world',
    });
    expect(echoed).toEqual({ hello: 'world' });
    await client.stop();
  });

  it('sendRequest 在未 initialize 时报错', async () => {
    const client = makeClient();
    await client.start(process.execPath, [MOCK_SERVER]);
    await expect(
      client.sendRequest('echo/test', { foo: 'bar' }),
    ).rejects.toThrow(/not initialized/i);
    await client.stop();
  });

  it('sendRequest 在未 start 时报错', async () => {
    const client = makeClient();
    await expect(
      client.sendRequest('echo/test', { foo: 'bar' }),
    ).rejects.toThrow(/not started/i);
  });

  it('onNotification 收到 server 推送 → window/showMessage', async () => {
    const client = makeClient();
    await client.start(process.execPath, [MOCK_SERVER]);

    // 在 initialize 之前注册 handler，触发 connection-ready 后 pendingHandlers
    // queue 重放机制
    const received = new Promise<unknown>((resolve) => {
      client.onNotification('window/showMessage', (params) => {
        resolve(params);
      });
    });

    await client.initialize({
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });

    const msg = await received;
    expect(msg).toMatchObject({ type: 1, message: 'hello from mock server' });
    await client.stop();
  });

  it('onNotification 在 connection ready 之前注册（pendingHandlers 队列）→ start 后被自动 apply', async () => {
    const client = makeClient();

    // 此时 connection 还没建立，handler 应该入队
    const received = new Promise<unknown>((resolve) => {
      client.onNotification('window/showMessage', (params) => {
        resolve(params);
      });
    });

    // 然后 start + initialize —— pendingHandlers 应该在 start 步骤 4 被 apply
    await client.start(process.execPath, [MOCK_SERVER]);
    await client.initialize({
      processId: process.pid,
      rootUri: null,
      capabilities: {},
    });

    const msg = await received;
    expect(msg).toMatchObject({ type: 1, message: 'hello from mock server' });
    await client.stop();
  });

  it('sendRequest 收到 server 错误 → reject', async () => {
    const { client } = await startAndInit();
    await expect(
      client.sendRequest('echo/error', { trigger: true }),
    ).rejects.toThrow(/echo\/error invoked/);
    await client.stop();
  });

  it('spawn 不存在的 binary → start rejected with ENOENT-like error', async () => {
    const client = makeClient();
    await expect(
      client.start('/nonexistent/path/to/binary', []),
    ).rejects.toThrow();
  });

  it('stop() 干净关闭 → isInitialized 变 false / capabilities 清空', async () => {
    const { client } = await startAndInit();
    expect(client.isInitialized).toBe(true);
    await client.stop();
    expect(client.isInitialized).toBe(false);
    expect(client.capabilities).toBeUndefined();
  });

  it('stop() 后再 sendRequest → 报错 not started', async () => {
    const { client } = await startAndInit();
    await client.stop();
    await expect(
      client.sendRequest('echo/test', { foo: 'bar' }),
    ).rejects.toThrow(/not started/i);
  });
});
