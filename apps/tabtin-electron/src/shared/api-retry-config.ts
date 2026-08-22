/**
 * API 请求重试配置
 *
 * 用于配置 API 请求失败时的重试策略。
 *
 * 注意：429（Too Many Requests）不在 retryableStatuses 中。
 * 429 由 api-proxy 单独处理(方法感知 + 指数退避 + jitter,详见
 * `docs/api/rate-limit-protocol.md` §3),盲重试只会放大请求量、加剧限流。
 *
 * 协议 §3.4 — 幂等方法默认重试 3 次,非幂等(POST)默认只重试 1 次。
 * 这两个常量是「数字依据」的载体:任何修改必须同步更新协议文档与
 * 总控 §1 决策记录。
 */

export interface RetryConfig {
  /** 最大重试次数 */
  maxRetries: number
  /** 初始重试延迟（毫秒） */
  retryDelay: number
  /** 退避倍数（指数退避） */
  retryBackoff: number
  /** 可重试的 HTTP 状态码（不包含 429，429 由专门逻辑处理） */
  retryableStatuses: number[]
}

/**
 * 默认重试配置
 *
 * - 最多重试 3 次
 * - 初始延迟 1 秒
 * - 指数退避：1s → 2s → 4s
 * - 可重试的状态码：408（请求超时）、502/503/504（网关/服务不可用）
 */
export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  retryDelay: 1000,
  retryBackoff: 2,
  retryableStatuses: [408, 502, 503, 504]
}

/**
 * 预设重试策略
 */
export const RETRY_PRESETS = {
  /** 无重试 */
  NONE: {
    maxRetries: 0,
    retryDelay: 0,
    retryBackoff: 1,
    retryableStatuses: []
  } as RetryConfig,

  /** 快速重试（适用于轻量接口） */
  FAST: {
    maxRetries: 2,
    retryDelay: 500,
    retryBackoff: 2,
    retryableStatuses: [408, 502, 503, 504]
  } as RetryConfig,

  /** 标准重试（默认） */
  STANDARD: DEFAULT_RETRY_CONFIG,

  /** 持久重试（适用于关键接口） */
  PERSISTENT: {
    maxRetries: 5,
    retryDelay: 2000,
    retryBackoff: 2,
    retryableStatuses: [408, 502, 503, 504]
  } as RetryConfig,

  /** 仅重试服务器错误 */
  SERVER_ERRORS_ONLY: {
    maxRetries: 3,
    retryDelay: 1000,
    retryBackoff: 2,
    retryableStatuses: [502, 503, 504]
  } as RetryConfig
} as const

const NETWORK_ERROR_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'ENETUNREACH',
  'EHOSTUNREACH',
])

/**
 * 判断错误是否应该重试
 */
export function shouldRetryError(
  error: any,
  statusCode?: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG,
): boolean {
  if (error && NETWORK_ERROR_CODES.has(error.code)) {
    return true
  }
  if (statusCode && config.retryableStatuses.includes(statusCode)) {
    return true
  }
  return false
}

/**
 * 计算重试延迟（指数退避）
 */
export function calculateRetryDelay(
  attempt: number,
  config: RetryConfig = DEFAULT_RETRY_CONFIG
): number {
  return config.retryDelay * Math.pow(config.retryBackoff, attempt)
}

const MAX_429_RETRY_DELAY_MS = 10_000

/**
 * 协议 §3.2 推荐的幂等方法 max_retries=3。
 * 数字依据:`docs/api/rate-limit-protocol.md` §3.2 退避算法示例。
 */
export const IDEMPOTENT_429_MAX_RETRIES = 3

/**
 * 协议 §3.4 — 非幂等 POST 默认重试 1 次,与 Electron 主进程历史行为一致,
 * 防止重试造成"创建资源 / 发送通知 / 扣费"等副作用重复执行。
 */
export const NON_IDEMPOTENT_429_MAX_RETRIES = 1

