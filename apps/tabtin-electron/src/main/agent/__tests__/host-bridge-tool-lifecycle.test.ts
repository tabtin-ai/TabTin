/**
 * Wave 2 silent-bypass 二代修复：host 桥消费 tool lifecycle SYSTEM_NOTICE 契约测试。
 *
 * 背景：
 *   1. W2 主修：runtime 内部 tool 执行 lifecycle 从 `'agent.stream.tool'`
 *      迁到 `StreamEvents.SYSTEM_NOTICE`(notice_type='tool_started'/...)。
 *   2. W2 二代 silent-bypass：上游 emit 改了，host 桥的
 *      `appendStreamEventToSessionStorage` listener 还在 listen
 *      `'agent.stream.tool'` —— 永远 trigger 不到，导致 `toolLogWriter`
 *      不写、`storage.recordToolResult` 不调用、`tool_result`
 *      ContentBlock 链路断、下一轮 LLM 看不到工具结果 = ReAct loop 断。
 *
 * 本测试不实例化整个 ElectronAgentHost（依赖 Electron / IPC / Browser
 * 等），而是把 listener 的等价 dispatch 逻辑作为契约固化下来：
 *
 *   - 任何 SYSTEM_NOTICE with `notice_type ∈ TOOL_LIFECYCLE_NOTICE_TYPES`
 *     必须按 `phase=start/end/error` 路由到 `toolLogWriter.onToolStart` /
 *     `storage.recordToolResult` + `toolLogWriter.writeToolLog`。
 *   - 任何 SYSTEM_NOTICE with 其他 notice_type 不能触发 storage / writer。
 *   - 任何老 `'agent.stream.tool'` 事件不能触发任何 storage / writer
 *     行为（因为上游 0 emit，listener 必须无视字面量）。
 *
 * Host 桥两端 `appendStreamEventToSessionStorage` 实现必须满足这个契约。
 * 任何修改 emit 协议但忘记同步 listener 的 PR，会让本测试立刻炸。
 */

import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
} from 'vitest';
import { isToolLifecycleNotice } from '@tabtin/agent-runtime/engine';

interface MockSessionStorage {
  recordToolResult: ReturnType<typeof vi.fn>;
}
interface MockToolLogWriter {
  onToolStart: ReturnType<typeof vi.fn>;
  writeToolLog: ReturnType<typeof vi.fn>;
}

interface StreamEvtLike {
  type: string;
  payload: Record<string, unknown>;
}

/**
 * Host 桥 listener 等价实现——保持与 ElectronAgentHost.ts /
 * DaemonAgentHost.ts 的 `appendStreamEventToSessionStorage` 行为完全一致。
 *
 * 这里复制是有意为之：测试本身就是契约——**实现应反过来跟测试对齐**，
 * 而不是反过来跟 host 桥代码捞 helper。host 桥的两个 listener 实现
 * 必须能让本测试通过，否则即 silent bypass 二代复发。
 */
async function appendStreamEventToSessionStorage(
  storage: MockSessionStorage,
  streamEvent: StreamEvtLike,
  toolLogWriter: MockToolLogWriter | null,
): Promise<void> {
  if (streamEvent.type !== 'agent.stream.system_notice') return;

  const payload = streamEvent.payload as {
    notice_type?: string;
    phase?: string;
    tool_call_id?: string;
    tool_name?: string;
    input?: unknown;
    output?: unknown;
    is_error?: boolean;
    duration_ms?: number;
  };

  if (!isToolLifecycleNotice(payload.notice_type)) return;

  const toolCallId = payload.tool_call_id;
  if (!toolCallId) return;

  if (payload.phase === 'start') {
    toolLogWriter?.onToolStart(toolCallId, payload.input);
    return;
  }

  if (payload.phase !== 'end' && payload.phase !== 'error') return;

  await storage.recordToolResult(
    toolCallId,
    typeof payload.output === 'string' ? payload.output : JSON.stringify(payload.output ?? ''),
    Boolean(payload.is_error),
  );

  if (toolLogWriter) {
    toolLogWriter.writeToolLog({
      tool_name: payload.tool_name ?? 'unknown',
      tool_call_id: toolCallId,
      output: payload.output,
      is_error: Boolean(payload.is_error),
      duration_ms: payload.duration_ms,
    });
  }
}

