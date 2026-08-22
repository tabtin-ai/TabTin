/**
 * Skill 运行时密钥注入 — 宿主共享 resolver 实现（Wave 1.5）。
 *
 * **为何放在 agent-host/credentials**：
 * - Electron 主进程与 Daemon 进程都需要同一份 resolver 逻辑——HTTP 调用
 *   `POST /api/credential-vault/api-key/skill-reveal`、进程内 LRU + TTL、
 *   401/404/410/422/429 失败降级、缓存失效钩子、`warnings` 透传。
 * - 两端此前各写一份会漂移（历史上 Electron 已经走过一轮；PROD-3 拍板
 *   Daemon 补接入时决定**直接搬到共享位置一次到位**，避免再复制）。
 * - 凭据解析是 TabTin 宿主业务，不属于通用执行循环；放在 agent-host
 *   保持 Electron / Daemon 单源，同时避免 agent-runtime 依赖产品后端。
 *
 * **职责**：
 * 1. **HTTP 调用**：`POST {apiBaseUrl}/credential-vault/api-key/skill-reveal`
 *    携带 `{ space_id, agent_id, skill_key, primary_env? }` body + `Authorization: Bearer <jwt>`。
 *    —— `apiBaseUrl` 契约必须以 `/api` 结尾（与 `document-tools.ts` / `data-tools.ts` /
 *    `plan-tools.ts` 等同 runtime 其他 HTTP 工具对齐；见 `packages/tabtin-config/src/index.ts`
 *    `getApiRuntimeConfig()` 的强制约束）。本文件之前写错为 `${apiBaseUrl}/api/credential-vault/...`，
 *    配合测试 fixture 故意不带 `/api` 后缀让单测通过，但生产 / dev `apiBaseUrl` 真实带 `/api`
 *    后缀 → 双 `/api` → Django 404（2026-04-30 dogfood P0 修复，与 plan-tools / planDocumentApi 同源）。
 * 2. **缓存**：进程内 LRU + 5min TTL。命中率取决于 Agent 在一个 Skill 里
 *    连续调多少次 run_terminal_command——典型是 1 Skill = 5-20 个命令调用，缓存只需
 *    服务"一次成功查询 + 几次重试"即可，不必太大。
 * 3. **失效**：
 *    - TTL 到期自动失效；
 *    - 失败响应（401/404/410/422/429）**不进缓存**——防止用户改完设置后
 *      还用旧的"未绑定"结果；
 *    - 宿主端改密钥 / 删密钥时应主动调 `invalidate({ spaceId? / skillKey? })`
 *      （Electron Wave 5 UI 层接线时补；Daemon 目前仅 TTL 兜底，见
 *      PROD-3 决策说明）。
 * 4. **安全不变量**：
 *    - 缓存 value 是 env 明文 dict——只在内存里活；
 *    - 日志只打 credentialId / serviceName / env 变量**名列表** / warnings；
 *    - 不写磁盘、不塞 renderer IPC（renderer 不该看到密钥）。
 *
 * **降级语义**：所有错误（网络 / HTTP 4xx / 5xx）一律归结为 resolver 返回
 * `null`——run_terminal_command 工具据此继续执行命令不注入 env。不抛异常给调用方。
 *
 * **Daemon 无头部署边界**（PROD-3 决策）：
 * - 若 Daemon 启动期没有可用 JWT（`getApiAuthToken()` 返回空），resolver
 *   仍然存在但**所有请求都直接降级返回 null**——日志打 `debug` 级别
 *   一次性提示，避免每条 run_terminal_command 刷屏。
 * - Daemon 宿主应在 `start()` 时做一次 pre-flight 自检：若检测到
 *   `skillCredentialResolver === undefined` 或 token 稳定为空，打一条
 *   **WARN** 日志引导运维（"Skill credential injection disabled,
 *   reason: no JWT"）。
 */

// ─── Types ───────────────────────────────────────────────────────────

import type {
  SkillCredentialInjection,
  SkillCredentialResolver,
} from '@tabtin/agent-runtime/tools'
import { joinApiPath } from '@tabtin/agent-runtime/tools'

