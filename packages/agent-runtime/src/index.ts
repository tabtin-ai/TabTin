/**
 * @tabtin/agent-runtime — TabTin local agent execution runtime.
 *
 * Hosts the local ReAct loop, tool orchestration, context compaction,
 * and session persistence. All LLM calls go through the Django LLM proxy.
 */

export type { Logger, GatewayPort, RuntimeConfig } from './interfaces.js';

// #5394 Phase 2：permission-policy.ts（shouldAutoApprove / classifyTool /
// presetToPermissionMode / ToolCategory）已整体删除——判决权威是
// `@tabtin/security-policy` judge()，handler 不再自动批准任何请求。
//
// issue #6009 Stage 6b：不再从本包 re-export `@tabtin/contracts/agent` 或
// `@tabtin/python-runtime-host`——宿主直接依赖对应包。

// ─── Local Engine ───────────────────────────────────────────────────
// Local ReAct loop, tool orchestration, compaction, session storage.

export type {
  // W2 silent-bypass 修复：5 个老 union case 删除（详见 engine/index.ts 注释）。
  StreamEvent,
  LifecycleEvent,
  StepEvent,
  DoneEvent,
  CompactionEvent,
  SystemNoticeEvent,
  MessageStartEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  ContentBlockEnvelopeEvent,
  LLMProvider,
  LLMRequest,
  LLMResponseChunk,
  Message,
  MessageParam,
  MessageRole,
  ContentBlock,
  TextBlock,
  ToolUseBlock,
  ToolResultBlock,
  ThinkingBlock,
  FileBlock,
  SystemBlock,
  ToolParam,
  JsonSchema,
  Tool,
  ToolProvider,
  ToolResult,
  ToolContext,
  ReadFileState,
  ReadFileStateEntry,
  ImageDedupEntry,
  LocalDocDedupEntry,
  ImageReadFileState,
  LocalDocReadFileState,
  EnginePermissionHandler,
  PermissionRequest,
  PermissionDecisionResult,
  // #4019 批次 5：HITL 单原语——供 Electron/Daemon 组装宿主外发起点（Access
  // Barrier HITL 等）直接构造 InterruptPort。
  InterruptKind,
  InterruptRequest,
  InterruptOutcome,
  InterruptPort,
  SystemPromptProvider,
  SystemPromptToolRef,
  ResolveSubagentPromptInput,
  TodoCompletionNudgeProvider,
  TodoNudgeItem,
  ToolRiskPolicyPort,
  ToolRiskPolicySnapshot,
  ToolRiskJudgeInput,
  ToolRiskJudgeTool,
  RiskDecision,
  RiskDecisionBehavior,
  RiskDecisionReason,
  WorkspaceBoundary,
  UserContextWrapperType,
  UserContextWrapperAttrs,
  ParsedUserContextWrapper,
  SystemSection,
  SystemSectionName,
  LLMCallSnapshot,
  LLMCallSectionSummary,
  LLMCallMessageSummary,
  LLMCallToolSummary,
  LLMRequestEvent,
  QueryParams,
  QueryDeps,
  ToolGate,
  AutoCompactParams,
  CompactResult,
  TranscriptEntry,
  SessionConfig,
  EngineHooks,
  EngineState,
  EngineConfig,
  AgentRuntime,
  AgentErrorCode,
} from './engine/index.js';

export {
  AgentError,
  ToolRegistry,
  sanitizeToolInput,
  executeTool,
  runTools,
  enforceToolOutputBudget,
  BudgetTracker,
  normalizeWorkspaceRoot,
  DEFAULT_CONTEXT_BUDGET,
  SYSTEM_SECTION_NAMES,
  StreamEvents,
  ContentBlockEvents,
  PROTOCOL_VERSION_V2,
  isContentBlockEvent,
  normalizeToWireRiskLevel,
  inferWireRiskLevelFromTool,
  inferWireRiskLevelForToolCall,
  planRefKey,
  planRefEquals,
  parsePlanRefKey,
  resolvePlanRef,
  planRefToLegacyId,
  assertMessageStartPayload,
  ApprovalRequestedPayloadSchema,
  buildUserContextWrapper,
  findFirstUserContextWrapper,
  findAllUserContextWrappers,
  VALID_USER_CONTEXT_WRAPPER_TYPES,
} from './engine/index.js';

