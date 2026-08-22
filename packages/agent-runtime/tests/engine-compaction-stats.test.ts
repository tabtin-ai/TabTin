/**
 * FR-11 — 压缩前后快照字段（messages_before/after + tokens_before/after +
 * tool_uses_retained）。
 *
 * 直接调 `runCompactionPhase` 三路径覆盖：
 *   1. reactive — `state.pendingCondenseSummary` 已存在
 *   2. auto — `autoCompact` 返回 result（pressure ≥ compactThreshold）
 *   3. emergency_blocking — auto 完成后仍超 blocking 阈值
 *
 * 加上 `recovery_413` / `hard_trim` 两个 query.ts 路径（API 消费者 Review M1
 * 修复后字段命名应统一 snake_case），共 5 路径。
 *
 * 每路径验证 stats 含三类字段，且数值合理。
 */

import { describe, it, expect } from 'vitest';
import {
  runCompactionPhase,
  initOrchestratorState,
} from '../src/compact/compaction-orchestrator.js';
import { createRuntime } from '../src/runtime-assembly.js';
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  CompactResult,
  AutoCompactParams,
  ContextBudget,
} from '../src/engine/contracts/context-capability.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';
import {
  DEFAULT_CONTEXT_BUDGET,
} from '../src/engine/contracts/context-capability.js';

async function collectEventsSafe(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  try {
    for await (const event of gen) {
      events.push(event);
    }
  } catch {
    /* terminate after recovery exhausted */
  }
  return events;
}

function makeRuntimeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test-fr11', threadId: 'test-fr11' },
    model: 'test-model',
    ...overrides,
  };
}

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

function makeAssistantWithToolUse(id: string, name: string): Message {
  return {
    role: 'assistant',
    content: [
      { type: 'text', text: 'using tool' },
      { type: 'tool_use', id, name, input: { arg: 'x' } },
    ],
  };
}

function makeUserWithToolResult(id: string, content: string): Message {
  return {
    role: 'user',
    content: [{ type: 'tool_result', tool_use_id: id, content }],
  };
}

interface MockState {
  messages: Message[];
  model: string;
  systemPrompt: string;
  iteration: number;
  pendingCondenseSummary?: string;
  _condenseInProgress?: unknown;
  _lastUsageAnchor?: unknown;
  __compactionForce?: unknown;
  __tokenWarningState?: unknown;
  [key: string]: unknown;
}

function makeBudget(overrides: Partial<ContextBudget> = {}): ContextBudget {
  const base = { ...DEFAULT_CONTEXT_BUDGET, ...overrides };
  // 测试常用 compactThreshold: 0.999 压制 auto-compact——emergencyThreshold
  // 必须跟着 bump 保严格递增，否则 resolvePressureThresholds 会 warn 并回落
  // DEFAULT（0.85），压制意图被静默破坏（与 orchestrator-time-based-integration
  // 的 makeBudget 同款处理）。
  if (base.compactThreshold >= base.emergencyThreshold) {
    base.emergencyThreshold = Math.min(1.0, base.compactThreshold + 0.001);
  }
  return base;
}

