import { describe, it, expect, vi } from 'vitest';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import {
  buildForkedMessages,
  filterIncompleteToolCalls,
  FORK_PLACEHOLDER_RESULT,
} from '../src/subagent/fork-query.js';
import { createAgentTool, cancelSubagent, getActiveSubagentIds } from '../src/subagent/agent-tool.js';
import { StreamEvents } from '../src/engine/contracts/stream-events.js';
import { ToolRegistry } from '../src/engine/tooling/tool-system.js';
import { runTools } from '../src/engine/tooling/tool-orchestration.js';
import { createMockPermissionHandler, createMockProvider, createMockToolProvider } from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
  ToolUseBlock,
  ContentBlock,
  ToolResultBlock,
  TextBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMResponseChunk,
  LLMProvider,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type { ToolExecutionResult } from '../src/engine/tooling/tool-orchestration.js';

// ─── Helpers ─────────────────────────────────────────────────────────

function makeContext(overrides = {}) {
  return {
    threadId: 'test-thread',
    runtimeId: 'test-session',
    toolUseId: 'mock-tool-use',
    abortSignal: new AbortController().signal,
    messages: [] as Message[],
    ...overrides,
  };
}

async function drainRunTools(
  gen: AsyncGenerator<StreamEvent, ToolExecutionResult[]>,
): Promise<{ events: StreamEvent[]; results: ToolExecutionResult[] }> {
  const events: StreamEvent[] = [];
  let next = await gen.next();
  while (!next.done) {
    events.push(next.value);
    next = await gen.next();
  }
  return { events, results: next.value };
}

// ─── BudgetTracker ──────────────────────────────────────────────────

describe('BudgetTracker', () => {
  it('should track token usage', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 1000 });
    bt.recordUsage(100, 50);
    bt.recordUsage(200, 100);

    const usage = bt.getUsage();
    expect(usage.inputTokens).toBe(300);
    expect(usage.outputTokens).toBe(150);
    expect(bt.isExhausted()).toBe(false);
  });

  it('should report exhausted when tokens exceed limit', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 500 });
    bt.recordUsage(300, 250);
    expect(bt.isExhausted()).toBe(true);
  });

  it('should report exhausted when credits exceed limit', () => {
    const bt = new BudgetTracker({ maxCredits: 1.0 });
    bt.recordUsage(100, 50, 0.6);
    expect(bt.isExhausted()).toBe(false);
    bt.recordUsage(100, 50, 0.5);
    expect(bt.isExhausted()).toBe(true);
  });

  it('should return remaining budget', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 1000, maxCredits: 2.0 });
    bt.recordUsage(200, 100, 0.5);

    const remaining = bt.getRemainingBudget();
    expect(remaining.tokens).toBe(700);
    expect(remaining.credits).toBe(1.5);
  });

  it('should never be exhausted with no limits', () => {
    const bt = new BudgetTracker();
    bt.recordUsage(1_000_000, 1_000_000, 999);
    expect(bt.isExhausted()).toBe(false);
  });

  it('should track per-scope usage independently for parallel children', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 10_000 });

    bt.recordUsage(100, 50, 0.1, 'child-a');
    bt.recordUsage(200, 80, 0.2, 'child-b');
    bt.recordUsage(150, 60, 0.15, 'child-a');

    const scopeA = bt.getUsageByScope('child-a');
    expect(scopeA.inputTokens).toBe(250);
    expect(scopeA.outputTokens).toBe(110);
    expect(scopeA.credits).toBeCloseTo(0.25);

    const scopeB = bt.getUsageByScope('child-b');
    expect(scopeB.inputTokens).toBe(200);
    expect(scopeB.outputTokens).toBe(80);
    expect(scopeB.credits).toBeCloseTo(0.2);

    const global = bt.getUsage();
    expect(global.inputTokens).toBe(450);
    expect(global.outputTokens).toBe(190);
    expect(global.credits).toBeCloseTo(0.45);
  });

  it('should return zero usage for unknown scope', () => {
    const bt = new BudgetTracker();
    bt.recordUsage(100, 50, 0.1, 'known-scope');

    const unknown = bt.getUsageByScope('nonexistent');
    expect(unknown.inputTokens).toBe(0);
    expect(unknown.outputTokens).toBe(0);
    expect(unknown.credits).toBe(0);
  });

  it('should not attribute scopeless recordUsage to any scope', () => {
    const bt = new BudgetTracker();

    bt.recordUsage(300, 200, 0.5);
    bt.recordUsage(100, 50, 0.1, 'child-x');

    const scopeX = bt.getUsageByScope('child-x');
    expect(scopeX.inputTokens).toBe(100);
    expect(scopeX.outputTokens).toBe(50);

    const global = bt.getUsage();
    expect(global.inputTokens).toBe(400);
    expect(global.outputTokens).toBe(250);
  });
});

// ─── buildForkedMessages ────────────────────────────────────────────