/**
 * 协议 §3.4 — 限流后是否允许多次重试取决于 HTTP 方法是否幂等。
 * GET/PUT/PATCH/DELETE/HEAD/OPTIONS:幂等 → max_retries=3。
 * POST:非幂等(创建资源 / 发通知 / 扣费等可能产生副作用)→ max_retries=1。
 */
export function get429MaxRetriesForMethod(method: string): number {
  const m = method.toUpperCase()
  if (m === 'POST') return NON_IDEMPOTENT_429_MAX_RETRIES
  return IDEMPOTENT_429_MAX_RETRIES
}

/**
 * 协议 §3.2 — 指数退避 + ±20% jitter,避免雷击群效应。
 * attempt 从 0 开始;第 0 次重试用 baseSeconds 秒。返回毫秒。
 *
 * 注意:测试时若需确定性,应在调用方注入 random;此处保持简单实现。
 */
export function compute429BackoffMs(
  attempt: number,
  baseSeconds: number,
  randomFn: () => number = Math.random,
): number {
  const baseMs = Math.max(1, baseSeconds) * 1000
  const expDelay = baseMs * Math.pow(2, attempt)
  const jitterRatio = 0.2
  const jitter = expDelay * jitterRatio * (randomFn() * 2 - 1)
  return Math.max(1000, expDelay + jitter)
}

/**
 * 协议 §3.4 — `retry_after_seconds > 60` 时不应自动重试,要让用户感知。
 * 此处转换为毫秒上限 `MAX_429_RETRY_DELAY_MS = 10_000`(10s),与历史行为一致;
 * 上限内的退避才会真正 sleep。
 */
export function resolve429RetryAfterMs(
  retryAfterSeconds: number,
  computedBackoffMs: number,
): number {
  if (!Number.isFinite(retryAfterSeconds) || retryAfterSeconds < 1) return 0
  // 协议 §3.4:超过 60s 让用户感知,不悄悄等
  if (retryAfterSeconds > 60) return 0
  // 实际退避取计算值,但不超过 ceiling
  const capped = Math.min(computedBackoffMs, MAX_429_RETRY_DELAY_MS)
  return capped > 0 ? capped : 0
}

/**
 * 协议 §3.1 — 客户端读取 retry_after_seconds 优先级:
 * 1. body.retry_after_seconds(精度最高,直接来自 Redis TTL)
 * 2. Retry-After header(若 body 解析失败/非 JSON)
 * 3. null(由调用者决定 fallback,**不在此处写死客户端默认值**)
 *
 * 仅认正整数 ≥ 1;0 / 负数视为缺失,避免雷击群效应。
 */
export function extractRetryAfterFromProxyResult(result: {
  data?: unknown
  headers?: Record<string, unknown>
}): number | null {
  // 路径 1:body.retry_after_seconds
  if (result?.data && typeof result.data === 'object') {
    const bodySeconds = (result.data as Record<string, unknown>).retry_after_seconds
    if (typeof bodySeconds === 'number' && Number.isInteger(bodySeconds) && bodySeconds >= 1) {
      return bodySeconds
    }
  }
  // 路径 2:Retry-After header
  const headerVal = result?.headers?.['retry-after']
  if (headerVal != null) {
    const parsed = parseInt(String(headerVal), 10)
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed
    }
  }
  return null
}

/**
 * @deprecated 仅保留以备过渡期 fallback;新代码请使用
 * `resolve429RetryAfterMs` + 协议 §3 完整决策树。
 *
 * 解析 429 响应的 Retry-After 延迟（毫秒）。
 * 返回 0 表示不应重试（Retry-After 太长或缺失且不愿盲猜）。
 */
export function get429RetryDelay(
  retryAfterHeader?: string | null,
  fallbackMs = 2000,
): number {
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10)
    if (Number.isFinite(seconds) && seconds > 0) {
      const ms = seconds * 1000
      return ms <= MAX_429_RETRY_DELAY_MS ? ms : 0
    }
  }
  return fallbackMs
}
