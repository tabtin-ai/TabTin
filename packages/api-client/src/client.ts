import createClient, { type Middleware } from 'openapi-fetch'
import type { paths } from './generated/schema.js'
import { unwrapMiddleware } from './unwrap.js'
import { createRefreshMiddleware, type RefreshMiddlewareOptions } from './refresh.js'
import { createRawFetcher, type RawRequestInit } from './raw.js'
import { RefreshLock } from './refresh-lock.js'

export type ClientType = 'electron' | 'daemon' | 'web' | 'server' | 'android' | 'ios' | 'admindash'

export interface ApiClientOptions {
  baseUrl: string
  getToken?: () => string | null | Promise<string | null>
  clientType?: ClientType
  /** refresh 失败或未配置 refresh 时的 401 回退（如跳转登录页） */
  onUnauthorized?: () => void
  /** 配置后启用 401 自动 refresh + 重试 */
  refresh?: RefreshMiddlewareOptions
  fetch?: typeof globalThis.fetch
}

export function createApiClient(options: ApiClientOptions) {
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    ...(options.fetch ? { fetch: options.fetch } : {}),
  })

  const authMiddleware: Middleware = {
    async onRequest({ request }) {
      if (options.clientType) {
        request.headers.set('X-Client-Type', options.clientType)
      }
      if (options.getToken) {
        const token = await options.getToken()
        if (token) {
          request.headers.set('Authorization', `Bearer ${token}`)
        }
      }
      return request
    },
    async onResponse({ response }) {
      if (response.status === 401 && !options.refresh && options.onUnauthorized) {
        options.onUnauthorized()
      }
      return undefined
    },
  }

  client.use(authMiddleware)

  let refreshLock: RefreshLock | undefined
  if (options.refresh) {
    refreshLock = new RefreshLock(options.refresh)
    client.use(createRefreshMiddleware({
      ...options.refresh,
      onRefreshFailed: () => {
        options.refresh!.onRefreshFailed()
        options.onUnauthorized?.()
      },
    }, refreshLock))
  }

  client.use(unwrapMiddleware)

  const raw = createRawFetcher(options, refreshLock)

  return Object.assign(client, { raw })
}

export type TabTinApiClient = ReturnType<typeof createApiClient>