export type {
  ToolRiskSource,
  ApprovalRequestedPayload,
} from './engine/index.js';

// ─── Runtime entry point（#4019 批次 13：engine barrel 收敛后的对外出口）───
// createRuntime / createDefaultQueryDeps 经 composition root（runtime-assembly）
// 统一收口——组装根不属于 engine 内部，出口在包入口。详见 ./runtime-assembly.ts。
export { createRuntime, createDefaultQueryDeps } from './runtime-assembly.js';
export { DEFAULT_MAX_TURNS } from './runtime-defaults.js';

// ─── Provider ───────────────────────────────────────────────────────
export {
  LocalCodexResponsesProvider,
  resolveReasoningEffort,
  TabTinProxyProvider,
  createProxyProvider,
} from './providers/provider.js';
export type {
  CodexAuthResolver,
  LocalCodexParamOverrides,
  LocalCodexResponsesProviderOptions,
  ProxyProviderConfig,
} from './providers/provider.js';

// ─── Fork / Sub-agent ───────────────────────────────────────────────
export {
  forkQuery,
  buildForkedMessages,
  filterIncompleteToolCalls,
  policyFilter,
  FORK_PLACEHOLDER_RESULT,
} from './subagent/fork-query.js';
export type { ForkQueryConfig, BuildForkedMessagesOptions } from './subagent/fork-query.js';
export {
  createAgentTool,
  cancelSubagent,
  getActiveSubagentIds,
} from './subagent/agent-tool.js';
export type { AgentToolConfig, AgentToolDeps, SubagentModelPolicy } from './subagent/agent-tool.js';

// ─── Model Catalog（子 Agent 模型自由度 Phase 3/4） ──────────────────
export {
  findCatalogEntry,
  isValidModelRef,
  resolveModelCapabilitiesFromCatalog,
  resolveChildModelFromCatalog,
  renderModelCatalogMenu,
} from './subagent/model-catalog.js';
export type {
  ResolveChildModelOptions,
  ResolveChildModelResult,
} from './subagent/model-catalog.js';

export { DEFAULT_MAX_CREDITS_PER_RUN } from './capability/index.js';

export type { ToolExecutionResult } from './engine/index.js';
export type {
  SyncQueueOptions,
  PersistentQueue,
  PersistedEntry,
  PersistedEntryArchiveReason,
  PersistedEntryOwner,
  FilePersistentQueueOptions,
} from './session/index.js';

// ─── Compact system（#4019 批次 13：出口从 engine barrel 收敛到包入口）────
export {
  compactConversation,
  summarizeHistoryForCheckpoint,
  autoCompactIfNeeded,
  calculateContextPressure,
  initCompactTracking,
  microCompactSubagentSummary,
  SUBAGENT_SUMMARY_DEFAULT_MAX_CHARS,
  judgeSummaryQuality,
  parseJudgeScore,
  appendJudgeScoreAndCheckFallback,
  recordJudgeFailure,
  createEmptyReuseStats,
  shouldSampleJudge,
  buildIncrementalCompactSystemPrompt,
  renderMessagesPreviewForJudge,
  INCREMENTAL_COMPACT_USER_INSTRUCTION,
  estimateTokens,
  estimateTokensWithAnchor,
  estimateFullContextTokens,
  estimateSystemTokens,
  estimateToolSchemaTokens,
  estimateImageTokens,
  detectModelFamily,
  TokenEstimator,
  softTrim,
  hardTrim,
  // W3-recovery (2026-05-11): layered-prune 仅在 emergency 档由 auto-compact
  // 内部调用，对外公开 export 供 host 兜底场景使用（保持 export 表完整）。
  layeredPrune,
} from './compact/index.js';
export type {
  CompactTracking,
  MicroCompactSubagentSummaryOptions,
  SubagentSummaryCompactResult,
  CompactCheckpointSummary,
  CompactCheckpointSummaryParams,
  AppendJudgeScoreParams,
  AppendJudgeScoreResult,
  UsageAnchor,
  ModelFamily,
  LayeredPruneResult,
  LayeredPruneOptions,
} from './compact/index.js';

