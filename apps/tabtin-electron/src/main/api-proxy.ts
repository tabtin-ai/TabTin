import https from 'https'
import http from 'http'
import {
  type RetryConfig,
  DEFAULT_RETRY_CONFIG,
  shouldRetryError,
  calculateRetryDelay,
  resolve429RetryAfterMs,
  get429MaxRetriesForMethod,
  compute429BackoffMs,
  extractRetryAfterFromProxyResult,
} from '@shared/api-retry-config'
import { errResponse, okResponse } from '@tabtin/agent-wire'
import { API_BASE_URL, DISTRIBUTION_KIND } from './config/api'
import { createLogger } from './logger'
import { guardedHandle } from './utils/guarded-handle'
import {
  generateTraceId,
  getCurrentTraceId,
  setCurrentTraceId,
  traceContextStorage,
} from './utils/trace-context'
import {
  makeInspectorRecordId,
  pushHttpCallToInspector,
  type InspectorHttpRecord,
} from './utils/inspector-push'
import {
  resolveDistributionProfile,
  type DistributionProfile,
} from './services/distribution-profile'

const log = createLogger('api-proxy')
const configuredDistributionProfile = resolveDistributionProfile({
  kind: DISTRIBUTION_KIND,
  apiBaseUrl: API_BASE_URL,
})

// 延迟函数
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

const BLOCKED_HOSTS = new Set([
  'metadata.google.internal',
  'metadata.internal',
])

// 允许的官方域名 — 包含历史品牌（example.com）和当前事实生产 / 预发域名
// （api-preprod.example.com）。两套并存是为了兼容历史 build / 渐进迁移；任何新增
// 官方域名应该补在这两个集合里，**不要**只靠 `allowedDevHosts` 兜底
// （allowedDevHosts 只收本地 env 里显式写出的服务地址，一旦运行时被 .env
// 改写到别的 host，硬编码 allowlist 就是兜底的最后一道）。
const ALLOWED_HOST_EXACT = new Set([
  'example.com',
  'api-preprod.example.com',
  'localhost',
])
const ALLOWED_HOST_SUFFIXES = ['.example.com', '.api-preprod.example.com']

export function isAllowedApiHost(
  url: string,
  profile: DistributionProfile = configuredDistributionProfile,
): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
    const hostname = parsed.hostname.toLowerCase()
    if (profile.kind === 'community') {
      return profile.apiOrigins.includes(parsed.origin)
    }
    if (ALLOWED_HOST_EXACT.has(hostname)) return true
    if (allowedDevHosts.has(hostname)) return true
    for (const suffix of ALLOWED_HOST_SUFFIXES) {
      if (hostname.endsWith(suffix)) return true
    }
    return false
  } catch {
    return false
  }
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000
const ORGANIZATION_MEMBER_REMOVAL_TIMEOUT_MS = 120_000
/** 用量/账单 CSV 导出：首批查询 + 任务名反查后才持续出块，默认 30s 会误杀。 */
const BILLING_EXPORT_REQUEST_TIMEOUT_MS = 180_000

/**
 * 自动重试只适用于天然幂等请求：
 * - 后端能用 client_request_id 去重的 IM 发消息
 * - 只读导入预览（读文件 + 表结构，无副作用）
 * 其他 POST 即使调用方传了 retryConfig 也必须保持单次，避免重复创建/通知等副作用。
 */
function isIdempotentImMessageSend(options: { url: string; method: string; body?: string }): boolean {
  if (options.method.toUpperCase() !== 'POST' || !options.body) return false
  try {
    const pathname = new URL(options.url).pathname
    if (!/^\/api\/im\/conversations\/[^/]+\/messages\/?$/.test(pathname)) return false
    const body = JSON.parse(options.body) as { client_request_id?: unknown }
    return typeof body.client_request_id === 'string' && body.client_request_id.length > 0
  } catch {
    return false
  }
}

/** TabData 导入预览：幂等只读 POST，允许一次瞬时网络/网关重试。 */
function isIdempotentImportPreview(options: { url: string; method: string }): boolean {
  if (options.method.toUpperCase() !== 'POST') return false
  try {
    const pathname = new URL(options.url).pathname
    return /\/tabdata\/import\/preview\/?$/.test(pathname)
  } catch {
    return false
  }
}

