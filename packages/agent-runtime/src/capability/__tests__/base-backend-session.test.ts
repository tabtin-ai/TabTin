/**
 * BaseBackendSession 测试 —— 补 review 3 P0-2 揭示的零测试盲点。
 *
 * 覆盖：
 *   - shellEscape 边界（含单引号、空格、换行、零字符）
 *   - ls 解析（含 `\r\n` Windows 输出 / 含 `.` 与 `..` 过滤）
 *   - mkdir 含 -p 与不含 -p
 *   - rm 含 -r/-f / force=true 时非零退出不抛 / force=false 时非零退出抛
 *   - exists 退出码 0 vs !=0
 *   - extract 创建目录 + tar
 *   - apply_patch 单 hunk / 多 hunk / 上下文不匹配抛错
 *   - structuredClone smoke test（M1 §9 风险 5）
 */

import { describe, expect, it } from 'vitest';
import {
  BaseBackendSession,
  shellEscape,
} from '../base-backend-session.js';
import type {
  AgentHomeLayout,
  BackendSessionCapabilities,
  BackendType,
  ExecOptions,
  ExecResult,
  SessionPersistState,
} from '../backend-session.js';

// ─── shellEscape ────────────────────────────────────────────────────

describe('shellEscape', () => {
  it('普通字符串包单引号', () => {
    expect(shellEscape('hello')).toBe(`'hello'`);
  });

  it('空字符串', () => {
    expect(shellEscape('')).toBe(`''`);
  });

  it('含空格 / 多空格 / tab', () => {
    expect(shellEscape('a b')).toBe(`'a b'`);
    expect(shellEscape('a\tb')).toBe(`'a\tb'`);
  });

  it('含单引号 —— 转义为关引号 + escape + 开引号', () => {
    expect(shellEscape("it's")).toBe(`'it'\\''s'`);
    expect(shellEscape("''")).toBe(`''\\'''\\'''`);
  });

  it('含换行 —— 单引号字面量包住即可（shell 接受多行字面量）', () => {
    expect(shellEscape('a\nb')).toBe(`'a\nb'`);
  });

  it('含 / .. ~ * 等 shell 特殊字符 —— 被单引号封死', () => {
    expect(shellEscape('/usr/local/bin')).toBe(`'/usr/local/bin'`);
    expect(shellEscape('../foo')).toBe(`'../foo'`);
    expect(shellEscape('~/bar')).toBe(`'~/bar'`);
    expect(shellEscape('a*.txt')).toBe(`'a*.txt'`);
  });
});

// ─── Mock subclass for ls/mkdir/rm/exists/extract/apply_patch ───────

interface ExecCall {
  command: string;
  opts?: ExecOptions;
}

class MockSession extends BaseBackendSession {
  readonly sessionId = 'mock';
  readonly backendType: BackendType = 'local';
  readonly capabilities: BackendSessionCapabilities = {
    supportsInteractive: false,
    supportsSandbox: false,
    supportsNetworkIsolation: false,
    supportsFileSystemIsolation: false,
    latencyClass: 'local',
    platforms: ['darwin'],
    supportsPersistence: false,
    supportsHibernate: false,
    supportsCheckpoint: false,
    supportsMount: false,
    supportsBackground: false,
  };
  readonly agentHome: AgentHomeLayout = {
    scratchpad: '/tmp/m/scratchpad',
    output: '/tmp/m/output',
    sessions: '/tmp/m/sessions',
    skills: '/tmp/m/skills',
  };

  execCalls: ExecCall[] = [];
  private execScript: (command: string) => ExecResult = () => ({
    stdout: '',
    stderr: '',
    exitCode: 0,
    durationMs: 0,
  });
  private files = new Map<string, string>();

  setExecScript(fn: (command: string) => ExecResult): void {
    this.execScript = fn;
  }

  async exec(command: string, opts?: ExecOptions): Promise<ExecResult> {
    this.execCalls.push({ command, opts });
    return this.execScript(command);
  }

  async read(path: string): Promise<Buffer> {
    if (!this.files.has(path)) {
      throw new Error(`mock read: ${path} not in files`);
    }
    return Buffer.from(this.files.get(path)!, 'utf8');
  }

