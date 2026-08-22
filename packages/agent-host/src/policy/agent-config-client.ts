/**
 * agent-config-client — 权威 `AgentConfigV3` 拉取客户端（Electron + Daemon 共用）。
 *
 * 背景（yolo PRD v3 review M2）：
 *   旧路径把 wire / IPC payload 的 `yoloMode` / `approval_grant` 直接当权威源
 *   写回 `session.agentConfigV3.security`，等于把客户端 cache 当 gate 真相——
 *   攻击者篡改 payload 就能绕开 Settings 里的 Agent 级 gate 提权。
 *
 *   本 client 由 host 每条消息入口现拉 Django `agent_config`，wire payload
 *   的 yolo/grant 字段降级为"客户端声称值"，仅用作 telemetry 比对，不再作
 *   gate 决策依据。
 *
 * 契约：
 *   - **5s 内存 cache（per-agentId）**：连续消息摊销 HTTP 成本；TTL 是 PRD §7.3
 *     "gate 修改后下一次工具决策 < 100ms" 与 "Settings 改完立刻生效"
 *     两条约束的折中；命中 cache 时 < 1ms 返回。
 *   - **失败 deny-by-default**：fetch 失败 / 401 / 404 / envelope 非法 → 返回
 *     `{ security: { allow_yolo_mode: false, approval_grant: 'always_ask' } }`。
 *     **永不抛错**，让 handleQuery 主链路继续走；但绝不能误判成允许 yolo。
 *   - **不阻塞 typing**：调用方在 handleQuery 入口 `await`；用户首条消息 / TTL
 *     过期时感受 ~200ms 延迟，可接受。
 *   - **URL / auth 由调用方注入**：Electron 走 `TokenManager` + Renderer API
 *     base；Daemon 走 install token + `deriveApiBaseUrl(config.server_url)`。
 *     agent-host 不假设具体宿主形态。
 */

import type { AgentConfigV3, AgentSecurityConfig } from '@tabtin/security-policy'

/**
 * Cache TTL — 5 秒。
 *
 * 取值理由（见头注释「契约」）：
 *   - 太短（<2s）：UI 快速连发消息时每条都 fetch，HTTP 成本回归
 *   - 太长（>10s）：用户在 Settings 关 gate 后下一条消息仍误读旧值（命中 cache），
 *     违反 PRD "Settings 改完立刻生效" 的 UX 期望
 */
export const CACHE_TTL_MS = 5_000

/** HTTP 超时（与其它 main 侧 authed fetch 对齐）。 */
const FETCH_TIMEOUT_MS = 10_000

// ─── Public API ──────────────────────────────────────────────────────

export interface AgentConfigClient {
  /**
   * 现拉权威 `AgentConfigV3`（带 5s 内存 cache）。
   *
   * **永不抛错**：fetch 失败 / 401 / 404 / 网络断 → 返回
   * `{ security: { allow_yolo_mode: false, approval_grant: 'always_ask' }, ... }`。
   *
   * @param agentId Agent UUID
   */
  fetchAuthoritativeAgentConfig(agentId: string): Promise<AgentConfigV3>
  /** 清空 cache（测试 / Settings 强制刷新用）。传 agentId 时只清该 Agent。 */
  clearCache(agentId?: string): void
}

export interface AgentConfigClientLogger {
  debug?(message: string): void
  info?(message: string): void
  warn(message: string): void
}

export interface AgentConfigClientOptions {
  /** 注入 fetch（测试用；缺省 globalThis.fetch）。 */
  fetch?: typeof fetch
  /** 获取访问令牌（Bearer）。返回 null/undefined 时不发请求、直接 fallback。 */
  getAccessToken(): Promise<string | null | undefined> | string | null | undefined
  /** 获取当前 X-Organization-Id（可选；缺省不写该 header）。 */
  getOrganizationId?(): string | null | undefined
  /**
   * 构造 Agent 详情 URL。宿主自己拼 `apiBase + /agents/${agentId}`，
   * agent-host 不引入 `@tabtin/config` / `API_BASE_URL` 之类的运行时耦合。
   */
  buildAgentDetailUrl(agentId: string): string
  /** 时间源（测试冻结 cache TTL 时用）。 */
  now?(): number
  /** TTL 覆盖（测试用）。 */
  cacheTtlMs?: number
  /** 日志（宿主 logger 注入；不注入则静默）。 */
  logger?: AgentConfigClientLogger
}

/** Cache 单元 */
interface CacheEntry {
  config: AgentConfigV3
  fetchedAt: number
}

/** Fallback：deny-by-default 的最小合法 AgentConfigV3。 */
export const FALLBACK_DENY_AGENT_CONFIG: AgentConfigV3 = Object.freeze({
  schema_version: 3,
  runtime_plane: 'local',
  security: Object.freeze<AgentSecurityConfig>({
    allow_yolo_mode: false,
    approval_grant: 'always_ask',
  }) as AgentSecurityConfig,
}) as AgentConfigV3

/** @deprecated 使用 {@link FALLBACK_DENY_AGENT_CONFIG} */
const FALLBACK_DENY = FALLBACK_DENY_AGENT_CONFIG

/**
 * 创建一个 AgentConfigClient 实例。通常宿主进程内单例：Electron 在
 * `ElectronAgentHost` 构造时 new 一次；Daemon 在 `DaemonAgentHost` 构造
 * 时 new 一次。
 */
