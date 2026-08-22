/**
 * 路由层统一错误响应构建器。
 *
 * 与 Daemon/Electron 各自 shared/error-handler.ts 中的 errorResponse 保持相同结构，
 * 但不包含宿主特定的 SUGGESTIONS 映射——由路由 handler 显式传入 suggestions。
 */

const RETRYABLE_CODES = new Set([
  'CONNECTION_REFUSED',
  'CONNECTION_TIMEOUT',
  'RATE_LIMITED',
  'BACKEND_ERROR',
  'TASK_TIMEOUT',
]);

export function errorResponse(
  code: string,
  message: string,
  opts?: { retryable?: boolean; detail?: unknown; suggestions?: string[] },
) {
  const retryable = opts?.retryable ?? RETRYABLE_CODES.has(code);
  const suggestions = opts?.suggestions ?? [];
  return {
    success: false as const,
    error: {
      code,
      message,
      retryable,
      suggestions,
      ...(opts?.detail ? { detail: opts.detail } : {}),
    },
  };
}
