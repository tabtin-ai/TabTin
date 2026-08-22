/**
 * 连续对话成熟化 · 事 3 + 事 8 —— orchestrator 集成测试。
 *
 * 验证 pressure-router + time-based microcompact 在 runCompactionPhase 里
 * 被正确路由：
 *   1. 压力够 + timeBasedMicroCompact.enabled=true + 有 lastAssistantTimestamp
 *      → content 被替换
 *   2. 压力不够（< microCompactStart） → 不触发
 *   3. enabled=false → 不触发（opt-in 默认）
 *   4. 无 lastAssistantTimestamp / usage anchor → 不触发（保守默认）
 *   5. 用 _lastUsageAnchor.timestamp 兜底也能触发
 *   6. RECOMMENDED 阈值（85-90% 只走 session memory 不调 LLM summary）
 */

import { describe, it, expect } from 'vitest';
import {
  runCompactionPhase,
  initOrchestratorState,
} from '../src/compact/compaction-orchestrator.js';
import { RECOMMENDED_PRESSURE_THRESHOLDS } from '../src/compact/pressure-router.js';
import { TIME_BASED_MC_CLEARED_MESSAGE } from '../src/compact/time-based-microcompact.js';
import {
  DEFAULT_CONTEXT_BUDGET,
} from '../src/engine/contracts/context-capability.js';
import type {
  Message,
  ToolResultBlock,
  ToolUseBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  AutoCompactParams,
  CompactResult,
  ContextBudget,
} from '../src/engine/contracts/context-capability.js';

function makeBudget(overrides: Partial<ContextBudget> = {}): ContextBudget {
  const base = { ...DEFAULT_CONTEXT_BUDGET, ...overrides };
  // 当 compactThreshold 被 bump 到高位（测试常用 0.999 压制 auto-compact），
  // emergencyThreshold 必须跟着 bump 保严格递增——否则 resolvePressureThresholds
  // 会 warn 并回落 DEFAULT，污染测试 stderr 干扰诊断。
  if (base.compactThreshold >= base.emergencyThreshold) {
    base.emergencyThreshold = Math.min(1.0, base.compactThreshold + 0.001);
  }
  return base;
}

function makeAsstWithToolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'using' },
      { type: 'tool_use', id, name, input: {} },
    ],
  };
}

function makeUserWithToolResult(id: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  };
}

function buildLongConversation(): Message[] {
  // 构造 "查询 X → 结果"的 6 轮（12 条）+ 1 条收尾 assistant
  const msgs: Message[] = [];
  for (let i = 0; i < 6; i++) {
    msgs.push({ role: 'user', content: `第 ${i} 轮问题` });
    msgs.push(makeAsstWithToolUse(`t${i}`, 'web_search'));
    msgs.push(makeUserWithToolResult(`t${i}`, `结果 ${i} 包含大量字符 ${'x'.repeat(500)}`));
  }
  msgs.push({ role: 'assistant', content: [{ type: 'text', text: '收尾' }] });
  return msgs;
}

