/**
 * 限流中间件 — Provider 级别本地滑动窗口，避免短时间内过多请求打爆上游。
 *
 * 实现为进程内内存计数，无 Redis；多实例部署时每实例独立配额。
 */

import { CapabilityError } from './billing.js';
import type { CapabilityMiddleware, WrapExecuteOptions } from './types.js';

export interface RateLimitOptions {
  /** 时间窗口内最大请求数，默认 10 */
  maxRequests?: number;
  /** 时间窗口大小（毫秒），默认 60_000（1 分钟） */
  windowMs?: number;
  /**
   * 限流 key；默认仅使用 capabilityId。
   * 可按需组合 userId、organizationId 等（由调用方在闭包或 extractor 中注入）。
   */
  keyExtractor?: (capabilityId: string, params: unknown) => string;
}

const DEFAULT_MAX_REQUESTS = 10;
const DEFAULT_WINDOW_MS = 60_000;

export function createRateLimitMiddleware(options?: RateLimitOptions): CapabilityMiddleware {
  const maxRequests = options?.maxRequests ?? DEFAULT_MAX_REQUESTS;
  const windowMs = options?.windowMs ?? DEFAULT_WINDOW_MS;
  const keyExtractor = options?.keyExtractor;

  /** 每个 key 在窗口内的请求时间戳（毫秒） */
  const buckets = new Map<string, number[]>();

  return {
    name: 'rate-limit',

    async wrapExecute({ doExecute, capabilityId, params }: WrapExecuteOptions) {
      const now = Date.now();
      const cutoff = now - windowMs;
      const key = keyExtractor ? keyExtractor(capabilityId, params) : capabilityId;

      const prev = buckets.get(key) ?? [];
      const inWindow = prev.filter((ts) => ts >= cutoff);

      if (inWindow.length >= maxRequests) {
        throw new CapabilityError({
          code: 'RATE_LIMITED',
          retryable: true,
          message: 'Local rate limit exceeded',
        });
      }

      inWindow.push(now);
      buckets.set(key, inWindow);

      return await doExecute();
    },
  };
}
