/**
 * executeDegraded 测试
 * 验证共享降级执行器的核心行为：banner/footer 输出、CommandExecutor 调用、
 * 沙箱清理、非零退出码处理、timeout 传递。
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockExecuteStreaming = vi.fn();
const mockCleanupSandbox = vi.fn();

vi.mock('../src/commandExecutor', () => ({
  CommandExecutor: function MockCommandExecutor() {
    return {
      executeStreaming: mockExecuteStreaming,
      cleanupSandbox: mockCleanupSandbox,
    };
  },
}));

import type { DegradationDecision } from '../src/policy';

const makeDegradation = (overrides?: Partial<DegradationDecision['sandboxConfig']>): DegradationDecision => ({
  canDegrade: true,
  reason: 'sandbox_not_supported_in_pty',
  sandboxConfig: {
    route: 'sandbox',
    sandboxLevel: 'filesystem',
    ...overrides,
  },
});

const makeSuccessResult = (overrides?: Record<string, unknown>) => ({
  stdout: 'hello\n',
  stderr: '',
  exitCode: 0,
  cwd: '/tmp',
  durationMs: 42,
  truncated: false,
  mode: 'sandbox' as const,
  timedOut: false,
  warnings: [],
  ...overrides,
});

const wrapAsHandle = (execResult: ReturnType<typeof makeSuccessResult>) => ({
  result: Promise.resolve(execResult),
  kill: () => {},
  pid: 12345,
});

describe('executeDegraded', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockCleanupSandbox.mockResolvedValue(undefined);
  });

  it('banner 和 success footer 通过 onOutput 正确输出', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));

    const { executeDegraded } = await import('../src/degraded-executor');
    const outputs: string[] = [];

    await executeDegraded({
      command: 'echo hello',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: (data) => outputs.push(data),
    });

    const combined = outputs.join('');
    expect(combined).toContain('🛡️');
    expect(combined).toContain('✓');
    expect(combined).not.toContain('⚠');
    expect(combined).not.toContain('✗');
  });

  it('非零退出码输出 warning footer', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult({ exitCode: 1 })));

    const { executeDegraded } = await import('../src/degraded-executor');
    const outputs: string[] = [];

    await executeDegraded({
      command: 'false',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: (data) => outputs.push(data),
    });

    const combined = outputs.join('');
    expect(combined).toContain('⚠');
    expect(combined).toContain('1');
    expect(combined).not.toContain('✓');
  });

  it('异常时输出 error footer 并返回 exitCode=1', async () => {
    mockExecuteStreaming.mockRejectedValue(new Error('spawn ENOENT'));

    const { executeDegraded } = await import('../src/degraded-executor');
    const outputs: string[] = [];

    const result = await executeDegraded({
      command: 'nonexistent',
      cwd: '/tmp',
      degradation: makeDegradation(),
      threadId: 'thread-1',
      onOutput: (data) => outputs.push(data),
    });

    const combined = outputs.join('');
    expect(combined).toContain('✗');
    expect(combined).toContain('spawn ENOENT');
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toBe('spawn ENOENT');
    expect(result.stdout).toBe('');
  });

  it('CommandExecutor 被正确调用，sandbox 参数传递正确', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));

    const { executeDegraded } = await import('../src/degraded-executor');

    await executeDegraded({
      command: 'ls',
      cwd: '/home/user',
      degradation: makeDegradation({
        route: 'sandbox',
        sandboxLevel: 'complete',
        networkMode: 'blocked',
        relaxedRules: ['curl-mutating'],
      }),
      threadId: 'thread-42',
      timeout: 60_000,
      onOutput: () => {},
    });

    expect(mockExecuteStreaming).toHaveBeenCalledOnce();
    const callArgs = mockExecuteStreaming.mock.calls[0][0];
    expect(callArgs.command).toBe('ls');
    expect(callArgs.mode).toBe('sandbox');
    expect(callArgs.sandboxLevel).toBe('complete');
    expect(callArgs.workingDirectory).toBe('/home/user');
    expect(callArgs.threadId).toBe('thread-42');
    expect(callArgs.timeout).toBe(60_000);
    expect(callArgs.policyOverrides).toBeDefined();
    expect(callArgs.policyOverrides.networkMode).toBe('blocked');
    expect(callArgs.policyOverrides.relaxedRules).toEqual(['curl-mutating']);
  });

  it('沙箱清理在 finally 中执行（成功路径）', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));

    const { executeDegraded } = await import('../src/degraded-executor');

    await executeDegraded({
      command: 'echo ok',
      cwd: '/tmp',
      degradation: makeDegradation(),
      threadId: 'thread-cleanup',
      onOutput: () => {},
    });

    expect(mockCleanupSandbox).toHaveBeenCalledWith('thread-cleanup');
  });

  it('沙箱清理在 finally 中执行（异常路径）', async () => {
    mockExecuteStreaming.mockRejectedValue(new Error('fail'));

    const { executeDegraded } = await import('../src/degraded-executor');

    await executeDegraded({
      command: 'bad',
      cwd: '/tmp',
      degradation: makeDegradation(),
      threadId: 'thread-fail',
      onOutput: () => {},
    });

    expect(mockCleanupSandbox).toHaveBeenCalledWith('thread-fail');
  });

  it('无 threadId 时使用自动生成的 degraded threadId 做 cleanupSandbox', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));

    const { executeDegraded } = await import('../src/degraded-executor');

    await executeDegraded({
      command: 'echo ok',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: () => {},
    });

    expect(mockCleanupSandbox).toHaveBeenCalledOnce();
    expect(mockCleanupSandbox.mock.calls[0][0]).toMatch(/^degraded-/);
  });

  it('timeout 默认值为 120_000', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));

    const { executeDegraded } = await import('../src/degraded-executor');

    await executeDegraded({
      command: 'sleep 1',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: () => {},
    });

    const callArgs = mockExecuteStreaming.mock.calls[0][0];
    expect(callArgs.timeout).toBe(120_000);
  });

  it('route=regular 时 mode 为 regular', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult({ mode: 'regular' })));

    const { executeDegraded } = await import('../src/degraded-executor');

    await executeDegraded({
      command: 'ls',
      cwd: '/tmp',
      degradation: makeDegradation({ route: 'regular' }),
      onOutput: () => {},
    });

    const callArgs = mockExecuteStreaming.mock.calls[0][0];
    expect(callArgs.mode).toBe('regular');
  });

  it('stdout/stderr 回调流经 \n → \r\n 转换后推送到 onOutput', async () => {
    mockExecuteStreaming.mockImplementation(async (opts: any) => {
      opts.onStdout?.('line1\nline2\n');
      opts.onStderr?.('err\n');
      return wrapAsHandle(makeSuccessResult());
    });

    const { executeDegraded } = await import('../src/degraded-executor');
    const outputs: string[] = [];

    await executeDegraded({
      command: 'echo test',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: (data) => outputs.push(data),
    });

    const combined = outputs.join('');
    expect(combined).toContain('line1\r\nline2\r\n');
    expect(combined).toContain('err\r\n');
  });

  it('返回结果结构正确', async () => {
    mockExecuteStreaming.mockImplementation(async (opts: any) => {
      opts.onStdout?.('output');
      opts.onStderr?.('warn');
      return wrapAsHandle(makeSuccessResult({ warnings: ['sandbox degraded'] }));
    });

    const { executeDegraded } = await import('../src/degraded-executor');

    const result = await executeDegraded({
      command: 'echo test',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: () => {},
    });

    expect(result.stdout).toBe('output');
    expect(result.stderr).toBe('warn');
    expect(result.exitCode).toBe(0);
    expect(result.cwd).toBe('/tmp');
    expect(result.timedOut).toBe(false);
    expect(result.sandboxApplied).toBe(true);
    expect(result.warnings).toEqual(['sandbox degraded']);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('无 onOutput 时不抛异常', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));

    const { executeDegraded } = await import('../src/degraded-executor');

    const result = await executeDegraded({
      command: 'echo silent',
      cwd: '/tmp',
      degradation: makeDegradation(),
    });

    expect(result.exitCode).toBe(0);
  });

  it('交互式命令被阻断，不调用 CommandExecutor', async () => {
    const { executeDegraded } = await import('../src/degraded-executor');
    const outputs: string[] = [];

    const result = await executeDegraded({
      command: 'vim',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: (data) => outputs.push(data),
    });

    expect(result.interactiveBlocked).toBe(true);
    expect(result.interactiveReason).toBeDefined();
    expect(result.matchedCommand).toBe('vim');
    expect(result.exitCode).toBe(-1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toBe('');
    expect(result.sandboxApplied).toBe(false);
    expect(mockExecuteStreaming).not.toHaveBeenCalled();
    expect(outputs).toHaveLength(0);
  });

  it('交互式 REPL（python 无参数）被阻断', async () => {
    const { executeDegraded } = await import('../src/degraded-executor');

    const result = await executeDegraded({
      command: 'python',
      cwd: '/tmp',
      degradation: makeDegradation(),
    });

    expect(result.interactiveBlocked).toBe(true);
    expect(result.matchedCommand).toBe('python');
  });

  it('非交互式 REPL 调用（python script.py）正常降级执行', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));
    const { executeDegraded } = await import('../src/degraded-executor');

    const result = await executeDegraded({
      command: 'python script.py',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: () => {},
    });

    expect(result.interactiveBlocked).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(mockExecuteStreaming).toHaveBeenCalledOnce();
  });

  it('ssh 命令被阻断', async () => {
    const { executeDegraded } = await import('../src/degraded-executor');

    const result = await executeDegraded({
      command: 'ssh user@host',
      cwd: '/tmp',
      degradation: makeDegradation(),
    });

    expect(result.interactiveBlocked).toBe(true);
    expect(result.matchedCommand).toBe('ssh');
  });

  it('普通命令正常降级执行', async () => {
    mockExecuteStreaming.mockResolvedValue(wrapAsHandle(makeSuccessResult()));
    const { executeDegraded } = await import('../src/degraded-executor');

    const result = await executeDegraded({
      command: 'ls -la',
      cwd: '/tmp',
      degradation: makeDegradation(),
      onOutput: () => {},
    });

    expect(result.interactiveBlocked).toBeUndefined();
    expect(result.exitCode).toBe(0);
    expect(mockExecuteStreaming).toHaveBeenCalledOnce();
  });
});
