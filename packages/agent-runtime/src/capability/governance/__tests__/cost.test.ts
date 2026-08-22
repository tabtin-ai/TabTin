/**
 * CostCap 单测 —— W2.2.3。
 *
 * 覆盖：
 *   1. type / category 静态契约（'cost' / 'governance'）
 *   2. tools() 返回空数组（hooks-only Cap 变体）
 *   3. instructions() 已下线（阶段 2.3，Capability.instructions?() 整接口删除）
 *   4. required_capability_types() 空集
 *   5. hooks() 返回非 null（与 AuditCap 在无 writer 时返回 null 对照）
 *   6. beforeIteration warning / error 阈值经 _convergenceHintBlock 注入 hint
 *      （：__tokenWarningState 死写已删，可观测为 convergence_hint）
 *   7. beforeIteration warning / error 阈值正确触发对应 hint
 *   8. beforeIteration normal 状态不注入 convergence_hint
 *   9. beforeIteration 写 contextPressure（：__context* 死写已删）
 *  10. beforeIteration 第一轮不写 _compactionForce（无 prev model）
 *  11. beforeIteration model 切换 + window 缩水 + 压力 ≥ 0.7 → _compactionForce
 *  12. beforeIteration model 切换但 window 增大 → 不强制 compaction
 *  13. afterIteration 累计 token >= maxTotal → requestForceFinal('tokens')
 *  14. afterIteration token 投影超限 → requestForceFinal('tokens_projected')
 *  15. afterIteration 累计 credit >= maxCredits → requestForceFinal('credits')
 *  16. afterIteration credit 投影超限 → requestForceFinal('credits_projected')
 *
 *  Phase 0：afterIteration 的收尾信号已从写 state.__force_final__ /
 * state.__budgetExceeded 黑板字段，改为调 ctx.requestForceFinal(reason) 显式通道。
 * 测试相应改为通过 makeIterationCtx 的 onForceFinal 回调捕获 reason。
 *  17. afterIteration 读本 run 增量的 state 扁平字段（，syncStateFromTracker 上游同步）
 *  18. afterIteration 本 run 增量未达上限不误杀前序 turn
 *  19. clone() 后 _prevModel / _prevWindow 重置 undefined
 *  20. resolveContextWindow 优先于 contextWindowTokens
 *  21. ctxWindow=0 时 beforeIteration 不写任何 token 字段（早 return）
 *  22. messages 为空时 beforeIteration 不写任何字段
 *  23. calculateTokenWarningState 单元（normal / warning / error / blocking）
 *  24. afterIteration 无 maxCredits 配置时不设 credits 墙
 */

import { describe, expect, it } from 'vitest';
import {
  CostCap,
  DEFAULT_MAX_CREDITS_PER_RUN,
  calculateTokenWarningState,
  type CostCapInit,
} from '../cost.js';
import {
  makeBeforeModelCtx,
  makeIterationCtx,
  sectionContent,
} from '../../__tests__/fixtures/fake-capabilities.js';
import { DEFAULT_MAX_TURNS } from '../../../runtime-defaults.js';
import type {
  Message,
} from '../../../engine/contracts/conversation.js';
import type {
  EngineState,
} from '../../../engine/contracts/kernel.js';
import {
  SYSTEM_SECTION_NAMES,
} from '../../../engine/contracts/wire-protocol.js';

// ─── helpers ────────────────────────────────────────────────────────

function makeMessages(count: number, charsPerMsg = 200): Message[] {
  const out: Message[] = [];
  const filler = 'x'.repeat(charsPerMsg);
  for (let i = 0; i < count; i++) {
    out.push({
      role: i % 2 === 0 ? 'user' : 'assistant',
      content: `msg-${i}-${filler}`,
    } as Message);
  }
  return out;
}

function makeState(overrides?: Partial<EngineState>): EngineState {
  return {
    model: 'claude-3-5-sonnet',
    iteration: 0,
    messages: [],
    totalInputTokens: 0,
    totalOutputTokens: 0,
    creditsCharged: 0,
    contextPressure: 0,
    ...overrides,
  } as unknown as EngineState;
}

