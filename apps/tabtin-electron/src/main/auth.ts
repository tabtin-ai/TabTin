import { BrowserWindow, app, webContents } from 'electron'
import { normalize, join, sep } from 'path'
import { fileURLToPath } from 'url'
import { guardedHandle } from './utils/guarded-handle'
import { API_BASE_URL } from './config/api.js'
import { joinApiPath } from '@tabtin/config'
import { createLogger } from './logger'
import { credentialStore } from './safe-credential-store'

// 通过 safeStorage 加密落盘，替代 keytar。
// 历史 keytar 7.9.0 在 macOS 26 (Tahoe) 上会抛 C++ 异常并 abort 主进程，
// 详见 safe-credential-store.ts 头注释。
const credentials = credentialStore

type IpcSenderEvent = {
  senderFrame?: { url?: string } | null
}

const log = createLogger('TokenManager')

// 服务名称与账号标识
const SERVICE_NAME = 'TabTin'
const AUTH_ACCOUNT = 'auth_bundle'

type AuthBundle = {
  accessToken: string | null
  refreshToken: string | null
  userInfo: any | null
  expiresAt?: number | null
}

const EMPTY_BUNDLE: AuthBundle = {
  accessToken: null,
  refreshToken: null,
  userInfo: null,
  expiresAt: null
}

export type AuthErrorCode =
  | 'TOKEN_EXPIRED'
  | 'RATE_LIMITED'
  | 'REFRESH_CONFLICT'
  | 'SERVER_ERROR'
  | 'REFRESH_TIMEOUT'
  | 'NETWORK_ERROR'
  | 'UNKNOWN'

export type AuthRefreshResult =
  | { success: true; accessToken: string }
  | { success: false; errorCode: AuthErrorCode; message: string; isTransient: boolean }

function decodeJwtPayload(token: string): Record<string, any> | null {
  try {
    const parts = token.split('.')
    if (parts.length < 2) return null
    let payload = parts[1].replace(/-/g, '+').replace(/_/g, '/')
    const pad = payload.length % 4
    if (pad) {
      payload += '='.repeat(4 - pad)
    }
    const json = Buffer.from(payload, 'base64').toString('utf-8')
    return JSON.parse(json)
  } catch (error) {
    log.error('解析 JWT 失败:', error)
    return null
  }
}

// 会话级内存缓存，避免频繁访问系统钥匙串
const tokenCache: {
  bundle: AuthBundle
  loaded: boolean
  loading: boolean
  loadPromise?: Promise<void>
} = {
  bundle: { ...EMPTY_BUNDLE },
  loaded: false,
  loading: false
}

function sanitizeBundle(bundle: AuthBundle | null | undefined): AuthBundle {
  if (!bundle || typeof bundle !== 'object') {
    return { ...EMPTY_BUNDLE }
  }
  return {
    accessToken: bundle.accessToken ?? null,
    refreshToken: bundle.refreshToken ?? null,
    userInfo: bundle.userInfo ?? null,
    expiresAt: typeof bundle.expiresAt === 'number' ? bundle.expiresAt : null
  }
}

async function writeBundleToKeychain(bundle: AuthBundle): Promise<void> {
  const normalized = sanitizeBundle(bundle)
  const hasAnyValue = !!(normalized.accessToken || normalized.refreshToken || normalized.userInfo)

  if (!hasAnyValue) {
    await credentials.deletePassword(SERVICE_NAME, AUTH_ACCOUNT).catch(() => {})
    return
  }

  try {
    await credentials.setPassword(SERVICE_NAME, AUTH_ACCOUNT, JSON.stringify(normalized))
  } catch (error) {
    log.error('写入认证 bundle 到 keychain 失败:', error)
    throw error
  }
}

async function readBundleFromKeychain(): Promise<AuthBundle> {
  const bundleJson = await credentials.getPassword(SERVICE_NAME, AUTH_ACCOUNT).catch(() => null)
  if (bundleJson) {
    try {
      const parsed = JSON.parse(bundleJson)
      return sanitizeBundle(parsed)
    } catch (error) {
      log.warn('认证数据解析失败，回退为空 bundle:', error)
    }
  }

  return { ...EMPTY_BUNDLE }
}

