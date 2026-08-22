export { atomicWriteFileSync, atomicWriteFile, type AtomicWriteOptions } from './atomicWrite';
export { CommandExecutor } from './commandExecutor';
export { CommandValidator, containsCommandSubstitution, containsEnvVarExpansion, containsAnsiCQuoting, splitCommandChain } from './commandValidator';
export { CommandValidationError, isCommandValidationError } from './commandValidationError';
export { detectUnquotedWorkspacePath, type UnquotedWorkspacePathHit } from './cwd-quote-protection';
export {
  DANGEROUS_INVISIBLE_CODEPOINTS,
  stripDangerousUnicode,
  detectDangerousUnicode,
  containsDangerousUnicode,
  stripInvisibleUnicode,
  containsInvisibleUnicode,
  normalizeForMatching,
} from './unicodeSecurity';
export type { UnicodeDetectionResult } from './unicodeSecurity';
export { OutputCollector } from './outputCollector';
export { SandboxManager, isSymlinkWithinRoot } from './sandboxManager';
export { CRITICAL_DENYLIST, DEFAULT_DENYLIST, HARDLINE_COMMAND_DENYLIST } from './denylist';
export { DENY_RULE_HINTS } from './deny-rule-hints';
export { DEFAULT_ALLOWLIST, RELAXABLE_ALLOW_RULES, resolveRelaxedRules, SENSITIVE_PATH_RULES, matchSensitivePath } from './allowlist';
export type { SensitivePathRule, ResolvedRelaxedRules } from './allowlist';
export {
  getInteractiveTerminalPolicySupportError,
  normalizeTerminalExecutionPolicy,
  toPolicyOverrides,
  evaluateTerminalPolicyDegradation,
} from './policy';
export type { DegradationDecision, DegradationReason } from './policy';
export { resolveDataRoot, resolveSpacesRoot, resolvePlatformDataRoot, resolveCommandSandboxRoot, resolveWorkspaceRoot } from './pathUtils';
export {
  assertSafeStorageSegment,
  isSafeStorageSegment,
  // 旧 API（deprecated；见 spacePaths.ts JSDoc）
  resolveOrganizationSpacesRoot,
  resolveSpaceWorkspaceRoot,
  resolveSpacePlatformDataRoot,
  resolveSpaceSkillsDir,
  resolveSpaceSkillDir,
  resolveSpacePluginsDir,
  resolveSpacePluginRegistryFile,
  resolveSpacePluginDir,
  resolveSpaceDownloadsDir,
  resolveSpaceSiteDir,
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
  // 新 API（ SSoT）
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
} from './spacePaths';
export {
  evaluateAgentShellSecurityFloor,
  evaluateLocalTerminalPolicy,
  evaluateLocalFilePolicy,
  isAutoApprovedTerminalWrite,
  type LocalPolicyDecision,
} from './localSandboxPolicy';
export { setTerminalCoreLocale, setTerminalCoreTranslator, t as translateTerminalCore, degradedBanner, degradedFooter, degradedErrorFooter } from './i18n';
export { executeDegraded } from './degraded-executor';
export type { DegradedExecuteOptions, DegradedExecuteResult } from './degraded-executor';
export {
  ManagedTaskStore,
  resolveNotificationRouteThreadId,
  resolveBackgroundTaskRelayThreadId,
  hashEnvVars,
  MANAGED_TASK_RECORD_TTL_MS,
  MANAGED_TASK_GC_INTERVAL_MS,
  MANAGED_TASK_SCHEMA_VERSION,
  HARD_TIMEOUT_WARNING_MS,
  HARD_TIMEOUT_KILL_MS,
  DEDUP_WINDOW_MS,
} from './managed-task-store';
export { toPersistedManagedTask } from './managed-task-store';
export type {
  ManagedTaskRecord,
  ManagedTaskStatus,
  ManagedTaskNotificationState,
  ManagedTaskOwner,
  ExitedBy,
  KilledReason,
  ManagedTaskHardTimeoutHandlers,
  ManagedTaskStoreOptions,
  PersistedManagedTask,
  ManagedTaskPersistence,
} from './managed-task-store';
export {
  reconcileManagedTask,
  reconcileManagedTasks,
  isProcessAlive,
  readSidecarExitCode,
  outputFileExistsDefault,
  DEFAULT_RECONCILE_POLL_INTERVAL_MS,
  DEFAULT_RECONCILE_POLL_TIMEOUT_MS,
} from './managed-task-reconcile';
export type {
  ManagedTaskReconcileRecord,
  ManagedTaskReconcileDeps,
  ReconcileTerminalState,
  ReconcileOutcome,
} from './managed-task-reconcile';
export {
  NotificationQueue,
  NOTIFICATION_QUEUE_TTL_MS,
  NOTIFICATION_DEDUP_WINDOW_MS,
  NOTIFICATION_QUEUE_GC_INTERVAL_MS,
} from './notification-queue';
export type {
  NotificationEnvelope,
  NotificationPriority,
  NotificationQueueOptions,
  NotificationQueueListener,
  NotificationQueueUnsubscribe,
  BackgroundTaskCompletedPayload,
  SubagentCompletedPayload,
} from './notification-queue';
export {
  composeNotificationPrompt,
  buildSubagentCompletionEnvelope,
  SHELL_NOTIFICATION_KIND,
  SUBAGENT_NOTIFICATION_KIND,
} from './notification-prompt';
export type { ComposeNotificationPromptOptions } from './notification-prompt';
export { detectInteractiveCommand } from './interactive-detect';
export type { InteractiveDetectionResult } from './interactive-detect';
export {
  computeSkillContentHash,
  computeSkillContentHashSync,
} from './skill-content-hash';
export * from './backend/index';
export { createPlatformSandbox } from './platform';
export { getBwrapUnavailableReason, isWSL } from './platform/detect';
export { WindowsSandbox } from './platform/windows';
export type { PlatformSandbox, SandboxParams, SandboxSpawnArgs } from './platform';
export type {
  AllowRule,
  CommandDecision,
  CommandValidationResult,
  DenyRule,
  TerminalAutoRespondRule,
  TerminalCapability,
  TerminalExecuteRequest,
  TerminalExecuteResponse,
  TerminalExecutionContext,
  TerminalExecutionPolicy,
  TerminalExecutionPolicyPayload,
  TerminalNetworkMode,
  TerminalReadOutput,
  TerminalRoute,
  TerminalRuntimeBridge,
  TerminalSessionMetadata,
  TerminalSessionSummary,
  ExecuteOptions,
  ExecuteResult,
  ExecutorConfig,
  PolicyOverrides,
  SandboxContext,
  SandboxLevel,
  StreamingExecuteOptions,
  StreamingHandle,
  TerminalMode
} from './types';