/**
 * 轻量 Logger 接口——宿主（electron-log / structured Logger / 测试 noop）
 * 都能实现。有意不依赖任何宿主专属 API，保持 agent-runtime 可移植。
 *
 * 契约：**仅**可打 `credentialId / serviceName / envVars (keys only) /
 * skillKey / spaceId / status / code / warnings / cacheSize` 等元数据；
 * 绝不可打 env 变量的**值**。
 */
export interface SkillCredentialResolverLogger {
  debug(message: string, fields?: Record<string, unknown>): void
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
}

/** 默认 noop logger——未注入时 resolver 静默运行（符合 agent-runtime 零依赖原则）。 */
const NOOP_LOGGER: SkillCredentialResolverLogger = {
  debug() { /* noop */ },
  info() { /* noop */ },
  warn() { /* noop */ },
}

export interface SkillCredentialResolverDeps {
  /**
   * 后端 API 根 URL，如 `https://api.example.com`（不含 `/api` 前缀）。
   * 通常从宿主的配置层透传：
   * - Electron：`ElectronAgentHost.API_BASE_URL`
   * - Daemon：`deriveApiBaseUrl(config.server_url)`
   */
  apiBaseUrl: string
  /**
   * JWT access token 的**最新**获取器。
   *
   * 为什么用 getter 而非值：
   * - Electron：每次 runtime query 构造新 resolver 时 token 是一次性快照，
   *   token 刷新会触发 runtime 重建——OK，但用 getter 更健壮；
   * - Daemon：`DaemonGatewayClient.getAccessToken()` 返回的 token 在
   *   session 期间可能被刷新，必须走 getter 以反映最新值。
   *
   * 返回空字符串 / undefined 时 resolver 直接返回 null（不发 HTTP 避免
   * 401 日志刷屏；详见 "Daemon 无头部署边界" 注释）。
   */
  getApiAuthToken: () => string | undefined
  /** Organization ID — 后端审计 / 多租户路由需要；未配置时不注入 header。 */
  organizationId?: string
  /**
   * 缓存 key 的用户命名空间。后端认证靠 JWT 即可隔离用户；这里用
   * token 的哈希前缀充当"谁在调"的指纹，保证同进程内多个 Agent Host
   * （不同用户 / 不同会话登录切换）不会串 key。
   * 缺省时用当前 token 的哈希；若 token 缺省则用 `'anon'`。
   */
  userCacheNamespace?: string
  /** 宿主侧结构化 Logger；缺省时走 noop（不打任何内部日志）。 */
  logger?: SkillCredentialResolverLogger
  /**
   * 宿主可选覆盖 `fetch`——测试注入 mock、或 Daemon 走自定义 HTTP 池。
   * 缺省用全局 `fetch`（Node 18+ / Electron 主进程均原生支持）。
   */
  fetchImpl?: typeof fetch
}

/**
 * 60 秒 TTL —— Wave 2a 从 5min 收紧（Wave 1.5 质疑 5 遗留项）。
 *
 * 为什么是 60 秒：
 *   - Skill 执行的典型窗口是几秒到几十秒（一次命令调用串），60 秒足以
 *     让同一 Skill 内的多次 run_terminal_command 命中缓存，成百倍省 HTTP round-trip；
 *   - 5min 太长：用户在凭据设置里禁用 / 到期 / 改密钥后，Agent 仍会沿用
 *     最长 5 分钟的老 env 执行命令，等同于 PD-4 "自动允许" 语义下的隐式
 *     权限泄漏。收紧到 60s 把这个窗口压缩到"即改即失效"的体感；
 *   - 真正的失效仍靠 Wave 5 的 ``invalidate(...)`` 主动调用（IPC 接线中）。
 *     TTL 只是兜底，不是主路径。
 */
const CACHE_TTL_MS = 60 * 1000

/** 单进程最多缓存 128 条 (userScope, spaceId, skillKey)，Skill 数量通常 < 50 够用。 */
const MAX_CACHE_ENTRIES = 128