function resolveRetryPolicy(options: {
  url: string
  method: string
  body?: string
  retryConfig?: Partial<RetryConfig>
}): { retryConfig: RetryConfig; allowLimitedPostRetry: boolean } {
  const allowLimitedPostRetry =
    isIdempotentImMessageSend(options) || isIdempotentImportPreview(options)
  const configured = { ...DEFAULT_RETRY_CONFIG, ...options.retryConfig }
  if (options.method.toUpperCase() !== 'POST') {
    return { retryConfig: configured, allowLimitedPostRetry: false }
  }

  return {
    retryConfig: {
      ...configured,
      maxRetries: allowLimitedPostRetry ? Math.min(configured.maxRetries, 1) : 0,
    },
    allowLimitedPostRetry,
  }
}

export function toProxyNetworkError(error: unknown): Error & { code?: string; reason?: string } {
  const source = error instanceof Error ? error : new Error(String(error))
  const sourceWithDetails = source as Error & { code?: unknown; reason?: unknown }
  // makeRequest 已经封装过的错误直接复用，避免 handler 边界再包一层而污染原始原因。
  if (typeof sourceWithDetails.reason === 'string') {
    return source as Error & { code?: string; reason?: string }
  }
  const wrapped = new Error(`Network error: ${source.message}`, { cause: source }) as Error & {
    code?: string
    reason?: string
  }
  if (typeof sourceWithDetails.code === 'string' && sourceWithDetails.code.length > 0) {
    wrapped.code = sourceWithDetails.code
  }
  wrapped.reason = source.message
  return wrapped
}
/** URL 导入要等后端拉 GitHub raw 等上游；默认 30s 会在慢网下误杀，用户看到假「格式错误」。 */
const SKILL_IMPORT_REQUEST_TIMEOUT_MS = 120_000

/**
 * dev 现场放行的服务 host 集合。
 *
 * 历史实现只认 `API_BASE_URL` 一个 host，但本地开发还可能运行独立设备控制服务，
 * 各自地址都写在根 `.env` / `.env.local`。
 * 一旦把 API host 从 `127.0.0.1` 改成局域网 IP（手机联调的常规操作），其余
 * 仍指向 `127.0.0.1` 的服务就全部掉出白名单——症状是 IPC 层直接抛
 * "Request blocked: host is not in the allowlist"，连网络请求都没发出去，
 * 跟"服务没起"的表现完全不同，极难定位。
 *
 * 这里按「配置里显式写出的服务地址」扩展白名单，而不是放宽私网网段本身：
 * 没写进 env 的 `127.0.0.1` 依然会被 blocklist 拦下，SSRF 边界不变。
 */
const DEV_SERVICE_BASE_ENV_KEYS = [
  'VITE_DAEMON_CONTROL_API_BASE_URL',
  'TABTIN_DAEMON_CONTROL_API_BASE_URL',
] as const

const allowedDevHosts: ReadonlySet<string> = (() => {
  const hosts = new Set<string>()
  const addHost = (rawUrl: string | undefined): void => {
    if (!rawUrl) return
    try {
      hosts.add(new URL(rawUrl).hostname.toLowerCase())
    } catch {
      // 配置写错不该让整个白名单塌掉，跳过即可。
    }
  }
  addHost(API_BASE_URL)
  for (const key of DEV_SERVICE_BASE_ENV_KEYS) addHost(process.env[key])
  return hosts
})()

export function isBlockedApiHost(
  url: string,
  profile: DistributionProfile = configuredDistributionProfile,
): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return true
    const hostname = parsed.hostname.toLowerCase()
    if (profile.apiOrigins.includes(parsed.origin)) return false
    if (allowedDevHosts.has(hostname)) return false
    if (BLOCKED_HOSTS.has(hostname)) return true
    if (hostname === '169.254.169.254') return true
    // Block IPv4 private ranges when accessed directly by IP
    const ipv4Match = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname)
    if (ipv4Match) {
      const [, a, b] = ipv4Match.map(Number)
      if (a === 10) return true
      if (a === 172 && b !== undefined && b >= 16 && b <= 31) return true
      if (a === 192 && b === 168) return true
      if (a === 127) return true
      if (a === 169 && b === 254) return true
    }
    // Block IPv6 private/reserved ranges (hostname from URL parser strips brackets)
    if (hostname.includes(':')) {
      if (hostname === '::1' || hostname === '0:0:0:0:0:0:0:1') return true
      if (hostname === '::' || hostname === '0:0:0:0:0:0:0:0') return true
      if (/^fe[89ab][0-9a-f]:/.test(hostname)) return true   // fe80::/10 link-local
      if (/^f[cd][0-9a-f]{2}:/.test(hostname)) return true   // fc00::/7 unique local
      // IPv4-mapped IPv6 ::ffff:a.b.c.d — check embedded IPv4
      const v4mapped = /^::ffff:(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(hostname)
      if (v4mapped) {
        const [, ma, mb] = v4mapped.map(Number)
        if (ma === 10) return true
        if (ma === 172 && mb !== undefined && mb >= 16 && mb <= 31) return true
        if (ma === 192 && mb === 168) return true
        if (ma === 127) return true
        if (ma === 169 && mb === 254) return true
      }
    }
    return false
  } catch {
    return true
  }
}