function updateCache(bundle: AuthBundle): void {
  tokenCache.bundle = sanitizeBundle(bundle)
  tokenCache.loaded = true
}

function mergeBundle(base: AuthBundle, updates: Partial<AuthBundle>): AuthBundle {
  return sanitizeBundle({
    ...base,
    ...updates
  })
}

// Token 管理类
export class TokenManager {
  private static _authChangedCallbacks = new Set<() => void>()

  /**
   * 注册回调：**任何**改变 auth 状态的写路径都会触发：
   *   - 登录 / 完整 saveAuthData
   *   - refresh token 成功（access token 更换）
   *   - 完整登出 clearAuthData
   *   - 部分清除 clearTokens / clearUserInfo（dogfood 期 token 刷新失败路径会调）
   *
   * 订阅方应**重新评估**当前 auth 状态而不是假设"now available" —— 例如
   * BrowserEnvironmentService 据此切到/切出 guest snapshot。
   *
   * 返回取消订阅函数。
   */
  static onAuthChanged(cb: () => void): () => void {
    this._authChangedCallbacks.add(cb)
    return () => { this._authChangedCallbacks.delete(cb) }
  }

  /**
   * @deprecated 历史名（语义只覆盖"available"路径，登出 / 部分清除路径会漏）。
   * 等价于 {@link onAuthChanged}，旧调用方按需迁移。新代码请直接用 onAuthChanged。
   */
  static onAuthAvailable(cb: () => void): () => void {
    return TokenManager.onAuthChanged(cb)
  }

  private static _notifyAuthChanged(): void {
    for (const cb of this._authChangedCallbacks) {
      try { cb() } catch { /* ignore */ }
    }
  }

  /**
   * 预加载认证数据，避免主窗口初始化后批量弹出授权提示
   */
  static async preloadAuthData(): Promise<void> {
    if (tokenCache.loaded || tokenCache.loading) {
      if (tokenCache.loading && tokenCache.loadPromise) {
        await tokenCache.loadPromise
      }
      return
    }

    tokenCache.loading = true
    tokenCache.loadPromise = (async () => {
      try {
        log.info('正在加载认证数据...')
        const bundle = await readBundleFromKeychain()
        updateCache(bundle)
        const hasAuth = !!(bundle.accessToken && bundle.userInfo)
        log.info(`✅ 加载完成 ${hasAuth ? '(已登录)' : '(未登录)'}`)
      } catch (error) {
        log.error('❌ 认证数据加载失败:', error)
        updateCache({ ...EMPTY_BUNDLE })
      } finally {
        tokenCache.loading = false
        tokenCache.loadPromise = undefined
      }
    })()

    await tokenCache.loadPromise
  }

  private static async updateBundle(updates: Partial<AuthBundle>): Promise<void> {
    await this.preloadAuthData()
    const next = mergeBundle(tokenCache.bundle, updates)
    await writeBundleToKeychain(next)
    updateCache(next)
  }

  // 保存访问 Token
  static async saveAccessToken(token: string): Promise<void> {
    try {
      await this.updateBundle({ accessToken: token })
    } catch (error) {
      log.error('保存 access token 失败:', error)
      throw new Error('保存访问令牌失败')
    }
  }

  // 获取访问 Token
  static async getAccessToken(): Promise<string | null> {
    try {
      await this.preloadAuthData()
      return tokenCache.bundle.accessToken
    } catch (error) {
      log.error('获取 access token 失败:', error)
      return null
    }
  }

  // 保存刷新 Token
  static async saveRefreshToken(token: string): Promise<void> {
    try {
      await this.updateBundle({ refreshToken: token })
    } catch (error) {
      log.error('保存 refresh token 失败:', error)
      throw new Error('保存刷新令牌失败')
    }
  }

