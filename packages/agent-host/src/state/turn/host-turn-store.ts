/**
 * Host 进程内 Agent / Workspace turn 状态仓库（可实例化）。
 *
 * Host 内存快照是 turn 执行的直接真相源；由本机更新或后端权威拉取整批替换。
 * 仅内存，不落盘。挂在 StateRoot.turn。
 */

import {
  FALLBACK_DENY_AGENT_CONFIG,
  normalizeAuthoritativeAgentConfig,
} from '../../policy/agent-config-client.js'
import type { AgentConfigV3 } from '@tabtin/security-policy'

export type HostTurnExecutionLimits = {
  max_iterations_per_run?: number | null
  max_credits_per_run?: number | string | null
  enabled?: boolean | null
}

export type HostTurnProfile = {
  agentName?: string
  customRules?: string
  workspaceRules?: string
  personalRules?: string
  executionLimits?: HostTurnExecutionLimits
}

export type HostTurnBundle = {
  agentConfig: AgentConfigV3
  profile: HostTurnProfile
  /** 实际解析进本 bundle 的 Agent；用于阻止选中 Agent 时静默使用空档案。 */
  resolvedAgentId?: string
  organizationDetail?: HostOrganizationDetail
  workspaceDetail?: HostWorkspaceDetail
  runtimeConfig?: HostTurnRuntimeConfig
}

export type ApprovalGrantName = 'always_ask' | 'auto' | 'full_access'

export type HostAgentDetail = Record<string, unknown> & {
  id: string
  organization_id: string
  agent_config: Record<string, unknown>
  organization_allow_member_yolo: boolean
}

export type HostOrganizationDetail = Record<string, unknown> & {
  id: string
  name: string
}

export type HostWorkspaceDetail = Record<string, unknown> & {
  id: string
  organization_id: string
  working_dir: string
  working_dir_type: string
  approval_grant: ApprovalGrantName
  device_id?: string | null
}

export type HostWorkspaceExecutionBinding = {
  deviceId: string
}

export type HostTurnRuntimeConfig = {
  operationSwitches?: Record<string, 'allow' | 'confirm' | 'block'>
  memoryCapability?: boolean
  enabledApps?: ReadonlyArray<{
    key: string
    cliKey?: string
    displayName: string
    capability: string
    aliases?: readonly string[]
  }>
}

export type HostTurnStateSnapshot = {
  organizationId: string
  organizationDetail: HostOrganizationDetail
  agentDetail: HostAgentDetail
  workspaceDetail: HostWorkspaceDetail
  runtimeConfig: HostTurnRuntimeConfig
}

export type HostAgentTurnState = {
  agentId: string
  detail?: HostAgentDetail
  operationSwitches?: HostTurnRuntimeConfig['operationSwitches']
  displayName?: string
  customRules?: string
  personalRules?: string
  /** Django Agent DETAIL / Agent API 的 agent_config 原文 */
  agentConfigRaw?: unknown
  organizationAllowMemberYolo?: boolean
  /**
   * 以前端为准：有 agent_config，且组织 YOLO 天花板已为 boolean（已知）才可合成。
   * 未知天花板禁止当 false 合成 deny。
   */
  securityReady: boolean
  updatedAt: number
}

export type HostWorkspaceTurnState = {
  workspaceId: string
  detail?: HostWorkspaceDetail
  organizationDetail?: HostOrganizationDetail
  runtimeConfig?: Omit<HostTurnRuntimeConfig, 'operationSwitches'>
  customRules?: string
  executionLimits?: HostTurnExecutionLimits
  approvalGrant?: ApprovalGrantName
  /** 至少推送/hydrate 过一次 */
  ready: boolean
  updatedAt: number
}

export type UpsertHostAgentTurnStateInput = {
  agentId: string
  detail?: HostAgentDetail
  operationSwitches?: HostTurnRuntimeConfig['operationSwitches']
  displayName?: string | null
  customRules?: string | null
  personalRules?: string | null
  agentConfigRaw?: unknown
  organizationAllowMemberYolo?: boolean | null
}