describe('buildForkedMessages', () => {
  it('should replace tool_result content with placeholder', () => {
    const parentMessages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'let me check' },
          { type: 'tool_use', id: 'tu-1', name: 'bash', input: { command: 'ls' } },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'file1.txt\nfile2.txt' },
        ],
      },
      { role: 'assistant', content: [{ type: 'text', text: 'found files' }] },
    ];

    // 显式传 'full'：本用例测 'full' 行为下 tool_result 被替换为 placeholder
    // 的语义；默认 inheritMode 已是 'filtered'（D12 / 总控 §六 W0），filtered
    // 模式下 tool_use / tool_result 块会被过滤掉，找不到 toolResultMsg。
    const forked = buildForkedMessages(parentMessages, 'analyse file1.txt', {
      inheritMode: 'full',
    });

    const toolResultMsg = forked.find(
      (m) =>
        Array.isArray(m.content) &&
        (m.content as ContentBlock[]).some((b) => b.type === 'tool_result'),
    );
    expect(toolResultMsg).toBeTruthy();

    const trBlock = (toolResultMsg!.content as ContentBlock[]).find(
      (b) => b.type === 'tool_result',
    ) as ToolResultBlock;
    expect(trBlock.content).toBe(FORK_PLACEHOLDER_RESULT);

    // 决策（2026-07-04）：末条 = 主 Agent 派的 raw task，不再包 fork-boilerplate。
    const lastMsg = forked[forked.length - 1];
    expect(lastMsg.role).toBe('user');
    expect(typeof lastMsg.content).toBe('string');
    expect(lastMsg.content as string).toBe('analyse file1.txt');
    expect(lastMsg.content as string).not.toContain('fork-boilerplate');
  });

  it('末条 user message = 主 Agent 派的 raw task（无包裹）', () => {
    const forked = buildForkedMessages(
      [{ role: 'user', content: 'hi' }],
      'do the thing',
    );

    const last = forked[forked.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe('do the thing');
  });

  it('子任务消息只放 raw task，不带 worker 纪律 / boilerplate（纪律已移进 system prompt）', () => {
    const forked = buildForkedMessages(
      [{ role: 'user', content: '请帮我分析这段代码' }],
      '检查错误',
    );

    const last = forked[forked.length - 1];
    expect(last.content).toBe('检查错误');
    expect(last.content as string).not.toContain('停下来，先读这段');
    expect(last.content as string).not.toContain('fork-boilerplate');
  });

  it('should handle empty parent messages', () => {
    const forked = buildForkedMessages([], 'start fresh');
    expect(forked.length).toBe(1);
    expect(forked[0].content).toBe('start fresh');
  });

  // ── 决策（2026-07-04）：子 Agent 上下文纯净化 ─────────────────────────
  //
  // 用户拍板：子 Agent 只收到 system prompt（含 worker 纪律段）+ 主 Agent 派的
  // task；不掺任何父会话背景、不再有 <inherited-context> / <fork-boilerplate> /
  // <active-directive> 包裹。生产路径恒 inheritMode='none'。以下测试锁住这个契约。

  it('不再注入 <inherited-context> 框定声明（filtered 也不加）', () => {
    const PARENT_INSTRUCTION = 'PARENT_ORIGINAL_TASK_INSTRUCTION';
    const forked = buildForkedMessages(
      [{ role: 'user', content: PARENT_INSTRUCTION }],
      'child task',
      { inheritMode: 'filtered' },
    );
    const joined = forked
      .map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)))
      .join('\n');
    expect(joined).not.toContain('inherited-context');
    // 末条 = raw child task
    const last = forked[forked.length - 1];
    expect(last.content).toBe('child task');
  });

  it('子任务末条 = raw task，不带 active-directive / fork-boilerplate', () => {
    const forked = buildForkedMessages(
      [{ role: 'user', content: 'some parent background' }],
      'the real child directive',
      { inheritMode: 'filtered' },
    );
    const last = forked[forked.length - 1];
    expect(last.role).toBe('user');
    expect(last.content).toBe('the real child directive');
    expect(last.content as string).not.toContain('active-directive');
    expect(last.content as string).not.toContain('fork-boilerplate');
  });

  it('none 模式：子 Agent 消息只有 raw task，不含父内容 / 框定 / 包裹', () => {
    const forked = buildForkedMessages(
      [{ role: 'user', content: 'parent stuff that should NOT leak' }],
      'isolated task',
      { inheritMode: 'none' },
    );
    expect(forked.length).toBe(1);
    expect(forked[0].content).toBe('isolated task');
    expect(forked[0].content as string).not.toContain('inherited-context');
    expect(forked[0].content as string).not.toContain('parent stuff');
    expect(forked[0].content as string).not.toContain('active-directive');
  });
});

// ─── filterIncompleteToolCalls ──────────────────────────────────────

describe('filterIncompleteToolCalls', () => {
  it('should keep complete tool_use/tool_result pairs', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-1', name: 'bash', input: {} },
        ],
      },
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
        ],
      },
    ];

    const filtered = filterIncompleteToolCalls(messages);
    expect(filtered).toHaveLength(3);
  });

  it('should remove unpaired tool_use blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'text', text: 'thinking...' },
          { type: 'tool_use', id: 'tu-orphan', name: 'bash', input: {} },
        ],
      },
    ];

    const filtered = filterIncompleteToolCalls(messages);
    const assistantMsg = filtered.find((m) => m.role === 'assistant');
    expect(assistantMsg).toBeTruthy();

    const blocks = assistantMsg!.content as ContentBlock[];
    expect(blocks.some((b) => b.type === 'tool_use')).toBe(false);
    expect(blocks.some((b) => b.type === 'text')).toBe(true);
  });

  it('should remove empty assistant messages after filtering', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tu-orphan', name: 'bash', input: {} },
        ],
      },
    ];

    const filtered = filterIncompleteToolCalls(messages);
    expect(filtered.every((m) => {
      if (typeof m.content === 'string') return m.content.length > 0;
      return (m.content as ContentBlock[]).length > 0;
    })).toBe(true);
  });
});

