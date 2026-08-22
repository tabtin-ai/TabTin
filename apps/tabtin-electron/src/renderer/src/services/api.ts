import type { AxiosRequestConfig } from 'axios'
import {
  ApiResponse,
  LoginRequest,
  LoginResponse,
  RefreshTokenResponse,
  RegisterRequest,
  VerificationCodeLoginRequest,
  SendVerificationCodeRequest,
  ForgotPasswordRequest,
  ResetPasswordRequest,
  CurrentUserPasswordResetRequest,
  PasswordChangeRequest,
  UserProfileUpdateRequest,
  UserProfileSettings,
  UserProfileSettingsUpdateRequest,
  EmailVerificationRequest,
  PhoneVerificationRequest,
  BindEmailSendRequest,
  BindEmailRequest,
  UserInfo,
  UserSession,
  PasswordStrength
} from '@/types/auth'
import type { UISettingsResponse, UISettingsUpdateRequest } from '@/types/uiSettings'
import { API_CONFIG, API_ENDPOINTS } from '@/config/api'
import { joinApiPath } from '@tabtin/config'
import { notifyTokensSynced, notifyLogoutRequired } from '@/utils/authPersistence'
import { getCurrentLanguage } from '@/i18n'
import i18n from '@/i18n'
import type { RetryConfig } from '@shared/api-retry-config'
import { createLogger } from '@/utils/logger'
import { isPlatformIpcError } from '@/services/ipc-error'

const log = createLogger('API')
const INVITE_CODE_REQUIRED = 'INVITE_CODE_REQUIRED'

export interface RuntimeVersionInfo {
  release_version: string
  source_sha: string
}

function notifyInviteCodeRequired(errorData: any) {
  const errorCode = errorData?.code || errorData?.error_code
  if (errorCode !== INVITE_CODE_REQUIRED || typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('auth:invite-code-required'))
}

// API 层只负责把服务端错误交给调用方。它不知道请求来自用户点击、自动刷新还是
// 组织切换；在这里直接展示计费提示会把后台失败误渲染为用户操作被拦截。
// 需要引导充值或升级的界面，必须在各自明确的用户操作 catch 中调用
// showBillingErrorToast。

/**
 * HTTP 错误，携带 status 和原始响应体。
 * save-controller 等模块依赖 `err.status` / `err.response.data` 提取冲突信息。
 *
 * Wave 2A(限流全栈治理):新增 `retryAfter` — 仅当 status === 429 时填充,
 * 单位秒(整数)。读取优先级见 `docs/api/rate-limit-protocol.md` §3.1:
 * body.retry_after_seconds → Retry-After header → undefined。
 *
 * 字段命名采用 TS 风格 camelCase(对应协议 body 后端 snake_case 字段
 * `retry_after_seconds`),adapter 层做命名转换是该层的标准职责。
 */
export class ApiError extends Error {
  status: number
  data: unknown
  response: { status: number; data: unknown }
  /**
   * 仅在 status === 429 时设置;业务层用此值做动态冷却(替代硬编码 5s)。
   * 缺失时业务层走自身 fallback(例如 `useTrackerStore.FAILURE_COOLDOWN_MS`)。
   */
  retryAfter?: number

  constructor(message: string, status: number, data?: unknown, retryAfter?: number) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.data = data
    this.response = { status, data }
    if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter >= 1) {
      this.retryAfter = retryAfter
    }
  }
}

/**
 * 从主进程返回的 response 对象中解析 retryAfter(秒)。
 * 协议 §3.1 优先级:body.retry_after_seconds → Retry-After header → undefined。
 * - body 字段是 snake_case(后端约定),header 是 RFC 6585 标准。
 * - 仅认正整数 ≥ 1;0 / 负数 / 浮点视为缺失,避免雷击群效应(协议 §3.2)。
 */
