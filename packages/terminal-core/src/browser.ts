/**
 * Browser-safe subset of @tabtin/terminal-core.
 *
 * Excludes modules that depend on Node.js built-ins (fs, child_process, crypto, os):
 *   atomicWrite, commandExecutor, outputCollector, sandboxManager, pathUtils, platform
 *
 * Used by renderer-side consumers (e.g. @tabtin/security-policy → AgentSecurityPanel)
 * via Vite alias to avoid pulling in fs/promises at import time.
 */
export {
  // 旧 API（deprecated）
  resolveSpaceConversationsRoot,
  resolveSpaceSessionArchiveDir,
  resolveSpaceToolLogsDir,
  // 新 API
  resolveWorkspaceConversationsRoot,
  resolveWorkspaceSessionArchiveDir,
  resolveWorkspaceToolLogsDir,
} from './spacePaths';
export { CommandValidator, containsCommandSubstitution, containsEnvVarExpansion, containsAnsiCQuoting, splitCommandChain } from './commandValidator';
export { CRITICAL_DENYLIST, DEFAULT_DENYLIST, HARDLINE_COMMAND_DENYLIST } from './denylist';
export { DEFAULT_ALLOWLIST, RELAXABLE_ALLOW_RULES, resolveRelaxedRules, SENSITIVE_PATH_RULES, matchSensitivePath } from './allowlist';
export type { SensitivePathRule, ResolvedRelaxedRules } from './allowlist';
export {
  getInteractiveTerminalPolicySupportError,
  normalizeTerminalExecutionPolicy,
  toPolicyOverrides,
  evaluateTerminalPolicyDegradation,
} from './policy';
export type { DegradationDecision, DegradationReason } from './policy';
export {
  evaluateLocalTerminalPolicy,
  evaluateLocalFilePolicy,
  isAutoApprovedTerminalWrite,
  type LocalPolicyDecision,
} from './localSandboxPolicy';
export { setTerminalCoreLocale, setTerminalCoreTranslator, t as translateTerminalCore } from './i18n';
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
  TerminalMode
} from './types';