function makeCap(init?: CostCapInit): CostCap {
  return new CostCap(init);
}

// ─── 静态契约 ────────────────────────────────────────────────────────

describe('产品默认与 UI / Django profile 对齐', () => {
  it('DEFAULT_MAX_TURNS = 500', () => {
    expect(DEFAULT_MAX_TURNS).toBe(500);
  });

  it('DEFAULT_MAX_CREDITS_PER_RUN = 1000', () => {
    expect(DEFAULT_MAX_CREDITS_PER_RUN).toBe(1000);
  });
});

describe('CostCap · 静态契约', () => {
  it('type = "cost"', () => {
    expect(makeCap().type).toBe('cost');
  });

  it('category = "governance"', () => {
    expect(makeCap().category).toBe('governance');
  });

  it('tools() 返回空数组', () => {
    expect(makeCap().tools()).toEqual([]);
  });

  it('required_capability_types() 空集', () => {
    expect(Array.from(makeCap().required_capability_types())).toEqual([]);
  });

  it('hooks() 即使无 writer / config 也返回非 null（区别于 AuditCap）', () => {
    expect(makeCap().hooks()).not.toBeNull();
  });
});

// ─── beforeIteration · token warning state ─────────────────────────

describe('CostCap · beforeIteration · token warning state', () => {
  it('低压力（normal）→ convergence_hint 不注入', async () => {
    const cap = makeCap({ contextWindowTokens: 200_000 });
    const h = cap.hooks()!;
    const state = makeState({ messages: makeMessages(5) });

    await h.beforeIteration!(makeIterationCtx(state, 0));
    const ctx = makeBeforeModelCtx(state);
    await h.beforeModel!(ctx);
    // ：__tokenWarningState 死写已删除（全库无消费者）。normal 的可观测
    // 效果是「不注入 convergence_hint」；warning state 分级由 calculateTokenWarningState
    // 单元测试覆盖。
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.convergence_hint)).toBeUndefined();
  });

  it('warning 阈值触发 → beforeModel 注入 warning hint', async () => {
    const cap = makeCap({ contextWindowTokens: 200_000 });
    const h = cap.hooks()!;
    const state = makeState({ messages: makeMessages(2) });
    state._lastUsageAnchor = { inputTokens: 155_000, messageCount: 2, timestamp: 0 };

    await h.beforeIteration!(makeIterationCtx(state, 0));
    const ctx = makeBeforeModelCtx(state);
    await h.beforeModel!(ctx);
    // ：warning 的可观测效果 = 注入 warning convergence_hint（__tokenWarningState 死写已删）。
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.convergence_hint)).toContain('上下文空间有限');
  });

  it('error 阈值触发 → beforeModel 注入 error hint', async () => {
    const cap = makeCap({ contextWindowTokens: 200_000 });
    const h = cap.hooks()!;
    const state = makeState({ messages: makeMessages(2) });
    state._lastUsageAnchor = { inputTokens: 165_000, messageCount: 2, timestamp: 0 };

    await h.beforeIteration!(makeIterationCtx(state, 0));
    const ctx = makeBeforeModelCtx(state);
    await h.beforeModel!(ctx);
    // ：error 的可观测效果 = 注入 error convergence_hint（__tokenWarningState 死写已删）。
    expect(sectionContent(ctx.sections, SYSTEM_SECTION_NAMES.convergence_hint)).toContain('已严重不足');
  });

  // ：原「blocking 阈值触发 → blocking state」用例只断言已删除的死写
  // state.__tokenWarningState。beforeIteration 对 blocking 无独立可观测副作用（不注入
  // convergence_hint），blocking 分级本身由下方 calculateTokenWarningState 单元测试
  // （`198_000, 200_000 → 'blocking'`）覆盖，故删除该用例。
});

describe('CostCap · calculateTokenWarningState 单元', () => {
  it('contextWindow ≤ 0 → normal', () => {
    expect(calculateTokenWarningState(50_000, 0)).toBe('normal');
  });

  it('正常区间', () => {
    expect(calculateTokenWarningState(100_000, 200_000)).toBe('normal');
  });

  it('warning / error / blocking 边界', () => {
    expect(calculateTokenWarningState(150_000, 200_000)).toBe('warning');
    expect(calculateTokenWarningState(160_000, 200_000)).toBe('error');
    expect(calculateTokenWarningState(198_000, 200_000)).toBe('blocking');
  });
});

