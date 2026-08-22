/**
 * agent-config-client.ts — Electron Main 进程的权威 `agent_config` 拉取客户端
 * 薄包装。
 *
 * 权威 fetch 逻辑已下沉到 `@tabtin/agent-host/policy`（与 Daemon 共享，见
 * `DaemonAgentHost.agentConfigClient`）。本文件只做「宿主特化注入」：
 *   - `getAccessToken` → `TokenManager.getAccessToken()`（Electron 主进程 token）
 *   - `buildAgentDetailUrl` → `joinApiPath(API_BASE_URL, API_ENDPOINTS.AGENT.DETAIL(agentId))`
 *   - `logger` → `createLogger('agent-config-client')`（走 electron-log 落诊断包）
 *
 * 详细契约（cache TTL / deny-by-default / normalize 语义）见共享模块头注释。
 *
 * `fetchAuthoritativeWorkspaceApprovalGrant` 不在共享模块里：这条读的是
 * **Workspace** 事实源（`GET /context/workspaces/{id}`），不是 Agent 身份
 * API，语义上属于 Electron 侧 Workspace/Agent 解耦而非 Daemon 共用
 * 的 Agent 身份 policy，Daemon 侧当前也没有调用它。缓存/deny-by-default/
 * fail-closed 策略与共享模块保持一致，复用同一份 `fetch` / token /
 * organization / now / TTL 注入。
 *
 * ：审批上限 SSoT 是 Workspace `approval_grant`（组织开放时）。切档 IPC
 * 与 query `fetchAuthoritative` 必须走同一合成入口
 * `fetchAuthoritativeAgentConfigForWorkspace`，禁止只读 Agent 身份 grant
 *（Runtime 重建后会把「全部允许」静默降成 always_ask）。
 */

import {
  CACHE_TTL_MS,
  createAgentConfigClient as createSharedClient,
} from '@tabtin/agent-host/policy'
import type {
  AgentConfigClient as SharedAgentConfigClient,
  AgentConfigClientLogger,
  AgentConfigClientOptions,
} from '@tabtin/agent-host/policy'
import type { AgentConfigV3 } from '@tabtin/security-policy'
import { API_ENDPOINTS, joinApiPath } from '@tabtin/config'

import { TokenManager } from '../../auth.js'
import { API_BASE_URL } from '../../config/api.js'
import { createLogger } from '../../logger.js'

export { CACHE_TTL_MS } from '@tabtin/agent-host/policy'
export type { AgentConfigClientLogger } from '@tabtin/agent-host/policy'

const log = createLogger('agent-config-client')

/** HTTP 超时（与共享模块 / proactive-poller 的 10s 一致）。 */
const FETCH_TIMEOUT_MS = 10_000

export type ApprovalGrantName = 'always_ask' | 'auto' | 'full_access'

/** 本地扩展：在共享 `AgentConfigClient` 基础上加 Workspace 审批档位读取与合成。 */
export interface AgentConfigClient extends SharedAgentConfigClient {
  /** 从 Workspace 事实源读取现场审批档位；失败时 fail-closed。 */
  fetchAuthoritativeWorkspaceApprovalGrant(
    workspaceId: string,
  ): Promise<ApprovalGrantName>
  /**
   *  SSoT：组织开放时用 Workspace grant 覆盖 Agent 身份 grant；
   * 组织关闭或无 workspaceId 时 fail-closed 为 `always_ask`。
   * 切档 IPC 与 query `fetchAuthoritative` 共用此入口。
   */
  fetchAuthoritativeAgentConfigForWorkspace(
    agentId: string,
    workspaceId?: string | null,
  ): Promise<AgentConfigV3>
}

/**
 * 创建一个绑定 Electron 主进程依赖的 AgentConfigClient。
 *
 * 通常进程内单例（在 `ElectronAgentHost` 构造时 new 一次即可）。
 */
