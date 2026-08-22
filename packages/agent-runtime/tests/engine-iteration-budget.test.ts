/**
 * FR-15 — IterationBudget + Grace Call 集成测试。
 *
 * 验证 `query.ts` 主循环：
 *   1. iteration 通路 70/90/100 三档分别触发 warn / grace / terminate notice
 *      + telemetry 事件；
 *   2. token 通路 85/95/100 三档同上；
 *   3. grace 期 LLM request 的 tools 字段被强制清空 + system prompt 含
 *      "FINAL turn" / "do NOT" 指令；
 *   4. terminate 时 DONE event 字段满足 PRD §5.2 验收：
 *      - `error: false`（区别于 MAX_TURNS_EXCEEDED 等硬错误）
 *      - `error_class` 为 `iteration_budget_exhausted` /
 *        `token_budget_exhausted`
 *      - `suggested_action` 中文兜底文案
 *      - `trace_id` 与 lifecycle 同源
 *   5. IterationBudget 与 DoomLoop 的优先级：IterationBudget terminate 在
 *      轮初接管，DoomLoop 段不会执行；DoomLoop terminate 上一轮 break 后
 *      IterationBudget 本轮也不会进入。
 */

import { describe, it, expect, afterEach } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
// W2.3 (D-tech-6)：`createDoomLoopGuard` 整段砍出本期归后续 Harness 治理专题；
// 旧 `FR-15 IterationBudget × DoomLoop priority` describe 块（针对 doom-loop
// 与 iteration-budget 抢占路径）随之删除——doom-loop 消费分支已下线，断言
// `doom_loop_terminate` notice 不再有写入者。`FR-15 default` 段独立，保留。
import {
  createMockProvider,
  createMockPermissionHandler,
  createMockToolProvider,
} from './test-utils.js';
import { createTestToolRiskPolicyPort } from './helpers/tool-risk-policy-port.js';
import {
  setTelemetrySink,
  resetTelemetrySink,
} from '../src/telemetry/emitter.js';
import type { TelemetryRecord } from '../src/telemetry/types.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  SystemBlock,
} from '../src/engine/contracts/conversation.js';
import type {
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  Tool,
} from '../src/engine/contracts/tools.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';

// ─── helpers ─────────────────────────────────────────────────────────

async function collectEvents(
  gen: AsyncGenerator<StreamEvent>,
): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    // Hosts must wire toolRiskPolicy（ fail-closed）；测试桩放行。
    toolRiskPolicy: createTestToolRiskPolicyPort({
      buildEffectivePolicy: () => undefined,
      memoStore: { lookup: async () => undefined } as never,
    }),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    // 本文件专测 IterationBudget（warn/grace/terminate 三档）。驱动手法是让
    // mock provider 每轮重复调同一个 `noop`（相同 input）以快速堆迭代数；但这
    // 会命中「工具复读」doom-loop 护栏（terminate 默认 6，），在默认
    // 预算档位（grace 90% → iter 9+）尚未到达前就把 run 硬停成
    // `tool_loop_terminated`，抢占了本要验证的预算路径。护栏本身行为正确、
    // 且未被 /#6014 改动。阈值上限 TOOL_REPETITION_THRESHOLD_MAX=100，
    // 抬阈值也盖不住 15+ 轮驱动，故直接 enabled:false 隔离被测单元。
    toolRepetitionTracker: { enabled: false },
    ...overrides,
  };
}

function makeTool(name: string): Tool {
  return {
    name,
    description: `Test tool: ${name}`,
    inputSchema: { type: 'object', properties: { arg: { type: 'string' } } },
    isReadOnly: true,
    execute: async () => ({ content: 'ok' }),
  };
}

function noticesOfType(events: StreamEvent[], type: string): StreamEvent[] {
  return events.filter(
    (e) =>
      e.type === 'agent.stream.system_notice' &&
      (e.payload as Record<string, unknown>).notice_type === type,
  );
}

function findDone(events: StreamEvent[]): StreamEvent | undefined {
  return events.find((e) => e.type === 'agent.stream.done');
}

