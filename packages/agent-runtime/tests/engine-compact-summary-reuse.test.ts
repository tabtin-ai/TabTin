/**
 * FR-16 H3-B — Compact summary reuse tests.
 *
 * 6 大场景（PRD §5.2 验收标准 + Q4 决策）：
 *   1. 首次 compact 走全量、把 summary 缓存到 CompactionOrchestratorState.lastSummary。
 *   2. 第二次 compact 走 reuse 路径，prompt 中含前次 summary（PRIOR_SUMMARY）。
 *   3. judge 评分窗口低于阈值后**下一次** compact 自动 fallback_full。
 *   4. reuse 后主循环 normalizeMessages 仍生效（不被 reuse 跳过）。
 *   5. 用 fixture 数据验证 token 节省 ≥ 30%。
 *   6. 跨 session（不同 orchestrator state 实例）lastSummary 不串。
 *
 * 测试设计：
 * - 直接调 `compactConversation` 验证 reuse 行为（不走 LLM 真路径）。
 * - 通过 `runCompactionPhase` + mock autoCompact 验证 orchestrator 整合行为
 *   （含埋点、judge 采样、cache 写入）。
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  compactConversation,
} from '../src/compact/compact.js';
import {
  appendJudgeScoreAndCheckFallback,
  shouldSampleJudge,
  parseJudgeScore,
} from '../src/compact/summary-judge.js';
import {
  runCompactionPhase,
  initOrchestratorState,
} from '../src/compact/compaction-orchestrator.js';
import { TokenEstimator, estimateTokens } from '../src/engine/context/token-budget.js';
import {
  setTelemetrySink,
  resetTelemetrySink,
} from '../src/telemetry/emitter.js';
import { TelemetryEvents } from '../src/telemetry/events.js';
import type { TelemetryRecord } from '../src/telemetry/types.js';
import type {
  Message,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  AutoCompactParams,
  CompactResult,
  ContextBudget,
  SummaryReuseEntry,
  SummaryReuseStats,
} from '../src/engine/contracts/context-capability.js';
import type {
  EngineState,
} from '../src/engine/contracts/kernel.js';
import {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_SUMMARY_REUSE_JUDGE_WINDOW_SIZE,
  DEFAULT_SUMMARY_REUSE_JUDGE_THRESHOLD,
} from '../src/engine/contracts/context-capability.js';

// ─── Test helpers ────────────────────────────────────────────────────

function makeMessage(role: 'user' | 'assistant', text: string): Message {
  return { role, content: text };
}

/**
 * Mock callModel：
 * - 记录每次 LLM 输入（system + messages 拼成的 char count，作 tokens 代理）。
 * - 返回固定的 summary 文本。
 *
 * 测试中我们用"输入字符总数"作为 token 输入消耗代理（与 estimateTokens 趋势一致），
 * 这样可以无网络验证 reuse 是否在节省"喂 LLM 的体积"。
 */
function makeRecordingCallModel(summary: string): {
  callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  callLog: { inputChars: number[]; systemChars: number[]; messages: Message[][]; systems: string[] };
} {
  const callLog = { inputChars: [] as number[], systemChars: [] as number[], messages: [] as Message[][], systems: [] as string[] };
  const callModel = (req: LLMRequest): AsyncIterable<LLMResponseChunk> => {
    const sys = typeof req.system === 'string'
      ? req.system
      : req.system?.map((b) => b.text).join('\n') ?? '';
    const msgChars = req.messages.reduce((sum, m) => {
      if (typeof m.content === 'string') return sum + m.content.length;
      return sum + m.content.reduce((s, b) => {
        if (b.type === 'text') return s + b.text.length;
        if (b.type === 'thinking') return s + b.thinking.length;
        if (b.type === 'tool_use') return s + JSON.stringify(b.input ?? {}).length + b.name.length;
        if (b.type === 'tool_result') return s + (typeof b.content === 'string' ? b.content.length : 0);
        return s;
      }, 0);
    }, 0);
    callLog.inputChars.push(msgChars);
    callLog.systemChars.push(sys.length);
    callLog.messages.push(req.messages);
    callLog.systems.push(sys);
    return (async function* () {
      yield { type: 'text_delta' as const, text: summary };
      yield { type: 'stop' as const, stopReason: 'end_turn' as const };
    })();
  };
  return { callModel, callLog };
}