describe('FR-11 — compaction stats fields', () => {
  it('reactive — stats 含 messages/tokens/tool_uses + summary_length', async () => {
    const summaryText = 'A condensed summary covering everything that happened so far in the conversation.';
    const state: MockState = {
      messages: [
        makeMessage('user', 'first user'),
        makeAssistantWithToolUse('tu1', 'read_file'),
        makeUserWithToolResult('tu1', 'tool output 1'),
        makeAssistantWithToolUse('tu2', 'write_file'),
        makeUserWithToolResult('tu2', 'tool output 2'),
        makeMessage('assistant', 'final assistant turn'),
      ],
      model: 'test-model',
      systemPrompt: 'system',
      iteration: 5,
      pendingCondenseSummary: summaryText,
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({ compactThreshold: 0.999 }), // 让 evaluate condense 不触发，避免抢占 step 4
        contextWindowTokens: 1_000_000, // 高阈值，避免 step 4/5 被 auto/blocking 介入
      },
      // mock autoCompact 不会被调用（reactive 路径已先消费 summary）
      async () => null,
    );

    const compactionEvents = result.events.filter(
      (e) => e.type === 'agent.stream.compaction',
    );
    expect(compactionEvents.length).toBeGreaterThanOrEqual(2); // start + end

    const endEvent = compactionEvents.find(
      (e) => (e.payload as Record<string, unknown>).phase === 'end',
    );
    expect(endEvent).toBeDefined();
    const payload = endEvent!.payload as Record<string, unknown>;
    expect(payload.mode).toBe('reactive');

    const stats = payload.stats as Record<string, unknown>;
    expect(stats).toBeDefined();
    expect(typeof stats.messages_before).toBe('number');
    expect(typeof stats.messages_after).toBe('number');
    expect(typeof stats.tokens_before).toBe('number');
    expect(typeof stats.tokens_after).toBe('number');
    expect(typeof stats.tokens_freed).toBe('number');
    expect(typeof stats.tool_uses_retained).toBe('number');
    expect(typeof stats.summary_length).toBe('number');

    // 数值合理性：reactive 是把消息替换为"summary + 尾部"，应该减少消息数
    expect(stats.messages_before).toBe(6);
    // reactive 保留尾部直到上一个 assistant，所以 messages_after >= 1
    expect(stats.messages_after as number).toBeGreaterThanOrEqual(1);
    expect(stats.messages_after as number).toBeLessThan(stats.messages_before as number);
    expect(stats.tokens_freed as number).toBeGreaterThanOrEqual(0);
    expect(stats.summary_length).toBe(summaryText.length);
  });

  it('auto — stats 含 messages/tokens/tool_uses，无 summary_length', async () => {
    // 让 pressure 不触发 evaluate condense（compactThreshold 设很高），
    // 但 step 4 仍然走 autoCompact mock —— 这是 step 4 无条件调用的设计。
    const state: MockState = {
      messages: [
        makeMessage('user', 'q1'),
        makeAssistantWithToolUse('a1', 'read_file'),
        makeUserWithToolResult('a1', 'r1'),
        makeAssistantWithToolUse('a2', 'write_file'),
        makeUserWithToolResult('a2', 'r2'),
        makeMessage('assistant', 'tail'),
      ],
      model: 'test-model',
      systemPrompt: 'system',
      iteration: 3,
    };

    // mock autoCompact 返回压缩结果
    const compactResult: CompactResult = {
      compactedMessages: [
        makeMessage('user', 'compressed'),
        makeAssistantWithToolUse('a2', 'write_file'),
        makeUserWithToolResult('a2', 'short'),
      ],
      summary: 'auto summary',
      tokensFreed: 50_000,
      mode: 'auto',
    };
    const autoCompactMock = async (_params: AutoCompactParams): Promise<CompactResult | null> => {
      return compactResult;
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({ compactThreshold: 0.999, blockingReserveTokens: 0 }), // 不触发 condense / blocking
        contextWindowTokens: 1_000_000,
      },
      autoCompactMock,
    );

    const endEvent = result.events.find(
      (e) =>
        e.type === 'agent.stream.compaction' &&
        (e.payload as Record<string, unknown>).phase === 'end' &&
        (e.payload as Record<string, unknown>).mode === 'auto',
    );
    expect(endEvent).toBeDefined();
    const stats = (endEvent!.payload as Record<string, unknown>).stats as Record<string, unknown>;
    expect(stats).toBeDefined();
    expect(typeof stats.messages_before).toBe('number');
    expect(typeof stats.messages_after).toBe('number');
    expect(typeof stats.tokens_before).toBe('number');
    expect(typeof stats.tokens_after).toBe('number');
    expect(stats.tokens_freed).toBe(50_000);
    expect(typeof stats.tool_uses_retained).toBe('number');
    // auto 路径不带 summary_length
    expect(stats.summary_length).toBeUndefined();

    // tool_uses_retained 应该等于 compactResult.compactedMessages 中的 tool_use 数量（=1）
    expect(stats.tool_uses_retained).toBe(1);
  });

  it('emergency_blocking — auto 完成后仍超 blocking 阈值，emergency 路径 emit 完整 stats', async () => {
    // 思路：避开 evaluateAutoCondense（compactThreshold 高），让 step 4 调一次 autoCompact
    // 返回小压缩；step 5 仍触发 blocking → 第二次调 autoCompact 返回激进压缩，标记
    // 为 emergency_blocking。
    const state: MockState = {
      messages: [
        makeMessage('user', 'q1'),
        makeAssistantWithToolUse('e1', 'read'),
        makeUserWithToolResult('e1', 'r1'),
      ],
      model: 'test-model',
      systemPrompt: 'system',
      iteration: 8,
    };

    // 第一次 auto 返回 small reduction（不足以让 postCompact 低于 blocking limit），
    // 第二次（emergency 路径）再返回更激进的压缩。
    let callIdx = 0;
    const autoCompactMock = async (_params: AutoCompactParams): Promise<CompactResult | null> => {
      callIdx++;
      if (callIdx === 1) {
        return {
          compactedMessages: state.messages.slice(),
          summary: 'partial',
          tokensFreed: 100,
          mode: 'auto',
        };
      }
      // emergency 调用：消息只剩 1 条 user，无 tool_use
      return {
        compactedMessages: [makeMessage('user', 'tiny')],
        summary: 'emergency',
        tokensFreed: 1_000_000,
        mode: 'emergency_blocking',
      };
    };

    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      {
        budget: makeBudget({
          compactThreshold: 0.999, // 不触发 evaluate condense
          emergencyThreshold: 0.99,
          blockingReserveTokens: 10_000_000, // 让 blockingLimit < 0 → 一定触发 blocking
        }),
        contextWindowTokens: 200_000,
      },
      autoCompactMock,
    );

    expect(callIdx).toBe(2); // 确认 step 4 + step 5 各调一次
    const emergencyEnd = result.events.find(
      (e) =>
        e.type === 'agent.stream.compaction' &&
        (e.payload as Record<string, unknown>).phase === 'end' &&
        (e.payload as Record<string, unknown>).mode === 'emergency_blocking',
    );
    expect(emergencyEnd).toBeDefined();
    const stats = (emergencyEnd!.payload as Record<string, unknown>).stats as Record<string, unknown>;
    expect(stats).toBeDefined();
    expect(typeof stats.messages_before).toBe('number');
    expect(typeof stats.messages_after).toBe('number');
    expect(typeof stats.tokens_before).toBe('number');
    expect(typeof stats.tokens_after).toBe('number');
    expect(typeof stats.tokens_freed).toBe('number');
    expect(typeof stats.tool_uses_retained).toBe('number');

    // emergency 之后只有 1 条 user message，没 tool_use
    expect(stats.tool_uses_retained).toBe(0);
    expect(stats.messages_after).toBe(1);
  });

  it('reactive — tool_uses_retained 真实计数（保留 1 个 tool_use 时为 1）', async () => {
    const state: MockState = {
      messages: [
        makeMessage('user', 'q'),
        makeAssistantWithToolUse('t1', 'read'),
        makeUserWithToolResult('t1', 'r1'),
        makeAssistantWithToolUse('t2', 'write'),
        makeUserWithToolResult('t2', 'r2'),
      ],
      model: 'test-model',
      systemPrompt: 's',
      iteration: 1,
      pendingCondenseSummary: 'a'.repeat(150),
    };
    const orchestratorState = initOrchestratorState();
    const result = await runCompactionPhase(
      state,
      orchestratorState,
      { budget: makeBudget({ compactThreshold: 0.999 }), contextWindowTokens: 1_000_000 },
      async () => null,
    );

    const endEvent = result.events.find(
      (e) =>
        e.type === 'agent.stream.compaction' &&
        (e.payload as Record<string, unknown>).phase === 'end',
    );
    const stats = (endEvent!.payload as Record<string, unknown>).stats as Record<string, unknown>;

    // reactive 保留尾部直到上一个 assistant：
    // 倒序遇到 user (t2 result)、assistant (write tool_use) → 保留 [tool_use t2, tool_result t2]
    // 加上 summary message → final messages = [summary user, assistant tool_use t2, user tool_result t2]
    // tool_use 计数 = 1
    expect(stats.tool_uses_retained).toBe(1);
  });
});

