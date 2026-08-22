/**
 * NativeBackendSession 集成测试 —— W1.2 验收用。
 *
 * 覆盖：
 *   1. 基本 exec（含 env 透传 e2e —— P0 实装真生效）
 *   2. signal AbortSignal 取消 e2e（P0 实装真生效）
 *   3. read / write 直接 fs 路径
 *   4. agentHome 懒创建
 *   5. agentId 路径注入校验（白名单 fail-fast）
 *   6. 6 抽象方法 + 默认基类组合方法（ls / mkdir / rm / exists / stat）
 *   7. persistWorkspace / hydrateWorkspace 抛 not supported
 *   8. shutdown 幂等 + onShutdown 触发
 *   9. backendType 是 'local' as const（D2 修订）
 *  10. capabilities 形态符合 Native（5 个 supportsX 全 false）
 *  11. NativeBackendSession + 真 SpawnSandboxBackend 端到端 env / signal
 *
 * 测试 #11 是真 spawn 子进程的 e2e，证明 P0 字段链路打通。
 */

import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

import {
  NativeBackendSession,
  NativeBackendSessionUnsupportedError,
} from '../native-backend-session.js';
import { CommandExecutor, SpawnSandboxBackend } from '@tabtin/terminal-core';
import type { ExecOptions, ExecResult } from '../../backend-session.js';
import { createTestSafeFsPort } from '../../../../tests/helpers/safe-fs-port.js';

// ─── 测试辅助：tmp dir 隔离 ──────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'native-bs-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // best-effort
  }
});

// ─── Mock execImpl：记录调用 + 返回脚本结果 ──────────────────────────

interface MockExecCall {
  command: string;
  opts?: ExecOptions;
}

function mockSession(opts?: {
  agentId?: string;
  agentHomeRoot?: string;
  scriptResult?: (cmd: string, opts?: ExecOptions) => ExecResult | Promise<ExecResult>;
  onShutdown?: () => Promise<void>;
}) {
  const calls: MockExecCall[] = [];
  const session = new NativeBackendSession({
    sessionId: 'test-session-id',
    agentId: opts?.agentId ?? 'test-agent',
    agentHomeRoot: opts?.agentHomeRoot ?? tmpDir,
    fs: createTestSafeFsPort(),
    execImpl: async (command, execOpts) => {
      calls.push({ command, opts: execOpts });
      const r = opts?.scriptResult?.(command, execOpts);
      if (r) return await Promise.resolve(r);
      return {
        stdout: '',
        stderr: '',
        exitCode: 0,
        durationMs: 0,
      };
    },
    onShutdown: opts?.onShutdown,
  });
  return { session, calls };
}

// ─── 测试 1：基本 exec + env 透传 e2e（mock execImpl）────────────────

describe('NativeBackendSession.exec', () => {
  it('转发 command 与 opts 到 execImpl 不变形', async () => {
    const { session, calls } = mockSession();
    const result = await session.exec('echo hello', {
      cwd: '/tmp',
      env: { FOO: 'bar' },
      timeout: 5000,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0].command).toBe('echo hello');
    expect(calls[0].opts?.cwd).toBe('/tmp');
    expect(calls[0].opts?.env).toEqual({ FOO: 'bar' });
    expect(calls[0].opts?.timeout).toBe(5000);
    expect(result.exitCode).toBe(0);
  });

  it('env 字段被原样透传（不做 sanitize）—— sanitize 是关卡 1 地板的职责', async () => {
    const { session, calls } = mockSession();
    await session.exec('cmd', { env: { DYLD_INSERT_LIBRARIES: '/evil' } });
    // session 层不做 sanitize；危险变量过滤由 CommandExecutor.mergeCallerEnv 完成
    expect(calls[0].opts?.env).toEqual({ DYLD_INSERT_LIBRARIES: '/evil' });
  });
});

// ─── 测试 2：read / write 直接 fs 路径 ──────────────────────────────

