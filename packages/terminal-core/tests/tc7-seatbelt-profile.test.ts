/**
 * TC-7 回归测试：macOS Seatbelt profile 安全性验证
 *
 * 验证修复后的 profile 不再包含过度宽松的规则：
 * - process-exec 限制为已知安全路径
 * - mach-lookup 限制为必要服务
 * - /private/tmp 限制为沙箱临时目录
 */
import { describe, it, expect, vi } from 'vitest';
import fs from 'node:fs';

// Mock fs to capture writeFileSync calls
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    default: {
      ...actual,
      mkdirSync: vi.fn(),
      writeFileSync: vi.fn(),
      existsSync: actual.existsSync,
    },
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    existsSync: actual.existsSync,
  };
});

vi.mock('./detect', () => ({
  isDarwinSandboxAvailable: async () => true,
}));

describe('TC-7: Seatbelt profile 安全限制', () => {
  let capturedProfile: string;

  it('buildSpawnArgs 生成的 profile 不含无限制的 process-exec', async () => {
    const { DarwinSandbox } = await import('../src/platform/darwin');
    const sandbox = new DarwinSandbox();

    const writeFileMock = vi.mocked(fs.writeFileSync);
    writeFileMock.mockImplementation(() => {});
    const mkdirMock = vi.mocked(fs.mkdirSync);
    mkdirMock.mockImplementation(() => undefined as any);

    sandbox.buildSpawnArgs({
      command: 'ls -la',
      cwd: '/Users/test/project',
      tmpDir: '/tmp/sandbox-123/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    // Get the profile content from writeFileSync call
    expect(writeFileMock).toHaveBeenCalled();
    capturedProfile = writeFileMock.mock.calls[0][1] as string;

    // Profile should NOT contain unrestricted (allow process-exec)
    // It should have path restrictions
    expect(capturedProfile).not.toMatch(/^\(allow process-exec\)$/m);
    // It should contain process-exec with subpath restrictions
    expect(capturedProfile).toMatch(/\(allow process-exec/);
    expect(capturedProfile).toMatch(/subpath "\/usr\/bin"/);
    expect(capturedProfile).toMatch(/subpath "\/bin"/);
  });

  it('profile 不含无限制的 mach-lookup', async () => {
    const { DarwinSandbox } = await import('../src/platform/darwin');
    const sandbox = new DarwinSandbox();

    const writeFileMock = vi.mocked(fs.writeFileSync);
    writeFileMock.mockClear();
    writeFileMock.mockImplementation(() => {});
    const mkdirMock = vi.mocked(fs.mkdirSync);
    mkdirMock.mockImplementation(() => undefined as any);

    sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/Users/test/project',
      tmpDir: '/tmp/sandbox-456/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    capturedProfile = writeFileMock.mock.calls[0][1] as string;

    // Profile should NOT contain unrestricted mach-lookup
    expect(capturedProfile).not.toMatch(/^\(allow mach-lookup\)$/m);
    // It should have specific service restrictions
    expect(capturedProfile).toMatch(/global-name "com\.apple\.system\.logger"/);
  });

  it('profile 不包含通配的 /private/tmp 访问', async () => {
    const { DarwinSandbox } = await import('../src/platform/darwin');
    const sandbox = new DarwinSandbox();

    const writeFileMock = vi.mocked(fs.writeFileSync);
    writeFileMock.mockClear();
    writeFileMock.mockImplementation(() => {});
    const mkdirMock = vi.mocked(fs.mkdirSync);
    mkdirMock.mockImplementation(() => undefined as any);

    sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/Users/test/project',
      tmpDir: '/tmp/sandbox-789/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    capturedProfile = writeFileMock.mock.calls[0][1] as string;

    // Profile should NOT allow reading all of /private/tmp
    expect(capturedProfile).not.toMatch(/subpath "\/private\/tmp"/);
  });

  it('complete 级别不允许网络', async () => {
    const { DarwinSandbox } = await import('../src/platform/darwin');
    const sandbox = new DarwinSandbox();

    const writeFileMock = vi.mocked(fs.writeFileSync);
    writeFileMock.mockClear();
    writeFileMock.mockImplementation(() => {});
    const mkdirMock = vi.mocked(fs.mkdirSync);
    mkdirMock.mockImplementation(() => undefined as any);

    sandbox.buildSpawnArgs({
      command: 'echo test',
      cwd: '/Users/test/project',
      tmpDir: '/tmp/sandbox-net/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    capturedProfile = writeFileMock.mock.calls[0][1] as string;
    expect(capturedProfile).not.toMatch(/allow network-outbound/);
    expect(capturedProfile).not.toMatch(/allow network-inbound/);
  });

  it('filesystem 级别允许网络', async () => {
    const { DarwinSandbox } = await import('../src/platform/darwin');
    const sandbox = new DarwinSandbox();

    const writeFileMock = vi.mocked(fs.writeFileSync);
    writeFileMock.mockClear();
    writeFileMock.mockImplementation(() => {});
    const mkdirMock = vi.mocked(fs.mkdirSync);
    mkdirMock.mockImplementation(() => undefined as any);

    sandbox.buildSpawnArgs({
      command: 'curl http://example.com',
      cwd: '/Users/test/project',
      tmpDir: '/tmp/sandbox-net2/tmp',
      sandboxLevel: 'filesystem',
      env: {},
    });

    capturedProfile = writeFileMock.mock.calls[0][1] as string;
    expect(capturedProfile).toMatch(/allow network-outbound/);
  });

  it('TC-8: 命令使用 set -euo pipefail 包裹', async () => {
    const { DarwinSandbox } = await import('../src/platform/darwin');
    const sandbox = new DarwinSandbox();

    const writeFileMock = vi.mocked(fs.writeFileSync);
    writeFileMock.mockClear();
    writeFileMock.mockImplementation(() => {});
    const mkdirMock = vi.mocked(fs.mkdirSync);
    mkdirMock.mockImplementation(() => undefined as any);

    const result = sandbox.buildSpawnArgs({
      command: 'echo hello',
      cwd: '/Users/test/project',
      tmpDir: '/tmp/sandbox-cmd/tmp',
      sandboxLevel: 'complete',
      env: {},
    });

    // The command should be wrapped with set -euo pipefail
    const shCommand = result.args[result.args.length - 1];
    expect(shCommand).toContain('set -euo pipefail');
    expect(shCommand).toContain('echo hello');
  });
});