/** Exported for unit tests — request-based long-timeout routing. */
export function getRequestTimeoutMs(url: string, method?: string): number {
  try {
    const pathname = new URL(url).pathname
    if (
      method?.toUpperCase() === 'DELETE'
      && /\/context\/organizations\/[^/]+\/members\/[^/]+\/?$/.test(pathname)
    ) {
      return ORGANIZATION_MEMBER_REMOVAL_TIMEOUT_MS
    }
    // POST /api/skills/import（含尾斜杠）——后端可能同步下载远程 URL，需长于默认 30s。
    if (/\/skills\/import\/?$/.test(pathname)) {
      return SKILL_IMPORT_REQUEST_TIMEOUT_MS
    }
    // 组织用量 CSV / 钱包流水 CSV：流式生成前可能有一段静默查询窗口。
    if (
      /\/services\/billing\/organizations\/[^/]+\/billing\/export\/?$/.test(pathname)
      || /\/wallet\/organizations\/[^/]+\/transactions\/export\/?$/.test(pathname)
      || /\/tabdata\/export\/(csv|excel|json|pdf)\/?$/.test(pathname)
    ) {
      return BILLING_EXPORT_REQUEST_TIMEOUT_MS
    }
  } catch {
    // Fall back to the default timeout on malformed URLs.
  }
  return DEFAULT_REQUEST_TIMEOUT_MS
}

/**
 * 确认当前 ALS context 内有 trace_id；如果没有（譬如 main 启动期定时
 * 任务直接调用，没有 IPC handler 包裹），就 generate 一个并 enterWith
 * 进入新 context。返回最终 trace_id。
 *
 * 设计取舍：
 *   - 在 ALS 内的调用：直接复用现有 trace（IPC handler 入口已 generate）
 *   - 不在 ALS 内的调用：generate 一个新 trace 并 enterWith。注意 enterWith
 *     在当前异步流上一直生效到该流终结——main 启动期的定时任务调用 fetch
 *     是合适的语义（每次 setInterval 回调进来都新建一个 trace context）；
 *     如果调用方希望同一逻辑请求复用 trace，应该在调用 api-proxy 前自己
 *     `runWithTraceId` / `runWithGeneratedTrace`。
 *
 * 不在文件顶层导出——这是 api-proxy 内部细节，外部应通过 IPC handler
 * 入口（已 wrap）或直接调用 `runWithGeneratedTrace` 进入 context。
 */
function ensureTraceId(): string {
  const current = getCurrentTraceId()
  if (current !== undefined) return current
  const traceId = generateTraceId()
  // enterWith — 在当前 async 资源链上"进入"新 context；适用于"调用
  // 方没有显式 run 但希望后续 await 链能拿到 trace"的场景。
  traceContextStorage.enterWith({ trace_id: traceId })
  return traceId
}

/**
 * 从 HTTP 响应头里读 X-Request-Id（大小写无关）。
 *
 * Node.js `http` 模块的 `res.headers` 是 lowercase 字段；自定义 headers
 * 容器（譬如 mock 测试）可能用原始大小写。两者都尝试。
 *
 * 返回 undefined 表示头不存在或值不是字符串（防御性——不要返 ''
 * 让调用方误以为"读到了空字符串"）。
 */
function readTraceFromResponseHeaders(headers: unknown): string | undefined {
  if (!headers || typeof headers !== 'object') return undefined
  const h = headers as Record<string, unknown>
  const raw = h['x-request-id'] ?? h['X-Request-Id']
  if (typeof raw === 'string' && raw.length > 0) return raw
  // Node.js http 偶尔返 string[] 形态（重复头），取第一个
  if (Array.isArray(raw) && typeof raw[0] === 'string' && raw[0].length > 0) {
    return raw[0]
  }
  return undefined
}

