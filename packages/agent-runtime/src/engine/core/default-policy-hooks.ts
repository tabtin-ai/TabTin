/**
 * Engine 默认策略 Hook 栈（ 策略迁移）。
 *
 * query.ts 主循环内联的策略逻辑分波迁到新一代 EngineHooks 扩展点后，由本
 * 工厂在每个 QueryRun 构造时装配成默认栈——宿主（Electron / Daemon）装配
 * 代码不动，`EngineConfig.hooks` 上的宿主钩子照旧生效。
 *
 * **装配形态**（QueryRun 里展开为独立 stage：`pre → 宿主 hooks → post stages`）：
 *   - **pre 段**（宿主钩子之前）——上下文注入类策略（内部仍 compose）：
 *     1. run-observations 注入（原 injectRecentRunObservations）
 *     2. thread-notifications 注入（原 injectThreadNotifications）
 *   - **post stages**（宿主钩子之后，**各自独立 stage / 独立 fail-soft**）——
 *     治理与恢复类策略（：不再用 composeHooks 捏成单段，避免
 *     message-governance 抛错连坐跳过 IterationBudget grace）：
 *     4. message governance（尺寸预算 / 规范化 / 配对门）
 *     5. iteration budget（warn / grace / terminate 三档）
 *     6. tool loop guard（失败 streak / 成功复读三档 + nudge 消费——nudge
 *        消费依赖 budget 的 grace 信号先就绪，必须排在 5 之后）
 *     7. login-wall-gate（确定性 login_required → 下一轮只留 ask_user；
 *        排在 budget 之后，grace 时门禁让位）
 *     8. captcha-wall-gate（确定性 captcha_required → 下一轮只留 ask_user；
 *        与登录墙同构，紧随其后）
 *     9. context overflow recovery（413 三段式恢复，onModelError）
 *    10. model fallback（529 / 5xx 降级，onModelError；段间短路合并下
 *        overflow 先走 9，未处理才轮到 10）
 *
 * **实例化语义**：每个 QueryRun（= 每次 query()）调用本工厂新建一份 hook
 * 实例——有状态策略（tool-loop-guard tracker 等）随 run 生命周期，且
 * forkQuery 的子 runtime 会自建新栈，不与父共享内部状态。
 */

import { composeHooks } from './hooks-compose.js';
import { buildRunObservationsInjectorHook } from '../policy-hooks/run-observations-injector.js';
import { buildThreadNotificationsInjectorHook } from '../policy-hooks/thread-notifications-injector.js';
import { buildMessageGovernanceHook } from '../policy-hooks/message-governance.js';
import { buildToolLoopGuardHook } from '../policy-hooks/tool-loop-guard.js';
import { buildLoginWallGateHook } from '../policy-hooks/login-wall-gate.js';
import { buildCaptchaWallGateHook } from '../policy-hooks/captcha-wall-gate.js';
import { buildIterationBudgetPolicyHook } from '../policy-hooks/iteration-budget-policy.js';
import { buildContextOverflowRecoveryHook } from '../policy-hooks/context-overflow-recovery.js';
import { buildModelFallbackHook } from '../policy-hooks/model-fallback.js';
import { normalizeIterationBudgetConfig } from '../guards/iteration-budget.js';
import { resolveMaxMessageChars } from '../guards/message-size-budget.js';
import { DEFAULT_NORMALIZATION_LEVEL } from '../context/message-normalizer.js';
import { DEFAULT_CONTEXT_WINDOW } from '../../runtime-defaults.js';
import type { MessageOversizedIncompressible } from '../guards/message-size-budget.js';
import type { TokenEstimator } from '../context/token-budget.js';
import type { RetryState } from './retry-state.js';
import type {
  ToolParam,
} from '../contracts/conversation.js';
import type {
  ContextManager,
  EngineConfig,
  EngineHooks,
  QueryDeps,
} from '../contracts/kernel.js';

/** QueryRun 运行时状态的受控透传口（工厂闭包持有，engine 拥有实现）。 */
export interface DefaultPolicyRunState {
  getPreDeeplyNested: () => MessageOversizedIncompressible[];
  clearPreDeeplyNested: () => void;
  /** 本 run 的最大迭代数（params.maxTurns ?? config.maxTurns ?? 默认）。 */
  getMaxTurns: () => number;
  getRetryState: () => RetryState;
  getTokenEstimator: () => TokenEstimator;
  getToolParams: () => ToolParam[];
  /** run 级 ContextManager 实例（413 恢复的 autoCompact 从这里拿）。 */
  getContextManager: () => ContextManager;
}