/** 构造一段够长的对话（≥ 12 turns，每条 ~200 chars）让 compact 真的有内容可压缩。 */
function makeLongConversation(rounds: number, prefix: string): Message[] {
  const out: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    out.push(makeMessage('user', `${prefix} user-q-${i}: ${'x'.repeat(200)}`));
    out.push(makeMessage('assistant', `${prefix} assistant-a-${i}: ${'y'.repeat(200)}`));
  }
  return out;
}

const NINE_SECTION_SUMMARY = [
  '1. **User Requests**: Implement FR-16 reuse',
  '2. **Key Decisions**: Default enabled, judge sampling 5%',
  '3. **Files & Code**: compact.ts, summary-judge.ts',
  '4. **Tool Results**: read_file ok, write_file ok',
  '5. **Errors & Fixes**: none so far',
  '6. **Current Status**: Implementing tests',
  '7. **Next Steps**: integration test',
  '8. **Active Files State**: compact.ts modified',
  '9. **Important Context**: PRD §5.2 FR-16',
].join('\n');

const NINE_SECTION_SUMMARY_V2 = [
  '1. **User Requests**: Implement FR-16 reuse + integration test',
  '2. **Key Decisions**: Default enabled, judge sampling 5%, fallback after 100 samples avg < 0.85',
  '3. **Files & Code**: compact.ts, summary-judge.ts, compaction-orchestrator.ts',
  '4. **Tool Results**: read_file ok, write_file ok, integration test passed',
  '5. **Errors & Fixes**: none',
  '6. **Current Status**: Tests green',
  '7. **Next Steps**: ship to RC3',
  '8. **Active Files State**: compact.ts modified, tests added',
  '9. **Important Context**: PRD §5.2 FR-16 + Q4 decision',
].join('\n');

beforeEach(() => {
  resetTelemetrySink();
});

afterEach(() => {
  resetTelemetrySink();
});

// ─── Scenario 1 + 2: First full → cache → second reuse ──────────────

