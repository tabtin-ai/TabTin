/**
 * TC-4 回归测试：shell 别名/函数覆盖绕过 — 降级模式修复验证
 *
 * 修复方案：降级模式使用 /bin/sh -c 而非 { shell: true }，
 * 避免加载用户 shell 配置中的 alias/function 定义。
 *
 * 注意：此测试验证 CommandExecutor 的 spawn 参数，不实际执行命令。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import * as childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';

// Mock child_process.spawn to capture arguments
vi.mock('node:child_process', () => {
  return {
    spawn: vi.fn(),
  };
});

// Mock platform sandbox to force degraded mode
vi.mock('../src/platform', () => {
  return {
    createPlatformSandbox: () => ({
      platform: 'linux',
      isAvailable: async () => false,
      buildSpawnArgs: vi.fn(),
    }),
  };
});

// Mock platform detect
vi.mock('../src/platform/detect', () => ({
  getBwrapUnavailableReason: () => 'bwrap not available in test',
}));

describe('TC-4: 降级模式不使用 { shell: true }', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('降级模式使用 /bin/sh -c 而非 shell: true', async () => {
    // Create a mock child process
    const mockChild = new EventEmitter() as any;
    mockChild.stdout = new EventEmitter();
    mockChild.stderr = new EventEmitter();
    mockChild.kill = vi.fn();

    const spawnMock = vi.mocked(childProcess.spawn);
    spawnMock.mockReturnValue(mockChild as any);

    // Import after mocks are set up
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({
      workspaceRoot: '/tmp/test-workspace',
      sandboxRoot: '/tmp/test-sandbox',
    });

    // Execute a simple allowed command in regular (non-sandbox) mode
    const resultPromise = executor.execute({
      command: 'ls -la',
      mode: 'regular',
    });

    // Trigger close to resolve the promise
    setTimeout(() => {
      mockChild.emit('close', 0);
    }, 10);

    await resultPromise;

    // Verify spawn was called with /bin/sh -c, not { shell: true }
    expect(spawnMock).toHaveBeenCalledWith(
      '/bin/sh',
      ['-c', 'ls -la'],
      expect.objectContaining({
        shell: false,
      }),
    );

    // Verify it was NOT called with { shell: true }
    const callArgs = spawnMock.mock.calls[0];
    if (callArgs.length === 2) {
      // spawn(command, { shell: true }) form — should NOT happen
      expect((callArgs[1] as any)?.shell).not.toBe(true);
    }
  });
});