// ─── concurrencySafe in tool-orchestration ──────────────────────────

describe('concurrencySafe tool orchestration', () => {
  it('should run concurrencySafe tools in parallel', async () => {
    const order: string[] = [];

    function makeConcurrentTool(name: string): Tool {
      return {
        name,
        description: `concurrent tool: ${name}`,
        inputSchema: { type: 'object', properties: {} },
        isReadOnly: false,
        concurrencySafe: true,
        execute: async () => {
          order.push(`${name}:start`);
          await new Promise((r) => setTimeout(r, 30));
          order.push(`${name}:end`);
          return { content: `result-${name}` };
        },
      };
    }

    const tools = [makeConcurrentTool('agent-1'), makeConcurrentTool('agent-2')];
    const registry = new ToolRegistry();
    registry.loadTools({ getTools: () => tools });

    const blocks: ToolUseBlock[] = tools.map((t, i) => ({
      type: 'tool_use',
      id: `id-${i}`,
      name: t.name,
      input: {},
    }));

    const gen = runTools({
      options: { allowLegacyPermissionFallback: true },
      toolUseBlocks: blocks,
      registry,
      context: makeContext(),
      permissionHandler: createMockPermissionHandler(),
    });

    const { results } = await drainRunTools(gen);

    expect(results).toHaveLength(2);

    const firstEnd = order.findIndex((s) => s.endsWith(':end'));
    const allStartsBeforeFirstEnd = order
      .slice(0, firstEnd)
      .every((s) => s.endsWith(':start'));
    expect(allStartsBeforeFirstEnd).toBe(true);
  });
});

// ─── createAgentTool ────────────────────────────────────────────────

