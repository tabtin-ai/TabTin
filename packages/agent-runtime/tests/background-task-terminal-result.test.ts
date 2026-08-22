/**
 * C1：后台命令终态 content 的结构化 `status` 字段契约（前端 TerminalCard 判定真相源）。
 *
 * 治 PRD §1.3 老硬伤——旧前端靠 string-match stderr 英文关键字（terminated/timed out）
 * 判定"已终止/已超时"，一本地化就回归。C1 让 content 带稳定结构化字段
 * `status`（completed/killed/failed）+ `killed_reason` + `exit_code`，前端据此判定。
 *
 * 本测试锁死字段名 + 取值枚举，供前端执行子 Agent 对齐（见完成报告 C1 字段契约）。
 */
import { describe, it, expect } from 'vitest';
import {
  deriveBackgroundTaskStatus,
  buildBackgroundTaskTerminalContent,
  buildBackgroundTaskTerminalResult,
  buildBackgroundTaskTerminalResultEvents,
  type BackgroundTaskTerminalInput,
} from '../src/terminal/background-task-terminal-result.js';

function baseInput(over: Partial<BackgroundTaskTerminalInput> = {}): BackgroundTaskTerminalInput {
  return {
    agent_session_id: 'agent-x',
    tool_use_id: 'run_terminal_command:0',
    command: 'pnpm dev',
    exit_code: 0,
    exited_by: 'normal_exit',
    duration_ms: 1234,
    output_file_path: '/tmp/x.log',
    cwd: '/repo',
    ...over,
  };
}

describe('deriveBackgroundTaskStatus（C1 结构化终态推导）', () => {
  it('正常退出（normal_exit）→ completed（exit_code 区分成功/失败）', () => {
    expect(deriveBackgroundTaskStatus({ exited_by: 'normal_exit' })).toBe('completed');
  });

  it('信号杀（exited_by=signal）→ killed', () => {
    expect(deriveBackgroundTaskStatus({ exited_by: 'signal' })).toBe('killed');
  });

  it('killed_reason 存在（kill_tool/hard_timeout/user_interrupt/app_exit）→ killed', () => {
    for (const reason of ['hard_timeout', 'kill_tool', 'user_interrupt', 'app_exit'] as const) {
      expect(deriveBackgroundTaskStatus({ exited_by: 'normal_exit', killed_reason: reason })).toBe('killed');
    }
  });

  it('exec_failure（command not found）→ failed', () => {
    expect(deriveBackgroundTaskStatus({ exited_by: 'exec_failure' })).toBe('failed');
  });

  it('显式传入 status → 直接采用（调用方持有 record 权威值）', () => {
    expect(deriveBackgroundTaskStatus({ exited_by: 'normal_exit', status: 'failed' })).toBe('failed');
    expect(deriveBackgroundTaskStatus({ exited_by: 'signal', status: 'completed' })).toBe('completed');
  });
});

describe('buildBackgroundTaskTerminalContent（C1 content 字段契约）', () => {
  it('正常退出 exit_code=0 → status=completed + exit_code=0（成功）', () => {
    const data = JSON.parse(buildBackgroundTaskTerminalContent(baseInput({ exit_code: 0 }), ''));
    expect(data.status).toBe('completed');
    expect(data.exit_code).toBe(0);
    expect(data._terminal_update).toBe(true);
  });

  it('非零退出 exit_code=1 → status=completed + exit_code=1（前端据 exit_code 判失败）', () => {
    const data = JSON.parse(buildBackgroundTaskTerminalContent(baseInput({ exit_code: 1 }), ''));
    expect(data.status).toBe('completed');
    expect(data.exit_code).toBe(1);
  });

  it('app_exit（退出客户端）→ status=killed + killed_reason=app_exit + exit_code=null', () => {
    const data = JSON.parse(buildBackgroundTaskTerminalContent(
      baseInput({ exit_code: null, exited_by: 'signal', killed_reason: 'app_exit' }),
      '',
    ));
    expect(data.status).toBe('killed');
    expect(data.killed_reason).toBe('app_exit');
    expect(data.exit_code).toBeNull();
    // 过渡期兼容：旧前端读 success/stderr。
    expect(data.success).toBe(false);
    expect(String(data.stderr)).toMatch(/terminated/);
  });

  it('hard_timeout → status=killed + killed_reason=hard_timeout（前端显示已超时）', () => {
    const data = JSON.parse(buildBackgroundTaskTerminalContent(
      baseInput({ exit_code: null, exited_by: 'signal', killed_reason: 'hard_timeout' }),
      '',
    ));
    expect(data.status).toBe('killed');
    expect(data.killed_reason).toBe('hard_timeout');
    expect(String(data.stderr)).toMatch(/timed out/);
  });

  it('exec_failure（exit 127）→ status=failed', () => {
    const data = JSON.parse(buildBackgroundTaskTerminalContent(
      baseInput({ exit_code: 127, exited_by: 'exec_failure' }),
      '',
    ));
    expect(data.status).toBe('failed');
    expect(data.exit_code).toBe(127);
  });
});

