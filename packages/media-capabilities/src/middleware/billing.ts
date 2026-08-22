/**
 * 计费中间件 — 在能力执行前做可选额度预检，避免明显无余额时仍发起下游请求。
 *
 * 实际扣费与硬拦截由 Django（如 BillingGuard / 各服务 API）完成；本层仅作「软预检」。
 */

import type { CapabilityMiddleware, WrapExecuteOptions } from './types.js';

/** 默认预检路径；后端若未挂载该路由，预检收到 404 时会放行（避免误杀旧环境）。 */
export const DEFAULT_BILLING_CHECK_PATH = '/api/services/billing/check/';

export interface BillingMiddlewareOptions {
  /**
   * 是否在执行能力前调用 Django 预检接口。
   * @default true
   */
  checkQuota?: boolean;
  /**
   * 额度预检的完整路径（须含 `/api/...` 前缀，与 `ctx.djangoRequest` 其它调用一致）。
   * @default {@link DEFAULT_BILLING_CHECK_PATH}
   */
  checkQuotaPath?: string;
}

/** 能力层统一错误 — 供中间件与消费者识别 `code` / `retryable`。 */
export class CapabilityError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(opts: { code: string; retryable: boolean; message?: string }) {
    super(opts.message ?? opts.code);
    this.name = 'CapabilityError';
    this.code = opts.code;
    this.retryable = opts.retryable;
  }
}

function buildCheckUrl(path: string, capabilityId: string): string {
  const sep = path.includes('?') ? '&' : '?';
  return `${path}${sep}capability=${encodeURIComponent(capabilityId)}`;
}

/** 响应体是否明确表示「不允许继续」（兼容多种 JSON 形状）。 */
function isExplicitlyDenied(data: unknown): boolean {
  if (!data || typeof data !== 'object') return false;
  const o = data as Record<string, unknown>;
  if (o.allowed === false || o.ok === false) return true;
  if (o.success === false) return true;
  const err = o.error;
  if (err && typeof err === 'object') {
    const e = err as Record<string, unknown>;
    if (e.code === 'QUOTA_EXCEEDED' || e.code === 'BILLING_BLOCKED') return true;
  }
  const nested = o.data;
  if (nested && typeof nested === 'object') {
    const d = nested as Record<string, unknown>;
    if (d.allowed === false || d.ok === false) return true;
  }
  return false;
}

async function preCheckQuota(
  opts: WrapExecuteOptions,
  checkPath: string,
): Promise<void> {
  const { capabilityId, ctx } = opts;

  const url = buildCheckUrl(checkPath, capabilityId);
  const res = await ctx.djangoRequest<unknown>('GET', url);

  if (res.status === 404) {
    // 后端尚未提供预检路由时不阻断能力调用
    return;
  }

  if (res.status === 402 || res.status === 403 || res.status === 429) {
    throw new CapabilityError({
      code: 'QUOTA_EXCEEDED',
      retryable: false,
      message: `Billing pre-check rejected (HTTP ${res.status})`,
    });
  }

  if (res.status < 200 || res.status >= 300) {
    throw new CapabilityError({
      code: 'BILLING_CHECK_FAILED',
      retryable: res.status >= 500,
      message: `Billing pre-check failed with HTTP ${res.status}`,
    });
  }

  if (isExplicitlyDenied(res.data)) {
    throw new CapabilityError({
      code: 'QUOTA_EXCEEDED',
      retryable: false,
      message: 'Quota exceeded or billing blocked (pre-check)',
    });
  }
}

export function createBillingMiddleware(options?: BillingMiddlewareOptions): CapabilityMiddleware {
  const checkQuota = options?.checkQuota ?? true;
  const checkQuotaPath = options?.checkQuotaPath ?? DEFAULT_BILLING_CHECK_PATH;

  return {
    name: 'billing',

    async wrapExecute(wrapOpts: WrapExecuteOptions) {
      const { doExecute } = wrapOpts;

      if (checkQuota) {
        await preCheckQuota(wrapOpts, checkQuotaPath);
      }

      // 扣费与用量记账在 Django 业务 API 内完成，中间件不再发扣费请求
      return await doExecute();
    },
  };
}
