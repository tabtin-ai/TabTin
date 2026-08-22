/**
 * FR-15 — IterationBudget 模块单元测试。
 *
 * 覆盖纯函数：normalizeIterationBudgetConfig / evaluateIterationBudget /
 * isStageUpgrade / 文案生成 helpers / error_class 映射。
 *
 * 引擎集成（与 query.ts 主循环交互）的测试在
 * `engine-iteration-budget.test.ts`。
 */

import { describe, it, expect } from 'vitest';
import {
  budgetTriggerToErrorClass,
  buildBudgetGraceNoticeContent,
  buildBudgetGraceSystemInjection,
  buildBudgetGraceToolBlockedNoticeContent,
  buildBudgetTerminateNoticeContent,
  buildBudgetWarnNoticeContent,
  buildBudgetWarnSystemInjection,
  DEFAULT_ITERATION_BUDGET,
  evaluateIterationBudget,
  isStageUpgrade,
  normalizeIterationBudgetConfig,
  suggestedActionForBudgetExhausted,
} from '../src/engine/guards/iteration-budget.js';

describe('FR-15 normalizeIterationBudgetConfig', () => {
  it('returns default when raw is undefined', () => {
    expect(normalizeIterationBudgetConfig(undefined)).toEqual(
      DEFAULT_ITERATION_BUDGET,
    );
  });

  it('returns default when raw is empty object', () => {
    expect(normalizeIterationBudgetConfig({})).toEqual(DEFAULT_ITERATION_BUDGET);
  });

  it('passes through valid full config', () => {
    const valid = {
      iteration: { warn: 0.6, grace: 0.85, terminate: 1.0 },
      token: { warn: 0.8, grace: 0.9, terminate: 1.0 },
    };
    expect(normalizeIterationBudgetConfig(valid)).toEqual(valid);
  });

  it('falls back single bad threshold to default', () => {
    // grace=0 非法 → grace 字段回落到默认 0.9 → 全通路 warn=0.6 < grace=0.9 满足
    // → 整通路返回 (0.6, 0.9, 1.0)
    const out = normalizeIterationBudgetConfig({
      iteration: { warn: 0.6, grace: 0, terminate: 1.0 },
    });
    expect(out.iteration).toEqual({ warn: 0.6, grace: 0.9, terminate: 1.0 });
    expect(out.token).toEqual(DEFAULT_ITERATION_BUDGET.token);
  });

  it('falls back entire channel when warn >= grace', () => {
    // warn=0.95 >= grace=0.5 违反不变量 → 整通路回落
    const out = normalizeIterationBudgetConfig({
      iteration: { warn: 0.95, grace: 0.5, terminate: 1.0 },
    });
    expect(out.iteration).toEqual(DEFAULT_ITERATION_BUDGET.iteration);
  });

  it('falls back entire channel when grace > terminate', () => {
    const out = normalizeIterationBudgetConfig({
      token: { warn: 0.5, grace: 0.99, terminate: 0.9 },
    });
    expect(out.token).toEqual(DEFAULT_ITERATION_BUDGET.token);
  });

  it('single-field fallback when terminate > 1 (other fields kept)', () => {
    // terminate=1.5 单字段非法 → fallback 到默认 1.0；warn=0.5 < grace=0.7 ≤ terminate=1.0
    // 满足不变量 → 整通路不回落，warn / grace 保留用户传入值。
    const out = normalizeIterationBudgetConfig({
      iteration: { warn: 0.5, grace: 0.7, terminate: 1.5 },
    });
    expect(out.iteration).toEqual({ warn: 0.5, grace: 0.7, terminate: 1.0 });
  });

  it('entire channel fallback when invariant impossible to fix at field level', () => {
    // warn=0.95 / grace=0.5 / terminate=0.99 三个值各自合法（在 (0,1] 内），
    // 但 warn >= grace 违反不变量——这种"局部全合法但整体反序"的情况整通路回落。
    const out = normalizeIterationBudgetConfig({
      iteration: { warn: 0.95, grace: 0.5, terminate: 0.99 },
    });
    expect(out.iteration).toEqual(DEFAULT_ITERATION_BUDGET.iteration);
  });

  it('handles NaN / Infinity / non-number gracefully', () => {
    const out = normalizeIterationBudgetConfig({
      iteration: {
        warn: NaN,
        grace: Infinity,
        terminate: ('abc' as unknown) as number,
      },
    });
    // 三个字段单独 fallback → (warn=0.7, grace=0.9, terminate=1.0) 默认值，
    // 满足不变量 → 通过
    expect(out.iteration).toEqual(DEFAULT_ITERATION_BUDGET.iteration);
  });

  it('handles partial channel (only token configured)', () => {
    const out = normalizeIterationBudgetConfig({
      token: { warn: 0.5, grace: 0.7, terminate: 1.0 },
    });
    expect(out.iteration).toEqual(DEFAULT_ITERATION_BUDGET.iteration);
    expect(out.token).toEqual({ warn: 0.5, grace: 0.7, terminate: 1.0 });
  });
});