interface CacheEntry {
  /** env 明文 dict —— **严格保密**，只流向 run_terminal_command → child_process env */
  injection: SkillCredentialInjection
  /** unix ms，过期后立刻丢弃 */
  expiresAt: number
}

interface CredentialListItem {
  id?: string
  is_active?: boolean
  expires_at?: string | null
}

async function verifySkillCredentialStillActive(
  deps: Pick<SkillCredentialResolverDeps, 'apiBaseUrl' | 'getApiAuthToken' | 'organizationId' | 'fetchImpl'>,
  credentialId: string,
  signal: AbortSignal | undefined,
  log: SkillCredentialResolverLogger,
): Promise<boolean> {
  const token = deps.getApiAuthToken()
  if (!token || !credentialId) return false

  const fetchFn = deps.fetchImpl ?? fetch
  const url = joinApiPath(deps.apiBaseUrl, '/credential-vault/list?category=api_key')
  const headers: Record<string, string> = {
    Accept: 'application/json',
    Authorization: `Bearer ${token}`,
  }
  if (deps.organizationId) headers['X-TabTin-Organization-Id'] = deps.organizationId

  let response: Response
  try {
    response = await fetchFn(url, { method: 'GET', headers, signal })
  } catch (err) {
    log.warn('skill-credential active-check fetch failed', {
      credentialId,
      error: err instanceof Error ? err.message : String(err),
    })
    // 网络抖动时保守降级：视为仍 active，避免误杀正在执行的 Skill。
    return true
  }

  if (!response.ok) {
    log.warn('skill-credential active-check rejected', {
      credentialId,
      status: response.status,
    })
    return true
  }

  let items: CredentialListItem[]
  try {
    items = (await response.json()) as CredentialListItem[]
  } catch {
    return true
  }

  const match = items.find((item) => String(item.id) === credentialId)
  if (!match) return false
  if (match.is_active === false) return false
  if (match.expires_at) {
    const expiresAt = Date.parse(match.expires_at)
    if (!Number.isNaN(expiresAt) && expiresAt < Date.now()) return false
  }
  return true
}

export interface SkillCredentialResolverHandle {
  /** 注入给 `ToolProvider.coreTools.skillCredentialResolver` 的回调。 */
  resolver: SkillCredentialResolver
  /**
   * 主动失效入口（Wave 5 UI "改完密钥刷新缓存"会接线）。
   * 不传 filter 或 filter 两字段都空 → 清空全部。
   */
  invalidate: (filter?: { spaceId?: string; skillKey?: string }) => void
  /** 运维诊断用：当前缓存 + 命中统计。不含密钥。 */
  stats: () => { entries: number; hits: number; misses: number; errors: number }
}

interface CredentialRevealResponse {
  success?: boolean
  credential_id?: string
  service_name?: string
  env?: Record<string, string>
  warnings?: string[]
}

interface ResolverStats {
  hits: number
  misses: number
  errors: number
}

interface ResolveCredentialRequest {
  skillKey: string
  spaceId: string
  agentId: string
  primaryEnv?: string
}

async function resolveCachedCredential(args: {
  cached: CacheEntry
  cache: Map<string, CacheEntry>
  cacheKey: string
  deps: SkillCredentialResolverDeps
  request: ResolveCredentialRequest
  signal: AbortSignal | undefined
  log: SkillCredentialResolverLogger
  stats: ResolverStats
}): Promise<SkillCredentialInjection | null> {
  const { cached, cache, cacheKey, deps, request, signal, log, stats } = args
  const stillActive = await verifySkillCredentialStillActive(
    deps,
    cached.injection.credentialId,
    signal,
    log,
  )
  if (!stillActive) {
    cache.delete(cacheKey)
    log.warn('skill-credential cache invalidated — credential inactive or missing', {
      skillKey: request.skillKey,
      spaceId: request.spaceId,
      credentialId: cached.injection.credentialId,
    })
    return null
  }
  stats.hits += 1
  log.debug('skill-credential cache hit', {
    skillKey: request.skillKey,
    spaceId: request.spaceId,
    credentialId: cached.injection.credentialId,
    serviceName: cached.injection.serviceName,
    envVars: Object.keys(cached.injection.env).sort(),
    warnings: cached.injection.warnings,
  })
  return cached.injection
}