export function extractRetryAfterFromResponse(
  response: { data?: any; headers?: Record<string, any>; retryAfter?: number } | null | undefined
): number | undefined {
  if (!response) return undefined
  // 优先 main 进程已挂载的 retryAfter 字段(api-proxy.ts 透传)
  if (typeof response.retryAfter === 'number' && response.retryAfter >= 1) {
    return Math.floor(response.retryAfter)
  }
  // 路径 1:body.retry_after_seconds
  const bodySeconds = response.data?.retry_after_seconds
  if (Number.isInteger(bodySeconds) && bodySeconds >= 1) {
    return bodySeconds as number
  }
  // 路径 2:Retry-After header(case-insensitive)
  const headerVal = response.headers?.['retry-after'] ?? response.headers?.['Retry-After']
  if (headerVal != null) {
    const parsed = parseInt(String(headerVal), 10)
    if (Number.isFinite(parsed) && parsed >= 1) {
      return parsed
    }
  }
  return undefined
}

// 检查是否在Electron环境中
const isElectron = typeof window !== 'undefined' && window.electron

/**
 * API 服务
 *
 * 所有请求经由主进程代理（requestViaProxy），绕过 CSP / 跨域限制。
 * Token 刷新与 401 重试逻辑直接在 requestViaProxy 内处理。
 */
class ApiService {
  private authToken: string | null = null
  private isRefreshing = false
  private refreshPromise: Promise<string | null> | null = null

  // 设置认证Token
  setAuthToken(token: string | null) {
    this.authToken = token
  }

  // 清除认证
  clearAuth() {
    this.authToken = null
  }

  // 是否已设置认证 Token（供偏好同步层决定是否写穿后端，避免循环依赖 useAuthStore）
  isAuthenticated(): boolean {
    return !!this.authToken
  }

  /**
   * 公开的 Token 刷新方法（带锁去重）
   * 供 table-core adapter 等外部模块在 401 时调用
   * @returns 新的 access_token 或 null
   */
  async tryRefreshTokens(): Promise<string | null> {
    try {
      return await this.refreshAccessTokenWithLock()
    } catch {
      return null
    }
  }

  /**
   * 检查当前 Token 是否有效，仅在即将过期时才刷新
   * 适用于页面恢复可见、网络恢复等场景的预防性检查
   */
  async ensureValidToken(): Promise<void> {
    try {
      await this.ensureAccessToken()
    } catch {
      // 静默处理，不影响调用方
    }
  }

  /** 无需附加 Auth 头的端点（公开接口） */
  private static readonly AUTH_BYPASS_PATTERNS = [
    '/auth/login',
    '/auth/register',
    '/auth/refresh-token',
    '/auth/forgot-password',
    '/auth/reset-password',
    '/auth/send-verification-code',
    '/auth/send-email-verification',
    '/auth/send-phone-verification',
    '/auth/password-strength',
    '/auth/health',
    '/client-errors/report-anonymous',
  ]

  private shouldBypassAuth(url?: string): boolean {
    if (!url) return false
    const pathname = url.split('?')[0].split('#')[0]
    return ApiService.AUTH_BYPASS_PATTERNS.some(
      (pattern) => pathname === pattern || pathname.endsWith(pattern)
    )
  }

  private async ensureAccessToken(): Promise<string | null> {
    if (!isElectron || !window.tabtin?.auth) {
      return this.authToken
    }

    if (!this.authToken) {
      try {
        // contract W2-β：旧 envelope `{success, token}` 改为 invokeIpc 直接返
        // `{ token }` 或 throw。catch 块只 log 不弹 toast——这是登录态健康检查路径，
        // 失败时让 caller 走 null 分支自然降级（外部 fetch 不带 Authorization）。
        const result = await window.tabtin.auth.getAccessToken()
        this.authToken = result?.token ?? null
      } catch (error) {
        log.error('获取存储的访问令牌失败:', error)
      }
    }

    if (!this.authToken) {
      return null
    }

    const isExpiring = await this.isAccessTokenExpiringSoon(5)
    if (isExpiring) {
      return this.refreshAccessTokenWithLock()
    }

    return this.authToken
  }

