/**
 * Renderer-side dedup + short TTL cache for `auth:getAccessToken`.
 *
 * 背景（IPC Inspector 实测）：renderer 内 6+ 处独立 caller（api.ts /
 * oss-direct-uploader / errorReporter / tabtin-client /
 * DataBrowser）在启动短窗口内并发拿 token，同一秒触发 5+ 次
 * `auth:getAccessToken` IPC，每次 ~50-200ms roundtrip 完全是无谓重复。
 *
 * 设计原则：
 *   1. **In-flight Promise dedup** — 同一时刻只有一个 IPC 在飞，所有同时调
 *      用方共享同一个 Promise。
 *   2. **短 TTL 缓存（500ms）** — 完成后的最近 token 在 500ms 内复用。这
 *      个值远小于 token 自然刷新周期（小时级），故不会让 caller 看到 stale
 *      token；又足以覆盖应用启动时多个组件 useEffect 同步触发的 burst。
 *   3. **失效信号订阅** — 监听 main 端广播的 `auth:token-refreshed-signal`
 *      和 `auth:force-logout`，立即清掉本地缓存，防止 refresh 后 caller 拿
 *      到过期 token。
 *
 * 修复前 5×（IPC Inspector 12:01:35.545s 实测）→ 修复后 1× per burst。
 *
 * 兜底：极端场景下 caller 拿到的 token 在 500ms 内被 server 端 invalidate，
 * 也只会触发一次 401，业务调用链已有 401 → refreshAccessToken 路径，
 * refresh 成功会广播 `auth:token-refreshed-signal` 失效本缓存。
 */

import { ipcRenderer } from 'electron'
import { invokeIpc } from './ipc-shim'

export type GetAccessTokenResult = {
  success: boolean
  token?: string | null
  error?: string
}

const ACCESS_TOKEN_CACHE_TTL_MS = 500

interface CacheEntry {
  result: GetAccessTokenResult
  expiresAt: number
}

let cachedAccessTokenResult: CacheEntry | null = null
let inflightAccessTokenPromise: Promise<GetAccessTokenResult> | null = null

const invalidateAccessTokenCache = (): void => {
  cachedAccessTokenResult = null
  // 故意不清 inflightAccessTokenPromise：已经在飞的 IPC 让它正常返回
  // （拿到的就是 main 端最新值），后续 caller 看到 cache 已失效会重新发起。
}

let listenersInstalled = false

/**
 * 在 preload 入口调一次。订阅 token 变更广播以失效缓存。
 * 重入安全（多次调用只装一次）。
 */
export function installAuthTokenInvalidationListeners(): void {
  if (listenersInstalled) return
  listenersInstalled = true
  ipcRenderer.on('auth:token-refreshed-signal', invalidateAccessTokenCache)
  ipcRenderer.on('auth:force-logout', invalidateAccessTokenCache)
}

/**
 * 拿 access token —— in-flight + 短 TTL 双层 dedup。
 *
 * caller 表现与原 `invokeIpc('auth:getAccessToken')` 完全一致（透传
 * legacy `{success, token, error}`），只是底层 IPC 次数大幅减少。
 */
export function getAccessTokenDeduped(): Promise<GetAccessTokenResult> {
  // 1. 短 TTL 缓存命中
  const now = Date.now()
  if (cachedAccessTokenResult && cachedAccessTokenResult.expiresAt > now) {
    return Promise.resolve(cachedAccessTokenResult.result)
  }

  // 2. in-flight 复用
  if (inflightAccessTokenPromise) {
    return inflightAccessTokenPromise
  }

  // 3. 真正发 IPC
  inflightAccessTokenPromise = invokeIpc<GetAccessTokenResult>('auth:getAccessToken')
    .then((result) => {
      cachedAccessTokenResult = {
        result,
        expiresAt: Date.now() + ACCESS_TOKEN_CACHE_TTL_MS,
      }
      return result
    })
    .catch((err) => {
      // 失败不缓存 — 让下一次调用重新尝试。
      throw err
    })
    .finally(() => {
      inflightAccessTokenPromise = null
    })
  return inflightAccessTokenPromise
}

// ─── 测试钩子 ───────────────────────────────────────────────────────────
// 暴露给 unit test 重置内部状态。生产路径不应使用。
export const __testing = {
  reset(): void {
    cachedAccessTokenResult = null
    inflightAccessTokenPromise = null
    listenersInstalled = false
    ipcRenderer.removeListener('auth:token-refreshed-signal', invalidateAccessTokenCache)
    ipcRenderer.removeListener('auth:force-logout', invalidateAccessTokenCache)
  },
  invalidate(): void {
    invalidateAccessTokenCache()
  },
  getCacheState(): { hasCache: boolean; hasInflight: boolean } {
    return {
      hasCache: cachedAccessTokenResult !== null,
      hasInflight: inflightAccessTokenPromise !== null,
    }
  },
  TTL_MS: ACCESS_TOKEN_CACHE_TTL_MS,
}