async function fetchCredentialReveal(args: {
  deps: SkillCredentialResolverDeps
  fetchFn: typeof fetch
  request: ResolveCredentialRequest
  signal: AbortSignal | undefined
  token: string
  log: SkillCredentialResolverLogger
  stats: ResolverStats
}): Promise<Response | null> {
  const { deps, fetchFn, request, signal, token, log, stats } = args
  const url = joinApiPath(deps.apiBaseUrl, '/credential-vault/api-key/skill-reveal')
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  }
  if (deps.organizationId) headers['X-TabTin-Organization-Id'] = deps.organizationId

  const body = JSON.stringify({
    space_id: request.spaceId,
    agent_id: request.agentId,
    skill_key: request.skillKey,
    primary_env: request.primaryEnv,
  })

  try {
    return await fetchFn(url, { method: 'POST', headers, body, signal })
  } catch (err) {
    stats.errors += 1
    log.warn('skill-credential fetch failed', {
      skillKey: request.skillKey,
      spaceId: request.spaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

async function handleRejectedCredentialResponse(
  response: Response,
  request: ResolveCredentialRequest,
  log: SkillCredentialResolverLogger,
  stats: ResolverStats,
): Promise<null> {
  stats.errors += 1
  let code: string | undefined
  try {
    const j = (await response.json()) as { code?: string }
    code = j?.code
  } catch {
    /* ignore */
  }
  // 三视角 Review 修复（用户 2）：生产部署常把日志级别设成 >= warn
  // （systemd journald 默认也倾向过滤 info）——这条是运维排查 401 /
  // 404 / 410 / 422 等"后端拒绝"的关键线索，必须是 warn。message 里
  // 直接带 status + code，让 `rg skill-credential` 一次捞出根因。
  log.warn(
    `skill-credential backend rejected status=${response.status} code=${code ?? 'n/a'}`,
    {
      skillKey: request.skillKey,
      spaceId: request.spaceId,
      status: response.status,
      code,
    },
  )
  return null
}

async function parseCredentialRevealResponse(
  response: Response,
  request: ResolveCredentialRequest,
  log: SkillCredentialResolverLogger,
  stats: ResolverStats,
): Promise<CredentialRevealResponse | null> {
  try {
    return (await response.json()) as CredentialRevealResponse
  } catch (err) {
    stats.errors += 1
    log.warn('skill-credential response not JSON', {
      skillKey: request.skillKey,
      spaceId: request.spaceId,
      error: err instanceof Error ? err.message : String(err),
    })
    return null
  }
}

function buildCredentialInjection(parsed: CredentialRevealResponse): SkillCredentialInjection | null {
  if (!parsed.success || !parsed.env || Object.keys(parsed.env).length === 0) return null
  return {
    env: parsed.env,
    serviceName: parsed.service_name ?? 'unknown',
    credentialId: parsed.credential_id ?? '',
    // PROD-5：后端 warnings（如 `primary_env_ignored_for_mapped_service`）
    // 透传给调用方。run_terminal_command 工具会把它发成 SYSTEM_NOTICE 让 LLM 可感知。
    ...(Array.isArray(parsed.warnings) && parsed.warnings.length > 0
      ? { warnings: [...parsed.warnings] }
      : {}),
  }
}

/**
 * 构造宿主共享的 Skill 凭据 resolver（**Electron / Daemon 唯一实现**）。
 */
export function createSkillCredentialResolver(
  deps: SkillCredentialResolverDeps,
): SkillCredentialResolverHandle {
  const log = deps.logger ?? NOOP_LOGGER
  const fetchFn = deps.fetchImpl ?? fetch
  const cache = new Map<string, CacheEntry>()
  const stats: ResolverStats = { hits: 0, misses: 0, errors: 0 }

  // token 哈希只取一次当作命名空间指纹——即使后续 token 刷新，也不应该
  // 换命名空间（会击穿缓存），哈希采样 ~2 字节区分度足够避免用户切换
  // 串 key 的极端情况。
  const initialToken = deps.getApiAuthToken()
  const nsHash = deps.userCacheNamespace
    ?? (initialToken ? hashToken(initialToken) : 'anon')

  function cacheKey(spaceId: string, agentId: string, skillKey: string): string {
    return `${nsHash}::${spaceId}::${agentId}::${skillKey}`
  }

  function pruneExpired(): void {
    const now = Date.now()
    for (const [k, v] of cache.entries()) {
      if (v.expiresAt <= now) cache.delete(k)
    }
  }

  function enforceMaxSize(): void {
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestKey = cache.keys().next().value
      if (oldestKey === undefined) break
      cache.delete(oldestKey)
    }
  }

  const resolver: SkillCredentialResolver = async (
    request,
    signal,
  ) => {
    pruneExpired()
    const { skillKey, spaceId, agentId } = request
    if (!agentId?.trim()) {
      log.warn('skill-credential missing agentId; refusing reveal ', {
        skillKey,
        spaceId,
      })
      return null
    }
    const key = cacheKey(spaceId, agentId, skillKey)
    const cached = cache.get(key)
    if (cached) {
      return resolveCachedCredential({
        cached,
        cache,
        cacheKey: key,
        deps,
        signal,
        log,
        request,
        stats,
      })
    }
    stats.misses += 1

    const token = deps.getApiAuthToken()
    if (!token) {
      // 未登录 / 无 token—— 直接降级，不发 HTTP 避免 401 日志刷屏。
      // Daemon 无头部署在 JWT 过期但还未重新 init 的时段会走这条路径；
      // 宿主应在启动期额外打 WARN 引导运维（见 module doc）。
      log.debug('skill-credential no auth token; falling back to no-inject', {
        skillKey,
        spaceId,
      })
      return null
    }

    const response = await fetchCredentialReveal({ deps, fetchFn, request, signal, token, log, stats })
    if (!response) return null

    if (!response.ok) {
      return handleRejectedCredentialResponse(response, request, log, stats)
    }

    const parsed = await parseCredentialRevealResponse(response, request, log, stats)
    if (!parsed) return null

    const injection = buildCredentialInjection(parsed)
    if (!injection) {
      log.info('skill-credential backend ok but empty env', {
        skillKey,
        spaceId,
        credentialId: parsed.credential_id,
      })
      return null
    }

    cache.set(key, {
      injection,
      expiresAt: Date.now() + CACHE_TTL_MS,
    })
    enforceMaxSize()

    log.debug('skill-credential fetched', {
      skillKey,
      spaceId,
      credentialId: injection.credentialId,
      serviceName: injection.serviceName,
      envVars: Object.keys(injection.env).sort(),
      warnings: injection.warnings,
      cacheSize: cache.size,
    })

    return injection
  }

  return {
    resolver,
    invalidate(filter) {
      if (!filter || (!filter.spaceId && !filter.skillKey)) {
        cache.clear()
        return
      }
      for (const k of Array.from(cache.keys())) {
        const parts = k.split('::')
        // [ns, spaceId, agentId, skillKey]
        if (filter.spaceId && parts[1] === filter.spaceId) cache.delete(k)
        else if (filter.skillKey && parts[3] === filter.skillKey) cache.delete(k)
      }
    },
    stats() {
      return { entries: cache.size, hits: stats.hits, misses: stats.misses, errors: stats.errors }
    },
  }
}

/**
 * JWT 简易哈希——仅用于缓存 key 命名空间区分，不做安全校验。
 * 避免直接把 token 当 key（日志 / 序列化风险）。
 */
function hashToken(token: string): string {
  let h = 0
  for (let i = 0; i < token.length; i++) {
    h = ((h << 5) - h + token.charCodeAt(i)) | 0
  }
  return `u${(h >>> 0).toString(36)}`
}