describe('FR-16 — compactConversation reuse path', () => {
  it('scenario 1: 首次 compact 走全量并返回 fallbackReason="no_previous_summary"', async () => {
    const messages = makeLongConversation(8, 'first');
    const { callModel, callLog } = makeRecordingCallModel(NINE_SECTION_SUMMARY);

    const result = await compactConversation({
      messages,
      systemPrompt: 'system prompt original',
      model: 'test-model',
      callModel,
      keepLastN: 2,
    });

    expect(result.summary).toBe(NINE_SECTION_SUMMARY);
    expect(result.reuseInfo).toBeDefined();
    expect(result.reuseInfo?.reused).toBe(false);
    expect(result.reuseInfo?.fallbackReason).toBe('no_previous_summary');
    expect(callLog.systems).toHaveLength(1);
    // 缓存友好全量路径：system 保持原始 prompt 不变（复用常规调用
    // 缓存前缀），摘要指导词改放在末尾 user 消息里。
    expect(callLog.systems[0]).toBe('system prompt original');
    expect(callLog.systems[0]).not.toContain('PRIOR_SUMMARY');
    const firstCallMsgs = callLog.messages[0] ?? [];
    const lastMsg = firstCallMsgs[firstCallMsgs.length - 1];
    const lastText = typeof lastMsg?.content === 'string' ? lastMsg.content : '';
    expect(lastText).toContain('对话摘要器');
  });

  it('scenario 2: 第二次 compact 走 reuse 路径，system prompt 含 PRIOR_SUMMARY', async () => {
    const messages = makeLongConversation(10, 'second');
    const previousSummary: SummaryReuseEntry = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now() - 1_000,
      msgsCovered: 10, // 之前已覆盖了前 10 条原始消息
      tokensCovered: 5_000,
    };

    const { callModel, callLog } = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);

    const result = await compactConversation({
      messages,
      systemPrompt: 'system prompt original',
      model: 'test-model',
      callModel,
      keepLastN: 2,
      previousSummary,
      enableSummaryReuse: true,
    });

    expect(result.reuseInfo?.reused).toBe(true);
    expect(result.reuseInfo?.coveredMsgsBefore).toBe(10);
    expect(result.reuseInfo?.coveredMsgsAfter).toBeGreaterThan(10);
    expect(result.reuseInfo?.msgsAdded).toBeGreaterThan(0);
    expect(result.reuseInfo?.previousAgeMs).toBeGreaterThanOrEqual(0);

    // System prompt 必须把 PRIOR_SUMMARY 嵌入
    expect(callLog.systems).toHaveLength(1);
    expect(callLog.systems[0]).toContain('PRIOR_SUMMARY');
    expect(callLog.systems[0]).toContain(NINE_SECTION_SUMMARY);
    expect(callLog.systems[0]).toContain('增量式');
    // user 末尾应该有 INCREMENTAL_COMPACT_USER_INSTRUCTION
    const lastMsg = callLog.messages[0]?.[callLog.messages[0].length - 1];
    expect(lastMsg?.role).toBe('user');
    if (typeof lastMsg?.content === 'string') {
      expect(lastMsg.content).toContain('更新后的摘要');
    }

    // Result summary 来自 LLM call
    expect(result.summary).toContain(NINE_SECTION_SUMMARY_V2);
  });

  it('scenario 5: token 节省 ≥ 30%（fixture 对比 reuse 输入 vs 全量输入）', async () => {
    // Fixture 设计原则：
    //   - previousSummary 已覆盖了大部分 oldMessages（msgsCovered=30 / 40）
    //   - 仅新增 10 条原始消息 + summary 文本本身 << 30 条原文
    //   - reuse 路径只送 [summary text + 10 新增] 给 LLM
    //   - 全量路径要送 [全部 40 条] 给 LLM
    //   - 期望节省比 ≥ 30%
    //
    // 关键：必须让 splitIdx > previousSummary.msgsCovered 才会走 reuse 命中
    // （否则触发 no_new_messages fallback）。findSplitPoint 在 40 条 messages
    // + keepLastN=2 时大致选到 idx=38 左右；msgsCovered=30 < 38 → 走 reuse。
    const oldMessages = makeLongConversation(20, 'old'); // 40 条
    const previousSummary: SummaryReuseEntry = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now(),
      msgsCovered: 30, // 前 30 条已被覆盖；splitIdx 会超过这个数
      tokensCovered: estimateTokens(oldMessages),
    };

    // ── reuse 调用 ──
    const reuseRecorder = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);
    const reuseResult = await compactConversation({
      messages: oldMessages,
      systemPrompt: 'sys',
      model: 'm',
      callModel: reuseRecorder.callModel,
      keepLastN: 2,
      previousSummary,
    });
    // 兜底：必须是真 reuse，否则节省断言无意义
    expect(reuseResult.reuseInfo?.reused).toBe(true);

    // ── 假想全量调用（同 messages 不传 previousSummary）──
    const fullRecorder = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);
    const fullResult = await compactConversation({
      messages: oldMessages,
      systemPrompt: 'sys',
      model: 'm',
      callModel: fullRecorder.callModel,
      keepLastN: 2,
    });
    expect(fullResult.reuseInfo?.reused).toBe(false);

    const reuseInputChars = (reuseRecorder.callLog.inputChars[0] ?? 0)
      + (reuseRecorder.callLog.systemChars[0] ?? 0);
    const fullInputChars = (fullRecorder.callLog.inputChars[0] ?? 0)
      + (fullRecorder.callLog.systemChars[0] ?? 0);

    expect(fullInputChars).toBeGreaterThan(reuseInputChars);
    const savedRatio = (fullInputChars - reuseInputChars) / fullInputChars;
    // PRD §3.1 O6：≥ 30% 节省
    expect(savedRatio).toBeGreaterThanOrEqual(0.3);
  });

  it('enableSummaryReuse=false 时永远走全量 + fallbackReason="disabled"', async () => {
    const previousSummary: SummaryReuseEntry = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now(),
      msgsCovered: 4,
      tokensCovered: 1_000,
    };

    const { callModel, callLog } = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);

    const result = await compactConversation({
      messages: makeLongConversation(8, 'disabled'),
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
      previousSummary,
      enableSummaryReuse: false,
    });

    expect(result.reuseInfo?.reused).toBe(false);
    expect(result.reuseInfo?.fallbackReason).toBe('disabled');
    // System prompt 不应嵌入 PRIOR_SUMMARY
    expect(callLog.systems[0]).not.toContain('PRIOR_SUMMARY');
  });

  it('forceFallbackReason="judge_window_fallback" 时走全量 + 标 reason', async () => {
    const previousSummary: SummaryReuseEntry = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now(),
      msgsCovered: 4,
      tokensCovered: 1_000,
    };

    const { callModel, callLog } = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);

    const result = await compactConversation({
      messages: makeLongConversation(8, 'forced'),
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
      previousSummary,
      enableSummaryReuse: true,
      forceFallbackReason: 'judge_window_fallback',
    });

    expect(result.reuseInfo?.reused).toBe(false);
    expect(result.reuseInfo?.fallbackReason).toBe('judge_window_fallback');
    expect(callLog.systems[0]).not.toContain('PRIOR_SUMMARY');
  });

  it('summaryReuseMaxAgeMs 超时 → fallbackReason="summary_too_old"', async () => {
    const previousSummary: SummaryReuseEntry = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now() - 60_000, // 1 分钟前
      msgsCovered: 4,
      tokensCovered: 1_000,
    };

    const { callModel } = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);

    const result = await compactConversation({
      messages: makeLongConversation(8, 'old-summary'),
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
      previousSummary,
      summaryReuseMaxAgeMs: 1_000, // 阈值仅 1s
    });

    expect(result.reuseInfo?.reused).toBe(false);
    expect(result.reuseInfo?.fallbackReason).toBe('summary_too_old');
  });

  it('previousSummary 存在但 splitIdx 没扩展 → no_new_messages', async () => {
    const messages = makeLongConversation(3, 'short'); // 6 条 -> splitIdx 大概是 4
    const previousSummary: SummaryReuseEntry = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now(),
      // 设大于 splitIdx 的 msgsCovered，让"无新增"分支命中
      msgsCovered: messages.length,
      tokensCovered: 1_000,
    };

    const { callModel } = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);

    const result = await compactConversation({
      messages,
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
      previousSummary,
    });

    expect(result.reuseInfo?.reused).toBe(false);
    expect(result.reuseInfo?.fallbackReason).toBe('no_new_messages');
  });
});