describe('FR-15 evaluateIterationBudget — iteration channel', () => {
  const config = DEFAULT_ITERATION_BUDGET;

  it('returns normal at 0%', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(out.stage).toBe('normal');
    expect(out.trigger).toBeNull();
  });

  it('triggers warn at 70% iteration (default)', () => {
    const out = evaluateIterationBudget({
      iteration: 70,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(out.stage).toBe('warn');
    expect(out.trigger).toBe('iteration');
    expect(out.iteration.percent).toBeCloseTo(0.7, 5);
    expect(out.iteration.threshold).toBe(70);
  });

  it('does NOT trigger warn at 69% iteration (just below)', () => {
    const out = evaluateIterationBudget({
      iteration: 69,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(out.stage).toBe('normal');
  });

  it('triggers grace at 90% iteration', () => {
    const out = evaluateIterationBudget({
      iteration: 90,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(out.stage).toBe('grace');
    expect(out.trigger).toBe('iteration');
  });

  it('triggers terminate at 100% iteration', () => {
    const out = evaluateIterationBudget({
      iteration: 100,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(out.stage).toBe('terminate');
    expect(out.trigger).toBe('iteration');
  });

  it('triggers terminate at 105% iteration (exceeded)', () => {
    const out = evaluateIterationBudget({
      iteration: 105,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(out.stage).toBe('terminate');
  });
});

describe('FR-15 evaluateIterationBudget — token channel', () => {
  const config = DEFAULT_ITERATION_BUDGET;

  it('triggers warn at 85% token (default)', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 8500,
      maxTotalTokens: 10_000,
      config,
    });
    expect(out.stage).toBe('warn');
    expect(out.trigger).toBe('token');
    expect(out.token.percent).toBeCloseTo(0.85, 5);
  });

  it('does NOT trigger warn at 84% token (just below)', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 8400,
      maxTotalTokens: 10_000,
      config,
    });
    expect(out.stage).toBe('normal');
  });

  it('triggers grace at 95% token', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 9500,
      maxTotalTokens: 10_000,
      config,
    });
    expect(out.stage).toBe('grace');
    expect(out.trigger).toBe('token');
  });

  it('triggers terminate at 100% token', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 10_000,
      maxTotalTokens: 10_000,
      config,
    });
    expect(out.stage).toBe('terminate');
    expect(out.trigger).toBe('token');
  });

  it('disabled when maxTotalTokens=Infinity', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 99_999_999,
      maxTotalTokens: Infinity,
      config,
    });
    expect(out.stage).toBe('normal');
    expect(out.token.enabled).toBe(false);
    expect(out.token.percent).toBe(0);
  });

  it('disabled when maxTotalTokens=0', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 1000,
      maxTotalTokens: 0,
      config,
    });
    expect(out.token.enabled).toBe(false);
  });

  it('disabled when maxTotalTokens=NaN', () => {
    const out = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 1000,
      maxTotalTokens: NaN,
      config,
    });
    expect(out.token.enabled).toBe(false);
  });
});

