/**
 * Service 基础设施
 *
 * 提供 authenticatedRequest — 自动附加 Auth header 的请求方法。
 * 所有 service 文件共用，避免重复 getAuthHeaders 样板。
 */

import { getRuntime } from '../runtime.js'

/**
 * 把后端信封 `{ code, message }` 拼进 Error.message。
 *
 * 前端冲突检测（如 WORKING_DIR_CONFLICT）靠 message 子串匹配；
 * 只抛 message 文案时，若文案被改写/翻译，检测会失效并退化成泛化「创建失败」。
 */
export function formatApiErrorMessage(
  data: { code?: unknown; message?: unknown } | null | undefined,
  fallback: string,
): string {
  const code = typeof data?.code === 'string' ? data.code.trim() : ''
  const message = typeof data?.message === 'string' ? data.message.trim() : ''
  if (code && message) return `${code}: ${message}`
  if (message) return message
  if (code) return code
  return fallback
}

export async function authenticatedRequest(options: {
  url: string
  method: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH'
  headers?: Record<string, string>
  body?: string
}): Promise<{ status: number; data: any; headers?: Record<string, string> }> {
  const { transport, auth } = getRuntime()
  const token = await auth.getToken()
  const headers: Record<string, string> = { ...options.headers }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  return transport({ ...options, headers })
}

export function apiBaseUrl(): string {
  return getRuntime().apiBaseUrl
}

/**
 * 取当前登录态 token（无登录返回 null）。
 *
 * 使用场景：极少数 service 需要绕过 `authenticatedRequest` 的统一封装
 * 直接发原生 fetch（如需要 AbortSignal、SSE、stream 等高级特性）时
 * 自行拼 Authorization header 用。
 */
export async function getAuthToken(): Promise<string | null> {
  return getRuntime().auth.getToken()
}