// ─── Scenario 3 + 6 + telemetry: orchestrator integration ──────────

interface MockState {
  messages: Message[];
  model: string;
  systemPrompt: string;
  iteration: number;
  pendingCondenseSummary?: string;
  _lastUsageAnchor?: unknown;
  __compactionForce?: unknown;
  __tokenWarningState?: unknown;
  [key: string]: unknown;
}

function makeBudget(overrides: Partial<ContextBudget> = {}): ContextBudget {
  return { ...DEFAULT_CONTEXT_BUDGET, ...overrides };
}

describe('FR-16 — runCompactionPhase reuse integration', () => {
  it('scenario 1+6: 首次 compact 走全量；第二次同 state 走 reuse；不同 state 不串', async () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((rec) => captured.push(rec));

    const orchestratorState = initOrchestratorState();
    const stateA: MockState = {
      messages: makeLongConversation(15, 'A'),
      model: 'test-model',
      systemPrompt: 'sys A',
      iteration: 1,
    };

    const compactResult1: CompactResult = {
      compactedMessages: [
        { role: 'user', content: '[对话摘要]\n\n' + NINE_SECTION_SUMMARY },
        ...makeLongConversation(2, 'kept'),
      ],
      summary: NINE_SECTION_SUMMARY,
      tokensFreed: 1_000,
      mode: 'auto',
      reuseInfo: { reused: false, fallbackReason: 'no_previous_summary' },
    };

    const autoCompactCalls: AutoCompactParams[] = [];
    const autoCompactMock = async (params: AutoCompactParams): Promise<CompactResult | null> => {
      autoCompactCalls.push(params);
      return autoCompactCalls.length === 1
        ? compactResult1
        : {
            compactedMessages: [
              { role: 'user', content: '[对话摘要]\n\n' + NINE_SECTION_SUMMARY_V2 },
              ...makeLongConversation(2, 'kept'),
            ],
            summary: NINE_SECTION_SUMMARY_V2,
            tokensFreed: 800,
            mode: 'auto',
            reuseInfo: {
              reused: true,
              previousAgeMs: 100,
              tokensSaved: 1_500,
              msgsAdded: 4,
              coveredMsgsBefore: 10,
              coveredMsgsAfter: 14,
            },
          };
    };

    // 首次：低 compactThreshold 让 step 4 一定触发。
    //
    // W3 (2026-05-10): the legacy auto-condense state machine used to set
    // `skipAutoCompact=true` on the first compact and let only Step 5
    // (emergency) call `autoCompact`. With auto-condense gone (W3), Step 4
    // runs first and Step 5's emergency arm would *also* fire because the
    // tiny `contextWindowTokens: 1000` setting leaves negative effective
    // budget after the default 16k output reserve. Set `maxOutputTokens: 100`
    // so `effectiveWindow ≈ 900 > postCompactTokens` and the emergency arm
    // skips — Step 4 alone produces the single autoCompact call this test
    // wants to inspect.
    const compactConfig = {
      budget: makeBudget({ compactThreshold: 0.001, blockingReserveTokens: 0 }),
      contextWindowTokens: 1_000,
      maxOutputTokens: 100,
    };
    const result1 = await runCompactionPhase(
      stateA,
      orchestratorState,
      compactConfig,
      autoCompactMock,
    );
    expect(result1.events.some((e) => e.type === 'agent.stream.compaction')).toBe(true);
    // 第一次调 autoCompact 时 previousSummary 应当未设
    expect(autoCompactCalls[0]?.previousSummary).toBeUndefined();
    // lastSummary 已被写入 orchestrator state（ 批次 8：不再挂 EngineState）
    expect(orchestratorState.lastSummary).toBeDefined();
    expect(orchestratorState.lastSummary?.content).toBe(NINE_SECTION_SUMMARY);

    // 准备第二次：换长 messages 让 splitIdx 扩展
    stateA.messages = [
      ...result1.messages,
      ...makeLongConversation(8, 'new-A'),
    ];
    stateA.iteration = 2;

    const result2 = await runCompactionPhase(
      stateA,
      orchestratorState,
      compactConfig,
      autoCompactMock,
    );
    expect(result2).toBeDefined();
    // 第二次调 autoCompact 时 previousSummary 应该有值
    expect(autoCompactCalls[1]?.previousSummary?.content).toBe(NINE_SECTION_SUMMARY);
    // lastSummary 已经被新 summary 覆盖
    expect(orchestratorState.lastSummary?.content).toBe(NINE_SECTION_SUMMARY_V2);

    // 跨 state 隔离：新 stateB 的首次 compact 应当走全量
    const stateB: MockState = {
      messages: makeLongConversation(15, 'B'),
      model: 'test-model',
      systemPrompt: 'sys B',
      iteration: 1,
    };
    const orchestratorStateB = initOrchestratorState();
    autoCompactCalls.length = 0;
    await runCompactionPhase(
      stateB,
      orchestratorStateB,
      compactConfig,
      autoCompactMock,
    );
    // 不应该看到 stateA 的 lastSummary 渗到 stateB（隔离靠新 orchestrator state 实例）
    expect(autoCompactCalls[0]?.previousSummary).toBeUndefined();

    // Telemetry：第二次 compact 应当有 summary_reused 事件
    const reusedRecords = captured.filter((r) => r.event_name === TelemetryEvents.COMPACT_SUMMARY_REUSED);
    expect(reusedRecords).toHaveLength(1);
    expect((reusedRecords[0]!.payload as Record<string, unknown>).msgs_added).toBe(4);
    expect((reusedRecords[0]!.payload as Record<string, unknown>).tokens_saved).toBe(1_500);
  });

  it('scenario 3: judge 评分窗口低于阈值后下次自动 fallback_full 并 reset 窗口', async () => {
    const captured: TelemetryRecord[] = [];
    setTelemetrySink((rec) => captured.push(rec));

    const orchestratorState = initOrchestratorState();
    const state: MockState = {
      messages: makeLongConversation(15, 'judge'),
      model: 'test-model',
      systemPrompt: 'sys',
      iteration: 1,
    };
    //  批次 8：reuse 记忆种在 orchestrator state（不再挂 EngineState）。
    orchestratorState.lastSummary = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now(),
      msgsCovered: 10,
      tokensCovered: 5_000,
    };

    // mock autoCompact 返回 reuse=true 结果
    const reuseAutoCompact = async (_params: AutoCompactParams): Promise<CompactResult | null> => ({
      compactedMessages: [
        { role: 'user', content: '[对话摘要]\n\n' + NINE_SECTION_SUMMARY_V2 },
        ...makeLongConversation(2, 'kept'),
      ],
      summary: NINE_SECTION_SUMMARY_V2,
      tokensFreed: 800,
      mode: 'auto',
      reuseInfo: {
        reused: true,
        previousAgeMs: 100,
        tokensSaved: 1_500,
        msgsAdded: 4,
        coveredMsgsBefore: 10,
        coveredMsgsAfter: 14,
      },
    });

    // mock judge 永远返回 0.5（< 0.85 threshold）
    const judgeFn = vi.fn().mockResolvedValue(0.5);

    // 用极小窗口（windowSize=2）让测试快速触发 fallback。
    // W3: same `maxOutputTokens: 100` workaround as scenario 1 above —
    // keep effectiveWindow positive so emergency Step 5 doesn't double up
    // with Step 4 (auto-condense state machine that used to gate this is
    // gone in W3, see compaction-orchestrator.ts file header).
    const orchConfig = {
      budget: makeBudget({ compactThreshold: 0.001, blockingReserveTokens: 0 }),
      contextWindowTokens: 1_000,
      maxOutputTokens: 100,
      enableSummaryReuse: true,
      summaryReuseJudgeSampleRate: 1, // 每次都采样
      summaryReuseJudgeWindowSize: 2,
      summaryReuseJudgeThreshold: 0.85,
      summaryReuseJudgeFn: judgeFn,
      // judge 需要 callModel/model 才会被触发
      callModel: (() => (async function* () { yield { type: 'stop' as const, stopReason: 'end_turn' as const }; })()) as unknown as (
        req: LLMRequest,
      ) => AsyncIterable<LLMResponseChunk>,
      model: 'test-model',
    };

    // 第 1 次 reuse + judge → score 0.5 写入窗口
    await runCompactionPhase(state, orchestratorState, orchConfig, reuseAutoCompact);
    expect(orchestratorState.reuseStats?.scores).toEqual([0.5]);
    expect(orchestratorState.reuseStats?.fallbackTriggered).toBe(false);

    // 第 2 次 reuse + judge → 窗口满 [0.5, 0.5]，平均 0.5 < 0.85 → fallbackTriggered=true，窗口 reset
    state.iteration = 2;
    state.messages = [...state.messages, ...makeLongConversation(2, 'more')];
    // 重新设置 lastSummary 让 reuse 路径再次准备命中（前次 result.summary 已写入了，模拟成新一轮）
    orchestratorState.lastSummary = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now(),
      msgsCovered: 10,
      tokensCovered: 5_000,
    };
    await runCompactionPhase(state, orchestratorState, orchConfig, reuseAutoCompact);
    expect(orchestratorState.reuseStats?.fallbackTriggered).toBe(true);
    expect(orchestratorState.reuseStats?.scores).toEqual([]); // reset

    // 第 3 次 compact → orchestrator 应该消耗 fallback 标记，传 forceFallbackReason='judge_window_fallback'
    state.iteration = 3;
    state.messages = [...state.messages, ...makeLongConversation(2, 'even-more')];
    const fallbackAutoCompact = vi.fn().mockResolvedValue({
      compactedMessages: [
        { role: 'user', content: '[对话摘要]\n\n' + NINE_SECTION_SUMMARY_V2 },
        ...makeLongConversation(2, 'kept'),
      ],
      summary: NINE_SECTION_SUMMARY_V2,
      tokensFreed: 1_000,
      mode: 'auto',
      reuseInfo: {
        reused: false,
        fallbackReason: 'judge_window_fallback',
        coveredMsgsBefore: 10,
        coveredMsgsAfter: 14,
      },
    });
    await runCompactionPhase(state, orchestratorState, orchConfig, fallbackAutoCompact);
    // autoCompact 第三次调用应当带 forceFallbackReason='judge_window_fallback'
    expect(fallbackAutoCompact.mock.calls[0]?.[0]?.forceFallbackReason).toBe('judge_window_fallback');
    // fallback 标记已被消费
    expect(orchestratorState.reuseStats?.fallbackTriggered).toBe(false);

    // Telemetry 总览
    const judgeScores = captured.filter((r) => r.event_name === TelemetryEvents.COMPACT_JUDGE_SCORE);
    expect(judgeScores).toHaveLength(2);
    expect((judgeScores[1]!.payload as Record<string, unknown>).fallback_triggered).toBe(true);
    const fallbackEvents = captured.filter((r) => r.event_name === TelemetryEvents.COMPACT_FALLBACK_FULL);
    // 第三次 compact 的 reuseInfo.fallbackReason='judge_window_fallback' 应该发 fallback_full
    expect(fallbackEvents.length).toBeGreaterThanOrEqual(1);
    expect((fallbackEvents[0]!.payload as Record<string, unknown>).reason).toBe('judge_window_fallback');
  });

  it('scenario 4: reuse 后 normalizeMessages 仍生效（compactConversation 输出 + 全主循环走 normalize）', async () => {
    // 这里我们不跑完整 createRuntime（重）。直接证明：
    //   1. compactConversation reuse 路径的输出 messagesAfter 仍然要走主循环里的 normalizeMessages（query.ts 行 1170 之后）。
    //   2. 我们可以独立 import normalizeMessages 验证它对 reuse 输出 messages 不抛错且不破坏。
    const { normalizeMessages } = await import('../src/engine/context/message-normalizer.js');

    const messages = makeLongConversation(8, 'norm');
    const previousSummary: SummaryReuseEntry = {
      content: NINE_SECTION_SUMMARY,
      generatedAt: Date.now(),
      msgsCovered: 8,
      tokensCovered: 2_000,
    };

    const { callModel } = makeRecordingCallModel(NINE_SECTION_SUMMARY_V2);
    const result = await compactConversation({
      messages: [...messages, makeMessage('user', 'extra'), makeMessage('assistant', 'reply')],
      systemPrompt: 'sys',
      model: 'm',
      callModel,
      keepLastN: 2,
      previousSummary,
    });
    expect(result.reuseInfo?.reused).toBe(true);

    // 把 reuse 输出再走 normalizeMessages（模拟主循环）：不应抛错，
    // 且 pairing_violations=0（compactConversation 自身会保 tool pairing）。
    const normResult = normalizeMessages(result.compactedMessages, { level: 'conservative' });
    expect(normResult.changes.pairing_violations).toBe(0);
    // 输出非空
    expect(normResult.messages.length).toBeGreaterThan(0);
  });
});