function findTerminalPersist(events: StreamEvent[]): StreamEvent | undefined {
  return events.find((e) =>
    e.type === 'agent.stream.persist_message'
    && (e.payload as Record<string, unknown>).stop_reason === 'error'
    && (e.payload as Record<string, unknown>).error_info_json != null,
  );
}

/**
 * Provider 重复输出 N 轮 tool_use 后给 final text，记录每轮看到的
 * `llmRequest.tools` 与 `system` 字段（grace 测试需要断言 tools 清空 +
 * system 含 "FINAL turn"）。
 */
interface CapturedRequest {
  tools: LLMRequest['tools'];
  system: LLMRequest['system'];
  iteration: number;
}

function capturingProvider(
  rounds: LLMResponseChunk[][],
  sink: { requests: CapturedRequest[] },
): LLMProvider {
  let i = 0;
  return {
    async *createStream(req: LLMRequest) {
      sink.requests.push({ tools: req.tools, system: req.system, iteration: i });
      const chunks = rounds[i] ?? rounds[rounds.length - 1]!;
      i++;
      for (const c of chunks) yield c;
    },
  };
}

function flattenSystemPrompt(
  s: string | SystemBlock[] | undefined,
): string {
  if (!s) return '';
  if (typeof s === 'string') return s;
  return s.map((b) => b.text).join('\n\n');
}

/** 多轮"调用工具+小 token usage"的 LLM 输出。 */
function toolThenTextRounds(
  toolRounds: number,
  finalText = 'final answer',
  tokensPerRound = 100,
): LLMResponseChunk[][] {
  const rounds: LLMResponseChunk[][] = [];
  for (let i = 0; i < toolRounds; i++) {
    rounds.push([
      { type: 'tool_use', toolUse: { id: `c${i}`, name: 'noop', input: {} } },
      {
        type: 'usage',
        usage: { input_tokens: tokensPerRound, output_tokens: tokensPerRound },
      },
      { type: 'stop', stopReason: 'tool_use' },
    ]);
  }
  rounds.push([
    { type: 'text_delta', text: finalText },
    {
      type: 'usage',
      usage: { input_tokens: tokensPerRound, output_tokens: tokensPerRound },
    },
    { type: 'stop', stopReason: 'end_turn' },
  ]);
  return rounds;
}

function withTelemetrySink<T>(
  fn: (sink: { records: TelemetryRecord[] }) => Promise<T>,
): Promise<T> {
  const sink = { records: [] as TelemetryRecord[] };
  setTelemetrySink((rec) => {
    sink.records.push(rec);
  });
  return fn(sink).finally(() => {
    resetTelemetrySink();
  });
}

afterEach(() => {
  resetTelemetrySink();
});

// ─── iteration channel — 70/90/100 ───────────────────────────────────

