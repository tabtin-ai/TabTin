/**
 * withRetry — 带指数退避 + 抖动的智能重试包装器
 *
 * 仅对 retriable 错误码重试，验证码相关错误直接返回不重试。
 */

import { ToolErrorCode, isRetriableError, type ToolError } from '../../types/errors';

export interface RetryOptions {
  maxAttempts?: number;
  baseMs?: number;
  maxBackoffMs?: number;
}

const DEFAULTS: Required<RetryOptions> = {
  maxAttempts: 3,
  baseMs: 1000,
  maxBackoffMs: 8000,
};

export async function withRetry<T extends { success: boolean; error?: ToolError }>(
  label: string,
  fn: () => Promise<T>,
  options?: RetryOptions,
): Promise<T> {
  const { maxAttempts, baseMs, maxBackoffMs } = { ...DEFAULTS, ...options };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const result = await fn();
    if (result.success || attempt >= maxAttempts) return result;

    const err = result.error;
    if (!err) return result;
    if (err.code === ToolErrorCode.CAPTCHA_REQUIRED) return result;
    if (!isRetriableError(err)) return result;

    const backoff = Math.min(baseMs * Math.pow(2, attempt - 1), maxBackoffMs);
    const jittered = Math.round(backoff * (0.5 + Math.random()));
    console.log(`[withRetry] ${label} 第 ${attempt} 次失败 (${err.code})，${jittered}ms 后重试...`);
    await new Promise((r) => setTimeout(r, jittered));
  }

  return fn();
}
