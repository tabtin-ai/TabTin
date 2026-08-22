/**
 * 适配器共享运行时辅助（无平台业务逻辑）。
 * 新平台优先复用这里，避免每个适配器复制 capture / 轮询样板。
 */
import type { RunContext } from '../adapter'

export const DEFAULT_CAPTURE_TIMEOUT_MS = 8000
export const DEFAULT_STATE_POLL_MAX = 12
export const DEFAULT_STATE_POLL_INTERVAL_MS = 400

export function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** 拦截 URL 命中 pattern 且有响应体的请求，返回其 body。 */
export async function captureJson(
  ctx: RunContext,
  tabId: string,
  pattern: string,
  timeoutMs = DEFAULT_CAPTURE_TIMEOUT_MS,
  opts?: { preferUrlIncludes?: string; bodyIncludes?: string },
): Promise<string | undefined> {
  const entries = await ctx.browser.captureNetwork({
    tabId,
    urlPattern: pattern,
    timeoutMs,
    ...(opts?.bodyIncludes ? { bodyIncludes: opts.bodyIncludes } : {}),
  })
  const hits = entries.filter(
    (e) =>
      e.responseBody &&
      e.url.includes(pattern) &&
      (!opts?.bodyIncludes || e.responseBody.includes(opts.bodyIncludes)),
  )
  if (hits.length === 0) return undefined
  const preferred = opts?.preferUrlIncludes
    ? hits.find((e) => e.url.includes(opts.preferUrlIncludes!))
    : undefined
  return (preferred ?? hits[0])?.responseBody
}

/**
 * 短轮询 eval，直到拿到非 null / 非空字符串结果或超时。
 * 用于 SSR `__INITIAL_STATE__` / `__NEXT_DATA__` 等晚于 open 返回的页面状态。
 */
export async function pollEval(
  ctx: RunContext,
  tabId: string,
  expression: string,
  opts: { max?: number; intervalMs?: number } = {},
): Promise<unknown> {
  const max = opts.max ?? DEFAULT_STATE_POLL_MAX
  const intervalMs = opts.intervalMs ?? DEFAULT_STATE_POLL_INTERVAL_MS
  let last: unknown = null
  for (let i = 0; i < max; i++) {
    last = await ctx.browser.eval({ tabId, expression })
    if (last !== null && last !== undefined && last !== false && last !== '') {
      return last
    }
    await delay(intervalMs)
  }
  return last
}