describe('NativeBackendSession.read / write', () => {
  it('write 创建文件，read 拿回相同内容', async () => {
    const { session } = mockSession();
    const filePath = path.join(tmpDir, 'a.txt');
    await session.write(filePath, 'hello world');
    const buf = await session.read(filePath);
    expect(buf.toString('utf8')).toBe('hello world');
  });

  it('write 接受 Buffer', async () => {
    const { session } = mockSession();
    const filePath = path.join(tmpDir, 'b.bin');
    await session.write(filePath, Buffer.from([0x01, 0x02, 0x03]));
    const buf = await session.read(filePath);
    expect(Array.from(buf)).toEqual([0x01, 0x02, 0x03]);
  });

  it('read 不存在文件抛 OSAccessError(TARGET_NOT_FOUND) —— safe-fs 归一', async () => {
    const { session } = mockSession();
    // safe-fs 把 ENOENT 归类成 OSError(TARGET_NOT_FOUND) 抛 OSAccessError；
    // 这正是 Wave 1 第二轮要的语义：FileSystemCap 透传 → orchestration
    // 写黑名单 + 转结构化 llm_message 给 Agent，避免 LLM 反复重试同路径。
    await expect(session.read(path.join(tmpDir, 'missing.txt'))).rejects.toMatchObject({
      name: 'OSAccessError',
      osError: {
        code: 'TARGET_NOT_FOUND',
      },
    });
  });

  it('read 走 safe-fs 不通过 exec 路径（性能 override + 结构化 OS 错误）', async () => {
    // Wave 1 第二轮：read 不再走 fs.promises，而是走 `@tabtin/safe-fs`，把
    // macOS TCC 拒绝 / Windows 杀软拦截 / 云盘占位等 OS 级错误归一抛
    // OSAccessError。本测试关键断言"不触发 exec spawn"，证明性能 override
    // 真生效——避免每次 read 多 5-20ms spawn 开销。
    const { session, calls } = mockSession();
    await session.write(path.join(tmpDir, 'x.txt'), 'data');
    await session.read(path.join(tmpDir, 'x.txt'));
    // 关键断言：read 不应触发 exec（性能 override 真生效）
    expect(calls).toHaveLength(0);
  });
});

// ─── 测试 3：agentHome 路径计算 ───────────────────────────────────────

describe('NativeBackendSession.agentHome 路径计算', () => {
  it('构造时计算 4 子分区路径但不创建任何目录', () => {
    const { session } = mockSession({ agentId: 'agent-x' });
    const layout = session.agentHome;
    expect(layout.scratchpad).toBe(path.join(tmpDir, 'scratchpad'));
    expect(layout.output).toBe(path.join(tmpDir, 'output'));
    expect(layout.sessions).toBe(path.join(tmpDir, 'sessions'));
    expect(layout.skills).toBe(path.join(tmpDir, 'skills'));
    expect(fs.existsSync(layout.scratchpad)).toBe(false);
    expect(fs.existsSync(layout.output)).toBe(false);
    expect(fs.existsSync(layout.sessions)).toBe(false);
    expect(fs.existsSync(layout.skills)).toBe(false);
  });

  it('默认路径走 ~/.tabtin/agents/{agentId}/', () => {
    // 不传 agentHomeRoot —— 用 default homedir 路径
    const session = new NativeBackendSession({
      sessionId: 'sid',
      agentId: 'home-default-test-' + Date.now(),
      fs: createTestSafeFsPort(),
      execImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
    });
    expect(session.agentHome.scratchpad).toContain('.tabtin');
    expect(session.agentHome.scratchpad).toContain('agents');
    expect(session.agentHome.scratchpad).toContain('scratchpad');
    // 清理：homedir 被改了一个真实文件夹
    try {
      fs.rmSync(path.dirname(session.agentHome.scratchpad), {
        recursive: true,
        force: true,
      });
    } catch {
      // best-effort
    }
  });

  it('TABTIN_RUNTIME_ROOT 存在时 Agent Home 跟随当前安装档', () => {
    const previous = process.env.TABTIN_RUNTIME_ROOT;
    process.env.TABTIN_RUNTIME_ROOT = path.join(tmpDir, 'TabTin Preprod', 'runtime');
    try {
      const agentId = 'profile-isolated-agent';
      const session = new NativeBackendSession({
        sessionId: 'sid',
        agentId,
        fs: createTestSafeFsPort(),
        execImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
      });
      expect(session.agentHome.scratchpad).toBe(
        path.join(tmpDir, 'TabTin Preprod', 'runtime', 'agents', agentId, 'scratchpad'),
      );
    } finally {
      if (previous === undefined) delete process.env.TABTIN_RUNTIME_ROOT;
      else process.env.TABTIN_RUNTIME_ROOT = previous;
    }
  });

  it('多次构造同 agentId 不抛错（路径计算幂等）', () => {
    const { session: s1 } = mockSession({ agentId: 'agent-y' });
    const { session: s2 } = mockSession({ agentId: 'agent-y' });
    expect(s1.agentHome.scratchpad).toBe(s2.agentHome.scratchpad);
  });
});