// ─── Session storage ────────────────────────────────────────────────
export {
  SessionStorage,
  // #4897：本机 transcript 重建（messages.jsonl 6 件套重放），主进程 read-session-transcript 复用。
  reconstructMessagesFromTranscriptEntries,
  findCompactionDoneStartIndex,
  computeRewindCommitPrefixLength,
  // #5430 message block 权威：消息级 block 存储与重建。
  MessageBlockStorage,
  reconstructMessagesFromBlockRecords,
  blockRecordsToTranscriptMessages,
  // #5592 / #8423：in-turn push 双写门闸（相对 idle drain）
  isInTurnPushNotificationUser,
  SnapshotStorage,
  EventStorage,
  type EventStorageEntry,
  SyncQueue,
  OwnerMismatchError,
  InMemoryPersistentQueue,
  FilePersistentQueue,
  buildSyncAccountDir,
  clearSyncAccountDir,
  listSyncAccountOwners,
  assertValidOwner,
  ownersMatch,
  ToolLogWriter,
  cleanupOldToolLogs,
  toolOutputToString,
  type ToolLogEntry,
  type ToolLogWriterOptions,
  // W3 (2026-05-10): ToolLogReader / extractToolLogOutput / ToolLogIndexEntry
  // / ToolLogQuery removed along with the `retrieve_tool_result` tool.
  resolveSpaceWorkspaceRoot,
  resolveSpacePlatformDataRoot,
  resolveSpaceSkillsDir,
  resolveSpaceSkillDir,
  resolveSpaceDownloadsDir,
  resolveSpaceSiteDir,
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
  // issue #7118 新 API
  resolveUserRoot,
  resolveUserSkillsDir,
  resolveUserSkillDir,
  resolveUserCommonDir,
  resolveOrganizationRoot,
  resolveOrganizationSkillsDir,
  resolveOrganizationSkillDir,
  resolveOrganizationPluginsDir,
  resolveOrganizationPluginRegistryFile,
  resolveOrganizationPluginDir,
  resolveOrganizationSharedDir,
  resolveWorkspaceMetadataRoot,
  resolveWorkspaceDownloadsDir,
  resolveWorkspaceConversationsRoot,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
  resolveWorkspaceSiteDir,
  // #7033：本机 session 归档分叉 + tool id remap
  forkLocalSessionArchive,
  createForkToolIdMapper,
  remapToolIdsInValue,
  FORK_TOOL_USE_TYPES,
  FORK_TOOL_REF_KEYS,
  // W4a S1：SubagentManager —— session 维度子 Agent 运行登记中心（挂 HostState）。
  SubagentManager,
  // W4b（2026-05-30）：崩溃残留子 Agent 收口（orphan reaper）。
  reapOrphanedSubagentRuns,
  // W5-b（2026-05-30）：resume-aware 折叠 + 只读读索引。
  foldSubagentRuns,
  readSubagentIndexEntries,
} from './session/index.js';
export type {
  ReconstructedTranscriptMessage,
  ReconstructTranscriptOptions,
  MessageBlockRecord,
  ForkLocalSessionParams,
  ForkLocalSessionResult,
  SubagentManagerOptions,
  SubagentRunMeta,
  SubagentRunStatus,
  SubagentSchedulerState,
  SubagentRunState,
  SubagentRunUnregister,
  // W4a S3-S5（PR2）：live 依赖重绑定 + 完成回调契约。
  SubagentLiveDeps,
  ResolveLiveDepsResult,
  SubagentCompletionInfo,
  EnqueueSubagentCompletion,
  SubagentIndexEntry,
  SubagentIndexStartEntry,
  SubagentIndexEndEntry,
  FoldedSubagentRun,
} from './session/index.js';
// ─── EngineHooks 合并工具 ───────────────────────────────────────────
// `composeHooks` 是 EngineHooks 合并工具（SSoT 在 `capability/hooks-compose.ts`，
// engine/core 透传），宿主装配 EngineConfig.hooks 时串联各 hook 用。
//
// issue #6009 Phase 1：原来这里 re-export 的 7 个 `build*InjectorHook` +
// 各 Options 类型已整体迁到宿主内容包。引擎不再持有 6 段上下文贡献
// （它们依赖 @tabtin/agent-prompt / agent-modes / lsp-runtime 这些产品内容包）
// ——引擎只保留 EngineHooks 这一唯一注入原语。
export { composeHooks } from './engine/index.js';