// ─── beforeIteration · context pressure ────────────────────────────

// ：__contextPressureLevel / __contextEstimatedTokens /
// __contextWindowTokens 死写已删除，beforeIteration 只保留 state.contextPressure
// （真实压力比率）。原「压力分级 level」断言无可观测对象，改为断言 contextPressure
// 比率（同一份估算的直接产物，覆盖等价）。
describe('CostCap · beforeIteration · context pressure', () => {
  it('写 contextPressure（估算 token / 上下文窗口比率）', async () => {
    const cap = makeCap({ contextWindowTokens: 100_000 });
    const h = cap.hooks()!;
    const state = makeState({ messages: makeMessages(2) });
    state._lastUsageAnchor = { inputTokens: 60_000, messageCount: 2, timestamp: 0 };

    await h.beforeIteration!(makeIterationCtx(state, 0));
    expect(state.contextPressure).toBeCloseTo(0.6, 4);
  });

  it('压力比率随 token 上升（原 low/medium/high/critical 分级边界）', async () => {
    const cap = makeCap({ contextWindowTokens: 100_000 });
    const h = cap.hooks()!;
    const cases: Array<{ tokens: number; pressure: number }> = [
      { tokens: 30_000, pressure: 0.3 },
      { tokens: 60_000, pressure: 0.6 },
      { tokens: 75_000, pressure: 0.75 },
      { tokens: 90_000, pressure: 0.9 },
    ];
    for (const { tokens, pressure } of cases) {
      const state = makeState({ messages: makeMessages(2) });
      state._lastUsageAnchor = { inputTokens: tokens, messageCount: 2, timestamp: 0 };
      await h.beforeIteration!(makeIterationCtx(state, 0));
      expect(state.contextPressure).toBeCloseTo(pressure, 4);
    }
  });

  it('messages 为空时不写 contextPressure', async () => {
    const cap = makeCap({ contextWindowTokens: 100_000 });
    const h = cap.hooks()!;
    const state = makeState();
    await h.beforeIteration!(makeIterationCtx(state, 0));
    expect(state.contextPressure).toBe(0);
  });

  it('contextWindow=0 时不写 contextPressure', async () => {
    const cap = makeCap({ contextWindowTokens: 0 });
    const h = cap.hooks()!;
    const state = makeState({ messages: makeMessages(2) });
    await h.beforeIteration!(makeIterationCtx(state, 0));
    expect(state.contextPressure).toBe(0);
  });
});

// ─── beforeIteration · model switch protection ─────────────────────