// ─── 测试 4：agentId 路径注入校验（白名单 fail-fast）─────────────────

describe('NativeBackendSession agentId 校验', () => {
  it.each([
    ['..', 'parent-traversal'],
    ['../etc', 'parent-traversal-with-rest'],
    ['a..b', 'embedded-dot-dot'],
    ['a/b', 'forward-slash'],
    ['a\\b', 'backslash'],
    ['', 'empty'],
    [' ', 'whitespace'],
    ['a\x00b', 'null-byte'],
    ['a:b', 'colon'],
    ['a*b', 'glob-star'],
  ])('拒绝恶意 agentId "%s" (%s)', (badId) => {
    expect(() =>
      new NativeBackendSession({
        sessionId: 'sid',
        agentId: badId,
        agentHomeRoot: tmpDir,
        fs: createTestSafeFsPort(),
        execImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
      }),
    ).toThrow(/invalid agentId|agentId is required|\.\. sequence/);
  });

  it.each([
    'simple',
    'with-dashes',
    'with_underscores',
    'with.dots.namespace', // W1.2 review#1 P2-1 修订：单 . 接受
    'UUID-LIKE-1234567890abcdef',
    '0123456789',
    'agent.v1.user-123',
  ])('接受合法 agentId "%s"', (goodId) => {
    expect(() =>
      new NativeBackendSession({
        sessionId: 'sid',
        agentId: goodId,
        agentHomeRoot: path.join(tmpDir, goodId),
        fs: createTestSafeFsPort(),
        execImpl: async () => ({ stdout: '', stderr: '', exitCode: 0, durationMs: 0 }),
      }),
    ).not.toThrow();
  });
});

// ─── 测试 5：6 抽象方法 + 默认基类组合方法 ──────────────────────────

