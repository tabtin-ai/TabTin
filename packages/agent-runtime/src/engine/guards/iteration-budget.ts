/**
 * FR-15 — IterationBudget + Grace Call.
 *
 * 让长任务在迭代 / token 预算到达上限前**优雅终止**——不再硬断
 * `MAX_TURNS_EXCEEDED` 报错，而是在到达上限的最后一轮强制 LLM 做总结
 * （grace call），完成后以 `error: false` + `error_class:
 * 'iteration_budget_exhausted' | 'token_budget_exhausted'` 退出。
 *
 * ### 双通路兜底（PRD Q3 决策 E）
 *
 * 引擎同时跟踪两个独立信号：
 *   - **iteration**：当前迭代号 / `EngineConfig.maxTurns` 比例
 *     （默认 warn 70% / grace 90% / terminate 100%）。
 *   - **token**：`BudgetTracker.maxTotalTokens` 累计 token 比例
 *     （默认 warn 85% / grace 95% / terminate 100%）。
 *
 * 任一通路推进到更高阶段都立即生效——iteration 是粗信号（轮数有限），
 * token 是精信号（按实际消耗），互为兜底。同 stage 时 iteration 优先
 * （展示给用户的"轮数"比"token 用量"更易理解，且 iteration 是离散计数
 * 更好对账）。
 *
 * ### 状态机
 *
 * `normal → warn → grace → terminate` 单调递增。一旦推到某个阶段：
 *
 * - **warn**：注入一条 system_notice + system prompt hint
 *   "预算紧张，准备总结"，让 Agent 知道收口；正常调 LLM。
 * - **grace**：注入"仅做最后总结，不调任何工具"指令；调 LLM 时
 *   **完全清空 tool 列表**（D3 决策硬约束）；LLM 输出后强制走 DONE。
 * - **terminate**：不再调 LLM，直接发 DONE，`error: false`。
 *
 * 通常路径是 normal → warn → grace → DONE（grace 完成路径，
 * `error_class` 仍写入便于前端展示"已完成（达上限）"）。terminate 仅在
 * grace 跳过的边缘情形（如 BudgetTracker 在轮内突变把 token 推到 100%
 * 而 iteration 仍在 warn）兜底。
 *
 * ### 与其他保险的边界
 *
 * | 触发器 | 触发位置 | 作用范围 | 关系 |
 * |---|---|---|---|
 * | `MAX_TURNS_EXCEEDED` (DEFAULT_MAX_TURNS) | 主循环末尾 | iteration 硬上限 | IterationBudget terminate 在主循环顶部更早触发；MAX_TURNS 仅作未配置 IterationBudget 时的最后兜底 |
 * | `MAX_CREDITS_EXCEEDED` (BudgetTracker exhausted) | 主循环工具执行后 | token + credits | 同上：IterationBudget terminate 在顶部更早触发；BudgetTracker.isExhausted 仍兜底 hard cap |
 * | DoomLoop terminate | 主循环末尾 (H1-B1 段) | 重复工具调用 | 行为异常优先：DoomLoop terminate 在末尾消费时本轮已 break，不会进入下一轮 IterationBudget 顶部检查 |
 *
 * ### 配置默认值
 *
 * `DEFAULT_ITERATION_BUDGET`（PRD §5.2 FR-15 + Q3）。所有阈值都是
 * 0–1 的小数（**比例**而非绝对值）：`warn: 0.7` 表示"达到 maxTurns
 * 70% 时进入 warn 阶段"。这与编程惯例一致，env override 也用小数。
 *
 * ### 设计不变量
 *
 * - **纯函数**：`evaluateIterationBudget` 不读不写任何外部状态，
 *   不发埋点；调用方（query.ts）拿到结果后负责发 telemetry / 注入
 *   system prompt。
 * - **idempotent**：同样输入永远返回同样输出。
 * - **defensive**：阈值非法值（NaN / 负数 / 越界）由
 *   `normalizeIterationBudgetConfig` 在配置归一化阶段就回落到默认，
 *   evaluate 假定输入永远是合法的。
 */

export type IterationBudgetTrigger = 'iteration' | 'token';

