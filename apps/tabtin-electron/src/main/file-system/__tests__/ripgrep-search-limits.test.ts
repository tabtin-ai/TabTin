import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const mocks = vi.hoisted(() => ({
  getPath: vi.fn((name: string) => {
    if (name === 'downloads') return '/tmp/downloads';
    if (name === 'home') return '/tmp/home';
    return '/tmp';
  }),
  invoke: vi.fn(),
  handle: vi.fn(),
  removeHandler: vi.fn(),
  openPath: vi.fn(),
  openExternal: vi.fn(),
  showItemInFolder: vi.fn(),
  execFileAsync: vi.fn(),
  rgPath:
    'C:\\Program Files\\TabTin\\resources\\app.asar\\node_modules\\@vscode\\ripgrep\\bin\\rg.exe',
  isPathSafe: vi.fn(() => true),
  resolveSpacesRoot: vi.fn(() => '/tmp/sandbox'),
  sanitizePathSegment: vi.fn((s: string) => s),
  isTrustedSender: vi.fn(() => true),
  // 路径权限治理 Wave 2：path-access-checker.check 默认放行；
  // 单条用例可 .mockReturnValueOnce 覆盖
  pathAccessCheck: vi.fn(
    () =>
      ({ allowed: true }) as {
        allowed: boolean;
        reason?: { reasonCode: string; message: string };
      },
  ),
}));

vi.mock('electron', () => ({
  app: { getPath: mocks.getPath },
  ipcMain: {
    handle: mocks.handle,
    removeHandler: mocks.removeHandler,
  },
  shell: {
    openPath: mocks.openPath,
    openExternal: mocks.openExternal,
    showItemInFolder: mocks.showItemInFolder,
  },
}));

vi.mock('node:child_process', () => {
  const execFile = vi.fn();
  return { execFile, default: { execFile } };
});

vi.mock('node:util', () => ({
  promisify: () => mocks.execFileAsync,
  default: { promisify: () => mocks.execFileAsync },
}));

vi.mock('../ripgrep-bundle-path', () => ({
  getBundledRipgrepPath: () => mocks.rgPath,
}));

vi.mock('@tabtin/terminal-core', () => ({
  resolveSpacesRoot: mocks.resolveSpacesRoot,
  resolvePlatformDataRoot: vi.fn(() => '/tmp/platform'),
  computeSkillContentHash: vi.fn().mockResolvedValue('hash'),
  matchSensitivePath: vi.fn(() => null),
}));

// 路径权限治理 Wave 2：fs IPC handler 现在通过 path-access-checker 做
// 权限判定，老 isPathAllowed 已退役。本测试默认放行——单个用例可
// 通过 mocks.pathAccessCheck.mockReturnValueOnce(...) 覆盖。
vi.mock('../../security/path-access-checker', () => ({
  getDefaultPathAccessChecker: () => ({
    check: (...args: unknown[]) => (mocks.pathAccessCheck as any)(...args),
  }),
}));

vi.mock('keytar', () => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  findCredentials: vi.fn(),
  findPassword: vi.fn(),
}));

vi.mock('../../utils/path-sanitize', () => ({
  sanitizePathSegment: mocks.sanitizePathSegment,
}));

vi.mock('../../download-security', () => ({
  isPathSafe: mocks.isPathSafe,
}));

vi.mock('../../auth', () => ({
  isTrustedSender: mocks.isTrustedSender,
}));

import {
  registerFileSystemIpcHandlers,
  ripgrepPathSearchConfig,
  unregisterFileSystemIpcHandlers,
} from '../ipc';

function getRipgrepHandler(): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find(
    (c: unknown[]) => c[0] === 'fs:ripgrepSearch',
  );
  if (!call) throw new Error('fs:ripgrepSearch handler not registered');
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function getHandler(channel: string): (...args: unknown[]) => Promise<unknown> {
  const call = mocks.handle.mock.calls.find((c: unknown[]) => c[0] === channel);
  if (!call) throw new Error(`${channel} handler not registered`);
  return call[1] as (...args: unknown[]) => Promise<unknown>;
}

function getReplaceHandler(): (...args: unknown[]) => Promise<unknown> {
  return getHandler('fs:replaceInFiles');
}

function makeRgJsonLine(type: string, data: Record<string, unknown>): string {
  return JSON.stringify({ type, data });
}

function makeMatchLines(
  count: number,
  filePrefix = '/tmp/home/proj/file',
): string {
  const lines: string[] = [];
  let fileIdx = 0;
  let lineNum = 1;
  for (let i = 0; i < count; i++) {
    if (i % 5 === 0) {
      fileIdx++;
      lineNum = 1;
      lines.push(
        makeRgJsonLine('begin', {
          path: { text: `${filePrefix}${fileIdx}.ts` },
        }),
      );
    }
    lines.push(
      makeRgJsonLine('match', {
        path: { text: `${filePrefix}${fileIdx}.ts` },
        lines: { text: `const foo_${i} = "bar";\n` },
        line_number: lineNum++,
        submatches: [{ match: { text: 'foo' }, start: 6, end: 9 }],
      }),
    );
  }
  return lines.join('\n');
}

