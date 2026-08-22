/**
 * @tabtin/security-policy — 跨端统一安全策略引擎
 *
 * 所有安全决策的 SSOT。
 * Django 作为策略源，Daemon / Electron / MCP / CLI / Mobile 统一消费。
 *
 * v3 API（judge / checkHardline* / buildPolicyFromAgentConfigV2）是新代码的唯一入口。
 * 下方 @deprecated 区块在 bridge / pipeline 完整迁移后删除。
 */

/**
 * @deprecated v2 类型 — ElectronToolProvider / DaemonToolProvider /
 * skill-trust-layer / PermissionContext.effectivePolicy 仍引用此族。
 * 待这些消费方迁出 v3 judge / EffectivePolicy 后整块可删。
 *
 * 已清退（contract L-W6 收尾，2026-05-04）：
 *   - ActionType / EvaluateParams：Tool.policyActionType +
 *     extractPolicyParams: EvaluateParams 死代码族
 *   - PolicyAction / PolicyDecision / toPermissionBehavior：旧 PolicyEvaluator
 *     三态判决映射，v3 直接用 EffectivePolicy + Decision
 *   - AuthorizationPreset / OperationCategory / AuthorizationAction /
 *     AuthorizationRules：UI 粗粒度授权分组，无 TS 端 import 消费方
 *     （app-shell / agent-wire 已就地 redefine）
 *   - OPERATION_SWITCH_KEYS / OPERATION_CATEGORIES（值常量）：仅 types.ts
 *     内部用于 type 派生，外部无 import
 */
export type {
  UnifiedSecurityPolicy,
  TerminalMode,
  SwitchAction,
  OperationSwitchKey,
  OperationSwitches,
  DevicePermissionKey,
  DevicePermissions,
  SandboxLevel,
  NetworkMode,
  SqlMode,
  PermissionBehavior,
  SandboxPathGrant,
  SandboxPathGrantSource,
} from './types';

// ─── 旧 API 已删除（L-W6-06 PolicyEvaluator 消费者全迁 v3） ─────────
// PolicyEvaluator / presets / compat / CommandRuleSet / PathRuleSet 全删。
// 如需查原实现：`git log --all -- packages/security-policy/src/evaluator.ts`

export { CHECKPOINT_MUTATING_ACTIONS } from './constants';

// URL / Host validation (SSRF protection)
export {
  isPrivateIPv4,
  parseAlternativeIPv4,
  isPrivateHost,
  validateNavigationUrl,
  validateUrl,
  isAllowedScheme,
} from './url-validator';
export type { ValidationResult } from './url-validator';

// ===========================================================================
// v3 授权策略（"yolo + 工作区 + 红线 + 记忆"）
// ===========================================================================
//
// 与上方旧 API 共存；W2 起逐步淘汰旧 API。
// 消费方导入示例：
//   import { judge, buildPolicyFromAgentConfigV2, normalize } from '@tabtin/security-policy';
//
// ===========================================================================

// v3 类型
export type {
  // D.1
  AgentSecurityConfig,
  AgentConfigV3,
  ApprovalMode,
  ApprovalGrant,
  // D.2
  WorkspaceSources,
  WorkspaceSnapshot,
  // D.3
  ExecutionLimitsV3,
  EffectivePolicy,
  // D.4
  DecisionBehavior,
  Decision,
  DecisionReason,
  ResolutionHint,
  // D.5
  ApprovalMemoEntry,
  ApprovalMemoSnapshot,
  ApprovalMemoLookupResult,
  MemoSpecificity,
  MemoSyncSurface,
  MemoStore,
  // D.6
  PolicyActionKind,
  ToolPolicyMeta,
  JudgeTool,
  // D.7
  JudgeContext,
} from './types-v3';

// 路径规范化
export {
  normalize,
  isInWorkspace,
  isCwdInWorkspace,
  isPathInAllowedRoots,
  isDangerouslyBroadPath,
  MAX_SYMLINK_DEPTH,
  __clearNormalizeCache,
  __debugNormalizeCacheSize,
} from './path-normalize';
export type { NormalizeResult } from './path-normalize';

// v3 硬红线
export {
  ABSOLUTE_COMMAND_DENYLIST,
  ABSOLUTE_PATH_DENYLIST,
  SENSITIVE_PATH_LIST,
  CATASTROPHIC_COMMAND_RULE_NAMES,
  HARDLINE_V3_SCHEMA_VERSION,
  checkHardlineCommand,
  checkHardlinePath,
  checkSensitivePath,
  checkOpaquePowerShellCommand,
  extractPathsFromCommand,
  hasOpaqueWindowsDeleteTarget,
  isAbsoluteShellPath,
  isWindowsFileDeleteCommand,
  listHardlineV3Names,
} from './hardline-v3';
export type { HardlineHit, SensitivePathDecision } from './hardline-v3';

// pattern-key
export {
  hash16,
  canonicalInput,
  canonicalizeShellCommand,
  stableStringify,
  buildApprovalKey,
  lookupMemo,
} from './pattern-key';

// build-policy
export {
  buildPolicyFromAgentConfigV2,
  deriveApprovalMode,
  resolveApprovalGrant,
} from './build-policy';
export type { BuildPolicyOptions } from './build-policy';

// scope-descriptions
export { buildScopeDescription } from './scope-descriptions';

// judge
export { judge, UNKNOWN_WORKSPACE_OUT_PATH } from './judge';
export {
  detectPlatformManagedTabtinCli,
  type PlatformCliDeferral,
} from './platform-cli-deferral';
export {
  CLI_OUTPUTS_DIR_NAME,
  TABTIN_TOOL_RESULTS_DIR_NAME,
  getPlatformArtifactRoots,
  isPlatformArtifactPath,
  isPlatformArtifactReadAllowed,
} from './platform-artifact-paths';
export { isShellCommandWriteOp } from './shell-command-side-effect';

// Cross-platform device permission contract (SSoT for iOS / Android / Django alignment)
export {
  AUTHORITATIVE_ACTION_PERMISSION_MAPPING,
  AUTHORITATIVE_ACTION_MAPPING_NOTES,
  AUTHORITATIVE_DJANGO_PRESET_VALUES,
  ENFORCEMENT_SITES,
} from './cross-platform-permission-contract';
export type {
  DjangoPresetName,
  EnforcementSite,
} from './cross-platform-permission-contract';
