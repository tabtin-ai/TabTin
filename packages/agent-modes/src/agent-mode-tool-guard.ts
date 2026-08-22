/**
 * agent-mode-tool-guard — Ask / Plan / Study 模式工具调用拦截 SSoT
 *
 * Phase 1 主闸门：把"按 mode 拒/允"的判定收口到一个函数
 * `evaluateAgentModeToolAccess()`。消费路径（ 收敛后）：
 *
 *   1. `@tabtin/security-policy::judge()` step 0（生产主路径，hasJudge 永真）
 *   2. `@tabtin/agent-runtime` query.ts pre-start 探针（受限模式漏网工具兜底）
 *
 * 两处都只调本 SSoT，不再有 runtime wrapper（旧 `createPlanModeGuard()` 已删）。
 *
 * 设计原则（总控 §5）：
 *   - 拒绝信息 = 诊断（为什么拒）+ remediation（应该怎么做）
 *   - 单 SSoT：不允许 judge / Provider 之间各自复刻策略表
 *   - 返回结构对模型友好：英文 LLM-facing 文案 + 结构化字段
 *
 * **不依赖 @tabtin/agent-runtime**：agent-modes 是叶子包，被 security-policy /
 * agent-runtime / 两个 Provider 共同消费。Active plan tracker 的细颗粒度 target
 * 校验随旧 wrapper 一并退役；judge step 0 用 `planTargetWriteGuarded` 粗粒度
 * marker 对写工具在受限模式统一 deny。
 */

import { AGENT_MODE_CONFIGS } from './contract.js';
import {
  checkPlanDraftPath,
  getPlanDraftPathExtension,
  isPlanDraftPath,
} from './permission-path.js';
import { isToolAllowedByPolicy, type ToolLike } from './tool-policy.js';
import type { AgentModeName } from './types.js';

export { isPlanDraftPath, checkPlanDraftPath, getPathsForPermissionCheck, isPathResolvedWithinWorkspace, hasSuspiciousWindowsPathPattern } from './permission-path.js';
export type { PathResolutionError, PathsForPermissionCheckResult, PlanDraftPathCheckResult, PlanDraftPathDenyReason } from './permission-path.js';

// ─── 拒绝码 / Remediation / 错误结构 ─────────────────────────────────

/**
 * 软拒原因码（snake_case，对齐 telemetry / `error_kind` 字段）。
 *
 * 前 4 个来自原 `PlanGuardDenyCode`（向后兼容保留）；后 2 个 v3 新增。
 */
export type ModeDenyCode =
  /** 工具不在当前 mode 的 allow 列表内（默认 deny 路径） */
  | 'mode_disallowed_tool'
  /** 写工具试图改 plan 文档但当前 session 无 active plan */
  | 'no_active_plan'
  /** 写工具的 target document_id 不等于 active plan id */
  | 'wrong_target_document'
  /** 写工具的 target document_id 字段类型不合法（非字符串） */
  | 'invalid_document_id_type'
  /** 写工具的 path 不在当前 mode 允许的扩展名/路径范围内（Phase 2 path-aware 使用） */
  | 'mode_disallowed_path'
  /** path canonicalize / fs 解析失败（fail-closed） */
  | 'path_resolution_failed'
  /** plan_create / plan_update_todos 等 plan 族工具在 ask 等非 plan/study 模式被调用 */
  | 'mode_tool_only_in_plan';

/** Remediation action — 告诉模型下一步应该做什么。 */
export type ModeRemediationAction =
  /**
   * Plan 模式专属：模型可以调 switch_mode 工具请求用户审批切到 Agent。
   * **重要**：仅当 plan 模式的 switch_mode 工具可见时使用；ask 模式下
   * switch_mode 不在工具表（contract 未放行），不能用此 action（用 `request_user_switch`）。
   */
  | 'switch_mode'
  /**
   * Phase 3 F11 修复：ask 模式专属——请用户在界面上**手动**切到 Agent。
   * 与 `switch_mode` 区别：模型自己**不**能调任何工具发起切换，
   * 必须等用户主动操作。文案明确"manually via the mode selector"。
   */
  | 'request_user_switch'
  /** 引导换用另一个工具（如 ls → glob_search, cat → read_file） */
  | 'use_tool'
  /** 引导改 path（如 Plan 模式下 `.ts` 改为 `.md`） */
  | 'change_path'
  /** 引导先调 plan_create 再调写工具 */
  | 'use_plan_create'
  /** 仅适用于 Plan 模式：让用户点 PlanProposalCard "执行" 按钮 */
  | 'user_click_proposal_card';

export interface ModeRemediation {
  action: ModeRemediationAction;
  /** D1：本期 SwitchMode 仅支持 plan→agent，固定 `'agent'`。 */
  target_mode_id?: 'agent';
  /** action=use_tool 时建议的替代工具名 */
  suggested_tool?: string;
  /** action=change_path 时建议的扩展名（如 ".md" / ".canvas.tsx"） */
  suggested_extension?: string;
  /**
   * 自然语言 hint，给 LLM 直接读。文案规范：
   *   - 英文为主（LLM-facing）
   *   - 明确说当前 mode + 拒因 + 推荐动作
   *   - 不啰嗦，单句 / 双句
   */
  hint: string;
}