/**
 * 重试 loop 主体 — 与 IPC handler 解耦,便于单测注入 mock makeRequest。
 *
 * 协议落地点:
 *  - §3.4 方法感知:`get429MaxRetriesForMethod(method)`(GET=3, POST=1)
 *  - §3.2 退避:首次 base = retryAfter 秒,后续 `compute429BackoffMs` 指数+jitter
 *  - §3.1 读取:`extractRetryAfterFromProxyResult` body 优先 / header fallback
 *  - 重试用尽透传 `result.retryAfter` 给 renderer 端 ApiError
 *
 * Wave 1 D3 — 自动注入 / 反读 `X-Request-Id`:
 *  1. 进入 retry loop 之前 `ensureTraceId()` 拿当前 ALS trace_id（没有
 *     就 generate 并 enterWith）；后续每次 attempt 都用同一个 trace_id
 *     写到 `X-Request-Id` 请求头。**重试同一逻辑请求，trace_id 不变**——
 *     这是关键，让 Django 端能看到"同一个 trace_id 的多次重试"。
 *  2. 收到响应时反读 `X-Request-Id`，如果 Django echo 回来跟我们发的
 *     不同（极端情况，譬如 Django middleware 覆盖了），把权威值写回
 *     ALS，让后续 envelope.trace_id 跟 Django log 对得上。
 */
