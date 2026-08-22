/**
 * Regression tests for grep_search safety fixes:
 * RP-013: maxBuffer overflow partial stdout recovery
 * RP-014: max_results enforcement with ceiling
 * RP-015: --max-filesize flag
 * RP-016: --max-columns flag
 * RP-017: concurrency semaphore
 * RP-019: context_lines upper bound clamping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFile } from 'node:child_process';

vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal() as any;
  return {
    ...actual,
    execFile: vi.fn(),
  };
});

import { codeGlobTool, codeGrepTool } from '../index';

const mockedExecFile = vi.mocked(execFile);

function setupExecFileMock(
  behavior: 'success' | 'no-match' | 'maxbuffer' | 'error',
  stdout = '',
  stderr = '',
) {
  mockedExecFile.mockImplementation((_cmd: any, _args: any, _opts: any, cb: any) => {
    const callback = typeof _opts === 'function' ? _opts : cb;
    switch (behavior) {
      case 'success':
        callback(null, stdout, stderr);
        break;
      case 'no-match': {
        const err: any = new Error('exit 1');
        err.code = 1;
        callback(err, '', '');
        break;
      }
      case 'maxbuffer': {
        const err: any = new Error('stdout maxBuffer length exceeded');
        err.code = 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
        callback(err, stdout, '');
        break;
      }
      case 'error': {
        const err: any = new Error(stderr || 'rg crashed');
        err.code = 2;
        callback(err, '', stderr);
        break;
      }
    }
    return {} as any;
  });
}

describe('grep_search safety fixes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // RP-013
  describe('RP-013: maxBuffer overflow recovery', () => {
    it('should recover partial stdout when maxBuffer overflows', async () => {
      const partialData = 'file.ts:1:partial match\nfile.ts:2:another match\n';
      setupExecFileMock('maxbuffer', partialData);

      const result = await codeGrepTool.execute({
        pattern: 'test',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(true);
      expect(result.data?.output).toContain('partial match');
    });

    it('should return empty string when maxBuffer overflows with no stdout', async () => {
      setupExecFileMock('maxbuffer', '');

      const result = await codeGrepTool.execute({
        pattern: 'test',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(true);
      expect(result.data?.output).toBe('');
    });
  });

  // RP-014
  describe('RP-014: max_results enforcement', () => {
    it('should use default max_results when not specified', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const mIndex = args.indexOf('-m');
      expect(mIndex).toBeGreaterThan(-1);
      expect(parseInt(args[mIndex + 1])).toBe(500);
    });

    it('should cap max_results at ceiling (2000)', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        max_results: 99999,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const mIndex = args.indexOf('-m');
      expect(parseInt(args[mIndex + 1])).toBe(2000);
    });

    it('should always pass -m flag even when max_results is null', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        max_results: null,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).toContain('-m');
    });
  });

  // RP-015
  describe('RP-015: --max-filesize protection', () => {
    it('should include --max-filesize 1M flag', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('--max-filesize');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('1M');
    });
  });

  // RP-016
  describe('RP-016: --max-columns protection', () => {
    it('should include --max-columns and --max-columns-preview flags', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('--max-columns');
      expect(idx).toBeGreaterThan(-1);
      expect(args[idx + 1]).toBe('500');
      expect(args).toContain('--max-columns-preview');
    });
  });

  // RP-019
  describe('RP-019: context lines clamping', () => {
    it('should clamp context_lines to 20', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        context_lines: 10000,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('-C');
      expect(idx).toBeGreaterThan(-1);
      expect(parseInt(args[idx + 1])).toBe(20);
    });

    it('should clamp after_context to 20', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        after_context: 5000,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('-A');
      expect(idx).toBeGreaterThan(-1);
      expect(parseInt(args[idx + 1])).toBe(20);
    });

    it('should clamp before_context to 20', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        before_context: 9999,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('-B');
      expect(idx).toBeGreaterThan(-1);
      expect(parseInt(args[idx + 1])).toBe(20);
    });

    it('should pass small context values unchanged', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'test',
        context_lines: 5,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const idx = args.indexOf('-C');
      expect(parseInt(args[idx + 1])).toBe(5);
    });
  });

  // General error handling
  describe('error handling', () => {
    it('should handle rg no-match (exit code 1) gracefully', async () => {
      setupExecFileMock('no-match');

      const result = await codeGrepTool.execute({
        pattern: 'nonexistent',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(true);
      // T2-C8 (2026-05-12)：action 层 0 匹配仍返空字符串（adapter 层 T2-C1
      // 把空字符串 → "No matches found." / "No files found." 等文案）。
      // 此处只钉死 action 层不再做 100K 二级截断，输出原样透传。
      expect(result.data?.output).toBe('');
    });

    it('should propagate real errors', async () => {
      setupExecFileMock('error', '', 'rg: regex parse error');

      const result = await codeGrepTool.execute({
        pattern: '[invalid',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(false);
      expect(result.error).toContain('regex parse error');
    });
  });

  // T2-C2 (2026-05-12)：VCS 目录排除
  describe('T2-C2: VCS 目录排除', () => {
    it('应该显式排除 6 个 VCS 目录（.git/.svn/.hg/.bzr/.jj/.sl）', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      // 6 个 VCS 目录每个跟一对 --glob !DIR
      const vcsDirs = ['.git', '.svn', '.hg', '.bzr', '.jj', '.sl'];
      for (const dir of vcsDirs) {
        const negativeGlob = `!${dir}`;
        const idx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === negativeGlob);
        expect(idx, `VCS dir "${dir}" should be excluded via --glob !${dir}`).toBeGreaterThan(-1);
      }
    });

    it('VCS 排除位置在 max-columns 之后、pattern 之前（不被用户 glob 覆盖）', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        glob: '*.ts',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const maxColumnsIdx = args.indexOf('--max-columns');
      const firstVcsIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '!.git');
      const userGlobIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.ts');
      expect(maxColumnsIdx).toBeGreaterThan(-1);
      expect(firstVcsIdx).toBeGreaterThan(maxColumnsIdx);
      // 用户 glob 通过 T2-C7 split 加入；VCS 排除独立分组
      expect(userGlobIdx).toBeGreaterThan(-1);
    });

    it('VCS 排除必须在用户 glob 之后（ripgrep last-match-wins，T2-M1 reviewer 反馈）', async () => {
      // **背景**：ripgrep 多 `--glob` 规则是 "last match wins"，不是 "negative
      // 优先"。如果用户传 `glob: "**/*"` 后又有 `--glob '!.git'`，最后一条 `!.git`
      // 胜出，`.git/...` 被排除（正确）。如果顺序反了（VCS 在前 + 用户 glob 在后），
      // 用户 `**/*` 会"重新匹中" `.git/...` 文件，破坏 VCS 排除。
      //
      // **本测试钉死 args 顺序**：用户 glob 必须先于 VCS 排除 push。如果未来按
      // "VCS 是基础设施层应该最先" 重构，本测试会立即报警。
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        glob: '**/*',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const userGlobIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '**/*');
      const firstVcsIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '!.git');
      expect(userGlobIdx).toBeGreaterThan(-1);
      expect(firstVcsIdx).toBeGreaterThan(-1);
      expect(firstVcsIdx).toBeGreaterThan(userGlobIdx);
    });
  });

  // T2-C3 (2026-05-12)：pattern 以 `-` 开头用 `-e` flag
  describe('T2-C3: pattern 以 `-` 开头防护', () => {
    it('pattern 以 `-` 开头时用 -e flag（不是 `--`）', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: '-flag',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const eIdx = args.indexOf('-e');
      expect(eIdx).toBeGreaterThan(-1);
      expect(args[eIdx + 1]).toBe('-flag');
      // 确认没有用 `--` 分隔符
      expect(args).not.toContain('--');
    });

    it('pattern 不以 `-` 开头时用 `--` 分隔符（保留原行为）', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'normal_pattern',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const dashIdx = args.indexOf('--');
      expect(dashIdx).toBeGreaterThan(-1);
      expect(args[dashIdx + 1]).toBe('normal_pattern');
      // 没有用 `-e` flag
      expect(args).not.toContain('-e');
    });
  });

  // T2-C7 (2026-05-12)：glob 参数智能 split
  describe('T2-C7: glob 参数空格 / 逗号 split', () => {
    it('空格分隔 → 多个 --glob flag', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        glob: '*.ts *.tsx',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const tsIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.ts');
      const tsxIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.tsx');
      expect(tsIdx).toBeGreaterThan(-1);
      expect(tsxIdx).toBeGreaterThan(-1);
    });

    it('逗号分隔 → 多个 --glob flag', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        glob: '*.py,*.go',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const pyIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.py');
      const goIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.go');
      expect(pyIdx).toBeGreaterThan(-1);
      expect(goIdx).toBeGreaterThan(-1);
    });

    it('花括号整体保留不被内部逗号 split', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        glob: '*.{ts,tsx}',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      // 整体作为一个 glob，不被 split 成 *.{ts 和 tsx}
      const braceIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.{ts,tsx}');
      expect(braceIdx).toBeGreaterThan(-1);
      // 不应该出现错误的 split 结果
      expect(args).not.toContain('*.{ts');
      expect(args).not.toContain('tsx}');
    });

    it('混合空格 + 花括号正确处理', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        glob: '*.{ts,tsx} *.py',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const braceIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.{ts,tsx}');
      const pyIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '*.py');
      expect(braceIdx).toBeGreaterThan(-1);
      expect(pyIdx).toBeGreaterThan(-1);
    });
  });

  // T2 follow-up B2 (2026-05-12)：默认 --hidden + env override 防御
  // 默认开 `--hidden`
  describe('T2 follow-up B2: 默认 --hidden + TABTIN_GREP_HIDDEN env 兜底', () => {
    afterEach(() => {
      delete process.env.TABTIN_GREP_HIDDEN;
    });

    it('默认 args 含 --hidden（搜 .vscode/.cursor/.env* 等隐藏配置）', async () => {
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--hidden');
    });

    it('TABTIN_GREP_HIDDEN=false 关闭 --hidden（dogfood / CI 兜底）', async () => {
      process.env.TABTIN_GREP_HIDDEN = 'false';
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--hidden');
    });

    it('TABTIN_GREP_HIDDEN=0 / no 也关闭（兼容多种 falsy 写法）', async () => {
      process.env.TABTIN_GREP_HIDDEN = '0';
      setupExecFileMock('success', '');
      await codeGrepTool.execute({
        pattern: 'foo',
        _workspace_root: '/tmp/test-workspace',
      } as any);
      expect((mockedExecFile.mock.calls[0]?.[1] as string[])).not.toContain('--hidden');

      vi.clearAllMocks();
      process.env.TABTIN_GREP_HIDDEN = 'no';
      setupExecFileMock('success', '');
      await codeGrepTool.execute({
        pattern: 'foo',
        _workspace_root: '/tmp/test-workspace',
      } as any);
      expect((mockedExecFile.mock.calls[0]?.[1] as string[])).not.toContain('--hidden');
    });

    it('--hidden 跟 VCS 排除共存：不引入 .git/objects 噪音', async () => {
      // VCS 排除（.git/.svn/...）独立显式排，--hidden 只放开非 VCS 的隐藏路径
      // （.vscode/.env*/.github/）。本测试钉死两条规则共存：
      setupExecFileMock('success', '');

      await codeGrepTool.execute({
        pattern: 'foo',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--hidden');
      // VCS 排除依然在
      expect(args.findIndex((a, i) => args[i - 1] === '--glob' && a === '!.git')).toBeGreaterThan(-1);
    });
  });

  // T2-C8 (2026-05-12)：删除 100K 二级截断
  describe('T2-C8: 100K 二级截断已移除', () => {
    it('action 层不再 slice(0, 100_000)；输出原样透传给 adapter', async () => {
      // 模拟 200K 输出（> 旧 100K 上限）—— 应当原样返回，不被砍
      const bigOutput = 'a'.repeat(200_000);
      setupExecFileMock('success', bigOutput);

      const result = await codeGrepTool.execute({
        pattern: 'foo',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(true);
      expect(result.data?.output).toBe(bigOutput);
      // 截断责任由 adapter applyHeadLimit + runtime maxResultSizeChars=20K 兜底
    });
  });

  // T2-B1 (2026-05-12)：glob_search 底层换 ripgrep --files，规则见 src/utils/glob.ts
  describe('T2-B1: glob_search 使用 ripgrep --files', () => {
    afterEach(() => {
      delete process.env.TABTIN_GLOB_HIDDEN;
      delete process.env.TABTIN_GLOB_INCLUDE_IGNORED;
    });

    it('默认 args 含 --files / --hidden，且不传正向 --glob（避免 whitelist .gitignore 文件）', async () => {
      setupExecFileMock('success', 'src/a.ts\n');

      const result = await codeGlobTool.execute({
        glob_pattern: '*.ts',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(true);
      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--files');
      expect(args).not.toContain('**/*.ts');
      expect(args).toContain('--hidden');
      expect(args).not.toContain('--no-ignore');
      expect(args).toContain('--sort=path'); // NODE_ENV=test 稳定排序
    });

    it('TABTIN_GLOB_HIDDEN=false 关闭 --hidden', async () => {
      process.env.TABTIN_GLOB_HIDDEN = 'false';
      setupExecFileMock('success', 'src/a.ts\n');

      await codeGlobTool.execute({
        glob_pattern: '*.ts',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).not.toContain('--hidden');
    });

    it('include_ignored=true 开启 --no-ignore', async () => {
      setupExecFileMock('success', 'src/a.ts\n');

      await codeGlobTool.execute({
        glob_pattern: '*.ts',
        include_ignored: true,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--no-ignore');
    });

    it('TABTIN_GLOB_INCLUDE_IGNORED=true 同款开启 --no-ignore（dogfood 兜底）', async () => {
      process.env.TABTIN_GLOB_INCLUDE_IGNORED = 'true';
      setupExecFileMock('success', 'src/a.ts\n');

      await codeGlobTool.execute({
        glob_pattern: '*.ts',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      expect(args).toContain('--no-ignore');
    });

    it('VCS / node_modules / 系统文件排除仍传给 ripgrep', async () => {
      setupExecFileMock('success', 'src/a.ts\n');

      await codeGlobTool.execute({
        glob_pattern: '**/*',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      const gitIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '!.git');
      const nodeModulesIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '!node_modules');
      const dsStoreIdx = args.findIndex((a, i) => args[i - 1] === '--glob' && a === '!.DS_Store');
      expect(gitIdx).toBeGreaterThan(-1);
      expect(nodeModulesIdx).toBeGreaterThan(-1);
      expect(dsStoreIdx).toBeGreaterThan(-1);
    });

    it('换 ripgrep 后不再限制 10 个 wildcard', async () => {
      setupExecFileMock('success', 'src/a.ts\n');
      const manyWildcards = 'a/**/b/**/c/**/d/**/e/**/f/**/g/**/h/**/i/**/j/**/k/**/*.ts';

      const result = await codeGlobTool.execute({
        glob_pattern: manyWildcards,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(true);
      const args = mockedExecFile.mock.calls[0]?.[1] as string[];
      // 正向 pattern 不传给 rg，而是在 rg --files 输出后用本地 matcher 过滤；
      // 因此这里断言没有因为 10 个以上 wildcard 被拒绝即可。
      expect(args).toContain('--files');
    });

    it('绝对 glob_pattern 的 baseDir 在 workspace 外 → 拒绝且不调用 rg', async () => {
      setupExecFileMock('success', '');

      const result = await codeGlobTool.execute({
        glob_pattern: '/tmp/outside-workspace/**/*.ts',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/outside the search directory/i);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });

    it('UNC glob_pattern → 拒绝且不调用 rg（防 SMB/NTLM）', async () => {
      setupExecFileMock('success', '');

      const result = await codeGlobTool.execute({
        glob_pattern: '\\\\server\\share\\**\\*.ts',
        _workspace_root: '/tmp/test-workspace',
      } as any);

      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/UNC paths are not supported/i);
      expect(mockedExecFile).not.toHaveBeenCalled();
    });
  });
});