export type UpsertHostWorkspaceTurnStateInput = {
  workspaceId: string
  detail?: HostWorkspaceDetail
  organizationDetail?: HostOrganizationDetail
  runtimeConfig?: Omit<HostTurnRuntimeConfig, 'operationSwitches'>
  customRules?: string | null
  executionLimits?: HostTurnExecutionLimits | null
  approvalGrant?: ApprovalGrantName | null
}

function trimId(value: string | null | undefined): string {
  return typeof value === 'string' ? value.trim() : ''
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function isApprovalGrant(value: unknown): value is ApprovalGrantName {
  return value === 'always_ask' || value === 'auto' || value === 'full_access'
}

function isRuntimeConfig(value: unknown): value is HostTurnRuntimeConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false
  const config = value as Record<string, unknown>
  if (typeof config.memoryCapability !== 'boolean') return false
  if (!Array.isArray(config.enabledApps)) return false
  if (
    !config.operationSwitches
    || typeof config.operationSwitches !== 'object'
    || Array.isArray(config.operationSwitches)
  ) return false
  return Object.values(config.operationSwitches).every(
    value => value === 'allow' || value === 'confirm' || value === 'block',
  ) && config.enabledApps.every((app) => {
    if (!app || typeof app !== 'object' || Array.isArray(app)) return false
    const entry = app as Record<string, unknown>
    return typeof entry.key === 'string'
      && typeof entry.displayName === 'string'
      && typeof entry.capability === 'string'
  })
}

function isHostAgentDetail(value: Record<string, unknown>): value is HostAgentDetail {
  return typeof value.id === 'string'
    && typeof value.organization_id === 'string'
    && value.agent_config != null
    && typeof value.agent_config === 'object'
    && typeof value.organization_allow_member_yolo === 'boolean'
}

function readExecutionLimits(raw: unknown): HostTurnExecutionLimits | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as HostTurnExecutionLimits
}

function readAgentCostLimits(agentConfig: unknown): HostTurnExecutionLimits | undefined {
  if (!agentConfig || typeof agentConfig !== 'object') return undefined
  const caps = (agentConfig as {
    capabilities?: { overrides?: { cost?: { execution_limits?: unknown } } }
  }).capabilities?.overrides?.cost?.execution_limits
  return readExecutionLimits(caps)
}

function mergeExecutionLimits(
  workspaceLimits: HostTurnExecutionLimits | undefined,
  agentLimits: HostTurnExecutionLimits | undefined,
  isEnabled: (limits: HostTurnExecutionLimits | null | undefined) => boolean,
): HostTurnExecutionLimits | undefined {
  const limitsOn = workspaceLimits != null
    ? isEnabled(workspaceLimits)
    : isEnabled(agentLimits ?? null)
  if (!limitsOn) return undefined
  const merged: HostTurnExecutionLimits = {
    max_iterations_per_run:
      workspaceLimits?.max_iterations_per_run
      ?? agentLimits?.max_iterations_per_run
      ?? null,
    max_credits_per_run:
      workspaceLimits?.max_credits_per_run
      ?? agentLimits?.max_credits_per_run
      ?? null,
  }
  if (merged.max_iterations_per_run == null && merged.max_credits_per_run == null) {
    return undefined
  }
  return merged
}

/** 默认：enabled 缺省视为开启（与 app-shell isExecutionLimitsEnabled 对齐由调用方注入更稳）。 */
function defaultLimitsEnabled(limits: HostTurnExecutionLimits | null | undefined): boolean {
  if (!limits) return false
  if (typeof limits.enabled === 'boolean') return limits.enabled
  return true
}

export class HostTurnStore {
  private agents = new Map<string, HostAgentTurnState>()
  private workspaces = new Map<string, HostWorkspaceTurnState>()
  private executionBindingsReady = false

  replaceSnapshots(snapshots: HostTurnStateSnapshot[]): void {
    const next = new HostTurnStore()
    for (const snapshot of snapshots) next.applySnapshot(snapshot)
    this.agents = next.agents
    this.workspaces = next.workspaces
    this.executionBindingsReady = true
  }