// ─── 宿主消息注入 hook 依赖的引擎侧 helper（issue #6009 Phase 1）─────────
// 6 段上下文贡献迁到宿主后，仍需引擎这几件「宿主无关」的工具：
//   - todo 回放（todo-state hook 每轮推导活跃批次）
//   - RuntimeSystemNoticeEvent（rules hook 发「已加载项目规则」系统通知）
// 均无 @tabtin 产品内容依赖，作为引擎公共面对宿主开放。
export {
  deriveActiveTodoBatch,
  deriveOpenTodoList,
  extractLatestActionableTodos,
  extractLatestUnfinishedTodos,
  extractInProgressTodo,
} from './todo/todo-replay.js';
export type {
  TaskContinuityTodo,
  TodoSessionAnchor,
  ActiveTodoBatch,
  DeriveTodoOptions,
} from './todo/todo-replay.js';
export {
  applyTodoAction,
  replayTodoActions,
  TODO_LIST_ALREADY_OPEN,
  TODO_LIST_NOT_OPEN,
  TODO_ITEM_FROZEN,
  TODO_INVALID_ITEMS,
} from './todo/todo-state-machine.js';
export type {
  TodoItem,
  TodoListState,
  TodoApplyResult,
  TodoActionName,
} from './todo/todo-state-machine.js';
export { RuntimeSystemNoticeEvent } from './event/events/observability-events.js';

// ─── Unified event system ────────────────────────────────────────────
export { AgentEvent, TypedAgentEvent } from './event/agent-event.js';
export type { InheritedIdentity } from './event/agent-event.js';
export { EventEmitter, nextArrivalSeq, stampEgressEvent } from './event/event-emitter.js';
export type { EventEmitterContext } from './event/event-emitter.js';
export { RuntimeLifecycleEvent } from './event/events/observability-events.js';
export {
  MessagePersistedEvent,
  hitlMessageId,
} from './event/events/persist-events.js';
export { RuntimeLlmSnapshotEvent, RuntimeLlmUsageEvent } from './event/events/llm-events.js';
export { extractTraceIdFromLifecycleStart } from './event/trace.js';

// ─── 终端进程退出能力；可靠投递由宿主 delivery 层拥有 ──
export {
  killProcessGroupSafe,
  runBackgroundTaskExitFlush,
} from './terminal/terminal-state-relay.js';
export type {
  ExitFlushDeps,
  ExitFlushStore,
  ExitFlushRunningRecord,
  TerminalRelayLogger,
} from './terminal/terminal-state-relay.js';

// ─── W3-轮 1（PRD 05 v0.4 §7.1 + §7.2.3）crash resume helpers ────────
export {
  applyPendingApprovalsRestore,
  decodeWirePendingApprovals,
} from './permissions/pending-approvals-restorer.js';
export type {
  PendingApprovalsRestoreInput,
  PendingApprovalsRestoreResult,
} from './permissions/pending-approvals-restorer.js';
// ─── issue #6022：单 HITL crash resume helpers ──────────────────────
export {
  applyPendingSingleHitlRestore,
  decodeWirePendingSingleHitl,
} from './permissions/pending-single-hitl-restorer.js';
export type {
  PendingSingleHitlRestoreInput,
  PendingSingleHitlRestoreResult,
} from './permissions/pending-single-hitl-restorer.js';

// ─── Permission handler ─────────────────────────────────────────────
export { LocalPermissionHandler } from './permissions/local-permission-handler.js';
export type { LocalPermissionHandlerOptions } from './permissions/local-permission-handler.js';

// ─── Skills 协议 / 工具函数（SSoT 在 skills/） ──────────────────────
export {
  createHttpSkillsFetcher,
  truncateSkillsWithinBudget,
  getCharBudget,
  SKILL_BUDGET_CONTEXT_PERCENT,
  CHARS_PER_TOKEN,
  DEFAULT_CHAR_BUDGET,
  MAX_LISTING_DESC_CHARS,
} from './skills/index.js';
export type {
  SkillsFetcher,
  SkillsFetchContext,
  SkillMeta,
  SkillListingResult,
  HttpSkillsFetcherOptions,
} from './skills/index.js';