// ==================== Agent Shell Bridge (WP0 公共契约 / WP2 实现 / WP1 消费) ====================
//
// agent-bridge.ts 是本地 LLM ShellCap ←→ 两端 PtyManager 实现的公共契约面；
// agent-output-tail.ts 是 bridge 层 detached 路径持续写盘 + GC 共享 helper；
// agent-bridge-contract.ts 是两端 contract test 共用的 describe runner。
//
// re-export 让下游消费者（runtime-bridge.ts / ShellCap / bridge 两端实现）
// 都从 `@tabtin/terminal-core` 顶层 import，避免 subpath 漂移。
export type {
  AgentBackgroundedReason,
  AgentCommandProgressSnapshot,
  AgentCommandRequest,
  AgentCommandResult,
  AgentCommandStatus,
  AgentKillSignal,
  AgentProgressDispatcher,
  AgentReadOptions,
  AgentReadResult,
  AgentSessionCloseReason,
  AgentSessionClosed,
  AgentSessionCreated,
  AgentSessionEventHandler,
  AgentSessionEventMap,
  AgentSessionEventName,
  AgentSessionUnsubscribe,
  AgentSpawnDetachedResult,
  CreateAgentProgressDispatcherOptions,
  PtyManagerBridge,
} from './agent-bridge';
export {
  createAgentProgressDispatcher,
  DEFAULT_AGENT_COMMAND_TIMEOUT_MS,
  unimplementedPtyManagerBridge,
} from './agent-bridge';
export {
  spawnAgentShellProcess,
  ExecutionRootUnreachableError,
  killProcessTreeByPid,
  resolveAgentShellInfo,
  classifyShellKind,
  SKILL_CREDENTIAL_PRESERVE_ENV_KEYS_MARKER,
} from './agent-process-runner';
export type {
  AgentShellProcessHandle,
  AgentShellProcessOptions,
  AgentShellProcessResult,
  AgentShellInfo,
  AgentShellKind,
} from './agent-process-runner';
export {
  AgentOutputTail,
  AGENT_OUTPUT_TAIL_MAX_FILE_BYTES,
  AGENT_OUTPUT_TAIL_KEEP_BYTES,
  AGENT_OUTPUT_TAIL_MAX_AGE_MS,
  tabtinAgentTasksDir,
  tabtinAgentTaskLogPath,
  tabtinAgentTaskStatusPath,
  runAgentOutputTailGC,
} from './agent-output-tail';
export type {
  AgentOutputTailLogger,
  AgentOutputTailGCOptions,
  AgentOutputTailGCResult,
} from './agent-output-tail';
export {
  AgentPromptStallWatchdog,
  looksLikeInteractivePrompt,
} from './agent-stall-watchdog';
export type {
  AgentPromptStallWatchdogOptions,
} from './agent-stall-watchdog';

// **注意**：`describeAgentBridgeContract` 与 `AgentBridgeContractFixture` 等
// contract test 相关 export 故意**不在主 entry re-export**——它们 import
// `'vitest'`，若进主 entry 会让生产 import 链触发 vitest 副作用，引起
// `Cannot find module '@vitest/runner'` 或 ESM live binding 失败。
// 下游消费者通过 sub-path `@tabtin/terminal-core/agent-bridge-contract`
// import（见 `package.json` exports + `tsup` 独立 entry + vitest external）。