describe('NativeBackendSession.ls / mkdir / rm / exists / stat', () => {
  it('ls 返回目录内容（不含 . 与 ..）', async () => {
    const { session, calls } = mockSession();
    await session.mkdir(path.join(tmpDir, 'd1'));
    await session.write(path.join(tmpDir, 'f1'), 'x');
    const entries = await session.ls(tmpDir);
    expect(entries.sort()).toEqual(['d1', 'f1']);
    // 性能 override：不走 exec
    expect(calls).toHaveLength(0);
  });

  it('mkdir recursive=true 创建多级目录', async () => {
    const { session } = mockSession();
    const deep = path.join(tmpDir, 'a/b/c');
    await session.mkdir(deep, { recursive: true });
    expect(fs.existsSync(deep)).toBe(true);
  });

  it('mkdir recursive=false 父目录不存在抛 OSAccessError(TARGET_NOT_FOUND)', async () => {
    const { session } = mockSession();
    // safe-fs 把 ENOENT 归类成 OSError(TARGET_NOT_FOUND)；与 read 的处理一致。
    await expect(
      session.mkdir(path.join(tmpDir, 'no-parent/child'), { recursive: false }),
    ).rejects.toMatchObject({
      name: 'OSAccessError',
      osError: {
        code: 'TARGET_NOT_FOUND',
      },
    });
  });

  it('rm force=true 不存在不抛错', async () => {
    const { session } = mockSession();
    await expect(
      session.rm(path.join(tmpDir, 'never-existed'), { force: true }),
    ).resolves.toBeUndefined();
  });

  it('rm recursive=true 删除非空目录', async () => {
    const { session } = mockSession();
    const dir = path.join(tmpDir, 'sub');
    await session.mkdir(dir);
    await session.write(path.join(dir, 'inner.txt'), 'y');
    await session.rm(dir, { recursive: true });
    expect(fs.existsSync(dir)).toBe(false);
  });

  it('exists 走 fs.access，不走 exec', async () => {
    const { session, calls } = mockSession();
    await session.write(path.join(tmpDir, 'present'), 'z');
    expect(await session.exists(path.join(tmpDir, 'present'))).toBe(true);
    expect(await session.exists(path.join(tmpDir, 'missing'))).toBe(false);
    expect(calls).toHaveLength(0);
  });

  // Wave 1 第二轮 Review M-4：exists 仅 TARGET_NOT_FOUND 归零；其他 OSError 透传。
  // 不再让 LLM 把"权限不足"错误识别成"路径不存在"，避免它走 mkdir 创建路径
  // 的歧途（mkdir 才会真触发 OSError 进黑名单）。
  it('exists 在 OS_PERMISSION_DENIED 时透传抛出 OSAccessError，而不是归零成 false', async () => {
    // mock fs.access 抛 EACCES（与 macOS TCC 拦截 / Linux POSIX 权限拒绝同形）
    // 由于 NativeBackendSession 直接走 safeAccess，我们通过 fs 层构造一个真实
    // 的权限拒绝场景：mkdir 一个 0o000 mode 目录后访问内部子路径。
    const restrictedDir = path.join(tmpDir, 'restricted');
    fs.mkdirSync(restrictedDir);
    // 仅当前用户可读写
    fs.chmodSync(restrictedDir, 0o000);

    try {
      const { session } = mockSession();
      // root 用户能绕开权限——CI 跑 root 时跳过这条断言。
      if (process.getuid && process.getuid() === 0) {
        return;
      }
      // 访问 0o000 目录下的子路径会抛 EACCES → safe-fs 归类成
      // OSError(OS_PERMISSION_DENIED) → exists 应**抛出**（不再归零）
      await expect(
        session.exists(path.join(restrictedDir, 'inside.txt')),
      ).rejects.toMatchObject({
        name: 'OSAccessError',
        osError: {
          code: 'OS_PERMISSION_DENIED',
        },
      });
    } finally {
      fs.chmodSync(restrictedDir, 0o755);
    }
  });

  it('stat 返回 isFile / isDirectory / size / mtimeMs', async () => {
    const { session } = mockSession();
    const filePath = path.join(tmpDir, 'stat-target');
    await session.write(filePath, 'abc');
    const s = await session.stat!(filePath);
    expect(s.isFile).toBe(true);
    expect(s.isDirectory).toBe(false);
    expect(s.size).toBe(3);
    expect(typeof s.mtimeMs).toBe('number');
  });
});

// ─── 测试 6：persistWorkspace / hydrateWorkspace 抛 not supported ─────

describe('NativeBackendSession persistence 不支持', () => {
  it('persistWorkspace 抛 NativeBackendSessionUnsupportedError', async () => {
    const { session } = mockSession();
    await expect(session.persistWorkspace()).rejects.toBeInstanceOf(
      NativeBackendSessionUnsupportedError,
    );
  });

  it('hydrateWorkspace 抛 NativeBackendSessionUnsupportedError', async () => {
    const { session } = mockSession();
    await expect(
      session.hydrateWorkspace({
        schemaVersion: 1,
        backendType: 'local',
        payload: {},
      }),
    ).rejects.toBeInstanceOf(NativeBackendSessionUnsupportedError);
  });

  it('capabilities.supportsPersistence === false（调用方应据此 gate）', () => {
    const { session } = mockSession();
    expect(session.capabilities.supportsPersistence).toBe(false);
    expect(session.capabilities.supportsHibernate).toBe(false);
    expect(session.capabilities.supportsCheckpoint).toBe(false);
    expect(session.capabilities.supportsMount).toBe(false);
    expect(session.capabilities.supportsBackground).toBe(false);
  });
});

// ─── 测试 7：shutdown 幂等 + onShutdown 触发 ────────────────────────

