import { afterEach, describe, expect, it, vi } from 'vitest';
import type { TerminalRuntimeBridge } from '@tabtin/terminal-core';
import {
  setTerminalRuntimeBridge,
  setPtyManagerAPI,
} from '../../utils/runtime-bridge';
import {
  executeInTerminalTool,
  truncateOutputForAgent,
} from '../terminal';

// ========== truncateOutputForAgent 单元测试 ==========

describe('truncateOutputForAgent', () => {
  it('短输出不截断', () => {
    const result = truncateOutputForAgent('hello world');
    expect(result.truncated).toBe(false);
    expect(result.output).toBe('hello world');
    expect(result.originalLength).toBe(11);
  });

  it('恰好等于阈值不截断', () => {
    const input = 'x'.repeat(51_200);
    const result = truncateOutputForAgent(input, 51_200, 10_240);
    expect(result.truncated).toBe(false);
    expect(result.output).toBe(input);
  });

  it('超过阈值时截断并保留首尾', () => {
    const head = 'H'.repeat(30_000);
    const middle = 'M'.repeat(40_000);
    const tail = 'T'.repeat(30_000);
    const input = head + middle + tail; // 100_000 chars

    const result = truncateOutputForAgent(input, 51_200, 10_240);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(100_000);

    expect(result.output).toContain('... [truncated:');
    expect(result.output).toContain('chars removed');

    // 头部应以 'H' 开头
    expect(result.output[0]).toBe('H');
    // 尾部应以 'T' 结尾
    expect(result.output[result.output.length - 1]).toBe('T');

    // 截断后长度应接近 maxChars
    expect(result.output.length).toBeLessThanOrEqual(51_200 + 200);
  });

  it('空字符串不截断', () => {
    const result = truncateOutputForAgent('');
    expect(result.truncated).toBe(false);
    expect(result.output).toBe('');
    expect(result.originalLength).toBe(0);
  });

  it('自定义参数生效', () => {
    const input = 'x'.repeat(200);
    const result = truncateOutputForAgent(input, 100, 30);
    expect(result.truncated).toBe(true);
    expect(result.originalLength).toBe(200);
    expect(result.output.length).toBeLessThan(200);
  });

  it('tailChars 接近 maxChars 时仍有效（headChars <= 0 分支）', () => {
    const input = 'x'.repeat(500);
    const result = truncateOutputForAgent(input, 100, 200);
    expect(result.truncated).toBe(true);
    expect(result.output).toContain('... [truncated:');
    // 当 headChars <= 0 时，输出以 marker 开头
    expect(result.output.startsWith('\n\n...')).toBe(true);
  });
});

// ========== execute_in_terminal kill_on_timeout 参数测试 ==========

describe('execute_in_terminal kill_on_timeout', () => {
  afterEach(() => {
    setTerminalRuntimeBridge(null);
    setPtyManagerAPI(null);
    vi.restoreAllMocks();
  });

  it('schema 中包含 kill_on_timeout 参数', () => {
    const props = executeInTerminalTool.parameters.properties;
    expect(props).toHaveProperty('kill_on_timeout');
    expect((props as any).kill_on_timeout.type).toBe('boolean');
  });

  it('kill_on_timeout 默认为 true，透传到 execute request', async () => {
    const execute = vi.fn().mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 5,
      sessionId: 'sess-1',
    });

    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute,
    });

    await executeInTerminalTool.execute({ command: 'echo hello' });

    expect(execute).toHaveBeenCalledTimes(1);
    const request = execute.mock.calls[0][0];
    expect(request.killOnTimeout).toBe(true);
  });

  it('kill_on_timeout=false 透传到 execute request', async () => {
    const execute = vi.fn().mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 5,
      sessionId: 'sess-2',
    });

    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute,
    });

    await executeInTerminalTool.execute({
      command: 'long-running-task',
      kill_on_timeout: false,
    });

    const request = execute.mock.calls[0][0];
    expect(request.killOnTimeout).toBe(false);
  });

  it('kill_on_timeout=true 显式设置', async () => {
    const execute = vi.fn().mockResolvedValue({
      output: 'ok',
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 5,
      sessionId: 'sess-3',
    });

    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute,
    });

    await executeInTerminalTool.execute({
      command: 'echo test',
      kill_on_timeout: true,
    });

    const request = execute.mock.calls[0][0];
    expect(request.killOnTimeout).toBe(true);
  });
});

// ========== execute_in_terminal 输出截断集成测试 ==========

describe('execute_in_terminal output truncation', () => {
  afterEach(() => {
    setTerminalRuntimeBridge(null);
    setPtyManagerAPI(null);
    vi.restoreAllMocks();
  });

  it('短输出不截断，无 output_truncated 字段', async () => {
    const execute = vi.fn().mockResolvedValue({
      output: 'short output',
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 5,
      sessionId: 'trunc-1',
    });

    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute,
    });

    const result = await executeInTerminalTool.execute({ command: 'echo hi' });
    expect(result.success).toBe(true);
    expect(result.data?.output).toBe('short output');
    expect(result.data?.output_truncated).toBeUndefined();
    expect(result.data?.output_original_length).toBeUndefined();
  });

  it('巨量输出被截断，附加 output_truncated 元数据', async () => {
    const bigOutput = 'x'.repeat(100_000);
    const execute = vi.fn().mockResolvedValue({
      output: bigOutput,
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 500,
      sessionId: 'trunc-2',
    });

    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute,
    });

    const result = await executeInTerminalTool.execute({ command: 'find /' });
    expect(result.success).toBe(true);
    expect(result.data?.output_truncated).toBe(true);
    expect(result.data?.output_original_length).toBe(100_000);
    expect(result.data?.output.length).toBeLessThan(100_000);
    expect(result.data?.output).toContain('... [truncated:');
  });

  it('output 为 undefined 时安全处理', async () => {
    const execute = vi.fn().mockResolvedValue({
      output: undefined,
      exitCode: 0,
      cwd: '/tmp',
      backgrounded: false,
      timedOut: false,
      durationMs: 1,
      sessionId: 'trunc-3',
    });

    setTerminalRuntimeBridge({
      getCapabilities: () => ['execute'],
      execute,
    });

    const result = await executeInTerminalTool.execute({ command: 'true' });
    expect(result.success).toBe(true);
    expect(result.data?.output).toBe('');
    expect(result.data?.output_truncated).toBeUndefined();
  });
});
