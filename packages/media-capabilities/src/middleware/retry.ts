/**
 * 重试中间件 — 对可重试错误执行指数退避重试。
 *
 * 可重试错误：
 * - 网络超时（ETIMEDOUT / ECONNRESET / fetch AbortError）
 * - HTTP 5xx 服务端错误
 * - HTTP 429 限流
 *
 * 非可重试错误直接抛出，不消耗重试次数。
 */

import type { CapabilityMiddleware, WrapExecuteOptions } from './types.js';

export interface RetryOptions {
  /** 最大重试次数（默认 3） */
  maxRetries?: number;
  /** 初始退避时间（毫秒，默认 1000） */
  initialDelayMs?: number;
  /** 退避倍数（默认 2） */
  backoffMultiplier?: number;
}

const DEFAULT_MAX_RETRIES = 3;
const DEFAULT_INITIAL_DELAY_MS = 1000;
const DEFAULT_BACKOFF_MULTIPLIER = 2;

function isRetryableError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const error = err as Record<string, unknown>;

  const code = typeof error.code === 'string' ? error.code : '';
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code)) {
    return true;
  }

  if (error.name === 'AbortError' || error.name === 'TimeoutError') {
    return true;
  }

  const status = typeof error.status === 'number' ? error.status : 0;
  if (status === 429 || (status >= 500 && status < 600)) {
    return true;
  }

  const statusCode = typeof error.statusCode === 'number' ? error.statusCode : 0;
  if (statusCode === 429 || (statusCode >= 500 && statusCode < 600)) {
    return true;
  }

  const message = typeof error.message === 'string' ? error.message.toLowerCase() : '';
  if (message.includes('timeout') || message.includes('econnreset') || message.includes('rate limit')) {
    return true;
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createRetryMiddleware(options?: RetryOptions): CapabilityMiddleware {
  const maxRetries = options?.maxRetries ?? DEFAULT_MAX_RETRIES;
  const initialDelay = options?.initialDelayMs ?? DEFAULT_INITIAL_DELAY_MS;
  const multiplier = options?.backoffMultiplier ?? DEFAULT_BACKOFF_MULTIPLIER;

  return {
    name: 'retry',

    async wrapExecute({ doExecute, ctx }: WrapExecuteOptions) {
      let lastError: unknown;

      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        try {
          return await doExecute();
        } catch (err: unknown) {
          lastError = err;

          if (!isRetryableError(err) || attempt === maxRetries) {
            throw err;
          }

          if (ctx.signal?.aborted) {
            throw err;
          }

          const delayMs = initialDelay * Math.pow(multiplier, attempt);
          await sleep(delayMs);
        }
      }

      throw lastError;
    },
  };
}
