/**
 * 错误 helper —— 把 unknown 转成可读 message。
 */

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