  // 获取刷新 Token
  static async getRefreshToken(): Promise<string | null> {
    try {
      await this.preloadAuthData()
      return tokenCache.bundle.refreshToken
    } catch (error) {
      log.error('获取 refresh token 失败:', error)
      return null
    }
  }

  // 保存用户信息
  static async saveUserInfo(userInfo: any): Promise<void> {
    try {
      await this.updateBundle({ userInfo })
    } catch (error) {
      log.error('保存用户信息失败:', error)
      throw new Error('保存用户信息失败')
    }
  }

  // 获取用户信息
  static async getUserInfo(): Promise<any | null> {
    try {
      await this.preloadAuthData()
      return tokenCache.bundle.userInfo
    } catch (error) {
      log.error('获取用户信息失败:', error)
      return null
    }
  }

  /**
   * 同步读取已预加载的用户信息，供不能异步等待的本地事件落盘路径使用。
   * 未完成预加载时返回 null，调用方必须 fail closed，不能写入公共目录。
   */
  static getCachedUserInfo(): unknown | null {
    return tokenCache.loaded ? tokenCache.bundle.userInfo : null
  }

  // 保存完整认证信息
  static async saveAuthData(accessToken: string, refreshToken: string, userInfo: any, expiresAt?: number | null): Promise<void> {
    try {
      await this.updateBundle({
        accessToken,
        refreshToken,
        userInfo,
        ...(typeof expiresAt === 'number' ? { expiresAt } : {})
      })
      if (accessToken) this._notifyAuthChanged()
    } catch (error) {
      log.error('保存完整认证信息失败:', error)
      throw new Error('保存认证信息失败')
    }
  }

  // 获取完整认证信息
  static async getAuthData(): Promise<AuthBundle> {
    try {
      await this.preloadAuthData()
      return sanitizeBundle(tokenCache.bundle)
    } catch (error) {
      log.error('获取完整认证信息失败:', error)
      return { ...EMPTY_BUNDLE }
    }
  }

  // 清除所有认证信息
  static async clearAuthData(options: { rethrow?: boolean } = {}): Promise<void> {
    try {
      await writeBundleToKeychain({ ...EMPTY_BUNDLE })
      updateCache({ ...EMPTY_BUNDLE })
      this._lastSuccessfulRefreshAt = 0
      log.info('认证信息已清除')
      // 通知订阅方"auth 状态变更" —— 包括登出场景。BrowserEnvironmentService
      // 等模块据此切回 guest snapshot,避免登出后仍持有上一用户的数据。
      this._notifyAuthChanged()
    } catch (error) {
      log.error('清除认证信息失败:', error)
      if (options.rethrow) {
        throw error
      }
    }
  }

  // 清除 Token
  //
  // 调用方包括 token 刷新失败路径（``packages/smartsheet-adapter-electron``）。
  // 这条路径虽然不写空 userInfo，但已经是"无效会话"语义；BES 的 `defaultResolveUserId`
  // 同时读 accessToken + userInfo，缺 token 即落 GUEST_USER_ID。我们这里只负责
  // notify auth changed，下游模块据此重新评估即可。
  static async clearTokens(): Promise<void> {
    try {
      await this.updateBundle({ accessToken: null, refreshToken: null })
      this._notifyAuthChanged()
    } catch (error) {
      log.error('清除 Token 失败:', error)
      throw new Error('清除 Token 失败')
    }
  }

  // 清除用户信息
  //
  // 与 clearTokens 对称：调用方语义上是"放弃当前 user 身份"，下游应重新评估
  // auth 状态（BES 看 userInfo 决定 snapshot user），故必须通知。
  static async clearUserInfo(): Promise<void> {
    try {
      await this.updateBundle({ userInfo: null })
      this._notifyAuthChanged()
    } catch (error) {
      log.error('清除用户信息失败:', error)
      throw new Error('清除用户信息失败')
    }
  }

  // 检查是否存在有效认证
  static async hasValidAuth(): Promise<boolean> {
    try {
      const { accessToken, userInfo } = await this.getAuthData()
      return !!(accessToken && userInfo)
    } catch (error) {
      log.error('检查认证有效性失败:', error)
      return false
    }
  }