describe('FR-15 iteration channel — three thresholds', () => {
  it('warn at 70% iteration: emits notice + telemetry, run continues', async () => {
    // maxTurns=10 → warn 在 iteration=7 (70%)；模型每轮调一次 noop 工具，
    // 10 轮内不会 grace（grace 在 9）。中途到第 7 轮触发 warn。
    // 但 default grace=0.9 → 9 轮就 grace。设 maxTurns=20，warn=14 grace=18。
    const rounds = toolThenTextRounds(15); // 15 轮工具 + 1 轮 final = 16 round
    const sink = { requests: [] as CapturedRequest[] };
    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: capturingProvider(rounds, sink),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 20,
        }),
      );

      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      const warnNotices = noticesOfType(events, 'iteration_budget_warn');
      expect(warnNotices.length).toBe(1);
      expect((warnNotices[0]!.payload as Record<string, unknown>).trigger).toBe(
        'iteration',
      );
      // warn 应在 iteration=14 (70% × 20) 触发
      const warnTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.warn',
      );
      expect(warnTel).toBeTruthy();
      expect(warnTel!.payload.trigger).toBe('iteration');
      expect((warnTel!.payload.percent as number) >= 0.7).toBe(true);
      expect(warnTel!.payload.iteration_max).toBe(20);

      // 不应有 grace / terminate（rounds 在 grace 触发前完成）
      expect(noticesOfType(events, 'iteration_budget_grace').length).toBe(0);
      expect(noticesOfType(events, 'iteration_budget_terminate').length).toBe(
        0,
      );
    });
  });

  it('warn dedup: doesn\'t re-emit when stage stays at warn', async () => {
    const rounds = toolThenTextRounds(8);
    const sink = { requests: [] as CapturedRequest[] };
    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: capturingProvider(rounds, sink),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 20,
        }),
      );
      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));
      // 只 warn 一次
      expect(noticesOfType(events, 'iteration_budget_warn').length).toBeLessThanOrEqual(
        1,
      );
      const warnTel = telSink.records.filter(
        (r) => r.event_name === 'iteration_budget.warn',
      );
      expect(warnTel.length).toBeLessThanOrEqual(1);
    });
  });

  it('grace at 90% iteration: emits grace notice + tools cleared + DONE error_class iteration_budget_exhausted', async () => {
    // maxTurns=10 → grace 在 iteration=9。让前 8 轮工具 + 第 9 轮 grace 期 LLM final text。
    // rounds[8] 在 grace 期，会被强制 final 处理（即使 LLM 仍出 tool_use）。
    // 设计：前 9 轮都是 tool_use，第 10 轮 final——但实际 grace 在 9 触发，
    // 会忽略 tool_use 强制走 final（用 round[9] 的内容）。
    const rounds: LLMResponseChunk[][] = [];
    for (let i = 0; i < 9; i++) {
      rounds.push([
        { type: 'tool_use', toolUse: { id: `c${i}`, name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 50, output_tokens: 50 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
    }
    // 第 10 轮（grace 期）：LLM 仍尝试 tool_use + 一段总结文本
    rounds.push([
      { type: 'text_delta', text: 'summary text' },
      { type: 'tool_use', toolUse: { id: 'g0', name: 'noop', input: {} } },
      { type: 'usage', usage: { input_tokens: 50, output_tokens: 50 } },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const sink = { requests: [] as CapturedRequest[] };

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: capturingProvider(rounds, sink),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 10,
        }),
      );
      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      // 触发 grace
      const graceNotices = noticesOfType(events, 'iteration_budget_grace');
      expect(graceNotices.length).toBe(1);
      expect(
        (graceNotices[0]!.payload as Record<string, unknown>).trigger,
      ).toBe('iteration');

      // grace 期请求的 tools 字段必须为 undefined
      const graceRequestIdx = sink.requests.findIndex(
        (r) => r.iteration === 9,
      );
      expect(graceRequestIdx).toBeGreaterThanOrEqual(0);
      expect(sink.requests[graceRequestIdx]!.tools).toBeUndefined();
      // grace 期 system prompt 含 "最后一轮" + "不要尝试调用任何工具"
      const sys = flattenSystemPrompt(sink.requests[graceRequestIdx]!.system);
      expect(sys).toMatch(/最后一轮/);
      expect(sys).toMatch(/不要尝试调用任何工具/);

      // grace 期即使 LLM 出 tool_use 也被 block + 强制走 final
      const toolBlockedNotices = noticesOfType(
        events,
        'iteration_budget_grace_tool_blocked',
      );
      expect(toolBlockedNotices.length).toBe(1);
      // H3-A Review P1：中文化 + 解释清楚"这是预期行为而非异常"
      const blockedContent = (
        toolBlockedNotices[0]!.payload as Record<string, unknown>
      ).content as string;
      expect(blockedContent).toMatch(/本轮为最后一轮/);
      expect(blockedContent).toMatch(/已忽略/);
      // 同步发了结构化 telemetry
      const blockedTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.grace_tool_blocked',
      );
      expect(blockedTel).toBeTruthy();
      expect(blockedTel!.payload.tool_count).toBe(1);

      // DONE event：error: false + error_class
      const done = findDone(events)!;
      const donePayload = done.payload as Record<string, unknown>;
      expect(donePayload.error).toBe(false);
      expect(donePayload.error_class).toBe('iteration_budget_exhausted');
      expect(donePayload.suggested_action).toMatch(/轮/);
      expect(donePayload.content).toBe('summary text');
      expect(donePayload.trace_id).toBeTruthy();
      const terminalPersist = findTerminalPersist(events);
      expect(terminalPersist?.payload.blocks_json).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'text', text: 'summary text' }),
      ]));
      expect(terminalPersist?.payload.error_info_json).toEqual(expect.objectContaining({
        error_class: 'iteration_budget_exhausted',
      }));

      // terminate telemetry: previous_stage='grace' + final_message_present=true
      const termTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.terminate',
      );
      expect(termTel).toBeTruthy();
      expect(termTel!.payload.previous_stage).toBe('grace');
      expect(termTel!.payload.final_message_present).toBe(true);
      expect(termTel!.payload.tools_disabled).toBe(true);
    });
  });

  it('terminate at 100% iteration (skip-grace path): direct DONE without LLM call', async () => {
    // 目标：iteration 已到 terminate 但 stage 没经过 grace（如 grace 阈值
    // 配 0.99，terminate 配 0.5——故意倒挂让 terminate 直接接管）。
    // 但我们的 normalize 会把这种倒置整通路回落默认。所以另想办法：
    // 使用 initialMessages 让 iteration 实际起点 + 修改 maxTurns 故意推到
    // terminate。最简单：iterationBudget.iteration 设 warn=0.4 grace=0.5 terminate=0.6
    // → maxTurns=10 → terminate 在 iter=6。
    // 让前 5 轮正常工具调用，第 6 轮顶部触发 terminate 直接 DONE 不调 LLM。
    const rounds = toolThenTextRounds(10);
    const sink = { requests: [] as CapturedRequest[] };

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: capturingProvider(rounds, sink),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 10,
          iterationBudget: {
            // terminate 提前到 60% → iteration=6 时直接 terminate（warn=4 grace=5）
            iteration: { warn: 0.4, grace: 0.5, terminate: 0.6 },
          },
        }),
      );

      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      // 应该看到 warn → grace → terminate notice
      expect(noticesOfType(events, 'iteration_budget_warn').length).toBe(1);
      expect(noticesOfType(events, 'iteration_budget_grace').length).toBe(1);

      const done = findDone(events)!;
      const donePayload = done.payload as Record<string, unknown>;
      expect(donePayload.error).toBe(false);
      expect(donePayload.error_class).toBe('iteration_budget_exhausted');

      // 验证 LLM 调用数小于 maxTurns（grace 完成后 break，所以最后一次调用是 grace 期）
      expect(sink.requests.length).toBeLessThan(10);

      const termTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.terminate',
      );
      expect(termTel).toBeTruthy();
    });
  });
});