  async write(path: string, data: Buffer | string): Promise<void> {
    const text = typeof data === 'string' ? data : data.toString('utf8');
    this.files.set(path, text);
  }

  setFile(path: string, content: string): void {
    this.files.set(path, content);
  }
  getFile(path: string): string | undefined {
    return this.files.get(path);
  }

  async running(): Promise<boolean> {
    return true;
  }

  async persistWorkspace(): Promise<SessionPersistState> {
    throw new Error('not supported in mock');
  }
  async hydrateWorkspace(_state: SessionPersistState): Promise<void> {
    throw new Error('not supported in mock');
  }
}

// ─── ls ─────────────────────────────────────────────────────────────

describe('BaseBackendSession.ls', () => {
  it('正常解析 ls 输出，过滤 . / ..', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({
      stdout: '.\n..\nfoo.txt\nbar\n',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    }));
    const entries = await m.ls('/some/dir');
    expect(entries).toEqual(['foo.txt', 'bar']);
  });

  it('Windows 风格 \\r\\n 行尾被处理', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({
      stdout: '.\r\n..\r\nfoo.txt\r\nbar\r\n',
      stderr: '',
      exitCode: 0,
      durationMs: 1,
    }));
    const entries = await m.ls('/some/dir');
    expect(entries).toEqual(['foo.txt', 'bar']);
  });

  it('exit !=0 抛错', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({
      stdout: '',
      stderr: 'No such file',
      exitCode: 2,
      durationMs: 0,
    }));
    await expect(m.ls('/missing')).rejects.toThrow(/ls failed.*No such file/);
  });

  it('调用的 exec 命令使用 shellEscape', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    await m.ls(`/path with 'quote'`);
    expect(m.execCalls[0].command).toBe(`ls -1a '/path with '\\''quote'\\'''`);
  });
});

// ─── mkdir ──────────────────────────────────────────────────────────

describe('BaseBackendSession.mkdir', () => {
  it('不传 recursive —— 不带 -p', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    await m.mkdir('/foo');
    expect(m.execCalls[0].command).toBe(`mkdir '/foo'`);
  });

  it('recursive: true —— 带 -p', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    await m.mkdir('/foo/bar', { recursive: true });
    expect(m.execCalls[0].command).toBe(`mkdir -p '/foo/bar'`);
  });

  it('exit !=0 抛错', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({
      stdout: '',
      stderr: 'Permission denied',
      exitCode: 1,
      durationMs: 0,
    }));
    await expect(m.mkdir('/no-perm')).rejects.toThrow(/mkdir failed.*Permission denied/);
  });
});

// ─── rm ─────────────────────────────────────────────────────────────

describe('BaseBackendSession.rm', () => {
  it('不传 opts —— 无 flag', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    await m.rm('/foo');
    expect(m.execCalls[0].command).toBe(`rm '/foo'`);
  });

  it('recursive + force —— 空格分隔多 flag（跨 sh 兼容）', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    await m.rm('/foo', { recursive: true, force: true });
    expect(m.execCalls[0].command).toBe(`rm -r -f '/foo'`);
  });

  it('force=true 任何非零 exit 都不抛（best-effort 清理语义）', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({
      stdout: '',
      stderr: 'No such file',
      exitCode: 1,
      durationMs: 0,
    }));
    await expect(m.rm('/missing', { force: true })).resolves.toBeUndefined();
    // 真失败也不抛（与 GNU rm -f 对齐）
    m.setExecScript(() => ({
      stdout: '',
      stderr: 'Operation not permitted',
      exitCode: 13,
      durationMs: 0,
    }));
    await expect(m.rm('/locked', { force: true })).resolves.toBeUndefined();
  });

  it('force=false 时非零退出抛错', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({
      stdout: '',
      stderr: 'No such file',
      exitCode: 1,
      durationMs: 0,
    }));
    await expect(m.rm('/missing')).rejects.toThrow(/rm failed.*No such file/);
  });
});

// ─── exists ─────────────────────────────────────────────────────────

describe('BaseBackendSession.exists', () => {
  it('exit 0 → true', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    expect(await m.exists('/foo')).toBe(true);
  });

  it('exit 1 → false', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 1, durationMs: 0 }));
    expect(await m.exists('/missing')).toBe(false);
  });

  it('使用 test -e 命令', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    await m.exists('/foo');
    expect(m.execCalls[0].command).toBe(`test -e '/foo'`);
  });
});

