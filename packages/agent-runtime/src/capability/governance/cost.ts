/**
 * CostCap —— Governance Capability：合并 BudgetTracker / token-budget /
 * context-pressure 三件套行为，把"成本压力"（token 累积 + credits +
 * context window 压力）统一为一个全生命周期 hooks 型 Capability。
 *
 * **W2.2.3 范围**（D-tech-5 / D-tech-8 + W2.1.0 §2 决议）：
 *   - 全生命周期 hooks 模板：beforeIteration（context window 警告 +
 *     convergence hint）+ afterIteration（token / credits 累积超限检查 →
 *     `ctx.requestForceFinal(reason)`）。
 *   - **D-tech-5 合并 BudgetTracker**：6 字段 BudgetTracker 已是 token /
 *     cost 的 SSoT 单源，CostCap 只是"读视图 + 超限判定"的消费方，不另
 *     维护内部计数器。
 *   - **合并 context-pressure**：harness 推荐"成本压力 = token + credit +
 *     context window"统一在 CostCap 内。原 createContextPressureMonitor
 *     的 4 级压力分类（low/medium/high/critical）+ model 切换强制 compaction
 *     全部继承。
 *   - **不合并 doom-loop**：D-tech-6 拍板 DoomLoopCap 整段砍出本期，归
 *     后续 Harness 专题。CostCap 与 doom-loop 正交。
 *
 * **职责边界**：
 *   - 做：每轮估 token / 算 context 压力 / 注入 convergence hint / 判超限 /
 *     经 `ctx.requestForceFinal(reason)` 请求 force-final + 设 `_compactionForce`
 *   - 不做：实际 compaction 编排（compaction-orchestrator 的事）/ 计数器
 *     维护（BudgetTracker SSoT）/ doom-loop 检测 / 审批（外层 v3 judge）
 *
 * **配置来源**（W2.3 装配时注入）：
 *   - `agent_config.capabilities.overrides.cost.execution_limits`
 *     - `max_iterations_per_run`（CostCap **不消费**——这是 query.ts
 *       maxTurns 直接消费的字段，CostCap 不重复，仅作为配置持有方）
 *     - `max_credits_per_run` → CostCap 消费；缺省 / null → **不设 credits 墙**
 *       （；`DEFAULT_MAX_CREDITS_PER_RUN` 仅作 UI 启用时的推荐初值）
 *   - 宿主层另传：
 *     - `contextWindowTokens` / `resolveContextWindow`（按当前 model
 *       动态解析）
 *
 * **永久规则**：本 Cap 不为 Harness / TabMemo / AdminDash / 移动端等"后续
 * 专题"加任何 fallback / 防御性代码（详见总控 §F6）。
 */

import type {
  Tool,
} from '../../engine/contracts/tools.js';
import type {
  ContextBudget,
} from '../../engine/contracts/context-capability.js';
import type {
  EngineHooks,
  IterationHookContext,
} from '../../engine/contracts/kernel.js';
import {
  SYSTEM_SECTION_NAMES,
} from '../../engine/contracts/wire-protocol.js';
import {
  DEFAULT_CONTEXT_BUDGET,
} from '../../engine/contracts/context-capability.js';
import type { CapabilityCategory } from '../capability.js';
import { CapabilityBase } from '../base.js';
import {
  estimateTokensWithAnchor,
  type TokenEstimator,
} from '../../engine/context/token-budget.js';
// ─── 警告状态 / 压力分级 ────────────────────────────────────────────

/**
 * Token 警告状态——与原 `middleware/token-budget.ts` 的同名枚举语义一致：
 *
 * - `normal`:   pressure < warning threshold
 * - `warning`:  approaching autocompact threshold (`warningBufferTokens` 缓冲)
 * - `error`:    very close to autocompact threshold (`errorBufferTokens` 缓冲)
 * - `blocking`: beyond effective window minus `blockingReserveTokens`
 *
 *  Phase 3：`warningState` 只用于本地选择 convergence hint 文案；历史上
 * 曾写入 `state.__tokenWarningState` 供旁路观测，但全库无消费者，已删除该死写。
 */
export type TokenWarningState = 'normal' | 'warning' | 'error' | 'blocking';

