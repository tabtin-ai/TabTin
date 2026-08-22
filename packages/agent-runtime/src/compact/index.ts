export {
  microCompactSubagentSummary,
  SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS,
} from './subagent-summary.js';
export type {
  MicroCompactSubagentSummaryOptions,
  SubagentSummaryCompactResult,
} from './subagent-summary.js';
export {
  COMPACTABLE_TOOLS_DEFAULT,
  COMPACTABLE_TOOL_PREFIXES_DEFAULT,
  isCompactableTool,
  evaluateTimeBasedTrigger,
  maybeTimeBasedMicrocompact,
  inferLastAssistantTimestamp,
  DEFAULT_TIME_BASED_MC_CONFIG,
  TIME_BASED_MC_CLEARED_MESSAGE,
} from './time-based-microcompact.js';
export type {
  TimeBasedMCConfig,
  EvaluateTimeBasedTriggerInput,
  EvaluateTimeBasedTriggerResult,
  MaybeTimeBasedMicrocompactOptions,
  TimeBasedMicrocompactResult,
} from './time-based-microcompact.js';
export {
  compactConversation,
  extractActiveFiles,
  extractFileAttachments,
  POST_COMPACT_ATTACHMENT_BUDGET,
} from './compact.js';
export type { ForkCompactConfig, FileAttachment } from './compact.js';
export { summarizeHistoryForCheckpoint } from './checkpoint.js';
export type {
  CompactCheckpointSummary,
  CompactCheckpointSummaryParams,
} from './checkpoint.js';
export { autoCompactIfNeeded, calculateContextPressure, initCompactTracking } from './auto-compact.js';
export type { CompactTracking } from './auto-compact.js';
// W3-recovery (2026-05-11): layered-prune 恢复但仅在 emergency 档（pressure ≥ 0.95）
// 由 auto-compact.ts 内部调用，对外公开 API 供 host 兜底场景使用。
// 决策依据：99 §4.1 「保留 + 缩小爆炸半径」+ C1 §2.3 修复方向 B（dogfood 诊断）。
export { layeredPrune } from './layered-prune.js';
export type { LayeredPruneResult, LayeredPruneOptions } from './layered-prune.js';
export {
  judgeSummaryQuality,
  parseJudgeScore,
  appendJudgeScoreAndCheckFallback,
  recordJudgeFailure,
  createEmptyReuseStats,
  shouldSampleJudge,
} from './summary-judge.js';
export type {
  AppendJudgeScoreParams,
  AppendJudgeScoreResult,
} from './summary-judge.js';
export {
  buildIncrementalCompactSystemPrompt,
  renderMessagesPreviewForJudge,
  INCREMENTAL_COMPACT_USER_INSTRUCTION,
} from './incremental-prompt.js';
export {
  estimateTokens,
  estimateTokensWithAnchor,
  estimateFullContextTokens,
  estimateSystemTokens,
  estimateToolSchemaTokens,
  estimateTextTokens,
  estimateImageTokens,
  detectModelFamily,
  TokenEstimator,
  softTrim,
  hardTrim,
} from '../engine/context/token-budget.js';
export type { UsageAnchor, ModelFamily } from '../engine/context/token-budget.js';
// W3 (2026-05-10): `auto-condense.ts` (evaluateAutoCondense / startCondense /
// endCondense / cleanupCondenseArtifacts / CondenseState / AutoCondenseAction)
// deleted alongside the `summarize_context` tool. Runtime-driven LLM summary
// in `auto-compact.ts` covers the same pressure thresholds without asking the
// model to call a tool — we no longer provide a self-condense loop either.
export {
  runCompactionPhase,
  initOrchestratorState,
} from './compaction-orchestrator.js';
export {
  DEFAULT_PRESSURE_THRESHOLDS,
  RECOMMENDED_PRESSURE_THRESHOLDS,
  resolvePressureThresholds,
  computePressureStage,
  shouldRunTimeBasedMicrocompact,
  shouldRunLlmSummary,
} from './pressure-router.js';
export type {
  PressureThresholds,
  PressureStage,
} from './pressure-router.js';
export type {
  CompactionOrchestratorState,
  CompactionOrchestratorConfig,
  CompactionPhaseResult,
} from './compaction-orchestrator.js';