export async function executeApiRequestWithRetry(
  options: {
    url: string
    method: string
    headers?: Record<string, string>
    body?: string
    multipartEntries?: Array<{ name: string; filename?: string; contentType?: string; base64: string }>
    retryConfig?: Partial<RetryConfig>
  },
  makeRequestFn: (opts: any) => Promise<any> = makeRequest,
  delayFn: (ms: number) => Promise<void> = delay,
): Promise<any> {
  const { retryConfig, allowLimitedPostRetry } = resolveRetryPolicy(options)
  let lastError: Error | null = null
  // 协议 §3.4:幂等(GET/PUT/PATCH/DELETE/HEAD/OPTIONS)默认重试 3 次,
  // 非幂等(POST)只重试 1 次。计数器替代原 has429Retried boolean。
  let retry429Count = 0
  // 429 会复用当前 loop attempt（为了保留独立的限流退避计数），因此不能只靠
  // attempt 限制总请求数：429 后的网络/5xx 失败否则会额外再试一次。
  let automaticRetryCount = 0
  const canRetryAutomatically = () => automaticRetryCount < retryConfig.maxRetries
  const max429Retries = options.method.toUpperCase() === 'POST'
    ? (allowLimitedPostRetry ? 1 : 0)
    : get429MaxRetriesForMethod(options.method)

  // Wave 1 D3：把 trace_id 注入 X-Request-Id 请求头。**整个 retry loop
  // 用同一个 trace_id**（不是每次 attempt 重新 generate），让 Django
  // 端 log 能看到"同一个 trace 重试 3 次"的因果。
  //
  // 调用方显式传 X-Request-Id（譬如 daemon 转发场景）的优先级高于本
  // 处自动 generate——`...options.headers` 在 spread 里位置在后，会
  // 覆盖默认值；这里同时写到 ALS 让后续 envelope.trace_id 一致。
  const traceId = ensureTraceId()
  const callerSuppliedTraceId =
    options.headers?.['X-Request-Id'] ?? options.headers?.['x-request-id']
  const effectiveTraceId = callerSuppliedTraceId ?? traceId
  if (callerSuppliedTraceId && callerSuppliedTraceId !== traceId) {
    setCurrentTraceId(callerSuppliedTraceId)
  }
  const headersWithTrace: Record<string, string> = {
    ...(options.headers ?? {}),
    'X-Request-Id': effectiveTraceId,
  }
  const optionsWithTrace = { ...options, headers: headersWithTrace }

  // contract W2-ζ — IpcInspector dev push。**整个 retry loop 算一次 HTTP
  // 调用记录**（不是每次 attempt 一条），duration 是从首次发请求到最终
  // 拿到结果（或抛错）的总耗时。retry 信息暂时不展开到 inspector record
  // 里，开发者从 console warn / Django log 反查重试细节。
  //
  // finalize() 只 push 一次（inspectorPushed 标志位避免双重 push）；
  // dev/prod guard 在 pushHttpCallToInspector 内部，prod 模式自动 no-op。
  const inspectorRecordId = makeInspectorRecordId()
  const inspectorStartedAt = Date.now()
  let inspectorPushed = false
  const finalize = (outcome: { result?: any; error?: any }): void => {
    if (inspectorPushed) return
    inspectorPushed = true
    try {
      const traceForRecord = getCurrentTraceId() ?? effectiveTraceId
      const record = buildInspectorRecord({
        id: inspectorRecordId,
        startedAt: inspectorStartedAt,
        method: options.method,
        url: options.url,
        body: options.body,
        traceId: traceForRecord,
        outcome,
      })
      pushHttpCallToInspector(record)
    } catch {
      // inspector 不能让主流程崩；任何序列化 / send 错误都吞掉
    }
  }

  try {
    for (let attempt = 0; attempt <= retryConfig.maxRetries; attempt++) {
      try {
        const result = await makeRequestFn(optionsWithTrace)

        // Wave 1 D3：从响应反读 X-Request-Id。Django middleware
        // process_response 会 echo 回来；如果跟发出去的不同就以服务端
        // 为准（防御性，正常情况下 Django 用我们发的）。
        const responseTraceId = readTraceFromResponseHeaders(result?.headers)
        if (responseTraceId && responseTraceId !== effectiveTraceId) {
          setCurrentTraceId(responseTraceId)
        }

        if (result.status === 429) {
          // 协议 §3.1:优先 body.retry_after_seconds → Retry-After header
          const retryAfterSeconds = extractRetryAfterFromProxyResult(result)

          if (retry429Count < max429Retries && retryAfterSeconds != null && canRetryAutomatically()) {
            // 协议 §3.2:首次重试用 retryAfter 秒,后续按指数退避 + jitter
            const backoffMs = compute429BackoffMs(retry429Count, retryAfterSeconds)
            const ceilingMs = resolve429RetryAfterMs(retryAfterSeconds, backoffMs)
            if (ceilingMs > 0) {
              log.warn(
                `429 rate-limited (${options.method} ${options.url}). ` +
                `retry_after_seconds=${retryAfterSeconds}, ` +
                `attempt ${retry429Count + 1}/${max429Retries}, waiting ${ceilingMs}ms.`
              )
              retry429Count += 1
              automaticRetryCount += 1
              await delayFn(ceilingMs)
              attempt--
              continue
            }
          }

          // 重试已用尽 / retry_after_seconds 缺失或超上限 → 透传 retryAfter 给上层
          // (renderer 进程 ApiError 会把它接走;协议 §3.4)
          if (retryAfterSeconds != null) {
            ;(result as any).retryAfter = retryAfterSeconds
          }
          finalize({ result })
          return result
        }

        if (
          canRetryAutomatically() &&
          result.status &&
          shouldRetryError(null, result.status, retryConfig)
        ) {
          const delayMs = calculateRetryDelay(attempt, retryConfig)
          log.warn(
            `HTTP ${result.status} (${options.method} ${options.url}) on attempt ${attempt + 1}/${retryConfig.maxRetries + 1}. ` +
            `Retrying in ${delayMs}ms...`
          )
          automaticRetryCount += 1
          await delayFn(delayMs)
          continue
        }

        finalize({ result })
        return result
      } catch (error: any) {
        lastError = error

        if (canRetryAutomatically() && shouldRetryError(error, undefined, retryConfig)) {
          const delayMs = calculateRetryDelay(attempt, retryConfig)
          log.warn(
            `请求失败(${options.method} ${options.url}) attempt ${attempt + 1}/${retryConfig.maxRetries + 1}: ${error.message}. ` +
            `Retrying in ${delayMs}ms...`
          )
          automaticRetryCount += 1
          await delayFn(delayMs)
          continue
        }

        log.error(`请求在 ${attempt + 1} 次尝试后仍失败(${options.method} ${options.url}):`, error)
        finalize({ error })
        throw error
      }
    }

    const finalErr = lastError || new Error('Request failed after all retries')
    finalize({ error: finalErr })
    throw finalErr
  } finally {
    // 兜底：retry loop 内 finalize 已经 push 过则 no-op；防御未覆盖路径
    // （譬如未来加分支忘了调 finalize）也能保证 inspector 一定收到。
    if (!inspectorPushed) {
      finalize({ error: lastError ?? new Error('inspector unreachable outcome') })
    }
  }
}

/**
 * contract W2-ζ — 把一次 HTTP 调用的原始材料 + outcome 转成 inspector 用的
 * record 形状。提取出独立函数：
 *   1. 主 retry loop 的 finalize() 不被序列化逻辑撑大，可读性高
 *   2. 单测可以独立验证 outcome → record 的 mapping（4xx → status='error'，
 *      envelope.ok=false → status='error'，network throw → 'error'，等）
 */
