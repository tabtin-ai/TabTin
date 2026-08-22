import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalRuntimeBridge } from '@tabtin/terminal-core';
import {
  resolveTerminalRuntimeBridge,
  setPtyManagerAPI,
  setTerminalRuntimeBridge,
} from '../runtime-bridge';
import {
  executeInTerminalTool,
  readTerminalOutputTool,
  writeToTerminalTool,
} from '../../tools/terminal';

describe('terminal runtime bridge', () => {
  afterEach(() => {
    setTerminalRuntimeBridge(null);
    setPtyManagerAPI(null);
    vi.restoreAllMocks();
  });

  it('优先返回显式注入的 terminal runtime bridge', async () => {
    const explicitBridge: TerminalRuntimeBridge = {
      getCapabilities: () => ['execute'],
      execute: vi.fn().mockResolvedValue({
        output: 'ok',
        exitCode: 0,
        cwd: '/tmp',
        backgrounded: false,
        timedOut: false,
        durationMs: 12,
        sessionId: 'explicit-session',
      }),
    };

    setTerminalRuntimeBridge(explicitBridge);
    setPtyManagerAPI({
      executeCommand: vi.fn(),
    });

    const resolved = resolveTerminalRuntimeBridge();
    expect(resolved).toBe(explicitBridge);

    const result = await executeInTerminalTool.execute({ command: 'echo hello' });
    expect(result.success).toBe(true);
    expect(explicitBridge.execute).toHaveBeenCalledTimes(1);
  });

  it('在未注入新 bridge 时自动适配 legacy PtyManagerAPI', async () => {
    const getOrSpawnAgentSession = vi.fn().mockReturnValue('session-1');
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'hello',
      exitCode: 0,
      cwd: '/workspace',
      backgrounded: false,
      timedOut: false,
      durationMs: 20,
      sessionId: 'session-1',
    });
    const readOutput = vi.fn().mockReturnValue({
      output: 'tail output',
      metadata: {
        pid: 123,
        cwd: '/workspace',
        isRunning: true,
        lastOutputAt: 111,
        lastExitCode: null,
        lastCommandCompletedAt: null,
        hasPendingCommand: true,
      },
    });

    setPtyManagerAPI({
      executeCommand,
      getOrSpawnAgentSession,
      resolveThreadSession: vi.fn().mockReturnValue('session-from-thread'),
      readOutput,
      listWithStatus: vi.fn().mockReturnValue([]),
      write: vi.fn().mockReturnValue(true),
    });

    const runtime = resolveTerminalRuntimeBridge();
    expect(runtime).not.toBeNull();
    expect(runtime?.getCapabilities?.()).toEqual(
      expect.arrayContaining([
        'execute',
        'session_read',
        'session_write',
        'session_list',
        'interactive',
      ]),
    );

    const executeResult = await executeInTerminalTool.execute({
      command: 'pwd',
      _space_id: 'space-1',
      _workspace_root: '/workspace',
      _thread_id: 'thread-1',
      _sandbox_policy: {
        route: 'regular',
        sandbox_level: 'filesystem',
        approval_required: false,
      },
    });

    expect(executeResult.success).toBe(true);
    expect(getOrSpawnAgentSession).toHaveBeenCalledWith('thread-1', 'space-1', {
      cwd: '/workspace',
    });
    const callArgs = executeCommand.mock.calls[0];
    expect(callArgs[0]).toBe('session-1');
    expect(callArgs[1]).toBe('pwd');
    const opts = callArgs[2];
    expect(opts.workingDirectory).toBeUndefined();
    expect(opts.env).toBeUndefined();
    expect(opts.killOnTimeout).toBe(true);
    expect(opts.context).toMatchObject({
      workingDirectory: undefined,
      workspaceRoot: '/workspace',
      threadId: 'thread-1',
      spaceId: 'space-1',
    });
    expect(opts.policy).toMatchObject({
      route: 'regular',
      sandboxLevel: 'filesystem',
      approvalRequired: false,
    });

    const readResult = await readTerminalOutputTool.execute({
      _thread_id: 'thread-1',
    });

    expect(readResult.success).toBe(true);
    expect(readOutput).toHaveBeenCalledWith('session-from-thread', { tail: 200 });
  });

  it('在 runtime 不支持 session read 时返回明确错误', async () => {
    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute: vi.fn().mockResolvedValue({
        output: '',
        exitCode: 0,
        cwd: '/tmp',
        backgrounded: false,
        timedOut: false,
        durationMs: 1,
      }),
    });

    const result = await readTerminalOutputTool.execute({ session_id: 'missing' });
    expect(result.success).toBe(false);
    expect(result.error?.message).toContain('does not support reading session output');
  });

  it('透传 snake_case sandbox policy 到共享 terminal request', async () => {
    const execute = vi.fn().mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 1,
      sessionId: 'runtime-session',
    });

    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute,
    });

    const result = await executeInTerminalTool.execute({
      command: 'echo hello',
      _sandbox_policy: {
        route: 'sandbox',
        sandbox_level: 'complete',
        network_mode: 'blocked',
        approval_required: true,
        deny_reason: 'blocked by policy',
        relaxed_rules: ['curl-mutating'],
      },
    });

    expect(result.success).toBe(true);
    const callPayload = execute.mock.calls[0][0];
    expect(callPayload.command).toBe('echo hello');
    expect(callPayload.killOnTimeout).toBe(true);
    expect(callPayload.context).toMatchObject({
      workingDirectory: undefined,
      workspaceRoot: undefined,
      threadId: undefined,
      spaceId: undefined,
    });
    expect(callPayload.policy).toMatchObject({
      route: 'sandbox',
      sandboxLevel: 'complete',
      networkMode: 'blocked',
      approvalRequired: true,
      denyReason: 'blocked by policy',
      relaxedRules: ['curl-mutating'],
    });
  });

  // ========== EF-19: context.env 透传 ==========

  it('adaptPtyManagerAPI 透传 context.env 到 executeCommand 调用', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cwd: '/workspace',
      backgrounded: false,
      timedOut: false,
      durationMs: 5,
      sessionId: 'env-session',
    });

    setPtyManagerAPI({
      executeCommand,
      spawnAgentSession: vi.fn().mockReturnValue('env-session'),
    });

    const runtime = resolveTerminalRuntimeBridge()!;
    expect(runtime).not.toBeNull();

    await runtime.execute!({
      command: 'printenv',
      context: {
        spaceId: 'sp-1',
        env: { NODE_ENV: 'test', MY_VAR: 'hello' },
      },
    });

    expect(executeCommand).toHaveBeenCalledWith(
      'env-session',
      'printenv',
      expect.objectContaining({
        env: { NODE_ENV: 'test', MY_VAR: 'hello' },
        context: expect.objectContaining({
          env: { NODE_ENV: 'test', MY_VAR: 'hello' },
        }),
      }),
    );
  });

  it('context.env 未提供时 env 为 undefined', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cwd: '/workspace',
      backgrounded: false,
      timedOut: false,
      durationMs: 5,
      sessionId: 'no-env-session',
    });

    setPtyManagerAPI({
      executeCommand,
      spawnAgentSession: vi.fn().mockReturnValue('no-env-session'),
    });

    const runtime = resolveTerminalRuntimeBridge()!;
    await runtime.execute!({ command: 'pwd', context: { spaceId: 'sp-1' } });

    expect(executeCommand).toHaveBeenCalledWith(
      'no-env-session',
      'pwd',
      expect.objectContaining({ env: undefined }),
    );
  });

  // ========== EF-20: schema required 声明 ==========

  it('read_terminal_output schema 不要求 session_id 为 required', () => {
    const required = readTerminalOutputTool.parameters.required;
    expect(required).not.toContain('session_id');
  });

  it('write_to_terminal schema 不要求 session_id 为 required 但保留 data', () => {
    const required = writeToTerminalTool.parameters.required;
    expect(required).not.toContain('session_id');
    expect(required).toContain('data');
  });

  it('read_terminal_output 在 _thread_id 回退下正常工作', async () => {
    const readOutput = vi.fn().mockReturnValue({
      output: 'thread fallback output',
      metadata: {
        pid: 999,
        cwd: '/home',
        isRunning: false,
        lastOutputAt: 222,
        lastExitCode: 0,
        lastCommandCompletedAt: 200,
        hasPendingCommand: false,
      },
    });

    setPtyManagerAPI({
      readOutput,
      resolveThreadSession: vi.fn().mockReturnValue('thread-resolved-session'),
      listWithStatus: vi.fn().mockReturnValue([]),
      write: vi.fn().mockReturnValue(true),
    });

    const result = await readTerminalOutputTool.execute({ _thread_id: 'tid-1' });
    expect(result.success).toBe(true);
    expect(readOutput).toHaveBeenCalledWith('thread-resolved-session', { tail: 200 });
  });

  it('write_to_terminal 在 _thread_id 回退下正常工作', async () => {
    setPtyManagerAPI({
      write: vi.fn().mockReturnValue(true),
      resolveThreadSession: vi.fn().mockReturnValue('thread-write-session'),
      listWithStatus: vi.fn().mockReturnValue([]),
    });

    const result = await writeToTerminalTool.execute({
      data: 'hello\\n',
      _thread_id: 'tid-2',
    });
    expect(result.success).toBe(true);
  });

  // ========== EF-21: PtyManagerAPI env 字段类型检查 ==========

  it('PtyManagerAPI.executeCommand options 接受 env 字段', async () => {
    const envData: Record<string, string> = { PATH: '/usr/bin', LANG: 'en_US.UTF-8' };
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'done',
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 3,
      sessionId: 'typed-session',
    });

    setPtyManagerAPI({
      executeCommand,
      spawnAgentSession: vi.fn().mockReturnValue('typed-session'),
    });

    const runtime = resolveTerminalRuntimeBridge()!;
    await runtime.execute!({
      command: 'env',
      context: { spaceId: 'sp-1', env: envData },
    });

    const callArgs = executeCommand.mock.calls[0];
    expect(callArgs[2].env).toEqual(envData);
  });

  // ========== HF2: killOnTimeout 端到端透传（legacy PtyManagerAPI 适配器路径） ==========

  it('adaptPtyManagerAPI 透传 killOnTimeout=false 到 executeCommand', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'running',
      exitCode: null,
      cwd: '/workspace',
      backgrounded: true,
      timedOut: true,
      durationMs: 30000,
      sessionId: 'kot-session',
    });

    setPtyManagerAPI({
      executeCommand,
      spawnAgentSession: vi.fn().mockReturnValue('kot-session'),
    });

    const runtime = resolveTerminalRuntimeBridge()!;
    expect(runtime).not.toBeNull();

    await runtime.execute!({
      command: 'npm run dev',
      killOnTimeout: false,
      context: { spaceId: 'sp-1' },
    });

    const callArgs = executeCommand.mock.calls[0];
    expect(callArgs[2].killOnTimeout).toBe(false);
  });

  it('adaptPtyManagerAPI 透传 killOnTimeout=true 到 executeCommand', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'done',
      exitCode: 0,
      cwd: '/workspace',
      backgrounded: false,
      timedOut: false,
      durationMs: 100,
      sessionId: 'kot-session-2',
    });

    setPtyManagerAPI({
      executeCommand,
      spawnAgentSession: vi.fn().mockReturnValue('kot-session-2'),
    });

    const runtime = resolveTerminalRuntimeBridge()!;
    await runtime.execute!({
      command: 'ls',
      killOnTimeout: true,
      context: { spaceId: 'sp-1' },
    });

    const callArgs = executeCommand.mock.calls[0];
    expect(callArgs[2].killOnTimeout).toBe(true);
  });

  it('adaptPtyManagerAPI 未指定 killOnTimeout 时透传 undefined（由下游默认）', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cwd: '/workspace',
      backgrounded: false,
      timedOut: false,
      durationMs: 10,
      sessionId: 'kot-session-3',
    });

    setPtyManagerAPI({
      executeCommand,
      spawnAgentSession: vi.fn().mockReturnValue('kot-session-3'),
    });

    const runtime = resolveTerminalRuntimeBridge()!;
    await runtime.execute!({
      command: 'pwd',
      context: { spaceId: 'sp-1' },
    });

    const callArgs = executeCommand.mock.calls[0];
    expect(callArgs[2].killOnTimeout).toBeUndefined();
  });

  it('kill_on_timeout=false 从 action-tools 经 legacy 适配器完整到达 PtyManagerAPI', async () => {
    const executeCommand = vi.fn().mockResolvedValue({
      output: 'background task',
      exitCode: null,
      cwd: '/workspace',
      backgrounded: true,
      timedOut: false,
      durationMs: 30000,
      sessionId: 'e2e-kot-session',
    });

    setPtyManagerAPI({
      executeCommand,
      getOrSpawnAgentSession: vi.fn().mockReturnValue('e2e-kot-session'),
    });

    const result = await executeInTerminalTool.execute({
      command: 'npm run dev',
      kill_on_timeout: false,
      block_until_ms: 0,
      _space_id: 'sp-e2e',
      _thread_id: 'thread-e2e',
    });

    expect(result.success).toBe(true);
    expect(executeCommand).toHaveBeenCalledTimes(1);
    const callArgs = executeCommand.mock.calls[0];
    expect(callArgs[2].killOnTimeout).toBe(false);
  });
});