/**
 * Context 压力级别——与原 `middleware/context-pressure.ts` 的同名枚举语义
 * 一致：
 *
 * - `< 0.5`   low      —— 正常
 * - `0.5–0.7` medium   —— 开始注意
 * - `0.7–0.85` high    —— 建议压缩
 * - `> 0.85`  critical —— 必须压缩
 */
export type PressureLevel = 'low' | 'medium' | 'high' | 'critical';

export function calculateTokenWarningState(
  estimatedTokens: number,
  contextWindowTokens: number,
  budget?: Partial<ContextBudget>,
): TokenWarningState {
  if (contextWindowTokens <= 0) return 'normal';

  const b = { ...DEFAULT_CONTEXT_BUDGET, ...budget };
  const autoCompactThreshold = Math.floor(contextWindowTokens * b.compactThreshold);
  const blockingLimit = contextWindowTokens - b.blockingReserveTokens;

  if (estimatedTokens >= blockingLimit) return 'blocking';
  if (estimatedTokens >= autoCompactThreshold - b.errorBufferTokens) return 'error';
  if (estimatedTokens >= autoCompactThreshold - b.warningBufferTokens) return 'warning';
  return 'normal';
}

// ─── Convergence hint（与原 token-budget 的 hint 字符串一致） ───────
//
// E1 资源化：CONVERGENCE_HINT_WARNING / CONVERGENCE_HINT_ERROR 已迁到
// `packages/agent-runtime/src/prompts/capability/convergence-hints.ts`，
// SSoT 由 prompts/ 持有；本处通过 import 复用。
import {
  CONVERGENCE_HINT_WARNING,
  CONVERGENCE_HINT_ERROR,
} from '../../prompts/capability/convergence-hints.js';

// ─── 配置 ───────────────────────────────────────────────────────────

/**
 * v2 `capabilities.overrides.cost.execution_limits` 的形状（与 Django
 * `agent_config_v2.build_default_agent_config_v2()` 对齐）。
 *
 * **字段语义**：
 *   - `max_iterations_per_run`: **CostCap 不消费**——这是 query.ts maxTurns
 *     直接读取的字段，由宿主装配阶段把 v2 字段映射成 `EngineConfig.maxTurns`。
 *     在 CapConfig 里保留只是为了集中持有 v2 子树形状，便于宿主装配读取
 *     （历史上还用于派生 instructions 软提示，阶段 2.3 已下线）。
 *   - `max_credits_per_run`: 单次 run 累积 credits 上限。超限经
 *     `ctx.requestForceFinal('credits')`。缺省 / null / 非正数 → 跳过
 *     credits 墙；UI 启用执行限制时才写入显式正数。
 */
export interface CostCapExecutionLimits {
  max_iterations_per_run?: number | null;
  max_credits_per_run?: number | null;
}

export { DEFAULT_MAX_CREDITS_PER_RUN } from '../../runtime-defaults.js';

export interface CostCapConfig {
  /** v2 `capabilities.overrides.cost.execution_limits` 子树。 */
  execution_limits?: CostCapExecutionLimits;
  /**
   * Token 累积上限 —— 与 credits 不同维度。当前 v2 形状里没有此字段，
   * 但保留以便宿主层手动注入（如对 dogfood 测试 cap 5M token）。
   *
   * **关于"max_total_tokens 不在 v2 SSoT"**：W2.1.0 §2 决议没把它列入
   * v2 字段，因为业务上"成本"主要由 credits 表达。这里保留 hook 方便
   * 调试 / future-proof，但不强制宿主装配传。
   */
  max_total_tokens?: number;
}

// ─── 初始化参数 ─────────────────────────────────────────────────────

export interface CostCapInit {
  config?: CostCapConfig;
  /**
   * 静态 context window 大小（tokens）—— 配合 model 切换 fallback 用。
   * 优先级：`resolveContextWindow(state.model)` > `contextWindowTokens` > 0。
   */
  contextWindowTokens?: number;
  /**
   * 动态 resolver——按 `state.model` 解析 context window。每轮都调，
   * 必须快（O(1) lookup table）。缺省走静态 `contextWindowTokens`。
   */
  resolveContextWindow?: (model: string) => number;
  /** Token 估算器（按 model family 校准过的）。缺省走 estimateTokens 内置 4/3 系数。 */
  estimator?: TokenEstimator;
  /** ContextBudget override（warningBufferTokens / errorBufferTokens 等）。缺省 DEFAULT_CONTEXT_BUDGET。 */
  contextBudget?: Partial<ContextBudget>;
}