function buildInspectorRecord(input: {
  id: string
  startedAt: number
  method: string
  url: string
  body: string | undefined
  traceId: string | undefined
  outcome: { result?: any; error?: any }
}): InspectorHttpRecord {
  const { id, startedAt, method, url, body, traceId, outcome } = input
  const duration_ms = Date.now() - startedAt

  // path 提取（channel 字段语义跟 IPC channel 对齐）
  let pathForChannel = url
  try {
    pathForChannel = new URL(url).pathname
  } catch {
    /* 保留原 url */
  }

  // body 解析（dev 工具展示用，不还原到原 string）
  let argsForRecord: unknown = body
  if (typeof body === 'string' && body.length > 0) {
    try {
      argsForRecord = JSON.parse(body)
    } catch {
      // 非 JSON body（譬如 form-encoded）保持 string，开发者自己识别
      argsForRecord = body
    }
  }

  if (outcome.error) {
    return {
      id,
      source: 'http',
      channel: pathForChannel,
      args: argsForRecord,
      error: {
        code: 'NETWORK_ERROR',
        message: String(outcome.error?.message ?? outcome.error),
      },
      status: 'error',
      trace_id: traceId,
      duration_ms,
      startedAt,
      method,
      url,
    }
  }

  const result = outcome.result
  const httpStatus: number | undefined =
    typeof result?.status === 'number' ? result.status : undefined
  const data = result?.data
  const isObjectData = data && typeof data === 'object'
  const isErrEnvelope = isObjectData && (data as { ok?: unknown }).ok === false
  const isOkByHttp = httpStatus !== undefined && httpStatus >= 200 && httpStatus < 400
  const treatAsOk = isOkByHttp && !isErrEnvelope

  if (treatAsOk) {
    return {
      id,
      source: 'http',
      channel: pathForChannel,
      args: argsForRecord,
      result: data,
      status: 'ok',
      trace_id: traceId,
      duration_ms,
      startedAt,
      method,
      url,
      httpStatus,
    }
  }

  const envelope = isErrEnvelope ? (data as { error?: { code?: string; message?: string; detail?: unknown } }) : null
  const errorCode = envelope?.error?.code ?? (httpStatus !== undefined ? `HTTP_${httpStatus}` : 'UNKNOWN_ERROR')
  const errorMessage =
    envelope?.error?.message
    ?? (typeof result?.statusText === 'string' ? result.statusText : 'Request failed')

  return {
    id,
    source: 'http',
    channel: pathForChannel,
    args: argsForRecord,
    error: {
      code: errorCode,
      message: errorMessage,
      detail: envelope?.error?.detail,
    },
    status: 'error',
    trace_id: traceId,
    duration_ms,
    startedAt,
    method,
    url,
    httpStatus,
  }
}

// API代理处理器
export function registerApiProxyHandlers(): void {
  // 通用API请求代理（带重试机制）。
  //
  // 形态：Tier 2 envelope。main 端把 HTTP 响应对象塞进 okResponse 的 data
  // 字段；renderer 侧 invokeIpc 在 ok:true 分支会自动 unwrap 为 data，
  // 所以 caller（electronFetch.ts、services/api.ts 等）拿到的仍然是
  // `{status, data, headers, ...}` 的 HTTP 壳，跟早期 LEGACY 透传完全一致。
  //
  // 收益：IPC Inspector 能识别 ok 状态、trace_id 自动 stamp、ipc-lazy 的
  // ok:false 路径与 invokeIpc 严格分支统一处理，不再静默吞噬失败信号。
  // HTTP body 里的 `{success}` / `{ok}` 字段在 data 内层，跟 IPC envelope
  // 的 ok 字段是两层语义，互不干扰。
  guardedHandle('api:request', async (_, options: {
    url: string
    method: string
    headers?: Record<string, string>
    body?: string
    retryConfig?: Partial<RetryConfig>
  }) => {
    if (!isAllowedApiHost(options.url)) {
      log.warn(`api:request 被拦截：host 不在白名单内 method=${options.method} url=${options.url}`)
      throw new Error(`Request blocked: host is not in the allowlist`)
    }
    if (isBlockedApiHost(options.url)) {
      log.warn(`api:request 被拦截：目标 host 属于受限网段 method=${options.method} url=${options.url}`)
      throw new Error('Request blocked: target host is not allowed')
    }

    try {
      return okResponse(await executeApiRequestWithRetry(options))
    } catch (error) {
      const networkError = toProxyNetworkError(error)
      // 不让 Electron 的 IPC reject 擦掉 Node 网络层的 code / 原因；renderer 可据此
      // 区分断网、DNS、连接被拒绝等，并在诊断记录里还原真实失败边界。
      return errResponse(networkError.code ?? 'NETWORK_ERROR', networkError.message, {
        detail: { reason: networkError.reason },
      })
    }
  })
}