// ─── token channel — 85/95/100 ───────────────────────────────────────

describe('FR-15 token channel — three thresholds', () => {
  it('warn at 85% token: triggered by token usage', async () => {
    // maxTotalTokens=200 → warn 在 170。每轮 +10 token → round 17 评估 170 触发 warn。
    // 当前评估在主循环顶部，iteration N 顶部看到的是 iteration 0..N-1 累积的 token。
    // 所以 round 17 (iter=17) 评估时 totalTokens = 17 * 10 = 170 → warn。
    // 配 18 轮 tool + 1 final = 19 rounds 让 warn 触发后还能再调一轮然后退出。
    const rounds: LLMResponseChunk[][] = [];
    for (let i = 0; i < 18; i++) {
      rounds.push([
        { type: 'tool_use', toolUse: { id: `c${i}`, name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 0 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
    }
    rounds.push([
      { type: 'text_delta', text: 'done' },
      { type: 'usage', usage: { input_tokens: 5, output_tokens: 0 } },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const sink = { requests: [] as CapturedRequest[] };
    const tracker = new BudgetTracker({ maxTotalTokens: 200 });

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: capturingProvider(rounds, sink),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 50,
          budgetTracker: tracker,
        }),
      );

      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));
      const warnTel = telSink.records.find(
        (r) =>
          r.event_name === 'iteration_budget.warn' &&
          r.payload.trigger === 'token',
      );
      expect(warnTel).toBeTruthy();
      expect(warnTel!.payload.max_total_tokens).toBe(200);
      // 至少有一个 SYSTEM_NOTICE 'iteration_budget_warn' with trigger=token
      const tokenWarnNotices = events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type ===
            'iteration_budget_warn' &&
          (e.payload as Record<string, unknown>).trigger === 'token',
      );
      expect(tokenWarnNotices.length).toBe(1);
    });
  });

  it('grace at 95% token: tools cleared + DONE token_budget_exhausted', async () => {
    // maxTotalTokens=200 → grace 在 190。每轮 +10 token：
    //   round 17 评估 170 → warn → 调 LLM +10 → 180
    //   round 18 评估 180 → 90% → normal/warn dedup → +10 → 190
    //   round 19 评估 190 → 95% → grace → 调 LLM (final 路径) → DONE
    // rounds 数：19 tool + 1 final = 20
    const rounds: LLMResponseChunk[][] = [];
    for (let i = 0; i < 19; i++) {
      rounds.push([
        { type: 'tool_use', toolUse: { id: `c${i}`, name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 0 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
    }
    rounds.push([
      { type: 'text_delta', text: 'token wrap up' },
      { type: 'usage', usage: { input_tokens: 5, output_tokens: 0 } },
      { type: 'stop', stopReason: 'end_turn' },
    ]);
    const sink = { requests: [] as CapturedRequest[] };
    const tracker = new BudgetTracker({ maxTotalTokens: 200 });

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: capturingProvider(rounds, sink),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 50,
          budgetTracker: tracker,
        }),
      );

      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      const graceNotices = noticesOfType(events, 'iteration_budget_grace');
      expect(graceNotices.length).toBe(1);
      expect(
        (graceNotices[0]!.payload as Record<string, unknown>).trigger,
      ).toBe('token');

      const done = findDone(events)!;
      const donePayload = done.payload as Record<string, unknown>;
      expect(donePayload.error).toBe(false);
      expect(donePayload.error_class).toBe('token_budget_exhausted');
      expect(donePayload.suggested_action).toMatch(/Token/);
      expect(donePayload.content).toBe('token wrap up');

      const termTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.terminate',
      );
      expect(termTel!.payload.trigger).toBe('token');
      expect(termTel!.payload.final_message_present).toBe(true);
    });
  });
});