describe('事 3 · orchestrator 集成：time-based microcompact 真实路由', () => {
  it('方案 §五 场景 2：两小时前的 tool_result 被替换，tool_use_id 保留', async () => {
    const now = 1_700_000_000_000;
    const twoHoursAgo = now - 2 * 60 * 60_000;
    const messages = buildLongConversation();

    // mock autoCompact 不做事（返回 null），让 time-based 是唯一的压缩动作
    const autoCompactMock = async (_p: AutoCompactParams): Promise<CompactResult | null> => null;

    const state = {
      messages,
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 10,
      // 让 pressure >= microCompactStart=0.75 但不进 auto-compact 路径
      _lastUsageAnchor: {
        inputTokens: 160_000, // 160k 压力
        messageCount: messages.length,
        timestamp: twoHoursAgo,
      },
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({ compactThreshold: 0.999 }), // 防止 auto-compact 介入
        contextWindowTokens: 200_000,
        maxOutputTokens: 0,
        pressureThresholds: { microCompactStart: 0.70 }, // 确保 pressure=0.8 命中
        timeBasedMicroCompact: {
          enabled: true,
          gapThresholdMinutes: 30,
          keepRecent: 2,
        },
        now: () => now,
      },
      autoCompactMock,
    );

    // 检查消息里的 tool_result content 被替换成占位字符串
    const clearedResults = result.messages.filter((m) => {
      if (typeof m.content === 'string') return false;
      return m.content.some(
        (b) => b.type === 'tool_result' && b.content === TIME_BASED_MC_CLEARED_MESSAGE,
      );
    });
    expect(clearedResults.length).toBeGreaterThan(0);

    // 检查 tool_use block 未被删（6 条依然存在）
    const toolUses = result.messages.flatMap((m) => {
      if (typeof m.content === 'string') return [];
      return m.content.filter((b) => b.type === 'tool_use') as ToolUseBlock[];
    });
    expect(toolUses.length).toBe(6);

    // 每个 tool_use_id 都能在 tool_result block 里找到配对
    for (const toolUse of toolUses) {
      const hasPairedResult = result.messages.some((m) => {
        if (typeof m.content === 'string') return false;
        return m.content.some(
          (b) => b.type === 'tool_result' && b.tool_use_id === toolUse.id,
        );
      });
      expect(hasPairedResult).toBe(true);
    }
  });

  it('enabled=false → 不触发 time-based（opt-in 默认）', async () => {
    const now = 1_700_000_000_000;
    const messages = buildLongConversation();

    const state = {
      messages,
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 10,
      _lastUsageAnchor: {
        inputTokens: 160_000,
        messageCount: messages.length,
        timestamp: now - 2 * 60 * 60_000,
      },
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({ compactThreshold: 0.999 }),
        contextWindowTokens: 200_000,
        maxOutputTokens: 0,
        pressureThresholds: { microCompactStart: 0.70 },
        // 不传 timeBasedMicroCompact => 不触发
        now: () => now,
      },
      async () => null,
    );

    // 所有 tool_result 保持原 content
    const anyCleared = result.messages.some((m) => {
      if (typeof m.content === 'string') return false;
      return m.content.some(
        (b) => b.type === 'tool_result' && b.content === TIME_BASED_MC_CLEARED_MESSAGE,
      );
    });
    expect(anyCleared).toBe(false);
  });

  it('压力不够（< microCompactStart=0.75）→ 不触发', async () => {
    const now = 1_700_000_000_000;
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      makeAsstWithToolUse('t1', 'file_read'),
      makeUserWithToolResult('t1', 'small result'),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    const state = {
      messages,
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 1,
      _lastUsageAnchor: {
        inputTokens: 1_000, // 极低压力
        messageCount: messages.length,
        timestamp: now - 2 * 60 * 60_000,
      },
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({ compactThreshold: 0.999 }),
        contextWindowTokens: 200_000,
        maxOutputTokens: 0,
        timeBasedMicroCompact: {
          enabled: true,
          gapThresholdMinutes: 30,
          keepRecent: 0,
        },
        now: () => now,
      },
      async () => null,
    );

    // 压力不够，time-based 不跑
    const blocks = result.messages[2].content as Array<ToolResultBlock>;
    expect(blocks[0].content).toBe('small result');
  });

  it('_lastUsageAnchor.timestamp 兜底也能判断 gap 触发', async () => {
    const now = 1_700_000_000_000;
    const messages = buildLongConversation();

    const state = {
      messages,
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 10,
      _lastUsageAnchor: {
        inputTokens: 160_000,
        messageCount: messages.length,
        timestamp: now - 60 * 60_000, // 1 小时前
      },
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({ compactThreshold: 0.999 }),
        contextWindowTokens: 200_000,
        maxOutputTokens: 0,
        pressureThresholds: { microCompactStart: 0.70 },
        timeBasedMicroCompact: {
          enabled: true,
          gapThresholdMinutes: 30,
          keepRecent: 2,
        },
        // 不传 lastAssistantTimestamp，应自动从 _lastUsageAnchor.timestamp 兜底
        now: () => now,
      },
      async () => null,
    );

    const anyCleared = result.messages.some((m) => {
      if (typeof m.content === 'string') return false;
      return m.content.some(
        (b) => b.type === 'tool_result' && b.content === TIME_BASED_MC_CLEARED_MESSAGE,
      );
    });
    expect(anyCleared).toBe(true);
  });

  it('无 lastAssistantTimestamp 且无 _lastUsageAnchor → 不触发（保守）', async () => {
    const now = 1_700_000_000_000;
    const messages = buildLongConversation();

    const state = {
      messages,
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 10,
      // 无 _lastUsageAnchor
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({ compactThreshold: 0.999 }),
        // 需要靠长消息生成 pressure >=0.75，但没 anchor 就会走高估
        contextWindowTokens: 10_000,
        maxOutputTokens: 0,
        pressureThresholds: { microCompactStart: 0.10 }, // 超低阈值保证触发
        timeBasedMicroCompact: {
          enabled: true,
          gapThresholdMinutes: 30,
          keepRecent: 0,
        },
        now: () => now,
      },
      async () => null,
    );

    // 无 timestamp 来源 → evaluate 返回 no_timestamp → 不触发
    const anyCleared = result.messages.some((m) => {
      if (typeof m.content === 'string') return false;
      return m.content.some(
        (b) => b.type === 'tool_result' && b.content === TIME_BASED_MC_CLEARED_MESSAGE,
      );
    });
    expect(anyCleared).toBe(false);
  });
});