// ─── 预算越界判定（纯函数：返回 reason 或 null，不写 state） ──────────
//
//  Phase 2：三个 helper 从「写 `__force_final__` + `__budgetExceeded`
// 黑板」改为返回 reason 字符串（未越界 → null），由 afterIteration hook 汇总后
// 经 `IterationHookContext.requestForceFinal(reason)` 写入 force_final 显式通道。
// 判定逻辑与 reason 取值逐字不变，仅换信号载体，保持纯函数可测。

function projectedBudgetExceededReason(
  iteration: number,
  currentTotal: number,
  maxTotal: number,
  exceeded: 'tokens_projected' | 'credits_projected',
): string | null {
  if (iteration <= 0) return null;
  const avgPerIteration = currentTotal / (iteration + 1);
  if (currentTotal + avgPerIteration <= maxTotal) return null;
  return exceeded;
}

function tokenBudgetExceededReason(
  iteration: number,
  totalTokens: number,
  maxTokens: number | undefined,
): string | null {
  if (typeof maxTokens !== 'number' || maxTokens <= 0) return null;
  if (totalTokens >= maxTokens) return 'tokens';
  return projectedBudgetExceededReason(iteration, totalTokens, maxTokens, 'tokens_projected');
}

function creditsBudgetExceededReason(
  iteration: number,
  creditsCharged: number,
  maxCredits: number,
): string | null {
  if (creditsCharged >= maxCredits) return 'credits';
  return projectedBudgetExceededReason(iteration, creditsCharged, maxCredits, 'credits_projected');
}

// ─── CostCap ────────────────────────────────────────────────────────

/**
 * CostCap：全生命周期 hooks 型 Capability。
 *
 * **type / category**：W2.1.0 §2 决议命名 `'cost'` / `'governance'`，与
 * `agent_config_v2.build_default_agent_config_v2()` 的
 * `capabilities.overrides.cost` 块对齐。
 *
 * **clone 行为**：override CapabilityBase.clone —— 内部 `_prevModel` /
 * `_prevWindow` 是上一轮 model 切换检测的状态，clone 时必须重置（避免新
 * session 第一轮就被识别为"model 切换"误触 `_compactionForce`）。其他
 * 字段（`_config` / `_contextWindowTokens` / `_resolveContextWindow` /
 * `_estimator` / `_contextBudget`）是构造期注入的不变引用，正常保留。
 *
 * **D-tech-5 SSoT 严格遵守**：CostCap 不维护任何 token / cost 累加器，也不
 * 直接读 BudgetTracker。afterIteration 预算判定读 `state.totalInputTokens` /
 * `state.totalOutputTokens` / `state.creditsCharged`——这些字段已由
 * `syncStateFromTracker`（budget-state-sync.ts）在每个 usage chunk 写成**本
 * run 增量**（根 query = `getAccumulated − _budgetRunBaseline`，与
 * DONE.usage 同口径），故同 runtime 前序 turn 消耗不会计入 `max_credits_per_run`
 * / `max_total_tokens`。
 */
export class CostCap extends CapabilityBase {
  readonly type = 'cost';
  readonly category: CapabilityCategory = 'governance';

  private readonly _config: Readonly<CostCapConfig>;
  private readonly _contextWindowTokens?: number;
  private readonly _resolveContextWindow?: (model: string) => number;
  private readonly _estimator?: TokenEstimator;
  private readonly _contextBudget?: Partial<ContextBudget>;

  /**
   * model 切换检测——上一轮记录 model + 解析得到的 contextWindow，
   * 让 model 切换时若新 window < 旧 window 且压力 ≥ 0.7 强制 compaction。
   *
   * **clone 时必须重置为 undefined**（override clone 处理）：跨 session
   * 共享会让新 session 第一轮就被错认为是 model 切换。
   */
  private _prevModel: string | undefined = undefined;
  private _prevWindow: number | undefined = undefined;
  /**  批次 10：当轮 convergence hint（原 `state.__convergenceHint` 黑板）。 */
  private _convergenceHintBlock: string | undefined;