  private static _refreshPromise: Promise<string> | null = null
  /** : 成功刷新后的新鲜窗口起点；限流/Collab 风暴期内复用现有 access token */
  private static _lastSuccessfulRefreshAt = 0

  /** @internal 单测重置刷新互斥锁与新鲜窗口 */
  static resetRefreshStateForTests(): void {
    this._refreshPromise = null
    this._lastSuccessfulRefreshAt = 0
  }

  /**
   * 刷新 Access Token（带互斥锁）
   * 使用 refresh_token 换取新的 access_token 和 refresh_token。
   * 并发调用会共享同一个 Promise，避免同一 refresh token 被消耗多次。
   * @returns 新的 access_token
   */
  static async refreshAccessToken(): Promise<string> {
    if (this._refreshPromise) return this._refreshPromise
    this._refreshPromise = this._doRefreshAccessToken().finally(() => {
      this._refreshPromise = null
    })
    return this._refreshPromise
  }

  private static readonly REFRESH_TIMEOUT_MS = 15_000
  private static readonly MAX_CONFLICT_RETRIES = 2
  /** Collab auth recovery 串行刷 refresh 的冷却窗（低于服务端 5次/60s） */
  private static readonly REFRESH_FRESHNESS_MS = 30_000
  /** 新鲜窗口内仍强制刷新的临近过期阈值（分钟） */
  private static readonly REFRESH_FRESHNESS_EXPIRY_BUFFER_MINUTES = 2

  private static async _readRefreshErrorPayload(
    response: Response,
  ): Promise<{ code: string | null; message: string | null }> {
    try {
      const raw = await response.json() as {
        code?: unknown
        message?: unknown
        data?: { code?: unknown; message?: unknown }
      }
      const codeCandidate = raw?.code ?? raw?.data?.code
      const messageCandidate = raw?.message ?? raw?.data?.message
      return {
        code: typeof codeCandidate === 'string' ? codeCandidate : null,
        message: typeof messageCandidate === 'string' ? messageCandidate : null,
      }
    } catch {
      return { code: null, message: null }
    }
  }

  private static async _reuseAccessTokenAfterRateLimit(
    currentAccessToken: string | null,
  ): Promise<string> {
    const existing = currentAccessToken || (await this.getAccessToken())
    if (existing) {
      // 进入新鲜窗口，避免限流后继续串行空打 /auth/refresh-token
      this._lastSuccessfulRefreshAt = Date.now()
      log.warn('Refresh rate limited — reusing current access token (no logout)')
      return existing
    }
    throw Object.assign(new Error('登录刷新过于频繁，请稍后重试'), {
      authErrorCode: 'RATE_LIMITED' as const,
      isTransient: true,
    })
  }