describe('CostCap · beforeIteration · model 切换保护', () => {
  // ：黑板逃生舱 __compactionForce 收敛为 EngineState 显式字段
  // _compactionForce（single-shot，query.ts compaction 路径消费并清除）。
  it('第一轮无 prevModel → 不写 _compactionForce', async () => {
    const cap = makeCap({ contextWindowTokens: 100_000 });
    const h = cap.hooks()!;
    const state = makeState({ messages: makeMessages(2) });
    state._lastUsageAnchor = { inputTokens: 80_000, messageCount: 2, timestamp: 0 };

    await h.beforeIteration!(makeIterationCtx(state, 0));
    expect(state._compactionForce).toBeUndefined();
  });

  it('model 切换 + window 缩水 + 压力 ≥ 0.7 → _compactionForce=true', async () => {
    const resolveContextWindow = (m: string): number =>
      m === 'small-model' ? 50_000 : 200_000;
    const cap = makeCap({ resolveContextWindow });
    const h = cap.hooks()!;

    const state = makeState({
      model: 'big-model',
      messages: makeMessages(2),
    });
    // 第一轮锚点：100k tokens / 200k window → 50% 压力
    state._lastUsageAnchor = { inputTokens: 100_000, messageCount: 2, timestamp: 0 };
    await h.beforeIteration!(makeIterationCtx(state, 0));
    expect(state._compactionForce).toBeUndefined();

    // 第二轮切到 small-model（50k window） → tokens 仍 100k → 压力 100%
    state.model = 'small-model';
    await h.beforeIteration!(makeIterationCtx(state, 1));
    expect(state._compactionForce).toBe(true);
  });

  it('model 切换但 window 增大 → 不强制 compaction', async () => {
    const resolveContextWindow = (m: string): number =>
      m === 'big-model' ? 200_000 : 100_000;
    const cap = makeCap({ resolveContextWindow });
    const h = cap.hooks()!;

    const state = makeState({
      model: 'small-model',
      messages: makeMessages(2),
    });
    state._lastUsageAnchor = { inputTokens: 80_000, messageCount: 2, timestamp: 0 };
    await h.beforeIteration!(makeIterationCtx(state, 0));
    state.model = 'big-model';
    await h.beforeIteration!(makeIterationCtx(state, 1));
    expect(state._compactionForce).toBeUndefined();
  });

  it('resolveContextWindow 优先于 contextWindowTokens', async () => {
    const cap = makeCap({
      contextWindowTokens: 100_000,
      resolveContextWindow: () => 200_000,
    });
    const h = cap.hooks()!;
    const state = makeState({ messages: makeMessages(2) });
    state._lastUsageAnchor = { inputTokens: 100_000, messageCount: 2, timestamp: 0 };
    await h.beforeIteration!(makeIterationCtx(state, 0));
    // ：__contextWindowTokens / __contextPressureLevel 死写已删，
    // 走 resolve 返回的 200k → 100k/200k = 0.5，可观测为 contextPressure。
    expect(state.contextPressure).toBeCloseTo(0.5, 4);
  });
});

// ─── afterIteration · token / credit 累积超限 ──────────────────────