describe('fs:ripgrepSearch maxResults 上限', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
  });

  afterEach(() => {
    unregisterFileSystemIpcHandlers();
  });

  it('应将 maxResults 限制在 MAX_RIPGREP_RESULTS (2000) 以内', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(3000) });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxResults: 99999,
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(2000);
    expect(result.truncated).toBe(true);
  });

  it('默认 maxResults=200 应正常生效', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(300) });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results.length).toBe(200);
    expect(result.truncated).toBe(true);
  });

  it('maxResults=0 或负数应被 clamp 到 1', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(10) });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxResults: -5,
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results.length).toBe(1);
  });

  it('maxResults 为 NaN/非数值时应回退到默认值 200（RP-014 NaN 绕过防护）', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(300) });

    const resultStr = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxResults: 'not-a-number' as unknown as number,
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(resultStr.success).toBe(true);
    expect(resultStr.results.length).toBe(200);
    expect(resultStr.truncated).toBe(true);
  });

  it('maxResults 为 Infinity 时应被 clamp 到 2000', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(3000) });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxResults: Infinity,
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results.length).toBeLessThanOrEqual(2000);
  });

  it('maxResults 为 null 时应使用默认值 200', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(300) });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxResults: null as unknown as number,
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results.length).toBe(200);
  });

  it('maxBuffer 溢出时应优雅降级返回部分结果（RP-013）', async () => {
    const handler = getRipgrepHandler();
    const partialOutput = makeMatchLines(50);
    const bufferErr = new Error('stdout maxBuffer length exceeded') as Error & {
      code: string;
      stdout: string;
    };
    bufferErr.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    bufferErr.stdout = partialOutput;
    mocks.execFileAsync.mockRejectedValue(bufferErr);

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxResults: 500,
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results.length).toBeGreaterThan(0);
    expect(result.results.length).toBeLessThanOrEqual(50);
    expect(result.truncated).toBe(true);
  });

  it('maxBuffer 溢出且无 stdout 时应返回错误', async () => {
    const handler = getRipgrepHandler();
    const bufferErr = new Error('stdout maxBuffer length exceeded') as Error & {
      code: string;
      stdout?: string;
    };
    bufferErr.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    bufferErr.stdout = undefined;
    mocks.execFileAsync.mockRejectedValue(bufferErr);

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    )) as { success: boolean; error: string; results: unknown[] };

    expect(result.success).toBe(false);
    expect(result.error).toContain('maxBuffer');
  });

  it('结果未满时 truncated 应为 false', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(5) });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxResults: 100,
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results.length).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it('includePathMatches=true 时应返回文件夹名称命中，即使内容 rg 无匹配', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-rg-path-'));
    await fs.mkdir(path.join(tmpDir, '666-folder'));
    await fs.writeFile(
      path.join(tmpDir, 'plain.txt'),
      'no content hit',
      'utf8',
    );
    try {
      const handler = getRipgrepHandler();
      const noMatch = new Error('no matches') as Error & { code: number };
      noMatch.code = 1;
      mocks.execFileAsync.mockRejectedValue(noMatch);

      const result = (await handler(
        {},
        {
          cwd: tmpDir,
          pattern: '666',
          maxResults: 20,
          includePathMatches: true,
        },
      )) as {
        success: boolean;
        results: Array<{
          file: string;
          line: number;
          text: string;
          matchKind?: string;
          isDirectory?: boolean;
        }>;
        truncated: boolean;
        contentTruncated?: boolean;
        pathMatchesTruncated?: boolean;
      };

      expect(result.success).toBe(true);
      expect(result.results).toEqual([
        expect.objectContaining({
          file: path.join(tmpDir, '666-folder'),
          line: 0,
          text: '666-folder',
          matchKind: 'path',
          isDirectory: true,
        }),
      ]);
      expect(result.truncated).toBe(false);
      expect(result.contentTruncated).toBe(false);
      expect(result.pathMatchesTruncated).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('路径遍历截断不得污染 contentTruncated', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-rg-path-trunc-'),
    );
    const contentFile = path.join(tmpDir, 'hit.txt');
    await fs.writeFile(contentFile, 'needle-one\nneedle-two\n', 'utf8');
    // 造出足够多的无关文件，让路径遍历触达可调低的条目上限。
    for (let index = 0; index < 12; index++) {
      await fs.writeFile(
        path.join(tmpDir, `noise-${index}.txt`),
        'unrelated',
        'utf8',
      );
    }
    const previousMaxEntries = ripgrepPathSearchConfig.maxEntries;
    ripgrepPathSearchConfig.maxEntries = 4;
    try {
      const handler = getRipgrepHandler();
      mocks.execFileAsync.mockResolvedValue({
        stdout: [
          JSON.stringify({
            type: 'begin',
            data: { path: { text: contentFile } },
          }),
          JSON.stringify({
            type: 'match',
            data: {
              path: { text: contentFile },
              lines: { text: 'needle-one\n' },
              line_number: 1,
              absolute_offset: 0,
              submatches: [{ start: 0, end: 6, match: { text: 'needle' } }],
            },
          }),
          JSON.stringify({
            type: 'match',
            data: {
              path: { text: contentFile },
              lines: { text: 'needle-two\n' },
              line_number: 2,
              absolute_offset: 11,
              submatches: [{ start: 0, end: 6, match: { text: 'needle' } }],
            },
          }),
        ].join('\n'),
      });

      const result = (await handler(
        {},
        {
          cwd: tmpDir,
          pattern: 'needle',
          maxResults: 500,
          includePathMatches: true,
        },
      )) as {
        success: boolean;
        results: Array<{ matchKind?: string }>;
        truncated: boolean;
        contentTruncated?: boolean;
        pathMatchesTruncated?: boolean;
      };

      expect(result.success).toBe(true);
      expect(
        result.results.filter((item) => item.matchKind === 'content'),
      ).toHaveLength(2);
      expect(result.contentTruncated).toBe(false);
      expect(result.pathMatchesTruncated).toBe(true);
      expect(result.truncated).toBe(true);
    } finally {
      ripgrepPathSearchConfig.maxEntries = previousMaxEntries;
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('同一文件同时命中文件名与内容时只返回内容结果，避免重复噪音', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-rg-dedupe-'),
    );
    const filePath = path.join(tmpDir, 'needle-file.ts');
    await fs.writeFile(filePath, 'const needle = true', 'utf8');
    try {
      const handler = getRipgrepHandler();
      mocks.execFileAsync.mockResolvedValue({
        stdout: [
          JSON.stringify({ type: 'begin', data: { path: { text: filePath } } }),
          JSON.stringify({
            type: 'match',
            data: {
              path: { text: filePath },
              lines: { text: 'const needle = true\\n' },
              line_number: 1,
              submatches: [{ start: 6, end: 12 }],
            },
          }),
        ].join('\n'),
      });

      const result = (await handler(
        {},
        {
          cwd: tmpDir,
          pattern: 'needle',
          maxResults: 20,
          includePathMatches: true,
        },
      )) as {
        success: boolean;
        results: Array<{ file: string; matchKind?: string }>;
      };

      expect(result.success).toBe(true);
      expect(result.results).toEqual([
        expect.objectContaining({
          file: filePath,
          matchKind: 'content',
        }),
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('默认不返回路径名称命中，避免影响全文搜索调用方', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-rg-default-'),
    );
    await fs.mkdir(path.join(tmpDir, '666-folder'));
    try {
      const handler = getRipgrepHandler();
      const noMatch = new Error('no matches') as Error & { code: number };
      noMatch.code = 1;
      mocks.execFileAsync.mockRejectedValue(noMatch);

      const result = (await handler(
        {},
        {
          cwd: tmpDir,
          pattern: '666',
          maxResults: 20,
        },
      )) as { success: boolean; results: unknown[]; truncated: boolean };

      expect(result.success).toBe(true);
      expect(result.results).toEqual([]);
      expect(result.truncated).toBe(false);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('文件名命中应遵守显式大小写与全词选项', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-rg-path-options-'),
    );
    await fs.writeFile(path.join(tmpDir, 'foo.ts'), '', 'utf8');
    await fs.writeFile(path.join(tmpDir, 'FooBar.ts'), '', 'utf8');
    try {
      const handler = getRipgrepHandler();
      const noMatch = new Error('no matches') as Error & { code: number };
      noMatch.code = 1;
      mocks.execFileAsync.mockRejectedValue(noMatch);

      const result = (await handler(
        {},
        {
          cwd: tmpDir,
          pattern: 'foo',
          matchCase: true,
          wholeWord: true,
          includePathMatches: true,
          maxResults: 20,
        },
      )) as { results: Array<{ file: string; matchKind?: string }> };

      expect(result.results).toEqual([
        expect.objectContaining({
          file: path.join(tmpDir, 'foo.ts'),
          matchKind: 'path',
        }),
      ]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });

  it('includeIgnored=true 时不混入未经同等 ignore 过滤的文件名结果', async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-rg-path-ignore-'),
    );
    await fs.writeFile(path.join(tmpDir, 'foo.ts'), '', 'utf8');
    try {
      const handler = getRipgrepHandler();
      const noMatch = new Error('no matches') as Error & { code: number };
      noMatch.code = 1;
      mocks.execFileAsync.mockRejectedValue(noMatch);

      const result = (await handler(
        {},
        {
          cwd: tmpDir,
          pattern: 'foo',
          includeIgnored: true,
          includePathMatches: true,
        },
      )) as { results: unknown[] };

      expect(result.results).toEqual([]);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});

describe('fs:ripgrepSearch 输入校验与 DoS 边界', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
  });

  afterEach(() => {
    unregisterFileSystemIpcHandlers();
  });

  it('缺少 cwd 时应拒绝', async () => {
    const handler = getRipgrepHandler();
    const result = (await handler(
      {},
      {
        cwd: '',
        pattern: 'foo',
      },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('缺少 pattern 时应拒绝', async () => {
    const handler = getRipgrepHandler();
    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: '',
      },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('required');
  });

  it('pattern 超过 500 字符时应拒绝', async () => {
    const handler = getRipgrepHandler();
    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'a'.repeat(501),
      },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('pattern too long');
  });

  it('pattern 恰好 500 字符应被接受', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: '' });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'a'.repeat(500),
      },
    )) as { success: boolean };

    expect(result.success).toBe(true);
  });

  it('非字符串 pattern 应被拒绝', async () => {
    const handler = getRipgrepHandler();
    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 12345 as unknown as string,
      },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('pattern too long');
  });

  it('glob 超过 200 字符时应拒绝', async () => {
    const handler = getRipgrepHandler();
    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        glob: '*'.repeat(201),
      },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('glob too long');
  });

  it('glob 恰好 200 字符应被接受', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: '' });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        glob: '*.ts'.padEnd(200, 'x'),
      },
    )) as { success: boolean };

    expect(result.success).toBe(true);
  });

  it('不安全路径应被拒绝（path-access-checker outside_workspace）', async () => {
    const handler = getRipgrepHandler();
    // Wave 2 起：旧 isPathSafe 已被 path-access-checker 替代。本用例
    // 直接 mock checker 拒绝该路径，验证 fs:ripgrepSearch 把 deny 翻译成
    // success: false + 透传 actionable 错误信息。
    mocks.pathAccessCheck.mockReturnValueOnce({
      allowed: false,
      reason: {
        reasonCode: 'outside_workspace',
        message: 'access denied: /etc/shadow is outside your workspace.',
      },
    });

    const result = (await handler(
      {},
      {
        cwd: '/etc/shadow',
        pattern: 'foo',
      },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error.toLowerCase()).toMatch(
      /access denied|outside|workspace/,
    );
  });

  it('rg 退出码 1（无匹配）应返回空结果', async () => {
    const handler = getRipgrepHandler();
    const noMatchErr = new Error('rg exited with code 1') as Error & {
      code: number;
      stdout: string;
    };
    noMatchErr.code = 1;
    noMatchErr.stdout = '';
    mocks.execFileAsync.mockRejectedValue(noMatchErr);

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'nonexistent',
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(false);
  });

  it('rg 未安装（ENOENT）时应返回友好错误', async () => {
    const handler = getRipgrepHandler();
    const enoentErr = new Error('spawn rg ENOENT') as Error & {
      code: string;
    };
    enoentErr.code = 'ENOENT';
    mocks.execFileAsync.mockRejectedValue(enoentErr);

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    )) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain('ripgrep');
  });

  it('bundled rg 命中 asar 路径（ENOTDIR）时应降级尝试系统 rg', async () => {
    const handler = getRipgrepHandler();
    const previousRgPath = mocks.rgPath;
    mocks.rgPath =
      '/Applications/TabTin.app/Contents/Resources/app.asar/node_modules/@vscode/ripgrep-darwin-arm64/bin/rg';

    const enotdirErr = new Error('spawn ENOTDIR') as Error & { code: string };
    enotdirErr.code = 'ENOTDIR';
    mocks.execFileAsync
      .mockRejectedValueOnce(enotdirErr)
      .mockResolvedValueOnce({ stdout: makeMatchLines(1) });

    try {
      const result = (await handler(
        {},
        {
          cwd: '/tmp/home/proj',
          pattern: 'foo',
        },
      )) as { success: boolean; results: unknown[] };

      expect(result.success).toBe(true);
      expect(mocks.execFileAsync).toHaveBeenCalledTimes(2);
      // 第一次已 remap 到 unpacked；仍 ENOTDIR 时第二次降级系统 rg
      expect(mocks.execFileAsync.mock.calls[0][0]).toContain(
        'app.asar.unpacked',
      );
      expect(mocks.execFileAsync.mock.calls[1][0]).toBe('rg');
    } finally {
      mocks.rgPath = previousRgPath;
    }
  });
});