export function buildDefaultPolicyPreHooks(
  config: EngineConfig,
  deps: QueryDeps,
): EngineHooks {
  return composeHooks(
    buildRunObservationsInjectorHook({
      getRecentRunObservations: config.getRecentRunObservations,
    }),
    buildThreadNotificationsInjectorHook({
      drainThreadNotifications: config.drainThreadNotifications,
    }),
  );
}

/**
 * post 策略装配（ 批次 12 knobs 解析 +  独立 stage）。
 *
 * 返回多个 `EngineHooks`，由 `HookRunner` 逐段独立 fail-soft——任一策略
 * beforeModel 抛错只跳过该策略，不连坐后续（尤其 IterationBudget grace）。
 *
 * 栈序契约：governance → budget → tool-loop-guard → login-wall-gate →
 * captcha-wall-gate；onModelError 仍是 overflow recovery → model fallback
 * （段间短路：首个返回指令者生效）。
 */
export function buildDefaultPolicyPostStages(
  config: EngineConfig,
  deps: QueryDeps,
  runState: DefaultPolicyRunState,
): EngineHooks[] {
  const sessionId = config.sessionConfig.threadId;
  return [
    buildMessageGovernanceHook({
      maxMessageChars: resolveMaxMessageChars(config.maxMessageChars),
      normalizationLevel: config.normalizationLevel ?? DEFAULT_NORMALIZATION_LEVEL,
      sessionId,
      getPreDeeplyNested: runState.getPreDeeplyNested,
      clearPreDeeplyNested: runState.clearPreDeeplyNested,
      observe: deps.observe,
    }),
    // 栈序契约：iteration-budget 在 tool-loop-guard 之前——grace turn 信号
    // 必须先就绪，tool-loop-guard 的 nudge 消费才能按 grace 丢弃。
    buildIterationBudgetPolicyHook({
      iterationBudgetConfig: normalizeIterationBudgetConfig(config.iterationBudget),
      budgetTracker: config.budgetTracker,
      budgetScope: config.budgetScope,
      sessionId,
      getMaxTurns: runState.getMaxTurns,
      observe: deps.observe,
    }),
    buildToolLoopGuardHook({
      toolFailureConfig: config.toolFailureTracker,
      toolRepetitionConfig: config.toolRepetitionTracker,
      sessionId,
      observe: deps.observe,
    }),
    // 登录墙硬门禁：工具结果侦测确定性 login_required → 下一轮只留 ask_user。
    // 排在 iteration-budget 之后（grace turn 信号已就绪，grace 时门禁让位）。
    buildLoginWallGateHook({
      sessionId,
      observe: deps.observe,
      getRuntimeMode: () => {
        const mode = config.runtimeMode;
        return (typeof mode === 'function' ? mode() : mode) ?? 'interactive';
      },
    }),
    // 验证码硬门禁：与登录墙同构；captcha_required → ask_user 卡片，不再弹全局 toast。
    buildCaptchaWallGateHook({
      sessionId,
      observe: deps.observe,
      getRuntimeMode: () => {
        const mode = config.runtimeMode;
        return (typeof mode === 'function' ? mode() : mode) ?? 'interactive';
      },
    }),
    // onModelError 段间短路：recovery 在 fallback 之前（overflow 错误先恢复）。
    buildContextOverflowRecoveryHook({
      resolveRecoveryContextWindow: (model) =>
        config.resolveContextWindow?.(model)
          ?? config.contextWindowTokens
          ?? DEFAULT_CONTEXT_WINDOW,
      budgetTracker: config.budgetTracker,
      budgetScope: config.budgetScope,
      observe: deps.observe,
      getContextManager: runState.getContextManager,
      getRetryState: runState.getRetryState,
      getTokenEstimator: runState.getTokenEstimator,
      getToolParams: runState.getToolParams,
    }),
    buildModelFallbackHook({
      fallbackChain: config.fallbackChain,
      fallbackModel: config.fallbackModel,
      getRetryState: runState.getRetryState,
      getTokenEstimator: runState.getTokenEstimator,
      observe: deps.observe,
    }),
  ];
}