/**
 * 统一的 mode 拒绝错误结构。
 *
 * 这是 `evaluateAgentModeToolAccess` 返回 `allowed: false` 时携带的 payload，
 * 由 judge step 0 投影到 `plan_blocked` decision 与 tool error 事件。
 */
export interface ModeRestrictedError {
  /** LLM-facing 主文案（英文） */
  error: string;
  /** 兼容旧 `code` 字段（如 'PLAN_MODE_TOOL_DENIED'） */
  code: string;
  /** 统一 error_kind，与 `packages/agent-runtime/src/engine/error-kinds.ts` 对齐 */
  error_kind: 'mode_restricted';
  /** 当前 mode（ask / plan / study） */
  agent_mode: AgentModeName;
  /** 拒绝原因 enum */
  deny_code: ModeDenyCode;
  /** 工具名 */
  tool_name: string;
  /** 引导结构 */
  remediation: ModeRemediation;
  /** 附加上下文：path / target_field / active_plan_id 等 */
  details?: Record<string, unknown>;
}

/** 从 deny code 映射到旧 error code（兼容现有 telemetry / 前端字段）。 */
export function denyCodeToLegacyErrorCode(code: ModeDenyCode): string {
  switch (code) {
    case 'mode_disallowed_tool':
      return 'PLAN_MODE_TOOL_DENIED';
    case 'no_active_plan':
      return 'PLAN_MODE_NO_ACTIVE_PLAN';
    case 'wrong_target_document':
      return 'PLAN_MODE_WRONG_TARGET';
    case 'invalid_document_id_type':
      return 'PLAN_MODE_INVALID_TARGET_TYPE';
    case 'mode_disallowed_path':
      return 'PLAN_MODE_PATH_DENIED';
    case 'path_resolution_failed':
      return 'PLAN_MODE_PATH_RESOLUTION_FAILED';
    case 'mode_tool_only_in_plan':
      return 'PLAN_MODE_TOOL_ONLY_IN_PLAN';
  }
}

// ─── 内部辅助 ────────────────────────────────────────────────────────

function humanModeLabel(mode: AgentModeName): string {
  switch (mode) {
    case 'plan':
      return 'Plan';
    case 'study':
      return 'Study';
    case 'ask':
      return 'Ask';
    case 'agent':
      return 'Agent';
    case 'group':
      return 'Group';
    case 'yolo':
      return 'Yolo';
    default:
      return mode;
  }
}

function modeAdvice(mode: AgentModeName): string {
  switch (mode) {
    case 'plan':
      return (
        'Plan mode is read-only. Use plan_create / plan_update_todos to draft a plan, ' +
        'then end your turn with a brief summary — the user clicks the Execute button ' +
        'on the inline proposal card to switch to agent mode.'
      );
    case 'study':
      return (
        'Study mode forbids destructive writes. Stick to read-only investigation, ' +
        'todo_write, present_to_user, and the plan_* tools.'
      );
    case 'ask':
      return (
        'Ask mode is pure Q&A — no writes, no todo_write. ' +
        'Use `agent(readonly: true, ...)` for readonly sub-agent research; ' +
        'non-readonly forks require agent mode.'
      );
    default:
      return '';
  }
}

/** 限制提示中暴露的工具名数量，防止 contract 长大后 deny 文案膨胀挤占 LLM context。 */
const ALLOWED_TOOLS_HINT_PREVIEW_LIMIT = 6;

function listAllowedToolNamesHint(mode: AgentModeName): string {
  const policy = AGENT_MODE_CONFIGS[mode]?.toolPolicy;
  if (!policy) return '';
  // F11（2026-05-28）：deny 提示不暴露 `switch_mode`——模型会把它误读成
  // "调 switch_mode 就能解锁写工具"，而实际切换需要用户批准（且 ask 模式只能
  // 请求切 plan）。此前靠 PREVIEW_LIMIT 截断偶然隐藏；#3709 白名单变短后显式排除。
  const explicit = policy.allowToolNames.filter((n) => n !== 'switch_mode');
  const previewed = explicit.slice(0, ALLOWED_TOOLS_HINT_PREVIEW_LIMIT);
  const overflow = Math.max(0, explicit.length - previewed.length);
  const parts: string[] = [...previewed];
  if (overflow > 0) {
    parts.push(`…+${overflow} more (see details.allowed_tool_names)`);
  }
  if (policy.defaultAllowReadOnly) {
    parts.push('plus read-only tools');
  }
  return parts.join(', ');
}

// ─── 错误构造函数 ────────────────────────────────────────────────────

