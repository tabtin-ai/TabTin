/**
 * Host 本轮档案（ thin send /  Workspace grant）
 *
 * 优先读 StateRoot.turn（前端推送维护的进程内状态）；
 * 缺失时一次并行 DETAIL hydrate，再写入状态仓库。
 */

import {
  FALLBACK_DENY_AGENT_CONFIG,
  HostTurnStore,
  normalizeAuthoritativeAgentConfig,
  type HostTurnBundle,
  type HostTurnExecutionLimits,
  type HostTurnProfile,
} from '@tabtin/agent-host/policy'
import { isExecutionLimitsEnabled } from '@tabtin/app-shell/agent-config-v2'
import { API_ENDPOINTS, joinApiPath } from '@tabtin/config'
import type { AgentConfigV3 } from '@tabtin/security-policy'
import { TokenManager } from '../auth.js'
import { API_BASE_URL } from '../config/api.js'
import { createLogger } from '../logger.js'

const log = createLogger('host-turn-bundle')
const FETCH_TIMEOUT_MS = 10_000

export type { HostTurnBundle, HostTurnExecutionLimits, HostTurnProfile }

/** 选中了 Agent 就必须拿到同一个 Agent 的宿主状态，禁止以空档案继续执行。 */
export function assertHostTurnAgentResolved(
  bundle: HostTurnBundle,
  requestedAgentId: string | null | undefined,
): void {
  if (requestedAgentId && bundle.resolvedAgentId !== requestedAgentId) {
    throw new Error('Selected Agent could not be resolved')
  }
}

export type HostTurnBundleDeps = {
  fetchImpl?: typeof fetch
  getAccessToken?: () => Promise<string | null>
  getOrganizationId?: () => string | null | undefined
  /** 缺省走 bindHostTurnStore 注册的实例 */
  turnStore?: HostTurnStore
}

type ApprovalGrantName = 'always_ask' | 'auto' | 'full_access'

let boundTurnStoreResolver: (() => HostTurnStore) | null = null
let boundHostStateReconciler: (() => Promise<boolean>) | null = null

/** ElectronAgentHost 启动时绑定权威 HostTurnStore */
export function bindHostTurnStore(resolver: () => HostTurnStore): void {
  boundTurnStoreResolver = resolver
}

export function bindHostStateReconciler(reconcile: () => Promise<boolean>): void {
  boundHostStateReconciler = reconcile
}

export function unbindHostTurnStoreForTests(): void {
  boundTurnStoreResolver = null
  boundHostStateReconciler = null
}

function resolveTurnStore(explicit?: HostTurnStore): HostTurnStore {
  if (explicit) return explicit
  if (boundTurnStoreResolver) return boundTurnStoreResolver()
  throw new Error('HostTurnStore not bound; call bindHostTurnStore from ElectronAgentHost')
}

function trimText(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

function readExecutionLimits(raw: unknown): HostTurnExecutionLimits | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return undefined
  return raw as HostTurnExecutionLimits
}