describe('CostCap · afterIteration · token budget', () => {
  it('累计 token >= max → __force_final__ + tokens', async () => {
    const cap = makeCap({ config: { max_total_tokens: 1000 } });
    const h = cap.hooks()!;
    const state = makeState({ totalInputTokens: 600, totalOutputTokens: 500 });

    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('tokens');
  });

  it('token 投影超限 → tokens_projected', async () => {
    const cap = makeCap({ config: { max_total_tokens: 1000 } });
    const h = cap.hooks()!;
    // iteration=4: avg = 800/5 = 160；800+160 = 960 < 1000？等等 — 让我重新算
    // 投影分支：iteration > 0 && totalTokens + avgPerIteration > maxTokens
    // → iteration=2 时 avg = 800/3 = 266.67；800+266.67 = 1066.67 > 1000 ✓
    const state = makeState({ totalInputTokens: 500, totalOutputTokens: 300 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 2, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('tokens_projected');
  });

  it('未达上限 → 不请求 force_final', async () => {
    const cap = makeCap({ config: { max_total_tokens: 10_000 } });
    const h = cap.hooks()!;
    const state = makeState({ totalInputTokens: 100, totalOutputTokens: 100 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBeUndefined();
  });

  it('无 max_total_tokens 配置 → 不检查 token', async () => {
    const cap = makeCap();
    const h = cap.hooks()!;
    const state = makeState({ totalInputTokens: 1_000_000 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBeUndefined();
  });
});

describe('CostCap · afterIteration · credits budget', () => {
  it('累计 credit >= max → __force_final__ + credits', async () => {
    const cap = makeCap({
      config: { execution_limits: { max_credits_per_run: 1.0 } },
    });
    const h = cap.hooks()!;
    const state = makeState({ creditsCharged: 1.5 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('credits');
  });

  it('credit 投影超限 → credits_projected', async () => {
    const cap = makeCap({
      config: { execution_limits: { max_credits_per_run: 1.0 } },
    });
    const h = cap.hooks()!;
    // iteration=2: avg = 0.8/3 = 0.267；0.8+0.267 > 1.0
    const state = makeState({ creditsCharged: 0.8 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 2, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('credits_projected');
  });

  it('无 max_credits_per_run 配置 → 不设 credits 墙', async () => {
    const cap = makeCap();
    const h = cap.hooks()!;
    // 远超旧产品默认 1000 → 仍不硬停（未启用执行限制）
    const state = makeState({ creditsCharged: 5000 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBeUndefined();
  });

  it('显式 max_credits_per_run → 按配置硬停', async () => {
    const cap = makeCap({
      config: { execution_limits: { max_credits_per_run: 1000 } },
    });
    const h = cap.hooks()!;
    const state = makeState({ creditsCharged: 5000 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('credits');
  });
});

// ─── 本 run 增量语义 ───────────────────────────────────────
//
// CostCap 只读 state 扁平字段（totalInputTokens / totalOutputTokens /
// creditsCharged）。这些字段由 syncStateFromTracker 在每个 usage chunk 写成
// 「本 run 增量」（根 query = getAccumulated − _budgetRunBaseline，子 query =
// per-scope，无 tracker = 从 0 累加）。前序 turn 的累计不会进入这里，故同
// session 第二条消息不再被 max_credits_per_run / max_total_tokens 误杀。
describe('CostCap · afterIteration · 本 run 增量语义', () => {
  it('本 run token 增量未达上限 → 不触发（前序 turn 不计入）', async () => {
    const cap = makeCap({ config: { max_total_tokens: 1000 } });
    const h = cap.hooks()!;
    // 前序 turn 已消耗 900，但 syncStateFromTracker 只把本 run 的 200 写进 state
    const state = makeState({ totalInputTokens: 100, totalOutputTokens: 100 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBeUndefined();
  });

  it('本 run credits 增量未达上限 → 不触发（前序 turn 不计入）', async () => {
    const cap = makeCap({
      config: { execution_limits: { max_credits_per_run: 50 } },
    });
    const h = cap.hooks()!;
    // 前序 turn 已消耗 30 credits，本 run 仅 25
    const state = makeState({ creditsCharged: 25 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBeUndefined();
  });

  it('本 run token 增量达上限仍触发', async () => {
    const cap = makeCap({ config: { max_total_tokens: 1000 } });
    const h = cap.hooks()!;
    const state = makeState({ totalInputTokens: 500, totalOutputTokens: 600 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('tokens');
  });

  it('本 run credits 增量达上限仍触发', async () => {
    const cap = makeCap({
      config: { execution_limits: { max_credits_per_run: 1.0 } },
    });
    const h = cap.hooks()!;
    const state = makeState({ creditsCharged: 2.0 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('credits');
  });
});

// ─── clone 行为 ──────────────────────────────────────────────────────

describe('CostCap · clone() 行为', () => {
  it('clone 后 _prevModel / _prevWindow 重置 undefined', async () => {
    const resolveContextWindow = (m: string): number =>
      m === 'small' ? 50_000 : 200_000;
    const cap = makeCap({ resolveContextWindow });
    const h = cap.hooks()!;
    const state = makeState({ model: 'big', messages: makeMessages(2) });
    state._lastUsageAnchor = { inputTokens: 100_000, messageCount: 2, timestamp: 0 };
    await h.beforeIteration!(makeIterationCtx(state, 0)); // 设 _prevModel='big' / _prevWindow=200k

    const cloned = cap.clone();
    const clonedH = cloned.hooks()!;
    const newState = makeState({ model: 'small', messages: makeMessages(2) });
    newState._lastUsageAnchor = { inputTokens: 40_000, messageCount: 2, timestamp: 0 };
    // 若 _prevModel 没重置，会被错认为 model 切换 + window 缩水 → 误触
    // _compactionForce。clone 重置后第一轮等同 fresh session。
    await clonedH.beforeIteration!(makeIterationCtx(newState, 0));
    expect(newState._compactionForce).toBeUndefined();
  });

  it('clone 保留 _config（budget 上限仍生效）', async () => {
    const cap = makeCap({ config: { max_total_tokens: 1000 } });
    const cloned = cap.clone();
    const h = cloned.hooks()!;
    const state = makeState({ totalInputTokens: 600, totalOutputTokens: 500 });
    let forceFinal: string | undefined;
    await h.afterIteration!(makeIterationCtx(state, 0, (r) => { forceFinal = r; }));
    expect(forceFinal).toBe('tokens');
  });
});