  invalidateExecutionBindings(): void {
    this.executionBindingsReady = false
  }

  areExecutionBindingsReady(): boolean {
    return this.executionBindingsReady
  }

  getWorkspaceExecutionBinding(
    workspaceId: string,
  ): HostWorkspaceExecutionBinding | undefined {
    if (!this.executionBindingsReady) return undefined
    const detail = this.getWorkspace(workspaceId)?.detail
    const deviceId = trimId(detail?.device_id ?? undefined)
    return deviceId ? { deviceId } : undefined
  }

  applySnapshot(snapshot: HostTurnStateSnapshot): void {
    const organizationId = trimId(snapshot.organizationId)
    const agentId = trimId(snapshot.agentDetail.id)
    const workspaceId = trimId(snapshot.workspaceDetail.id)
    if (!organizationId || !agentId || !workspaceId) {
      throw new Error('HostTurnStore.applySnapshot: organizationId, agentId and workspaceId required')
    }
    if (
      trimId(snapshot.agentDetail.organization_id) !== organizationId
      || trimId(snapshot.organizationDetail.id) !== organizationId
      || trimId(snapshot.workspaceDetail.organization_id) !== organizationId
      || snapshot.agentDetail.agent_config == null
      || typeof snapshot.agentDetail.agent_config !== 'object'
      || typeof snapshot.agentDetail.organization_allow_member_yolo !== 'boolean'
      || !isApprovalGrant(snapshot.workspaceDetail.approval_grant)
      || !isRuntimeConfig(snapshot.runtimeConfig)
    ) {
      throw new Error('HostTurnStore.applySnapshot: incomplete security state')
    }
    this.upsertAgent({
      agentId,
      detail: snapshot.agentDetail,
      operationSwitches: snapshot.runtimeConfig.operationSwitches,
      displayName: trimText(snapshot.agentDetail.display_name)
        ?? trimText(snapshot.agentDetail.name),
      customRules: trimText(snapshot.agentDetail.custom_rules),
      personalRules: trimText(snapshot.agentDetail.personal_rules),
      agentConfigRaw: snapshot.agentDetail.agent_config,
      organizationAllowMemberYolo:
        snapshot.agentDetail.organization_allow_member_yolo,
    })
    this.upsertWorkspace({
      workspaceId,
      detail: snapshot.workspaceDetail,
      organizationDetail: snapshot.organizationDetail,
      runtimeConfig: {
        memoryCapability: snapshot.runtimeConfig.memoryCapability,
        enabledApps: snapshot.runtimeConfig.enabledApps,
      },
      customRules: trimText(snapshot.workspaceDetail.custom_rules),
      executionLimits: readExecutionLimits(snapshot.workspaceDetail.execution_limits),
      approvalGrant: snapshot.workspaceDetail.approval_grant,
    })
  }

  upsertAgent(input: UpsertHostAgentTurnStateInput): HostAgentTurnState {
    const agentId = trimId(input.agentId)
    if (!agentId) {
      throw new Error('HostTurnStore.upsertAgent: agentId required')
    }
    const prev = this.agents.get(agentId)
    const detail = input.detail === undefined ? prev?.detail : input.detail
    const operationSwitches = input.operationSwitches === undefined
      ? prev?.operationSwitches
      : input.operationSwitches
    const displayName = input.displayName === undefined
      ? prev?.displayName
      : trimText(input.displayName)
    const customRules = input.customRules === undefined
      ? prev?.customRules
      : trimText(input.customRules)
    const personalRules = input.personalRules === undefined
      ? prev?.personalRules
      : trimText(input.personalRules)
    const agentConfigRaw = input.agentConfigRaw === undefined
      ? prev?.agentConfigRaw
      : input.agentConfigRaw
    const organizationAllowMemberYolo = input.organizationAllowMemberYolo === undefined
      ? prev?.organizationAllowMemberYolo
      : typeof input.organizationAllowMemberYolo === 'boolean'
        ? input.organizationAllowMemberYolo
        : undefined

    const hasConfig = agentConfigRaw != null && typeof agentConfigRaw === 'object'
    const yoloKnown = typeof organizationAllowMemberYolo === 'boolean'
    const next: HostAgentTurnState = {
      agentId,
      ...(detail ? { detail } : {}),
      ...(operationSwitches ? { operationSwitches } : {}),
      ...(displayName ? { displayName } : {}),
      ...(customRules ? { customRules } : {}),
      ...(personalRules ? { personalRules } : {}),
      ...(agentConfigRaw !== undefined ? { agentConfigRaw } : {}),
      ...(organizationAllowMemberYolo !== undefined
        ? { organizationAllowMemberYolo }
        : {}),
      securityReady: hasConfig && yoloKnown,
      updatedAt: Date.now(),
    }
    this.agents.set(agentId, next)
    return next
  }