  private static async _doRefreshAccessToken(): Promise<string> {
    log.info('开始刷新 Token...')

    const refreshToken = await this.getRefreshToken()
    if (!refreshToken) {
      throw Object.assign(new Error('未找到 refresh_token，请重新登录'), {
        authErrorCode: 'TOKEN_EXPIRED' as const,
        isTransient: false,
      })
    }

    // : 串行风暴下互斥锁无法合并；新鲜窗口内复用未临近过期的 access token。
    const cachedAccessToken = await this.getAccessToken()
    if (
      cachedAccessToken
      && this._lastSuccessfulRefreshAt > 0
      && (Date.now() - this._lastSuccessfulRefreshAt) < this.REFRESH_FRESHNESS_MS
      && !(await this.isAccessTokenExpiringSoon(this.REFRESH_FRESHNESS_EXPIRY_BUFFER_MINUTES))
    ) {
      log.info('跳过 Token 刷新：仍在新鲜窗口内')
      return cachedAccessToken
    }

    for (let attempt = 0; attempt <= this.MAX_CONFLICT_RETRIES; attempt++) {
      const abortController = new AbortController()
      const timeoutId = setTimeout(() => abortController.abort(), this.REFRESH_TIMEOUT_MS)

      try {
        const currentAccessToken = await this.getAccessToken()

        const response = await fetch(joinApiPath(API_BASE_URL, '/auth/refresh-token'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ refresh_token: refreshToken }),
          signal: abortController.signal,
        })

        if (!response.ok) {
          const errorPayload = await this._readRefreshErrorPayload(response)
          const isRateLimited =
            response.status === 429
            || errorPayload.code === 'RATE_LIMITED'

          // : 服务端限流曾用 401+RATE_LIMITED；绝不能当 token 失效清凭证。
          if (isRateLimited) {
            return await this._reuseAccessTokenAfterRateLimit(currentAccessToken)
          }

          if (response.status === 401 || response.status === 403 || response.status === 404) {
            log.error(`❌ Refresh Token 无效或已过期(status=${response.status})，需要重新登录`)
            await this.clearAuthData()
            this._broadcastForceLogout()
            throw Object.assign(new Error(errorPayload.message || '登录已过期，请重新登录'), {
              authErrorCode: 'TOKEN_EXPIRED' as const,
              isTransient: false,
            })
          }

          if (response.status === 409) {
            const latestBundle = await readBundleFromKeychain()
            if (latestBundle.accessToken && latestBundle.accessToken !== currentAccessToken) {
              updateCache(latestBundle)
              log.info('409 冲突恢复：从 Keychain 获取到其他窗口刷新的 Token')
              return latestBundle.accessToken
            }
            if (attempt < this.MAX_CONFLICT_RETRIES) {
              const jitter = 1000 + Math.random() * 500
              log.info(`409 冲突，等待 ${Math.round(jitter)}ms 后重试 (${attempt + 1}/${this.MAX_CONFLICT_RETRIES})`)
              await new Promise(resolve => setTimeout(resolve, jitter))
              continue
            }
            throw Object.assign(new Error('Token 刷新冲突持续'), {
              authErrorCode: 'REFRESH_CONFLICT' as const,
              isTransient: true,
            })
          }

          if (response.status >= 500) {
            throw Object.assign(new Error(`服务端错误: ${response.status}`), {
              authErrorCode: 'SERVER_ERROR' as const,
              isTransient: true,
            })
          }

          throw Object.assign(new Error(`刷新 Token 失败: ${response.status}`), {
            authErrorCode: 'UNKNOWN' as const,
            isTransient: false,
          })
        }

        const raw = await response.json()
        const data = (raw && raw.success === true && raw.data) ? raw.data : raw

        if (!data.access_token || typeof data.access_token !== 'string') {
          throw Object.assign(new Error('刷新 Token 响应缺少有效的 access_token'), {
            authErrorCode: 'UNKNOWN' as const,
            isTransient: false,
          })
        }
        if (!data.refresh_token || typeof data.refresh_token !== 'string') {
          throw Object.assign(new Error('刷新 Token 响应缺少有效的 refresh_token'), {
            authErrorCode: 'UNKNOWN' as const,
            isTransient: false,
          })
        }

        await this.updateBundle({
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
        })

        this._lastSuccessfulRefreshAt = Date.now()
        this._broadcastTokenRefreshed()
        this._notifyAuthChanged()
        log.info('✅ Token 刷新成功')
        return data.access_token
      } catch (error: any) {
        if (error?.authErrorCode) {
          throw error
        }
        if (error?.name === 'AbortError') {
          throw Object.assign(new Error(`Token 刷新超时 (${this.REFRESH_TIMEOUT_MS / 1000}s)，请检查网络连接`), {
            authErrorCode: 'REFRESH_TIMEOUT' as const,
            isTransient: true,
          })
        }
        log.error('❌ Token 刷新失败:', error)
        throw Object.assign(
          error instanceof Error ? error : new Error(String(error?.message ?? error)),
          { authErrorCode: 'NETWORK_ERROR' as const, isTransient: true }
        )
      } finally {
        clearTimeout(timeoutId)
      }
    }

    throw Object.assign(new Error('Token 刷新重试次数耗尽'), {
      authErrorCode: 'UNKNOWN' as const,
      isTransient: false,
    })
  }

  private static _broadcastTokenRefreshed(): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        try {
          win.webContents.send('auth:token-refreshed-signal')
        } catch (e) {
          log.warn('广播 token-refreshed-signal 失败:', e)
        }
      }
    }
  }

  private static _broadcastForceLogout(): void {
    for (const wc of webContents.getAllWebContents()) {
      if (!wc.isDestroyed()) {
        try {
          wc.send('auth:force-logout')
        } catch (e) {
          log.warn('广播 force-logout 失败:', e)
        }
      }
    }
  }

  /**
   * 检查 access token 是否即将过期
   */
  static async isAccessTokenExpiringSoon(bufferMinutes = 5): Promise<boolean> {
    try {
      const accessToken = await this.getAccessToken()
      if (!accessToken) return true

      const payload = decodeJwtPayload(accessToken)
      const exp = payload?.exp
      if (typeof exp !== 'number') return false

      const now = Math.floor(Date.now() / 1000)
      const bufferSeconds = Math.max(0, Math.floor(bufferMinutes * 60))
      return exp - now <= bufferSeconds
    } catch (error) {
      log.error('检查 Token 过期失败:', error)
      return true
    }
  }
}

