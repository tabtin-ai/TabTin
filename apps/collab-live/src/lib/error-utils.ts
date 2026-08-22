/**
 * 错误处理工具 — 安全提取错误消息
 */

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