describe('FR-15 evaluateIterationBudget — dual-channel priority', () => {
  it('iteration priority when both at warn (same stage)', () => {
    const out = evaluateIterationBudget({
      iteration: 70,
      maxTurns: 100,
      totalTokens: 8500,
      maxTotalTokens: 10_000,
      config: DEFAULT_ITERATION_BUDGET,
    });
    // 两通路同 stage(warn) → iteration 优先
    expect(out.stage).toBe('warn');
    expect(out.trigger).toBe('iteration');
  });

  it('higher channel wins (token grace beats iteration warn)', () => {
    const out = evaluateIterationBudget({
      iteration: 70, // warn
      maxTurns: 100,
      totalTokens: 9500, // grace
      maxTotalTokens: 10_000,
      config: DEFAULT_ITERATION_BUDGET,
    });
    expect(out.stage).toBe('grace');
    expect(out.trigger).toBe('token');
  });

  it('iteration terminate beats token grace', () => {
    const out = evaluateIterationBudget({
      iteration: 100, // terminate
      maxTurns: 100,
      totalTokens: 9500, // grace
      maxTotalTokens: 10_000,
      config: DEFAULT_ITERATION_BUDGET,
    });
    expect(out.stage).toBe('terminate');
    expect(out.trigger).toBe('iteration');
  });

  it('both channels normal returns normal/null', () => {
    const out = evaluateIterationBudget({
      iteration: 30,
      maxTurns: 100,
      totalTokens: 5000,
      maxTotalTokens: 10_000,
      config: DEFAULT_ITERATION_BUDGET,
    });
    expect(out.stage).toBe('normal');
    expect(out.trigger).toBeNull();
  });

  it('returns full per-channel detail even when one is normal', () => {
    const out = evaluateIterationBudget({
      iteration: 70, // warn
      maxTurns: 100,
      totalTokens: 5000, // normal
      maxTotalTokens: 10_000,
      config: DEFAULT_ITERATION_BUDGET,
    });
    expect(out.iteration.stage).toBe('warn');
    expect(out.iteration.percent).toBeCloseTo(0.7, 5);
    expect(out.token.stage).toBe('normal');
    expect(out.token.percent).toBeCloseTo(0.5, 5);
    expect(out.token.enabled).toBe(true);
  });
});

describe('FR-15 isStageUpgrade', () => {
  it('undefined → warn is upgrade', () => {
    expect(isStageUpgrade(undefined, 'warn')).toBe(true);
  });
  it('warn → grace is upgrade', () => {
    expect(isStageUpgrade('warn', 'grace')).toBe(true);
  });
  it('grace → terminate is upgrade', () => {
    expect(isStageUpgrade('grace', 'terminate')).toBe(true);
  });
  it('warn → warn is NOT upgrade', () => {
    expect(isStageUpgrade('warn', 'warn')).toBe(false);
  });
  it('grace → warn is NOT upgrade (decline)', () => {
    expect(isStageUpgrade('grace', 'warn')).toBe(false);
  });
  it('terminate → grace is NOT upgrade', () => {
    expect(isStageUpgrade('terminate', 'grace')).toBe(false);
  });
  it('undefined → normal is NOT upgrade', () => {
    expect(isStageUpgrade(undefined, 'normal')).toBe(false);
  });
});

describe('FR-15 budgetTriggerToErrorClass', () => {
  it('iteration → iteration_budget_exhausted', () => {
    expect(budgetTriggerToErrorClass('iteration')).toBe(
      'iteration_budget_exhausted',
    );
  });
  it('token → token_budget_exhausted', () => {
    expect(budgetTriggerToErrorClass('token')).toBe('token_budget_exhausted');
  });
});

describe('FR-15 suggestedActionForBudgetExhausted', () => {
  it('iteration trigger returns Chinese hint mentioning 轮数', () => {
    const text = suggestedActionForBudgetExhausted('iteration');
    expect(text).toMatch(/轮/);
  });
  it('token trigger returns Chinese hint mentioning Token', () => {
    const text = suggestedActionForBudgetExhausted('token');
    expect(text).toMatch(/Token/);
  });
});

