/**
 * @tabtin/agent-runtime/engine — Local Agent Engine（执行微内核 barrel）
 *
 *  批次 13 收敛：本 barrel 只导出 `engine/**` 自己的符号——
 * contracts 分层契约（批次 14 由原 core/types.ts 拆分）、core
 * （retry-state / run-prelude / hooks-compose）、context / tooling /
 * wire / guards / policy-hooks / errors 各子目录。
 *
 * 历史上这里 re-export 过十余个非 engine 目录（subagent / compact / session /
 * tools / permissions / skills / telemetry / agent-modes / state / host /
 * terminal / runtime-assembly / providers / capability injectors），是
 * 「engine 边界虚化」最大出口。这些出口已整体搬到包入口 `src/index.ts`
 * （`@tabtin/agent-runtime`），不留旧路径 re-export——从本子路径 import
 * 已搬走符号会直接编译报错。
 */

// ─── Shared Contract（ 批次 14：types.ts 拆为 contracts/ 7 层契约）────
// 对外导出符号集与拆分前保持一致（新增 ContentBlockEnvelopeHint 供原
// `engine/types` 深路径消费者迁移）；包外 `@tabtin/agent-runtime/engine`
// 消费者零感知。

// 第 1 层 wire-protocol：Stream Events + envelope 6 件套 + LLM Call Snapshot
export type {
  StreamEvent,
  LifecycleEvent,
  StepEvent,
  DoneEvent,
  CompactionEvent,
  ContextPressureEvent,
  SystemNoticeEvent,
  MessageStartEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  ContentBlockEnvelopeEvent,
  SystemSection,
  SystemSectionName,
  LLMCallSnapshot,
  LLMCallSectionSummary,
  LLMCallMessageSummary,
  LLMCallToolSummary,
  LLMRequestEvent,
} from './contracts/wire-protocol.js';
export { SYSTEM_SECTION_NAMES } from './contracts/wire-protocol.js';
// Query 外的 host 也需要用统一 emitter 合成可持久化的工具产物 mini-message。
// 对外只暴露构造器，不复制 wire envelope 拼装逻辑。
export { EnvelopeEmitter } from './wire/envelope-emitter.js';

// 第 2 层 conversation：消息契约 + internal markers
export type {
  Message,
  MessageParam,
  MessageRole,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  ImageBlock,
  VideoBlock,
  FileBlock,
  SystemBlock,
  ToolParam,
  InternalMessageMarker,
} from './contracts/conversation.js';
export {
  INTERNAL_MESSAGE_MARKERS,
  hasInternalMarker,
  setInternalMarker,
} from './contracts/conversation.js';

// 第 3 层 model-llm：模型能力 + LLM Provider
export type {
  ModelCapabilities,
  ModelCatalogEntry,
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
  RetryAttemptInfo,
  ContentBlockEnvelopeHint,
} from './contracts/model-llm.js';
export {
  EXPLICIT_CACHE_PROVIDERS,
  FALLBACK_MODEL_CAPABILITIES,
  IMPLICIT_CACHE_PROVIDERS,
  PRESERVE_REASONING_FOR_TOOLS_PROVIDERS,
  SYSTEM_PROMPT_DYNAMIC_BOUNDARY,
  deriveCacheType,
  deriveReasoningHistoryPolicy,
} from './contracts/model-llm.js';

// 第 4 层 tools：工具系统契约
export type {
  JsonSchema,
  Tool,
  ToolPresentation,
  ToolProvider,
  ToolResult,
  ToolResultSignals,
  ToolContext,
  ReadFileState,
  ReadFileStateEntry,
  ImageDedupEntry,
  LocalDocDedupEntry,
  ImageReadFileState,
  LocalDocReadFileState,
} from './contracts/tools.js';

// 第 5 层 hitl：审批与挂起契约
export type {
  EnginePermissionHandler,
  PermissionRequest,
  PermissionDecisionResult,
  SerializedPendingApproval,
  SerializedPendingSingleHitl,
} from './contracts/hitl.js';

// SystemPromptProvider 端口（ Stage 2b）
export type {
  SystemPromptProvider,
  SystemPromptToolRef,
  ResolveSubagentPromptInput,
} from './contracts/system-prompt-provider.js';

