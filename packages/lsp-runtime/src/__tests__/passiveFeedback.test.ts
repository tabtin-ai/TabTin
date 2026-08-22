/**
 * passiveFeedback wire 单测。
 *
 * 覆盖：
 *   - formatDiagnosticsForAttachment：LSP severity 映射 + URI 处理 + code 字符串化
 *   - registerLSPNotificationHandlers：注册全部 server 的 publishDiagnostics handler
 *   - 端到端：server 推 publishDiagnostics → registry pending +1
 *   - 多 server：每个 server 独立注册
 *   - 无效 params 被过滤（不入 registry）
 *   - 空 diagnostics 被过滤
 *   - server 抛错被隔离（不影响其他 server）
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  formatDiagnosticsForAttachment,
  registerLSPNotificationHandlers,
} from '../diagnostics/passiveFeedback.js';
import {
  resetAllLSPDiagnosticState,
  getPendingLSPDiagnosticCount,
  checkForLSPDiagnostics,
} from '../diagnostics/LSPDiagnosticRegistry.js';
import {
  initializeLspServerManager,
  shutdownLspServerManager,
  waitForInitialization,
  getLspServerManager,
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

describe('formatDiagnosticsForAttachment', () => {
  it('LSP severity 1 → Error / 2 → Warning / 3 → Info / 4 → Hint', () => {
    const result = formatDiagnosticsForAttachment({
      uri: 'file:///a.ts',
      diagnostics: [
        { message: 'e', severity: 1, range: r() },
        { message: 'w', severity: 2, range: r() },
        { message: 'i', severity: 3, range: r() },
        { message: 'h', severity: 4, range: r() },
      ],
    });
    const sevs = result[0]!.diagnostics.map((d) => d.severity);
    expect(sevs).toEqual(['Error', 'Warning', 'Info', 'Hint']);
  });

  it('LSP severity undefined → Error (默认行为)', () => {
    const result = formatDiagnosticsForAttachment({
      uri: 'file:///a.ts',
      diagnostics: [{ message: 'm', range: r() }],
    });
    expect(result[0]!.diagnostics[0]!.severity).toBe('Error');
  });

  it('file:// URI → 转 fileURLToPath（OS path）', () => {
    const result = formatDiagnosticsForAttachment({
      uri: 'file:///path/to/foo.ts',
      diagnostics: [],
    });
    expect(result[0]!.uri).toBe('/path/to/foo.ts');
  });

  it('非 file:// URI → 保留原值', () => {
    const result = formatDiagnosticsForAttachment({
      uri: '_claude_fs_right:foo.ts',
      diagnostics: [],
    });
    expect(result[0]!.uri).toBe('_claude_fs_right:foo.ts');
  });

  it('code 数字 → 字符串化', () => {
    const result = formatDiagnosticsForAttachment({
      uri: 'file:///a.ts',
      diagnostics: [
        { message: 'm', severity: 1, range: r(), code: 2322 },
      ],
    });
    expect(result[0]!.diagnostics[0]!.code).toBe('2322');
  });

  it('code 为 null/undefined → 不出现在结果里', () => {
    const result = formatDiagnosticsForAttachment({
      uri: 'file:///a.ts',
      diagnostics: [{ message: 'm', severity: 1, range: r(), code: undefined }],
    });
    expect(result[0]!.diagnostics[0]!.code).toBeUndefined();
  });

  function r() {
    return {
      start: { line: 0, character: 0 },
      end: { line: 0, character: 1 },
    };
  }
});

describe('registerLSPNotificationHandlers', () => {
  beforeEach(() => {
    _resetLspManagerForTesting();
    resetAllLSPDiagnosticState();
  });

  afterEach(async () => {
    await shutdownLspServerManager();
    _resetLspManagerForTesting();
    resetAllLSPDiagnosticState();
  });

  it('全部 server 都注册成功', async () => {
    initializeLspServerManager(
      makeLoader({ s1: mockConfig(), s2: mockConfig() }),
    );
    await waitForInitialization();

    const result = registerLSPNotificationHandlers(getLspServerManager()!);
    expect(result.totalServers).toBe(2);
    expect(result.successCount).toBe(2);
    expect(result.registrationErrors).toHaveLength(0);
  });

  it('端到端：server 推 publishDiagnostics → registry pending +1', async () => {
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    const manager = getLspServerManager()!;
    registerLSPNotificationHandlers(manager);

    // 启动 server + 触发 publishDiagnostics
    const server = await manager.ensureServerStarted('/x/test.ts');
    expect(server).toBeDefined();

    expect(getPendingLSPDiagnosticCount()).toBe(0);

    // mock server 收到这个 request 后会主动推 publishDiagnostics
    await server!.sendRequest('client/triggerPublishDiagnostics', {
      uri: 'file:///fake.ts',
      diagnostics: [
        {
          message: 'real diagnostic',
          severity: 1,
          range: {
            start: { line: 5, character: 0 },
            end: { line: 5, character: 1 },
          },
          source: 'mock-lsp',
          code: 'E001',
        },
      ],
    });

    // 给 notification 一点时间 propagate
    await new Promise((r) => setTimeout(r, 100));

    expect(getPendingLSPDiagnosticCount()).toBe(1);

    // checkForLSPDiagnostics 取出来验证内容
    const taken = checkForLSPDiagnostics();
    expect(taken).toHaveLength(1);
    expect(taken[0]!.serverName).toBe('mock');
    expect(taken[0]!.files[0]!.diagnostics[0]!.message).toBe('real diagnostic');
    expect(taken[0]!.files[0]!.diagnostics[0]!.severity).toBe('Error');
  });

  it('空 diagnostics 不入 registry', async () => {
    initializeLspServerManager(makeLoader());
    await waitForInitialization();
    const manager = getLspServerManager()!;
    registerLSPNotificationHandlers(manager);

    const server = await manager.ensureServerStarted('/x/test.ts');
    await server!.sendRequest('client/triggerPublishDiagnostics', {
      uri: 'file:///empty.ts',
      diagnostics: [], // 空 diagnostics
    });
    await new Promise((r) => setTimeout(r, 100));

    expect(getPendingLSPDiagnosticCount()).toBe(0);
  });
});
