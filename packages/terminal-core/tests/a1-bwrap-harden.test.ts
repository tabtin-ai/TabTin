/**
 * A1 bwrap 加固回归测试
 *
 * 验证三项安全加固：
 * 1. /etc 白名单挂载（不含 /etc/shadow 等敏感文件）
 * 2. 敏感环境变量在沙箱内被过滤（/proc/self/environ 防泄露）
 * 3. dereference:false + 外部符号链接过滤
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

describe('A1-1: bwrap /etc 白名单挂载', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('/etc 不被整体挂载', async () => {
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
      command: 'ls',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-etc/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    const argStr = result.args.join(' ');
    expect(argStr).not.toMatch(/--ro-bind\s+\/etc\s+\/etc/);
    expect(argStr).not.toMatch(/--ro-bind-try\s+\/etc\s+\/etc/);
  });

  it('白名单中包含 DNS/TLS/链接器所需条目', async () => {
    const { ETC_REQUIRED_ENTRIES } = await import('../src/platform/linux');

    const required = ['/etc/resolv.conf', '/etc/hosts', '/etc/ssl', '/etc/nsswitch.conf',
      '/etc/ld.so.cache', '/etc/ld.so.conf'];
    for (const entry of required) {
      expect(ETC_REQUIRED_ENTRIES).toContain(entry);
    }
  });

  it('白名单中不包含敏感路径', async () => {
    const { ETC_REQUIRED_ENTRIES } = await import('../src/platform/linux');

    const forbidden = ['/etc/shadow', '/etc/gshadow', '/etc/sudoers',
      '/etc/ssh', '/etc/sudoers.d', '/etc/passwd'];
    for (const entry of forbidden) {
      expect(ETC_REQUIRED_ENTRIES).not.toContain(entry);
    }
  });

  it('每个白名单条目使用 --ro-bind-try 挂载', async () => {
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

    const { LinuxSandbox, ETC_REQUIRED_ENTRIES } = await import('../src/platform/linux');
    const sandbox = new LinuxSandbox();
    const result = sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-etc2/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    for (const entry of ETC_REQUIRED_ENTRIES) {
      const idx = result.args.indexOf(entry);
      expect(idx).toBeGreaterThan(-1);
      expect(result.args[idx - 1]).toBe('--ro-bind-try');
    }
  });
});

describe('A1-2: 敏感环境变量过滤', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it('isSensitiveSandboxKey 识别已知敏感键', async () => {
    const { isSensitiveSandboxKey } = await import('../src/sanitizeEnv');

    const sensitiveKeys = [
      'AWS_SECRET_ACCESS_KEY', 'AZURE_CLIENT_SECRET', 'OPENAI_API_KEY',
      'ANTHROPIC_API_KEY', 'GITHUB_TOKEN', 'NPM_TOKEN', 'DATABASE_URL',
      'REDIS_URL', 'SSH_AUTH_SOCK', 'STRIPE_SECRET_KEY', 'MY_PASSWORD',
      'DB_CREDENTIAL', 'PRIVATE_KEY_PATH',
    ];
    for (const key of sensitiveKeys) {
      expect(isSensitiveSandboxKey(key)).toBe(true);
    }
  });

  it('isSensitiveSandboxKey 放行安全键', async () => {
    const { isSensitiveSandboxKey } = await import('../src/sanitizeEnv');

    const safeKeys = [
      'PATH', 'HOME', 'USER', 'SHELL', 'LANG', 'TERM', 'NODE_ENV',
      'HOSTNAME', 'PWD', 'TMPDIR', 'EDITOR',
    ];
    for (const key of safeKeys) {
      expect(isSensitiveSandboxKey(key)).toBe(false);
    }
  });

  it('sanitizeSandboxEnv 移除敏感变量，保留安全变量', async () => {
    const { sanitizeSandboxEnv } = await import('../src/sanitizeEnv');

    const input = {
      PATH: '/usr/bin',
      HOME: '/home/user',
      OPENAI_API_KEY: 'sk-xxx',
      AWS_SECRET_ACCESS_KEY: 'aws-secret',
      NODE_ENV: 'production',
      DATABASE_URL: 'postgres://...',
      LANG: 'en_US.UTF-8',
    };

    const result = sanitizeSandboxEnv(input);
    expect(result).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/user',
      NODE_ENV: 'production',
      LANG: 'en_US.UTF-8',
    });
  });

  it('bwrap spawn args 使用清洗后的 env', async () => {
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
      command: 'node index.js',
      cwd: '/home/test/project',
      tmpDir: '/tmp/sandbox-env/tmp',
      sandboxLevel: 'complete',
      env: {
        PATH: '/usr/bin',
        OPENAI_API_KEY: 'sk-leaked',
        GITHUB_TOKEN: 'ghp_leaked',
        HOME: '/home/test',
      },
    });

    const env = result.options.env as Record<string, string>;
    expect(env.PATH).toBe('/usr/bin');
    expect(env.HOME).toBe('/home/test');
    expect(env).not.toHaveProperty('OPENAI_API_KEY');
    expect(env).not.toHaveProperty('GITHUB_TOKEN');
  });
});

describe('A1-3: dereference:false + 符号链接过滤', () => {
  let testDir: string;
  let sourceDir: string;
  let sandboxRoot: string;

  beforeEach(async () => {
    testDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'a1-symlink-'));
    sourceDir = path.join(testDir, 'source');
    sandboxRoot = path.join(testDir, 'sandbox');

    await fsPromises.mkdir(sourceDir, { recursive: true });
    await fsPromises.writeFile(path.join(sourceDir, 'real.txt'), 'real content');
    await fsPromises.mkdir(path.join(sourceDir, 'subdir'), { recursive: true });
    await fsPromises.writeFile(path.join(sourceDir, 'subdir', 'nested.txt'), 'nested');
  });

  afterEach(async () => {
    try {
      await fsPromises.rm(testDir, { recursive: true, force: true, maxRetries: 3 });
    } catch {
      const chmodR = async (p: string) => {
        try {
          const s = await fsPromises.stat(p).catch(() => fsPromises.lstat(p));
          if (s.isDirectory()) {
            await fsPromises.chmod(p, 0o755);
            for (const e of await fsPromises.readdir(p)) {
              await chmodR(path.join(p, e));
            }
          } else {
            await fsPromises.chmod(p, 0o644);
          }
        } catch { /* ignore */ }
      };
      await chmodR(testDir);
      await fsPromises.rm(testDir, { recursive: true, force: true });
    }
  });

  it('isSymlinkWithinRoot 接受内部符号链接', async () => {
    const { isSymlinkWithinRoot } = await import('../src/sandboxManager');

    const linkPath = path.join(sourceDir, 'internal-link');
    await fsPromises.symlink(path.join(sourceDir, 'real.txt'), linkPath);

    expect(isSymlinkWithinRoot(linkPath, sourceDir)).toBe(true);
  });

  it('isSymlinkWithinRoot 拒绝外部符号链接', async () => {
    const { isSymlinkWithinRoot } = await import('../src/sandboxManager');

    const externalTarget = path.join(testDir, 'outside.txt');
    await fsPromises.writeFile(externalTarget, 'external');
    const linkPath = path.join(sourceDir, 'external-link');
    await fsPromises.symlink(externalTarget, linkPath);

    expect(isSymlinkWithinRoot(linkPath, sourceDir)).toBe(false);
  });

  it('isSymlinkWithinRoot 对断链返回 false', async () => {
    const { isSymlinkWithinRoot } = await import('../src/sandboxManager');

    const linkPath = path.join(sourceDir, 'broken-link');
    await fsPromises.symlink('/nonexistent/target', linkPath);

    expect(isSymlinkWithinRoot(linkPath, sourceDir)).toBe(false);
  });

  it('ensureSandbox 过滤指向外部的符号链接', async () => {
    const { SandboxManager } = await import('../src/sandboxManager');

    const externalTarget = path.join(testDir, 'secret.txt');
    await fsPromises.writeFile(externalTarget, 'sensitive data');
    await fsPromises.symlink(externalTarget, path.join(sourceDir, 'escape-link'));

    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('symlink-test', sourceDir);

    expect(fs.existsSync(path.join(ctx.projectDir, 'real.txt'))).toBe(true);
    expect(fs.existsSync(path.join(ctx.projectDir, 'escape-link'))).toBe(false);
  });

  it('ensureSandbox 保留内部相对符号链接', async () => {
    const { SandboxManager } = await import('../src/sandboxManager');

    await fsPromises.symlink('real.txt', path.join(sourceDir, 'relative-link'));

    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('relative-link-test', sourceDir);

    expect(fs.existsSync(path.join(ctx.projectDir, 'real.txt'))).toBe(true);
    const linkStat = await fsPromises.lstat(path.join(ctx.projectDir, 'relative-link'));
    expect(linkStat.isSymbolicLink()).toBe(true);
  });

  it('makeReadonly 不对符号链接调用 chmod', async () => {
    const { SandboxManager } = await import('../src/sandboxManager');

    await fsPromises.symlink('real.txt', path.join(sourceDir, 'safe-link'));

    const manager = new SandboxManager(sandboxRoot);
    const ctx = await manager.ensureSandbox('chmod-link-test', sourceDir);

    const linkPath = path.join(ctx.projectDir, 'safe-link');
    if (fs.existsSync(linkPath)) {
      const linkStat = await fsPromises.lstat(linkPath);
      expect(linkStat.isSymbolicLink()).toBe(true);
    }

    const fileStat = await fsPromises.stat(path.join(ctx.projectDir, 'real.txt'));
    expect(fileStat.mode & 0o222).toBe(0);
  });
});
