/**
 * build-policy.ts — 从 AgentConfig v3 + WorkspaceSnapshot 派生 EffectivePolicy
 *
 * v3 §4.4 SSoT：判决路径上**唯一**的 policy 派生入口。
 *
 * ：effectiveMode 二元 → approvalMode 三档（always_ask / auto / full_access）。
 */

import type {
  AgentConfigV3,
  ApprovalGrant,
  ApprovalMode,
  EffectivePolicy,
  ExecutionLimitsV3,
  WorkspaceSnapshot,
  ApprovalMemoSnapshot,
} from './types-v3.js';

export interface BuildPolicyOptions {
  planModeGuardActive?: boolean;
  /**
   * 对话级请求的审批档位（消息体 `approval_mode`）。
   * 缺省时从 legacy `requestedAgentMode='yolo'` 归一为 `'auto'`，否则 `'always_ask'`。
   */
  requestedApprovalMode?: ApprovalMode;
  /**
   * @deprecated 读兼容；`yolo` 归一为 `requestedApprovalMode='auto'`
   */
  requestedAgentMode?: 'ask' | 'plan' | 'study' | 'agent' | 'yolo' | 'group';
  /** 群协作 Space 与 auto/full_access 互斥 */
  isGroupSpace?: boolean;
  /**
   * 无人值守（scheduled）：钉在 `auto`（替我审批），可绕过 grant 闸门。
   * group Space 仍不可突破。
   */
  unattended?: boolean;
}

const APPROVAL_MODE_RANK: Record<ApprovalMode, number> = {
  always_ask: 0,
  auto: 1,
  full_access: 2,
};

export function resolveApprovalGrant(config: AgentConfigV3): ApprovalGrant {
  const grant = config.security?.approval_grant;
  if (grant === 'auto' || grant === 'full_access' || grant === 'always_ask') {
    return grant;
  }
  if (config.security?.allow_yolo_mode === true) {
    return 'auto';
  }
  return 'always_ask';
}

/**
 * 派生本轮有效审批档位。
 *
 * ：Workspace `approval_grant` 是唯一权限数据源。旧客户端仍可能发送
 * `requestedApprovalMode` / legacy yolo；为保持 wire 向前兼容，字段继续由
 * `BuildPolicyOptions` 接受，但不再参与权限判决。
 */
export function deriveApprovalMode(
  config: AgentConfigV3,
  opts?: BuildPolicyOptions,
): ApprovalMode {
  const isGroup = !!opts?.isGroupSpace;
  if (isGroup) {
    return 'always_ask';
  }

  const grant = resolveApprovalGrant(config);
  const unattended = !!opts?.unattended;

  if (unattended) {
    return APPROVAL_MODE_RANK[grant] >= APPROVAL_MODE_RANK.auto
      ? 'auto'
      : 'always_ask';
  }

  return grant;
}

export function buildPolicyFromAgentConfigV2(
  config: AgentConfigV3,
  workspace: WorkspaceSnapshot,
  opts?: BuildPolicyOptions,
): EffectivePolicy {
  if (!config || typeof config !== 'object') {
    throw new TypeError('[build-policy] config 必须是 AgentConfigV3 object');
  }
  if (!workspace || typeof workspace !== 'object') {
    throw new TypeError('[build-policy] workspace 必须是 WorkspaceSnapshot object');
  }

  const approvalMode = deriveApprovalMode(config, opts);
  const executionLimits = readExecutionLimits(config);
  const memo = readApprovalMemo(config.approval_memo);

  return {
    approvalMode,
    workspace,
    memo,
    executionLimits,
    planModeGuardActive: !!opts?.planModeGuardActive,
  };
}

function readExecutionLimits(config: AgentConfigV3): ExecutionLimitsV3 {
  const overrides = config.capabilities?.overrides?.cost?.execution_limits;
  if (!overrides) return {};
  const out: ExecutionLimitsV3 = {};
  if (typeof overrides.max_iterations_per_run === 'number' && overrides.max_iterations_per_run > 0) {
    out.max_iterations_per_run = overrides.max_iterations_per_run;
  }
  if (typeof overrides.max_credits_per_run === 'number' && overrides.max_credits_per_run > 0) {
    out.max_credits_per_run = overrides.max_credits_per_run;
  } else if (typeof overrides.max_credits_per_run === 'string') {
    const n = Number(overrides.max_credits_per_run);
    if (Number.isFinite(n) && n > 0) out.max_credits_per_run = n;
  }
  return out;
}

function readApprovalMemo(snapshot: ApprovalMemoSnapshot | undefined): EffectivePolicy['memo'] {
  if (!snapshot) {
    return { generation: 0, entries: Object.freeze({}) };
  }
  return {
    generation: snapshot.generation ?? 0,
    entries: snapshot.entries ?? Object.freeze({}),
  };
}