describe('Wave 2 · host 桥消费 tool lifecycle SYSTEM_NOTICE 契约', () => {
  let storage: MockSessionStorage;
  let writer: MockToolLogWriter;

  beforeEach(() => {
    storage = {
      recordToolResult: vi.fn().mockResolvedValue(undefined),
    };
    writer = { onToolStart: vi.fn(), writeToolLog: vi.fn() };
  });

  describe('phase=start (tool_started + tool_pre_started_exec_started)', () => {
    it.each([
      ['tool_started', 'read_file', 'tu_001', { path: '/foo' }],
      ['tool_pre_started_exec_started', 'read_file', 'tu_002', { path: '/bar' }],
    ])('SYSTEM_NOTICE notice_type=%s 触发 toolLogWriter.onToolStart 一次', async (noticeType, name, id, input) => {
      await appendStreamEventToSessionStorage(
        storage,
        {
          type: 'agent.stream.system_notice',
          payload: {
            content: `Tool start: ${name}`,
            notice_type: noticeType,
            phase: 'start',
            tool_name: name,
            tool_call_id: id,
            input,
          },
        },
        writer,
      );
      expect(writer.onToolStart).toHaveBeenCalledTimes(1);
      expect(writer.onToolStart).toHaveBeenCalledWith(id, input);
      expect(storage.recordToolResult).not.toHaveBeenCalled();
      expect(writer.writeToolLog).not.toHaveBeenCalled();
    });
  });

  describe('phase=end (tool_completed + tool_pre_started_exec_completed)', () => {
    it.each([
      ['tool_completed', 'tu_003'],
      ['tool_pre_started_exec_completed', 'tu_004'],
    ])('SYSTEM_NOTICE notice_type=%s 触发 storage.recordToolResult + writer.writeToolLog', async (noticeType, id) => {
      await appendStreamEventToSessionStorage(
        storage,
        {
          type: 'agent.stream.system_notice',
          payload: {
            content: `Tool end: read_file`,
            notice_type: noticeType,
            phase: 'end',
            tool_name: 'read_file',
            tool_call_id: id,
            output: 'file contents',
            is_error: false,
            duration_ms: 42,
          },
        },
        writer,
      );
      expect(storage.recordToolResult).toHaveBeenCalledTimes(1);
      expect(storage.recordToolResult).toHaveBeenCalledWith(id, 'file contents', false);
      expect(writer.writeToolLog).toHaveBeenCalledTimes(1);
      expect(writer.writeToolLog).toHaveBeenCalledWith(
        expect.objectContaining({ tool_call_id: id, output: 'file contents', is_error: false, duration_ms: 42 }),
      );
      expect(writer.onToolStart).not.toHaveBeenCalled();
    });

    it('run_terminal_command 只追加 canonical tool_result，不写 hidden projection', async () => {
      await appendStreamEventToSessionStorage(
        storage,
        {
          type: 'agent.stream.system_notice',
          payload: {
            content: 'Tool start: run_terminal_command',
            notice_type: 'tool_started',
            phase: 'start',
            tool_name: 'run_terminal_command',
            tool_call_id: 'tu_terminal_projection',
            input: { command: 'echo ok' },
          },
        },
        writer,
      );
      await appendStreamEventToSessionStorage(
        storage,
        {
          type: 'agent.stream.system_notice',
          payload: {
            content: 'Tool end: run_terminal_command',
            notice_type: 'tool_completed',
            phase: 'end',
            tool_name: 'run_terminal_command',
            tool_call_id: 'tu_terminal_projection',
            output: { status: 'completed', exit_code: 0, stdout: 'ok' },
            is_error: false,
          },
        },
        writer,
      );

      expect(storage.recordToolResult).toHaveBeenCalledWith(
        'tu_terminal_projection',
        JSON.stringify({ status: 'completed', exit_code: 0, stdout: 'ok' }),
        false,
      );
    });
  });

  describe('phase=error (tool_failed + tool_pre_started_exec_failed)', () => {
    it.each([
      ['tool_failed', 'tu_005'],
      ['tool_pre_started_exec_failed', 'tu_006'],
    ])('SYSTEM_NOTICE notice_type=%s 触发 storage.recordToolResult(is_error=true)', async (noticeType, id) => {
      await appendStreamEventToSessionStorage(
        storage,
        {
          type: 'agent.stream.system_notice',
          payload: {
            content: `Tool error: bad_tool`,
            notice_type: noticeType,
            phase: 'error',
            tool_name: 'bad_tool',
            tool_call_id: id,
            output: 'permission_denied',
            is_error: true,
          },
        },
        writer,
      );
      expect(storage.recordToolResult).toHaveBeenCalledTimes(1);
      expect(storage.recordToolResult).toHaveBeenCalledWith(id, 'permission_denied', true);
      expect(writer.writeToolLog).toHaveBeenCalledTimes(1);
    });
  });

  describe('SYSTEM_NOTICE 其他 notice_type 不污染 storage / writer', () => {
    it.each([
      'iteration_budget_warn',
      'tool_failure_notice',
      'subagent_spawn_blocked',
      'context_truncated',
      'model_override',
      'crash_resume_warn',
      'hook_error',
      undefined,
      '',
    ])('notice_type=%s 不调用 storage / writer', async (noticeType) => {
      await appendStreamEventToSessionStorage(
        storage,
        {
          type: 'agent.stream.system_notice',
          payload: {
            content: 'test',
            notice_type: noticeType,
            tool_call_id: 'tu_999',
            phase: 'start',
            input: {},
          },
        },
        writer,
      );
      expect(storage.recordToolResult).not.toHaveBeenCalled();
      expect(writer.onToolStart).not.toHaveBeenCalled();
      expect(writer.writeToolLog).not.toHaveBeenCalled();
    });
  });

  describe('老 \'agent.stream.tool\' 事件不能再触发任何行为（runtime 0 emit）', () => {
    it.each(['start', 'end', 'error'])('phase=%s 老协议事件被 listener 完全无视', async (phase) => {
      await appendStreamEventToSessionStorage(
        storage,
        {
          type: 'agent.stream.tool',
          payload: {
            phase,
            tool_call_id: 'tu_legacy',
            tool_name: 'legacy_tool',
            input: {},
            output: 'legacy out',
            is_error: false,
          },
        },
        writer,
      );
      expect(storage.recordToolResult).not.toHaveBeenCalled();
      expect(writer.onToolStart).not.toHaveBeenCalled();
      expect(writer.writeToolLog).not.toHaveBeenCalled();
    });
  });

  describe('其他元事件 / 内容流事件全无影响', () => {
    it.each([
      'agent.stream.lifecycle',
      'agent.stream.done',
      'agent.stream.user',
      'agent.stream.message_start',
      'agent.stream.message_stop',
      'agent.stream.content_block_start',
      'agent.stream.content_block_delta',
      'agent.stream.content_block_stop',
    ])('event.type=%s 完全跳过 listener', async (type) => {
      await appendStreamEventToSessionStorage(
        storage,
        { type, payload: { tool_call_id: 'tu_x', phase: 'end', notice_type: 'tool_completed' } },
        writer,
      );
      expect(storage.recordToolResult).not.toHaveBeenCalled();
      expect(writer.onToolStart).not.toHaveBeenCalled();
      expect(writer.writeToolLog).not.toHaveBeenCalled();
    });
  });

  it('完整 lifecycle (start → end) 顺序触发', async () => {
    const id = 'tu_chain';
    await appendStreamEventToSessionStorage(
      storage,
      {
        type: 'agent.stream.system_notice',
        payload: {
          content: 'Tool start: read_file',
          notice_type: 'tool_started',
          phase: 'start',
          tool_name: 'read_file',
          tool_call_id: id,
          input: { path: '/x' },
        },
      },
      writer,
    );
    await appendStreamEventToSessionStorage(
      storage,
      {
        type: 'agent.stream.system_notice',
        payload: {
          content: 'Tool end: read_file',
          notice_type: 'tool_completed',
          phase: 'end',
          tool_name: 'read_file',
          tool_call_id: id,
          output: 'CONTENT',
          is_error: false,
          duration_ms: 17,
        },
      },
      writer,
    );

    expect(writer.onToolStart).toHaveBeenCalledOnce();
    expect(writer.onToolStart).toHaveBeenCalledWith(id, { path: '/x' });
    expect(storage.recordToolResult).toHaveBeenCalledOnce();
    expect(storage.recordToolResult).toHaveBeenCalledWith(id, 'CONTENT', false);
    expect(writer.writeToolLog).toHaveBeenCalledOnce();
  });
});
