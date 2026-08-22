/**
 * TC-8 回归测试：沙箱内命令链防护 + A3 用户隔离加固
 *
 * 验证沙箱层（Linux bwrap / macOS sandbox-exec）对命令使用
 * set -euo pipefail 包裹，作为 L0 验证层的纵深防御。
 *
 * A3 新增：--unshare-user、--unshare-ipc、/etc 白名单挂载
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

function buildArgs(params?: Partial<import('../src/platform/types').SandboxParams>) {
  const { LinuxSandbox } = require('../src/platform/linux');
  const sandbox = new LinuxSandbox();
  return sandbox.buildSpawnArgs({
    command: 'echo test',
    cwd: '/home/test/project',
    tmpDir: '/tmp/sandbox-test/tmp',
    sandboxLevel: 'complete',
    env: {},
    ...params,
  });
}

describe('TC-8: Linux bwrap 命令链防护', () => {
  it('命令使用 set -euo pipefail 包裹', async () => {
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
      return {
        ...actual,
        default: {
          ...actual,
          existsSync: (p: string) => {
            if (p === '/nix/store') return false;
            return actual.existsSync(p);
          },
        },
      };
    });

    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo hello',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-test/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    const cIndex = result.args.indexOf('-c');
    expect(cIndex).toBeGreaterThan(-1);

    const shellCommand = result.args[cIndex + 1];
    expect(shellCommand).toContain('set -euo pipefail');
    expect(shellCommand).toContain('echo hello');
  });

  it('bwrap complete 级别使用 --unshare-net', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-net/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    expect(result.args).toContain('--unshare-net');
  });

  it('bwrap filesystem 级别不使用 --unshare-net', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-nonet/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(result.args).not.toContain('--unshare-net');
  });

  it('bwrap 使用 --unshare-pid 和 --die-with-parent', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-pid/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(result.args).toContain('--unshare-pid');
    expect(result.args).toContain('--die-with-parent');
  });

  it('bwrap 项目目录为只读', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const cwd = '/home/test/project';
    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd,
      tmpDir: '/tmp/sandbox-ro/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    const roBindIndex = result.args.lastIndexOf('--ro-bind');
    expect(result.args[roBindIndex + 1]).toBe(cwd);
    expect(result.args[roBindIndex + 2]).toBe(cwd);
  });
});

// ── A3: 沙箱用户隔离加固 ──

describe('A3: --unshare-user 用户命名空间隔离', () => {
  it('bwrap 参数包含 --unshare-user', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'node -e "console.log(1)"',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-user/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(result.args).toContain('--unshare-user');
  });

  it('--unshare-user 位于 args 最前面（在 bind 参数之前）', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'ls',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-order/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    const unshareIdx = result.args.indexOf('--unshare-user');
    const firstRoBindIdx = result.args.indexOf('--ro-bind');

    expect(unshareIdx).toBeGreaterThanOrEqual(0);
    expect(firstRoBindIdx).toBeGreaterThan(unshareIdx);
  });

  it('所有 sandboxLevel 都包含 --unshare-user', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    for (const level of ['filesystem', 'complete'] as const) {
      const result = sandbox.buildSpawnArgs({
        command: 'echo test',
        cwd: '/home/test/project',
        tmpDir: `/tmp/sandbox-${level}/tmp`,
        sandboxLevel: level,
        env: {},
      });

      expect(result.args).toContain('--unshare-user');
    }
  });
});

describe('A3: --unshare-ipc IPC 命名空间隔离', () => {
  it('bwrap 参数包含 --unshare-ipc', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-ipc/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(result.args).toContain('--unshare-ipc');
  });
});

describe('A3: /etc 白名单式挂载', () => {
  it('不再整体挂载 /etc', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-etc/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    // 不应该有 --ro-bind /etc /etc 这种整体挂载
    const args = result.args;
    for (let i = 0; i < args.length - 2; i++) {
      if (args[i] === '--ro-bind' && args[i + 1] === '/etc' && args[i + 2] === '/etc') {
        throw new Error('/etc 被整体挂载，应该使用白名单式挂载');
      }
    }
  });

  it('/etc/passwd 和 /etc/shadow 不在 bind mount 参数中', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-passwd/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    // 只检查 bind mount 参数部分（排除 -- 之后的 shell command）
    const separatorIdx = result.args.indexOf('--');
    const bindArgs = result.args.slice(0, separatorIdx);
    const bindArgsStr = bindArgs.join(' ');

    expect(bindArgsStr).not.toContain('/etc/passwd');
    expect(bindArgsStr).not.toContain('/etc/shadow');
    expect(bindArgsStr).not.toContain('/etc/sudoers');
    expect(bindArgsStr).not.toContain('/etc/group');
  });

  it('必要的 /etc 子路径通过 --ro-bind-try 挂载', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-etc-sub/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    const args = result.args;
    const requiredPaths = [
      '/etc/ssl',
      '/etc/resolv.conf',
      '/etc/hosts',
      '/etc/ld.so.cache',
      '/etc/nsswitch.conf',
      '/etc/localtime',
    ];

    for (const p of requiredPaths) {
      // --ro-bind-try <src> <dest> 格式：args[idx] = src, args[idx+1] = dest
      const idx = args.indexOf(p);
      expect(idx).toBeGreaterThan(0);
      expect(args[idx - 1]).toBe('--ro-bind-try');
      expect(args[idx + 1]).toBe(p);
    }
  });
});

describe('A3: 完整命名空间隔离集合', () => {
  it('complete 级别包含所有 4 种 unshare', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-full/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    expect(result.args).toContain('--unshare-user');
    expect(result.args).toContain('--unshare-pid');
    expect(result.args).toContain('--unshare-ipc');
    expect(result.args).toContain('--unshare-net');
  });

  it('filesystem 级别包含 user + pid + ipc（无 net）', async () => {
    const { LinuxSandbox } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();

    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-fs/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    expect(result.args).toContain('--unshare-user');
    expect(result.args).toContain('--unshare-pid');
    expect(result.args).toContain('--unshare-ipc');
    expect(result.args).not.toContain('--unshare-net');
  });
});