function mergeExecutionLimits(
  workspaceLimits: HostTurnExecutionLimits | undefined,
  agentLimits: HostTurnExecutionLimits | undefined,
): HostTurnExecutionLimits | undefined {
  const limitsOn = workspaceLimits != null
    ? isExecutionLimitsEnabled(workspaceLimits)
    : isExecutionLimitsEnabled(agentLimits ?? null)
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

function readAgentCostLimits(agentConfig: unknown): HostTurnExecutionLimits | undefined {
  if (!agentConfig || typeof agentConfig !== 'object') return undefined
  const caps = (agentConfig as {
    capabilities?: { overrides?: { cost?: { execution_limits?: unknown } } }
  }).capabilities?.overrides?.cost?.execution_limits
  return readExecutionLimits(caps)
}

function buildProfile(
  agentData: Record<string, unknown> | null | undefined,
  workspaceData: Record<string, unknown> | null | undefined,
): HostTurnProfile {
  const agentName =
    trimText(agentData?.display_name)
    ?? trimText(agentData?.name)
  const customRules = trimText(agentData?.custom_rules)
  const personalRules = trimText(agentData?.personal_rules)
  const workspaceRules = trimText(workspaceData?.custom_rules)
  const executionLimits = mergeExecutionLimits(
    readExecutionLimits(workspaceData?.execution_limits),
    readAgentCostLimits(agentData?.agent_config),
  )
  return {
    ...(agentName ? { agentName } : {}),
    ...(customRules ? { customRules } : {}),
    ...(workspaceRules ? { workspaceRules } : {}),
    ...(personalRules ? { personalRules } : {}),
    ...(executionLimits ? { executionLimits } : {}),
  }
}

function readWorkspaceApprovalGrant(
  workspaceData: Record<string, unknown> | null,
): ApprovalGrantName {
  const raw = workspaceData?.approval_grant
  if (raw === 'always_ask' || raw === 'auto' || raw === 'full_access') return raw
  return 'always_ask'
}

async function getDetail(
  path: string,
  deps: HostTurnBundleDeps,
): Promise<Record<string, unknown> | null> {
  const fetchImpl = deps.fetchImpl ?? globalThis.fetch
  const getToken = deps.getAccessToken ?? (() => TokenManager.getAccessToken())
  const token = await getToken()
  if (!token) return null
  const organizationId = deps.getOrganizationId?.()
  const resp = await fetchImpl(joinApiPath(API_BASE_URL, path), {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  })
  if (!resp.ok) return null
  const body = await resp.json() as { success?: boolean; data?: Record<string, unknown> }
  if (body.success !== true || !body.data || typeof body.data !== 'object') return null
  return body.data
}

function buildAgentConfig(
  agentData: Record<string, unknown> | null,
  workspaceData: Record<string, unknown> | null,
  workspaceId: string,
): AgentConfigV3 {
  if (!agentData) return FALLBACK_DENY_AGENT_CONFIG

  let agentConfig = normalizeAuthoritativeAgentConfig(
    agentData.agent_config,
    agentData.organization_allow_member_yolo === true,
  )

  if (agentConfig.security.allow_yolo_mode !== true) return agentConfig

  const before = agentConfig.security.approval_grant
  const grant = workspaceId ? readWorkspaceApprovalGrant(workspaceData) : 'always_ask'
  if (before === grant) return agentConfig

  log.info(
    `host-turn-bundle workspace-grant overlay ` +
      `workspace=${workspaceId ? `${workspaceId.slice(0, 8)}…` : 'none'} ` +
      `${before ?? 'undef'} → ${grant}`,
  )
  return {
    ...agentConfig,
    security: {
      ...agentConfig.security,
      approval_grant: grant,
    },
  }
}

/** 无状态时：并行 DETAIL → 写入仓库 → 返回 bundle。 */
export async function fetchHostTurnBundle(params: {
  agentId?: string | null
  workspaceId?: string | null
} & HostTurnBundleDeps): Promise<HostTurnBundle> {
  const { agentId, workspaceId, turnStore: explicitTurn, ...deps } = params
  const turn = resolveTurnStore(explicitTurn)
  const trimmedAgentId = typeof agentId === 'string' ? agentId.trim() : ''
  const trimmedWorkspaceId = typeof workspaceId === 'string' ? workspaceId.trim() : ''

  if (!trimmedAgentId && !trimmedWorkspaceId) {
    return { agentConfig: FALLBACK_DENY_AGENT_CONFIG, profile: {} }
  }

  const [agentData, workspaceData] = await Promise.all([
    trimmedAgentId
      ? getDetail(API_ENDPOINTS.AGENT.DETAIL(trimmedAgentId), deps).catch((err) => {
          log.warn(
            `agent detail failed agent=${trimmedAgentId.slice(0, 8)}… err=${err instanceof Error ? err.message : String(err)}`,
          )
          return null
        })
      : Promise.resolve(null),
    trimmedWorkspaceId
      ? getDetail(API_ENDPOINTS.WORKSPACE.DETAIL(trimmedWorkspaceId), deps).catch((err) => {
          log.warn(
            `workspace detail failed workspace=${trimmedWorkspaceId.slice(0, 8)}… err=${err instanceof Error ? err.message : String(err)}`,
          )
          return null
        })
      : Promise.resolve(null),
  ])

  turn.ingestDetails({
    agentId: trimmedAgentId || null,
    workspaceId: trimmedWorkspaceId || null,
    agentData,
    workspaceData,
  })

  const fromStore = turn.compose(trimmedAgentId || null, trimmedWorkspaceId || null, {
    isExecutionLimitsEnabled,
  })
  if (fromStore) return fromStore

  return {
    agentConfig: trimmedAgentId
      ? buildAgentConfig(agentData, workspaceData, trimmedWorkspaceId)
      : FALLBACK_DENY_AGENT_CONFIG,
    profile: buildProfile(agentData, workspaceData),
    ...(trimmedAgentId && agentData ? { resolvedAgentId: trimmedAgentId } : {}),
  }
}

const inflight = new Map<string, Promise<HostTurnBundle>>()

function hasCompleteHostContext(
  turn: HostTurnStore,
  agentId: string,
  workspaceId: string,
): boolean {
  if (!turn.canCompose(agentId || null, workspaceId || null)) return false
  if (agentId && !turn.getAgent(agentId)?.detail) return false
  if (agentId && !turn.getAgent(agentId)?.operationSwitches) return false
  if (workspaceId) {
    const workspace = turn.getWorkspace(workspaceId)
    if (
      !workspace?.detail
      || !workspace.organizationDetail
      || !workspace.runtimeConfig
    ) return false
  }
  return true
}

function canUseCachedHostContext(
  turn: HostTurnStore,
  agentId: string,
  workspaceId: string,
): boolean {
  return boundHostStateReconciler
    ? hasCompleteHostContext(turn, agentId, workspaceId)
    : turn.canCompose(agentId || null, workspaceId || null)
}

/** Host query 入口：完整快照直接合成，缺字段则由 Host 主动向后端对账。 */
export function loadHostTurnBundle(params: {
  agentId?: string | null
  workspaceId?: string | null
} & HostTurnBundleDeps): Promise<HostTurnBundle> {
  const trimmedAgentId = typeof params.agentId === 'string' ? params.agentId.trim() : ''
  const trimmedWorkspaceId = typeof params.workspaceId === 'string' ? params.workspaceId.trim() : ''
  const turn = resolveTurnStore(params.turnStore)

  if (canUseCachedHostContext(turn, trimmedAgentId, trimmedWorkspaceId)) {
    const composed = turn.compose(trimmedAgentId || null, trimmedWorkspaceId || null, {
      isExecutionLimitsEnabled,
    })
    if (composed) {
      log.info(
        `[host-turn-bundle] compose hit (frontend state) `
          + `agent=${trimmedAgentId ? `${trimmedAgentId.slice(0, 8)}…` : 'none'} `
          + `workspace=${trimmedWorkspaceId ? `${trimmedWorkspaceId.slice(0, 8)}…` : 'none'}`,
      )
      return Promise.resolve(composed)
    }
  }

  const key = `${trimmedAgentId}\0${trimmedWorkspaceId}`
  const existing = inflight.get(key)
  if (existing) return existing

  log.info(
    `[host-turn-bundle] authoritative context miss → reconcile host state `
      + `agent=${trimmedAgentId ? `${trimmedAgentId.slice(0, 8)}…` : 'none'} `
      + `workspace=${trimmedWorkspaceId ? `${trimmedWorkspaceId.slice(0, 8)}…` : 'none'}`,
  )
  const promise = (async () => {
    if (boundHostStateReconciler) {
      const reconciledSuccessfully = await boundHostStateReconciler()
      if (!reconciledSuccessfully) {
        throw new Error('Authoritative Host state is unavailable')
      }
      if (hasCompleteHostContext(turn, trimmedAgentId, trimmedWorkspaceId)) {
        const reconciled = turn.compose(trimmedAgentId || null, trimmedWorkspaceId || null, {
          isExecutionLimitsEnabled,
        })
        if (reconciled) return reconciled
      }
      throw new Error('Authoritative Host state is incomplete for selected context')
    }
    return fetchHostTurnBundle(params)
  })().finally(() => {
    if (inflight.get(key) === promise) inflight.delete(key)
  })
  inflight.set(key, promise)
  return promise
}

/** Settings / invalidate：清进程内 turn 状态（下次发送再 hydrate）。 */
export function clearHostTurnBundleCache(opts?: {
  agentId?: string
  workspaceId?: string
  turnStore?: HostTurnStore
}): void {
  resolveTurnStore(opts?.turnStore).clear(
    opts?.agentId || opts?.workspaceId
      ? { agentId: opts.agentId, workspaceId: opts.workspaceId }
      : undefined,
  )
  if (!opts?.agentId && !opts?.workspaceId) {
    inflight.clear()
    return
  }
  for (const key of [...inflight.keys()]) {
    const [agentPart = '', workspacePart = ''] = key.split('\0')
    if (opts.agentId && agentPart === opts.agentId) {
      inflight.delete(key)
      continue
    }
    if (opts.workspaceId && workspacePart === opts.workspaceId) {
      inflight.delete(key)
    }
  }
}
