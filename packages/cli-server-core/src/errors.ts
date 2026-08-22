/**
 * CLI Server 错误码体系 + 响应构造器。
 *
 * Electron CLI Server 和 Daemon CLI Server 共用。
 *
 * 错误码来源：
 * 1. 通用码 — 从 @tabtin/agent-wire 的 ERROR_CODES 权威列表 re-export，
 *    保证 IPC / CLI / HTTP 三端名称完全一致。
 * 2. CLI 专有码 — 只在 CLI Server 上下文有意义的错误码，不需要三端同步。
 *
 * 历史对齐（contract W7 收尾）：
 *   RATE_LIMITED      → RATE_LIMIT_EXCEEDED  （ERROR_CODES 标准名）
 *   BACKEND_ERROR     → UNAVAILABLE          （ERROR_CODES 标准名）
 *   AUTH_MISSING       → UNAUTHORIZED         （ERROR_CODES 标准名）
 */

import type http from 'node:http'
import {
  errResponse as wireErrResponse,
  okResponse,
  type ErrorCode as WireErrorCode,
} from '@tabtin/agent-wire'

/**
 * CLI Server 专有错误码 — 仅在 CLI Server 场景下使用，不三端同步。
 */
export type CliServerOnlyCode =
  | 'CONNECTION_REFUSED'
  | 'CONNECTION_TIMEOUT'
  | 'TASK_FAILED'
  | 'TASK_TIMEOUT'
  | 'UNKNOWN_ROUTE'
  | 'POLICY_BLOCKED'
  | 'POLICY_CONFIRM_REQUIRED'

/**
 * CLI Server 完整错误码联合 = 通用码（@tabtin/agent-wire）+ CLI 专有码。
 */
export type ErrorCode = WireErrorCode | CliServerOnlyCode

export type SendJSON = (res: http.ServerResponse, status: number, data: any) => void

export interface DjangoProxyResult {
  status: number
  data: any
}

export interface DjangoRequestOptions {
  logTag?: string
  timeout?: number
  /**
   * 透传给 Django 的额外请求头（白名单语义由调用方控制）。
   * Electron / Daemon 两端 djangoRequest 实现都把它合并进出站 headers，
   * 用于如 Agent run/session 上下文头、表单 `X-Form-Password` 等场景。
   */
  extraHeaders?: Record<string, string>
}

export type DjangoRequestFn = (
  method: string,
  path: string,
  body?: unknown,
  opts?: DjangoRequestOptions,
) => Promise<DjangoProxyResult>

const RETRYABLE_CODES = new Set<string>([
  'CONNECTION_REFUSED', 'CONNECTION_TIMEOUT', 'RATE_LIMIT_EXCEEDED',
  'UNAVAILABLE', 'TASK_TIMEOUT',
])

export const COMMON_SUGGESTIONS: Partial<Record<string, string[]>> = {
  CONNECTION_REFUSED: ['请确保 Django 后端服务正在运行', '运行 tabtin doctor 进行环境诊断'],
  CONNECTION_TIMEOUT: ['后端响应超时，请稍后重试', '如果频繁超时，请检查后端服务状态'],
  UNAUTHORIZED: ['确保在 TabTin 内置终端中运行命令'],
  PERMISSION_DENIED: ['当前账号没有访问该资源的权限'],
  VALIDATION_ERROR: ['请检查参数是否正确', '使用 --help 查看命令用法'],
  NOT_IMPLEMENTED: ['该功能在当前模式下尚未实现'],
  RATE_LIMIT_EXCEEDED: ['请求过于频繁，请稍等片刻后重试'],
  UNAVAILABLE: ['后端服务暂时不可用，请稍后重试'],
}

export function isRetryable(code: string): boolean {
  return RETRYABLE_CODES.has(code)
}

/**
 * Build a standard error response envelope.
 *
 * Delegates to @tabtin/agent-wire for the wire format,
 * adds retryable flag and suggestions based on error code.
 */
export function errorResponse(
  code: ErrorCode | string,
  message: string,
  opts?: { retryable?: boolean; detail?: any; suggestions?: string[] },
) {
  const retryable = opts?.retryable ?? isRetryable(code)
  const suggestions = opts?.suggestions ?? COMMON_SUGGESTIONS[code] ?? []
  const envelope = wireErrResponse(code, message, { retryable, suggestions })
  if (opts?.detail) {
    (envelope.error as any).detail = opts.detail
  }
  return envelope
}

/**
 * Wrap a Django proxy result into the unified CLI envelope.
 *
 * Django responses often have `{ success: true, data: { ... } }` shape.
 * This helper unwraps the inner `data` to avoid double-nesting.
 */
export function sendDjangoResult(
  res: http.ServerResponse,
  sendJSONFn: SendJSON,
  result: DjangoProxyResult,
): void {
  if (result.status >= 400) {
    sendJSONFn(res, result.status, result.data)
    return
  }

  if (result.status === 204) {
    res.writeHead(204)
    res.end()
    return
  }

  const payload = result.data?.data ?? result.data
  const statusToSend = result.status === 207 ? 207 : 200
  sendJSONFn(res, statusToSend, okResponse(payload))
}