// Stream 事件常量表（ Stage 5b）
export {
  StreamEvents,
  ContentBlockEvents,
  PROTOCOL_VERSION_V2,
  isContentBlockEvent,
} from './contracts/stream-events.js';
export type {
  StreamEventType,
  ContentBlockEventType,
} from './contracts/stream-events.js';

// Wire payload 本地契约（ Stage 5a）
export type {
  StreamLifecycle,
  StreamStep,
  StreamDone,
  CompactionStats,
  UsageReport,
  MessageStart,
  MessageDelta,
  MessageStop,
  ContentBlockStart,
  ContentBlockDelta,
  ContentBlockStop,
  WireContentBlock,
  ContentBlockDeltaPayload,
  MessageUsage,
  RiskLevel,
  ApprovalWireRiskLevel,
  DecisionReason,
  PlanRef,
  PlanProposalTodo,
  InheritMode,
  SubAgentPolicyDto,
  SpeakerIdentity,
} from './contracts/wire-payloads.js';

// Wire helpers / 本地 Zod（ Stage 5c）
export {
  normalizeToWireRiskLevel,
  inferWireRiskLevelFromTool,
  inferWireRiskLevelForToolCall,
} from './contracts/wire-risk.js';
export type { ToolRiskSource } from './contracts/wire-risk.js';
export {
  planRefKey,
  planRefEquals,
  parsePlanRefKey,
  resolvePlanRef,
  planRefToLegacyId,
} from './contracts/plan-ref.js';
export { assertMessageStartPayload } from './contracts/message-start-assert.js';
export {
  ApprovalRequestedPayloadSchema,
} from './contracts/approval-requested-schema.js';
export type { ApprovalRequestedPayload } from './contracts/approval-requested-schema.js';

// TodoCompletionNudgeProvider 端口（ Stage 2c）
export type {
  TodoCompletionNudgeProvider,
  TodoNudgeItem,
} from './contracts/todo-completion-nudge.js';

// ToolRiskPolicyPort 端口（ Stage 3）
export type {
  ToolRiskPolicyPort,
  ToolRiskPolicySnapshot,
  ToolRiskJudgeInput,
  ToolRiskJudgeTool,
  BuildMemoPatternKeyInput,
  RiskDecision,
  RiskDecisionBehavior,
  RiskDecisionReason,
  WorkspaceBoundary,
} from './contracts/tool-risk-policy.js';

// User-context wrapper 协议（ Stage 2c：自 agent-prompt 迁入）
export {
  buildUserContextWrapper,
  findFirstUserContextWrapper,
  findAllUserContextWrappers,
  VALID_USER_CONTEXT_WRAPPER_TYPES,
} from './context/user-context-wrapper.js';
export type {
  UserContextWrapperType,
  UserContextWrapperAttrs,
  ParsedUserContextWrapper,
} from './context/user-context-wrapper.js';

// 第 6 层 context-capability：上下文治理与会话契约
export type {
  AutoCompactParams,
  CompactResult,
  CompactionMode,
  ContextBudget,
  SummaryReuseEntry,
  SummaryReuseStats,
  SummaryReuseInfo,
  SummaryReuseFallbackReason,
  SummaryJudgeFn,
  TranscriptEntry,
  SessionConfig,
} from './contracts/context-capability.js';
export {
  DEFAULT_CONTEXT_BUDGET,
  DEFAULT_SUMMARY_REUSE_JUDGE_SAMPLE_RATE,
  DEFAULT_SUMMARY_REUSE_JUDGE_THRESHOLD,
  DEFAULT_SUMMARY_REUSE_JUDGE_WINDOW_SIZE,
  normalizeWorkspaceRoot,
} from './contracts/context-capability.js';

// 第 7 层 kernel：内核装配契约（Query / Hooks / EngineState / EngineConfig / Errors）
export type {
  QueryParams,
  QueryDeps,
  ToolGate,
  EngineHooks,
  RunHookContext,
  // IterationHookContext：beforeIteration / afterIteration 的入参契约。宿主侧
  // 消息注入 hook 需要它作为回调形参类型 —— 引擎唯一注入原语 EngineHooks 的
  // 配套契约随引擎公开出口一起导出。
  IterationHookContext,
  EngineState,
  EngineConfig,
  AgentRuntime,
  RunObservationInjection,
  AgentErrorCode,
} from './contracts/kernel.js';
export { AgentError } from './contracts/kernel.js';