/**
 * 验证 IPC 调用者是否来自受信任的主应用渲染进程。
 * 拒绝来自第三方 WebContents（如 BrowserView 加载的外部页面、Tin 沙箱）的调用。
 *
 * 受信任来源：
 *   1. `tabtin-file://app/...` —— packaged 模式主 renderer / 分离 chat 窗口的入口协议。
 *      协议本身由 main 进程的 `registerStreamProtocol` 独占注册，且 `app` host 被
 *      `resolveAppResourcePath` 限定到 `out/renderer/` 目录，无法被外部页面伪造来源。
 *   2. `file://<appDir>/...` —— 历史 packaged 模式（直接 loadFile）兼容路径。如果
 *      未来彻底切到 `tabtin-file://app/`，可以删除该分支；保留可平滑迁移。
 *      CR-001/SD-034: 仅信任 app 安装目录内的资源，不信任 userData 下的 Tin 沙箱文件。
 *   3. `process.env.ELECTRON_RENDERER_URL` —— dev 模式 vite dev server。
 *      SD-049: 仅匹配该值，不再允许任意 http://localhost。
 */
export function isTrustedSender(event: IpcSenderEvent): boolean {
  try {
    const frameUrl = event.senderFrame?.url
    if (!frameUrl) return false

    if (frameUrl.startsWith('tabtin-file://')) {
      // 严格校验：protocol + hostname 必须完全匹配 `tabtin-file://app`，
      // 防 `tabtin-file://app.evil.com` 之类 hostname 混淆。
      try {
        const parsed = new URL(frameUrl)
        return parsed.protocol === 'tabtin-file:' && parsed.hostname === 'app'
      } catch {
        return false
      }
    }

    if (frameUrl.startsWith('file://')) {
      const filePath = normalize(fileURLToPath(frameUrl))
      const appDir = normalize(app.getAppPath())
      return filePath.startsWith(appDir + sep) || filePath === appDir
    }

    const rendererUrl = process.env['ELECTRON_RENDERER_URL']
    if (rendererUrl && frameUrl.startsWith(rendererUrl)) return true

    return false
  } catch {
    return false
  }
}

/**
 * 验证 IPC 调用者是否来自有效的 Tin 沙箱 webview。
 * 仅用于 tin-bridge:request — Tin 沙箱通过此桥接调用受权限系统控制的 API，
 * 但不应通过 isTrustedSender 获得全局 IPC 特权。
 */
export function isTinSandboxSender(event: IpcSenderEvent): boolean {
  try {
    const frameUrl = event.senderFrame?.url
    if (!frameUrl || !frameUrl.startsWith('file://')) return false

    const filePath = normalize(fileURLToPath(frameUrl))
    const sandboxDir = normalize(join(app.getPath('userData'), 'tin-sandboxes'))
    return filePath.startsWith(sandboxDir + sep)
  } catch {
    return false
  }
}