// ─── grace prompt content / tools clearing ───────────────────────────

describe('FR-15 grace call — system prompt + tools enforcement', () => {
  it('grace turn: tools = undefined, system contains "最后一轮", "不要尝试调用任何工具", "工具已被禁用"', async () => {
    // 配 grace=0.5 → maxTurns=2 → iter 1 是 grace
    const rounds: LLMResponseChunk[][] = [
      [
        { type: 'tool_use', toolUse: { id: 'c0', name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 10 } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'final summary' },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 10 } },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ];
    const sink = { requests: [] as CapturedRequest[] };
    const rt = createRuntime(
      makeConfig({
        provider: capturingProvider(rounds, sink),
        tools: createMockToolProvider([makeTool('noop')]),
        maxTurns: 2,
        iterationBudget: {
          iteration: { warn: 0.4, grace: 0.5, terminate: 1.0 },
        },
      }),
    );
    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

    // 第二轮（iteration=1）是 grace
    const graceReq = sink.requests.find((r) => r.iteration === 1);
    expect(graceReq).toBeTruthy();
    expect(graceReq!.tools).toBeUndefined();
    const sys = flattenSystemPrompt(graceReq!.system);
    expect(sys).toMatch(/最后一轮/);
    expect(sys).toMatch(/不要尝试调用任何工具/);
    expect(sys).toMatch(/工具已被禁用/);
    expect(sys).toMatch(/预算宽限轮/);

    // 验证总有 final summary
    const done = findDone(events)!;
    expect((done.payload as Record<string, unknown>).content).toBe(
      'final summary',
    );
  });

  it('warn turn: tools NOT cleared, system contains "预算预警"', async () => {
    const rounds: LLMResponseChunk[][] = [
      [
        { type: 'tool_use', toolUse: { id: 'c0', name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 10 } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'finishing' },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 10 } },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ];
    const sink = { requests: [] as CapturedRequest[] };
    const rt = createRuntime(
      makeConfig({
        provider: capturingProvider(rounds, sink),
        tools: createMockToolProvider([makeTool('noop')]),
        maxTurns: 4,
        iterationBudget: {
          // warn 在 iter=1 (25%) → 提前；grace 在 iter=3 (75%)
          iteration: { warn: 0.25, grace: 0.75, terminate: 1.0 },
        },
      }),
    );
    await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

    const warnReq = sink.requests.find((r) => r.iteration === 1);
    expect(warnReq).toBeTruthy();
    // warn 期 tools 仍保留
    expect(warnReq!.tools).toBeDefined();
    expect(warnReq!.tools!.length).toBe(1);
    const sys = flattenSystemPrompt(warnReq!.system);
    expect(sys).toMatch(/预算预警/);
    expect(sys).toMatch(/请开始收口/);
  });
});