  constructor(init?: CostCapInit) {
    super();
    this._config = Object.freeze({ ...(init?.config ?? {}) });
    this._contextWindowTokens = init?.contextWindowTokens;
    this._resolveContextWindow = init?.resolveContextWindow;
    this._estimator = init?.estimator;
    this._contextBudget = init?.contextBudget;
  }

  /**
   * 不贡献工具 —— 与 AuditCap 一样，CostCap 是 hooks-only Cap 的变体
   *（"全生命周期 hooks 型" vs AuditCap 的"hooks-only 型"，差别仅在
   * 是否真消费 state 做决策）。
   *
   * **设计决策**：不暴露"query my budget"工具——budget 数据应由 dashboard /
   * AdminDash 消费，不让 LLM 自我探查。预算压力通过 hooks().beforeIteration
   * 经 `beforeModel` → `appendSystemSection` 注入 system prompt 让 LLM 感知，
   * 而不是开放查询工具。
   */
  tools(): Tool[] {
    return [];
  }

  required_capability_types(): ReadonlySet<string> {
    return new Set();
  }

  /**
   * Hooks —— 全生命周期 + token/credit/context 三类决策。
   *
   * **beforeIteration**（context window 警告 + convergence hint）：
   *   1. 估当前 token 数（带 anchor 增量加速）
   *   2. 调 `calculateTokenWarningState` 分类 normal/warning/error/blocking
   *   3. 按级别缓存 convergence hint 块
   *   4. 算 context pressure（estimated/window）写 `state.contextPressure`
   *   5. model 切换 + window 缩水 + 压力 ≥ 0.7 → 设 `state._compactionForce`
   *
   * **afterIteration**（token / credit 本 run 超限）：
   *   1. 读本 run token（`state.totalInputTokens + state.totalOutputTokens`，
   *      由 syncStateFromTracker 写成本 run 增量）
   *   2. >= maxTotalTokens → `ctx.requestForceFinal('tokens')`
   *   3. 投影 next iteration（avg per iter）超 max → `tokens_projected`
   *   4. 本 run credits（`state.creditsCharged`）同上 → `credits` / `credits_projected`
   *
   * **顺序保证**：beforeIteration 与 afterIteration 在 query.ts 主循环
   * 中分别在迭代头/尾执行，互不打架。同轮内多 hook 通过 composeHooks
   * beforeModel 在本轮 LLM 前把 hint 经 `appendSystemSection` 注入。
   */
  hooks(): EngineHooks | null {
    return {
      beforeIteration: async (ctx: IterationHookContext) => {
        const state = ctx.state;
        // ── 1. 解析 contextWindow（动态优先，静态 fallback）──
        const ctxWindow =
          this._resolveContextWindow?.(state.model) ?? this._contextWindowTokens ?? 0;

        if (ctxWindow > 0 && state.messages.length > 0) {
          // ── 2. 估 token 数（带 anchor 增量优化）──
          const anchor = state._lastUsageAnchor;
          // P3.2: 优先使用 query 主循环挂载的已校准 estimator，回退到
          // 构造期注入的（与原 token-budget 行为一致）
          const estimator = state._tokenEstimator ?? this._estimator;
          const estimated = estimateTokensWithAnchor(state.messages, anchor, estimator);

          // ── 3. Token warning state + convergence hint ──
          const warningState = calculateTokenWarningState(
            estimated,
            ctxWindow,
            this._contextBudget,
          );
          if (warningState === 'error') {
            this._convergenceHintBlock = CONVERGENCE_HINT_ERROR;
          } else if (warningState === 'warning') {
            this._convergenceHintBlock = CONVERGENCE_HINT_WARNING;
          } else {
            this._convergenceHintBlock = undefined;
          }

          // ── 4. Context pressure ratio ──
          const pressure = Math.min(estimated / ctxWindow, 1.0);
          state.contextPressure = Math.round(pressure * 10000) / 10000;

          // ── 5. Model 切换保护：window 缩水 + 压力高时强制 compaction ──
          // `_compactionForce` 是 single-shot 标志：本轮设 → query.ts
          // compaction 路径消费并清除（与原 createContextPressureMonitor
          // 注释一致）。
          if (this._prevModel !== undefined && this._prevModel !== state.model) {
            if (
              this._prevWindow !== undefined &&
              ctxWindow < this._prevWindow &&
              pressure >= 0.7
            ) {
              state._compactionForce = true;
            }
          }
          this._prevModel = state.model;
          this._prevWindow = ctxWindow;
        }
      },

      beforeModel: async (ctx) => {
        if (this._convergenceHintBlock) {
          ctx.appendSystemSection(
            SYSTEM_SECTION_NAMES.convergence_hint,
            this._convergenceHintBlock,
            'token-budget',
          );
        }
      },

      afterIteration: async (ctx: IterationHookContext) => {
        const { state, iteration } = ctx;
        // state 扁平字段已由 syncStateFromTracker（model-stream 每个 usage
        // chunk）写成「本 run 增量」：根 query = getAccumulated − _budgetRunBaseline，
        // 子 query = per-scope，无 tracker = 从 0 累加。CostCap 直接消费，不
        // 自行读 tracker / 减基线（SSoT 由 budget-state-sync.ts 独占，）。
        const totalTokens = state.totalInputTokens + state.totalOutputTokens;
        const maxTokens = this._config.max_total_tokens;
        const maxCredits = this._config.execution_limits?.max_credits_per_run;

        // ── Token budget ──
        const tokenReason = tokenBudgetExceededReason(iteration, totalTokens, maxTokens);
        if (tokenReason) {
          ctx.requestForceFinal(tokenReason);
          return;
        }

        // ── Credits budget ──
        // ：仅显式正数 max_credits_per_run 才设墙；缺省 / null / 非正数
        // 表示未启用 credits 限制（不再回落 DEFAULT_MAX_CREDITS_PER_RUN）。
        if (typeof maxCredits === 'number' && maxCredits > 0) {
          const creditsReason = creditsBudgetExceededReason(
            iteration,
            state.creditsCharged,
            maxCredits,
          );
          if (creditsReason) ctx.requestForceFinal(creditsReason);
        }
      },
    };
  }