describe('createAgentTool', () => {
  it('should have correct metadata', () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    expect(tool.name).toBe('agent');
    expect(tool.concurrencySafe).toBe(true);
    expect(tool.isReadOnly).toBe(false);
  });

  it('schema exposes fork_context and findings report contract', () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const properties = tool.inputSchema.properties as Record<string, { enum?: string[]; type?: string }>;
    expect(properties.fork_context?.type).toBe('boolean');
    expect(properties.report_schema?.enum).toEqual(['free', 'findings']);
    expect(properties).not.toHaveProperty('max_turns');
    expect(properties).not.toHaveProperty('maxTurns');
  });

  it('should reject empty prompt', async () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute({ prompt: '' }, makeContext());
    expect(result.isError).toBe(true);
  });

  it('should reject when budget exhausted', async () => {
    const bt = new BudgetTracker({ maxTotalTokens: 100 });
    bt.recordUsage(50, 60);

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
      budgetTracker: bt,
    });

    const result = await tool.execute({ prompt: 'do something' }, makeContext());
    expect(result.isError).toBe(true);
    // W4 (2026-05-26)：trySubmit 的 budget_exhausted 走中文化文案（D2 决策）。
    expect(result.content).toContain('账单余额不足');
  });

  it('should allow nested fork (grandchild) inside fork child', async () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const forkChildMessages: Message[] = [
      { role: 'user', content: '<fork-boilerplate>\n你是一个 fork 出来的工作进程。\n</fork-boilerplate>\n\n你的指令：do X' },
    ];

    const result = await tool.execute(
      { prompt: 'spawn grandchild' },
      makeContext({ messages: forkChildMessages }),
    );
    expect(result.isError).toBeFalsy();
  });

  it('fork_context=true 时子 Agent 继承父对话历史', async () => {
    const requests: Array<{ messages?: Message[] }> = [];
    const provider: LLMProvider = {
      async *createStream(request): AsyncIterable<LLMResponseChunk> {
        requests.push(request as { messages?: Message[] });
        yield { type: 'text_delta', text: 'done' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'child task', fork_context: true },
      makeContext({
        messages: [
          { role: 'user', content: 'parent context marker' },
          { role: 'assistant', content: 'parent answer marker' },
        ] satisfies Message[],
      }),
    );

    expect(result.isError).toBeFalsy();
    const joined = JSON.stringify(requests[0]?.messages ?? []);
    expect(joined).toContain('parent context marker');
    expect(joined).toContain('parent answer marker');
    expect(joined).toContain('child task');
  });

  it('report_schema=findings 注入输出契约并回传结构化产出', async () => {
    const requests: Array<{ messages?: Message[] }> = [];
    const events: StreamEvent[] = [];
    const reportJson = {
      findings: [
        {
          claim: 'exec description is concise',
          evidence: ['packages/agent-runtime/src/capability/core/shell.ts'],
          confidence: 'high',
        },
      ],
      limitations: [],
      summary: '契约有效',
    };
    const provider: LLMProvider = {
      async *createStream(request): AsyncIterable<LLMResponseChunk> {
        requests.push(request as { messages?: Message[] });
        yield { type: 'text_delta', text: `\`\`\`json\n${JSON.stringify(reportJson)}\n\`\`\`\n\n完成` };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };
    const tool = createAgentTool({
      provider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'review tool contract', report_schema: 'findings' },
      makeContext({ emitStreamEvent: (event: StreamEvent) => events.push(event) }),
    );

    expect(result.isError).toBeFalsy();
    expect(JSON.stringify(requests[0]?.messages ?? [])).toContain('输出契约');
    expect(result.content).toContain('<structured_report>');
    expect(result.content).toContain('exec description is concise');
    const completed = events.find((event) => event.type === StreamEvents.SUBAGENT_COMPLETED);
    expect((completed?.payload as { structured_report?: unknown }).structured_report).toEqual(reportJson);
  });

  // ─── "父子孙三级" 递归封顶（2026-05-29 dogfood：子 Agent 又派子 Agent）──
  //
  // 用户拍板：最多父子孙三级（主=0 / 子=1 / 孙=2），孙不再 fork。根因是子 Agent
  // 继承父会话上下文（含父的原始编排指令）+ 持有 agent 工具，弱模型无视
  // <fork-boilerplate> 把父任务整个重跑。结构性剔除工具（孙看不到 agent）是唯一
  // 可靠拦截；guard 是 tool_domains 等边缘路径的兜底防御层。
  //
  // 2026-06-26 决策 1（ 方案 C）：inheritMode 默认改 'none'，子 Agent 不
  // 继承父历史，从源头掐断父原文污染。三级嵌套在此保护下保留。
  describe('subagent depth cap (父子孙三级)', () => {
    const SC = { sessionDir: '/tmp/test-depth', threadId: 'test' };
    const marker: Tool = {
      name: 'marker_tool',
      description: 'marker',
      inputSchema: { type: 'object' },
      isReadOnly: true,
      execute: async () => ({ content: 'x' }),
    };

    /** 一个会记录每次 createStream 收到的工具名的 provider（用于断言子 Agent 工具集）。 */
    function makeCapturingProvider(): { provider: LLMProvider; calls: string[][] } {
      const calls: string[][] = [];
      const provider: LLMProvider = {
        // eslint-disable-next-line require-yield
        async *createStream(request) {
          calls.push((request.tools ?? []).map((t) => t.name));
          return; // 立即结束子 ReAct（无 chunk = 直接收尾）
        },
      };
      return { provider, calls };
    }

    function makeAgentToolWith(provider: LLMProvider): Tool {
      let toolsRef: Tool[] = [marker];
      const toolProvider = { getTools: () => toolsRef };
      const agentTool = createAgentTool({
        provider,
        tools: toolProvider,
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: SC,
        model: 'sonnet',
      });
      // config.tools 同时含 agent 自身 + marker（模拟真实 host 注册的工具集）
      toolsRef = [agentTool, marker];
      return agentTool;
    }

    it('子（childDepth=1）工具集保留 agent —— 主 Agent 派的子仍能再派孙', async () => {
      const { provider, calls } = makeCapturingProvider();
      const agentTool = makeAgentToolWith(provider);
      // 主 Agent（depth 0）派子 → 子 = depth 1
      await agentTool.execute({ prompt: 'noop' }, makeContext({ subagentDepth: 0 }));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).toContain('agent');
      expect(calls[0]).toContain('marker_tool');
    });

    it('孙（childDepth=2）工具集剔除 agent —— 孙拿不到 agent，无法再派重孙', async () => {
      const { provider, calls } = makeCapturingProvider();
      const agentTool = makeAgentToolWith(provider);
      // 子 Agent（depth 1）派子 → 子 = depth 2 = 孙
      await agentTool.execute({ prompt: 'noop' }, makeContext({ subagentDepth: 1 }));
      expect(calls.length).toBeGreaterThan(0);
      expect(calls[0]).not.toContain('agent'); // 孙看不到 agent 工具（结构性拦截）
      expect(calls[0]).toContain('marker_tool'); // 其余工具不受影响
    });

    it('孙（depth 2）直接调 agent 被 guard 拒绝（防御层，给明确文案）', async () => {
      const agentTool = createAgentTool({
        provider: createMockProvider(),
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: SC,
        model: 'sonnet',
      });
      const result = await agentTool.execute(
        { prompt: 'spawn 重孙' },
        makeContext({ subagentDepth: 2 }),
      );
      expect(result.isError).toBe(true);
      expect(result.content).toContain('父子孙三级');
    });

    it('主（depth 0）/ 子（depth 1）调 agent 不被 guard 拒绝', async () => {
      const agentTool = createAgentTool({
        provider: createMockProvider(),
        tools: createMockToolProvider(),
        permissionHandler: createMockPermissionHandler(),
        sessionConfig: SC,
        model: 'sonnet',
      });
      const r0 = await agentTool.execute({ prompt: 'noop' }, makeContext({ subagentDepth: 0 }));
      expect(r0.isError).toBeFalsy();
      const r1 = await agentTool.execute({ prompt: 'noop' }, makeContext({ subagentDepth: 1 }));
      expect(r1.isError).toBeFalsy();
    });
  });

  it('should emit SUBAGENT_STARTED and SUBAGENT_COMPLETED events', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute(
      { prompt: 'simple task', description: 'test' },
      makeContext({ emitStreamEvent: emitter }),
    );

    const started = events.find((e) => e.type === 'agent.stream.subagent_started');
    const completed = events.find((e) => e.type === 'agent.stream.subagent_completed');

    expect(started).toBeTruthy();
    expect(completed).toBeTruthy();
    expect(started!.payload).toHaveProperty('subagent_run_id');
    expect(completed!.payload).toHaveProperty('summary');
  });

  // H2-A FR-10 review fix：澄清 child relay 实际路径 — childEmitter 仅在
  // 工具内部主动 emit 时触发，子 Agent 主线 ReAct 事件不经此路径（被
  // agent-tool 的 while loop 消费成 SUBAGENT_PROGRESS）。
  //
  // 本测试断言的契约：当工具内部确实通过 context.emitStreamEvent(...) 发了
  // 事件时，childEmitter 必须给事件加 child_id；并且，对于未自带 trace_id
  // 的事件，若已观察到子 lifecycle.start（理论上不会经 childEmitter 但保留
  // 防御），就注入子 trace_id；否则保持不带（父宿主 DeliveryBatchBuffer 会用父
  // trace_id 兜底）。
  //
  // 子 Agent 主线事件不可见 AdminDash 是更大的问题，登记 L36，超出 H2-A 范围。
  it('child SUBAGENT_* events do not have child_id (parent-perspective events)', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute(
      { prompt: 'simple task' },
      makeContext({ emitStreamEvent: emitter }),
    );

    const subagentStarted = events.find(
      (e) => e.type === 'agent.stream.subagent_started',
    );
    expect(subagentStarted).toBeTruthy();
    // SUBAGENT_STARTED 是父视角事件，不应带 child_id 标识；由父 DeliveryBatchBuffer
    // 用父 trace_id 注入到 payload（H1 行为），与 H2-A trace 接通一致。
    expect((subagentStarted!.payload as { child_id?: string }).child_id).toBeUndefined();
    expect((subagentStarted!.payload as { trace_id?: string }).trace_id).toBeUndefined();

    // 当前测试 setup（mock provider yield text + stop，无工具）下 childEmitter
    // 完全不会被触发；断言 events 列表中没有「带 child_id 的 lifecycle/assistant」
    // 事件，证明 child raw events 走的不是 emitter 路径（agent-tool 主线消费）。
    const childRawEvents = events.filter(
      (e) =>
        (e.payload as { child_id?: string }).child_id !== undefined &&
        (e.type === 'agent.stream.lifecycle' ||
          e.type === 'agent.stream.assistant' ||
          e.type === 'agent.stream.done'),
    );
    expect(childRawEvents).toEqual([]);
  });

  //  有意移除：业务身份不再经 ToolContext / fork-query 透传。
  // Space / Organization 由 host 装配期烘焙进子 Agent 工具闭包；本用例锁定
  // 「子 ToolContext 不再携带 spaceId / organizationId」的不变量。
  it('child agent ToolContext 不再继承父 spaceId / organizationId ', async () => {
    const seenFromChild: Array<Record<string, unknown>> = [];

    const probeTool: Tool = {
      name: 'probe_space',
      description: 'Probe ToolContext identity fields — test only',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute(_input, context) {
        seenFromChild.push({
          hasSpaceId: Object.prototype.hasOwnProperty.call(context, 'spaceId'),
          hasOrganizationId: Object.prototype.hasOwnProperty.call(context, 'organizationId'),
          spaceId: (context as { spaceId?: string }).spaceId,
          organizationId: (context as { organizationId?: string }).organizationId,
        });
        return { content: 'probed' };
      },
    };

    const childProvider = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-1', name: 'probe_space', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const tool = createAgentTool({
      provider: childProvider,
      tools: createMockToolProvider([probeTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'use probe_space' },
      // 故意传业务 id： 后应被忽略，不进入子 ToolContext
      makeContext({ spaceId: 'parent-space-id', organizationId: 'parent-wt-id' }),
    );

    expect(result.isError).toBeFalsy();
    expect(seenFromChild.length).toBeGreaterThan(0);
    expect(seenFromChild[0].hasSpaceId).toBe(false);
    expect(seenFromChild[0].hasOrganizationId).toBe(false);
    expect(seenFromChild[0].spaceId).toBeUndefined();
    expect(seenFromChild[0].organizationId).toBeUndefined();
  });
});