export type IterationBudgetStage = 'normal' | 'warn' | 'grace' | 'terminate';

export interface IterationBudgetThresholds {
  /** 进入 warn 阶段的比例（0–1，相对 max）。 */
  warn: number;
  /** 进入 grace 阶段的比例。必须 > warn。 */
  grace: number;
  /** 进入 terminate 阶段的比例。必须 > grace；通常固定为 1.0。 */
  terminate: number;
}

export interface IterationBudgetConfig {
  iteration: IterationBudgetThresholds;
  token: IterationBudgetThresholds;
}

/**
 * 单通路的评估结果——便于 telemetry / 调试时按通路分别看用量。
 */
export interface IterationBudgetChannelEval {
  stage: IterationBudgetStage;
  /** 当前消耗（iteration 通路是 iteration 号，token 通路是累计 token 数）。 */
  current: number;
  /** 当前 stage 的绝对触发阈值（如 grace 时是 max * grace 比例）。 */
  threshold: number;
  /** `current / max`；max 为 0/Infinity 时为 0。 */
  percent: number;
  /** 上限本身——便于 telemetry 展示"X / Y"格式。 */
  max: number;
  /** 该通路是否启用（max 有限）。无限/未配置时 enabled=false 且 stage 永远是 normal。 */
  enabled: boolean;
}

export interface IterationBudgetEvaluation {
  /** 双通路合并后的最终阶段（取较高者；同高 iteration 优先）。 */
  stage: IterationBudgetStage;
  /**
   * 触发当前 stage 的通路；`stage='normal'` 时为 `null`。
   *
   * 仅记录"决定 stage 的"通路；若两通路同 stage，优先记 iteration。
   */
  trigger: IterationBudgetTrigger | null;
  /** iteration 通路明细。 */
  iteration: IterationBudgetChannelEval;
  /** token 通路明细。 */
  token: IterationBudgetChannelEval;
}

// ─── Defaults ────────────────────────────────────────────────────────

/**
 * PRD §5.2 FR-15 + Q3 决策 E 的默认值。
 *
 * iteration 触发更早（70% 就 warn）是因为迭代是粗粒度信号，留 30%
 * 空间让 Agent 收尾足够。token 更晚（85% 才 warn）因为 token 用量
 * 通常更可控，过早 warn 会打扰大段输出场景。
 */
export const DEFAULT_ITERATION_BUDGET: IterationBudgetConfig = {
  iteration: { warn: 0.7, grace: 0.9, terminate: 1.0 },
  token: { warn: 0.85, grace: 0.95, terminate: 1.0 },
};

const STAGE_RANK: Record<IterationBudgetStage, number> = {
  normal: 0,
  warn: 1,
  grace: 2,
  terminate: 3,
};

// ─── Configuration normalization ─────────────────────────────────────

/**
 * 归一化用户传入的（可能不完整 / 含非法值的）配置到一个合法
 * `IterationBudgetConfig`。
 *
 * 规则：
 * - 缺省字段 → 取默认值。
 * - 单值非法（NaN / 非数字 / ≤0 / >1）→ 该单值取默认值。
 * - 单通路阈值不满足 `warn < grace ≤ terminate ≤ 1` → 整通路回落到默认值
 *   （而非局部修复——避免"修一半"产生反直觉行为）。
 * - 永远不抛错（host 启动期错配不该让 runtime 崩）。
 *
 * **不**做的事：
 * - 不发 console.warn（host-knobs 层负责 env 校验时已经 warn 过）。
 * - 不强制 terminate=1.0（用户若显式传 terminate=0.95 也允许，但需要
 *   warn < grace < terminate 的约束仍然满足）。
 */
export function normalizeIterationBudgetConfig(
  raw: Partial<IterationBudgetConfig> | undefined,
): IterationBudgetConfig {
  return {
    iteration: normalizeChannelThresholds(
      raw?.iteration,
      DEFAULT_ITERATION_BUDGET.iteration,
    ),
    token: normalizeChannelThresholds(
      raw?.token,
      DEFAULT_ITERATION_BUDGET.token,
    ),
  };
}

