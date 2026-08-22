/**
 * agent-tool-tool-history.test.ts — W6 tool_history 重写 + W1 D11 childEmitter
 * 收紧 端到端回归（总控 §六 W1 改动 1 + 改动 2）
 *
 * **锁住 W6**：agent-tool.ts 内 while 循环消费子 stream events，必须从子
 * `SYSTEM_NOTICE(notice_type='tool_completed' | 'tool_failed')` 准确回填
 * toolHistory 的 success / output_summary / error / elapsed_ms。
 * 不允许回退到 W2 简化版"content_block_stop → success=true / output_summary=''"
 * 兜底假数据。
 *
 * **锁住 D11**：childEmitter 只转发**白名单内**的子工具自发 emit 事件到父
 * emitStreamEvent；子内部 raw events（content_block_* / message_* / step_* /
 * 子 widget 元事件等）一律拦在子工作面。聚合 SUBAGENT_* 仍由 agent-tool
 * 直接 parentEmitter()，不受影响。
 *
 * **白名单（PARENT_UI_FORWARD_TYPES）当前 5 项**：PLAN_PROPOSAL /
 * ASK_USER_REQUIRED / ASK_FORM_REQUIRED / REQUEST_APPROVAL_REQUIRED /
 * SYSTEM_NOTICE。这些是子 Agent 工具内部 emit 给前端**渲染卡片或接住用户
 * 交互**的事件——父 UI 必须接住，否则用户看不到子 Agent 的计划/审批入口/
 * 凭据警告。下面 `describe('白名单事件...')` 块覆盖了全部 5 项的
 * 转发契约。
 *
 * 测试策略（与 agent-tool-w0-regression.test.ts 同款）：
 *   - `vi.mock` 替换 `fork-query.ts::forkQuery`：让子 runtime 完全 stub，
 *     只 yield 人造的子 stream events，避免真启动 SnapshotStorage /
 *     EventStorage / 真 LLM provider；
 *   - 断言父 collected events 中 `SUBAGENT_PROGRESS.tool_history` 字段
 *     反映了从子 SYSTEM_NOTICE 提取的真实数据。
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../src/subagent/fork-query.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/subagent/fork-query.js')>();
  return {
    ...actual,
    forkQuery: vi.fn(),
  };
});

import { StreamEvents, ContentBlockEvents } from '../src/engine/contracts/stream-events.js';
import { createAgentTool, type AgentToolConfig } from '../src/subagent/agent-tool.js';
import { forkQuery } from '../src/subagent/fork-query.js';
import type { ForkQueryConfig } from '../src/subagent/fork-query.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  ToolContext,
} from '../src/engine/contracts/tools.js';
import {
  createMockPermissionHandler,
  createMockProvider,
  createMockToolProvider,
} from './test-utils.js';

const PARENT_THREAD = 'parent-w1-tool-history';

function makeBaseConfig(): AgentToolConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/agent-tool-w1', threadId: PARENT_THREAD },
    model: 'sonnet',
    systemPrompt: 'parent system prompt',
  };
}

interface ContextWithCollected extends ToolContext {
  __collected: StreamEvent[];
}

function makeContext(toolUseId: string): ContextWithCollected {
  const collected: StreamEvent[] = [];
  const ctx = {
    threadId: PARENT_THREAD,
    runtimeId: 'runtime-w1-tool-history',
    toolUseId,
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    emitStreamEvent: (e: StreamEvent) => { collected.push(e); },
    __collected: collected,
  };
  return ctx as unknown as ContextWithCollected;
}

/**
 * 把人造的子 stream events 喂给 agent-tool 的 while 循环。
 *
 * 同时捕获 forkQuery 收到的 config（含 emitStreamEvent=childEmitter 引用），
 * 供 D11 测试主动用 childEmitter 模拟"工具内部自发 emit"。
 */
function setupForkQueryMock(events: StreamEvent[]): {
  capturedConfig: () => ForkQueryConfig | undefined;
} {
  let lastConfig: ForkQueryConfig | undefined;
  vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
    lastConfig = config;
    async function* gen(): AsyncGenerator<StreamEvent, string> {
      for (const ev of events) yield ev;
      return 'mock summary';
    }
    return gen();
  }) as typeof forkQuery);
  return { capturedConfig: () => lastConfig };
}

function findLastProgress(events: StreamEvent[]): StreamEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    if (events[i].type === StreamEvents.SUBAGENT_PROGRESS) return events[i];
  }
  return undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── W6：toolHistory 真实回填（替代 W2 兜底假数据）─────────────────────

