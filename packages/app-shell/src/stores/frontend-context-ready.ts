/**
 * 纯前端 Init Ready（与 Host 解耦）。
 *
 * 组织 settings / Agent agent_config / Workspace approval_grant 未权威就绪前，
 * 禁止把「未知」当成「未开放」去 claim / push，也禁止发送。
 *
 * 权威写入点由 organization / agent / space store notify；登出走 reset。
 */

export type FrontendContextReadySnapshot = {
  ready: boolean
  organizationId: string | null
  organizationSettingsKnown: boolean
  /** 未知为 null；仅 organizationSettingsKnown 时为 true/false */
  allowMemberYolo: boolean | null
  agentId: string | null
  agentConfigKnown: boolean
  workspaceId: string | null
  approvalGrantKnown: boolean
}

const APPROVAL_GRANTS = new Set(['always_ask', 'auto', 'full_access'])

type Listener = () => void

const listeners = new Set<Listener>()

let organizationId: string | null = null
let organizationSettingsKnown = false
let allowMemberYolo: boolean | null = null
let agentId: string | null = null
/** 任意路径 loadAgent DETAIL 成功且含 agent_config 的 id 集合。 */
const agentConfigKnownIds = new Set<string>()
let workspaceId: string | null = null
let approvalGrantKnown = false

function isPlainObject(value: unknown): boolean {
  return value != null && typeof value === 'object' && !Array.isArray(value)
}

function isCurrentAgentConfigKnown(): boolean {
  return agentId != null && agentConfigKnownIds.has(agentId)
}

function buildSnapshot(): FrontendContextReadySnapshot {
  const agentConfigKnown = isCurrentAgentConfigKnown()
  return {
    ready: organizationSettingsKnown && agentConfigKnown && approvalGrantKnown,
    organizationId,
    organizationSettingsKnown,
    allowMemberYolo: organizationSettingsKnown ? allowMemberYolo : null,
    agentId,
    agentConfigKnown,
    workspaceId,
    approvalGrantKnown,
  }
}

function emit(): void {
  for (const listener of listeners) {
    listener()
  }
}

export function getFrontendContextReady(): FrontendContextReadySnapshot {
  return buildSnapshot()
}

export function isFrontendContextReady(): boolean {
  return isFrontendContextReadyFor()
}

export function subscribeFrontendContextReady(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** DETAIL / 权威 update 完成后调用；null 表示清空组织上下文。 */
export function notifyOrganizationSettingsKnown(
  organization: {
    id: string
    settings?: { allow_member_yolo?: boolean | null } | null
  } | null,
): void {
  if (!organization?.id) {
    organizationId = null
    organizationSettingsKnown = false
    allowMemberYolo = null
    emit()
    return
  }
  organizationId = organization.id
  organizationSettingsKnown = true
  allowMemberYolo = organization.settings?.allow_member_yolo === true
  emit()
}

/**
 * 切组织 / rehydrate 尚未 DETAIL：settings 不可信。
 * 保留 organizationId 便于诊断，但 known=false 且 allowMemberYolo=null。
 */
export function clearOrganizationSettingsKnown(nextOrganizationId?: string | null): void {
  organizationId = nextOrganizationId === undefined ? organizationId : (nextOrganizationId ?? null)
  organizationSettingsKnown = false
  allowMemberYolo = null
  emit()
}

export function notifyAgentContextChanged(
  agent: { id: string; agent_config?: unknown } | null,
): void {
  if (!agent?.id) {
    agentId = null
    emit()
    return
  }
  agentId = agent.id
  if (isPlainObject(agent.agent_config)) {
    agentConfigKnownIds.add(agent.id)
  }
  emit()
}

/**
 * loadAgent / prefetch：登记 agent_config 已知。
 * 不抢占当前 agentId（由 selectAgent / 身份解析 notify）；若恰为当前 id 则刷新 ready。
 */
export function markAgentConfigKnown(
  agent: { id: string; agent_config?: unknown } | null | undefined,
): void {
  if (!agent?.id || !isPlainObject(agent.agent_config)) return
  const already = agentConfigKnownIds.has(agent.id)
  agentConfigKnownIds.add(agent.id)
  if (!already && agentId === agent.id) {
    emit()
  }
}

export function isAgentConfigKnown(id: string | null | undefined): boolean {
  return typeof id === 'string' && id.length > 0 && agentConfigKnownIds.has(id)
}

export function notifyWorkspaceContextChanged(
  space: { id: string; approval_grant?: string | null } | null,
): void {
  if (!space?.id) {
    workspaceId = null
    approvalGrantKnown = false
    emit()
    return
  }
  workspaceId = space.id
  approvalGrantKnown =
    typeof space.approval_grant === 'string' && APPROVAL_GRANTS.has(space.approval_grant)
  emit()
}

export function resetFrontendContextReady(): void {
  organizationId = null
  organizationSettingsKnown = false
  allowMemberYolo = null
  agentId = null
  agentConfigKnownIds.clear()
  workspaceId = null
  approvalGrantKnown = false
  emit()
}

/** 组织 settings + 执行 Workspace grant 已知（发送 pre-lock；不要求 Agent）。 */
export function isFrontendShellContextReady(): boolean {
  return organizationSettingsKnown && approvalGrantKnown
}

/**
 * 发送路径：可按会话真实 agent 覆盖默认前台指针。
 * workspace 仍以前台 selectedSpace（执行现场）的 grant known 为准。
 */
export function isFrontendContextReadyFor(params?: {
  agentId?: string | null
}): boolean {
  if (!isFrontendShellContextReady()) return false
  const effectiveAgentId = params?.agentId !== undefined ? params.agentId : agentId
  return Boolean(effectiveAgentId && agentConfigKnownIds.has(effectiveAgentId))
}
