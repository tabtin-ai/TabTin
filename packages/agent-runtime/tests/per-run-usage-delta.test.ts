/**
 *  — 根 query 的 DONE.usage 必须是「本 run 增量」而非「per-runtime 累计」。
 *
 * 背景：`BudgetTracker` 是 per-runtime（同一 runtime 跨多轮对话复用），其
 * `getAccumulated()` 跨 turn 单调递增。历史实现里根 query 的
 * `syncStateFromTracker` 直接把 `getAccumulated()` 灌进 `state.totalInputTokens`，
 * 于是每个 turn 的 DONE.usage 报的都是「累计到当前 turn 为止」的总量；后端
 * `_accumulate_session_tokens_from_done` 又按 `F() +=` 逐 turn 累加，导致前序
 * turn 被反复计入（实测某会话 ChatSession.input_tokens 翻 ~2×）。
 *
 * 方案A 修复：run 起始快照基线 `state._budgetRunBaseline = getAccumulated()`，
 * DONE 报 `getAccumulated() − 基线` = 本 run 真实消耗。本测试用「同一 runtime
 * 连续两个 query」复现并守门。
 */

import { describe, it, expect } from 'vitest';
import { createRuntime } from '../src/runtime-assembly.js';
import { BudgetTracker } from '../src/engine/guards/budget-tracker.js';
import {
  createMockProvider,
  createMockToolProvider,
  createMockPermissionHandler,
} from './test-utils.js';
import type {
  StreamEvent,
} from '../src/engine/contracts/wire-protocol.js';
import type {
  LLMResponseChunk,
} from '../src/engine/contracts/model-llm.js';
import type {
  EngineConfig,
} from '../src/engine/contracts/kernel.js';

function makeConfig(overrides: Partial<EngineConfig> = {}): EngineConfig {
  return {
    provider: createMockProvider(),
    tools: createMockToolProvider(),
    permissionHandler: createMockPermissionHandler(),
    sessionConfig: { sessionDir: '/tmp/test', threadId: 'test-session' },
    model: 'test-model',
    ...overrides,
  };
}

async function collectEvents(gen: AsyncGenerator<StreamEvent>): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const event of gen) events.push(event);
  return events;
}

function doneUsage(events: StreamEvent[]): Record<string, unknown> {
  const done = events.find((e) => e.type === 'agent.stream.done');
  const usage = (done?.payload as Record<string, unknown> | undefined)?.usage;
  return (usage ?? {}) as Record<string, unknown>;
}

/** 单轮：一次 LLM 调用，给定 usage，立即 end_turn（不调工具）。 */
function singleCallTurn(inputTokens: number, outputTokens: number): LLMResponseChunk[] {
  return [
    { type: 'text_delta', text: 'ok' },
    { type: 'usage', usage: { input_tokens: inputTokens, output_tokens: outputTokens } },
    { type: 'stop', stopReason: 'end_turn' },
  ];
}

describe('#2012 — 根 query DONE.usage 为 per-run 增量（共享 BudgetTracker 跨 turn）', () => {
  it('同一 runtime 连续两个 turn：DONE 各报本 turn 增量，不把前一 turn 重复累计', async () => {
    const tracker = new BudgetTracker();
    // 同一 provider 的 callIndex 跨 createStream 持续递增：turn1→round0, turn2→round1。
    const provider = createMockProvider([
      singleCallTurn(100, 20),
      singleCallTurn(300, 40),
    ]);
    const rt = createRuntime(makeConfig({ provider, budgetTracker: tracker }));

    // ── turn 1 ──
    const e1 = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'q1' }));
    const u1 = doneUsage(e1);
    expect(u1.input_tokens).toBe(100);
    expect(u1.output_tokens).toBe(20);

    // ── turn 2（共享 tracker，getAccumulated 此刻已累计到 input=400） ──
    const e2 = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'q2' }));
    const u2 = doneUsage(e2);
    // 关键断言：turn2 只报本 turn 的 300，而不是累计的 400。
    // 修复前这里会是 400（getAccumulated 累计值）→ 后端 F() 累加把 turn1 重复计入。
    expect(u2.input_tokens).toBe(300);
    expect(u2.output_tokens).toBe(40);

    // P2-1：by_model 必须与标量同口径（本 run 增量），不能是累计 400。
    const byModel2 = (doneUsage(e2) as { by_model?: Record<string, { input_tokens?: number }> })
      .by_model;
    expect(byModel2?.['test-model']?.input_tokens).toBe(300);

    // ── 后端按 F() += 逐 turn 累加的等效结果 = 两个 DONE 之和 = 真实总量 ──
    const sessionInput = (u1.input_tokens as number) + (u2.input_tokens as number);
    const sessionOutput = (u1.output_tokens as number) + (u2.output_tokens as number);
    expect(sessionInput).toBe(400); // == tracker 最终累计，无重复
    expect(sessionOutput).toBe(60);
  });

  it('单 turn 多次 LLM 调用：DONE 报本 turn 全部调用之和（per-run 累加，不跨 turn 滚雪球）', async () => {
    const tracker = new BudgetTracker();
    const provider = createMockProvider([
      // turn1 内两次 LLM 调用（tool_use → 再 end_turn）
      [
        { type: 'tool_use', toolUse: { id: 'c0', name: 'noop', input: {} } },
        { type: 'usage', usage: { input_tokens: 50, output_tokens: 10 } },
        { type: 'stop', stopReason: 'tool_use' },
      ],
      [
        { type: 'text_delta', text: 'done' },
        { type: 'usage', usage: { input_tokens: 80, output_tokens: 15 } },
        { type: 'stop', stopReason: 'end_turn' },
      ],
    ]);
    const rt = createRuntime(
      makeConfig({
        provider,
        tools: createMockToolProvider([
          {
            name: 'noop',
            description: 'noop',
            inputSchema: { type: 'object', properties: {} },
            isReadOnly: true,
            execute: async () => ({ content: 'ok' }),
          },
        ]),
        budgetTracker: tracker,
      }),
    );

    const e1 = await collectEvents(rt.query({ hostRunId: 'test-run', prompt: 'q1' }));
    const u1 = doneUsage(e1);
    // 本 turn 两次调用之和（50+80 / 10+15）——per-run 累加是对的，
    // 「不重复计算」针对的是跨 turn 把累计值再加一遍，不是禁止一 turn 内多调用求和。
    expect(u1.input_tokens).toBe(130);
    expect(u1.output_tokens).toBe(25);
  });
});
