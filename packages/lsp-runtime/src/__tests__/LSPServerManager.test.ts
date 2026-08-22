/**
 * LSPServerManager 端到端单测。
 *
 * 覆盖：
 *   - initialize 加载配置 + 注册扩展名路由
 *   - getServerForFile 按扩展名找 server
 *   - ensureServerStarted 懒启动
 *   - sendRequest 路由到正确 server
 *   - openFile / changeFile / saveFile / closeFile 4 个 LSP 通知
 *   - changeFile 在 file 没 open 时自动 fallback 到 openFile
 *   - openedFiles 追踪（didOpen 之前不会发 didChange）
 *   - closeAllFiles 关闭所有跟踪文件
 *   - workspace/configuration handler 注册（不抛错）
 *   - shutdown 清空 state
 *   - 多扩展名 / 多 server 配置
 */

import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  createLSPServerManager,
  type LspServerConfigLoader,
} from '../manager/LSPServerManager.js';
import type { ScopedLspServerConfig } from '../manager/types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MOCK_SERVER = join(__dirname, 'mock-lsp-server.mjs');

function makeMockConfig(
  overrides: Partial<ScopedLspServerConfig> = {},
): ScopedLspServerConfig {
  return {
    command: process.execPath,
    args: [MOCK_SERVER],
    extensionToLanguage: { '.ts': 'typescript', '.tsx': 'typescriptreact' },
    ...overrides,
  };
}

function makeLoader(
  servers: Record<string, ScopedLspServerConfig>,
): LspServerConfigLoader {
  return {
    load: async () => ({ servers }),
  };
}

describe('LSPServerManager', () => {
  it('initialize 加载配置 + 扩展名路由建立', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    expect(manager.getAllServers().size).toBe(1);
    expect(manager.getServerForFile('/a/b/foo.ts')?.name).toBe('mock');
    expect(manager.getServerForFile('/a/b/foo.tsx')?.name).toBe('mock');
    expect(manager.getServerForFile('/a/b/foo.py')).toBeUndefined();

    await manager.shutdown();
  });

  it('ensureServerStarted 懒启动 → 第一次调用才 spawn', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    const server = manager.getServerForFile('/x/test.ts');
    expect(server?.state).toBe('stopped'); // 懒启动，未 start

    const ensured = await manager.ensureServerStarted('/x/test.ts');
    expect(ensured?.state).toBe('running');

    await manager.shutdown();
  });

  it('ensureServerStarted 对不支持的扩展名返回 undefined', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();
    expect(await manager.ensureServerStarted('/x/test.py')).toBeUndefined();
    await manager.shutdown();
  });

  it('sendRequest 路由到正确 server', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    const result = await manager.sendRequest<{ hello: string }>(
      '/x/test.ts',
      'echo/test',
      { hello: 'world' },
    );
    expect(result).toEqual({ hello: 'world' });

    await manager.shutdown();
  });

  it('openFile 触发 didOpen + 更新 openedFiles 追踪', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    expect(manager.isFileOpen('/x/foo.ts')).toBe(false);
    await manager.openFile('/x/foo.ts', 'const a = 1');
    expect(manager.isFileOpen('/x/foo.ts')).toBe(true);

    // 重复 openFile 不抛错（已开就 skip）
    await manager.openFile('/x/foo.ts', 'const a = 2');
    expect(manager.isFileOpen('/x/foo.ts')).toBe(true);

    await manager.shutdown();
  });

  it('changeFile 在文件没 open 时自动 fallback 到 openFile', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    expect(manager.isFileOpen('/x/bar.ts')).toBe(false);
    await manager.changeFile('/x/bar.ts', 'const b = 1');
    // changeFile 内部应该 fallback 到 openFile，所以 openedFiles 有记录
    expect(manager.isFileOpen('/x/bar.ts')).toBe(true);

    await manager.shutdown();
  });

  it('changeFile 在 server 已 running + file 已 open 时直接发 didChange', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    await manager.openFile('/x/baz.ts', 'const c = 1');
    // 这次 changeFile 应该走 didChange 路径，不会 reopen
    await manager.changeFile('/x/baz.ts', 'const c = 2');
    expect(manager.isFileOpen('/x/baz.ts')).toBe(true);

    await manager.shutdown();
  });

  it('saveFile 在 server running 时发 didSave；server 没启动则 noop', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    // 没启动 server，saveFile 应当 noop（不抛错）
    await expect(manager.saveFile('/x/qux.ts')).resolves.toBeUndefined();

    // 启动后再 saveFile（不验证内容，只要不抛错）
    await manager.openFile('/x/qux.ts', 'const d = 1');
    await expect(manager.saveFile('/x/qux.ts')).resolves.toBeUndefined();

    await manager.shutdown();
  });

  it('closeFile 发 didClose + 清空 openedFiles 单条', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    await manager.openFile('/x/zap.ts', 'const e = 1');
    expect(manager.isFileOpen('/x/zap.ts')).toBe(true);
    await manager.closeFile('/x/zap.ts');
    expect(manager.isFileOpen('/x/zap.ts')).toBe(false);

    await manager.shutdown();
  });

  it('closeAllFiles 关闭所有跟踪文件', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();

    await manager.openFile('/x/1.ts', 'a');
    await manager.openFile('/x/2.ts', 'b');
    await manager.openFile('/x/3.ts', 'c');
    expect(manager.isFileOpen('/x/1.ts')).toBe(true);

    await manager.closeAllFiles();
    expect(manager.isFileOpen('/x/1.ts')).toBe(false);
    expect(manager.isFileOpen('/x/2.ts')).toBe(false);
    expect(manager.isFileOpen('/x/3.ts')).toBe(false);

    await manager.shutdown();
  });

  it('shutdown 清空所有 state', async () => {
    const manager = createLSPServerManager(
      makeLoader({ mock: makeMockConfig() }),
    );
    await manager.initialize();
    await manager.openFile('/x/test.ts', 'x');
    expect(manager.getAllServers().size).toBe(1);

    await manager.shutdown();
    expect(manager.getAllServers().size).toBe(0);
    expect(manager.isFileOpen('/x/test.ts')).toBe(false);
  });

  it('initialize 单个 server config 损坏不影响其他 server', async () => {
    const manager = createLSPServerManager(
      makeLoader({
        mock: makeMockConfig(),
        // @ts-expect-error 故意构造无效 config
        bad: { extensionToLanguage: {} }, // 缺 command
      }),
    );
    await manager.initialize();
    // 'mock' 应该成功加载
    expect(manager.getAllServers().has('mock')).toBe(true);
    // 'bad' 应该跳过
    expect(manager.getAllServers().has('bad')).toBe(false);
    await manager.shutdown();
  });

  it('多 server 配置：不同扩展名路由到不同 server', async () => {
    const manager = createLSPServerManager(
      makeLoader({
        'ts-mock': makeMockConfig({
          extensionToLanguage: { '.ts': 'typescript' },
        }),
        'py-mock': makeMockConfig({
          extensionToLanguage: { '.py': 'python' },
        }),
      }),
    );
    await manager.initialize();

    expect(manager.getServerForFile('/x/a.ts')?.name).toBe('ts-mock');
    expect(manager.getServerForFile('/x/b.py')?.name).toBe('py-mock');

    await manager.shutdown();
  });
});