describe('fs:ripgrepSearch rg CLI 参数防护', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
  });

  afterEach(() => {
    unregisterFileSystemIpcHandlers();
  });

  it('应始终传递 --max-count、--max-filesize、--max-columns 防护参数', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(1) });

    await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    );

    expect(mocks.execFileAsync).toHaveBeenCalledOnce();
    const [, args, opts] = mocks.execFileAsync.mock.calls[0];

    expect(args).toContain('--max-count');
    expect(args[args.indexOf('--max-count') + 1]).toBe('50');
    expect(args).toContain('--max-filesize');
    expect(args).toContain('--max-columns');
    expect(args).toContain('--max-columns-preview');
    expect(args).toContain('--fixed-strings');

    expect(opts.maxBuffer).toBeLessThanOrEqual(10 * 1024 * 1024);
    expect(opts.timeout).toBeGreaterThan(0);
    expect(opts.timeout).toBeLessThanOrEqual(30000);
  });

  it('支持自定义 maxCount，并允许 searchPath 单文件再搜', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(1) });

    await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        maxCount: 500,
        searchPath: '/tmp/home/proj/src/a.ts',
      },
    );

    const [, args] = mocks.execFileAsync.mock.calls[0];
    expect(args[args.indexOf('--max-count') + 1]).toBe('500');
    expect(args.at(-1)).toBe('/tmp/home/proj/src/a.ts');
    // 单文件再搜不应再套目录 exclude glob
    expect(args).not.toContain('!node_modules');
  });

  it('替换预览模式不传 --max-count / --max-filesize，避免静默漏替换', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(1) });

    await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        replace: 'bar',
      },
    );

    expect(mocks.execFileAsync).toHaveBeenCalledOnce();
    const [, args] = mocks.execFileAsync.mock.calls[0];
    expect(args).toEqual(expect.arrayContaining(['--replace', 'bar']));
    expect(args).not.toContain('--max-count');
    expect(args).not.toContain('--max-filesize');
  });

  it('searchPath 越出 cwd 时拒绝搜索', async () => {
    const handler = getRipgrepHandler();

    const result = await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        searchPath: '/tmp/outside/a.ts',
      },
    );

    expect(result).toEqual({
      success: false,
      error: 'searchPath outside cwd',
      results: [],
    });
    expect(mocks.execFileAsync).not.toHaveBeenCalled();
  });

  it('应排除 node_modules、.git 等目录', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(1) });

    await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    );

    const [, args] = mocks.execFileAsync.mock.calls[0];
    const globArgs: string[] = [];
    for (let i = 0; i < args.length; i++) {
      if (args[i] === '--glob') globArgs.push(args[i + 1]);
    }

    expect(globArgs).toContain('!node_modules');
    expect(globArgs).toContain('!.git');
  });

  it('用户 glob 应被传递到 rg 参数', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(1) });

    await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        glob: '*.ts',
      },
    );

    const [, args] = mocks.execFileAsync.mock.calls[0];
    const globIdx = args.indexOf('*.ts');
    expect(globIdx).toBeGreaterThan(0);
    expect(args[globIdx - 1]).toBe('--glob');
  });

  it('搜索选项应映射为 rg 参数，并保持 smart-case 默认值', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: '' });

    await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        matchCase: true,
        wholeWord: true,
        isRegex: true,
        includeGlobs: ['src/**/*.ts'],
        excludeGlobs: ['**/*.test.ts'],
        includeIgnored: true,
      },
    );

    const [, args] = mocks.execFileAsync.mock.calls[0];
    expect(args).toEqual(
      expect.arrayContaining([
        '--case-sensitive',
        '--word-regexp',
        '--no-ignore',
        '--glob',
        'src/**/*.ts',
        '--glob',
        '!**/*.test.ts',
      ]),
    );
    expect(args).not.toContain('--fixed-strings');

    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
    await handler({}, { cwd: '/tmp/home/proj', pattern: 'foo' });
    const [, defaultArgs] = mocks.execFileAsync.mock.calls[0];
    expect(defaultArgs).toEqual(
      expect.arrayContaining(['--smart-case', '--fixed-strings']),
    );
  });

  it('应消费一行中的全部 submatches，并把 UTF-8 字节偏移换成字符偏移', async () => {
    const handler = getRipgrepHandler();
    const file = '/tmp/home/proj/source.ts';
    const line = '中文测试 foo Foobar foo 结尾\n';
    const firstByteStart = Buffer.byteLength('中文测试 ', 'utf8');
    const secondByteStart = Buffer.byteLength('中文测试 foo Foobar ', 'utf8');
    mocks.execFileAsync.mockResolvedValue({
      stdout: [
        makeRgJsonLine('begin', { path: { text: file } }),
        makeRgJsonLine('match', {
          path: { text: file },
          lines: { text: line },
          line_number: 1,
          absolute_offset: 100,
          submatches: [
            { start: firstByteStart, end: firstByteStart + 3 },
            { start: secondByteStart, end: secondByteStart + 3 },
          ],
        }),
      ].join('\n'),
    });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    )) as {
      success: boolean;
      results: Array<{
        column: number;
        matchText: string;
        text: string;
        ranges?: Array<{ start: number; end: number }>;
        byteRange?: { start: number; end: number };
      }>;
    };

    expect(result.success).toBe(true);
    expect(result.results[0]).toMatchObject({
      column: 5,
      matchText: 'foo',
      text: '中文测试 foo Foobar foo 结尾',
      ranges: [
        { start: 5, end: 8 },
        { start: 16, end: 19 },
      ],
      byteRange: { start: 100 + firstByteStart, end: 100 + firstByteStart + 3 },
    });
  });

  it('end.binary_offset 存在时应标记匹配文件为二进制', async () => {
    const handler = getRipgrepHandler();
    const file = '/tmp/home/proj/image.bin';
    mocks.execFileAsync.mockResolvedValue({
      stdout: [
        makeRgJsonLine('begin', { path: { text: file } }),
        makeRgJsonLine('match', {
          path: { text: file },
          lines: { text: 'binary foo\n' },
          line_number: 1,
          submatches: [{ start: 7, end: 10 }],
        }),
        makeRgJsonLine('end', {
          path: { text: file },
          binary_offset: 7,
        }),
      ].join('\n'),
    });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    )) as { results: Array<{ isBinary?: boolean }> };

    expect(result.results[0]?.isBinary).toBe(true);
  });

  it('rg exit code 2 应返回结构化 invalid_pattern', async () => {
    const handler = getRipgrepHandler();
    const invalidPatternError = new Error('regex parse error') as Error & {
      code: number;
      stderr: string;
    };
    invalidPatternError.code = 2;
    invalidPatternError.stderr = 'regex parse error: unclosed group\n';
    mocks.execFileAsync.mockRejectedValue(invalidPatternError);

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: '(unclosed',
        isRegex: true,
      },
    )) as { success: boolean; errorCode?: string; error?: string };

    expect(result).toMatchObject({
      success: false,
      errorCode: 'invalid_pattern',
      error: 'regex parse error: unclosed group',
    });
  });

  it('取消应终止带 signal 的 rg，并清理 requestId 映射', async () => {
    const handler = getRipgrepHandler();
    const cancelHandler = getHandler('fs:ripgrepSearchCancel');
    mocks.execFileAsync.mockImplementation(
      (_command: string, _args: string[], options: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.signal?.addEventListener(
            'abort',
            () => {
              const error = new Error('aborted') as Error & { code: string };
              error.name = 'AbortError';
              error.code = 'ABORT_ERR';
              reject(error);
            },
            { once: true },
          );
        }),
    );

    const searchPromise = handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        requestId: 'request-cancel-1',
      },
    );
    await Promise.resolve();
    expect(mocks.execFileAsync.mock.calls[0][2].signal).toBeInstanceOf(
      AbortSignal,
    );

    const cancelResult = await cancelHandler({}, 'request-cancel-1');
    const searchResult = (await searchPromise) as {
      success: boolean;
      canceled?: boolean;
    };

    expect(cancelResult).toMatchObject({ success: true, canceled: true });
    expect(searchResult).toMatchObject({ success: false, canceled: true });
    expect(await cancelHandler({}, 'request-cancel-1')).toMatchObject({
      success: true,
      canceled: false,
    });
  });

  it('Windows packaged 环境应执行 app.asar.unpacked 内的 rg.exe', async () => {
    const handler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({ stdout: makeMatchLines(1) });

    await handler(
      {},
      {
        cwd: 'C:\\Users\\me\\Documents\\project',
        pattern: 'foo',
      },
    );

    const [command] = mocks.execFileAsync.mock.calls[0];
    expect(command).toContain('app.asar.unpacked');
    expect(command).not.toContain('app.asar\\node_modules');
    expect(command).toContain('rg.exe');
  });

  it('bundled rg.exe EFTYPE 时应回退到 PATH 中的 rg', async () => {
    const handler = getRipgrepHandler();
    const eftypeErr = new Error('spawn EFTYPE') as Error & { code: string };
    eftypeErr.code = 'EFTYPE';
    mocks.execFileAsync
      .mockRejectedValueOnce(eftypeErr)
      .mockResolvedValueOnce({ stdout: makeMatchLines(1) });

    const result = (await handler(
      {},
      {
        cwd: 'C:\\Users\\me\\Documents\\project',
        pattern: 'foo',
      },
    )) as { success: boolean; results: unknown[] };

    expect(result.success).toBe(true);
    expect(result.results).toHaveLength(1);
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(2);
    expect(mocks.execFileAsync.mock.calls[0][0]).toContain('app.asar.unpacked');
    expect(mocks.execFileAsync.mock.calls[1][0]).toBe('rg');
  });

  it('fallback rg 返回无匹配时应保留空结果语义', async () => {
    const handler = getRipgrepHandler();
    const eftypeErr = new Error('spawn EFTYPE') as Error & { code: string };
    eftypeErr.code = 'EFTYPE';
    const noMatchErr = new Error('rg exited with code 1') as Error & {
      code: number;
      stdout: string;
    };
    noMatchErr.code = 1;
    noMatchErr.stdout = '';
    mocks.execFileAsync
      .mockRejectedValueOnce(eftypeErr)
      .mockRejectedValueOnce(noMatchErr);

    const result = (await handler(
      {},
      {
        cwd: 'C:\\Users\\me\\Documents\\project',
        pattern: 'missing',
      },
    )) as { success: boolean; results: unknown[]; truncated: boolean };

    expect(result.success).toBe(true);
    expect(result.results).toEqual([]);
    expect(result.truncated).toBe(false);
    expect(mocks.execFileAsync).toHaveBeenCalledTimes(2);
  });

  it('bundled rg fallback 到系统 rg 时应保留 exit code 2 的 invalid_pattern', async () => {
    const handler = getRipgrepHandler();
    const eftypeErr = new Error('spawn EFTYPE') as Error & { code: string };
    eftypeErr.code = 'EFTYPE';
    const invalidPatternErr = new Error('regex parse error') as Error & {
      code: number;
      stderr: string;
    };
    invalidPatternErr.code = 2;
    invalidPatternErr.stderr = 'regex parse error: unclosed group\n';
    mocks.execFileAsync
      .mockRejectedValueOnce(eftypeErr)
      .mockRejectedValueOnce(invalidPatternErr);

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: '(unclosed',
        isRegex: true,
      },
    )) as { success: boolean; errorCode?: string; error?: string };

    expect(result).toMatchObject({
      success: false,
      errorCode: 'invalid_pattern',
      error: 'regex parse error: unclosed group',
    });
  });

  it('glob/path 参数错误不得误报为 invalid_pattern', async () => {
    const handler = getRipgrepHandler();
    const parameterErr = new Error('glob error: invalid glob') as Error & {
      code: number;
      stderr: string;
    };
    parameterErr.code = 2;
    parameterErr.stderr = 'glob error: invalid glob **[.ts';
    mocks.execFileAsync.mockRejectedValue(parameterErr);

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        glob: '**[.ts',
        isRegex: false,
      },
    )) as { success: boolean; errorCode?: string; error?: string };

    expect(result.success).toBe(false);
    expect(result.errorCode).not.toBe('invalid_pattern');
    expect(result.error).toContain('glob error');
  });
});