// ─── extract ────────────────────────────────────────────────────────

describe('BaseBackendSession.extract', () => {
  it('先 mkdir -p destDir 再 tar -xf', async () => {
    const m = new MockSession();
    m.setExecScript(() => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }));
    await m.extract('/tmp/foo.tar.gz', '/tmp/out');
    expect(m.execCalls[0].command).toBe(`mkdir -p '/tmp/out'`);
    expect(m.execCalls[1].command).toBe(`tar -xf '/tmp/foo.tar.gz' -C '/tmp/out'`);
  });

  it('tar 失败抛错', async () => {
    const m = new MockSession();
    let call = 0;
    m.setExecScript(() => {
      call++;
      if (call === 1) {
        return { stdout: '', stderr: '', exitCode: 0, durationMs: 0 };
      }
      return {
        stdout: '',
        stderr: 'Unrecognized archive format',
        exitCode: 2,
        durationMs: 0,
      };
    });
    await expect(m.extract('/tmp/bad', '/tmp/out')).rejects.toThrow(
      /extract failed.*Unrecognized archive format/,
    );
  });
});

// ─── apply_patch ────────────────────────────────────────────────────

describe('BaseBackendSession.apply_patch', () => {
  it('单 hunk 替换中间一行', async () => {
    const m = new MockSession();
    m.setFile('/a.txt', 'line1\nline2\nline3');
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+line2-modified',
      ' line3',
    ].join('\n');
    await m.apply_patch('/a.txt', patch);
    expect(m.getFile('/a.txt')).toBe('line1\nline2-modified\nline3');
  });

  it('单 hunk 增加一行', async () => {
    const m = new MockSession();
    m.setFile('/a.txt', 'line1\nline2');
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,3 @@',
      ' line1',
      ' line2',
      '+line3',
    ].join('\n');
    await m.apply_patch('/a.txt', patch);
    expect(m.getFile('/a.txt')).toBe('line1\nline2\nline3');
  });

  it('多 hunk —— 偏移量正确累计', async () => {
    const m = new MockSession();
    m.setFile('/a.txt', 'A\nB\nC\nD\nE\nF');
    // 删 B；同时把 E 改成 E2
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,2 +1,1 @@',
      ' A',
      '-B',
      '@@ -5,1 +4,1 @@',
      '-E',
      '+E2',
    ].join('\n');
    await m.apply_patch('/a.txt', patch);
    expect(m.getFile('/a.txt')).toBe('A\nC\nD\nE2\nF');
  });

  it('上下文不匹配抛错（含具体行号 / 期望 / 实际）', async () => {
    const m = new MockSession();
    m.setFile('/a.txt', 'X\nY\nZ');
    const patch = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,3 +1,3 @@',
      ' X',
      '-DIFFERENT',
      '+modified',
      ' Z',
    ].join('\n');
    await expect(m.apply_patch('/a.txt', patch)).rejects.toThrow(
      /hunk context mismatch.*expected "DIFFERENT".*got "Y"/,
    );
  });
});

// ─── structuredClone smoke test (M1 §9 风险 5) ───────────────────────

describe('structuredClone availability (M1 §9 风险 5 smoke)', () => {
  it('全局 structuredClone 函数可用（Node 17+ / vitest 环境）', () => {
    expect(typeof structuredClone).toBe('function');
    const obj = { a: 1, b: { c: [1, 2, 3] } };
    const cloned = structuredClone(obj);
    expect(cloned).toEqual(obj);
    expect(cloned).not.toBe(obj);
    expect(cloned.b).not.toBe(obj.b);
  });

  it('对函数 structuredClone 抛 DataCloneError —— CapabilityBase.clone 依赖此行为', () => {
    expect(() => structuredClone({ fn: () => 1 })).toThrow();
  });

  it('对 Map / Set / Date 都正常工作（结构化拷贝特性）', () => {
    const m = new Map([['a', 1]]);
    const s = new Set([1, 2]);
    const d = new Date('2026-04-27');
    expect(structuredClone(m)).toEqual(m);
    expect(structuredClone(s)).toEqual(s);
    expect(structuredClone(d).toISOString()).toBe(d.toISOString());
  });
});
