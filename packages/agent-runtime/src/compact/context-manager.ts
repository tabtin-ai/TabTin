/**
 * 默认 ContextManager 实现（ 批次 3 控制反转）。
 *
 * 内核经 `QueryDeps.createContextManager()` 拿到本实现的实例，对压缩编排
 * （orchestrator 状态、时机判定、reuse、time-based microcompact、413 恢复的
 * autoCompact）零感知——装配级配置在构造时闭包，run 级可变量逐轮传入。
 *
 * 历史：原 `engine/context/compaction-phase.ts` 的 `buildCompactionOptions` +
 * QueryRun 手持的 `orchestratorState` 收编于此；engine 侧只留「消费相位结果」
 * 的协议段（记账 / DONE）。
 */

import type {
  LLMRequest,
  LLMResponseChunk,
} from '../engine/contracts/model-llm.js';
import type {
  AutoCompactParams,
} from '../engine/contracts/context-capability.js';
import type {
  ContextManager,
  ContextPhaseArgs,
  ContextPhaseResult,
  EngineConfig,
  EngineState,
} from '../engine/contracts/kernel.js';
import {
  initOrchestratorState,
  runCompactionPhase,
  resolveActivePlanForCompact,
} from './compaction-orchestrator.js';
import { inferLastAssistantTimestamp } from './time-based-microcompact.js';
import { autoCompactIfNeeded } from './auto-compact.js';
import type { ForkCompactConfig } from './compact.js';

export interface CompactContextManagerDeps {
  config: EngineConfig;
  /** 已过投影闸的 LLM 出口（组装根的 guardedCreateStream）。 */
  callModel: (req: LLMRequest) => AsyncIterable<LLMResponseChunk>;
  /** chunkedCompact 等 fork 摘要路径的配置（同样必须走投影闸）。 */
  forkConfig?: ForkCompactConfig;
}

export function createCompactContextManager(deps: CompactContextManagerDeps): ContextManager {
  const { config, callModel, forkConfig } = deps;
  // 压缩编排状态随本实例（= 随 run）生命周期，对内核不透明。
  const orchestratorState = initOrchestratorState();

  const autoCompact = (params: AutoCompactParams) =>
    autoCompactIfNeeded({
      ...params,
      //  任务连续性：413 恢复等调用方不感知 active plan——由本实现按
      // sessionId 统一解析，与 orchestrator 内部三条压缩路径同口径。
      activePlanRef: params.activePlanRef
        ?? resolveActivePlanForCompact(config.sessionConfig?.threadId),
      callModel,
      forkConfig,
    });

  return {
    async beforeModelCall(args: ContextPhaseArgs): Promise<ContextPhaseResult> {
      return runCompactionPhase(
        args.state,
        orchestratorState,
        buildCompactionOptions(config, args),
        (compactParams) => autoCompact(compactParams),
      );
    },
    autoCompact,
    //  批次 8：压缩记忆（前次摘要 + judge 窗口）随本实例，外部（413 恢复
    // 等直接改写 messages 的路径）经此方法失效，不再触碰 EngineState。
    invalidateSummaryCache() {
      orchestratorState.lastSummary = undefined;
      orchestratorState.reuseStats = undefined;
    },
  };

  function buildCompactionOptions(cfg: EngineConfig, args: ContextPhaseArgs) {
    const state: EngineState = args.state;
    return {
      budget: args.budget,
      resolveContextWindow: cfg.resolveContextWindow,
      contextWindowTokens: cfg.contextWindowTokens,
      // 修复：EngineConfig.maxOutputTokens 此前漏接进压缩配置，导致
      // compaction-orchestrator 的 outputReserve 永远回落默认 16384。当
      // contextWindowTokens < 16384（小上下文模型 / 测试小窗）时
      // effectiveWindow 被钳到 1，估算压力恒为 1（幻影 emergency）→ 每轮
      // 强压后仍越阻塞线 → 假 CONTEXT_OVERFLOW。透传真实 output 预留后
      // 有效窗口回归正常，压力估算与生产 catalog 的 max_tokens 对齐。
      maxOutputTokens: cfg.maxOutputTokens,
      sessionDir: cfg.sessionConfig?.sessionDir,
      sessionId: cfg.sessionConfig?.threadId,
      tools: args.toolParams,
      estimator: args.tokenEstimator,
      enableSummaryReuse: cfg.enableSummaryReuse,
      summaryReuseJudgeSampleRate: cfg.summaryReuseJudgeSampleRate,
      summaryReuseJudgeWindowSize: cfg.summaryReuseJudgeWindowSize,
      summaryReuseJudgeThreshold: cfg.summaryReuseJudgeThreshold,
      summaryReuseMaxAgeMs: cfg.summaryReuseMaxAgeMs,
      summaryReuseJudgeFn: cfg.summaryReuseJudgeFn,
      callModel,
      model: state.model,
      postCompactAttachmentBudget: cfg.postCompactAttachmentBudget,
      timeBasedMicroCompact: cfg.timeBasedMicroCompact,
      lastAssistantTimestamp: inferLastAssistantTimestamp(state.messages),
      pressureThresholds: cfg.pressureThresholds,
    };
  }
}