describe('FR-15 Notice / system-injection content', () => {
  const warnEval = evaluateIterationBudget({
    iteration: 70,
    maxTurns: 100,
    totalTokens: 0,
    maxTotalTokens: Infinity,
    config: DEFAULT_ITERATION_BUDGET,
  });
  const graceEval = evaluateIterationBudget({
    iteration: 0,
    maxTurns: 100,
    totalTokens: 9500,
    maxTotalTokens: 10_000,
    config: DEFAULT_ITERATION_BUDGET,
  });

  it('warn notice mentions 轮数 + 70%', () => {
    const text = buildBudgetWarnNoticeContent(warnEval);
    expect(text).toMatch(/对话轮数/);
    expect(text).toMatch(/70/);
  });

  it('warn system-injection is 中文 with "请开始收口"', () => {
    const text = buildBudgetWarnSystemInjection(warnEval);
    expect(text).toMatch(/预算预警/);
    expect(text).toMatch(/请开始收口/);
    expect(text).toMatch(/对话轮数/);
  });

  it('grace notice mentions Token + 本轮为最后一轮 + 列出仍需继续的任务', () => {
    const text = buildBudgetGraceNoticeContent(graceEval);
    expect(text).toMatch(/Token/);
    // H3-A Review P1 修订：grace notice 改为更清晰的"最后一轮 / 列出未完成项"叙事
    expect(text).toMatch(/本轮为最后一轮/);
    expect(text).toMatch(/列出仍需继续的任务/);
  });

  it('grace system-injection contains "不要尝试调用任何工具" + "最后一轮"', () => {
    const text = buildBudgetGraceSystemInjection(graceEval);
    expect(text).toMatch(/不要尝试调用任何工具/);
    expect(text).toMatch(/最后一轮/);
    expect(text).toMatch(/Token 用量/);
  });

  it('warn notice for normal stage returns empty string', () => {
    const normalEval = evaluateIterationBudget({
      iteration: 0,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config: DEFAULT_ITERATION_BUDGET,
    });
    expect(buildBudgetWarnNoticeContent(normalEval)).toBe('');
    expect(buildBudgetWarnSystemInjection(normalEval)).toBe('');
    expect(buildBudgetGraceNoticeContent(normalEval)).toBe('');
    expect(buildBudgetGraceSystemInjection(normalEval)).toBe('');
    expect(buildBudgetTerminateNoticeContent(normalEval)).toBe('');
  });

  it('terminate notice mentions 上限 + 既有结果 / 新开会话 (NOT grace 文案)', () => {
    // H3-A Review P1：terminate 路径独立文案，不复用 grace 文案
    const terminateEval = evaluateIterationBudget({
      iteration: 100,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config: DEFAULT_ITERATION_BUDGET,
    });
    const text = buildBudgetTerminateNoticeContent(terminateEval);
    expect(text).toMatch(/对话轮数已达 100%/);
    expect(text).toMatch(/本轮未再调用模型/);
    expect(text).toMatch(/查看上方既有结果/);
    expect(text).toMatch(/新开一段会话/);
    // 关键：不能含"将给出最终总结"（这是 grace 文案，会与 terminate.content='' 矛盾）
    expect(text).not.toMatch(/将给出最终总结/);
  });

  it('grace tool_blocked notice 中文化 + 解释为何这是预期行为', () => {
    const text = buildBudgetGraceToolBlockedNoticeContent(3);
    // H3-A Review P1：原英文 notice 让用户"以为系统 bug"，改中文 + 引导
    expect(text).toMatch(/本轮为最后一轮/);
    expect(text).toMatch(/3 个工具/);
    expect(text).toMatch(/已忽略/);
    expect(text).toMatch(/新对话中继续/);
    // 不能含英文 tool_use / Discarded 等技术术语
    expect(text).not.toMatch(/tool_use/);
    expect(text).not.toMatch(/Discarded/);
  });
});

describe('FR-15 evaluateIterationBudget — defensive corner cases', () => {
  it('handles negative current as 0', () => {
    const out = evaluateIterationBudget({
      iteration: -10,
      maxTurns: 100,
      totalTokens: -500,
      maxTotalTokens: 10_000,
      config: DEFAULT_ITERATION_BUDGET,
    });
    expect(out.stage).toBe('normal');
    expect(out.iteration.current).toBe(0);
    expect(out.token.current).toBe(0);
  });

  it('handles NaN current as 0', () => {
    const out = evaluateIterationBudget({
      iteration: NaN,
      maxTurns: 100,
      totalTokens: NaN,
      maxTotalTokens: 10_000,
      config: DEFAULT_ITERATION_BUDGET,
    });
    expect(out.stage).toBe('normal');
  });

  it('custom config: warn=0.5 grace=0.6 terminate=0.9', () => {
    const config = {
      iteration: { warn: 0.5, grace: 0.6, terminate: 0.9 },
      token: DEFAULT_ITERATION_BUDGET.token,
    };
    const warnOut = evaluateIterationBudget({
      iteration: 50,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(warnOut.stage).toBe('warn');

    const graceOut = evaluateIterationBudget({
      iteration: 60,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(graceOut.stage).toBe('grace');

    const termOut = evaluateIterationBudget({
      iteration: 90,
      maxTurns: 100,
      totalTokens: 0,
      maxTotalTokens: Infinity,
      config,
    });
    expect(termOut.stage).toBe('terminate');
  });
});