function normalizeChannelThresholds(
  raw: Partial<IterationBudgetThresholds> | undefined,
  fallback: IterationBudgetThresholds,
): IterationBudgetThresholds {
  const warn = sanitizeThreshold(raw?.warn, fallback.warn);
  const grace = sanitizeThreshold(raw?.grace, fallback.grace);
  const terminate = sanitizeThreshold(raw?.terminate, fallback.terminate);
  // 不变量：warn < grace ≤ terminate ≤ 1。任何违反都整通路回落
  // 默认——避免局部修复（如把 grace 抬到 warn+0.01）产生
  // 反直觉的"我配置了 0.5/0.4/1.0，结果生效的不是 0.5"。
  if (!(warn > 0 && warn < grace && grace <= terminate && terminate <= 1)) {
    return { ...fallback };
  }
  return { warn, grace, terminate };
}

function sanitizeThreshold(value: unknown, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  if (value <= 0 || value > 1) return fallback;
  return value;
}

// ─── Evaluation ──────────────────────────────────────────────────────

export interface EvaluateIterationBudgetParams {
  /**
   * 当前迭代号（0-based）。**注意**：这是 query.ts 主循环 `state.iteration`
   * 的语义，即"已完成的 iteration 数"——iteration=0 表示第 0 轮即将开始；
   * iteration=10 表示已经完成 10 轮、即将开始第 11 轮。
   *
   * 评估时按"已完成轮数"判断：iteration=70 + maxTurns=100 ⇒ percent=0.7 ⇒ warn。
   * 这与 query.ts 现有 `state.iteration >= maxTurns` 触发 MAX_TURNS_EXCEEDED 的语义对齐。
   */
  iteration: number;
  /** `EngineConfig.maxTurns ?? DEFAULT_MAX_TURNS`。 */
  maxTurns: number;
  /** 已累计的总 token（`state.totalInputTokens + state.totalOutputTokens`）。 */
  totalTokens: number;
  /**
   * `BudgetTracker.maxTotalTokens` 上限。**Infinity / 0 / 负数 / NaN** 表示
   * 该通路未启用——evaluate 会把它当 disabled，永远返回 stage='normal'。
   */
  maxTotalTokens: number;
  /** 已归一化的配置（应该是 `normalizeIterationBudgetConfig` 的输出）。 */
  config: IterationBudgetConfig;
}

/**
 * 评估当前轮次的预算阶段。
 *
 * 返回的 `stage` 是双通路合并值；`trigger` 是触发该 stage 的通路；
 * `iteration` / `token` 是各自通路的完整明细（即使没触发 stage 升级
 * 也带 percent / threshold，便于 telemetry 全量观测）。
 */
export function evaluateIterationBudget(
  params: EvaluateIterationBudgetParams,
): IterationBudgetEvaluation {
  const iterationEval = evaluateChannel(
    params.iteration,
    params.maxTurns,
    params.config.iteration,
  );
  const tokenEval = evaluateChannel(
    params.totalTokens,
    params.maxTotalTokens,
    params.config.token,
  );

  // 取较高者；同 stage 时 iteration 优先（更直观）。
  const iterRank = STAGE_RANK[iterationEval.stage];
  const tokenRank = STAGE_RANK[tokenEval.stage];

  if (iterRank === 0 && tokenRank === 0) {
    return {
      stage: 'normal',
      trigger: null,
      iteration: iterationEval,
      token: tokenEval,
    };
  }

  const trigger: IterationBudgetTrigger =
    iterRank >= tokenRank ? 'iteration' : 'token';
  const stage = trigger === 'iteration' ? iterationEval.stage : tokenEval.stage;

  return { stage, trigger, iteration: iterationEval, token: tokenEval };
}

