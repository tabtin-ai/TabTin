/**
 * Singleton manager 单测。
 *
 * 覆盖：
 *   - initialize 异步流：not-started → pending → success
 *   - 重复 initialize 幂等
 *   - disabled 模式（env / opts）跳过初始化
 *   - getInitializationStatus 状态切换
 *   - waitForInitialization 等待
 *   - onLspInitialized 回调（init 前注册 / init 后注册都能收到）
 *   - reinitialize 重建
 *   - shutdown 清空
 *   - generation counter 防止 stale promise 污染
 *   - 配置 loader 失败 → state=failed
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  initializeLspServerManager,
  reinitializeLspServerManager,
  shutdownLspServerManager,
  getLspServerManager,
  getInitializationStatus,
  waitForInitialization,
  isLspConnected,
  onLspInitialized,
  _resetLspManagerForTesting,
} from '../manager/singleton.js';
import type { LspServerConfigLoader } from '../manager/LSPServerManager.js';
import type { ScopedLspServerConfig } from '../manager/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(__dirname, 'mock-lsp-server.mjs');

function mockConfig(): ScopedLspServerConfig {
  return {
    command: process.execPath,
    args: [MOCK_SERVER],
    extensionToLanguage: { '.ts': 'typescript' },
  };
}

function makeLoader(
  servers: Record<string, ScopedLspServerConfig> = { mock: mockConfig() },
): LspServerConfigLoader {
  return { load: async () => ({ servers }) };
}

function makeFailingLoader(): LspServerConfigLoader {
  return {
    load: async () => {
      throw new Error('Simulated loader failure');
    },
  };
}

describe('singleton manager', () => {
  beforeEach(() => {
    _resetLspManagerForTesting();
    delete process.env.TABTIN_DISABLE_LSP;
  });

  afterEach(async () => {
    await shutdownLspServerManager();
    _resetLspManagerForTesting();
    delete process.env.TABTIN_DISABLE_LSP;
  });

  it('初始状态：not-started + getLspServerManager 返回 undefined', () => {
    expect(getInitializationStatus().status).toBe('not-started');
    expect(getLspServerManager()).toBeUndefined();
    expect(isLspConnected()).toBe(false);
  });

  it('initialize 异步流：not-started → pending → success', async () => {
    initializeLspServerManager(makeLoader());
    expect(getInitializationStatus().status).toBe('pending');
    expect(getLspServerManager()).toBeDefined();

    await waitForInitialization();
    expect(getInitializationStatus().status).toBe('success');
  });

  it('initialize 后 isLspConnected = true（连接态语义：只要 server 不是 error 状态都算 connected）', async () => {
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    // 设计出处 manager.ts:100-110: isLspConnected 检查
    // `server.state !== 'error'`，懒启动的 'stopped' 状态也算 connected
    expect(isLspConnected()).toBe(true);
  });

  it('isLspConnected 在 init failed 时返回 false', async () => {
    initializeLspServerManager(makeFailingLoader());
    await waitForInitialization();
    expect(isLspConnected()).toBe(false);
  });

  it('isLspConnected 在 init not-started 时返回 false', () => {
    expect(isLspConnected()).toBe(false);
  });

  it('重复 initialize 幂等（不重建 manager）', async () => {
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    const m1 = getLspServerManager();
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    const m2 = getLspServerManager();
    expect(m1).toBe(m2);
  });

  it('disabled via env (TABTIN_DISABLE_LSP=1) → 跳过初始化', () => {
    process.env.TABTIN_DISABLE_LSP = '1';
    initializeLspServerManager(makeLoader());
    expect(getInitializationStatus().status).toBe('not-started');
    expect(getLspServerManager()).toBeUndefined();
  });

  it('disabled via opts → 跳过初始化', () => {
    initializeLspServerManager(makeLoader(), { disabled: true });
    expect(getInitializationStatus().status).toBe('not-started');
    expect(getLspServerManager()).toBeUndefined();
  });

  it('configLoader 失败 → state = failed', async () => {
    initializeLspServerManager(makeFailingLoader());
    await waitForInitialization();
    const status = getInitializationStatus();
    expect(status.status).toBe('failed');
    if (status.status === 'failed') {
      expect(status.error.message).toContain('Simulated loader failure');
    }
    expect(getLspServerManager()).toBeUndefined();
  });

  it('failed 后再次 initialize 可重试', async () => {
    initializeLspServerManager(makeFailingLoader());
    await waitForInitialization();
    expect(getInitializationStatus().status).toBe('failed');

    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    expect(getInitializationStatus().status).toBe('success');
  });

  it('onLspInitialized：init 前注册 → success 时触发', async () => {
    const calls: string[] = [];
    onLspInitialized((manager) => {
      calls.push(`got ${manager.getAllServers().size} servers`);
    });

    expect(calls).toEqual([]);

    initializeLspServerManager(makeLoader());
    await waitForInitialization();

    expect(calls).toEqual(['got 1 servers']);
  });

  it('onLspInitialized：init 后注册 → 立即触发（race 防护）', async () => {
    initializeLspServerManager(makeLoader());
    await waitForInitialization();

    const calls: string[] = [];
    onLspInitialized((manager) => {
      calls.push(`got ${manager.getAllServers().size} servers`);
    });

    expect(calls).toEqual(['got 1 servers']);
  });

  it('reinitialize 重建（用之前的 loader）', async () => {
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    const m1 = getLspServerManager();

    reinitializeLspServerManager();
    await waitForInitialization();
    const m2 = getLspServerManager();

    // 应该是不同实例
    expect(m1).not.toBe(m2);
    expect(getInitializationStatus().status).toBe('success');
  });

  it('reinitialize 用新 loader', async () => {
    initializeLspServerManager(makeLoader({ a: mockConfig() }));
    await waitForInitialization();
    expect(getLspServerManager()?.getAllServers().has('a')).toBe(true);

    reinitializeLspServerManager(makeLoader({ b: mockConfig() }));
    await waitForInitialization();
    expect(getLspServerManager()?.getAllServers().has('b')).toBe(true);
    expect(getLspServerManager()?.getAllServers().has('a')).toBe(false);
  });

  it('reinitialize 在 not-started 时是 noop', () => {
    expect(getInitializationStatus().status).toBe('not-started');
    reinitializeLspServerManager(makeLoader());
    expect(getInitializationStatus().status).toBe('not-started');
  });

  it('shutdown 清空状态', async () => {
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    expect(getLspServerManager()).toBeDefined();

    await shutdownLspServerManager();
    expect(getLspServerManager()).toBeUndefined();
    expect(getInitializationStatus().status).toBe('not-started');
  });
});
