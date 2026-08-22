/**
 * @tabtin/agent-modes — Agent Mode SSoT（独立包）
 *
 * 统一管理 ask / agent / plan / study / group 五种交互模式的：
 *   1. 工具白名单与访问策略（isToolAllowedByPolicy / evaluateAgentModeToolAccess）
 *   2. 注入 system prompt 的额外段落（getAgentModePromptSection）
 *   3. JSON contract 序列化（serializeAgentModeContract）— 跨语言对齐 Django
 *
 * 本包不依赖 @tabtin/agent-runtime，可被 agent-runtime、tabtin-electron、Daemon
 * 等多端直接 import。
 */

import { AGENT_MODE_CONFIGS } from './contract.js';
import type { AgentModeName } from './types.js';

export {
  AGENT_MODE_NAMES,
  SELECTABLE_AGENT_MODES,
  isAgentModeName,
  resolveAgentModeName,
  APPROVAL_MODE_NAMES,
  isApprovalModeName,
  resolveApprovalModeName,
} from './types.js';

export type {
  AgentModeName,
  ApprovalModeName,
  AgentModeMetadata,
  AgentModeConfig,
  AgentModeToolPolicy,
  AgentModeToolPolicyKind,
} from './types.js';

export {
  AGENT_MODE_CONFIGS,
  AGENT_MODE_CONTRACT_VERSION,
  getAgentModeConfig,
  getProposableModeTargets,
  serializeAgentModeContract,
} from './contract.js';

export type {
  SerializedAgentModeContract,
  SerializedAgentModeConfig,
  SerializedAgentModeMetadata,
  SerializedAgentModeToolPolicy,
} from './contract.js';

export {
  isToolAllowedForMode,
  isToolAllowedByPolicy,
  isToolAllowedBySerializedPolicy,
  listFilteredToolNames,
  getRestrictedShellAllowlist,
} from './tool-policy.js';

export type { ToolLike } from './tool-policy.js';

export {
  evaluateAgentModeToolAccess,
  annotateToolsForMode,
  extractToolPath,
  isPlanDraftPath,
  checkPlanDraftPath,
  getPathsForPermissionCheck,
  isPathResolvedWithinWorkspace,
  hasSuspiciousWindowsPathPattern,
  denyCodeToLegacyErrorCode,
  buildModeDisallowedToolError,
  buildModeToolOnlyInPlanError,
  buildModeDisallowedPathError,
  buildPathResolutionFailedError,
  buildNoActivePlanError,
  buildWrongTargetDocumentError,
  buildInvalidDocumentIdTypeError,
  isPlanModeGuardActive,
  PLAN_MODE_GUARDED_MODES,
  PLAN_TARGET_GUARDED_TOOLS,
} from './agent-mode-tool-guard.js';

export type {
  ModeDenyCode,
  ModeRemediationAction,
  ModeRemediation,
  ModeRestrictedError,
  ActivePlanTracker,
  EvaluateAgentModeToolAccessInput,
  EvaluateAgentModeToolAccessResult,
} from './agent-mode-tool-guard.js';

export {
  AGENT_MODE_PROMPT_SECTIONS,
  SECTION_AGENT_MODE_PLAN,
  SECTION_AGENT_MODE_ASK,
  SECTION_AGENT_MODE_STUDY,
  SECTION_AGENT_MODE_GROUP,
  SECTION_AGENT_MODE_AGENT,
  SECTION_AGENT_MODE_YOLO,
} from './prompt-sections.js';

import {
  PROMPT_ASK_SPARSE,
  PROMPT_PLAN_SPARSE,
  PROMPT_MODE_TRANSITION_REMINDER,
  PROMPT_STUDY_SPARSE,
} from './prompt-content.generated.js';

export interface AgentModeSparseReminderOptions {
  /** Plan 模式主 plan 文件路径（plan_create 落 TabDoc 后的本地引用，可选）。 */
  activePlanFilePath?: string;
}

/**
 * 返回指定模式应当注入到 system prompt 的额外段落；'agent' 模式或未知模式返回 null。
 */
export function getAgentModePromptSection(mode: AgentModeName): string | null {
  return AGENT_MODE_CONFIGS[mode]?.promptSection ?? null;
}

/** Phase 2 per-turn sparse reminder（ask / plan / study）。 */
export function getAgentModeSparseReminder(
  mode: 'ask' | 'plan' | 'study',
  options?: AgentModeSparseReminderOptions,
): string {
  const raw =
    mode === 'ask'
      ? PROMPT_ASK_SPARSE
      : mode === 'plan'
        ? PROMPT_PLAN_SPARSE
        : PROMPT_STUDY_SPARSE;
  let text = raw.trim();
  if (mode === 'plan' && options?.activePlanFilePath) {
    const hint = `（主 plan：\`${options.activePlanFilePath}\`）`;
    text = text.replace('{{planFilePath}}', hint);
  } else {
    text = text.replace('{{planFilePath}}', '');
  }
  return text;
}

export interface AgentModeTransitionReminderOptions {
  fromMode: AgentModeName;
  toMode: AgentModeName;
}

/** Mode 切换后注入一次，明确旧模式约束已退出、新模式边界已生效。 */
export function getModeTransitionReminder(
  options: AgentModeTransitionReminderOptions,
): string {
  return PROMPT_MODE_TRANSITION_REMINDER.trim()
    .replaceAll('{{fromMode}}', options.fromMode)
    .replaceAll('{{toMode}}', options.toMode);
}
