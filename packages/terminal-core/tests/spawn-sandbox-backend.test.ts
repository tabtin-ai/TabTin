import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SpawnSandboxBackend, SpawnSandboxBackendFactory } from '../src/backend/spawn-sandbox-backend';
import type { CommandExecutor } from '../src/commandExecutor';
import type { ExecuteResult, StreamingExecuteOptions, StreamingHandle } from '../src/types';

function makeMockExecutor(
  overrides: Partial<ExecuteResult> = {},
): CommandExecutor {
  const defaultResult: ExecuteResult = {
    stdout: 'hello\n',
    stderr: '',
    exitCode: 0,
    cwd: '/tmp',
    durationMs: 42,
    truncated: false,
    mode: 'regular',
    timedOut: false,
    ...overrides,
  };

  return {
    execute: vi.fn(),
    executeStreaming: vi.fn(async (_opts: StreamingExecuteOptions): Promise<StreamingHandle> => ({
      result: Promise.resolve(defaultResult),
      kill: () => {},
      pid: 9999,
    })),
    cleanupSandbox: vi.fn(async () => {}),
  } as unknown as CommandExecutor;
}

describe('SpawnSandboxBackend', () => {
  let executor: CommandExecutor;
  let backend: SpawnSandboxBackend;

  beforeEach(() => {
    executor = makeMockExecutor();
    backend = new SpawnSandboxBackend(executor);
  });

  it('id 和 capabilities 符合预期', () => {
    expect(backend.id).toBe('local-spawn');
    expect(backend.capabilities.supportsInteractive).toBe(false);
    expect(backend.capabilities.supportsSandbox).toBe(true);
    expect(backend.capabilities.latencyClass).toBe('local');
    expect(backend.capabilities.platforms).toContain('darwin');
    expect(backend.capabilities.platforms).toContain('linux');
  });

  it('execute 调用 executor.executeStreaming 并映射结果', async () => {
    const result = await backend.execute({
      command: 'echo hi',
      cwd: '/tmp',
    });

    expect(result.stdout).toBe('hello\n');
    expect(result.stderr).toBe('');
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBe(42);
    expect(result.backendId).toBe('local-spawn');
    expect(result.sandboxApplied).toBe(false);
    expect(result.degraded).toBe(false);
    expect(result.warnings).toEqual([]);

    expect(executor.executeStreaming).toHaveBeenCalledTimes(1);
    const callArgs = (executor.executeStreaming as any).mock.calls[0][0] as StreamingExecuteOptions;
    expect(callArgs.command).toBe('echo hi');
    expect(callArgs.mode).toBe('regular');
    expect(callArgs.workingDirectory).toBe('/tmp');
  });

  it('沙箱策略 route=sandbox 传递 sandboxLevel', async () => {
    await backend.execute({
      command: 'ls',
      cwd: '/workspace',
      policy: {
        route: 'sandbox',
        sandboxLevel: 'complete',
      },
    });

    const callArgs = (executor.executeStreaming as any).mock.calls[0][0] as StreamingExecuteOptions;
    expect(callArgs.mode).toBe('sandbox');
    expect(callArgs.sandboxLevel).toBe('complete');
  });

  it('沙箱策略 route=sandbox 无 sandboxLevel 时默认 filesystem', async () => {
    await backend.execute({
      command: 'ls',
      cwd: '/workspace',
      policy: { route: 'sandbox' },
    });

    const callArgs = (executor.executeStreaming as any).mock.calls[0][0] as StreamingExecuteOptions;
    expect(callArgs.mode).toBe('sandbox');
    expect(callArgs.sandboxLevel).toBe('filesystem');
  });

  it('转发 onStdout / onStderr 回调', async () => {
    const onStdout = vi.fn();
    const onStderr = vi.fn();

    await backend.execute({
      command: 'echo test',
      cwd: '/tmp',
      onStdout,
      onStderr,
    });

    const callArgs = (executor.executeStreaming as any).mock.calls[0][0] as StreamingExecuteOptions;
    expect(callArgs.onStdout).toBe(onStdout);
    expect(callArgs.onStderr).toBe(onStderr);
  });

  it('转发 timeout 参数', async () => {
    await backend.execute({
      command: 'sleep 10',
      cwd: '/tmp',
      timeout: 5000,
    });

    const callArgs = (executor.executeStreaming as any).mock.calls[0][0] as StreamingExecuteOptions;
    expect(callArgs.timeoutMs).toBe(5000);
  });

  it('osSandbox=true 时 sandboxApplied 为 true', async () => {
    executor = makeMockExecutor({ osSandbox: true });
    backend = new SpawnSandboxBackend(executor);

    const result = await backend.execute({
      command: 'ls',
      cwd: '/tmp',
      policy: { route: 'sandbox', sandboxLevel: 'filesystem' },
    });

    expect(result.sandboxApplied).toBe(true);
  });

  it('osSandboxDegraded=true 时 degraded 为 true', async () => {
    executor = makeMockExecutor({ osSandboxDegraded: true });
    backend = new SpawnSandboxBackend(executor);

    const result = await backend.execute({
      command: 'ls',
      cwd: '/tmp',
    });

    expect(result.degraded).toBe(true);
  });

  it('warnings 正确传递', async () => {
    executor = makeMockExecutor({
      warnings: ['OS sandbox degraded: bwrap unavailable'],
    });
    backend = new SpawnSandboxBackend(executor);

    const result = await backend.execute({ command: 'ls', cwd: '/tmp' });

    expect(result.warnings).toEqual(['OS sandbox degraded: bwrap unavailable']);
  });

  it('cleanup 不抛出', async () => {
    await expect(backend.cleanup()).resolves.toBeUndefined();
  });
});

describe('SpawnSandboxBackendFactory', () => {
  it('create 返回 SpawnSandboxBackend 实例', async () => {
    const executor = makeMockExecutor();
    const factory = new SpawnSandboxBackendFactory(executor);

    const backend = await factory.create({});
    expect(backend).toBeInstanceOf(SpawnSandboxBackend);
    expect(backend.id).toBe('local-spawn');
  });
});