  upsertWorkspace(input: UpsertHostWorkspaceTurnStateInput): HostWorkspaceTurnState {
    const workspaceId = trimId(input.workspaceId)
    if (!workspaceId) {
      throw new Error('HostTurnStore.upsertWorkspace: workspaceId required')
    }
    const prev = this.workspaces.get(workspaceId)
    const detail = input.detail === undefined ? prev?.detail : input.detail
    const organizationDetail = input.organizationDetail === undefined
      ? prev?.organizationDetail
      : input.organizationDetail
    const runtimeConfig = input.runtimeConfig === undefined
      ? prev?.runtimeConfig
      : input.runtimeConfig
    const customRules = input.customRules === undefined
      ? prev?.customRules
      : trimText(input.customRules)
    const executionLimits = input.executionLimits === undefined
      ? prev?.executionLimits
      : input.executionLimits === null
        ? undefined
        : readExecutionLimits(input.executionLimits) ?? undefined
    const approvalGrant = input.approvalGrant === undefined
      ? prev?.approvalGrant
      : input.approvalGrant === null
        ? undefined
        : isApprovalGrant(input.approvalGrant)
          ? input.approvalGrant
          : prev?.approvalGrant

    const next: HostWorkspaceTurnState = {
      workspaceId,
      ...(detail ? { detail } : {}),
      ...(organizationDetail ? { organizationDetail } : {}),
      ...(runtimeConfig ? { runtimeConfig } : {}),
      ...(customRules ? { customRules } : {}),
      ...(executionLimits ? { executionLimits } : {}),
      ...(approvalGrant ? { approvalGrant } : {}),
      ready: true,
      updatedAt: Date.now(),
    }
    this.workspaces.set(workspaceId, next)
    return next
  }

  getAgent(agentId: string): HostAgentTurnState | undefined {
    const id = trimId(agentId)
    return id ? this.agents.get(id) : undefined
  }

  getWorkspace(workspaceId: string): HostWorkspaceTurnState | undefined {
    const id = trimId(workspaceId)
    return id ? this.workspaces.get(id) : undefined
  }

  /**
   * 能否不经 HTTP 合成 turn bundle。
   * - 有 agentId：必须 securityReady
   * - 有 workspaceId：必须 ready（至少推送/hydrate 过）
   */
  canCompose(
    agentId?: string | null,
    workspaceId?: string | null,
  ): boolean {
    const aid = trimId(agentId ?? undefined)
    const wid = trimId(workspaceId ?? undefined)
    if (!aid && !wid) return false
    if (aid) {
      const agent = this.agents.get(aid)
      if (!agent?.securityReady) return false
    }
    if (wid) {
      const ws = this.workspaces.get(wid)
      if (!ws?.ready) return false
    }
    return true
  }