// ─── BudgetTracker scope tracking ──────────────────────────────────

describe('BudgetTracker scope tracking', () => {
  it('should track usage per scope independently', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 10000 });
    bt.recordUsage(100, 50, 0.1, 'child-a');
    bt.recordUsage(200, 80, 0.2, 'child-b');
    bt.recordUsage(50, 20, 0.05, 'child-a');

    const scopeA = bt.getUsageByScope('child-a');
    expect(scopeA.inputTokens).toBe(150);
    expect(scopeA.outputTokens).toBe(70);
    expect(scopeA.credits).toBeCloseTo(0.15);

    const scopeB = bt.getUsageByScope('child-b');
    expect(scopeB.inputTokens).toBe(200);
    expect(scopeB.outputTokens).toBe(80);
    expect(scopeB.credits).toBeCloseTo(0.2);
  });

  it('should return zero for unknown scope', () => {
    const bt = new BudgetTracker();
    bt.recordUsage(100, 50, 0.1, 'known-scope');

    const unknown = bt.getUsageByScope('nonexistent');
    expect(unknown.inputTokens).toBe(0);
    expect(unknown.outputTokens).toBe(0);
    expect(unknown.credits).toBe(0);
  });

  it('global getUsage should include all scoped usage', () => {
    const bt = new BudgetTracker();
    bt.recordUsage(100, 50, 0.1, 'scope-1');
    bt.recordUsage(200, 100, 0.2, 'scope-2');
    bt.recordUsage(300, 150);

    const global = bt.getUsage();
    expect(global.inputTokens).toBe(600);
    expect(global.outputTokens).toBe(300);
    expect(global.credits).toBeCloseTo(0.3);
  });

  it('should ignore negative values in scoped recording', () => {
    const bt = new BudgetTracker({ maxTotalTokens: 5000 });
    bt.recordUsage(-100, -50, -0.5, 'bad-scope');

    const scoped = bt.getUsageByScope('bad-scope');
    expect(scoped.inputTokens).toBe(0);
    expect(scoped.outputTokens).toBe(0);
    expect(scoped.credits).toBe(0);

    const global = bt.getUsage();
    expect(global.inputTokens).toBe(0);
    expect(global.outputTokens).toBe(0);
  });
});