// ─── Mode switch tool ───────────────────────────────────────────────
export { createSwitchModeTool, REQUIRES_CLIENT_APPROVAL, ALREADY_PENDING } from './tools/mode-tools.js';
export type {
  SwitchModeToolDeps,
  SwitchModeToolInput,
  SwitchModeProposalRegistry,
} from './tools/mode-tools.js';

// ─── Background task terminal result (t1) ───────────────────────────
// 后台命令终结时构造终态 tool_result，host 经 relay 覆盖 running 快照。
// 两宿主（ElectronAgentHost / DaemonAgentHost）的
// relayBackgroundTaskTerminalResult 直接从顶层 barrel 消费这些 helper。
export {
  buildBackgroundTaskTerminalResult,
  buildBackgroundTaskTerminalResultEvents,
  buildBackgroundTaskTerminalContent,
  deriveBackgroundTaskStatus,
  readFileTailSafe,
  BG_TERMINAL_STDOUT_TAIL_BYTES,
} from './terminal/background-task-terminal-result.js';
export type {
  BackgroundTaskTerminalInput,
  BackgroundTaskTerminalStatus,
} from './terminal/background-task-terminal-result.js';

// AgentMode SSoT / 受限模式软拒：请直接从产品 modes 包导入
// （issue #6009 Stage 4；runtime 不再 re-export）。

// ─── HITL 通道 + 审批记忆 ───────────────────────────────────────────
// v3 judge() 主路径 + LocalPermissionHandler 用到的 memo 存储 / 跨设备同步 /
// UserInteractiveChannel 桥。两宿主通过这些导出装配 HITL 通道（详见
// createRuntimeForSession 内 `bridgeUserInteractiveToLocalPermissionHandler`
// 调用点）。历史 6 层 PermissionPipeline 已在 W7 / B1 整体清退。
export {
  createApprovalMemoStore,
  InMemoryApprovalMemoStore,
  // W2-轮 2：跨设备 always memo 同步客户端
  createApprovalMemoCommitClient,
  createApprovalMemoRefetchClient,
  parseApprovalMemoSnapshot,
  bridgeUserInteractiveToLocalPermissionHandler,
  // W3-轮 1（PRD §7.6.2 接口 B）：host envelope handler helper
  applyCancelledByRollbackToHitl,
  cancelAllPendingHitlRequests,
  // Phase 3 F1：全局 shutdown 路径专用（显式命名，避免业务路径误用）
  cancelAllSessionsHitlRequests,
  getHumanInteractionContext,
  requestPlatformApproval,
  requestAccessBarrierResolution,
  runWithHumanInteractionContext,
  setHumanInteractionHooks,
  createInterruptAdapter,
} from './permissions/index.js';

export type {
  PendingHitlEntry,
  PendingHitlMap,
  CancelAllPendingHitlOptions,
} from './permissions/index.js';

export type {
  UserInteractiveChannel,
  ApprovalMemoStore,
  ApprovalMemoEntry,
  BridgeOptions,
  CommitAlwaysCallback,
  RefetchAllCallback,
  InMemoryApprovalMemoStoreOptions,
  // W2-轮 2：跨设备 always memo 同步客户端
  AuthTokenProvider,
  CommitClientOptions,
  RefetchClientOptions,
  MemoSyncLogger,
  HumanInteractionContext,
  HumanInteractionHooks,
  PlatformApprovalRequest,
  PlatformApprovalResult,
  InterruptAdapterDeps,
} from './permissions/index.js';

// ─── Access Barrier HITL ────────────────────────────────────────────────────
// 呈现辅助（非默认策略）：`agent-runtime` 主循环 / 默认策略栈不装配任何墙
// 策略，本函数只是给宿主（Electron CLI 编排出口等）用的呈现辅助。
export {
  presentAccessBarrier,
  buildUnattendedResolution as buildUnattendedAccessBarrierResolution,
} from './access-barrier/present.js';
export type {
  AccessBarrier,
  AccessBarrierKind,
  AccessBarrierActionId,
  AccessBarrierResolution,
  PresentAccessBarrierArgs,
} from './access-barrier/present.js';