  compose(
    agentId?: string | null,
    workspaceId?: string | null,
    opts?: {
      isExecutionLimitsEnabled?: (limits: HostTurnExecutionLimits | null | undefined) => boolean
    },
  ): HostTurnBundle | null {
    if (!this.canCompose(agentId, workspaceId)) return null

    const aid = trimId(agentId ?? undefined)
    const wid = trimId(workspaceId ?? undefined)
    const agent = aid ? this.agents.get(aid) : undefined
    const workspace = wid ? this.workspaces.get(wid) : undefined
    const limitsEnabled = opts?.isExecutionLimitsEnabled ?? defaultLimitsEnabled

    let agentConfig: AgentConfigV3 = FALLBACK_DENY_AGENT_CONFIG
    if (agent?.securityReady) {
      agentConfig = normalizeAuthoritativeAgentConfig(
        agent.agentConfigRaw,
        agent.organizationAllowMemberYolo === true,
      )
      if (agentConfig.security.allow_yolo_mode === true) {
        const grant = wid
          ? (workspace?.approvalGrant ?? 'always_ask')
          : 'always_ask'
        if (agentConfig.security.approval_grant !== grant) {
          agentConfig = {
            ...agentConfig,
            security: {
              ...agentConfig.security,
              approval_grant: grant,
            },
          }
        }
      }
    }

    const profile: HostTurnProfile = {
      ...(agent?.displayName ? { agentName: agent.displayName } : {}),
      ...(agent?.customRules ? { customRules: agent.customRules } : {}),
      ...(agent?.personalRules ? { personalRules: agent.personalRules } : {}),
      ...(workspace?.customRules ? { workspaceRules: workspace.customRules } : {}),
    }
    const executionLimits = mergeExecutionLimits(
      workspace?.executionLimits,
      readAgentCostLimits(agent?.agentConfigRaw),
      limitsEnabled,
    )
    if (executionLimits) profile.executionLimits = executionLimits

    return {
      agentConfig,
      profile,
      ...(agent ? { resolvedAgentId: agent.agentId } : {}),
      ...(workspace?.organizationDetail
        ? { organizationDetail: workspace.organizationDetail }
        : {}),
      ...(workspace?.detail ? { workspaceDetail: workspace.detail } : {}),
      ...(workspace?.runtimeConfig
        ? {
            runtimeConfig: {
              operationSwitches: agent?.operationSwitches,
              ...workspace.runtimeConfig,
            },
          }
        : {}),
    }
  }

  /** 从 Django DETAIL data 写入仓库（hydrate）。 */
  ingestDetails(params: {
    agentId?: string | null
    workspaceId?: string | null
    agentData?: Record<string, unknown> | null
    workspaceData?: Record<string, unknown> | null
  }): void {
    const aid = trimId(params.agentId ?? undefined)
    const wid = trimId(params.workspaceId ?? undefined)
    if (aid && params.agentData) {
      const data = params.agentData
      this.upsertAgent({
        agentId: aid,
        ...(isHostAgentDetail(data)
          ? { detail: data }
          : {}),
        ...(typeof data.display_name === 'string' || typeof data.name === 'string'
          ? { displayName: trimText(data.display_name) ?? trimText(data.name) ?? null }
          : {}),
        ...(typeof data.custom_rules === 'string' ? { customRules: data.custom_rules } : {}),
        ...(typeof data.personal_rules === 'string' ? { personalRules: data.personal_rules } : {}),
        ...(data.agent_config !== undefined ? { agentConfigRaw: data.agent_config } : {}),
        ...(typeof data.organization_allow_member_yolo === 'boolean'
          ? { organizationAllowMemberYolo: data.organization_allow_member_yolo }
          : {}),
      })
    }
    if (wid && params.workspaceData) {
      const data = params.workspaceData
      this.upsertWorkspace({
        workspaceId: wid,
        ...(typeof data.custom_rules === 'string' ? { customRules: data.custom_rules } : {}),
        ...(data.execution_limits !== undefined
          ? { executionLimits: readExecutionLimits(data.execution_limits) ?? null }
          : {}),
        ...(isApprovalGrant(data.approval_grant)
          ? { approvalGrant: data.approval_grant }
          : {}),
      })
    }
  }

  clear(opts?: {
    agentId?: string
    workspaceId?: string
  }): void {
    if (opts?.agentId) {
      this.agents.delete(trimId(opts.agentId))
    }
    if (opts?.workspaceId) {
      this.workspaces.delete(trimId(opts.workspaceId))
    }
    if (!opts?.agentId && !opts?.workspaceId) {
      this.agents.clear()
      this.workspaces.clear()
    }
  }
}