describe('NativeBackendSession.shutdown', () => {
  it('shutdown 触发 onShutdown 钩子一次', async () => {
    let count = 0;
    const { session } = mockSession({
      onShutdown: async () => {
        count++;
      },
    });
    await session.shutdown();
    expect(count).toBe(1);
  });

  it('多次 shutdown 幂等 —— onShutdown 仅触发一次', async () => {
    let count = 0;
    const { session } = mockSession({
      onShutdown: async () => {
        count++;
      },
    });
    await session.shutdown();
    await session.shutdown();
    await session.shutdown();
    expect(count).toBe(1);
  });

  it('onShutdown 抛错不传染', async () => {
    const { session } = mockSession({
      onShutdown: async () => {
        throw new Error('cleanup failed');
      },
    });
    await expect(session.shutdown()).resolves.toBeUndefined();
  });

  it('shutdown 后 running() 返回 false（W1.2 review#1 P1-1 修订）', async () => {
    const { session } = mockSession();
    expect(await session.running()).toBe(true);
    await session.shutdown();
    expect(await session.running()).toBe(false);
  });
});

// ─── 测试 8：身份 + capabilities 形态正确 ──────────────────────────

// feature flag isNativeBackendSessionEnabled 测试已随 Stage 6d 迁至宿主包
// tests/native/native-backend-flag.test.ts

describe('NativeBackendSession 身份 / capabilities', () => {
  it('backendType === "local" as const（D2 修订）', () => {
    const { session } = mockSession();
    expect(session.backendType).toBe('local');
    // TypeScript 'as const' 由 tsc 确保；运行时仅可断字面量
    const t: 'local' | 'cloud' = session.backendType;
    expect(t).toBe('local');
  });

  it('capabilities Native 形态完整', () => {
    const { session } = mockSession();
    expect(session.capabilities).toEqual({
      supportsInteractive: true,
      supportsSandbox: true,
      supportsNetworkIsolation: true,
      supportsFileSystemIsolation: true,
      latencyClass: 'local',
      platforms: ['darwin', 'linux', 'win32'],
      supportsPersistence: false,
      supportsHibernate: false,
      supportsCheckpoint: false,
      supportsMount: false,
      supportsBackground: false,
    });
  });

  it('manifest 默认 undefined（Native 不挂 manifest）', () => {
    const { session } = mockSession();
    expect(session.manifest).toBeUndefined();
  });

  it('running 默认 true', async () => {
    const { session } = mockSession();
    expect(await session.running()).toBe(true);
  });

  it('sessionId 透传', () => {
    const { session } = mockSession();
    expect(session.sessionId).toBe('test-session-id');
  });
});

// ─── 测试 9：apply_patch 通过基类继承 ──────────────────────────────

describe('NativeBackendSession apply_patch 基类继承', () => {
  it('apply_patch 单 hunk 替换通过基类组合 read + write', async () => {
    const { session } = mockSession();
    const filePath = path.join(tmpDir, 'patch-target');
    await session.write(filePath, 'line1\nline2\nline3');
    const patch = [
      '--- a/patch-target',
      '+++ b/patch-target',
      '@@ -1,3 +1,3 @@',
      ' line1',
      '-line2',
      '+modified',
      ' line3',
    ].join('\n');
    await session.apply_patch(filePath, patch);
    const content = (await session.read(filePath)).toString('utf8');
    expect(content).toBe('line1\nmodified\nline3');
  });
});

// ─── 测试 10：真 SpawnSandboxBackend 端到端 env / signal e2e ────────

/**
 * 真 spawn 子进程的 e2e 测试 —— 证明 P0 字段链路打通：
 *
 *   NativeBackendSession.exec(opts)
 *     → execImpl wrapper
 *     → SpawnSandboxBackend.execute({ env, signal, ... })
 *     → CommandExecutor.executeStreaming({ env, signal, ... })
 *     → child_process.spawn(env / signal.aborted → kill)
 *
 * 任何一节断了 e2e 测试就会失败 —— 这是 W1.2 P0 实装的最强保证。
 */