// RP-017: concurrency control
describe('fs:ripgrepSearch 并发控制 (RP-017)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
  });

  afterEach(() => {
    unregisterFileSystemIpcHandlers();
  });

  it('并发请求超过 4 个时应排队而非全部并行', async () => {
    const handler = getRipgrepHandler();
    let activeCount = 0;
    let peakCount = 0;

    mocks.execFileAsync.mockImplementation(() => {
      activeCount++;
      peakCount = Math.max(peakCount, activeCount);
      return new Promise((resolve) => {
        setTimeout(() => {
          activeCount--;
          resolve({ stdout: makeMatchLines(1) });
        }, 50);
      });
    });

    const requests = Array.from({ length: 8 }, () =>
      handler({}, { cwd: '/tmp/home/proj', pattern: 'foo', maxResults: 10 }),
    );

    await Promise.all(requests);

    expect(peakCount).toBeLessThanOrEqual(4);
    expect(peakCount).toBeGreaterThan(0);
  });
});

describe('fs:ripgrepSearch replacement 预览', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
  });

  afterEach(() => {
    unregisterFileSystemIpcHandlers();
  });

  it('固定字符串应转义 dollar，regex 应保留捕获组语义并传递全部 submatch', async () => {
    const handler = getRipgrepHandler();
    const file = '/tmp/home/proj/source.ts';
    mocks.execFileAsync.mockResolvedValue({
      stdout: [
        makeRgJsonLine('begin', { path: { text: file } }),
        makeRgJsonLine('match', {
          path: { text: file },
          lines: { text: 'foo bar foo\n' },
          line_number: 1,
          absolute_offset: 0,
          submatches: [
            {
              match: { text: 'foo' },
              replacement: { text: '$1' },
              start: 0,
              end: 3,
            },
            {
              match: { text: 'foo' },
              replacement: { text: '$1' },
              start: 8,
              end: 11,
            },
          ],
        }),
      ].join('\n'),
    });

    await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
        replace: '$1',
      },
    );
    const [, fixedArgs] = mocks.execFileAsync.mock.calls[0];
    expect(fixedArgs).toEqual(expect.arrayContaining(['--replace', '$$1']));

    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
    const regexHandler = getRipgrepHandler();
    mocks.execFileAsync.mockResolvedValue({
      stdout: [
        makeRgJsonLine('begin', { path: { text: file } }),
        makeRgJsonLine('match', {
          path: { text: file },
          lines: { text: 'foo bar\n' },
          line_number: 1,
          absolute_offset: 0,
          submatches: [
            {
              match: { text: 'foo bar' },
              replacement: { text: 'foo-bar' },
              start: 0,
              end: 7,
            },
          ],
        }),
      ].join('\n'),
    });
    const result = (await regexHandler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: '(foo) (bar)',
        isRegex: true,
        replace: '$1-$2',
      },
    )) as {
      results: Array<{
        replacements?: Array<{ matchText: string; replacement: string }>;
      }>;
    };
    const [, regexArgs] = mocks.execFileAsync.mock.calls[0];
    expect(regexArgs).toEqual(expect.arrayContaining(['--replace', '$1-$2']));
    expect(result.results[0]?.replacements).toEqual([
      expect.objectContaining({ matchText: 'foo bar', replacement: 'foo-bar' }),
    ]);
  });

  it('中文和 emoji 的 UTF-8 byte offset 应换算成可切片的 JavaScript 字符范围', async () => {
    const handler = getRipgrepHandler();
    const file = '/tmp/home/proj/source.ts';
    const line = '中文 😀 foo\n';
    const start = Buffer.byteLength('中文 😀 ', 'utf8');
    mocks.execFileAsync.mockResolvedValue({
      stdout: [
        makeRgJsonLine('begin', { path: { text: file } }),
        makeRgJsonLine('match', {
          path: { text: file },
          lines: { text: line },
          line_number: 1,
          absolute_offset: 100,
          submatches: [{ match: { text: 'foo' }, start, end: start + 3 }],
        }),
      ].join('\n'),
    });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo',
      },
    )) as {
      results: Array<{
        matchText: string;
        ranges?: Array<{ start: number; end: number }>;
        byteRange?: { start: number; end: number };
      }>;
    };
    expect(result.results[0]).toMatchObject({
      matchText: 'foo',
      ranges: [{ start: 6, end: 9 }],
      byteRange: { start: 100 + start, end: 100 + start + 3 },
    });
  });

  it('缺失 replacement.text 标记为 invalid preview，但空字符串仍是合法删除预览', async () => {
    const handler = getRipgrepHandler();
    const file = '/tmp/home/proj/source.ts';
    mocks.execFileAsync.mockResolvedValue({
      stdout: [
        makeRgJsonLine('begin', { path: { text: file } }),
        makeRgJsonLine('match', {
          path: { text: file },
          lines: { text: 'foo bar\n' },
          line_number: 1,
          absolute_offset: 0,
          submatches: [
            { match: { text: 'foo' }, start: 0, end: 3 },
            {
              match: { text: 'bar' },
              replacement: { text: '' },
              start: 4,
              end: 7,
            },
          ],
        }),
      ].join('\n'),
    });

    const result = (await handler(
      {},
      {
        cwd: '/tmp/home/proj',
        pattern: 'foo|bar',
        isRegex: true,
        replace: '',
      },
    )) as {
      results: Array<{
        replacements?: Array<{
          replacement?: string;
          replacementError?: string;
        }>;
      }>;
    };
    expect(result.results[0]?.replacements).toEqual([
      expect.objectContaining({ replacementError: 'missing_preview' }),
      expect.objectContaining({ replacement: '' }),
    ]);
  });
});