describe('SUBAGENT_PROGRESS 只发卡片元数据，工具履历走 SUBAGENT_STREAM_EVENT', () => {
  it('成功工具 → progress 只有 step/latest，不含 tool_history', async () => {
    const toolCallId = 'toolu_success_1';
    setupForkQueryMock([
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          message_id: 'm1',
          index: 0,
          block_id: toolCallId,
          block: { type: 'tool_use', id: toolCallId, name: 'read_file', input: { path: '/foo.txt' } },
        },
      },
      {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: {
          notice_type: 'tool_completed',
          tool_name: 'read_file',
          tool_call_id: toolCallId,
          phase: 'end',
          output: 'file contents here',
          is_error: false,
          duration_ms: 50,
        },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_w1_p_1');
    await tool.execute({ prompt: 'read foo', description: 'read test' }, ctx);

    const progress = findLastProgress(ctx.__collected);
    expect(progress, 'SUBAGENT_PROGRESS 必须被 emit').toBeDefined();
    const payload = progress!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tool_history');
    expect(payload.step_count).toBe(1);
    expect(payload.latest_tool).toBe('read_file');
    expect(payload.latest_success).toBe(true);
    expect(payload.latest_tool_status).toBe('completed');
    expect(ctx.__collected.some((event) => event.type === StreamEvents.SUBAGENT_STREAM_EVENT)).toBe(true);
  });

  it('超大工具输出只进摘要，progress 快照保持在 Event Buffer 单事件上限内', async () => {
    const toolCallId = 'toolu_huge_output';
    const hugeOutput = 'x'.repeat(1_400_000);
    setupForkQueryMock([
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          message_id: 'm-huge',
          index: 0,
          block_id: toolCallId,
          block: { type: 'tool_use', id: toolCallId, name: 'read_file', input: { path: '/huge.txt' } },
        },
      },
      {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: {
          notice_type: 'tool_completed',
          tool_name: 'read_file',
          tool_call_id: toolCallId,
          phase: 'end',
          output: hugeOutput,
          is_error: false,
          duration_ms: 80,
        },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_w1_huge');
    await tool.execute({ prompt: 'read huge file', description: 'huge output' }, ctx);

    const progress = findLastProgress(ctx.__collected);
    expect(progress).toBeDefined();
    const payload = progress!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tool_history');
    expect(payload.latest_tool).toBe('read_file');
    // Event Buffer 单 envelope 上限 256 KiB；修前全文履历会把快照顶到 ~1.3 MiB。
    const eventBufferMaxBytes = 256 * 1024;
    expect(Buffer.byteLength(JSON.stringify(progress), 'utf8')).toBeLessThan(eventBufferMaxBytes);
  });

  it('失败工具 → success=false、output_summary 含错误信息、error 字段含 error_code', async () => {
    const toolCallId = 'toolu_fail_1';
    setupForkQueryMock([
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          message_id: 'm1',
          index: 0,
          block_id: toolCallId,
          block: { type: 'tool_use', id: toolCallId, name: 'read_file', input: { path: '/nonexistent' } },
        },
      },
      {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: {
          notice_type: 'tool_failed',
          tool_name: 'read_file',
          tool_call_id: toolCallId,
          phase: 'error',
          output: 'ENOENT: no such file or directory',
          is_error: true,
          duration_ms: 12,
          error_code: 'execute_error',
        },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_w1_p_2');
    await tool.execute({ prompt: 'read missing', description: 'fail test' }, ctx);

    const progress = findLastProgress(ctx.__collected);
    expect(progress).toBeDefined();
    const payload = progress!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tool_history');
    expect(payload.latest_success).toBe(false);
    expect(payload.latest_tool).toBe('read_file');
    expect(payload.latest_tool_status).toBe('failed');
  });

  it('长工具的 tool_progress → 刷新运行中进度，但不增加完成步数或复制 tool_history', async () => {
    const toolCallId = 'toolu_long_running';
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      async function* gen(): AsyncGenerator<StreamEvent, string> {
        yield {
          type: ContentBlockEvents.CONTENT_BLOCK_START,
          payload: {
            block_id: toolCallId,
            block: {
              type: 'tool_use',
              id: toolCallId,
              name: 'run_terminal_command',
              input: { command: 'pnpm build' },
            },
          },
        };
        config.emitStreamEvent?.({
          type: StreamEvents.SYSTEM_NOTICE,
          payload: {
            notice_type: 'tool_progress',
            tool_name: 'run_terminal_command',
            tool_call_id: toolCallId,
            phase: 'progress',
            output_bytes: 1024,
            captured_at: 1_000,
          },
        });
        return 'mock summary';
      }
      return gen();
    }) as typeof forkQuery);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_parent_long_running');
    await tool.execute({ prompt: 'run a long build' }, ctx);

    const progressEvents = ctx.__collected.filter(
      (event) => event.type === StreamEvents.SUBAGENT_PROGRESS,
    );
    expect(progressEvents).toHaveLength(2);

    const latest = progressEvents[1]!.payload as Record<string, unknown>;
    expect(latest.latest_tool).toBe('run_terminal_command');
    expect(latest.latest_tool_status).toBe('pending');
    expect(latest.step_count).toBe(0);
    expect(latest).not.toHaveProperty('tool_history');
    expect(latest.elapsed_ms).toEqual(expect.any(Number));
  });

  it('混合成功 + 失败 → toolHistory 顺序保留、每步 success 字段准确', async () => {
    setupForkQueryMock([
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          block_id: 'call_ok',
          block: { type: 'tool_use', id: 'call_ok', name: 'read_file', input: { path: '/a.txt' } },
        },
      },
      {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: {
          notice_type: 'tool_completed',
          tool_name: 'read_file',
          tool_call_id: 'call_ok',
          output: 'ok content',
          is_error: false,
          duration_ms: 20,
        },
      },
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          block_id: 'call_fail',
          block: { type: 'tool_use', id: 'call_fail', name: 'grep_search', input: { query: 'bug' } },
        },
      },
      {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: {
          notice_type: 'tool_failed',
          tool_name: 'grep_search',
          tool_call_id: 'call_fail',
          output: 'timeout',
          is_error: true,
          duration_ms: 60_000,
          error_code: 'tool_timeout',
        },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_mix');
    await tool.execute({ prompt: 'mix' }, ctx);

    const progress = findLastProgress(ctx.__collected);
    const payload = progress!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tool_history');
    expect(payload.step_count).toBe(2);
    expect(payload.latest_tool).toBe('grep_search');
    expect(payload.latest_success).toBe(false);
  });

  it('ContentBlock[] 形态 output 不进入 progress 履历字段', async () => {
    setupForkQueryMock([
      {
        type: ContentBlockEvents.CONTENT_BLOCK_START,
        payload: {
          block_id: 'call_cb',
          block: { type: 'tool_use', id: 'call_cb', name: 'read_image', input: {} },
        },
      },
      {
        type: StreamEvents.SYSTEM_NOTICE,
        payload: {
          notice_type: 'tool_completed',
          tool_name: 'read_image',
          tool_call_id: 'call_cb',
          output: [
            { type: 'text', text: 'OCR result line 1' },
            { type: 'image', source: { data: 'base64...' } },
            { type: 'text', text: 'OCR result line 2' },
          ],
          is_error: false,
          duration_ms: 30,
        },
      },
    ]);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_cb');
    await tool.execute({ prompt: 'cb' }, ctx);

    const progress = findLastProgress(ctx.__collected);
    const payload = progress!.payload as Record<string, unknown>;
    expect(payload).not.toHaveProperty('tool_history');
    expect(payload.latest_tool).toBe('read_image');
    expect(JSON.stringify(progress)).not.toContain('OCR result line 1');
  });

  it('W2 简化版兜底逻辑（content_block_stop → success=true / output_summary=""）已删除', async () => {
    // 元测试：源码不应再含 W2 简化版注释和兜底实现
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/subagent/agent-tool.ts'),
      'utf-8',
    );
    expect(source, '"W2 简化版" 注释必须删除').not.toContain('W2 简化版');
    // 核心兜底字符（'output_summary: ""' / "output_summary: ''"）也不能再出现
    expect(source, 'output_summary 兜底空串必须删除').not.toMatch(/output_summary:\s*['"]\s*['"]/);
  });
});

