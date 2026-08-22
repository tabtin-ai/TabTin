/**
 * Shared error handling utilities for Electron CLI route handlers.
 *
 * Uses @tabtin/cli-server-core for common error types and response builders.
 * The Django proxy uses Electron's TokenManager for JWT authentication
 * with automatic token refresh on 401.
 */

import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'
import { TokenManager } from '../../../auth'
import { API_BASE_URL } from '../../../config/api'
import { joinApiPath } from '@tabtin/config'
import { getAgentRequestContextHeaders } from '../../agent-request-context'
import {
  type ErrorCode as CoreErrorCode,
  type SendJSON,
  type DjangoProxyResult,
  decodeDjangoProxyBody,
  errorResponse as coreErrorResponse,
} from '@tabtin/cli-server-core'
import { createLogger } from '../../../logger'

const log = createLogger('CLIProxy')

export type ErrorCode =
  | CoreErrorCode
  | 'TAB_REQUIRED'
  | 'VIEW_GETTER_MISSING'
  | 'VIEW_NOT_FOUND'
  /** ：tab 已登记但网页进程尚未挂载（webview 后台挂载在途），可稍后重试 */
  | 'VIEW_NOT_READY'
  | 'RESOURCE_NOT_FOUND'
  | 'PROBE_FAILED'
  | 'NO_MEDIA_FOUND'
  | 'CAPTURE_FAILED'
  | 'DOWNLOAD_FAILED'
  | 'PDF_GENERATION_FAILED'
  | 'TAB_OR_URL_REQUIRED'
  | 'MARKDOWN_CONVERSION_FAILED'
  | 'PATCH_FAILED'
  | 'DIST_NOT_FOUND'
  | 'EMPTY_DIST'
  | 'UPLOAD_FAILED'
  | 'NAVIGATION_FAILED'
  | 'UNVERIFIED_NAVIGATION_URL'
  | 'NEEDS_APPROVAL'
  | 'COPY_FAILED'
  | 'SESSION_EXPIRED'
  | 'MISSING_PARAM'
  | 'PATH_FORBIDDEN'
  | 'FILE_NOT_FOUND'
  | 'SYMLINK_FORBIDDEN'
  | 'NOT_A_FILE'
  | 'FILE_TOO_LARGE'
  | 'UPLOAD_ERROR'
  | 'UNKNOWN_ROUTE'

export type { SendJSON, DjangoProxyResult }

const ELECTRON_SUGGESTIONS: Partial<Record<string, string[]>> = {
  UNAUTHORIZED: ['请先登录 TabTin 应用', '确保在 TabTin 内置终端中运行命令'],
  AUTH_EXPIRED: ['登录已过期，请重新打开 TabTin 应用', '应用会自动刷新登录状态'],
  PERMISSION_DENIED: ['当前账号没有访问该资源的权限', '请确认你拥有对应组织或 Space 的访问权限'],
  QUOTA_EXCEEDED: ['配额已用尽，请在 TabTin 设置中查看详情'],
  RATE_LIMIT_EXCEEDED: ['请求过于频繁，请稍等片刻后重试'],
}

export function errorResponse(
  code: ErrorCode,
  message: string,
  opts?: { retryable?: boolean; detail?: any; suggestions?: string[] },
) {
  const suggestions = opts?.suggestions ?? ELECTRON_SUGGESTIONS[code]
  return coreErrorResponse(code, message, { ...opts, suggestions })
}

// ── Django HTTP proxy ────────────────────────────────────────────

const DEFAULT_TIMEOUT = 30_000
const ABSOLUTE_TIMEOUT_MULTIPLIER = 3

let refreshAccessTokenPromise: Promise<string> | null = null
let lastRefreshedToken: string | null = null
let lastRefreshedAt = 0
const REFRESH_RESULT_TTL_MS = 10_000

export function resolveOrganizationIdFromUserInfo(userInfo: any): string | null {
  if (!userInfo || typeof userInfo !== 'object') return null
  const candidate =
    userInfo.organization_id ??
    userInfo.organizationId ??
    userInfo.default_organization_id ??
    userInfo.defaultOrganizationId ??
    userInfo.current_organization_id ??
    userInfo.currentOrganizationId ??
    null
  return candidate ? String(candidate) : null
}

async function refreshAccessTokenShared(): Promise<string> {
  if (lastRefreshedToken && Date.now() - lastRefreshedAt < REFRESH_RESULT_TTL_MS) {
    return lastRefreshedToken
  }
  if (refreshAccessTokenPromise) {
    return refreshAccessTokenPromise
  }
  refreshAccessTokenPromise = (async () => {
    try {
      const token = await TokenManager.refreshAccessToken()
      lastRefreshedToken = token
      lastRefreshedAt = Date.now()
      return token
    } catch (err) {
      lastRefreshedToken = null
      lastRefreshedAt = 0
      throw err
    } finally {
      refreshAccessTokenPromise = null
    }
  })()
  return refreshAccessTokenPromise
}