function evaluateChannel(
  rawCurrent: number,
  rawMax: number,
  thresholds: IterationBudgetThresholds,
): IterationBudgetChannelEval {
  // disabled：未配置上限或上限非法值（Infinity / NaN / ≤0）。
  // 这种情况下该通路永远 normal，不参与 stage 计算。
  const enabled = Number.isFinite(rawMax) && rawMax > 0;
  if (!enabled) {
    const safeCurrent = Number.isFinite(rawCurrent)
      ? Math.max(0, rawCurrent)
      : 0;
    return {
      stage: 'normal',
      current: safeCurrent,
      threshold: 0,
      percent: 0,
      max: Number.isFinite(rawMax) ? Math.max(0, rawMax) : 0,
      enabled: false,
    };
  }

  const current = Number.isFinite(rawCurrent) ? Math.max(0, rawCurrent) : 0;
  const max = rawMax;
  const percent = current / max;

  let stage: IterationBudgetStage = 'normal';
  let threshold = 0;
  if (percent >= thresholds.terminate) {
    stage = 'terminate';
    threshold = max * thresholds.terminate;
  } else if (percent >= thresholds.grace) {
    stage = 'grace';
    threshold = max * thresholds.grace;
  } else if (percent >= thresholds.warn) {
    stage = 'warn';
    threshold = max * thresholds.warn;
  }

  return { stage, current, threshold, percent, max, enabled };
}

// ─── Stage transition helpers ────────────────────────────────────────

/**
 * 判断本轮评估相对"上次已通知阶段"是否产生**升级**——只有升级才需要发
 * notice / 注入新指令；否则属于"已经在 grace 中再评估一次仍是 grace"
 * 的情形，避免重复 noise。
 *
 * 单调递增设计：阶段一旦推到 grace 就不会回 warn 或 normal（即使
 * 下轮 token 用量奇迹般减少——这种场景在 ReAct 主循环里不会发生，
 * iteration 单调递增、token 也单调递增）。
 */
export function isStageUpgrade(
  previous: IterationBudgetStage | undefined,
  current: IterationBudgetStage,
): boolean {
  const prevRank = STAGE_RANK[previous ?? 'normal'];
  const currentRank = STAGE_RANK[current];
  return currentRank > prevRank;
}

// ─── User-facing copy（system_notice + system prompt 注入）─────────────
//
// E1 资源化：5 个 builder 已迁到
// `packages/agent-runtime/src/prompts/engine/budget-notices.ts`，
// SSoT 由 prompts/ 持有；本处仅 re-export 给历史消费者沿用旧导入路径。
export {
  buildBudgetWarnNoticeContent,
  buildBudgetWarnSystemInjection,
  buildBudgetGraceNoticeContent,
  buildBudgetGraceSystemInjection,
  buildBudgetTerminateNoticeContent,
  buildBudgetGraceToolBlockedNoticeContent,
} from '../../prompts/engine/budget-notices.js';

// ─── DONE error_class mapping ────────────────────────────────────────

/**
 * 把通路转成 DONE event 的 `error_class` 字段值。
 *
 * 这是**新增**的 error_class 值（不在 `AgentErrorCode` 枚举里），
 * 与 PRD §5.2 FR-15 验收标准一致：
 *
 *   - `'iteration_budget_exhausted'` — iteration 通路达到 terminate
 *   - `'token_budget_exhausted'` — token 通路达到 terminate
 *
 * 与 stream.ts `StreamDoneSchema.error_class` 的关系：schema 里 error_class
 * 是松散字符串（passthrough），新增枚举值不破坏老消费者；前端按已知值
 * 走分支，未知值落 default 文案。
 */
export function budgetTriggerToErrorClass(
  trigger: IterationBudgetTrigger,
): 'iteration_budget_exhausted' | 'token_budget_exhausted' {
  return trigger === 'iteration'
    ? 'iteration_budget_exhausted'
    : 'token_budget_exhausted';
}

/**
 * `error_class` → 中文 suggested_action 映射（FR-06 兼容）。
 *
 * 文案故意短，给前端 i18n / PM 文案表覆盖留余地（与 query.ts
 * `ERROR_CLASS_SUGGESTED_ACTION` 同一风格）。
 */
export function suggestedActionForBudgetExhausted(
  trigger: IterationBudgetTrigger,
): string {
  return trigger === 'iteration'
    ? '本次对话已达最大轮数。可基于当前结果继续追问，或新开会话重新开始。'
    : '本次对话已达 Token 用量上限。可基于当前结果继续追问，或新开会话重新开始。';
}
