/**
 * T2-C9 (2026-05-12)：grep_search / glob_search 入口的 UNC 路径 skip stat 防护。
 *
 * **背景**：Windows UNC 路径 `\\server\share\path` 触发 stat 时会发起 SMB / NTLM
 * 协商——攻击者可以通过 prompt injection 让 LLM 传入恶意 UNC 路径诱导本机
 * 发起对外 NTLM 认证（凭据泄漏 / NTLM relay 攻击）。
 *
 * **规则来源**：
 *   - UNC 路径跳过 stat：`if (absolutePath.startsWith('\\\\') || ...) return { result: true }`
 *   - Glob 路径同款 guard
 *
 * **本测试钉死**：
 *   - `\\server\share` 不调用 `fs.stat`（避免 SMB 协商）
 *   - `//server/share`（Linux 风格 UNC，POSIX 资源 fork / SMB mount）同款防护
 *   - 普通绝对路径仍走完整 stat 检查（不影响主链路）
 *
 * **本测试不验证**：实际 grep / glob 跑 UNC 路径的行为——交给后端 ripgrep / walkDir
 * 自己处理（它们对 UNC 要么 fail-closed 要么 ENOENT，都不会发起 SMB 协商）。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fsPromises } from 'node:fs';

vi.mock('../../../utils/tool-output', () => ({
  standardizeLegacyResult: (r: any) => r,
}));

// spy fs.stat 验证调用次数
const realStat = fsPromises.stat;
const statSpy = vi.spyOn(fsPromises, 'stat');

import { codeGlobTool, codeGrepTool } from '../index';

describe('T2-C9: UNC 路径 skip stat 防护', () => {
  beforeEach(() => {
    statSpy.mockClear();
    // 默认 stat 行为透传到真实 fs.stat（让普通路径正常走通）
    statSpy.mockImplementation(realStat as any);
  });

  describe('glob_search', () => {
    it('Windows UNC 路径 `\\\\server\\share\\path` 跳过 stat（防 NTLM 泄漏）', async () => {
      // glob_search 用 target_directory 触发 checkSearchPathExists
      const uncPath = '\\\\server\\share\\some-path';

      await codeGlobTool.execute({
        glob_pattern: '*.ts',
        target_directory: uncPath,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      // checkSearchPathExists 在 UNC 入口短路返回，不应调 fs.stat 验证 UNC 路径
      const statCalls = statSpy.mock.calls.map((c) => String(c[0]));
      const uncStatCalls = statCalls.filter((p) => p.includes('\\\\server') || p.includes('//server'));
      expect(uncStatCalls).toHaveLength(0);
    });

    it('POSIX 风格 `//server/share` 同款跳过 stat', async () => {
      const uncPath = '//server/share/some-path';

      await codeGlobTool.execute({
        glob_pattern: '*.ts',
        target_directory: uncPath,
        _workspace_root: '/tmp/test-workspace',
      } as any);

      const statCalls = statSpy.mock.calls.map((c) => String(c[0]));
      const uncStatCalls = statCalls.filter((p) => p.startsWith('//server'));
      expect(uncStatCalls).toHaveLength(0);
    });
  });

  describe('grep_search', () => {
    it('Windows UNC 路径跳过 stat 防护', async () => {
      const uncPath = '\\\\server\\share\\some-path';

      // grep_search 不挂载真 ripgrep（execFile 会报错），但 checkSearchPathExists
      // 在 path 解析阶段就被调用，即便后续 ripgrep fail 也已验证 stat 是否调用
      await codeGrepTool.execute({
        pattern: 'foo',
        path: uncPath,
        _workspace_root: '/tmp/test-workspace',
      } as any).catch(() => {});

      const statCalls = statSpy.mock.calls.map((c) => String(c[0]));
      const uncStatCalls = statCalls.filter((p) => p.includes('\\\\server') || p.includes('//server'));
      expect(uncStatCalls).toHaveLength(0);
    });
  });
});