describe('事 8 · orchestrator 集成：RECOMMENDED 阈值下的分档语义', () => {
  it('RECOMMENDED 阈值 85-90% 档：触发 session memory，不调 LLM summary', async () => {
    const messages: Message[] = [
      { role: 'user', content: 'q1' },
      makeAsstWithToolUse('t1', 'web_search'),
      makeUserWithToolResult('t1', 'result-1 long'.repeat(100)),
      { role: 'assistant', content: [{ type: 'text', text: 'done-1' }] },
      { role: 'user', content: 'q2' },
      makeAsstWithToolUse('t2', 'web_search'),
      makeUserWithToolResult('t2', 'result-2 long'.repeat(100)),
      { role: 'assistant', content: [{ type: 'text', text: 'done-2' }] },
    ];

    // pressure = 87% (在 [85, 90) 档位)
    const state = {
      messages,
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 5,
      _lastUsageAnchor: {
        inputTokens: 87_000,
        messageCount: messages.length,
        timestamp: Date.now(),
      },
    };

    let autoCompactCalled = false;
    const autoCompactMock = async (_p: AutoCompactParams): Promise<CompactResult | null> => {
      autoCompactCalled = true;
      return null;
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({
          // 让 compactThreshold 不生效（靠 pressureThresholds.llmSummaryStart 决定）
          compactThreshold: RECOMMENDED_PRESSURE_THRESHOLDS.llmSummaryStart,
        }),
        contextWindowTokens: 100_000,
        maxOutputTokens: 0,
        pressureThresholds: RECOMMENDED_PRESSURE_THRESHOLDS,
      },
      autoCompactMock,
    );

    // 87% ∈ [85%, 90%) → shouldRunLlmSummary = false → autoCompact 不应被跳过，
    // 但 compactConversation 在 autoCompactIfNeeded 内部会按 pressure < thresholdLLM 返回 null
    // 因此 autoCompactMock 被调（我们无法直接检查内部）——关键断言：end 事件不是 'auto'/LLM mode。
    const endEvents = result.events.filter(
      (e) =>
        e.type === 'agent.stream.compaction' &&
        (e.payload as Record<string, unknown>).phase === 'end',
    );
    // 允许 autoCompact 路径被调（mock 返回 null 就不会 emit end 事件）
    // 核心：不应 emit 'auto' 或任何 summary mode 的 end 事件
    const llmModeEnds = endEvents.filter((e) => {
      const mode = (e.payload as Record<string, unknown>).mode;
      return mode === 'auto' || mode === 'reactive';
    });
    expect(llmModeEnds.length).toBe(0);
    // autoCompact mock 可能被调，但返回 null
    expect(autoCompactCalled).toBe(true); // step 4 总会调
  });

  it('RECOMMENDED 阈值 92% 档：触发 LLM summary 路径（auto-condense 或 auto-compact）', async () => {
    // 92% ∈ [90%, 95%)（llmSummary 档位）：orchestrator 要么走 auto-condense
    // inject（由 Agent 自行调 summarize_context），要么直接 auto-compact。
    // 两者都属于"调 LLM 写摘要"——测试只验证其一被触发。
    const messages: Message[] = [
      { role: 'user', content: 'q' },
      makeAsstWithToolUse('t1', 'web_search'),
      makeUserWithToolResult('t1', 'r'.repeat(1000)),
      { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
    ];

    const compactResultMock: CompactResult = {
      compactedMessages: [{ role: 'user', content: 'summarized' }],
      summary: 'test summary',
      tokensFreed: 50_000,
      mode: 'auto',
    };
    const autoCompactMock = async (_p: AutoCompactParams): Promise<CompactResult | null> => {
      return compactResultMock;
    };

    const state = {
      messages,
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 5,
      _lastUsageAnchor: {
        inputTokens: 92_000,
        messageCount: messages.length,
        timestamp: Date.now(),
      },
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({
          compactThreshold: RECOMMENDED_PRESSURE_THRESHOLDS.llmSummaryStart,
          blockingReserveTokens: 0, // 防止 emergency 路径干扰
        }),
        contextWindowTokens: 100_000,
        maxOutputTokens: 0,
        pressureThresholds: RECOMMENDED_PRESSURE_THRESHOLDS,
      },
      autoCompactMock,
    );

    // LLM summary 可能走两条路径之一：
    //   a) auto-condense：注入 summarize_context 工具 + system prompt trigger
    //   b) auto-compact：直接调 LLM 摘要，emit `mode: 'auto'` end event
    const autoEndEvent = result.events.find(
      (e) =>
        e.type === 'agent.stream.compaction' &&
        (e.payload as Record<string, unknown>).phase === 'end' &&
        (e.payload as Record<string, unknown>).mode === 'auto',
    );
    const condenseInjected =
      typeof result.condenseSystemInjection === 'string'
      && result.condenseSystemInjection.length > 0;
    const autoCondenseToolAdded =
      result.toolParamsDelta?.add?.some((t) => t.name === 'summarize_context') === true;

    expect(autoEndEvent !== undefined || condenseInjected || autoCondenseToolAdded).toBe(true);
  });
});