describe('fs:replaceInFiles 安全替换', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerFileSystemIpcHandlers();
  });

  afterEach(() => {
    unregisterFileSystemIpcHandlers();
  });

  it('按 byte offset 降序替换，保留 CRLF，并返回逐文件汇总', async () => {
    const handler = getReplaceHandler();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'tabtin-replace-'));
    const first = path.join(root, 'first.txt');
    const second = path.join(root, 'second.txt');
    const firstBuffer = Buffer.from('中文 😀 foo\r\nfoo\r\n', 'utf8');
    await fs.writeFile(first, firstBuffer);
    await fs.writeFile(second, 'foo\n', 'utf8');
    try {
      const firstStart = firstBuffer.indexOf(Buffer.from('foo'));
      const secondStart = firstBuffer.lastIndexOf(Buffer.from('foo'));
      const result = (await handler(
        {},
        {
          rootPath: root,
          edits: [
            {
              file: first,
              byteStart: firstStart,
              byteEnd: firstStart + 3,
              expectedText: 'foo',
              replacement: '$1',
            },
            {
              file: first,
              byteStart: secondStart,
              byteEnd: secondStart + 3,
              expectedText: 'foo',
              replacement: 'bar',
            },
            {
              file: second,
              byteStart: 0,
              byteEnd: 3,
              expectedText: 'foo',
              replacement: 'baz',
            },
          ],
        },
      )) as {
        success: boolean;
        totalReplacements: number;
        files: Array<{ status: string }>;
      };
      expect(result).toMatchObject({ success: true, totalReplacements: 3 });
      expect(result.files.every((file) => file.status === 'success')).toBe(
        true,
      );
      expect(await fs.readFile(first, 'utf8')).toBe('中文 😀 $1\r\nbar\r\n');
      expect(await fs.readFile(second, 'utf8')).toBe('baz\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('过期 expectedText、重叠范围、越界路径和二进制文件都不会写入', async () => {
    const handler = getReplaceHandler();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-replace-safety-'),
    );
    const stale = path.join(root, 'stale.txt');
    const overlap = path.join(root, 'overlap.txt');
    const binary = path.join(root, 'binary.bin');
    const binaryOutput = path.join(root, 'binary-output.txt');
    await fs.writeFile(stale, 'new\n', 'utf8');
    await fs.writeFile(overlap, 'abcdef\n', 'utf8');
    await fs.writeFile(binary, Buffer.from([0x66, 0x00, 0x6f, 0x6f]));
    await fs.writeFile(binaryOutput, 'foo\n', 'utf8');
    try {
      const result = (await handler(
        {},
        {
          rootPath: root,
          edits: [
            {
              file: stale,
              byteStart: 0,
              byteEnd: 3,
              expectedText: 'old',
              replacement: 'x',
            },
            {
              file: overlap,
              byteStart: 0,
              byteEnd: 3,
              expectedText: 'abc',
              replacement: 'x',
            },
            {
              file: overlap,
              byteStart: 2,
              byteEnd: 5,
              expectedText: 'cde',
              replacement: 'y',
            },
            {
              file: binary,
              byteStart: 0,
              byteEnd: 3,
              expectedText: 'foo',
              replacement: 'bar',
            },
            {
              file: binaryOutput,
              byteStart: 0,
              byteEnd: 3,
              expectedText: 'foo',
              replacement: '\u0000',
            },
            {
              file: path.join(root, '..', 'outside.txt'),
              byteStart: 0,
              byteEnd: 1,
              expectedText: 'x',
              replacement: 'y',
            },
          ],
        },
      )) as {
        files: Array<{ file: string; status: string; reason?: string }>;
      };
      expect(result.files).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            file: stale,
            status: 'skipped',
            reason: 'stale_file',
          }),
          expect.objectContaining({
            file: overlap,
            status: 'skipped',
            reason: 'overlapping_edits',
          }),
          expect.objectContaining({
            file: binary,
            status: 'skipped',
            reason: 'binary_file',
          }),
          expect.objectContaining({
            file: binaryOutput,
            status: 'skipped',
            reason: 'binary_output',
          }),
          expect.objectContaining({
            status: 'skipped',
            reason: 'outside_root',
          }),
        ]),
      );
      expect(await fs.readFile(stale, 'utf8')).toBe('new\n');
      expect(await fs.readFile(overlap, 'utf8')).toBe('abcdef\n');
      expect((await fs.readFile(binary)).toString('hex')).toBe('66006f6f');
      expect(await fs.readFile(binaryOutput, 'utf8')).toBe('foo\n');
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('路径权限拒绝时返回失败文件，不写入目标', async () => {
    const handler = getReplaceHandler();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-replace-permission-'),
    );
    const file = path.join(root, 'source.txt');
    await fs.writeFile(file, 'foo', 'utf8');
    mocks.pathAccessCheck.mockReturnValueOnce({
      allowed: false,
      reason: { reasonCode: 'DENY', message: 'denied' },
    });
    try {
      const result = (await handler(
        {},
        {
          rootPath: root,
          edits: [
            {
              file,
              byteStart: 0,
              byteEnd: 3,
              expectedText: 'foo',
              replacement: 'bar',
            },
          ],
        },
      )) as { success: boolean; error?: string; files: unknown[] };
      expect(result.success).toBe(false);
      expect(result.files).toEqual([]);
      expect(await fs.readFile(file, 'utf8')).toBe('foo');
    } finally {
      mocks.pathAccessCheck.mockReset();
      mocks.pathAccessCheck.mockImplementation(() => ({ allowed: true }));
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('同一 canonical 文件并发替换时，后一个请求返回 replace_in_progress', async () => {
    const handler = getReplaceHandler();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-replace-inflight-'),
    );
    const file = path.join(root, 'same.txt');
    await fs.writeFile(file, 'foo', 'utf8');
    let releaseWrite: (() => void) | undefined;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const writeSpy = vi
      .spyOn(fs, 'writeFile')
      .mockImplementation(async (...args) => {
        await writeBlocked;
        void args;
        return undefined;
      });
    const request = {
      rootPath: root,
      edits: [
        {
          file,
          byteStart: 0,
          byteEnd: 3,
          expectedText: 'foo',
          replacement: 'bar',
        },
      ],
    };
    try {
      const first = handler({}, request);
      await new Promise((resolve) => setTimeout(resolve, 0));
      const second = (await handler({}, request)) as { error?: string };
      expect(second.error).toBe('replace_in_progress');
      releaseWrite?.();
      await first;
    } finally {
      releaseWrite?.();
      writeSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('canonical 文件 identity 在读取后变化时拒绝写回', async () => {
    const handler = getReplaceHandler();
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), 'tabtin-replace-identity-'),
    );
    const file = path.join(root, 'identity.txt');
    const moved = path.join(root, 'identity.old.txt');
    await fs.writeFile(file, 'foo', 'utf8');
    const originalReadFile = fs.readFile;
    let readCount = 0;
    const readSpy = vi
      .spyOn(fs, 'readFile')
      .mockImplementation(async (...args) => {
        const value = await originalReadFile(...args);
        if (++readCount === 1) {
          await fs.rename(file, moved);
          await fs.writeFile(file, 'foo', 'utf8');
        }
        return value;
      });
    try {
      const result = (await handler(
        {},
        {
          rootPath: root,
          edits: [
            {
              file,
              byteStart: 0,
              byteEnd: 3,
              expectedText: 'foo',
              replacement: 'bar',
            },
          ],
        },
      )) as { files: Array<{ reason?: string }> };
      expect(result.files).toEqual([
        expect.objectContaining({ reason: 'stale_file' }),
      ]);
      expect(await fs.readFile(file, 'utf8')).toBe('foo');
    } finally {
      readSpy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