  private async isAccessTokenExpiringSoon(bufferMinutes = 5): Promise<boolean> {
    if (!isElectron || !window.tabtin?.auth?.isTokenExpiringSoon) {
      return false
    }

    try {
      const result = await window.tabtin.auth.isTokenExpiringSoon(bufferMinutes)
      if (typeof result?.isExpiring === 'boolean') {
        return result.isExpiring
      }
    } catch (error) {
      // 静默：检查过期时间失败就当作未过期（caller 后续真实请求会再次刷新 / 失败时 throw 401）
      log.error('检查访问令牌过期状态失败:', error)
    }

    return false
  }

  private async refreshAccessTokenWithLock(): Promise<string | null> {
    if (this.refreshPromise) {
      return this.refreshPromise
    }

    this.isRefreshing = true
    this.refreshPromise = (async () => {
      try {
        if (!isElectron || !window.tabtin?.auth?.refreshAccessToken) {
          throw new Error(i18n.t('common:errors.electronUnavailable'))
        }

        // contract W2-β：旧 `{success, accessToken, message, errorCode, isTransient}` envelope
        // 改为 invokeIpc 直接返 `{ accessToken, errorCode?, isTransient? }` 或 throw。
        // 失败 envelope 的 `errorCode`/`isTransient` 通过 PlatformIpcError.detail
        // 透传——主进程把 401/网络错等元信息塞进 detail，让 handleRefreshFailure
        // 决定要不要清登录态（详见 detail.errorCode === 'AUTH_INVALID' 分支）。
        let result: { accessToken: string; errorCode?: string; isTransient?: boolean }
        try {
          result = await window.tabtin.auth.refreshAccessToken()
        } catch (err) {
          if (isPlatformIpcError(err)) {
            const detail = (err.detail ?? {}) as { errorCode?: string; isTransient?: boolean }
            const error = new Error(err.message || i18n.t('common:errors.refreshTokenFailed'))
            ;(error as any).authErrorCode = detail.errorCode ?? err.code
            ;(error as any).isTransient = detail.isTransient
            throw error
          }
          throw err
        }

        this.setAuthToken(result.accessToken)

        const authBundle = await window.tabtin.auth.get().catch(() => null)
        const refreshToken = authBundle?.refreshToken || ''
        const userInfo = authBundle?.userInfo || null

        notifyTokensSynced({
          accessToken: result.accessToken,
          refreshToken,
          user: userInfo,
        })

        return result.accessToken
      } catch (error) {
        await this.handleRefreshFailure(error)
        throw error
      } finally {
        this.isRefreshing = false
        this.refreshPromise = null
      }
    })()

    return this.refreshPromise
  }

  /**
   * 判断错误是否为网络层错误（断网、超时、DNS 等）
   * 网络错误时不应清除本地凭证和登出，因为 token 可能仍然有效
   */
  private static isNetworkError(error: unknown): boolean {
    if (!error) return false
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
    const networkPatterns = [
      'network error',
      'net::err_',
      'failed to fetch',
      'fetch failed',
      'request timeout',
      'timeout',
      'econnrefused',
      'econnreset',
      'enotfound',
      'etimedout',
      'enetunreach',
      'ehostunreach',
      'eai_again',
      'socket hang up',
      'abort',
    ]
    return networkPatterns.some((p) => msg.includes(p))
  }

  private async handleRefreshFailure(error?: unknown): Promise<void> {
    // ==================== 结构化错误分类（优先） ====================
    // 主进程 IPC 返回的结构化字段 authErrorCode / isTransient 是最可靠的判断依据
    const authErrorCode = (error as any)?.authErrorCode as string | undefined
    const isTransient = (error as any)?.isTransient as boolean | undefined

    if (isTransient === true) {
      log.warn('Token 刷新因暂时性错误失败（%s），保留本地凭证', authErrorCode)
      return
    }

    // : 限流绝不当 token 失效（即便 isTransient 字段丢失）
    if (authErrorCode === 'RATE_LIMITED') {
      log.warn('Token 刷新因限流失败（RATE_LIMITED），保留本地凭证')
      return
    }

    // ==================== Fallback：isNetworkError（HTTP 层非 IPC 错误） ====================
    if (isTransient === undefined && ApiService.isNetworkError(error)) {
      log.warn('Token 刷新因网络错误失败，保留本地凭证，不触发登出')
      return
    }

    // 只有服务端明确拒绝（TOKEN_EXPIRED 等）或无法识别的非暂时性错误才登出
    log.error('Token 刷新因认证错误失败（%s），清除凭证并登出', authErrorCode ?? 'unknown')
    try {
      if (isElectron && window.tabtin?.auth) {
        await window.tabtin.auth.clear()
      }
    } catch (clearError) {
      log.error('刷新失败后清理认证信息出错:', clearError)
    } finally {
      this.clearAuth()
      notifyLogoutRequired('token_refresh_failed')
    }
  }