export function createAgentConfigClient(opts?: {
  /** 注入 fetch（测试用；缺省 globalThis.fetch）。 */
  fetch?: typeof fetch
  /** 注入 token getter（测试用；缺省 `TokenManager.getAccessToken`）。 */
  getAccessToken?: () => Promise<string | null>
  /**
   * 注入 organization id getter（生产由 ElectronAgentHost 透传
   * `getCLIOrganizationId`；测试可缺省）。
   */
  getOrganizationId?: () => string | null | undefined
  /** 注入 now（测试冻结 cache TTL 用）。 */
  now?: () => number
  /** TTL 覆盖（测试用）。 */
  cacheTtlMs?: number
}): AgentConfigClient {
  const fetchImpl = opts?.fetch ?? globalThis.fetch
  const tokenGetter = opts?.getAccessToken ?? (() => TokenManager.getAccessToken())
  const organizationGetter = opts?.getOrganizationId ?? (() => null)
  const now = opts?.now ?? (() => Date.now())
  const ttl = opts?.cacheTtlMs ?? CACHE_TTL_MS

  const sharedOpts: AgentConfigClientOptions = {
    fetch: fetchImpl,
    getAccessToken: tokenGetter,
    getOrganizationId: organizationGetter,
    buildAgentDetailUrl: (agentId: string) =>
      joinApiPath(API_BASE_URL, API_ENDPOINTS.AGENT.DETAIL(agentId)),
    now,
    cacheTtlMs: ttl,
    logger: log as AgentConfigClientLogger,
  }
  const sharedClient = createSharedClient(sharedOpts)

  const workspaceGrantCache = new Map<
    string,
    { grant: ApprovalGrantName; fetchedAt: number }
  >()

  async function fetchAuthoritativeWorkspaceApprovalGrant(
    workspaceId: string,
  ): Promise<ApprovalGrantName> {
    const cached = workspaceGrantCache.get(workspaceId)
    if (cached && now() - cached.fetchedAt < ttl) {
      return cached.grant
    }

    const fallback = 'always_ask' as const
    try {
      const token = await tokenGetter()
      if (!token) {
        log.warn(
          `fetchAuthoritativeWorkspaceApprovalGrant: no auth token, fallback deny for workspace=${workspaceId.slice(0, 8)}…`,
        )
        return fallback
      }
      const organizationId = organizationGetter()
      const response = await fetchImpl(
        joinApiPath(API_BASE_URL, API_ENDPOINTS.WORKSPACE.DETAIL(workspaceId)),
        {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        log.warn(
          `fetchAuthoritativeWorkspaceApprovalGrant: HTTP ${response.status} for workspace=${workspaceId.slice(0, 8)}…, fallback deny`,
        )
        return fallback
      }
      const body = (await response.json()) as {
        success?: boolean
        data?: { approval_grant?: unknown }
      }
      const rawGrant = body.data?.approval_grant
      const grant =
        body.success === true &&
        (rawGrant === 'always_ask' || rawGrant === 'auto' || rawGrant === 'full_access')
          ? rawGrant
          : fallback
      workspaceGrantCache.set(workspaceId, { grant, fetchedAt: now() })
      return grant
    } catch (err) {
      log.warn(
        `fetchAuthoritativeWorkspaceApprovalGrant failed workspace=${workspaceId.slice(0, 8)}… err=${err instanceof Error ? err.message : String(err)}, fallback deny`,
      )
      return fallback
    }
  }

  async function fetchAuthoritativeAgentConfigForWorkspace(
    agentId: string,
    workspaceId?: string | null,
  ): Promise<AgentConfigV3> {
    const config = await sharedClient.fetchAuthoritativeAgentConfig(agentId)
    // 组织未开放：共享 normalize 已把 grant 夹成 always_ask。
    if (config.security.allow_yolo_mode !== true) {
      return config
    }
    const trimmedWorkspaceId =
      typeof workspaceId === 'string' ? workspaceId.trim() : ''
    // 无 Workspace 绑定时无法读现场授权上限，与切档 IPC 同口径 fail-closed。
    const approvalGrant: ApprovalGrantName = trimmedWorkspaceId
      ? await fetchAuthoritativeWorkspaceApprovalGrant(trimmedWorkspaceId)
      : 'always_ask'
    if (config.security.approval_grant === approvalGrant) {
      return config
    }
    log.info(
      `agent-config-client workspace-grant overlay agent=${agentId.slice(0, 8)}… ` +
        `workspace=${trimmedWorkspaceId ? `${trimmedWorkspaceId.slice(0, 8)}…` : 'none'} ` +
        `agentGrant=${config.security.approval_grant ?? 'undef'} → ${approvalGrant}`,
    )
    return {
      ...config,
      security: {
        ...config.security,
        approval_grant: approvalGrant,
      },
    }
  }

  return {
    fetchAuthoritativeAgentConfig: sharedClient.fetchAuthoritativeAgentConfig,
    fetchAuthoritativeWorkspaceApprovalGrant,
    fetchAuthoritativeAgentConfigForWorkspace,
    clearCache(agentId?: string): void {
      sharedClient.clearCache(agentId)
      if (!agentId) {
        workspaceGrantCache.clear()
      }
    },
  }
}