// 注册IPC处理器
export function registerAuthHandlers(): void {
  // 保存认证信息
  guardedHandle('auth:save', async (_, accessToken: string, refreshToken: string, userInfo: any, expiresAt?: number | null) => {
    try {
      await TokenManager.saveAuthData(accessToken, refreshToken, userInfo, expiresAt)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 获取认证信息
  guardedHandle('auth:get', async () => {
    try {
      const authData = await TokenManager.getAuthData()
      return { success: true, data: authData }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 清除认证信息，并广播给所有 WebContents（含 BrowserWindow、webview/Tin 沙箱等）
  // CR-006: 使用 webContents.getAllWebContents() 替代 BrowserWindow.getAllWindows()，
  // 确保 Tin 沙箱 webview 等非窗口级 WebContents 也收到登出广播。
  guardedHandle('auth:clear', async (event) => {
    try {
      await TokenManager.clearAuthData()
      const senderWebContentsId = event.sender.id
      for (const wc of webContents.getAllWebContents()) {
        if (!wc.isDestroyed() && wc.id !== senderWebContentsId) {
          try {
            wc.send('auth:force-logout')
          } catch (e) {
            log.warn('广播 force-logout 失败:', e)
          }
        }
      }
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 清除 Token
  guardedHandle('auth:clearTokens', async () => {
    try {
      await TokenManager.clearTokens()
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 清除用户信息
  guardedHandle('auth:clearUserInfo', async () => {
    try {
      await TokenManager.clearUserInfo()
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 检查认证状态
  guardedHandle('auth:check', async () => {
    try {
      const isValid = await TokenManager.hasValidAuth()
      return { success: true, isValid }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 保存访问Token
  guardedHandle('auth:saveAccessToken', async (_, token: string) => {
    try {
      await TokenManager.saveAccessToken(token)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 获取访问Token
  guardedHandle('auth:getAccessToken', async () => {
    try {
      const token = await TokenManager.getAccessToken()
      return { success: true, token }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 保存刷新Token
  guardedHandle('auth:saveRefreshToken', async (_, token: string) => {
    try {
      await TokenManager.saveRefreshToken(token)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // SS-31: auth:getRefreshToken 已移除 — refresh token 不应暴露给渲染进程。
  // 渲染进程应改用 auth:refreshAccessToken 由主进程透明完成刷新。

  // 在主进程内执行 Token 刷新，仅返回新的 access token
  guardedHandle('auth:refreshAccessToken', async (): Promise<AuthRefreshResult> => {
    try {
      const accessToken = await TokenManager.refreshAccessToken()
      return { success: true, accessToken }
    } catch (error: any) {
      return {
        success: false,
        errorCode: error?.authErrorCode ?? 'UNKNOWN',
        message: error?.message ?? 'Token 刷新失败',
        isTransient: error?.isTransient ?? false,
      }
    }
  })

  // 保存用户信息
  guardedHandle('auth:saveUserInfo', async (_, userInfo: any) => {
    try {
      await TokenManager.saveUserInfo(userInfo)
      return { success: true }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 获取用户信息
  guardedHandle('auth:getUserInfo', async () => {
    try {
      const userInfo = await TokenManager.getUserInfo()
      return { success: true, userInfo }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })

  // 检查 Token 是否即将过期
  guardedHandle('auth:isTokenExpiringSoon', async (_, bufferMinutes: number = 5) => {
    try {
      const isExpiring = await TokenManager.isAccessTokenExpiringSoon(bufferMinutes)
      return { success: true, isExpiring }
    } catch (error: any) {
      return { success: false, error: error.message }
    }
  })
}

// 导出类型
export interface AuthData {
  accessToken: string | null
  refreshToken: string | null
  userInfo: any | null
  expiresAt?: number | null
}

export interface AuthResult {
  success: boolean
  error?: string
  data?: AuthData
  isValid?: boolean
  token?: string | null
  userInfo?: any | null
}