// ─── 注入位置 helper（宿主消息注入 hook 复用）──────────────────────────
// `findLastRealUserIndex` / `isRealUserMessage` / `firstMessageText` 定位「最后一条
// 真用户消息」，引擎核心（run-prelude-phases / llm-call-snapshot）与宿主侧注入 hook
// 都要用同一份口径把易变内容贴到当前 user turn 尾部。实现留在引擎
// （engine/context/injection-position.ts），此处仅对外公开。
export {
  findLastRealUserIndex,
  isRealUserMessage,
  firstMessageText,
} from './context/injection-position.js';

// ─── Guards / Policy hooks ──────────────────────────────────────────
export { DEFAULT_MAX_MESSAGE_CHARS } from './guards/message-size-budget.js';
export { buildModelFallbackChain, normalizeModelName } from './policy-hooks/model-fallback.js';
export { markHistoricalContextMessages } from './core/run-prelude.js';

// ─── Message normalization (FR-03) ──────────────────────────────────
export {
  normalizeMessages,
  validateToolPairing,
  mergeConsecutiveMessages,
  repairOrphanToolCalls,
  filterOrphanedThinkingOnlyMessages,
  hasAnyChange,
  keepLatestAgentProfileRuntimeMessages,
  isAgentProfileRuntimeMessage,
  DEFAULT_NORMALIZATION_LEVEL,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  ensureToolResultPairing,
} from './context/message-normalizer.js';
// ：TabTin 权威 tool_use id（入站映射）
export {
  ToolIdMapper,
  allocateTabtinToolUseId,
  isTabtinToolUseId,
} from './context/tool-id-mapper.js';
export type {
  NormalizationLevel,
  NormalizeChanges,
  NormalizeOptions,
  NormalizeResult,
  EnsureToolResultPairingResult,
} from './context/message-normalizer.js';

// ─── Budget tracking ────────────────────────────────────────────────
// W4 (2026-05-26)：删除 `AcquireChildSlotResult` 导出（acquireChildSlot 旧 API
// 一并退役）。trySubmit + SubmitResult 是唯一调度入口。
export { BudgetTracker } from './guards/budget-tracker.js';
export type {
  BudgetTrackerOptions,
  ChildSubmitConfig,
  SubmitResult,
  SchedulerStats,
} from './guards/budget-tracker.js';

// ─── IterationBudget + Grace Call (FR-15) ───────────────────────────
export {
  evaluateIterationBudget,
  isStageUpgrade,
  normalizeIterationBudgetConfig,
  buildBudgetWarnNoticeContent,
  buildBudgetWarnSystemInjection,
  buildBudgetGraceNoticeContent,
  buildBudgetGraceSystemInjection,
  buildBudgetTerminateNoticeContent,
  buildBudgetGraceToolBlockedNoticeContent,
  budgetTriggerToErrorClass,
  suggestedActionForBudgetExhausted,
  DEFAULT_ITERATION_BUDGET,
} from './guards/iteration-budget.js';
export type {
  IterationBudgetConfig,
  IterationBudgetThresholds,
  IterationBudgetStage,
  IterationBudgetTrigger,
  IterationBudgetEvaluation,
  IterationBudgetChannelEval,
  EvaluateIterationBudgetParams,
} from './guards/iteration-budget.js';

// ─── W3 · Tool-failure stall detector ──────────────────────────────
export {
  ToolFailureTracker,
  evaluateToolFailureBudget,
  recordToolFailure,
  recordToolSuccess,
  isToolFailureStageUpgrade,
  buildToolFailureNoticeContent,
  buildToolFailureNudgeContent,
  buildToolFailureNudgeSystemInjection,
  DEFAULT_TOOL_FAILURE_BUDGET_THRESHOLDS,
  DEFAULT_TOOL_FAILURE_BUFFER_SIZE,
  DEFAULT_TOOL_FAILURE_EXCLUDE_KINDS,
  DEFAULT_TOOL_FAILURE_TRACKER_CONFIG,
} from './guards/tool-failure-tracker.js';
export type {
  RecordToolFailureContext,
  RecordToolFailureInput,
  ToolFailureBufferEntry,
  ToolFailureBudgetEvaluation,
  ToolFailureBudgetThresholds,
  ToolFailureBudgetTrigger,
  ToolFailureStage,
  ToolFailureTrackerConfig,
  ToolFailureTrackerOptions,
} from './guards/tool-failure-tracker.js';

