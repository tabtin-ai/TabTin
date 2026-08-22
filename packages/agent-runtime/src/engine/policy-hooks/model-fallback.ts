/**
 * Model Fallback Hook —— provider 过载 / 5xx 时的模型降级策略
 * （，Wave 5）。挂新一代 `onModelError` 扩展点。
 *
 * **历史背景**：本策略原内联在 `query.ts`（maybePrepareProviderFallback /
 * tryPrepareFallback / prepareFallback / resolveFallbackModel）。#3939 策略
 * 迁移把它挂到 onModelError，在 provider 过载 / 5xx 时切换 fallback 模型。
 *
 * **行为不变**：
 *   - 529 + `AgentError.details.needsFallback` → 立即尝试降级；
 *   - 5xx 连续计数（consecutive5xxCount），非 5xx 清零；每 run 只降级一次
 *     （fallbackAttempted）；
 *   - 降级链：config.fallbackChain → config.fallbackModel → opus→sonnet→haiku
 *     文本推导；orphan tool_use 补配对；`model_fallback` notice + telemetry；
 *   - 降级成功 → state.iteration++ → 返回 'retry'（原 'continue'）。
 *
 * **栈序契约**：在 context-overflow-recovery 之后（onModelError 短路合并，
 * overflow 错误先走恢复；恢复未处理的才轮到 fallback）——与迁移前
 * recovery → fallback 的判定顺序一致。
 */

import { TelemetryEvents } from '../../telemetry/events.js';
import { buildOrphanToolResults } from '../context/orphan-tool-results.js';
import {
  AgentError,
} from '../contracts/kernel.js';
import type {
  EngineHooks,
  EngineState,
  ModelErrorContext,
  ModelErrorDirective,
  ObserveFn,
} from '../contracts/kernel.js';
import type { RetryState } from '../core/retry-state.js';
import type { TokenEstimator } from '../context/token-budget.js';

// ─── 降级链解析（原 query.ts normalizeModelName / resolveFallbackModel）──

/** @internal — exported for testing */
export function normalizeModelName(name: string): string {
  return name.replace(/-(preview|latest|\d{8})$/, '').toLowerCase();
}

const MODEL_FAMILY_TIERS: [RegExp, string[]][] = [
  [/claude/i, ['opus', 'sonnet', 'haiku']],
];

/**
 * Build a fallback chain from a model identifier based on known model family tiers.
 * Used by hosts (Electron/Daemon) to inject `EngineConfig.fallbackChain`.
 *
 * Returns `undefined` when the model is already the lowest tier or is unrecognized.
 */
export function buildModelFallbackChain(modelId: string): string[] | undefined {
  for (const [familyPattern, tiers] of MODEL_FAMILY_TIERS) {
    if (!familyPattern.test(modelId)) continue;
    const currentTierIdx = tiers.findIndex(t => new RegExp(t, 'i').test(modelId));
    if (currentTierIdx < 0) continue;
    const chain = [modelId];
    for (let j = currentTierIdx + 1; j < tiers.length; j++) {
      chain.push(modelId.replace(new RegExp(tiers[currentTierIdx]!, 'i'), tiers[j]!));
    }
    return chain.length > 1 ? chain : undefined;
  }
  return undefined;
}

function resolveFallbackModel(
  currentModel: string,
  observe: ObserveFn,
  fallback: { fallbackChain?: string[]; fallbackModel?: string },
): string | null {
  if (fallback.fallbackChain?.length) {
    const normalizedCurrent = normalizeModelName(currentModel);
    const idx = fallback.fallbackChain.findIndex(
      m => normalizeModelName(m) === normalizedCurrent,
    );
    if (idx >= 0 && idx < fallback.fallbackChain.length - 1) {
      return fallback.fallbackChain[idx + 1]!;
    }
    if (idx < 0) {
      observe(TelemetryEvents.ERROR_FALLBACK_CHAIN_MISMATCH, {
        currentModel,
        chain: fallback.fallbackChain,
      });
    }
  }

  if (fallback.fallbackModel) return fallback.fallbackModel;

  if (/opus/i.test(currentModel)) {
    return currentModel.replace(/opus/i, 'sonnet');
  }
  if (/sonnet/i.test(currentModel)) {
    return currentModel.replace(/sonnet/i, 'haiku');
  }
  return null;
}