// ─── DONE event field validation ─────────────────────────────────────

describe('FR-15 DONE event payload — terminate path (skip grace)', () => {
  it('iteration trigger 直接 terminate (跳过 grace)：no LLM call, error=false, no content', async () => {
    // 触发"轮内突变到 terminate 跳过 grace"的关键约束：IterationBudget terminate
    // 阈值必须**严格小于** BudgetTracker.isExhausted 触发点，否则后者会先 trip
    // 走 MAX_CREDITS_EXCEEDED (error: true)。
    //
    // 配置：BudgetTracker maxTotalTokens=200，IterationBudget token.terminate=0.5
    //   → IterationBudget 在累积 100 token 时（顶部评估）触发 terminate
    //   → BudgetTracker 在累积 200 token 时（末尾检查）才 trip
    //
    // round 0: 顶部 token=0 → normal → LLM +100 token → 末尾 BudgetTracker 100<200 → 继续
    // round 1: 顶部 token=100 → 50% → terminate → 直接 DONE，**不调 LLM**
    const rounds: LLMResponseChunk[][] = [
      [
        { type: 'tool_use', toolUse: { id: 'c0', name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 100, output_tokens: 0 } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      // round 1 永远不会被消费——IterationBudget terminate 在顶部直接 break
      [
        { type: 'text_delta', text: 'should_not_appear' },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ];
    const tracker = new BudgetTracker({ maxTotalTokens: 200 });

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: createMockProvider(rounds),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 50,
          budgetTracker: tracker,
          iterationBudget: {
            // token.terminate=0.5 让 IterationBudget 在 100 token 触发，
            // 早于 BudgetTracker.isExhausted (200 token)
            token: { warn: 0.3, grace: 0.4, terminate: 0.5 },
          },
        }),
      );

      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      const done = findDone(events)!;
      const p = done.payload as Record<string, unknown>;
      expect(p.error).toBe(false);
      expect(p.error_class).toBe('token_budget_exhausted');
      expect(p.content).toBe(''); // 直接 terminate 路径无 LLM final 内容
      expect(p.trace_id).toBeTruthy();
      expect(p.termination_reason).toBe('token_budget_exhausted');
      const terminalPersist = findTerminalPersist(events);
      expect(terminalPersist?.payload.blocks_json).toEqual(expect.arrayContaining([
        expect.objectContaining({ type: 'tool_use', id: 'c0' }),
      ]));
      expect(terminalPersist?.payload.error_info_json).toEqual(expect.objectContaining({
        error_class: 'token_budget_exhausted',
      }));

      const termTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.terminate',
      );
      expect(termTel).toBeTruthy();
      expect(termTel!.payload.trigger).toBe('token');
      expect(termTel!.payload.final_message_present).toBe(false);
      // 跳过 grace 路径下 previous_stage 不是 'grace'
      expect(termTel!.payload.previous_stage).not.toBe('grace');

      // H3-A Review P1：terminate 路径独立 notice 文案——不能与 grace 文案
      // 矛盾（grace 文案承诺"将给出最终总结"但 terminate.content=''）
      const termNotices = noticesOfType(events, 'iteration_budget_terminate');
      expect(termNotices.length).toBe(1);
      const termContent = (termNotices[0]!.payload as Record<string, unknown>)
        .content as string;
      expect(termContent).toMatch(/本轮未再调用模型/);
      expect(termContent).toMatch(/查看上方既有结果/);
      expect(termContent).not.toMatch(/将给出最终总结/);
    });
  });
});