// 构建 multipart/form-data 请求体
function buildMultipartBody(
  entries: Array<{ name: string; filename?: string; contentType?: string; base64: string }>
): { body: Buffer; contentType: string } {
  const boundary = `----TabTinBoundary${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`
  const parts: Buffer[] = []

  for (const entry of entries) {
    const data = Buffer.from(entry.base64, 'base64')
    let disposition = `Content-Disposition: form-data; name="${entry.name}"`
    if (entry.filename) {
      disposition += `; filename="${entry.filename}"`
    }
    let partHeader = `--${boundary}\r\n${disposition}\r\n`
    if (entry.contentType) {
      partHeader += `Content-Type: ${entry.contentType}\r\n`
    }
    partHeader += '\r\n'
    parts.push(Buffer.from(partHeader, 'utf-8'))
    parts.push(data)
    parts.push(Buffer.from('\r\n', 'utf-8'))
  }

  parts.push(Buffer.from(`--${boundary}--\r\n`, 'utf-8'))
  return {
    body: Buffer.concat(parts),
    contentType: `multipart/form-data; boundary=${boundary}`,
  }
}

const ABSOLUTE_TIMEOUT_MULTIPLIER = 3

export type OfficeImportRequestStage =
  | 'tabdata_excel_upload'
  | 'oss_presign'
  | 'oss_confirm'
  | 'tabdoc_job_create'
  | 'tabdoc_job_poll'
  | 'tabdoc_job_result'

/**
 * 只标记 Office 导入的通用网络边界。返回固定阶段名，避免把 query、文件名、
 * token 或响应正文写入生产诊断包。
 */
export function getOfficeImportRequestStage(url: string, method: string): OfficeImportRequestStage | null {
  try {
    const pathname = new URL(url).pathname.replace(/\/+$/, '')
    const normalizedMethod = method.toUpperCase()
    if (normalizedMethod === 'POST' && pathname.endsWith('/tabdata/import/excel')) {
      return 'tabdata_excel_upload'
    }
    if (normalizedMethod === 'POST' && pathname.endsWith('/services/oss/presign-upload')) {
      return 'oss_presign'
    }
    if (normalizedMethod === 'POST' && pathname.endsWith('/services/oss/confirm-upload')) {
      return 'oss_confirm'
    }
    if (normalizedMethod === 'POST' && pathname.endsWith('/tabdoc/import/jobs')) {
      return 'tabdoc_job_create'
    }
    if (normalizedMethod === 'GET' && /\/tabdoc\/import\/jobs\/[^/]+\/result$/.test(pathname)) {
      return 'tabdoc_job_result'
    }
    if (normalizedMethod === 'GET' && /\/tabdoc\/import\/jobs\/[^/]+$/.test(pathname)) {
      return 'tabdoc_job_poll'
    }
  } catch {
    // 非法 URL 由上游校验处理；诊断分类保持 fail-soft。
  }
  return null
}