// 系统提示词装配（assembleSystemPrompt）已迁宿主 prompt 出口（ Stage 2）。

// ─── Tool system ────────────────────────────────────────────────────
//  批次 13：`adaptActionTool` / `adaptActionTools` 已物理删除——生产链路
// 零消费（action-tools 集成实际走 ShellCap / tabcode-adapter 直连
// `@tabtin/action-tools`，不经 engine 内 adapter）。
export {
  ToolRegistry,
  sanitizeToolInput,
  executeTool,
  levenshteinDistance,
  listToolAliases,
} from './tooling/tool-system.js';
export { runTools, enforceToolOutputBudget } from './tooling/tool-orchestration.js';
export type {
  ToolExecutionResult,
  EnforceToolOutputBudgetOptions,
  RunToolsOptions,
} from './tooling/tool-orchestration.js';
// W3 (2026-05-10): `ToolResultArchive` removed (legacy `Map`-shaped store
// lived only to back the deleted `retrieve_tool_result` tool).

// ─── Tool result storage (T-P1-4 / W3) ─────────────────────────────
export {
  MemoryToolResultStorage,
  FileToolResultStorage,
  resolveToolResultStorage,
} from './tooling/tool-result-storage.js';
// W3: `wrapLegacyArchive` and `ToolResultStorageEntry` removed alongside
// the in-memory cache layer (FileToolResultStorage is now disk-only).
export type { ToolResultStorage } from './tooling/tool-result-storage.js';

// ─── Tool error construction (T-P0-1) ───────────────────────────────
export { buildToolErrorResult } from './tooling/tool-error.js';
export type { ToolErrorKind } from './tooling/tool-error.js';

// ─── Tool execution lifecycle notice (W2 silent-bypass 修复) ────────
export {
  TOOL_LIFECYCLE_NOTICE_TYPES,
  isToolLifecycleNotice,
} from './tooling/tool-lifecycle-notice.js';
export type { ToolLifecycleNoticeType } from './tooling/tool-lifecycle-notice.js';

// ─── Error classifier (E-P0-3) ──────────────────────────────────────
export {
  classifyError,
  isReportableRunError,
  isUpstreamBurstRateLimitMessage,
  parseTokenGap,
  UPSTREAM_RATE_LIMIT_USER_MESSAGE,
} from './errors/error-classifier.js';
export type { ClassifiedError, ErrorCategory, SuggestedAction } from './errors/error-classifier.js';

// ─── Retry state (E-P1-7) ───────────────────────────────────────────
export { createRetryState, FOREGROUND_SOURCES } from './core/retry-state.js';
export type { RetryState, QuerySource } from './core/retry-state.js';

// ─── FR-07 schema validation ────────────────────────────────────────
export {
  validateToolInput,
  summarizeValidationErrors,
  DEFAULT_TOOL_SCHEMA_VALIDATION,
} from './tooling/tool-schema-validator.js';
export type {
  SchemaValidationError,
  SchemaValidationResult,
  ToolSchemaValidationLevel,
} from './tooling/tool-schema-validator.js';

// ─── FR-09 output sanitization ──────────────────────────────────────
export {
  sanitizeToolOutput,
  shouldSanitizeToolOutput,
  scanForInjectionPatterns,
  wrapInToolOutputFence,
  listInjectionPatternIds,
} from './tooling/tool-output-sanitizer.js';
export type { SanitizedToolOutput } from './tooling/tool-output-sanitizer.js';

// ─── Dynamic Tool Manager (T-P1-7) ──────────────────────────────────
export { DynamicToolManager, DEFAULT_STALE_TTL } from './tooling/dynamic-tool-manager.js';

// ─── EngineHooks 合并工具 ───────────────────────────────────────────
// `composeHooks` 是宿主装配 EngineConfig.hooks 时的核心串联工具。
// W2.3 SSoT 已迁到 `capability/hooks-compose.ts`，engine/core 透传。
export { composeHooks } from './core/hooks-compose.js';