/**
 * H2-B 验收要求"三种 mode" 实指 PRD §5.2 FR-11 列出的 reactive / auto / emergency_blocking
 * 三个 orchestrator 路径，**已**在上面覆盖。
 *
 * query.ts 的 `recovery_413` / `hard_trim` 是 413 错误恢复的两个独立路径，
 * 字段命名口径必须与 orchestrator 三路径一致（snake_case +
 * messages_before/after + tokens_before/after + tokens_freed +
 * tool_uses_retained），否则前端 `normalizeCompactionStats` 在 5 mode
 * 下展示不一致。
 *
 * 这里用真 `runQuery` + mock provider（抛 413）走 query.ts catch 路径。
 *
 * 由于 `createRuntime` 内部封装了 `createDefaultQueryDeps`，本测试无法直接
 * inject mock autoCompact——所以用最小消息的 prompt 让 `autoCompactIfNeeded`
 * 自然返回 null（无可压缩内容）→ recovery_413 第一阶段 `compactSucceeded=false`
 * → 自动 fall through 到 hard_trim 第二阶段。这覆盖：
 *   - hard_trim mode 字段填充正确性（messages_before/after + tokens_before/after
 *     + tokens_freed + tool_uses_retained）
 *   - snake_case 命名一致性（前端 normalizeCompactionStats 只认 snake_case）
 *   - 5 个 mode 字段集合完全一致——前端按统一 normalizer 展示
 *
 * recovery_413 成功路径（autoCompact 返回非 null）的字段填充由 query.ts
 * 共享同一 `tokenEstimator.estimateMessages` helper 保证；此处不重复构造场景。
 */