// ─── 降级执行（原 query.ts prepareFallback，events 改经 ctx 队列）─────

function prepareFallback(args: {
  ctx: ModelErrorContext;
  retryState: RetryState;
  state: EngineState;
  options: ModelFallbackOptions;
  tokenEstimator: TokenEstimator;
  observe: ObserveFn;
}): void {
  const { ctx, retryState, state, options, tokenEstimator, observe } = args;
  const fallback = resolveFallbackModel(retryState.currentModel, observe, options);
  if (!fallback) {
    throw new AgentError('No fallback model available', 'LLM_ERROR');
  }

  retryState.currentModel = fallback;
  retryState.fallbackAttempted = true;
  retryState.consecutive5xxCount = 0;

  state.model = fallback;
  tokenEstimator.setModel(fallback);

  const orphanMessages = buildOrphanToolResults(state.messages, 'Model fallback triggered');
  state.messages.push(...orphanMessages);

  ctx.emitNotice({
    content: `主模型（${retryState.originalModel}）暂时不可用，已切换到 ${fallback}。下次发消息时将自动尝试恢复主模型`,
    notice_type: 'model_fallback',
    severity: 'warning',
    original_model: retryState.originalModel,
    fallback_model: fallback,
  });

  observe(TelemetryEvents.ERROR_MODEL_FALLBACK, {
    originalModel: retryState.originalModel,
    fallbackModel: fallback,
    reason: '529_overload_or_5xx_consecutive',
  });
}

function isServerErrorStatus(statusCode: number | undefined): boolean {
  return typeof statusCode === 'number' && statusCode >= 500 && statusCode < 600;
}

function tryPrepareFallback(args: {
  ctx: ModelErrorContext;
  retryState: RetryState;
  options: ModelFallbackOptions;
  tokenEstimator: TokenEstimator;
  observe: ObserveFn;
}): boolean {
  try {
    prepareFallback({ ...args, state: args.ctx.state });
    args.ctx.state.iteration++;
    return true;
  } catch {
    return false;
  }
}

// ─── Factory ─────────────────────────────────────────────────────────

/**
 *  批次 12：工厂 options 只收降级链两个策略 knobs（`fallbackChain` /
 * `fallbackModel`），由装配层从 EngineConfig 摘出后注入，本 hook 不再直读
 * 整个 config。
 */
export interface ModelFallbackOptions {
  /** 有序降级链（= `EngineConfig.fallbackChain`，宿主从 ModelCatalog 注入）。 */
  fallbackChain?: string[];
  /** 单一后备模型（= `EngineConfig.fallbackModel`，降级链不命中时的最终兜底）。 */
  fallbackModel?: string;
  getRetryState: () => RetryState;
  getTokenEstimator: () => TokenEstimator;
  /** 观测出口（`QueryDeps.observe`）。 */
  observe: ObserveFn;
}

export function buildModelFallbackHook(options: ModelFallbackOptions): EngineHooks {
  const { getRetryState, getTokenEstimator, observe } = options;
  return {
    async onModelError(ctx): Promise<ModelErrorDirective | undefined> {
      // overflow 错误归 context-overflow-recovery 全权（含 attempts 耗尽后的
      // failed 收尾）——迁移前 recoverContextOverflow 对该类错误必然 return
      // 'done'/'retry'，fallback 永远看不到它。provider 可能用 5xx 状态码返回
      // prompt-too-long 文案（classifier 按文案归 context_overflow 但保留
      // statusCode），不加此守门会在恢复耗尽后意外触发一次模型降级重试。
      if (ctx.category === 'context_overflow') return undefined;
      const retryState = getRetryState();
      const tokenEstimator = getTokenEstimator();
      const agentError = ctx.error instanceof AgentError ? ctx.error : null;
      if (ctx.statusCode === 529 && agentError?.details?.needsFallback === true) {
        if (tryPrepareFallback({ ctx, retryState, options, tokenEstimator, observe })) return 'retry';
      }
      if (!isServerErrorStatus(ctx.statusCode)) {
        retryState.consecutive5xxCount = 0;
        return undefined;
      }
      retryState.consecutive5xxCount++;
      if (retryState.fallbackAttempted) return undefined;
      return tryPrepareFallback({ ctx, retryState, options, tokenEstimator, observe }) ? 'retry' : undefined;
    },
  };
}
