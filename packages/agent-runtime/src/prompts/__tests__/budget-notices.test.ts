/**
 * E1 / 宪法 v0.1 §3.5 + §3.6——budget-notices 的快照测试。
 *
 * 重点锁定：
 * 1. **文案语言边界**——
 *    - warn/grace/terminate notice content **必须中文**（用户面）；
 *    - warn/grace system injection **必须中文**（LLM 系统指令，已全中文化）；
 *    - 任意一段文案漂移都触发 snapshot 失败 + PR review。
 * 2. **早返回不变量**——非匹配 stage 必须返回空字符串（避免错配阶段误注入）。
 * 3. **数值格式化**——iteration 整数、token 千分位逗号 + en-US 风格。
 * 4. **terminate 文案与 grace 严格分开**——避免"承诺总结却没总结"用户感知 bug。
 */

import { describe, it, expect } from 'vitest';
import {
  buildBudgetWarnNoticeContent,
  buildBudgetWarnSystemInjection,
  buildBudgetGraceNoticeContent,
  buildBudgetGraceSystemInjection,
  buildBudgetTerminateNoticeContent,
  buildBudgetGraceToolBlockedNoticeContent,
} from '../index.js';
import type { IterationBudgetEvaluation } from '../../engine/guards/iteration-budget.js';

function makeEval(
  stage: 'warn' | 'grace' | 'terminate' | 'normal',
  trigger: 'iteration' | 'token' | null,
  current: number,
  max: number,
): IterationBudgetEvaluation {
  const channel: IterationBudgetEvaluation['iteration'] = {
    stage,
    current,
    max,
    percent: max > 0 ? current / max : 0,
    threshold: max,
    enabled: true,
  };
  const inactive: IterationBudgetEvaluation['iteration'] = {
    stage: 'normal',
    current: 0,
    max: 0,
    percent: 0,
    threshold: 0,
    enabled: false,
  };
  return {
    stage,
    trigger,
    iteration: trigger === 'iteration' ? channel : inactive,
    token: trigger === 'token' ? channel : inactive,
  };
}

describe('budget warn — user-facing notice (Chinese)', () => {
  it('iteration 70% triggers warn notice with 轮 unit', () => {
    const out = buildBudgetWarnNoticeContent(makeEval('warn', 'iteration', 14, 20));
    expect(out).toBe(
      '对话轮数已达 70%（14 / 20 轮）。Agent 已收到提示开始收口，请准备查看本轮总结。',
    );
  });

  it('token 85% triggers warn notice with tokens unit (en-US comma)', () => {
    const out = buildBudgetWarnNoticeContent(makeEval('warn', 'token', 85_000, 100_000));
    expect(out).toBe(
      'Token 用量已达 85%（85,000 / 100,000 tokens）。Agent 已收到提示开始收口，请准备查看本轮总结。',
    );
  });

  it('returns empty string outside warn stage', () => {
    expect(buildBudgetWarnNoticeContent(makeEval('grace', 'iteration', 18, 20))).toBe('');
    expect(buildBudgetWarnNoticeContent(makeEval('warn', null, 0, 0))).toBe('');
  });
});

describe('budget warn — LLM system injection (中文)', () => {
  it('iteration warn injection 中文', () => {
    const out = buildBudgetWarnSystemInjection(makeEval('warn', 'iteration', 14, 20));
    expect(out).toMatchInlineSnapshot(
      `"[系统 / 预算预警] 本次运行你已使用可用对话轮数的 70%。请开始收口：优先总结当前进展、完成手头正在进行的任务、给出简洁的最终答复，而不是分支进入新的探索。"`,
    );
  });

  it('token warn injection 中文 (full snapshot)', () => {
    const out = buildBudgetWarnSystemInjection(makeEval('warn', 'token', 85_000, 100_000));
    expect(out).toMatchInlineSnapshot(
      `"[系统 / 预算预警] 本次运行你已使用可用Token 用量的 85%。请开始收口：优先总结当前进展、完成手头正在进行的任务、给出简洁的最终答复，而不是分支进入新的探索。"`,
    );
  });

  it('returns empty string outside warn stage', () => {
    expect(buildBudgetWarnSystemInjection(makeEval('grace', 'iteration', 18, 20))).toBe('');
  });
});

describe('budget grace — user-facing notice (Chinese)', () => {
  it('grace iteration 90% says 本轮为最后一轮 + lists pending tasks', () => {
    const out = buildBudgetGraceNoticeContent(makeEval('grace', 'iteration', 18, 20));
    expect(out).toMatchInlineSnapshot(
      `"对话轮数已达 90%（18 / 20 轮）。本轮为最后一轮：Agent 不再调用工具，仅基于当前进展输出文字总结，并应列出仍需继续的任务，请等待本轮回复完成后查看。"`,
    );
  });

  it('returns empty string outside grace stage', () => {
    expect(buildBudgetGraceNoticeContent(makeEval('warn', 'iteration', 14, 20))).toBe('');
    expect(buildBudgetGraceNoticeContent(makeEval('terminate', 'iteration', 20, 20))).toBe('');
  });
});

describe('budget grace — LLM system injection (中文, 最后一轮)', () => {
  it('grace iteration injection 中文 不要调用工具 (full snapshot)', () => {
    const out = buildBudgetGraceSystemInjection(makeEval('grace', 'iteration', 18, 20));
    expect(out).toMatchInlineSnapshot(
      `"[系统 / 预算宽限轮] 你已使用可用对话轮数的 90%。这是本次运行的最后一轮。工具已被禁用——不要尝试调用任何工具。请立即基于你已知的信息给出简洁的最终答复：总结进展、列出仍需用户确认的开放问题，然后收尾。本轮回复后运行即终止。"`,
    );
  });

  it('returns empty string outside grace stage', () => {
    expect(buildBudgetGraceSystemInjection(makeEval('warn', 'iteration', 14, 20))).toBe('');
  });
});

describe('budget terminate — distinct from grace (no "summary promised" copy)', () => {
  it('terminate notice mentions "本轮未再调用模型" not "Agent 不再调用工具"', () => {
    const out = buildBudgetTerminateNoticeContent(makeEval('terminate', 'iteration', 20, 20));
    expect(out).toMatchInlineSnapshot(
      `"对话轮数已达 100%（20 / 20 轮）。本次对话已达上限，本轮未再调用模型；请查看上方既有结果，或基于现有进展新开一段会话继续。"`,
    );
    expect(out).not.toContain('本轮为最后一轮');
    expect(out).not.toContain('仅基于当前进展输出文字总结');
  });

  it('returns empty string outside terminate stage', () => {
    expect(
      buildBudgetTerminateNoticeContent(makeEval('grace', 'iteration', 18, 20)),
    ).toBe('');
  });
});

describe('budget grace tool-blocked — Chinese explanation', () => {
  it('mentions tool count and explains it is expected behaviour', () => {
    const out = buildBudgetGraceToolBlockedNoticeContent(3);
    expect(out).toBe(
      '本轮为最后一轮（已禁用工具），但模型仍尝试调用 3 个工具——已忽略，仅以文字回复为准。如发现总结不完整，可在新对话中继续。',
    );
  });
});