function makeRequest(options: {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
  multipartEntries?: Array<{ name: string; filename?: string; contentType?: string; base64: string }>
}): Promise<any> {
  return new Promise((resolve, reject) => {
    const { url, method, headers = {}, body, multipartEntries } = options
    const urlObj = new URL(url)
    const socketTimeout = getRequestTimeoutMs(url, method)
    const absoluteTimeout = socketTimeout * ABSOLUTE_TIMEOUT_MULTIPLIER
    const importStage = getOfficeImportRequestStage(url, method)
    const requestStartedAt = Date.now()

    let settled = false
    const settleResolve = (value: any) => {
      if (settled) return
      settled = true
      clearTimeout(absoluteTimer)
      if (importStage) {
        log.info(
          `office-import request completed stage=${importStage} status=${value?.status ?? '-'} durationMs=${Date.now() - requestStartedAt}`,
        )
      }
      resolve(value)
    }
    const settleReject = (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(absoluteTimer)
      if (importStage) {
        log.warn(
          `office-import request failed stage=${importStage} durationMs=${Date.now() - requestStartedAt} error=${err.name}:${err.message}`,
        )
      }
      reject(err)
    }

    const absoluteTimer = setTimeout(() => {
      if (settled) return
      req.destroy()
      settleReject(toProxyNetworkError(Object.assign(
        new Error(`Request absolute timeout (${absoluteTimeout / 1000}s)`),
        { code: 'ETIMEDOUT' },
      )))
    }, absoluteTimeout)

      const requestHeaders: Record<string, string> = {
        'User-Agent': 'TabTin-Crawl/1.0.0',
        Accept: 'application/json',
        ...headers
      }

      let bodyBuffer: Buffer | null = null
      if (multipartEntries && multipartEntries.length > 0) {
        const multipart = buildMultipartBody(multipartEntries)
        bodyBuffer = multipart.body
        requestHeaders['Content-Type'] = multipart.contentType
        requestHeaders['Content-Length'] = String(bodyBuffer.length)
      } else {
        if (!requestHeaders['Content-Type'] && !requestHeaders['content-type']) {
          requestHeaders['Content-Type'] = 'application/json'
        }
        if (body && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT' || method.toUpperCase() === 'PATCH')) {
          bodyBuffer = Buffer.from(body, 'utf-8')
          requestHeaders['Content-Length'] = String(bodyBuffer.length)
        }
      }

      if (importStage) {
        log.info(
          `office-import request started stage=${importStage} method=${method.toUpperCase()} bytes=${bodyBuffer?.length ?? 0} timeoutMs=${socketTimeout}`,
        )
      }

      const httpModule = urlObj.protocol === 'https:' ? https : http

      const requestOptions = {
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: method.toUpperCase(),
        headers: requestHeaders
      }

      const req = httpModule.request(requestOptions, (res) => {
        const contentType = res.headers['content-type'] || ''
        const contentDisposition = String(res.headers['content-disposition'] || '')
        const isAttachmentResponse = /\battachment\b/i.test(contentDisposition)
        // application/json 即使带 Content-Disposition 也按文本/JSON 解析，
        // 避免导入模板等接口被当成二进制后错存。
        const isJsonContent = contentType.includes('application/json')
        const isBinary =
          !isJsonContent && (
            isAttachmentResponse ||
            contentType.includes('application/vnd.') ||
            contentType.includes('application/pdf') ||
            contentType.includes('application/octet-stream') ||
            contentType.includes('text/csv') ||
            contentType.includes('image/') ||
            contentType.includes('video/') ||
            contentType.includes('audio/')
          )

        res.on('error', (error) => {
          log.error(`响应流错误(${method} ${url}):`, error)
          settleReject(toProxyNetworkError(error))
        })

        if (isBinary) {
          const chunks: Buffer[] = []

          res.on('data', (chunk: Buffer) => {
            chunks.push(chunk)
          })

          res.on('end', () => {
            try {
              const buffer = Buffer.concat(chunks)

              settleResolve({
                status: res.statusCode || 500,
                statusText: res.statusMessage || 'Unknown Error',
                headers: res.headers,
                data: {
                  __isBinary: true,
                  __contentType: contentType,
                  __buffer: buffer.toString('base64'),
                  __size: buffer.length
                }
              })
            } catch (error) {
              log.error(`处理二进制响应失败(${method} ${url}):`, error)
              const errorMessage = error instanceof Error ? error.message : String(error)
              settleResolve({
                status: res.statusCode || 500,
                statusText: res.statusMessage || 'Unknown Error',
                headers: res.headers,
                data: { error: 'Binary response processing failed', details: errorMessage }
              })
            }
          })
        } else {
          let data = ''

          res.setEncoding('utf8')

          res.on('data', (chunk) => {
            data += chunk
          })

          res.on('end', () => {
            try {
              let parsedData = null
              if (data) {
                try {
                  parsedData = JSON.parse(data)
                } catch (parseError) {
                  log.warn(`解析 JSON 响应失败(${method} ${url}, HTTP ${res.statusCode})，按纯文本处理:`, parseError)
                  parsedData = data
                }
              }

              settleResolve({
                status: res.statusCode || 500,
                statusText: res.statusMessage || 'Unknown Error',
                headers: res.headers,
                data: parsedData
              })
            } catch (error) {
              log.error(`处理响应失败(${method} ${url}):`, error)
              const errorMessage = error instanceof Error ? error.message : String(error)
              settleResolve({
                status: res.statusCode || 500,
                statusText: res.statusMessage || 'Unknown Error',
                headers: res.headers,
                data: { error: 'Response processing failed', details: errorMessage }
              })
            }
          })
        }
      })

      req.on('error', (error) => {
        log.error(`网络请求错误(${method} ${url}):`, error)
        settleReject(toProxyNetworkError(error))
      })

      req.setTimeout(socketTimeout, () => {
        req.destroy()
        settleReject(toProxyNetworkError(Object.assign(new Error('Request timeout'), {
          code: 'ETIMEDOUT',
        })))
      })

      if (bodyBuffer && (method.toUpperCase() === 'POST' || method.toUpperCase() === 'PUT' || method.toUpperCase() === 'PATCH')) {
        req.write(bodyBuffer)
      }

      req.end()
  })
}