/**
 * ：终态 mini-message 的 tool_result block 补 `is_error`（移动端按
 * is_error 定工具卡成败，缺失会让失败的背景命令误显成功）。
 *
 * 语义（显式三态）：`status === 'killed' | 'failed'`，或 `status === 'completed'`
 * 且 `exit_code != null && exit_code !== 0` 时 block 带 `is_error: true`；
 * 正常 exit 0 不加该字段（保持现状兼容）。
 * `status === 'unknown'`（Layer 2 崩溃对账中性态，真实终态不可知）**不带**
 * is_error——否则移动端会把「运行状态未知」误显示成「失败」（移动端中性渲染
 * 在  跟踪，届时读 content.status）。
 */
describe('buildBackgroundTaskTerminalResult ·  is_error 契约', () => {
  function terminalToolResultBlock(input: BackgroundTaskTerminalInput): Record<string, unknown> {
    const events = buildBackgroundTaskTerminalResult({ threadId: 'thread-x', input });
    expect(events).not.toBeNull();
    const blockStart = events!.find((e) => e.type === 'agent.stream.content_block_start');
    expect(blockStart).toBeDefined();
    return (blockStart!.payload as { block: Record<string, unknown> }).block;
  }

  it('正常退出 exit_code=0 → block 不带 is_error（现状兼容）', () => {
    const block = terminalToolResultBlock(baseInput({ exit_code: 0 }));
    expect(block.type).toBe('tool_result');
    expect('is_error' in block).toBe(false);
  });

  it('正常退出但 exit_code=1 → is_error: true', () => {
    const block = terminalToolResultBlock(baseInput({ exit_code: 1 }));
    expect(block.is_error).toBe(true);
  });

  it('killed（hard_timeout，exit_code=null）→ is_error: true', () => {
    const block = terminalToolResultBlock(
      baseInput({ exit_code: null, exited_by: 'signal', killed_reason: 'hard_timeout' }),
    );
    expect(block.is_error).toBe(true);
  });

  it('killed（app_exit）→ is_error: true', () => {
    const block = terminalToolResultBlock(
      baseInput({ exit_code: null, exited_by: 'signal', killed_reason: 'app_exit' }),
    );
    expect(block.is_error).toBe(true);
  });

  it('failed（exec_failure，exit_code=127）→ is_error: true', () => {
    const block = terminalToolResultBlock(baseInput({ exit_code: 127, exited_by: 'exec_failure' }));
    expect(block.is_error).toBe(true);
  });

  it('显式 status=completed 但 exit_code≠0 → 仍 is_error: true（exit_code 优先）', () => {
    const block = terminalToolResultBlock(baseInput({ exit_code: 2, status: 'completed' }));
    expect(block.is_error).toBe(true);
  });

  it('unknown（Layer 2 崩溃对账中性态，真实终态不可知）→ 不带 is_error（不误显失败）', () => {
    // Layer 2 启动对账：sidecar 退出码缺失 → exit_code=null、exited_by 不可信，
    // 权威来源是显式 status='unknown'。此时若按反向判断（!== 'completed'）会误判
    // is_error=true，移动端把「运行状态未知」显示成「失败」。
    const block = terminalToolResultBlock(
      baseInput({ exit_code: null, exited_by: 'signal', status: 'unknown' }),
    );
    expect('is_error' in block).toBe(false);
  });
});

describe('buildBackgroundTaskTerminalResultEvents · isError 参数透传', () => {
  function blockOf(isError?: boolean): Record<string, unknown> {
    const events = buildBackgroundTaskTerminalResultEvents({
      threadId: 'thread-x',
      toolUseId: 'toolu_x',
      contentJson: '{}',
      ...(isError === undefined ? {} : { isError }),
    });
    const blockStart = events.find((e) => e.type === 'agent.stream.content_block_start');
    return (blockStart!.payload as { block: Record<string, unknown> }).block;
  }

  it('isError=true → block.is_error=true', () => {
    expect(blockOf(true).is_error).toBe(true);
  });

  it('isError=false / 缺省 → block 不带 is_error 字段', () => {
    expect('is_error' in blockOf(false)).toBe(false);
    expect('is_error' in blockOf()).toBe(false);
  });
});