// ─── Interaction with DoomLoop ───────────────────────────────────────
// W2.3 (D-tech-6)：原 `FR-15 IterationBudget × DoomLoop priority` describe
// 块在此处删除——`createDoomLoopGuard` 已下线，doom_loop_terminate /
// doom_loop_pause notice 不再有写入者，断言无法成立。归后续 Harness
// 专题；届时按"DoomLoopCap × IterationBudget 抢占优先级"重新建测试。

// ─── default behaviour (no override): MAX_TURNS_EXCEEDED 不再触发 ────

describe('FR-15 default — grace 抢占 MAX_TURNS_EXCEEDED 路径', () => {
  it('default 配置：长任务 grace 路径接管，DONE error=false (而非 MAX_TURNS_EXCEEDED hard error)', async () => {
    // maxTurns=10 + 默认 IterationBudget (warn=70% grace=90% terminate=100%)。
    // grace 在 iter=9 (90% × 10) 触发，强制 LLM 做最后总结后 DONE。
    // 主循环末尾的 `state.iteration >= maxTurns` MAX_TURNS_EXCEEDED 路径
    // 永远不会触发——grace round break 退出循环，iter 没机会到 10。
    const rounds: LLMResponseChunk[][] = [];
    for (let i = 0; i < 14; i++) {
      rounds.push([
        { type: 'tool_use', toolUse: { id: `c${i}`, name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 5, output_tokens: 5 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
    }

    const rt = createRuntime(
      makeConfig({
        provider: createMockProvider(rounds),
        tools: createMockToolProvider([makeTool('noop')]),
        maxTurns: 10,
      }),
    );

    const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

    const done = findDone(events)!;
    const p = done.payload as Record<string, unknown>;
    // 关键：error=false（与 MAX_TURNS_EXCEEDED 的 error=true 区别）
    expect(p.error).toBe(false);
    expect(p.error_class).toBe('iteration_budget_exhausted');

    // MAX_TURNS notice 不应该出现（被 grace 抢占）
    expect(noticesOfType(events, 'max_turns').length).toBe(0);

    // grace + warn notice 都该出现（依次升级）
    expect(noticesOfType(events, 'iteration_budget_warn').length).toBe(1);
    expect(noticesOfType(events, 'iteration_budget_grace').length).toBe(1);
  });

  it('未配置 budgetTracker maxTotalTokens 时 token 通路 disabled，仅 iteration 通路生效', async () => {
    // 注：input_tokens 用合理值（小数量）避免触发 contextPressure-based compaction
    // 反复失败导致测试早退；本测试只关心 IterationBudget 是否分别按通路工作。
    const rounds: LLMResponseChunk[][] = [];
    for (let i = 0; i < 14; i++) {
      rounds.push([
        { type: 'tool_use', toolUse: { id: `c${i}`, name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 5, output_tokens: 5 } },
        { type: 'stop', stopReason: 'tool_use' },
      ]);
    }

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: createMockProvider(rounds),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 10,
          // 不传 budgetTracker → token 通路 disabled
        }),
      );
      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      // 任何 IterationBudget 事件 trigger 都不应是 token
      const tokenTriggered = telSink.records.filter(
        (r) =>
          r.event_name.startsWith('iteration_budget.') &&
          r.payload.trigger === 'token',
      );
      expect(tokenTriggered.length).toBe(0);

      // iteration 通路应正常触发 grace（在 iter=9 = 90% × 10）
      const iterGraceNotices = events.filter(
        (e) =>
          e.type === 'agent.stream.system_notice' &&
          (e.payload as Record<string, unknown>).notice_type ===
            'iteration_budget_grace',
      );
      expect(iterGraceNotices.length).toBe(1);
      expect(
        (iterGraceNotices[0]!.payload as Record<string, unknown>).trigger,
      ).toBe('iteration');
    });
  });
});