describe('FR-11 — query.ts 413 recovery 路径快照字段', () => {
  it('hard_trim — 413 时 autoCompact+truncateHead 都不够 fall through 到 hardTrim，stats 含全部 5 字段（messages/tokens/tool_uses）且 snake_case', async () => {
    let llmCalls = 0;
    const provider = {
      async *createStream(): AsyncIterable<LLMResponseChunk> {
        llmCalls++;
        if (llmCalls <= 3) {
          // 三次 413: 1→autoCompact(null)→truncateHead, 2→truncateHead done but still PTL, 3→hardTrim
          const err: Error & { status?: number } = new Error('prompt is too long');
          err.status = 413;
          throw err;
        }
        // 第四次（hard_trim 后重试）正常返回
        yield { type: 'text_delta', text: 'after hard trim' };
        yield { type: 'stop', stopReason: 'end_turn' };
      },
    };

    const rt = createRuntime(
      makeRuntimeConfig({
        provider,
        maxTurns: 10,
      }),
    );
    const events = await collectEventsSafe(rt.query({ hostRunId: 'test-run', prompt: 'tiny' }));

    // 期望走 R1 四级链：autoCompact null → truncateHead → hardTrim → emit hard_trim
    const hardTrim = events.find(
      (e) =>
        e.type === 'agent.stream.compaction' &&
        (e.payload as Record<string, unknown>).phase === 'end' &&
        (e.payload as Record<string, unknown>).mode === 'hard_trim',
    );
    expect(hardTrim).toBeDefined();

    const stats = (hardTrim!.payload as Record<string, unknown>).stats as Record<string, unknown>;
    expect(stats).toBeDefined();
    // FR-11 全字段集合（与 orchestrator 三路径完全对齐）：
    expect(typeof stats.messages_before).toBe('number');
    expect(typeof stats.messages_after).toBe('number');
    expect(typeof stats.tokens_before).toBe('number');
    expect(typeof stats.tokens_after).toBe('number');
    expect(typeof stats.tokens_freed).toBe('number');
    expect(typeof stats.tool_uses_retained).toBe('number');

    // tokens_freed 不能为负（hard_trim 一定减少 token，至少 0）
    expect(stats.tokens_freed as number).toBeGreaterThanOrEqual(0);
    // tokens_after ≤ tokens_before（hard_trim 一定不增加 token）
    expect(stats.tokens_after as number).toBeLessThanOrEqual(stats.tokens_before as number);

    // 字段命名必须 snake_case（前端 normalizeCompactionStats 只认 snake_case）。
    // 历史 query.ts 曾经写过 camelCase `tokensFreed`/`toolUsesRetained`——
    // 保留这几行作为回归看护，避免命名漂移再发生。
    expect(stats.tokensFreed).toBeUndefined();
    expect(stats.toolUsesRetained).toBeUndefined();
    expect(stats.tokensBefore).toBeUndefined();
    expect(stats.tokensAfter).toBeUndefined();
  });
});

describe('countToolUses helper', () => {
  it('在多种消息形态下计数正确', async () => {
    const { countToolUses } = await import('../src/compact/compaction-orchestrator.js');
    expect(countToolUses([])).toBe(0);
    expect(countToolUses([makeMessage('user', 'plain')])).toBe(0);
    expect(
      countToolUses([
        makeAssistantWithToolUse('a1', 'read'),
        makeUserWithToolResult('a1', 'r1'),
      ]),
    ).toBe(1);
    expect(
      countToolUses([
        makeAssistantWithToolUse('a1', 'read'),
        makeAssistantWithToolUse('a2', 'write'),
        makeMessage('user', 'plain'),
      ]),
    ).toBe(2);
    // string content 路径
    expect(countToolUses([{ role: 'user', content: 'x'.repeat(100) }])).toBe(0);
  });
});
