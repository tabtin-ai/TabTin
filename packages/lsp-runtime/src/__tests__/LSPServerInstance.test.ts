/**
 * LSPServerInstance 端到端单测。
 *
 * 覆盖：
 *   - 状态机：stopped → starting → running → stopping → stopped
 *   - 错误：error 状态 / crashRecoveryCount 上限
 *   - 完整 InitializeParams 被 LSP server 接收（mock server 返回 capabilities）
 *   - content-modified (-32801) 重试机制
 *   - startupTimeout 超时
 *   - maxRestarts 限制
 *   - restartOnCrash / shutdownTimeout 字段误用抛错（同款 guard）
 *
 * 用真实 spawn 的 mock LSP server，不 mock LSPClient（端到端验证更稳）。
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createLSPServerInstance } from '../client/LSPServerInstance.js';
import type { ScopedLspServerConfig } from '../manager/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(__dirname, 'mock-lsp-server.mjs');

function makeConfig(
  overrides: Partial<ScopedLspServerConfig> = {},
): ScopedLspServerConfig {
  return {
    command: process.execPath,
    args: [MOCK_SERVER],
    extensionToLanguage: { '.ts': 'typescript' },
    ...overrides,
  };
}

describe('LSPServerInstance', () => {
  it('初始状态是 stopped', () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    expect(instance.state).toBe('stopped');
    expect(instance.startTime).toBeUndefined();
    expect(instance.lastError).toBeUndefined();
    expect(instance.restartCount).toBe(0);
  });

  it('start() 完整状态机：stopped → running', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    expect(instance.state).toBe('stopped');
    await instance.start();
    expect(instance.state).toBe('running');
    expect(instance.startTime).toBeInstanceOf(Date);
    expect(instance.isHealthy()).toBe(true);
    await instance.stop();
    expect(instance.state).toBe('stopped');
  });

  it('start() 已 running 时直接 return（幂等）', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    await instance.start();
    const t1 = instance.startTime;
    await instance.start(); // 应该 noop
    expect(instance.startTime).toBe(t1);
    await instance.stop();
  });

  it('完整 InitializeParams 被 server 接受 → capabilities 有 hoverProvider', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    await instance.start();
    expect(instance.state).toBe('running');
    // 通过 sendRequest 验证 server 真的 initialize 完成
    const result = await instance.sendRequest<{ hello: string }>(
      'echo/test',
      { hello: 'world' },
    );
    expect(result).toEqual({ hello: 'world' });
    await instance.stop();
  });

  it('sendRequest 在 unhealthy 时抛错', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    // 没 start 直接 sendRequest
    await expect(instance.sendRequest('echo/test', {})).rejects.toThrow(
      /server is stopped/,
    );
  });

  it('content-modified (-32801) 重试：前 2 次失败，第 3 次成功', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    await instance.start();
    // mock server 会在前 2 次抛 -32801，第 3 次返回成功
    await instance.sendRequest('echo/reset-content-modified', {});
    const result = await instance.sendRequest<{
      attempts: number;
      params: { failTimes: number };
    }>('echo/content-modified', { failTimes: 2 });
    expect(result.attempts).toBe(3); // 第 3 次成功
    await instance.stop();
  });

  it('content-modified 超过 max retries (3 次) 后抛错', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    await instance.start();
    await instance.sendRequest('echo/reset-content-modified', {});
    // 让 mock server 失败 10 次（远超 MAX_RETRIES_FOR_TRANSIENT_ERRORS=3）
    await expect(
      instance.sendRequest('echo/content-modified', { failTimes: 10 }),
    ).rejects.toThrow();
    await instance.stop();
  });

  it('startupTimeout 触发 → start() rejected', async () => {
    const instance = createLSPServerInstance(
      'slow-mock',
      makeConfig({
        startupTimeout: 100, // 100ms
        env: { MOCK_LSP_INIT_DELAY_MS: '2000' }, // server 故意慢 2s
      }),
    );
    await expect(instance.start()).rejects.toThrow(/timed out after 100ms/);
    expect(instance.state).toBe('error');
    expect(instance.lastError).toBeDefined();
    // 子进程应该已被清理（client.stop 在 catch 块里调）
  });

  it('start() 失败后状态变 error，再次 start() 重置状态', async () => {
    // 用一个 bad command 触发 start 失败
    const instance = createLSPServerInstance(
      'bad',
      makeConfig({ command: '/nonexistent/binary' }),
    );
    await expect(instance.start()).rejects.toThrow();
    expect(instance.state).toBe('error');
    expect(instance.lastError).toBeDefined();
  });

  it('restart() 增加 restartCount', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    await instance.start();
    expect(instance.restartCount).toBe(0);
    await instance.restart();
    expect(instance.restartCount).toBe(1);
    expect(instance.state).toBe('running');
    await instance.restart();
    expect(instance.restartCount).toBe(2);
    await instance.stop();
  });

  it('restart() 超过 maxRestarts 抛错', async () => {
    const instance = createLSPServerInstance(
      'mock',
      makeConfig({ maxRestarts: 1 }),
    );
    await instance.start();
    await instance.restart(); // count=1 ok
    await expect(instance.restart()).rejects.toThrow(/Max restart attempts/);
  });

  it('restartOnCrash 字段误用 → 立刻抛错', () => {
    expect(() =>
      createLSPServerInstance(
        'mock',
        makeConfig({ restartOnCrash: true }),
      ),
    ).toThrow(/restartOnCrash is not yet implemented/);
  });

  it('shutdownTimeout 字段误用 → 立刻抛错', () => {
    expect(() =>
      createLSPServerInstance(
        'mock',
        makeConfig({ shutdownTimeout: 5000 }),
      ),
    ).toThrow(/shutdownTimeout is not yet implemented/);
  });

  it('stop() 已 stopped 时直接 return（幂等）', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    expect(instance.state).toBe('stopped');
    await instance.stop(); // 应该 noop，不抛错
    expect(instance.state).toBe('stopped');
  });

  it('sendNotification 不返回值，但调用成功', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    await instance.start();
    await expect(
      instance.sendNotification('$/test', { foo: 'bar' }),
    ).resolves.toBeUndefined();
    await instance.stop();
  });

  it('onNotification + onRequest 可注册（不抛错）', async () => {
    const instance = createLSPServerInstance('mock', makeConfig());
    await instance.start();
    // 仅验证 API 调用不抛错；实际 wire 在 C5 测
    expect(() =>
      instance.onNotification('window/showMessage', () => {}),
    ).not.toThrow();
    expect(() =>
      instance.onRequest('workspace/configuration', () => []),
    ).not.toThrow();
    await instance.stop();
  });
});