// ─── OS Error Blacklist（#10614 后生产路径不再注入） ──────────
export {
  getSharedOSErrorBlacklist,
  OSErrorBlacklist,
  OS_ERROR_DEFAULT_TTL_MS,
} from './permissions/index.js';
export type {
  OSErrorBlacklistEntry,
  OSErrorBlacklistOptions,
} from './permissions/index.js';

// ─── Active Plan Tracker (W2-A) ─────────────────────────────────────
// 维护 session-scope 的"当前 active plan document_id"，由 plan_create 工具
// 写入、plan_exit 工具清除。W2-B 的 plan-mode-guard 通过 readonly
// `getActivePlan(sessionId)` 校验写工具的 target 是否合法。
export {
  markActivePlan,
  clearActivePlan,
  clearAllForSession as clearAllActivePlansForSession,
  getActivePlan,
  getActivePlanRef,
  getActivePlanFilePath,
  setActivePlanChangeListener,
  __snapshotActivePlans,
  __resetActivePlanTrackerForTests,
} from './state/active-plan-tracker.js';

export type {
  ActivePlanEntry,
  ActivePlanChangeEvent,
  ActivePlanClearReason,
} from './state/active-plan-tracker.js';

// ─── Plan Tools ─────────────────────────────────────────────────────
// Plan 模式二件套（plan_create / plan_update_todos）。`plan_exit` 已移除——
// 「执行」由用户点击 inline PlanProposalCard 完成；plan_create 落库后通过
// `agent.stream.plan_proposal` 事件向渲染端推送卡片快照。
export { createPlanTools } from './tools/plan-tools.js';

export type {
  PlanToolsDeps,
  PlanCreateToolInput,
  PlanUpdateTodosToolInput,
  PlanTodoInput,
  PlanPhaseInput,
} from './tools/plan-tools.js';

export {
  LocalFilePlanStore,
  normalizePlanTodos,
} from './tools/plan-store.js';
export type {
  PlanStore,
  PlanSnapshot,
  PlanContentInput,
  PlanStoreResult,
  PlanTodoStatus,
  NormalizedPlanTodo,
  LocalFilePlanStoreDeps,
} from './tools/plan-store.js';

// ─── Telemetry (H1-E) ───────────────────────────────────────────────
// 结构化埋点 API。宿主启动时 `setTelemetrySink` 注入落地逻辑，Runtime
// 内部通过 `emitTelemetryEvent` 上报事件。详见 `TELEMETRY.md`。
export {
  TelemetryEvents,
  setTelemetrySink,
  resetTelemetrySink,
  setTelemetryDebug,
  emitTelemetryEvent,
  hashSensitive,
  redactCustomRules,
  redactErrorBody,
  redactMessageContent,
  emitMttrStart,
  emitMttrResolved,
  generateIncidentId,
} from './telemetry/index.js';

export type {
  TelemetryRecord,
  TelemetrySink,
  TelemetryEmitOptions,
  TelemetryEventName,
  CustomRulesFingerprint,
  ErrorBodyFingerprint,
  MessageFingerprint,
  MttrStartPayload,
  MttrResolvedPayload,
} from './telemetry/index.js';

// ─── History / Cross-Turn Memory ─────────────────────────────────────
// 宿主无关的跨轮记忆装填逻辑。各宿主只需提供 HistorySourceMessage[]，
// 共享包负责选片、展开 tool 链、构建 initialMessages。
export {
  selectRecentHistoryForRuntime,
  filterUnresolvedToolUses,
  isCrossTurnMemoryEnabled,
  buildInitialMessages,
  buildUserMessageWithAttachments,
  KNOWN_HISTORY_BLOCK_TYPES,
  DEFAULT_MAX_HISTORY_MESSAGES,
  TOOL_RESULT_MAX_CHARS,
} from './history/index.js';

export type {
  RuntimeHistoryMessage,
  HistorySourceMessage,
  HistoryMessageBlock,
  SelectRecentHistoryOptions,
  CrossTurnMemoryConfig,
  EnvKillSwitchReader,
  UserMessageAttachment,
} from './history/index.js';