// ─── Token channel SSoT with BudgetTracker（ per-scope）──────────

describe('FR-15 token channel SSoT — budgetScope per-run numerator ', () => {
  it('子 Agent（有 budgetScope）token current 用 per-scope，不被父全树用量误杀', async () => {
    // 父已在全局桶烧掉 80 token；子 run 带 budgetScope=child-1，首轮 scope=0。
    // 旧口径读全树会立刻 grace；#8480 后应按子自身用量单独核算。
    const tracker = new BudgetTracker({ maxTotalTokens: 100 });
    tracker.recordUsage(80, 0); // 模拟父 Agent 已用（无 scope → 只进全局）

    const rounds: LLMResponseChunk[][] = [
      [
        { type: 'tool_use', toolUse: { id: 'c0', name: 'noop', input: { i: 0 } } },
        { type: 'usage', usage: { input_tokens: 10, output_tokens: 0 } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'child done' },
        { type: 'usage', usage: { input_tokens: 5, output_tokens: 0 } },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ];

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: createMockProvider(rounds),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 50,
          budgetTracker: tracker,
          budgetScope: 'child-1',
          iterationBudget: {
            token: { warn: 0.5, grace: 0.85, terminate: 1.0 },
          },
        }),
      );

      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      // 子 scope 仅 10+5=15 token，远低于 grace(85)——不应触发 token grace
      expect(noticesOfType(events, 'iteration_budget_grace').length).toBe(0);
      expect(noticesOfType(events, 'iteration_budget_warn').length).toBe(0);

      const done = findDone(events)!;
      const p = done.payload as Record<string, unknown>;
      expect(p.error_class).not.toBe('token_budget_exhausted');

      const graceTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.grace',
      );
      expect(graceTel).toBeUndefined();
    });
  });

  it('子 Agent 自身 scope 用量达 grace 阈值时仍正常触发', async () => {
    // maxTotalTokens 同时喂 IterationBudget 分母与 isExhausted 硬墙；
    // 本用例只验证 scope 分子，不预填父全局（避免 80+90 撞全树硬墙）。
    const tracker = new BudgetTracker({ maxTotalTokens: 100 });

    // 子首轮 scope=90 → 第二轮顶部 90/100=90% ≥ grace(0.85)
    const rounds: LLMResponseChunk[][] = [
      [
        { type: 'tool_use', toolUse: { id: 'c0', name: 'noop', input: { i: 0 } } },
        { type: 'usage', usage: { input_tokens: 90, output_tokens: 0 } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'wrap up' },
        { type: 'usage', usage: { input_tokens: 5, output_tokens: 0 } },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ];

    await withTelemetrySink(async (telSink) => {
      const rt = createRuntime(
        makeConfig({
          provider: createMockProvider(rounds),
          tools: createMockToolProvider([makeTool('noop')]),
          maxTurns: 50,
          budgetTracker: tracker,
          budgetScope: 'child-1',
          iterationBudget: {
            token: { warn: 0.5, grace: 0.85, terminate: 1.0 },
          },
        }),
      );

      const events = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'Run' }));

      const graceNotices = noticesOfType(events, 'iteration_budget_grace');
      expect(graceNotices.length).toBe(1);
      expect(
        (graceNotices[0]!.payload as Record<string, unknown>).trigger,
      ).toBe('token');

      const done = findDone(events)!;
      expect((done.payload as Record<string, unknown>).error_class).toBe(
        'token_budget_exhausted',
      );

      const graceTel = telSink.records.find(
        (r) => r.event_name === 'iteration_budget.grace',
      );
      expect(graceTel).toBeTruthy();
      expect(graceTel!.payload.total_tokens).toBe(90);
    });
  });
});
