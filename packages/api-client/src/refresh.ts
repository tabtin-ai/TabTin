import type { Middleware } from 'openapi-fetch'
import {
  RefreshLock,
  isRefreshTemporarilyUnavailableError,
  type RefreshConfig,
} from './refresh-lock.js'

export interface RefreshMiddlewareOptions extends RefreshConfig {
  onRefreshFailed: () => void
}

/**
 * 401 自动刷新 Token 中间件。
 *
 * 检测 401 响应 → 通过 RefreshLock 获取新 token → 用新 token 重试原始请求。
 * 如果刷新失败则调用 onRefreshFailed。
 *
 * 当传入外部 lock 时，与 raw() 共享同一个 refresh 锁，
 * 避免并发 401 时重复调用 onRefreshToken。
 */
export function createRefreshMiddleware(
  options: RefreshMiddlewareOptions,
  lock?: RefreshLock,
): Middleware {
  const refreshLock = lock ?? new RefreshLock(options)

  return {
    async onResponse({ request, response, options: reqOptions }) {
      if (response.status !== 401) return undefined

      try {
        const newToken = await refreshLock.acquire()

        if (!newToken) {
          options.onRefreshFailed()
          return undefined
        }

        const retryReq = request.clone()
        retryReq.headers.set('Authorization', `Bearer ${newToken}`)
        const doFetch = reqOptions.fetch ?? globalThis.fetch
        const retryResponse = await doFetch(retryReq)
        if (retryResponse.status === 401) {
          options.onRefreshFailed()
        }
        return retryResponse
      } catch (error) {
        if (isRefreshTemporarilyUnavailableError(error)) {
          return undefined
        }
        options.onRefreshFailed()
        return undefined
      }
    },
  }
}