  private async fetchStoredUserInfo(): Promise<UserInfo | null> {
    if (!isElectron || !window.tabtin?.auth) {
      return null
    }

    try {
      const result = await window.tabtin.auth.getUserInfo()
      if (result?.success) {
        return result.userInfo ?? null
      }
    } catch (error) {
      log.error('获取存储的用户信息失败:', error)
    }

    return null
  }

  // 规范化请求头为 Record<string, string>
  private normalizeHeaders(input: any): Record<string, string> {
    if (!input) return {}
    // 处理 AxiosHeaders
    if (typeof input === 'object' && typeof input.forEach === 'function') {
      const result: Record<string, string> = {}
      try {
        input.forEach((value: any, key: string) => {
          if (value == null) return
          result[key] = Array.isArray(value) ? value.join(', ') : String(value)
        })
        return result
      } catch {
        // fallthrough
      }
    }
    // 普通对象或可序列化对象
    try {
      if (typeof input.toJSON === 'function') {
        input = input.toJSON()
      }
    } catch {
      // fail-soft: toJSON() 抛错时退到普通对象路径继续规范化，避免拖垮整个请求
    }
    const result: Record<string, string> = {}
    for (const [k, v] of Object.entries(input)) {
      if (v == null) continue
      result[k] = Array.isArray(v) ? (v as any[]).join(', ') : String(v)
    }
    return result
  }