describe('NativeBackendSession + SpawnSandboxBackend e2e（真 spawn 子进程）', () => {
  function makeRealSession(agentId: string) {
    const executor = new CommandExecutor({ workspaceRoot: tmpDir });
    const sandbox = new SpawnSandboxBackend(executor);
    const session = new NativeBackendSession({
      sessionId: 'e2e-' + Date.now(),
      agentId,
      agentHomeRoot: path.join(tmpDir, agentId),
      fs: createTestSafeFsPort(),
      execImpl: async (command, opts) => {
        const r = await sandbox.execute({
          command,
          cwd: opts?.cwd ?? path.join(tmpDir, agentId),
          env: opts?.env,
          timeout: opts?.timeout,
          // SpawnSandboxBackend 透传 signal —— W1.2 P0 实装路径
          ...(opts?.signal ? ({ signal: opts.signal } as { signal: AbortSignal }) : {}),
          onStdout: opts?.onStdout,
          onStderr: opts?.onStderr,
        });
        return {
          stdout: r.stdout,
          stderr: r.stderr,
          exitCode: r.exitCode,
          durationMs: r.durationMs,
          degraded: r.degraded || undefined,
        };
      },
    });
    return session;
  }

  it('env 字段透传到子进程并能被 printenv 输出', async () => {
    // 用 printenv 而非 echo "$VAR" —— 后者会被 CommandValidator 的
    // env-var-expansion denylist 拒绝（关卡 1 地板的预期行为）。
    // printenv 是直接读 environ，不经 shell 展开，绕过 denylist 但
    // 仍真实验证 env 传递。
    const session = makeRealSession('e2e-env-test');
    const cwd = path.join(tmpDir, 'e2e-env-test');
    fs.mkdirSync(cwd, { recursive: true });
    const result = await session.exec('printenv MY_TEST_VAR', {
      cwd,
      env: { MY_TEST_VAR: 'hello-from-w1-2' },
      timeout: 5000,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('hello-from-w1-2');
  });

  it('signal AbortSignal 取消长 sleep 命令', async () => {
    const session = makeRealSession('e2e-signal-test');
    const cwd = path.join(tmpDir, 'e2e-signal-test');
    fs.mkdirSync(cwd, { recursive: true });
    const ctrl = new AbortController();
    const startedAt = Date.now();
    const promise = session.exec('sleep 30', {
      cwd,
      signal: ctrl.signal,
      timeout: 60000, // 远大于 sleep 30，确保不是 timeout 触发
    });

    setTimeout(() => ctrl.abort(), 100);

    const result = await promise;
    const durationMs = Date.now() - startedAt;
    // 必须比 sleep 30 短得多 —— 证明 signal 真的杀掉了 sleep
    expect(durationMs).toBeLessThan(10_000);
    expect(result.exitCode).not.toBe(0);
  }, 15_000);

  it('signal 已 aborted 时 spawn 也立即终止', async () => {
    const session = makeRealSession('e2e-pre-abort');
    const cwd = path.join(tmpDir, 'e2e-pre-abort');
    fs.mkdirSync(cwd, { recursive: true });
    const ctrl = new AbortController();
    ctrl.abort(); // pre-abort
    const startedAt = Date.now();
    const result = await session.exec('sleep 30', {
      cwd,
      signal: ctrl.signal,
      timeout: 60000,
    });
    const durationMs = Date.now() - startedAt;
    expect(durationMs).toBeLessThan(5000);
    expect(result.exitCode).not.toBe(0);
  }, 10_000);

  it('SpawnSandboxBackend 关卡 1 地板：env-sanitize 过滤危险变量（DYLD_INSERT_LIBRARIES）', async () => {
    const session = makeRealSession('e2e-sanitize-test');
    const cwd = path.join(tmpDir, 'e2e-sanitize-test');
    fs.mkdirSync(cwd, { recursive: true });
    // 调用方传入危险变量；CommandExecutor.mergeCallerEnv 应通过
    // sanitizeEnv 过滤掉。printenv 在变量不存在时返回 exit code 1
    // 且 stdout 空 —— 这是关卡 1 真生效的强信号。
    const result = await session.exec('printenv DYLD_INSERT_LIBRARIES', {
      cwd,
      env: { DYLD_INSERT_LIBRARIES: '/evil/lib' },
      timeout: 5000,
    });
    // 关卡 1 验证：危险变量被关卡 1 sanitize 过滤掉了 —— printenv
    // 没拿到值，stdout 应为空（exit code 通常 1，但宿主环境可能变化）。
    expect(result.stdout.trim()).toBe('');
  });
});
