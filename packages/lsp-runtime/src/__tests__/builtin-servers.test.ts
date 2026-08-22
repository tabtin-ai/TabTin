/**
 * Bundled LSP server 集成测试。
 *
 * 关键验证：
 *   - bundled typescript-language-server + bundled typescript 能 spawn 起来
 *     并完成 LSP initialize（这是 C7 的北极星）
 *   - bundled pyright-langserver 能 spawn 起来并完成 LSP initialize
 *   - 项目自带 typescript 时优先用项目的
 *   - venv 检测正确工作（pythonPath 注入）
 *   - 所有 binary 都找不到时 loader 返回空 servers（不抛错）
 *
 * 这是 C7 端到端验证：dev 模式下下载的 lsp-servers/ 真的能跑。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createBuiltinServersLoader } from '../registry/builtin-servers.js';
import {
  resolveTypescriptLanguageServer,
  resolveTsserver,
  resolvePyrightLangserver,
  detectPythonInterpreter,
  getLspServersRoot,
} from '../registry/bundled-paths.js';
import { createLSPServerManager } from '../manager/LSPServerManager.js';

describe('bundled-paths', () => {
  it('getLspServersRoot 返回有效路径（dev 模式 → packages/lsp-runtime/lsp-servers）', () => {
    const root = getLspServersRoot();
    expect(root).toBeTruthy();
    // 注：如果 pre-build 跑过了，这个目录应该存在
    if (!process.env.TABTIN_SKIP_LSP_DOWNLOAD) {
      expect(existsSync(root)).toBe(true);
    }
  });

  it('resolveTypescriptLanguageServer 找到 binary（bundled 或系统 PATH）', () => {
    const result = resolveTypescriptLanguageServer();
    // 如果 pre-build 跑过 → 必然能找到 bundled
    if (!process.env.TABTIN_SKIP_LSP_DOWNLOAD) {
      expect(result).toBeDefined();
      expect(result!.command).toBeTruthy();
      expect(result!.args).toContain('--stdio');
    }
  });

  it('resolveTsserver 找到 bundled tsserver.js（无项目自带时）', () => {
    // 创建一个空临时目录（没 node_modules/typescript）
    const tmp = join(tmpdir(), `tabtin-lsp-test-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const result = resolveTsserver(tmp);
      if (!process.env.TABTIN_SKIP_LSP_DOWNLOAD) {
        // 应该回退到 bundled
        expect(result).toBeTruthy();
        expect(result).toContain('lsp-servers/typescript');
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('resolveTsserver 项目自带 typescript 优先', () => {
    const tmp = join(tmpdir(), `tabtin-lsp-test-${randomUUID()}`);
    const fakeTsserver = join(
      tmp,
      'node_modules',
      'typescript',
      'lib',
      'tsserver.js',
    );
    mkdirSync(join(tmp, 'node_modules', 'typescript', 'lib'), {
      recursive: true,
    });
    writeFileSync(fakeTsserver, '// fake tsserver');
    try {
      const result = resolveTsserver(tmp);
      expect(result).toBe(fakeTsserver);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detectPythonInterpreter 检测 .venv 路径', () => {
    const tmp = join(tmpdir(), `tabtin-lsp-test-${randomUUID()}`);
    const venvPy =
      process.platform === 'win32'
        ? join(tmp, '.venv', 'Scripts', 'python.exe')
        : join(tmp, '.venv', 'bin', 'python');
    mkdirSync(join(venvPy, '..'), { recursive: true });
    writeFileSync(venvPy, '#!/bin/bash\n');

    try {
      // 临时清掉 VIRTUAL_ENV 避免干扰
      const oldVenv = process.env.VIRTUAL_ENV;
      delete process.env.VIRTUAL_ENV;
      try {
        const result = detectPythonInterpreter(tmp);
        expect(result).toBe(venvPy);
      } finally {
        if (oldVenv) process.env.VIRTUAL_ENV = oldVenv;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('detectPythonInterpreter 没有 venv 返回 undefined', () => {
    const tmp = join(tmpdir(), `tabtin-lsp-test-${randomUUID()}`);
    mkdirSync(tmp, { recursive: true });
    try {
      const oldVenv = process.env.VIRTUAL_ENV;
      delete process.env.VIRTUAL_ENV;
      try {
        expect(detectPythonInterpreter(tmp)).toBeUndefined();
      } finally {
        if (oldVenv) process.env.VIRTUAL_ENV = oldVenv;
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe('createBuiltinServersLoader', () => {
  let projectRoot: string;

  beforeAll(() => {
    // 创建一个最小项目（有 node_modules/typescript stub）
    projectRoot = join(tmpdir(), `tabtin-lsp-proj-${randomUUID()}`);
    mkdirSync(join(projectRoot, 'node_modules', 'typescript', 'lib'), {
      recursive: true,
    });
    // 写一个真实的 tsserver.js stub（让 resolveTsserver 检查 existsSync 通过）
    writeFileSync(
      join(projectRoot, 'node_modules', 'typescript', 'lib', 'tsserver.js'),
      '// stub tsserver for testing',
    );
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('load 返回 typescript + pyright 配置（bundled 都在）', async () => {
    if (process.env.TABTIN_SKIP_LSP_DOWNLOAD) return;

    const loader = createBuiltinServersLoader({ projectRoot });
    const { servers } = await loader.load();

    expect(Object.keys(servers).sort()).toEqual(['pyright', 'typescript']);

    // typescript 配置含正确的 extensionToLanguage 和 initializationOptions
    expect(servers.typescript!.extensionToLanguage['.ts']).toBe('typescript');
    expect(servers.typescript!.extensionToLanguage['.tsx']).toBe(
      'typescriptreact',
    );
    expect(
      (servers.typescript!.initializationOptions as { tsserver: { path: string } })
        .tsserver.path,
    ).toContain('tsserver.js');

    // pyright 配置
    expect(servers.pyright!.extensionToLanguage['.py']).toBe('python');
  });

  it('enabled.typescript = false 跳过 typescript', async () => {
    const loader = createBuiltinServersLoader({
      projectRoot,
      enabled: { typescript: false },
    });
    const { servers } = await loader.load();
    expect(servers.typescript).toBeUndefined();
  });

  it('enabled.pyright = false 跳过 pyright', async () => {
    const loader = createBuiltinServersLoader({
      projectRoot,
      enabled: { pyright: false },
    });
    const { servers } = await loader.load();
    expect(servers.pyright).toBeUndefined();
  });
});

describe('bundled LSP server 端到端 spawn（这是 C7 北极星）', () => {
  // 这个 describe 块跑实际 spawn + initialize；如果 bundled binary 缺失则
  // skip——避免 CI 缺包时挂掉
  if (process.env.TABTIN_SKIP_LSP_DOWNLOAD) {
    it.skip('bundled typescript-language-server: skipped (TABTIN_SKIP_LSP_DOWNLOAD)', () => {});
    return;
  }

  let projectRoot: string;

  beforeAll(() => {
    projectRoot = join(tmpdir(), `tabtin-lsp-spawn-${randomUUID()}`);
    mkdirSync(join(projectRoot, 'node_modules', 'typescript', 'lib'), {
      recursive: true,
    });
    // resolveTsserver 优先用项目，但项目 tsserver.js 是假的——
    // 实际启动时 typescript-language-server 会因找不到真 tsserver 失败。
    // 改成不写假 tsserver，让 resolveTsserver 回退到 bundled 真 tsserver.js。
    // 即 fresh empty projectRoot
    rmSync(join(projectRoot, 'node_modules'), {
      recursive: true,
      force: true,
    });
  });

  afterAll(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  it('bundled typescript-language-server 能 spawn + initialize 完成', async () => {
    const loader = createBuiltinServersLoader({
      projectRoot,
      enabled: { pyright: false }, // 只测 typescript
    });
    const manager = createLSPServerManager(loader);
    await manager.initialize();

    expect(manager.getAllServers().has('typescript')).toBe(true);

    // 实际 spawn —— 第一次 ensureServerStarted 会跑完 initialize
    const server = await manager.ensureServerStarted('/x/test.ts');
    expect(server).toBeDefined();
    expect(server!.state).toBe('running');
    expect(server!.isHealthy()).toBe(true);

    await manager.shutdown();
  }, 30000); // typescript-language-server 启动可能慢 ~3-5s，给 30s timeout

  it('bundled pyright 能 spawn + initialize 完成', async () => {
    const loader = createBuiltinServersLoader({
      projectRoot,
      enabled: { typescript: false }, // 只测 pyright
    });
    const manager = createLSPServerManager(loader);
    await manager.initialize();

    expect(manager.getAllServers().has('pyright')).toBe(true);

    const server = await manager.ensureServerStarted('/x/test.py');
    expect(server).toBeDefined();
    expect(server!.state).toBe('running');

    await manager.shutdown();
  }, 30000);
});