  // 使用主进程代理的请求方法
  private async requestViaProxy<T>(
    config: AxiosRequestConfig,
    retryConfig?: Partial<RetryConfig>,
    _isRetry = false
  ): Promise<T> {
    if (!isElectron || !window.tabtin) {
      throw new Error(i18n.t('common:errors.electronUnavailable'))
    }

    try {
      const url = joinApiPath(API_CONFIG.baseURL, config.url ?? '')
      const headers: Record<string, string> = {
        Accept: 'application/json',
        'Accept-Language': getCurrentLanguage(),
        ...this.normalizeHeaders(API_CONFIG.headers),
        ...this.normalizeHeaders(config.headers),
        'X-Client-Type': 'electron',
        'X-Client-Version': import.meta.env.VITE_APP_VERSION || '',
        'X-Client-Source-Sha': import.meta.env.VITE_GIT_COMMIT || '',
      }
      if (!headers['Content-Type']) {
        headers['Content-Type'] = 'application/json'
      }

      // 对非公开接口，确保 token 有效（预刷新即将过期的 token）
      if (!_isRetry && !this.shouldBypassAuth(config.url)) {
        try {
          const freshToken = await this.ensureAccessToken()
          if (freshToken) {
            this.authToken = freshToken
          }
        } catch (err) {
          log.warn('ensureAccessToken failed, using cached token:', err)
        }
      }

      if (this.authToken) {
        headers.Authorization = `Bearer ${this.authToken}`
      }

      // FormData 需要特殊处理：将文件转为 base64 entries 通过 IPC 传输，
      // 由主进程重建 multipart/form-data 请求（IPC 不支持二进制 FormData）。
      let body: string | undefined
      let multipartEntries: Array<{ name: string; filename?: string; contentType?: string; base64: string }> | undefined

      if (config.data instanceof FormData) {
        const entries: Array<{ name: string; filename?: string; contentType?: string; base64: string }> = []
        for (const [key, value] of config.data.entries()) {
          if (typeof value !== 'string') {
            const buffer = await value.arrayBuffer()
            const bytes = new Uint8Array(buffer)
            let binary = ''
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i])
            }
            const filename =
              'name' in value && typeof value.name === 'string'
                ? value.name
                : undefined
            entries.push({
              name: key,
              filename,
              contentType: value.type || 'application/octet-stream',
              base64: btoa(binary),
            })
          } else {
            const encoder = new TextEncoder()
            const bytes = encoder.encode(String(value))
            let binary = ''
            for (let i = 0; i < bytes.length; i++) {
              binary += String.fromCharCode(bytes[i])
            }
            entries.push({ name: key, base64: btoa(binary) })
          }
        }
        multipartEntries = entries
        delete headers['Content-Type']
        delete headers['content-type']
      } else if (config.data != null) {
        body = JSON.stringify(config.data)
      }

      const response = await window.tabtin.apiRequest({
        url,
        method: config.method || 'GET',
        headers,
        body,
        multipartEntries,
        retryConfig
      })

      // ==================== 401 自动刷新重试 ====================
      if (response.status === 401 && !_isRetry && !this.shouldBypassAuth(config.url)) {
        log.debug('收到 401，尝试刷新 Token 后重试...')
        try {
          const newToken = await this.refreshAccessTokenWithLock()
          if (newToken) {
            // 用新 token 重试原始请求（标记 _isRetry 防止无限循环）
            return this.requestViaProxy<T>(config, retryConfig, true)
          }
        } catch (refreshError) {
          // 刷新失败，handleRefreshFailure 已触发登出
          log.error('Token 刷新失败，无法重试请求')
          throw refreshError
        }
      }

      if (response.status >= 400) {
        const errorData = response.data
        notifyInviteCodeRequired(errorData)
        if (typeof window !== 'undefined' && response.status >= 500) {
          window.dispatchEvent(new CustomEvent('api:server-error', {
            detail: { status: response.status, url: url || '' },
          }))
        }
        // Wave 2A:429 时从 body / header 解析 retryAfter,业务层(useTrackerStore 等)
        // 用此值做动态冷却,避免硬编码秒数(协议 §3.1 读取优先级)。
        const retryAfter = response.status === 429
          ? extractRetryAfterFromResponse(response)
          : undefined
        throw new ApiError(
          errorData?.message || `HTTP ${response.status}`,
          response.status,
          errorData,
          retryAfter,
        )
      }

      // 统一响应格式 { success, code, message, data } 自动解包
      const data = response.data as any
      if (data && typeof data === 'object' && 'success' in data) {
        if (data.success === false) {
          notifyInviteCodeRequired(data)
          const message = data.message || i18n.t('common:errors.requestFailed')
          throw new ApiError(message, response.status, data)
        }
        if ('data' in data && data.data != null) {
          return data.data as T
        }
      }

      return data
    } catch (error: any) {
      const errorMessage = error.message || i18n.t('common:errors.networkError')
      log.error('Request failed:', {
        url: config.url,
        method: config.method,
        error: errorMessage
      })
      if (error instanceof ApiError) {
        throw error
      }
      // api:request 的主进程失败会以 PlatformIpcError 带回网络 code/reason；
      // 不要在这一层缩成只有 message 的普通 Error，否则 IM 无法判断可恢复失败。
      if (isPlatformIpcError(error)) {
        const proxyError = new Error(errorMessage) as Error & { code?: string; reason?: unknown }
        proxyError.code = error.code
        proxyError.reason = (error.detail as { reason?: unknown } | undefined)?.reason
        throw proxyError
      }
      throw new Error(errorMessage)
    }
  }

  // 通用请求方法（供业务模块复用）
  async request<T>(
    config: AxiosRequestConfig,
    retryConfig?: Partial<RetryConfig>
  ): Promise<T> {
    // 一律通过主进程代理，避免CSP与跨域问题
    return this.requestViaProxy<T>(config, retryConfig)
  }

  // ==================== 认证相关接口 ====================

  // 用户注册
  async register(data: RegisterRequest): Promise<LoginResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.AUTH.REGISTER,
      data,
    })
  }

  // 用户登录
  async login(data: LoginRequest): Promise<LoginResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.AUTH.LOGIN,
      data,
    })
  }

  // 验证码登录
  async loginWithVerificationCode(data: VerificationCodeLoginRequest): Promise<LoginResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.AUTH.LOGIN_VERIFICATION_CODE,
      data,
    })
  }

  // 用户登出
  async logout(): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.AUTH.LOGOUT,
    })
  }

  // 刷新Token — 委托主进程执行，复用实例级锁避免与 401 自动刷新并发
  async refreshToken(): Promise<RefreshTokenResponse> {
    if (!isElectron || !window.tabtin?.auth) {
      throw new Error(i18n.t('common:errors.electronUnavailable'))
    }

    const accessToken = await this.refreshAccessTokenWithLock()
    if (!accessToken) {
      throw new Error(i18n.t('common:errors.refreshTokenFailed'))
    }

    // contract W2-β：旧 envelope `{success, data: {refreshToken, userInfo}}` 改为
    // invokeIpc 直接返 `{ refreshToken, userInfo, ... }`（顶层无 success/data 包裹）。
    // auth.get() 失败应该 throw（caller 已经过 refreshAccessTokenWithLock 判过 token），
    // 但 catch 兜底返 null 保证 refresh_token / user 字段安全降级。
    const authBundle = await window.tabtin.auth.get().catch(() => null)
    const refreshToken = authBundle?.refreshToken || ''
    const userInfo = authBundle?.userInfo || null

    return {
      access_token: accessToken,
      refresh_token: refreshToken,
      user: userInfo,
    }
  }

  // ==================== 验证码相关接口 ====================

  // 发送验证码
  async sendVerificationCode(data: SendVerificationCodeRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.VERIFICATION.SEND_CODE,
      data,
    })
  }

  // 发送邮箱验证码
  async sendEmailVerification(): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.VERIFICATION.SEND_EMAIL,
    })
  }

  // 发送手机验证码
  async sendPhoneVerification(): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.VERIFICATION.SEND_PHONE,
    })
  }

  // 绑定邮箱：发送验证码到待绑定邮箱
  async sendBindEmailCode(data: BindEmailSendRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.VERIFICATION.SEND_BIND_EMAIL_CODE,
      data,
    })
  }

  // 绑定邮箱：校验验证码并写入
  async bindEmail(data: BindEmailRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.VERIFICATION.BIND_EMAIL,
      data,
    })
  }

  // 验证邮箱
  async verifyEmail(data: EmailVerificationRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.VERIFICATION.VERIFY_EMAIL,
      data,
    })
  }

  // 验证手机号
  async verifyPhone(data: PhoneVerificationRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.VERIFICATION.VERIFY_PHONE,
      data,
    })
  }

  // ==================== 密码管理接口 ====================

  // 忘记密码
  async forgotPassword(data: ForgotPasswordRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.PASSWORD.FORGOT,
      data,
    })
  }

  // 重置密码
  async resetPassword(data: ResetPasswordRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.PASSWORD.RESET,
      data,
    })
  }

  // 给当前登录用户发送验证码重置密码
  async sendCurrentPasswordResetCode(): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.PASSWORD.SEND_CURRENT_RESET_CODE,
    })
  }

  // 当前登录用户使用验证码重置密码
  async resetCurrentPassword(data: CurrentUserPasswordResetRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.PASSWORD.RESET_CURRENT,
      data,
    })
  }

  // 修改密码
  async changePassword(data: PasswordChangeRequest): Promise<ApiResponse> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.PASSWORD.CHANGE,
      data,
    })
  }

  // 检查密码强度（使用 POST 避免密码出现在 URL 中）
  async checkPasswordStrength(password: string): Promise<PasswordStrength> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.PASSWORD.STRENGTH,
      data: { password },
    })
  }

  // ==================== 用户管理接口 ====================

  // 获取用户资料
  async getProfile(): Promise<UserInfo> {
    return this.request({
      method: 'GET',
      url: API_ENDPOINTS.AUTH.PROFILE,
    })
  }

  async redeemInviteCode(inviteCode: string): Promise<{ user: UserInfo }> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.AUTH.REDEEM_INVITE_CODE,
      data: { invite_code: inviteCode },
    })
  }

  // 更新用户资料
  async updateProfile(data: UserProfileUpdateRequest): Promise<ApiResponse> {
    return this.request({
      method: 'PUT',
      url: API_ENDPOINTS.AUTH.PROFILE,
      data,
    })
  }

  // 获取用户偏好设置
  async getProfileSettings(): Promise<UserProfileSettings> {
    return this.request({
      method: 'GET',
      url: API_ENDPOINTS.AUTH.PROFILE_SETTINGS,
    })
  }

  // 更新用户偏好设置
  async updateProfileSettings(data: UserProfileSettingsUpdateRequest): Promise<ApiResponse> {
    return this.request({
      method: 'PUT',
      url: API_ENDPOINTS.AUTH.PROFILE_SETTINGS,
      data,
    })
  }

  // 获取个人偏好同步设置（IA Phase 2 · 6 namespace 增量信封）
  async getUISettings(): Promise<UISettingsResponse> {
    return this.request({
      method: 'GET',
      url: API_ENDPOINTS.AUTH.PROFILE_UI_SETTINGS,
    })
  }

  // 增量更新个人偏好同步设置（仅传变更的 namespace，后端 per-namespace LWW）
  async updateUISettings(data: UISettingsUpdateRequest): Promise<ApiResponse> {
    return this.request({
      method: 'PUT',
      url: API_ENDPOINTS.AUTH.PROFILE_UI_SETTINGS,
      data,
    })
  }

  // 获取个人 Agent 规则（两层规则里的个人层，跨 Organization 全局）
  async getPersonalRules(): Promise<{ personal_rules: string }> {
    return this.request({
      method: 'GET',
      url: API_ENDPOINTS.AUTH.PROFILE_PERSONAL_RULES,
    })
  }

  // 整体替换个人 Agent 规则（空串=清空个人基线层；后端上限 5000 字，超限 422）
  async updatePersonalRules(personalRules: string): Promise<ApiResponse> {
    return this.request({
      method: 'PUT',
      url: API_ENDPOINTS.AUTH.PROFILE_PERSONAL_RULES,
      data: { personal_rules: personalRules },
    })
  }

  // 草稿态预热到上游 LLM provider 的连接（best-effort，后端立即返回、后台建连）。
  async warmupLlmConnection(model: string): Promise<{ warmed?: boolean; reason?: string }> {
    return this.request({
      method: 'POST',
      url: API_ENDPOINTS.LLM.WARMUP,
      data: { model },
    })
  }

  // 获取用户会话列表
  async getSessions(): Promise<UserSession[]> {
    return this.request({
      method: 'GET',
      url: API_ENDPOINTS.SESSION.LIST,
    })
  }

  // 删除用户会话
  async deleteSession(sessionId: string): Promise<ApiResponse> {
    return this.request({
      method: 'DELETE',
      url: API_ENDPOINTS.SESSION.DELETE(sessionId),
    })
  }

  // ==================== 系统接口 ====================

  // 健康检查
  async healthCheck(): Promise<RuntimeVersionInfo> {
    return this.request({
      method: 'GET',
      url: API_ENDPOINTS.AUTH.HEALTH,
    })
  }

  // Extract 模块方法已移除：后端 /extract/ 下无 recommend-schemas /
  // history-schemas / save-user-schema / record-schema-usage 路由，
  // 原方法（queryHistorySchemas / generateRecommendations /
  // saveUserSchema / recordSchemaUsage）全部是死代码，调用必 404。
  // 如需恢复，须先在后端 apps/tabtin_django 注册对应路由。
}

// 创建单例实例
export const apiService = new ApiService()

// 导出类型和实例
export default apiService
export type { ApiService }