// ─── truncateSummary edge cases (via createAgentTool integration) ──

describe('truncateSummary edge cases (via agent tool integration)', () => {
  function makeToolThatReturns(value: unknown): Tool {
    return {
      name: 'test_tool',
      description: 'returns a specific value',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute() {
        return { content: typeof value === 'string' ? value : JSON.stringify(value) };
      },
    };
  }

  function makeProviderWithToolUse(toolName: string): ReturnType<typeof createMockProvider> {
    return createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-1', name: toolName, input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
  }

  it('should handle circular reference in tool output without crashing', async () => {
    const circularTool: Tool = {
      name: 'circular_tool',
      description: 'returns circular ref',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute() {
        return { content: '[Circular]' };
      },
    };

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: makeProviderWithToolUse('circular_tool'),
      tools: createMockToolProvider([circularTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'use circular_tool' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    expect(result.isError).toBeFalsy();
  });

  it('should handle undefined and null tool outputs gracefully', async () => {
    const nullTool: Tool = {
      name: 'null_tool',
      description: 'returns empty',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute() {
        return { content: '' };
      },
    };

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: makeProviderWithToolUse('null_tool'),
      tools: createMockToolProvider([nullTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'use null_tool' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    expect(result.isError).toBeFalsy();
  });

  it('should handle very long string tool outputs', async () => {
    const longString = 'x'.repeat(10000);
    const longTool = makeToolThatReturns(longString);
    longTool.name = 'long_tool';

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: makeProviderWithToolUse('long_tool'),
      tools: createMockToolProvider([longTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'use long_tool' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    expect(result.isError).toBeFalsy();

    const progressEvents = events.filter(
      (e) => e.type === StreamEvents.SUBAGENT_PROGRESS,
    );
    for (const pe of progressEvents) {
      const history = pe.payload.tool_history as Array<{ output_summary?: string }>;
      if (history?.length) {
        const last = history[history.length - 1];
        if (last.output_summary) {
          expect(last.output_summary.length).toBeLessThanOrEqual(201);
        }
      }
    }
  });

  it('should handle BigInt-like string values', async () => {
    const bigintTool = makeToolThatReturns('99999999999999999999999999999999');
    bigintTool.name = 'bigint_tool';

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: makeProviderWithToolUse('bigint_tool'),
      tools: createMockToolProvider([bigintTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'use bigint_tool' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    expect(result.isError).toBeFalsy();
  });

  it('should handle Symbol-like string values', async () => {
    const symbolTool = makeToolThatReturns('Symbol(test)');
    symbolTool.name = 'symbol_tool';

    const events: StreamEvent[] = [];
    const tool = createAgentTool({
      provider: makeProviderWithToolUse('symbol_tool'),
      tools: createMockToolProvider([symbolTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const result = await tool.execute(
      { prompt: 'use symbol_tool' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => events.push(e) }),
    );
    expect(result.isError).toBeFalsy();
  });
});

// ─── cancelSubagent ─────────────────────────────────────────────────

describe('cancelSubagent', () => {
  it('should return false for unknown childId', () => {
    const result = cancelSubagent('non-existent-child-id-' + Date.now());
    expect(result).toBe(false);
  });

  it('should return true and abort for active child', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    let resolveHang: (() => void) | undefined;
    const hangingProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        await new Promise<void>((r) => { resolveHang = r; });
        yield { type: 'text_delta' as const, text: 'post-abort' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider: hangingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const execPromise = tool.execute(
      { prompt: 'long running task' },
      makeContext({ emitStreamEvent: emitter }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const startedEvent = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    expect(startedEvent).toBeTruthy();
    const childId = startedEvent!.payload.subagent_run_id as string;

    expect(getActiveSubagentIds()).toContain(childId);

    const cancelled = cancelSubagent(childId);
    expect(cancelled).toBe(true);

    resolveHang?.();
    const result = await execPromise;
    expect(typeof result.content).toBe('string');
  });

  it('should cleanup after cancel', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    let resolveHang: (() => void) | undefined;
    const hangingProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        await new Promise<void>((r) => { resolveHang = r; });
        yield { type: 'text_delta' as const, text: 'nope' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider: hangingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const execPromise = tool.execute(
      { prompt: 'another long task' },
      makeContext({ emitStreamEvent: emitter }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const startedEvent = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    const childId = startedEvent!.payload.subagent_run_id as string;

    cancelSubagent(childId);
    resolveHang?.();
    await execPromise;

    expect(getActiveSubagentIds()).not.toContain(childId);
  });
});

// ─── nested fork (grandchild) with array content blocks ─────────────

describe('nested fork with array content blocks', () => {
  it('should allow fork even when messages contain fork-boilerplate', async () => {
    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const forkChildMessages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: '<fork-boilerplate>\nYou are a forked worker.\n</fork-boilerplate>\n\nDo X' },
        ],
      },
    ];

    const result = await tool.execute(
      { prompt: 'spawn grandchild from array content' },
      makeContext({ messages: forkChildMessages }),
    );
    expect(result.isError).toBeFalsy();
  });
});

// ─── event isolation ────────────────────────────────────────────────

describe('event isolation', () => {
  it('should emit SUBAGENT_STARTED event with correct payload including speaker', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute(
      { prompt: 'analyse code', description: 'code review' },
      makeContext({ emitStreamEvent: emitter }),
    );

    const started = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    expect(started).toBeTruthy();
    expect(started!.payload.subagent_run_id).toBeTruthy();
    expect(started!.payload.task).toBe('analyse code');
    expect(started!.payload.label).toBe('code review');
    expect(started!.payload).toHaveProperty('started_at');
    expect(started!.payload.speaker_id).toBe(started!.payload.subagent_run_id);
    const speaker = started!.payload.speaker as { kind: string; source: string; display_name: string; display_short_id: string; status: string };
    expect(speaker.kind).toBe('sub_agent');
    expect(speaker.source).toBe('inherit');
    expect(speaker.status).toBe('running');
    expect(speaker.display_short_id).toBe((started!.payload.subagent_run_id as string).slice(0, 4));
    expect(typeof speaker.display_name).toBe('string');
    expect(speaker.display_name.length).toBeGreaterThan(0);
  });

  it('should emit SUBAGENT_COMPLETED with summary and speaker', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute(
      { prompt: 'simple analysis' },
      makeContext({ emitStreamEvent: emitter }),
    );

    const completed = events.find((e) => e.type === StreamEvents.SUBAGENT_COMPLETED);
    expect(completed).toBeTruthy();
    expect(completed!.payload).toHaveProperty('summary');
    expect(completed!.payload).toHaveProperty('stats');
    expect(completed!.payload).toHaveProperty('ended_at');
    expect(typeof completed!.payload.summary).toBe('string');
    expect(completed!.payload.speaker_id).toBe(completed!.payload.subagent_run_id);
    const speaker = completed!.payload.speaker as { kind: string; status: string };
    expect(speaker.kind).toBe('sub_agent');
    expect(speaker.status).toBe('completed');
  });

  it('should NOT forward child tool events to parent emitter', async () => {
    const parentEvents: StreamEvent[] = [];
    const parentEmitter = (e: StreamEvent) => parentEvents.push(e);

    const childTool: Tool = {
      name: 'child_bash',
      description: 'simulated bash',
      inputSchema: { type: 'object', properties: { command: { type: 'string' } } },
      isReadOnly: true,
      async execute() {
        return { content: 'file1.txt\nfile2.txt' };
      },
    };

    const providerWithToolCall = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-child-1', name: 'child_bash', input: { command: 'ls' } } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'Scope: listing done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const tool = createAgentTool({
      provider: providerWithToolCall,
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute(
      { prompt: 'list files' },
      makeContext({ emitStreamEvent: parentEmitter }),
    );

    // W4.5 第三波 C1（2026-05-13）：wire `StreamEvents.TOOL` 已物理删；
    // 反向断言改用字面量 'agent.stream.tool' 验证 daemon 不再产生这条老协议事件。
    const childToolEvents = parentEvents.filter(
      (e) => e.type === 'agent.stream.tool' && (e.payload as { tool_name?: string }).tool_name === 'child_bash',
    );
    expect(childToolEvents).toHaveLength(0);

    for (const event of parentEvents) {
      if (event.type.startsWith('agent.stream.subagent')) continue;
      const runId = (event.payload as { subagent_run_id?: string } | undefined)?.subagent_run_id;
      expect(runId).toBeTruthy();
    }
  });

  // W4 (2026-05-26)：本测试在解除 deferred 后挂——因为 createMockProvider 只 emit
  // 简化事件（text_delta / tool_use / stop），不 emit lifecycle_start 也不模拟
  // tool-orchestration 在工具 settle 后的 SYSTEM_NOTICE(tool_completed)。
  // W1 重写后 SUBAGENT_PROGRESS 的 tool_history 数据源是 SYSTEM_NOTICE 而非
  // content_block 兜底，所以纯 mock 路径走不到。
  //
  // 真实路径已被 `tests/agent-tool-tool-history.test.ts`（W1 新增 8 个用例）+
  // `tests/agent-tool-w0-regression.test.ts` 覆盖。本测试待 W6 后续 wave 重写
  // mock 使其产生真实 envelope + SYSTEM_NOTICE 序列后再解 skip。
  it.skip('should include tool_history in SUBAGENT_PROGRESS [TODO: mock 不完整]', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    const childTool: Tool = {
      name: 'read_file',
      description: 'read a file',
      inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
      isReadOnly: true,
      async execute() {
        return { content: 'file contents here' };
      },
    };

    const providerWithToolCall = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-rf-1', name: 'read_file', input: { path: '/tmp/a.txt' } } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'Scope: read done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const tool = createAgentTool({
      provider: providerWithToolCall,
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute(
      { prompt: 'read file /tmp/a.txt' },
      makeContext({ emitStreamEvent: emitter }),
    );

    const progressEvents = events.filter(
      (e) => e.type === StreamEvents.SUBAGENT_PROGRESS,
    );
    expect(progressEvents.length).toBeGreaterThan(0);

    const lastProgress = progressEvents[progressEvents.length - 1];
    expect(lastProgress.payload).toHaveProperty('tool_history');
    const history = lastProgress.payload.tool_history as Array<{
      tool_name: string;
      success: boolean;
      elapsed_ms: number;
    }>;
    expect(history.length).toBeGreaterThan(0);
    expect(history[0].tool_name).toBe('read_file');
    expect(typeof history[0].success).toBe('boolean');
    expect(typeof history[0].elapsed_ms).toBe('number');
  });
});

// ─── cancel 路径 SUBAGENT_FAILED 事件（C-1 修复验证） ────────────────

describe('cancel emits SUBAGENT_FAILED with cancelled flag', () => {
  it('should emit SUBAGENT_FAILED with cancelled:true when child is cancelled', async () => {
    const events: StreamEvent[] = [];
    const emitter = (e: StreamEvent) => events.push(e);

    let rejectHang: ((err: Error) => void) | undefined;

    const hangingProvider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        await new Promise<void>((_resolve, reject) => {
          rejectHang = reject;
        });
        yield { type: 'text_delta' as const, text: 'unreachable' };
        yield { type: 'stop' as const, stopReason: 'end_turn' as const };
      },
    };

    const tool = createAgentTool({
      provider: hangingProvider,
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    const execPromise = tool.execute(
      { prompt: 'cancellable task' },
      makeContext({ emitStreamEvent: emitter }),
    );

    await new Promise((r) => setTimeout(r, 50));

    const startedEvent = events.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    expect(startedEvent).toBeTruthy();
    const childId = startedEvent!.payload.subagent_run_id as string;

    cancelSubagent(childId);
    rejectHang?.(new Error('The operation was aborted'));
    const result = await execPromise;

    expect(result.isError).toBe(true);
    const failedEvent = events.find((e) => e.type === StreamEvents.SUBAGENT_FAILED);
    expect(failedEvent).toBeTruthy();
    expect(failedEvent!.payload.cancelled).toBe(true);
    expect(failedEvent!.payload.error).toBe('Cancelled by parent');
    const speaker = failedEvent!.payload.speaker as { status: string };
    expect(speaker.status).toBe('cancelled');
  });
});

// ─── subagentTraceEmitter 测试（D-1 修复验证） ──────────────────────

describe('subagentTraceEmitter forwarding', () => {
  it('should forward child events to subagentTraceEmitter with run_id', async () => {
    const traceEvents: StreamEvent[] = [];
    const traceEmitter = (e: StreamEvent) => traceEvents.push(e);

    const childTool: Tool = {
      name: 'probe_tool',
      description: 'test probe',
      inputSchema: { type: 'object', properties: {} },
      isReadOnly: true,
      async execute() {
        return { content: 'probed' };
      },
    };

    const providerWithToolCall = createMockProvider([
      [
        { type: 'tool_use', toolUse: { id: 'tu-trace-1', name: 'probe_tool', input: {} } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);

    const tool = createAgentTool({
      provider: providerWithToolCall,
      tools: createMockToolProvider([childTool]),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
      subagentTraceEmitter: traceEmitter,
      getParentTraceId: () => 'parent-trace-abc',
    });

    const parentEvents: StreamEvent[] = [];
    await tool.execute(
      { prompt: 'use probe_tool' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => parentEvents.push(e) }),
    );

    expect(traceEvents.length).toBeGreaterThan(0);

    const eventsWithRunId = traceEvents.filter(
      (e) => typeof (e.payload as Record<string, unknown>).run_id === 'string'
        && (e.payload as Record<string, unknown>).subagent_run_id === (e.payload as Record<string, unknown>).run_id
        && (e.payload as Record<string, unknown>).observer_only === true,
    );
    expect(eventsWithRunId.length).toBe(traceEvents.length);

    const eventsWithParentTrace = traceEvents.filter(
      (e) => (e.payload as Record<string, unknown>).parent_trace_id === 'parent-trace-abc',
    );
    expect(eventsWithParentTrace.length).toBe(traceEvents.length);
  });

  it('should not emit to subagentTraceEmitter when not injected', async () => {
    const parentEvents: StreamEvent[] = [];

    const tool = createAgentTool({
      provider: createMockProvider(),
      tools: createMockToolProvider(),
      permissionHandler: createMockPermissionHandler(),
      sessionConfig: { sessionDir: '/tmp/test', threadId: 'test' },
      model: 'claude-sonnet-4-20250514',
    });

    await tool.execute(
      { prompt: 'simple task' },
      makeContext({ emitStreamEvent: (e: StreamEvent) => parentEvents.push(e) }),
    );

    const started = parentEvents.find((e) => e.type === StreamEvents.SUBAGENT_STARTED);
    expect(started).toBeTruthy();
  });
});