/**
 * 构造"工具不在当前 mode 允许列表"的拒绝结构（最常见场景）。
 *
 * P1-5 修复（2026-05-27）：plan / study 模式的 remediation 改为
 * `use_plan_create`（而不是 `switch_mode`）。
 *
 * **旧 bug**：plan 模式调 write_file 被拒时 remediation.action === 'switch_mode'
 * + "Ask the user to switch to agent mode"——模型按提示劝用户切 agent 模式，
 * 违背 plan 模式产品意图（plan 模式的核心动作是先调 plan_create 落 TabDoc +
 * PlanProposalCard，让用户点"执行"按钮自动切到 agent 执行，而不是让用户手动切）。
 *
 * **修法**：
 *   - ask 模式：保留 `switch_mode`（合理：ask 是纯问答，写工具就是模式不对）
 *   - plan / study 模式：改为 `use_plan_create`（引导先写 plan 文档，end turn 等用户）
 */
export function buildModeDisallowedToolError(args: {
  agentMode: AgentModeName;
  toolName: string;
}): ModeRestrictedError {
  const { agentMode, toolName } = args;
  const allowedToolHint = listAllowedToolNamesHint(agentMode);
  const advice = modeAdvice(agentMode);
  const policy = AGENT_MODE_CONFIGS[agentMode]?.toolPolicy;
  const remediation = buildRemediationForDisallowedTool(agentMode, toolName, allowedToolHint);
  return {
    error: `You are in ${humanModeLabel(agentMode).toLowerCase()} mode and cannot run '${toolName}'.`,
    code: denyCodeToLegacyErrorCode('mode_disallowed_tool'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'mode_disallowed_tool',
    tool_name: toolName,
    remediation,
    details: {
      agent_mode: agentMode,
      allowed_tool_hint: allowedToolHint,
      allowed_tool_names: policy ? [...policy.allowToolNames] : [],
      default_allow_read_only: policy?.defaultAllowReadOnly ?? false,
      mode_advice: advice,
    },
  };
}

function buildRemediationForDisallowedTool(
  agentMode: AgentModeName,
  toolName: string,
  allowedToolHint: string,
): ModeRemediation {
  const modeLabel = humanModeLabel(agentMode);
  switch (agentMode) {
    case 'plan':
    case 'study':
      // P1-5：plan / study 模式引导用 plan_create 而不是劝用户切 mode。
      // 用户预期的流程：模型先调 plan_create 草拟方案 → PlanProposalCard
      // → 用户点"执行" → runtime 自动切到 agent 模式执行（不需要用户去切 mode）。
      return {
        action: 'use_plan_create',
        hint:
          `${modeLabel} mode does not allow tool '${toolName}'. ` +
          `Use \`plan_create\` to draft a structured plan, then end your turn. ` +
          `The user clicks "Execute" on the inline proposal card to switch to agent mode and run it. ` +
          `Available in this mode: ${allowedToolHint}.`,
      };
    case 'ask':
    default:
      // F11 修复（2026-05-28）：ask 模式 contract 不放行 switch_mode 工具，
      // 旧 hint 暗示模型可调 switch_mode 是误导（工具表里看不到）。
      // 改为 `request_user_switch` action，明确要求用户**手动**在模式选择器切。
      return {
        action: 'request_user_switch',
        target_mode_id: 'agent',
        hint:
          `${modeLabel} mode does not allow tool '${toolName}'. ` +
          `Available in this mode: ${allowedToolHint}. ` +
          `You cannot switch modes yourself — answer with read-only tools or ask the user to ` +
          `switch to agent mode manually via the mode selector at the bottom-left of the chat input.`,
      };
  }
}

/** 构造"plan 族工具在非 plan/study 模式被调用"的拒绝结构。 */
export function buildModeToolOnlyInPlanError(args: {
  agentMode: AgentModeName;
  toolName: string;
}): ModeRestrictedError {
  const { agentMode, toolName } = args;
  return {
    error: `Tool '${toolName}' is only available in plan or study mode.`,
    code: denyCodeToLegacyErrorCode('mode_tool_only_in_plan'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'mode_tool_only_in_plan',
    tool_name: toolName,
    remediation: {
      // TD-18 (Phase 4) 修复：原 action: 'switch_mode' 是误导——ask 模式下
      // switch_mode 工具不可见（contract 仅在 plan 模式注册），模型按 action 字面
      // 量调 switch_mode 会撞工具未注册错误。统一到与 F11 一致的 'request_user_switch'。
      action: 'request_user_switch',
      target_mode_id: 'agent',
      hint:
        `'${toolName}' belongs to the plan tool family and only exists in plan/study mode. ` +
        `In ${humanModeLabel(agentMode).toLowerCase()} mode, answer the user directly without creating a plan document; ` +
        `if planning is really needed, ask the user to switch to plan mode manually via the mode selector at the bottom-left of the chat input.`,
    },
    details: { agent_mode: agentMode },
  };
}

/** 构造"plan 模式 path 不在允许扩展名内"的拒绝结构（Phase 2 path-aware 使用）。 */
export function buildModeDisallowedPathError(args: {
  agentMode: AgentModeName;
  toolName: string;
  path: string;
  pathExtension: string;
}): ModeRestrictedError {
  const { agentMode, toolName, path, pathExtension } = args;
  return {
    error:
      `${humanModeLabel(agentMode)} mode can only edit markdown (.md) and canvas (.canvas.tsx) files. ` +
      `Path '${path}' (${pathExtension || 'no extension'}) is not allowed.`,
    code: denyCodeToLegacyErrorCode('mode_disallowed_path'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'mode_disallowed_path',
    tool_name: toolName,
    remediation: {
      action: 'change_path',
      suggested_extension: '.md',
      hint:
        `Save your draft as a \`.md\` file instead, or use \`plan_create\` for the structured plan.`,
    },
    details: { agent_mode: agentMode, path, path_extension: pathExtension },
  };
}

/** 构造"path 解析失败"的拒绝结构（fail-closed）。 */
export function buildPathResolutionFailedError(args: {
  agentMode: AgentModeName;
  toolName: string;
  path: string;
}): ModeRestrictedError {
  const { agentMode, toolName, path } = args;
  return {
    error:
      `${humanModeLabel(agentMode)} mode could not verify path '${path}' — filesystem resolution failed.`,
    code: denyCodeToLegacyErrorCode('path_resolution_failed'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'path_resolution_failed',
    tool_name: toolName,
    remediation: {
      action: 'change_path',
      suggested_extension: '.md',
      hint:
        `Use a simple relative \`.md\` path under the workspace, or retry with \`plan_create\` for the main plan.`,
    },
    details: { agent_mode: agentMode, path },
  };
}

/** 构造"无 active plan 但试图改 plan target 工具"的拒绝结构。 */
export function buildNoActivePlanError(args: {
  agentMode: AgentModeName;
  toolName: string;
  targetField: string;
  providedId: string | null;
}): ModeRestrictedError {
  const { agentMode, toolName, targetField, providedId } = args;
  return {
    error:
      `${humanModeLabel(agentMode)} mode write blocked: no active plan in this session. ` +
      `'${toolName}' may only modify the active plan document.`,
    code: denyCodeToLegacyErrorCode('no_active_plan'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'no_active_plan',
    tool_name: toolName,
    remediation: {
      action: 'use_plan_create',
      hint:
        `Call plan_create first to draft a plan. Until the user clicks "Execute" on the inline ` +
        `proposal card, write tools may only target that plan document.`,
    },
    details: {
      agent_mode: agentMode,
      tool_target_field: targetField,
      provided_document_id: providedId,
    },
  };
}

/** 构造"target document_id 不等于 active plan id"的拒绝结构。 */
export function buildWrongTargetDocumentError(args: {
  agentMode: AgentModeName;
  toolName: string;
  targetField: string;
  activePlanId: string;
  providedId: string | null;
}): ModeRestrictedError {
  const { agentMode, toolName, targetField, activePlanId, providedId } = args;
  return {
    error:
      `${humanModeLabel(agentMode)} mode write target rejected: ` +
      `'${toolName}' may only modify the active plan document ('${activePlanId}'), ` +
      `not '${providedId ?? '(missing)'}'.`,
    code: denyCodeToLegacyErrorCode('wrong_target_document'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'wrong_target_document',
    tool_name: toolName,
    remediation: {
      action: 'user_click_proposal_card',
      hint:
        `To modify other documents, end this turn so the user can click "Execute" on the proposal card — ` +
        `the runtime then switches to agent mode where unrestricted writes are allowed.`,
    },
    details: {
      agent_mode: agentMode,
      tool_target_field: targetField,
      active_plan_document_id: activePlanId,
      provided_document_id: providedId,
    },
  };
}

/** 构造"target document_id 字段类型错"的拒绝结构。 */
export function buildInvalidDocumentIdTypeError(args: {
  agentMode: AgentModeName;
  toolName: string;
  targetField: string;
  actualType: string;
}): ModeRestrictedError {
  const { agentMode, toolName, targetField, actualType } = args;
  return {
    error:
      `${humanModeLabel(agentMode)} mode write blocked: ` +
      `'${toolName}.${targetField}' must be a non-empty string, got ${actualType}.`,
    code: denyCodeToLegacyErrorCode('invalid_document_id_type'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'invalid_document_id_type',
    tool_name: toolName,
    remediation: {
      action: 'use_tool',
      hint: `Re-read the tool input schema and re-issue with a string document_id.`,
    },
    details: {
      agent_mode: agentMode,
      tool_target_field: targetField,
      provided_document_id_type: actualType,
    },
  };
}

// ─── Plan / Study / Ask 触发 guard 的模式集 ──────────────────────────

/** Plan / Study / Ask 触发 guard；其它模式 (agent / group / yolo / undefined) 直接放行。 */
export const PLAN_MODE_GUARDED_MODES: ReadonlySet<AgentModeName> = new Set<AgentModeName>([
  'plan',
  'study',
  'ask',
]);

export function isPlanModeGuardActive(agentMode: AgentModeName | undefined): boolean {
  return !!agentMode && PLAN_MODE_GUARDED_MODES.has(agentMode);
}

/**
 * 写工具 → target document_id 字段名。Plan / Study 模式下这些工具的 args 必须满足
 * `args[document_id_field] === activePlan(sessionId)`，否则 guard 拒绝。
 *
 * **优先级（重要）**：登记在此清单的工具在 target check 路径会**跳过第一道闸门**
 * （mode 工具白名单）。
 *
 * **#2627 收敛后**：judge.ts step 0 调 `evaluateAgentModeToolAccess` **不**注入
 * activePlanTracker，target 细颗粒度豁免（`target === active_plan_id` 时 allow）
 * 不触发；受限模式下这些写工具统一走 mode 白名单 deny，与 plan.md「软拒」文案
 * 一致。judge 另用 `planTargetWriteGuarded`（本 Map 的 boolean 投影）作粗粒度
 * 兜底 deny。旧 runtime wrapper（`createPlanModeGuard()` + tracker 注入）已删除，
 * 细颗粒度 target 校验随之退役——本 Map 现只用于 `planTargetWriteGuarded` marker。
 */
export const PLAN_TARGET_GUARDED_TOOLS: ReadonlyMap<string, string> = new Map([
  ['tabdoc_update_document', 'document_id'],
  ['tabdoc_replace_content', 'document_id'],
]);

/**
 * Plan 系列工具名（plan_create / plan_update_todos / todo_write）。
 *
 * 在 ask 模式（plan_create / plan_update_todos / todo_write 都不在 allow 列表）
 * 触发 `mode_tool_only_in_plan` 的细粒度提示，让模型走"切到 plan 模式或直接答用户"
 * 的自纠路径，而不是普通的 `mode_disallowed_tool`。
 */
const PLAN_FAMILY_TOOL_NAMES: ReadonlySet<string> = new Set([
  'plan_create',
  'plan_update_todos',
  'todo_write',
]);

/** Plan / Study 模式下按 path 放行的写工具（Phase 2 path-aware）。 */
const PLAN_DRAFT_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'edit_file',
]);

/** D12.1：受限模式下 `agent` 工具按 input.readonly 三分支裁定。 */
const AGENT_TOOL_NAME = 'agent';

function readReadonlyFromAgentInput(toolInput: unknown): boolean | undefined {
  if (toolInput == null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return undefined;
  }
  const value = (toolInput as Record<string, unknown>).readonly;
  if (value === true) return true;
  if (value === false) return false;
  return undefined;
}

/**
 * 构造"受限模式调 agent 工具但未传 readonly: true"的拒绝结构（D12.1）。
 *
 * 复用 mode_disallowed_tool deny code；hint 明确 readonly 要求。
 */
export function buildAgentRequiresReadonlySubagentError(args: {
  agentMode: AgentModeName;
  toolName: string;
}): ModeRestrictedError {
  const { agentMode, toolName } = args;
  const modeLabel = humanModeLabel(agentMode);
  const allowedToolHint = listAllowedToolNamesHint(agentMode);
  const remediation: ModeRemediation =
    agentMode === 'ask'
      ? {
          action: 'request_user_switch',
          target_mode_id: 'agent',
          hint:
            `In ${modeLabel} mode, \`${toolName}\` requires \`readonly: true\`. ` +
            `Use \`${toolName}(readonly: true, ...)\` to spawn a readonly subagent, or ask the user to ` +
            `switch to agent mode manually via the mode selector at the bottom-left of the chat input for unrestricted fork. ` +
            `Available in this mode: ${allowedToolHint}.`,
        }
      : {
          action: 'use_plan_create',
          hint:
            `In ${modeLabel} mode, \`${toolName}\` requires \`readonly: true\`. ` +
            `Use \`${toolName}(readonly: true, ...)\` to spawn a readonly subagent for parallel research. ` +
            `For unrestricted sub-agents, ask the user to switch to agent mode. ` +
            `Available in this mode: ${allowedToolHint}.`,
        };
  return {
    error: `You are in ${modeLabel.toLowerCase()} mode and cannot run '${toolName}' without readonly: true.`,
    code: denyCodeToLegacyErrorCode('mode_disallowed_tool'),
    error_kind: 'mode_restricted',
    agent_mode: agentMode,
    deny_code: 'mode_disallowed_tool',
    tool_name: toolName,
    remediation,
    details: {
      agent_mode: agentMode,
      requires_readonly_subagent: true,
      allowed_tool_hint: allowedToolHint,
    },
  };
}

// ─── 主评估函数 ──────────────────────────────────────────────────────

/**
 * Active Plan Tracker — 抽象依赖接口（可选 target 细颗粒度校验用）。
 *
 *  后**已无生产注入方**：judge.ts step 0 与 query.ts pre-start 都不注入
 * tracker（受限模式对写工具走 `planTargetWriteGuarded` 粗粒度 deny）。接口保留
 * 供潜在 host 自定义 target 校验，不影响主路径。
 */
export interface ActivePlanTracker {
  getActivePlan(sessionId: string): string | null;
}

/** evaluateAgentModeToolAccess 入参。 */
export interface EvaluateAgentModeToolAccessInput {
  tool: ToolLike;
  toolInput: unknown;
  agentMode: AgentModeName | undefined;
  /** 可选：active plan tracker 的 session key；judge step 0 省略。 */
  sessionId?: string;
  /**
   * 可选：Space working_dir，用于相对 path 解析与 symlink 链 canonicalize。
   * judge.ts 从 `effectivePolicy.workspace.sources.workingDir` 透传。
   */
  workspaceRoot?: string;
  /**
   * 可选：注入 active plan tracker 后才会跑 target check（PLAN_TARGET_GUARDED_TOOLS
   * 那两个写工具的 document_id === active_plan_id 校验）。judge.ts 不传 → 完全走
   * mode policy 路径；agent-runtime/permissions/plan-mode-guard.ts 必传。
   */
  activePlanTracker?: ActivePlanTracker;
}

export type EvaluateAgentModeToolAccessResult =
  | { allowed: true }
  | { allowed: false; error: ModeRestrictedError };

/**
 * 主评估函数：返回当前 tool 调用在指定 mode 下是允许还是软拒。
 *
 * 顺序（P1-6 修复，2026-05-27）：
 *   1. 非受限模式（agent / group / yolo / undefined）→ allow
 *   2. 缺失 policy → fail-open allow（contract 漂移兜底）
 *   3. **target check（仅 plan / study 模式 + tracker 注入）**：
 *      PLAN_TARGET_GUARDED_TOOLS 在 plan/study 模式下作为"active plan 编辑
 *      豁免"，target 命中 active_plan_id 时跳过 deny 直接放行
 *   4. **mode 工具白名单**：不在 allow 列表 → mode_disallowed_tool
 *      （ask 模式 plan 族工具 → 细粒度 mode_tool_only_in_plan）
 *
 * **P1-6 关键修复（ask 模式 target_check 漏洞）**：
 *
 *   旧顺序：target check 在任何受限模式都先跑。一旦 ask 模式下用户从 plan
 *   切过来但 active plan 还没清掉，模型调 `tabdoc_update_document(document_id=active_plan_id)`
 *   会走 target check 路径直接 allow——但 ask 模式 contract 明确 deny
 *   `tabdoc_update_document`！产品意图错位。
 *
 *   新顺序：target check **仅在 plan / study 模式**才跑。其他受限模式（ask）
 *   下 PLAN_TARGET_GUARDED_TOOLS 不享受豁免，必须通过 mode 白名单——而 ask
 *   contract 把 `tabdoc_update_document` 列入 denyToolNames，所以一定 deny。
 *
 *   这保留了 plan / study 模式下"绑定 active plan 的写工具豁免"的合法用法
 *   （legitimate path：模型调 plan_create 后 → tabdoc_update_document
 *   target=active_plan_id → allow 写 plan 草稿），同时关闭 ask 模式 race 漏洞。
 */
/**
 * 从写工具 input 提取目标 path（不同工具字段名可能不同）。
 */
export function extractToolPath(_tool: ToolLike, toolInput: unknown): string | undefined {
  if (toolInput == null || typeof toolInput !== 'object' || Array.isArray(toolInput)) {
    return undefined;
  }
  const obj = toolInput as Record<string, unknown>;
  for (const field of ['path', 'file_path', 'file']) {
    if (!(field in obj)) continue;
    const value = obj[field];
    if (typeof value !== 'string') continue;
    const trimmed = value.trim();
    if (trimmed.length > 0) return trimmed;
  }
  return undefined;
}

export function evaluateAgentModeToolAccess(
  input: EvaluateAgentModeToolAccessInput,
): EvaluateAgentModeToolAccessResult {
  const { tool, toolInput, agentMode, sessionId, workspaceRoot, activePlanTracker } = input;

  if (!agentMode || !PLAN_MODE_GUARDED_MODES.has(agentMode)) {
    return { allowed: true };
  }

  const policy = AGENT_MODE_CONFIGS[agentMode]?.toolPolicy;
  if (!policy) {
    // 未知 mode 的 contract 缺失 → fail-open（与 isToolAllowedForMode 一致）。
    // 上层调用方应该 emit telemetry 发现配置漂移。
    return { allowed: true };
  }

  const targetField = PLAN_TARGET_GUARDED_TOOLS.get(tool.name);

  // ── 第一道闸门：target check (active plan 豁免) ──
  //
  // 仅在 **plan / study 模式** + tracker 注入时跑。其他模式（ask）下即使
  // 工具在 PLAN_TARGET_GUARDED_TOOLS 里也不享受豁免，跳过本闸门，让 mode
  // 白名单（denyToolNames 包含 tabdoc_update_document）拒掉。
  const supportsActivePlanEditing = agentMode === 'plan' || agentMode === 'study';
  if (targetField && activePlanTracker && supportsActivePlanEditing) {
    const parsed = readDocumentIdFromInput(toolInput, targetField);
    if (parsed.kind === 'invalid_type') {
      return {
        allowed: false,
        error: buildInvalidDocumentIdTypeError({
          agentMode,
          toolName: tool.name,
          targetField,
          actualType: parsed.actualType,
        }),
      };
    }
    const providedId = parsed.kind === 'string' ? parsed.value : null;
    const activePlanId = activePlanTracker.getActivePlan(sessionId ?? '');
    if (!activePlanId) {
      return {
        allowed: false,
        error: buildNoActivePlanError({
          agentMode,
          toolName: tool.name,
          targetField,
          providedId,
        }),
      };
    }
    if (!providedId || providedId !== activePlanId) {
      return {
        allowed: false,
        error: buildWrongTargetDocumentError({
          agentMode,
          toolName: tool.name,
          targetField,
          activePlanId,
          providedId,
        }),
      };
    }
    // target 匹配 active plan → allow（豁免 policy 判定）
    return { allowed: true };
  }

  // ── 第二道闸门：path-aware 草稿写（plan / study + write_file / edit_file）──
  if (supportsActivePlanEditing && PLAN_DRAFT_WRITE_TOOLS.has(tool.name)) {
    const filePath = extractToolPath(tool, toolInput);
    if (filePath) {
      const draftCheck = checkPlanDraftPath(filePath, workspaceRoot);
      if (draftCheck.allowed) {
        return { allowed: true };
      }
      if (draftCheck.reason === 'path_resolution_failed') {
        return {
          allowed: false,
          error: buildPathResolutionFailedError({
            agentMode,
            toolName: tool.name,
            path: filePath,
          }),
        };
      }
      const pathExtension = getPlanDraftPathExtension(filePath);
      return {
        allowed: false,
        error: buildModeDisallowedPathError({
          agentMode,
          toolName: tool.name,
          path: filePath,
          pathExtension,
        }),
      };
    }
    return {
      allowed: false,
      error: buildModeDisallowedPathError({
        agentMode,
        toolName: tool.name,
        path: '(missing)',
        pathExtension: '',
      }),
    };
  }

  // ── 第三道闸门：agent 工具 input-aware（D12.1）──
  //
  // ask/plan/study 允许 `agent(readonly: true)` 派 readonly 子 Agent；
  // readonly: false 或缺省 → deny，防止非 readonly 子 Agent 继承父 mode 写权限。
  if (tool.name === AGENT_TOOL_NAME) {
    if (readReadonlyFromAgentInput(toolInput) === true) {
      return { allowed: true };
    }
    return {
      allowed: false,
      error: buildAgentRequiresReadonlySubagentError({ agentMode, toolName: tool.name }),
    };
  }

  // ── 第四道闸门：mode 工具白名单 ──
  if (!isToolAllowedByPolicy(tool, policy)) {
    // plan 族工具在 ask 模式 → 细粒度 mode_tool_only_in_plan
    if (agentMode === 'ask' && PLAN_FAMILY_TOOL_NAMES.has(tool.name)) {
      return {
        allowed: false,
        error: buildModeToolOnlyInPlanError({ agentMode, toolName: tool.name }),
      };
    }
    return {
      allowed: false,
      error: buildModeDisallowedToolError({ agentMode, toolName: tool.name }),
    };
  }

  return { allowed: true };
}

/**
 * 读取写工具 args 中的 target document_id（三态返回）。
 *
 * - `{ kind: 'string', value }` 表示读到合法非空字符串
 * - `{ kind: 'missing' }` 表示字段缺失（含空字符串 / whitespace-only）
 * - `{ kind: 'invalid_type', actualType }` 表示字段存在但非字符串
 */
function readDocumentIdFromInput(
  input: unknown,
  fieldName: string,
):
  | { kind: 'string'; value: string }
  | { kind: 'missing' }
  | { kind: 'invalid_type'; actualType: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { kind: 'missing' };
  }
  const obj = input as Record<string, unknown>;
  if (!(fieldName in obj)) return { kind: 'missing' };
  const value = obj[fieldName];
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length === 0) return { kind: 'missing' };
    return { kind: 'string', value: trimmed };
  }
  const actualType = Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;
  return { kind: 'invalid_type', actualType };
}

// ─── annotateToolsForMode（替代 filterToolsForMode） ──────────────────

/**
 * Annotate 而非 filter：在受限模式下不删工具，但在 description 末尾追加一行 mode
 * 提示，告知模型"这个工具在当前 mode 下会被软拒"。让模型从工具列表读到完整能力
 * 边界，避免"撞 shell allowlist 才学到边界"的 dogfood 痛点。
 *
 * 实施约定：
 *   - agent / group / yolo 模式：原样返回（短路）
 *   - ask / plan / study：
 *       · 对 policy 拒绝的工具加"被拒"annotation
 *       · `run_terminal_command` **始终额外注入 shell 受限提示**（即使它在 allow
 *         列表内）——L16 W5.5 shell 入口由 `restrictedShellAllowlist='tabtin-readonly'`
 *         做 input 级过滤，模型应当**预先**知道这条限制，而不是撞 allowlist 才学到
 *   - 文案简短，避免 token 浪费
 *
 * Provider 调用：`annotateToolsForMode(tools, agentMode)`
 */
export function annotateToolsForMode<T extends ToolLike & { description: string }>(
  tools: T[],
  mode: AgentModeName,
): T[] {
  if (!PLAN_MODE_GUARDED_MODES.has(mode)) {
    return tools;
  }
  const policy = AGENT_MODE_CONFIGS[mode]?.toolPolicy;
  if (!policy) return tools;

  return tools.map((tool) => {
    // P0-3 修复（2026-05-27）：run_terminal_command 即使在 policy.allowToolNames
    // 里也要额外注入 shell 受限提示（dogfood "ls 撞墙" 历史痛点的根因之一）。
    // 否则模型不知道 shell 受 tabtin-readonly 过滤，会本能调 `ls -la` 然后被拒。
    if (tool.name === 'run_terminal_command' && policy.restrictedShellAllowlist === 'tabtin-readonly') {
      const annotation = buildShellRestrictedAnnotation(mode);
      return {
        ...tool,
        description: `${tool.description}${annotation}`,
      } as T;
    }
    // D12.1：agent 工具在受限模式需 readonly: true，专属 annotation（非泛化 "is restricted"）。
    if (tool.name === AGENT_TOOL_NAME) {
      const annotation = buildAgentToolModeAnnotation(mode);
      return {
        ...tool,
        description: `${tool.description}${annotation}`,
      } as T;
    }
    if (isToolAllowedByPolicy(tool, policy)) {
      return tool;
    }
    const annotation = buildToolModeAnnotation(mode, tool.name);
    return {
      ...tool,
      description: `${tool.description}${annotation}`,
    } as T;
  });
}

function buildToolModeAnnotation(mode: AgentModeName, toolName: string): string {
  const label = humanModeLabel(mode);
  switch (mode) {
    case 'ask':
      if (PLAN_FAMILY_TOOL_NAMES.has(toolName)) {
        return `\n\n[${label} mode] '${toolName}' is restricted — plan/study only.`;
      }
      return `\n\n[${label} mode] '${toolName}' is restricted in ${label} mode.`;
    case 'plan':
      if (PLAN_DRAFT_WRITE_TOOLS.has(toolName)) {
        return `\n\n[${label} mode] '${toolName}' — only .md / .canvas.tsx drafts allowed; use plan_create for the main plan.`;
      }
      return `\n\n[${label} mode] '${toolName}' is restricted in ${label} mode.`;
    case 'study':
      if (PLAN_DRAFT_WRITE_TOOLS.has(toolName)) {
        return `\n\n[${label} mode] '${toolName}' — only .md / .canvas.tsx drafts allowed.`;
      }
      return `\n\n[${label} mode] '${toolName}' is restricted in ${label} mode.`;
    default:
      return `\n\n[${label} mode] '${toolName}' is restricted in the current mode.`;
  }
}

/**
 * P0-3 修复（2026-05-27）：受限模式下 `run_terminal_command` 的 shell 限制提示。
 *
 * 让模型预先知道：
 *   - Shell 仅放行 `tabtin` 只读子命令
 *   - 常见替代映射（避免 dogfood "ls 撞墙" 历史 bug）
 *   - 写命令（rm / mv / sed -i / git commit 等）会被入口过滤拒掉
 */
function buildShellRestrictedAnnotation(mode: AgentModeName): string {
  const label = humanModeLabel(mode);
  return (
    `\n\n[${label} mode] Shell is restricted to tabtin readonly subcommands. ` +
    `Common alternatives: ls→glob_search, cat→read_file, grep/find→grep_search/glob_search. ` +
    `Writing commands (rm, mv, sed -i, git commit, etc.) will be rejected.`
  );
}

/** D12.1：受限模式下 `agent` 工具的专属 annotation（比泛化 "is restricted" 更精确）。 */
function buildAgentToolModeAnnotation(mode: AgentModeName): string {
  const label = humanModeLabel(mode);
  if (mode === 'ask') {
    return (
      `\n\n[${label} mode] \`agent\` tool requires \`readonly: true\`. ` +
      `Use \`agent({ readonly: true, ... })\` to spawn a readonly subagent (which runs in Ask mode itself).`
    );
  }
  return (
    `\n\n[${label} mode] \`agent\` tool requires \`readonly: true\`. ` +
    `Use \`agent({ readonly: true, ... })\` to spawn a readonly subagent for parallel research.`
  );
}
