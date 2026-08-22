/**
 * CommandExecutor.executeStreaming 测试
 * 验证流式执行的回调触发、输出聚合、与 execute() 行为一致性。
 */
import { describe, it, expect, vi } from 'vitest';

vi.mock('../src/platform', () => ({
  createPlatformSandbox: vi.fn(() => ({
    platform: 'linux',
    isAvailable: vi.fn().mockResolvedValue(false),
    buildSpawnArgs: vi.fn(),
  })),
}));

vi.mock('../src/sandboxManager', () => {
  class MockSandboxManager {
    async ensureSandbox() {
      return {
        sandboxDir: '/tmp/test-sandbox',
        projectDir: '/tmp',
        tmpDir: '/tmp/test-sandbox-tmp',
      };
    }
  }
  return {
    SandboxManager: MockSandboxManager,
    isSymlinkWithinRoot: vi.fn().mockReturnValue(true),
  };
});

describe('CommandExecutor.executeStreaming', () => {
  it('返回 StreamingHandle 包含 result/kill/pid', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const handle = await executor.executeStreaming({
      command: 'echo handle-test',
      mode: 'regular',
      timeoutMs: 5000,
    });

    expect(handle).toHaveProperty('result');
    expect(handle).toHaveProperty('kill');
    expect(handle).toHaveProperty('pid');
    expect(typeof handle.kill).toBe('function');
    expect(typeof handle.pid).toBe('number');

    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('handle-test');
  });

  it('流式回调接收 stdout chunks', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const stdoutChunks: string[] = [];
    const handle = await executor.executeStreaming({
      command: 'echo hello && echo world',
      mode: 'regular',
      timeoutMs: 5000,
      onStdout: (chunk) => stdoutChunks.push(chunk),
    });

    const result = await handle.result;
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain('hello');
    expect(result.stdout).toContain('world');
    expect(stdoutChunks.length).toBeGreaterThan(0);
    expect(stdoutChunks.join('')).toContain('hello');
  });

  it('流式回调接收 stderr chunks', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const stderrChunks: string[] = [];
    const handle = await executor.executeStreaming({
      command: 'echo error-output >&2',
      mode: 'regular',
      timeoutMs: 5000,
      onStderr: (chunk) => stderrChunks.push(chunk),
    });

    const result = await handle.result;
    expect(result.stderr).toContain('error-output');
    expect(stderrChunks.length).toBeGreaterThan(0);
    expect(stderrChunks.join('')).toContain('error-output');
  });

  it('无回调时 result 与 execute() 一致', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const handle = await executor.executeStreaming({
      command: 'echo consistent',
      mode: 'regular',
      timeoutMs: 5000,
    });
    const streamResult = await handle.result;

    const execResult = await executor.execute({
      command: 'echo consistent',
      mode: 'regular',
      timeoutMs: 5000,
    });

    expect(streamResult.stdout.trim()).toBe(execResult.stdout.trim());
    expect(streamResult.exitCode).toBe(execResult.exitCode);
    expect(streamResult.mode).toBe(execResult.mode);
  });

  it('timeout 参数覆盖 timeoutMs', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const handle = await executor.executeStreaming({
      command: 'sleep 10',
      mode: 'regular',
      timeoutMs: 30000,
      timeout: 500,
    });

    const result = await handle.result;
    expect(result.timedOut).toBe(true);
  });

  it('kill() 终止进程', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const handle = await executor.executeStreaming({
      command: 'sleep 60',
      mode: 'regular',
      timeoutMs: 30000,
    });

    expect(handle.pid).toBeDefined();
    handle.kill();

    const result = await handle.result;
    expect(result.exitCode).not.toBe(0);
  });

  it('kill() 在进程退出后不会再补发延迟 SIGKILL', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });
    const originalKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: number | NodeJS.Signals) => {
      return originalKill(pid, signal);
    }) as typeof process.kill);

    try {
      const handle = await executor.executeStreaming({
        command: 'sleep 60',
        mode: 'regular',
        timeoutMs: 30000,
      });

      handle.kill();
      await handle.result;

      const callCountAfterExit = killSpy.mock.calls.length;
      expect(callCountAfterExit).toBeGreaterThan(0);

      await new Promise((resolve) => setTimeout(resolve, 3200));
      expect(killSpy.mock.calls.length).toBe(callCountAfterExit);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('返回的 ExecuteResult 包含完整聚合的 stdout/stderr', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const handle = await executor.executeStreaming({
      command: 'echo line-1 && echo line-2 && echo line-3',
      mode: 'regular',
      timeoutMs: 5000,
      onStdout: () => {},
    });

    const result = await handle.result;
    expect(result.stdout).toContain('line-1');
    expect(result.stdout).toContain('line-2');
    expect(result.stdout).toContain('line-3');
    expect(result.exitCode).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('非零退出码正确传递', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const handle = await executor.executeStreaming({
      command: 'exit 42',
      mode: 'regular',
      timeoutMs: 5000,
    });

    const result = await handle.result;
    expect(result.exitCode).toBe(42);
  });
});

describe('CommandExecutor.execute 重构后行为不变', () => {
  it('基础执行仍然正常', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    const result = await executor.execute({
      command: 'echo refactor-ok',
      mode: 'regular',
      timeoutMs: 5000,
    });

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe('refactor-ok');
    expect(result.mode).toBe('regular');
  });

  it('空命令仍然抛错', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    await expect(
      executor.execute({ command: '  ', mode: 'regular' }),
    ).rejects.toThrow();
  });

  it('blocked 策略仍然抛错', async () => {
    const { CommandExecutor } = await import('../src/commandExecutor');
    const executor = new CommandExecutor({ workspaceRoot: '/tmp' });

    await expect(
      executor.execute({
        command: 'echo test',
        mode: 'regular',
        policyOverrides: { route: 'blocked', denyReason: 'test block' },
      }),
    ).rejects.toThrow('test block');
  });
});