export async function djangoRequest(
  method: string,
  path: string,
  body?: any,
  opts?: { logTag?: string; timeout?: number; extraHeaders?: Record<string, string> },
): Promise<DjangoProxyResult> {
  const logTag = opts?.logTag ?? '[CLI]'
  const timeout = opts?.timeout ?? DEFAULT_TIMEOUT

  let accessToken = await TokenManager.getAccessToken()
  if (!accessToken) {
    return {
      status: 401,
      data: errorResponse('UNAUTHORIZED', '未登录，请先登录 TabTin'),
    }
  }
  const userInfo = await TokenManager.getUserInfo()
  const organizationId =
    process.env.TABTIN_ORGANIZATION_ID ||
    resolveOrganizationIdFromUserInfo(userInfo) ||
    ''

  const fullUrl = joinApiPath(API_BASE_URL, path)
  const url = new URL(fullUrl)
  const isHttps = url.protocol === 'https:'
  const transport = isHttps ? https : http
  const bodyStr = body ? JSON.stringify(body) : undefined

  const performRequest = async (token: string): Promise<DjangoProxyResult> => {
    const absoluteTimeout = timeout * ABSOLUTE_TIMEOUT_MULTIPLIER

    return new Promise((resolve) => {
      let settled = false
      const settle = (value: DjangoProxyResult) => {
        if (settled) return
        settled = true
        clearTimeout(absoluteTimer)
        resolve(value)
      }

      const absoluteTimer = setTimeout(() => {
        if (settled) return
        req.destroy()
        settle({
          status: 504,
          data: errorResponse('CONNECTION_TIMEOUT', `后端请求绝对超时 (${absoluteTimeout / 1000}s): ${method} ${path}`, {
            detail: { method, path, timeout_ms: absoluteTimeout, type: 'absolute' },
          }),
        })
      }, absoluteTimeout)

      const req = transport.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method,
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${token}`,
            ...(organizationId ? { 'X-Organization-Id': organizationId } : {}),
            // TD-1/H-2：透传 CLI 带来的 Agent run/session 上下文头给 Django。
            ...(opts?.extraHeaders ?? {}),
            // Table and browser-to-table routes establish this request-scoped
            // context at the Electron CLI boundary. Trusted context headers
            // win over route-provided values and cannot be supplied in body data.
            ...getAgentRequestContextHeaders(),
            ...(bodyStr ? { 'Content-Length': Buffer.byteLength(bodyStr) } : {}),
          },
          timeout,
        },
        (res) => {
          const chunks: Buffer[] = []
          res.on('data', (chunk: Buffer) => chunks.push(chunk))
          res.on('error', (err) => {
            log.error(`${logTag} 响应流传输错误 (${method} ${path}):`, err.message)
            settle({
              status: 502,
              data: errorResponse('UNAVAILABLE', `响应流传输失败: ${err.message}`, {
                detail: { system_error: (err as NodeJS.ErrnoException).code, path },
              }),
            })
          })
          res.on('end', () => {
            // : 按 Content-Type 解码；xlsx/pdf 等走 __binary+base64，
            // 禁止 Buffer.toString('utf-8') 污染二进制（U+FFFD / ef bf bd）。
            const contentType = res.headers['content-type'] || ''
            const raw = Buffer.concat(chunks)
            settle({
              status: res.statusCode ?? 500,
              data: decodeDjangoProxyBody(contentType, raw),
            })
          })
        },
      )

      req.on('timeout', () => {
        req.destroy()
        settle({
          status: 504,
          data: errorResponse('CONNECTION_TIMEOUT', `后端请求超时 (${timeout / 1000}s): ${method} ${path}`, {
            detail: { method, path, timeout_ms: timeout },
          }),
        })
      })

      req.on('error', (err) => {
        log.error(`${logTag} Django 请求错误 (${method} ${path}):`, err.message)
        const errCode = (err as NodeJS.ErrnoException).code
        if (errCode === 'ECONNREFUSED') {
          settle({
            status: 502,
            data: errorResponse('CONNECTION_REFUSED', '无法连接到 Django 后端，请确保后端服务正在运行', {
              detail: { system_error: errCode, path },
            }),
          })
        } else {
          settle({
            status: 502,
            data: errorResponse('UNAVAILABLE', `后端连接失败: ${err.message}`, {
              detail: { system_error: errCode, path },
            }),
          })
        }
      })

      if (bodyStr) req.write(bodyStr)
      req.end()
    })
  }

  const originalToken = accessToken
  let result = await performRequest(accessToken)
  if (result.status !== 401) {
    return result
  }

  const latestToken = await TokenManager.getAccessToken()
  if (latestToken && latestToken !== originalToken) {
    accessToken = latestToken
  } else {
    try {
      accessToken = await refreshAccessTokenShared()
    } catch (error) {
      const message = error instanceof Error ? error.message : '登录已过期，请重新登录'
      return {
        status: 401,
        data: errorResponse('AUTH_EXPIRED', message, {
          detail: { method, path },
        }),
      }
    }
  }

  result = await performRequest(accessToken)
  if (result.status === 401) {
    return {
      status: 401,
      data: errorResponse('AUTH_EXPIRED', '登录已过期，请重新登录', {
        detail: { method, path },
      }),
    }
  }

  return result
}