export function createAgentConfigClient(opts: AgentConfigClientOptions): AgentConfigClient {
  const cache = new Map<string, CacheEntry>()
  const fetchImpl = opts.fetch ?? globalThis.fetch
  const tokenGetter = opts.getAccessToken
  const organizationGetter = opts.getOrganizationId ?? (() => null)
  const urlBuilder = opts.buildAgentDetailUrl
  const now = opts.now ?? (() => Date.now())
  const ttl = opts.cacheTtlMs ?? CACHE_TTL_MS
  const log = opts.logger

  return {
    async fetchAuthoritativeAgentConfig(agentId: string): Promise<AgentConfigV3> {
      const cached = cache.get(agentId)
      if (cached && now() - cached.fetchedAt < ttl) {
        log?.debug?.(
          `agent-config-client cache hit agent=${agentId.slice(0, 8)}… age=${now() - cached.fetchedAt}ms`,
        )
        return cached.config
      }

      const startedAt = now()
      try {
        const token = await tokenGetter()
        if (!token) {
          log?.warn(
            `agent-config-client no auth token, fallback deny for agent=${agentId.slice(0, 8)}…`,
          )
          return FALLBACK_DENY
        }

        const organizationId = organizationGetter()
        const url = urlBuilder(agentId)

        const resp = await fetchImpl(url, {
          headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        })

        if (!resp.ok) {
          log?.warn(
            `agent-config-client HTTP ${resp.status} for agent=${agentId.slice(0, 8)}…, fallback deny`,
          )
          return FALLBACK_DENY
        }

        const body = (await resp.json()) as {
          success?: boolean
          data?: { agent_config?: AgentConfigV3; organization_allow_member_yolo?: boolean }
        }

        if (!body?.success || !body?.data) {
          log?.warn(
            `agent-config-client invalid envelope success=${body?.success} agent=${agentId.slice(0, 8)}…, fallback deny`,
          )
          return FALLBACK_DENY
        }

        const rawConfig = body.data.agent_config
        // ：组织准入天花板权威源是 Django resolve 的
        // `organization_allow_member_yolo`；#3503：approval_grant 仍来自 Agent，
        // 组织未开放时夹回 always_ask。normalize 始终显式写出 grant，避免
        // 把「组织开放」误当成「Agent 已授权 auto」（legacy allow_yolo 回落）。
        const config = normalizeAuthoritativeAgentConfig(
          rawConfig,
          body.data.organization_allow_member_yolo === true,
        )

        cache.set(agentId, { config, fetchedAt: now() })
        log?.info?.(
          `agent-config-client fetched agent=${agentId.slice(0, 8)}… ` +
            `allow_yolo=${config.security.allow_yolo_mode} ` +
            `grant=${config.security.approval_grant} ` +
            `latency=${now() - startedAt}ms`,
        )
        return config
      } catch (err) {
        log?.warn(
          `agent-config-client fetch failed agent=${agentId.slice(0, 8)}… ` +
            `err=${err instanceof Error ? err.message : String(err)} ` +
            `latency=${now() - startedAt}ms, fallback deny`,
        )
        return FALLBACK_DENY
      }
    },
    clearCache(agentId?: string): void {
      if (agentId) {
        cache.delete(agentId)
        return
      }
      cache.clear()
    },
  }
}

/**
 * 把 Django Agent DETAIL 中的 `agent_config` + 组织天花板归一为合法 `AgentConfigV3`。
 * Electron Host turn bundle 与本 client 共用，避免同轮再打一遍 DETAIL。
 *
 *  + ：
 *   - `security.allow_yolo_mode` ← 组织准入天花板（能否使用宽松审批档）
 *   - `security.approval_grant` ← Agent 已授权档 ∩ 组织天花板
 *     （组织关 → 强制 `always_ask`；组织开 → 读 Agent grant / legacy yolo→auto）
 *   - **始终显式写出 approval_grant**，避免 build-policy 的 legacy 回落把
 *     「组织开放」误读成「已授权 auto」
 */
export function normalizeAuthoritativeAgentConfig(
  raw: unknown,
  orgAllowMemberYolo: boolean,
): AgentConfigV3 {
  const orgOpen = orgAllowMemberYolo === true
  const base = (raw && typeof raw === 'object' ? raw : {}) as Partial<AgentConfigV3> & {
    security?: Partial<AgentSecurityConfig> & {
      yolo_mode?: unknown
      allow_yolo_mode?: unknown
      approval_grant?: unknown
    }
  }

  const rawGrant = base.security?.approval_grant
  let agentGrant: 'always_ask' | 'auto' | 'full_access' = 'always_ask'
  if (rawGrant === 'always_ask' || rawGrant === 'auto' || rawGrant === 'full_access') {
    agentGrant = rawGrant
  } else if (base.security?.allow_yolo_mode === true) {
    agentGrant = 'auto'
  }

  const approvalGrant = orgOpen ? agentGrant : 'always_ask'

  return {
    schema_version: 3,
    runtime_plane: base.runtime_plane === 'cloud' ? 'cloud' : 'local',
    security: {
      allow_yolo_mode: orgOpen,
      approval_grant: approvalGrant,
    },
    capabilities: base.capabilities,
    conversation: base.conversation,
    approval_memo: base.approval_memo,
  }
}