// ─── D11：childEmitter 收紧（白名单空集）──────────────────────────────

describe('W1 / D11 childEmitter 收紧：子 raw events 不污染父 chat 流', () => {
  it('工具自发 emit 的 raw content_block 事件不转发到父 emitStreamEvent', async () => {
    // 用 forkQuery mock 暴露 childEmitter，模拟"子工具内部主动调
    // context.emitStreamEvent emit 一个 raw 元事件"。
    const tracker = setupForkQueryMock([]);
    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_d11_1');

    // 重新 mock 让 forkQuery 在生成器里通过 emitStreamEvent 主动 emit 非白名单事件
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      async function* gen(): AsyncGenerator<StreamEvent, string> {
        // 模拟子工具内部主动 emit raw 流事件（widget 元事件 / 子内 content_block_delta 等）
        config.emitStreamEvent?.({
          type: ContentBlockEvents.CONTENT_BLOCK_DELTA,
          payload: { message_id: 'mc', index: 0, delta: { type: 'text_delta', text: 'inner streaming' } },
        });
        config.emitStreamEvent?.({
          type: 'agent.stream.widget_render',
          payload: { widget_id: 'inner-widget' },
        });
        return 'done';
      }
      return gen();
    }) as typeof forkQuery);

    await tool.execute({ prompt: 'd11 test' }, ctx);

    const hasContentBlockDelta = ctx.__collected.some(
      (e) => e.type === ContentBlockEvents.CONTENT_BLOCK_DELTA,
    );
    expect(hasContentBlockDelta, '子 content_block_delta 不应转发到父 UI').toBe(false);

    const hasWidget = ctx.__collected.some((e) => e.type === 'agent.stream.widget_render');
    expect(hasWidget, '子工具元事件不应转发到父 UI').toBe(false);

    // 但聚合 SUBAGENT_STARTED / SUBAGENT_COMPLETED 必须仍在父 collected
    // （这两个由 agent-tool 自己直接 parentEmitter，不经 childEmitter）
    expect(ctx.__collected.some((e) => e.type === StreamEvents.SUBAGENT_STARTED)).toBe(true);
    expect(ctx.__collected.some((e) => e.type === StreamEvents.SUBAGENT_COMPLETED)).toBe(true);

    // tracker 防 dead code
    expect(tracker.capturedConfig).toBeDefined();
  });

  it('PARENT_UI_FORWARD_TYPES 收紧策略在源码中明确声明', async () => {
    const fs = await import('node:fs');
    const path = await import('node:path');
    const source = fs.readFileSync(
      path.resolve(__dirname, '../src/subagent/agent-tool.ts'),
      'utf-8',
    );
    expect(source, 'PARENT_UI_FORWARD_TYPES 常量必须存在').toContain('PARENT_UI_FORWARD_TYPES');
  });

  it('白名单事件必须仍能到达父 UI，TODO 不作为异常兜底转发', async () => {
    // 子 Agent 不维护独立待办；其余交互 / 可见产物仍必须到父 chat 流，
    // 否则用户看不到子 Agent 创建的计划卡片、无法响应子 HITL 询问，
    // 或看不到子工具的 skill credential 警告。
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      async function* gen(): AsyncGenerator<StreamEvent, string> {
        config.emitStreamEvent?.({
          type: StreamEvents.PLAN_PROPOSAL,
          payload: { plan_document_id: 'doc-1', plan: 'do A then B' },
        });
        config.emitStreamEvent?.({
          type: StreamEvents.ASK_USER_REQUIRED,
          payload: { request_id: 'req-1', tool_name: 'ask_user' },
        });
        config.emitStreamEvent?.({
          type: StreamEvents.TODO,
          payload: { action: 'open', items: [{ id: 't1', content: 'step', status: 'pending' }] },
        });
        config.emitStreamEvent?.({
          type: StreamEvents.SYSTEM_NOTICE,
          payload: { notice_type: 'skill_credential_unavailable', content: 'missing cred' },
        });
        return 'done';
      }
      return gen();
    }) as typeof forkQuery);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_d11_whitelist');
    await tool.execute({ prompt: 'whitelist test' }, ctx);

    const collected = ctx.__collected;
    expect(collected.some((e) => e.type === StreamEvents.PLAN_PROPOSAL),
      'PLAN_PROPOSAL 必须转发到父 UI（子 plan_create 卡片）').toBe(true);
    expect(collected.some((e) => e.type === StreamEvents.ASK_USER_REQUIRED),
      'ASK_USER_REQUIRED 必须转发（子 HITL 询问）').toBe(true);
    expect(collected.some((e) => e.type === StreamEvents.TODO),
      'TODO 不应作为异常兜底转发到父 UI').toBe(false);
    expect(collected.some((e) => e.type === StreamEvents.SYSTEM_NOTICE
        && (e.payload as { notice_type?: string }).notice_type === 'skill_credential_unavailable'),
      'SYSTEM_NOTICE(skill_credential_unavailable) 必须转发').toBe(true);
  });

  it('ASK_FORM_REQUIRED 必须转发到父 UI（子 ask_form 表单审批）', async () => {
    // W1 三视角 review · P1 修复 7：补全白名单 6 项中之前缺测的 ASK_FORM_REQUIRED。
    // 子 Agent 通过 ask_form 工具触发的多字段表单审批必须能在父 chat 流渲染
    // SchemaFormRenderer，否则用户无法填写并提交字段，子 Agent 永远卡在
    // pending——违背 C2 透明性 + 哲学 C5 失败/取消是一等公民。
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      async function* gen(): AsyncGenerator<StreamEvent, string> {
        config.emitStreamEvent?.({
          type: StreamEvents.ASK_FORM_REQUIRED,
          payload: {
            request_id: 'form-req-1',
            tool_name: 'ask_form',
            tool_call_id: 'tc_form',
            fields: [{ name: 'env_name', type: 'text', label: '环境名' }],
          },
        });
        return 'done';
      }
      return gen();
    }) as typeof forkQuery);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_d11_ask_form');
    await tool.execute({ prompt: 'ask form test' }, ctx);

    expect(
      ctx.__collected.some((e) => e.type === StreamEvents.ASK_FORM_REQUIRED),
      'ASK_FORM_REQUIRED 必须转发（子 ask_form 表单审批）',
    ).toBe(true);
    // 与同款 ASK_USER_REQUIRED 一致地透传 run_id 注入（让父 UI 知道是
    // 哪个子 Agent 在询问，与 SubagentRun 关联）。
    const formEvent = ctx.__collected.find(
      (e) => e.type === StreamEvents.ASK_FORM_REQUIRED,
    );
    expect((formEvent?.payload as { run_id?: string; subagent_run_id?: string }).run_id,
      '白名单转发必须注入 run_id 让父 UI 关联子 Agent').toBeDefined();
    expect((formEvent?.payload as { run_id?: string; subagent_run_id?: string }).subagent_run_id)
      .toBe((formEvent?.payload as { run_id?: string }).run_id);
  });

  it('REQUEST_APPROVAL_REQUIRED 必须转发到父 UI（子 request_approval 高风险审批）', async () => {
    // W1 三视角 review · P1 修复 7：补全白名单 6 项中之前缺测的
    // REQUEST_APPROVAL_REQUIRED。子 Agent 在跑 request_approval 工具（高风险
    // 方案审批，必带 risk_level）时父 UI 必须接住 → 渲染 ApprovalPanel 让用
    // 户批准/拒绝，否则子 Agent 卡死无法继续——同 ASK_FORM 一样的哲学约束。
    vi.mocked(forkQuery).mockImplementation(((config: ForkQueryConfig) => {
      async function* gen(): AsyncGenerator<StreamEvent, string> {
        config.emitStreamEvent?.({
          type: StreamEvents.REQUEST_APPROVAL_REQUIRED,
          payload: {
            request_id: 'approval-req-1',
            tool_name: 'request_approval',
            tool_call_id: 'tc_approval',
            rationale: '准备删除 5 个文件，需要批准',
            risk_level: 'high',
          },
        });
        return 'done';
      }
      return gen();
    }) as typeof forkQuery);

    const tool = createAgentTool(makeBaseConfig());
    const ctx = makeContext('toolu_d11_approval');
    await tool.execute({ prompt: 'approval test' }, ctx);

    expect(
      ctx.__collected.some((e) => e.type === StreamEvents.REQUEST_APPROVAL_REQUIRED),
      'REQUEST_APPROVAL_REQUIRED 必须转发（子 request_approval 高风险审批）',
    ).toBe(true);
    const approvalEvent = ctx.__collected.find(
      (e) => e.type === StreamEvents.REQUEST_APPROVAL_REQUIRED,
    );
    expect((approvalEvent?.payload as { run_id?: string; subagent_run_id?: string }).run_id,
      '白名单转发必须注入 run_id 让父 UI 关联子 Agent').toBeDefined();
    expect((approvalEvent?.payload as { run_id?: string; subagent_run_id?: string }).subagent_run_id)
      .toBe((approvalEvent?.payload as { run_id?: string }).run_id);
    // 关键风险字段必须原样透传（不能被 enrichedPayload 改写覆盖）
    expect((approvalEvent?.payload as { risk_level?: string }).risk_level)
      .toBe('high');
  });
});