  /**
   * Override clone —— 显式重置 `_prevModel` / `_prevWindow` + 显式保留
   * `_estimator` 原引用。
   *
   * **重置 _prevModel / _prevWindow**（与 AuditCap / SkillsCap clone 模式
   * 对齐）：默认 CapabilityBase.clone 会 structuredClone 这两个字段（string /
   * number / undefined 都能 clone），但语义上 clone ≡ 新 session —— 上一
   * session 的 model 切换历史对新 session 无意义，反而触发"新 session 第
   * 一轮就被识别为 model 切换"误触 `__compactionForce` 的 bug。
   *
   * **保留 _estimator 原引用**：默认 CapabilityBase.clone 对 class instance
   * 字段（TokenEstimator 是 class）走 `structuredClone(v)` 路径——
   * `structuredClone` 对 class instance**不抛错但丢 prototype**（W3C spec
   * 行为），导致 cloned 实例上方法不可用。TokenEstimator 含 model family /
   * 校准因子 state，多 clone 共享原引用是期望语义。
   */
  clone(): CostCap {
    const cloned = super.clone() as CostCap;
    cloned._prevModel = undefined;
    cloned._prevWindow = undefined;
    cloned._convergenceHintBlock = undefined;
    // 强制保留原引用（覆盖 super.clone 走 structuredClone 丢 prototype 的
    // 行为）。`as unknown as` 双层 cast 绕过 private 字段访问检查——这里
    // 改的就是同类型 cloned 实例的 private 字段，只是 TS 不允许通过类型
    // 假名直接访问 private，必须用双层 cast 显式声明意图。
    type CostCapWritablePrivates = {
      _estimator?: TokenEstimator;
    };
    const writable = cloned as unknown as CostCapWritablePrivates;
    writable._estimator = this._estimator;
    return cloned;
  }
}
