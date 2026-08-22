import type { GroupRuntimeConfig } from '@tabtin/chat-client'
import { useOrganizationStore } from '@stores/useOrganizationStore'
import { useSpaceStore } from '@stores/useSpaceStore'
import { resolveProjectExecutionWorkspace } from '@utils/projectExecutionTarget'
import { useChatRuntimeStore } from '../../useChatRuntimeStore'
import {
  isAgentModeName,
  resolveAgentModeName,
  isApprovalModeName,
  type AgentModeName,
  type ApprovalModeName,
} from '../shared/types'

/** 与 Django `GroupRuntimeService.build_snapshot` 对齐：enabled 且 resolved_roles 非空。 */
export function resolveIsGroupSpace(
  groupRuntime?: GroupRuntimeConfig | null,
): boolean {
  return groupRuntime?.is_active === true
}

export interface AgentModeResolutionContext {
  /**
   * ：组织准入天花板（`Organization.settings.allow_member_yolo`）。
   * 未开放时对话不能升到 auto / full_access（含 legacy yolo）。
   */
  allowYolo: boolean
  isGroupSpace: boolean
  /**
   *  / ：执行 Workspace 已授权最高档，再经组织天花板夹紧。
   * 组织未开放 → 强制 `always_ask`；开放后读 Workspace.`approval_grant`。
   */
  approvalGrant: ApprovalModeName
}

/** 组织天花板最小形状。 */
export interface AgentModeGateOrganization {
  settings?: { allow_member_yolo?: boolean | null } | null
}

/**  后权威 grant 落在 Workspace（经 mergePersonalSpaces 并入 Space 形状）。 */
export interface AgentModeGateWorkspace {
  approval_grant?: string | null
}

export function resolveAllowYoloFromOrganization(
  organization?: AgentModeGateOrganization | null,
): boolean {
  return organization?.settings?.allow_member_yolo === true
}

/**
 * ：Workspace grant ∩ 组织天花板。
 * `orgAllowMemberYolo=false` → 始终 `always_ask`；缺字段 fail-safe 为 `always_ask`。
 */
export function resolveApprovalGrantFromWorkspace(
  workspace?: AgentModeGateWorkspace | null,
  orgAllowMemberYolo = false,
): ApprovalModeName {
  if (!orgAllowMemberYolo) return 'always_ask'
  const grant = workspace?.approval_grant
  return isApprovalModeName(grant) ? grant : 'always_ask'
}

export function buildAgentModeResolutionContext(
  allowYolo: boolean,
  groupRuntime?: GroupRuntimeConfig | null,
  workspace?: AgentModeGateWorkspace | null,
): AgentModeResolutionContext {
  return {
    allowYolo,
    isGroupSpace: resolveIsGroupSpace(groupRuntime),
    approvalGrant: resolveApprovalGrantFromWorkspace(workspace, allowYolo),
  }
}

/** 新会话 / 无 per-session 覆盖时的默认 mode（group 会话优先 group）。 */
export function resolveDefaultAgentMode(
  context: AgentModeResolutionContext,
  storedPreference?: AgentModeName | null,
): AgentModeName {
  if (context.isGroupSpace) return 'group'
  if (storedPreference && isAgentModeName(storedPreference)) {
    return storedPreference
  }
  return 'agent'
}

/** group 会话里 yolo 不可用；组织未开放时 yolo 降级。 */
export function normalizeAgentModeForContext(
  mode: AgentModeName,
  context: AgentModeResolutionContext,
): AgentModeName {
  const resolved = resolveAgentModeName(mode, 'agent')
  if (resolved === 'yolo' && (context.isGroupSpace || !context.allowYolo)) {
    return context.isGroupSpace ? 'group' : 'agent'
  }
  return resolved
}

/**
 * 从 organization + runtime + 当前执行 Workspace 组装守卫上下文。
 * ：allowYolo = 组织天花板；#6021：approvalGrant = Workspace grant ∩ 天花板。
 *
 * 口径对齐旧「读 selectedAgent」：取当前选中 Space 的执行 Workspace
 * （个人域即 Space 本身；team_space 经 resolveProjectExecutionWorkspace 解析）。
 * 不引入 useChatStore，避免与 modePreferenceSlice 形成循环依赖。
 */
export function getAgentModeResolutionContextForSession(
  sessionId: string | null | undefined,
): AgentModeResolutionContext {
  const groupRuntime = sessionId
    ? useChatRuntimeStore.getState().groupRuntimeBySessionId[sessionId] ?? null
    : null
  const organization = useOrganizationStore.getState().selectedOrganization
  const { selectedSpace, spaces } = useSpaceStore.getState()
  const executionWorkspace = resolveProjectExecutionWorkspace(selectedSpace, spaces)
  return buildAgentModeResolutionContext(
    resolveAllowYoloFromOrganization(organization),
    groupRuntime,
    executionWorkspace,
  )
}
