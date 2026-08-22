/**
 * 通用重试工具 — 指数退避 + 随机 jitter
 *
 * 用于 Django API 调用的重试（fetch snapshot / store persist 等）。
 * jitter 防止多文档网络恢复时请求同步脉冲（thundering herd）。
 */

export interface RetryOptions {
  maxRetries: number;
  baseDelay: number;
  maxDelay: number;
  label: string;
  /** jitter 幅度（0-1），默认 0.25 表示 ±25% 随机偏移 */
  jitter: number;
}

const DEFAULT_OPTIONS: RetryOptions = {
  maxRetries: 3,
  baseDelay: 500,
  maxDelay: 5000,
  label: "store",
  jitter: 0.25,
};

const NON_RETRYABLE_STATUS_CODES = new Set([403, 404, 409, 413, 422]);

/** Minimum wait when rate-limited and no Retry-After hint is available. */
const RATE_LIMIT_DEFAULT_DELAY_MS = 3000;

/**
 * 从 django-api.ts 的 fetchJSON 抛出的错误消息中提取 HTTP 状态码。
 * 格式: "Django API error {statusCode}: {body}"
 */
export function extractHttpStatusCode(errMsg: string): number | null {
  const match = errMsg.match(/\bAPI error (\d{3})\b/);
  return match ? parseInt(match[1], 10) : null;
}

/**
 * 尝试从错误消息体中解析 Retry-After 秒数（Django 可能在 JSON body 中返回）。
 * 返回毫秒数，解析失败则返回 null。
 */
function parseRetryAfterFromBody(errMsg: string): number | null {
  const match = errMsg.match(/[Rr]etry[_-]?[Aa]fter[":\s]+(\d+)/);
  if (match) {
    const seconds = parseInt(match[1], 10);
    if (seconds > 0 && seconds <= 300) return seconds * 1000;
  }
  return null;
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: Partial<RetryOptions> = {},
): Promise<T> {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  let lastError: Error | undefined;

  for (let attempt = 0; attempt <= opts.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: unknown) {
      lastError = error instanceof Error ? error : new Error(String(error));

      const errMsg = lastError.message;
      const statusCode = extractHttpStatusCode(errMsg);

      if (statusCode && NON_RETRYABLE_STATUS_CODES.has(statusCode)) {
        throw lastError;
      }

      if (attempt < opts.maxRetries) {
        let delay: number;
        if (statusCode === 429) {
          delay = parseRetryAfterFromBody(errMsg) ?? RATE_LIMIT_DEFAULT_DELAY_MS;
          console.warn(
            `[${opts.label}] Rate limited (429), waiting ${delay}ms before retry ${attempt + 1}/${opts.maxRetries + 1}`,
          );
        } else {
          const baseDelay = Math.min(
            opts.baseDelay * Math.pow(2, attempt),
            opts.maxDelay,
          );
          const jitterRange = baseDelay * opts.jitter;
          delay = baseDelay + (Math.random() * 2 - 1) * jitterRange;
          delay = Math.max(0, Math.round(delay));
          console.warn(
            `[${opts.label}] Attempt ${attempt + 1}/${opts.maxRetries + 1} failed, retrying in ${delay}ms: ${errMsg}`,
          );
        }
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }
  }

  console.error(
    `[${opts.label}] All ${opts.maxRetries + 1} attempts failed: ${lastError?.message}`,
  );
  throw lastError;
}