// ─── Standalone unit tests for summary-judge helpers ────────────────

describe('FR-16 — summary-judge helpers', () => {
  it('parseJudgeScore 兜底：JSON / regex / 越界 / NaN', () => {
    expect(parseJudgeScore('{"score": 0.92, "reason": "ok"}')).toBe(0.92);
    expect(parseJudgeScore('```json\n{"score":0.7,"reason":"x"}\n```')).toBe(0.7);
    expect(parseJudgeScore('Some prose. "score": 0.5 here.')).toBe(0.5);
    expect(parseJudgeScore('{"score": 1.5}')).toBeNull();
    expect(parseJudgeScore('{"score": "high"}')).toBeNull();
    expect(parseJudgeScore('garbage')).toBeNull();
    expect(parseJudgeScore('')).toBeNull();
  });

  it('shouldSampleJudge 边界：0 永不 / 1 永远', () => {
    expect(shouldSampleJudge(0)).toBe(false);
    expect(shouldSampleJudge(-0.1)).toBe(false);
    expect(shouldSampleJudge(NaN)).toBe(false);
    expect(shouldSampleJudge(1)).toBe(true);
    expect(shouldSampleJudge(1.5)).toBe(true);
    // 注入 rng=固定值
    expect(shouldSampleJudge(0.5, () => 0.4)).toBe(true);
    expect(shouldSampleJudge(0.5, () => 0.6)).toBe(false);
  });

  it('appendJudgeScoreAndCheckFallback 窗口未满不触发；满 + avg < threshold 触发并 reset', () => {
    let stats: SummaryReuseStats | undefined;
    let r = appendJudgeScoreAndCheckFallback({ stats, score: 0.5, windowSize: 3, threshold: 0.85 });
    expect(r.fallbackTriggered).toBe(false);
    expect(r.stats.scores).toEqual([0.5]);
    stats = r.stats;
    r = appendJudgeScoreAndCheckFallback({ stats, score: 0.6, windowSize: 3, threshold: 0.85 });
    expect(r.fallbackTriggered).toBe(false);
    expect(r.stats.scores).toEqual([0.5, 0.6]);
    stats = r.stats;
    r = appendJudgeScoreAndCheckFallback({ stats, score: 0.4, windowSize: 3, threshold: 0.85 });
    // 平均 = 0.5 < 0.85 → fallback + reset
    expect(r.fallbackTriggered).toBe(true);
    expect(r.stats.scores).toEqual([]);
    expect(r.stats.fallbackTriggered).toBe(true);
  });

  it('appendJudgeScoreAndCheckFallback 平均分 ≥ threshold 时不触发', () => {
    let stats: SummaryReuseStats | undefined;
    for (let i = 0; i < 3; i++) {
      const r = appendJudgeScoreAndCheckFallback({
        stats,
        score: 0.95,
        windowSize: 3,
        threshold: 0.85,
      });
      stats = r.stats;
      if (i === 2) expect(r.fallbackTriggered).toBe(false);
    }
    expect(stats?.scores.length).toBe(3);
  });

  it('windowSize 默认值与阈值默认值与 PRD 对齐', () => {
    expect(DEFAULT_SUMMARY_REUSE_JUDGE_WINDOW_SIZE).toBe(100);
    expect(DEFAULT_SUMMARY_REUSE_JUDGE_THRESHOLD).toBe(0.85);
  });
});

// ─── Estimator regression ───────────────────────────────────────────

describe('FR-16 — token saving sanity check', () => {
  it('estimateTokens(prior summary) << estimateTokens(40 messages original)', () => {
    const messages = makeLongConversation(20, 'sanity');
    const messagesTokens = estimateTokens(messages);
    const summaryTokens = estimateTokens([{ role: 'user', content: NINE_SECTION_SUMMARY }]);
    expect(summaryTokens).toBeLessThan(messagesTokens * 0.3);
  });

  it('TokenEstimator 计数稳定（不抖动）', () => {
    const est = new TokenEstimator();
    est.setModel('test-model');
    const messages = makeLongConversation(5, 'stable');
    const a = est.estimateMessages(messages);
    const b = est.estimateMessages(messages);
    expect(a).toBe(b);
  });
});
