/** @store-category domain */

import { create } from 'zustand'
import { createJSONStorage, persist, subscribeWithSelector } from 'zustand/middleware'
import { AuthState, AuthPhase, LoginRequest, LoginResponse, RegisterRequest, VerificationCodeLoginRequest, LogoutReason, UserInfo, UserProfileUpdateRequest } from '@/types/auth'
import apiService from '@/services/api'
import { useI18nStore } from './useI18nStore'
import { resetSessionState } from './sessionReset'
import i18n from '@/i18n'
import { toast } from '@tabtin/smartsheet-ui'
import { createLogger } from '@/utils/logger'
import { fetchUploadConfig } from '@/constants/upload'
import { setAuthSyncHandler, setAuthLogoutHandler } from '@/utils/authPersistence'
import { extractErrorMessage, extractStorableErrorMessage } from '@/utils/extract-api-error'
import { withPersistSafety, createMigratingStorage } from '@tabtin/shared'
import { PERSIST_KEYS } from './persist-key-registry'
import { useSessionReadStore } from './useSessionReadStore'
import { queryClient } from '@/lib/query-client'

const log = createLogger('Auth')

/**
 * TabDoc collab 等旁路走 refreshAuthToken；须与 api.handleRefreshFailure 同口径：
 * 瞬时失败保留凭证，仅确定性拒绝才 logout。
 */
const TRANSIENT_TOKEN_REFRESH_MESSAGE_PATTERNS = [
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

export function isTransientTokenRefreshFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') {
    return typeof error === 'string'
      ? TRANSIENT_TOKEN_REFRESH_MESSAGE_PATTERNS.some((p) => error.toLowerCase().includes(p))
      : false
  }
  const typed = error as { isTransient?: boolean; message?: string; authErrorCode?: string }
  // : 限流绝不能当 token 失效（即便上游漏标 isTransient）
  if (typed.authErrorCode === 'RATE_LIMITED') return true
  if (typed.isTransient === true) return true
  if (typed.isTransient === false) return false
  const msg = (typed.message ?? String(error)).toLowerCase()
  return TRANSIENT_TOKEN_REFRESH_MESSAGE_PATTERNS.some((p) => msg.includes(p))
}

/** 认证态与 IM 公共资料缓存共用同一份最新用户资料，避免昵称或头像跨界面不一致。 */
function syncUserProfileCache(user: UserInfo | null | undefined): void {
  if (!user?.id) return
  // IM 是按需加载模块；避免认证基础 store 在启动时反向拉入完整 IM API 依赖图。
  void import('./useUserProfileCache')
    .then(({ useUserProfileCache }) => {
      useUserProfileCache.getState().upsertProfile({
        id: user.id,
        nickname: user.nickname,
        username: user.username,
        avatar: user.avatar,
      })
    })
    .catch((error) => log.warn('Failed to sync IM user profile cache:', error))
}

/** 登录成功后的统一处理逻辑（密码登录和验证码登录共享） */
async function handleLoginSuccess(
  set: (partial: Partial<AuthStore>) => void,
  response: LoginResponse,
): Promise<void> {
  const { access_token, refresh_token, user } = response

  // 设置 API 服务的认证 Token
  apiService.setAuthToken(access_token)

  // 保存到安全存储
  await window.tabtin.auth.save(access_token, refresh_token, user)

  // 更新状态
  set({
    authPhase: 'authenticated' as const,
    user,
    accessToken: access_token,
    refreshToken: refresh_token,
    isLoading: false,
    error: null,
    logoutReason: null,
  })
  syncUserProfileCache(user)
  if (user?.id != null) {
    useSessionReadStore.getState().restoreForAccount(String(user.id))
  }

  // 关键状态迁移：认证态置为 authenticated（只打 userId，绝不打 token/手机号/邮箱）
  log.info('Auth phase → authenticated:', { userId: user?.id })

  // 同步语言设置（后端优先，fire-and-forget 不阻塞 authReady）
  void useI18nStore.getState().syncFromServer().catch(e =>
    log.warn('i18n sync failed:', e)
  )

  // 登录后强制重新拉取上传配置（启动时未登录拿到的是安全默认值）
  fetchUploadConfig(true).catch(() => {})
}

async function refreshProfileFromServer(
  set: (partial: Partial<AuthStore>) => void,
  get: () => AuthStore,
): Promise<void> {
  const startedWithAccessToken = get().accessToken
  if (!startedWithAccessToken || get().authPhase !== 'authenticated') return

  try {
    const refreshedUser = await apiService.getProfile()
    const current = get()
    if (
      current.authPhase !== 'authenticated'
      || current.accessToken !== startedWithAccessToken
    ) {
      return
    }

    set({ user: refreshedUser })
    syncUserProfileCache(refreshedUser)
    if (current.accessToken && current.refreshToken) {
      await window.tabtin.auth.save(
        current.accessToken,
        current.refreshToken,
        refreshedUser,
      )
    }
  } catch (error) {
    log.warn('profile refresh failed:', error)
  }
}

function extractAuthErrorMessage(error: unknown, fallbackKey: string): string {
  return extractErrorMessage(error, fallbackKey, undefined, 'auth')
}

function extractStorableAuthErrorMessage(error: unknown, fallbackKey: string): string {
  return extractStorableErrorMessage(error, fallbackKey, undefined, 'auth')
}

interface AuthStore extends AuthState {
  // 操作方法
  login: (data: LoginRequest) => Promise<void>
  loginWithVerificationCode: (data: VerificationCodeLoginRequest) => Promise<void>
  register: (data: RegisterRequest) => Promise<void>
  redeemInviteCode: (inviteCode: string) => Promise<void>
  logout: (reason?: LogoutReason) => Promise<void>
  refreshAuthToken: () => Promise<void>
  updateProfile: (data: UserProfileUpdateRequest) => Promise<void>
  refreshProfile: () => Promise<void>
  loadAuthFromStorage: () => Promise<void>
  clearAuth: () => void
  setLoading: (loading: boolean) => void
  setError: (error: string | null) => void
}

let _isLoggingOut = false
let _stopTokenCheckFn: (() => void) | null = null

export const useAuthStore = create<AuthStore>()(
  subscribeWithSelector(
    persist(
      (set, get) => ({
        // 初始状态
        authPhase: 'initializing' as AuthPhase,
        user: null,
        accessToken: null,
        refreshToken: null,
        isLoading: false,
        error: null,
        logoutReason: null,

        // 用户登录
        login: async (data: LoginRequest) => {
          set({ isLoading: true, error: null })

          try {
            const response = await apiService.login(data)
            await handleLoginSuccess(set, response)
          } catch (error: any) {
            log.error('Login failed:', error)
            set({
              isLoading: false,
              error: extractStorableAuthErrorMessage(error, 'errors.loginFailed')
            })
            throw error
          }
        },

        // 验证码登录
        loginWithVerificationCode: async (data: VerificationCodeLoginRequest) => {
          set({ isLoading: true, error: null })

          try {
            const response = await apiService.loginWithVerificationCode(data)
            await handleLoginSuccess(set, response)
          } catch (error: any) {
            log.error('Verification-code login failed:', error)
            set({
              isLoading: false,
              error: extractStorableAuthErrorMessage(error, 'errors.codeLoginFailed')
            })
            throw error
          }
        },

        // 用户注册（注册成功后自动登录）
        register: async (data: RegisterRequest) => {
          set({ isLoading: true, error: null })

          try {
            const response = await apiService.register(data)
            await handleLoginSuccess(set, response)
            toast({ title: i18n.t('registerSuccess', { ns: 'auth', defaultValue: '注册成功，欢迎使用 TabTin！' }) })
          } catch (error: any) {
            log.error('Register failed:', error)
            set({
              isLoading: false,
              error: extractAuthErrorMessage(error, 'errors.registerFailed')
            })
            throw error
          }
        },

        redeemInviteCode: async (inviteCode: string) => {
          const trimmedCode = inviteCode.trim()
          if (!trimmedCode) {
            throw new Error('请输入邀请码')
          }
          set({ isLoading: true, error: null })

          try {
            const response = await apiService.redeemInviteCode(trimmedCode)
            const updatedUser = response.user
            if (!updatedUser) {
              throw new Error('邀请码验证失败')
            }
            const current = get()
            set({
              user: updatedUser,
              isLoading: false,
              error: null,
            })
            if (current.accessToken && current.refreshToken) {
              await window.tabtin.auth.save(current.accessToken, current.refreshToken, updatedUser)
            }
            toast({ title: '邀请码已验证，欢迎使用 TabTin' })
          } catch (error: any) {
            set({
              isLoading: false,
              error: error.message || '邀请码验证失败',
            })
            throw error
          }
        },

        // 用户登出
        logout: async (reason?: LogoutReason) => {
          if (_isLoggingOut) return

          //  / : 已未登录且无内存凭证时短路，避免 force-logout 风暴重复 reset
          const currentPhase = get().authPhase
          const hasInMemoryCreds = Boolean(get().accessToken || get().refreshToken)
          if (currentPhase === 'unauthenticated' && !hasInMemoryCreds) {
            log.info('Logout skipped (already unauthenticated):', {
              reason: reason ?? 'manual',
            })
            return
          }

          _isLoggingOut = true
          _stopTokenCheckFn?.()

          const resolvedReason = reason ?? 'manual'
          const hadAuth = get().authPhase === 'authenticated'
          // 关键生命周期切换：登出起点（记原因 + 是否已认证，不打任何凭证）
          log.info('Logout started:', { reason: resolvedReason, hadAuth })

          // LH2-D2：在 set null / resetSessionState 之前抓住 owner 信息——
          // store reset 后这两个字段都会清空，错过这一刻就无法精确按 owner
          // 清主进程的 sync 目录（fallback 到"清整个 syncRoot"会误删其他账号
          // 数据，违反 LH2-D2 的"只清当前账号"约束）。
          const currentUser = get().user
          if (currentUser?.id != null) {
            useSessionReadStore.getState().preserveForAccount(String(currentUser.id))
          }
          let logoutOwner: { userId: string; organizationId: string } | null = null
          try {
            // 动态 import 避免在 store 顶层引入循环依赖（useOrganizationStore
            // 来自 @tabtin/app-shell，与 useAuthStore 互相 import 会成环）。
            const { useOrganizationStore } = await import('@tabtin/app-shell')
            const wt = useOrganizationStore.getState().selectedOrganization
            const userId = currentUser?.id != null ? String(currentUser.id) : ''
            const organizationId = wt?.id ? String(wt.id) : ''
            if (userId && organizationId) {
              logoutOwner = { userId, organizationId }
            }
          } catch (e) {
            log.warn('failed to resolve logout owner:', e)
          }

          try {
            if (hadAuth) {
              apiService.logout().catch((err) => {
                log.warn('Server-side logout failed (local cleanup unaffected):', err)
              })
            }

            apiService.clearAuth()

            await window.tabtin.auth.clear()

            // 先标记未认证，阻断 clearDevices → reportOffline → 401 → notifyLogoutRequired 循环
            set({
              logoutReason: resolvedReason,
              authPhase: 'unauthenticated' as const,
              user: null,
              accessToken: null,
              refreshToken: null,
              error: null,
            })

            await resetSessionState('logout')

            // LH2-D2：通知主进程清当前账号 sync 目录 + 关掉对应 SyncQueue。
            // **必须在 resetSessionState 之后**——sessionResetRegistry 会
            // 触发 chat-client teardown / abort 进行中的 query，等他们走完
            // 再清 sync 目录，避免还有 in-flight syncQueue.flush 在写盘时被
            // 拔地基。如果 owner 未能解析（例如登录前直接登出），这里 no-op
            // 并打日志，不阻塞登出主流程。
            //
            // 产品 Review LH2-D2 follow-up：必须区分 IPC 业务失败（result.success=false）
            // 与 IPC 通道异常。前者通常是 fs 权限 / dispose 失败，应明确 warn
            // 让运维知道"本地 sync 目录可能未清空"；后者是 preload/IPC 没就绪。
            if (logoutOwner && window.tabtin?.agentEngine?.resetAccountSync) {
              try {
                const result = await window.tabtin.agentEngine.resetAccountSync(logoutOwner)
                if (result?.success) {
                  log.info('reset-account-sync done:', {
                    userId: logoutOwner.userId,
                    organizationId: logoutOwner.organizationId,
                    clearedFiles: result.clearedFiles,
                  })
                } else {
                  log.warn(
                    'reset-account-sync returned failure — local sync dir may still contain residual transcripts:',
                    {
                      userId: logoutOwner.userId,
                      organizationId: logoutOwner.organizationId,
                      error: result?.error,
                    },
                  )
                }
              } catch (e) {
                log.warn('reset-account-sync IPC threw (ignored, logout continues):', e)
              }
            } else {
              log.warn(
                'reset-account-sync skipped — local sync dir for this account will NOT be cleaned',
                { hasOwner: !!logoutOwner, hasIpc: !!window.tabtin?.agentEngine?.resetAccountSync },
              )
            }

            log.info('Logout completed, all business data cleared:', { reason: resolvedReason })
          } catch (error: any) {
            log.error('Logout failed (forcing unauthenticated):', error)
            set({
              logoutReason: resolvedReason,
              authPhase: 'unauthenticated' as const,
              user: null,
              accessToken: null,
              refreshToken: null,
              error: null,
            })
            await resetSessionState('logout')
          } finally {
            _isLoggingOut = false
          }
        },

        // 刷新认证Token — 委托主进程 TokenManager 完成，避免渲染进程直接操作 refresh token
        refreshAuthToken: async () => {
          try {
            // contract W2-β：旧 envelope `{success, accessToken, message}` 改为 invokeIpc 自动 throw。
            // 确定性拒绝（过期/吊销）才 logout；瞬时网络失败对齐 api.handleRefreshFailure / ，保留凭证。
            await window.tabtin.auth.refreshAccessToken()

            // 主进程已将新 token 持久化到 Keychain，读取完整 token bundle 同步到渲染进程
            const authData = await window.tabtin.auth.load()
            if (!authData?.accessToken) {
              throw new Error('Failed to load refreshed tokens from storage')
            }

            apiService.setAuthToken(authData.accessToken)

            set({
              accessToken: authData.accessToken,
              refreshToken: authData.refreshToken,
              user: authData.user,
            })
          } catch (error: any) {
            if (isTransientTokenRefreshFailure(error)) {
              log.warn('Token refresh failed transiently, keeping credentials:', error)
              throw error
            }
            log.error('Token refresh failed, logging out (token_expired):', error)
            await get().logout('token_expired')
            throw error
          }
        },

        // 更新用户资料
        updateProfile: async (data: UserProfileUpdateRequest) => {
          set({ isLoading: true, error: null })

          try {
            await apiService.updateProfile(data)

            // 重新获取用户信息
            const updatedUser = await apiService.getProfile()

            // 更新本地用户信息
            set({
              user: updatedUser,
              isLoading: false,
              error: null
            })
            syncUserProfileCache(updatedUser)
            // TabData 的用户字段以组织成员目录为展示基线；本人改名后立即重拉，
            // 避免已打开的数据表继续使用更新前的成员查询结果。
            void queryClient.invalidateQueries({ queryKey: ['members'] })

            // 同步到安全存储
            const { accessToken, refreshToken } = get()
            if (accessToken && refreshToken) {
              await window.tabtin.auth.save(accessToken, refreshToken, updatedUser)
            }
          } catch (error: any) {
            set({
              isLoading: false,
              error: extractAuthErrorMessage(error, 'errors.updateProfileFailed')
            })
            throw error
          }
        },

        refreshProfile: async () => {
          await refreshProfileFromServer(set, get)
        },

        // 从存储加载认证信息
        loadAuthFromStorage: async () => {
          try {
            const authData = await window.tabtin.auth.load()

            if (authData && authData.accessToken) {
              // 检查 token 是否即将过期，若即将过期则尝试主动刷新
              let activeAccessToken = authData.accessToken
              try {
                const expiryCheck = await window.tabtin.auth.isTokenExpiringSoon(5)
                if (expiryCheck?.success && expiryCheck.isExpiring && authData.refreshToken) {
                  log.info('Token expiring soon, attempting refresh...')
                  const newToken = await apiService.tryRefreshTokens()
                  if (newToken) {
                    const freshAuth = await window.tabtin.auth.load()
                    if (freshAuth?.accessToken) {
                      activeAccessToken = freshAuth.accessToken
                      authData.refreshToken = freshAuth.refreshToken
                      if (freshAuth.user) {
                        authData.user = freshAuth.user
                      }
                    }
                    log.info('Startup token refresh succeeded')
                  } else {
                    // ：tryRefreshTokens 失败不抛错（返回 null），必须区分两类失败：
                    // - 确定性拒绝（401/403/404）：主进程已 clearAuthData()，重读 bundle
                    //   为空。此时绝不能带着旧 token 进入 authenticated 态，否则 UI 会在
                    //   凭证已被清掉的情况下"演已登录"（Agent 设置可编辑但保存全 401）。
                    // - 瞬时失败（网络/超时/5xx）：主进程保留凭证，bundle 仍有 token，
                    //   维持"保留现有 token"的既有设计（见 api.ts handleRefreshFailure）。
                    const bundleAfterFailure = await window.tabtin.auth.load().catch(() => null)
                    if (!bundleAfterFailure?.accessToken) {
                      log.warn('Startup token refresh rejected and credentials cleared, entering unauthenticated')
                      set({
                        authPhase: 'unauthenticated' as const,
                        user: null,
                        accessToken: null,
                        refreshToken: null,
                        logoutReason: 'token_expired' as const,
                      })
                      // 清掉持久化的会话内缓存（organization/space/agent 等），避免登录页
                      // 背后残留上一会话数据。与 handleRefreshFailure 触发的并发 logout
                      // 重复执行是幂等的。
                      await resetSessionState('token_refresh_failed')
                      return
                    }
                    log.warn('Startup token refresh failed transiently, using existing token')
                  }
                }
              } catch (error) {
                log.warn('Token expiry check failed:', error)
              }

              // 设置API服务的认证Token
              apiService.setAuthToken(activeAccessToken)

              // 更新状态
              set({
                authPhase: 'authenticated' as const,
                user: authData.user,
                accessToken: activeAccessToken,
                refreshToken: authData.refreshToken,
              })
              if (authData.user?.id != null) {
                useSessionReadStore.getState().restoreForAccount(String(authData.user.id))
              }

              // 同步语言设置（后端优先，fire-and-forget 不阻塞 authReady）
              void useI18nStore.getState().syncFromServer().catch(e =>
                log.warn('i18n sync failed:', e)
              )

              // 状态迁移：从本地存储恢复登录态成功
              log.info('Auth restored from storage → authenticated:', { userId: authData.user?.id })

              // UAVTR-4: 持久化 user.avatar 可能是裸 OSS URL 或过期签名。
              // 启动恢复登录态后后台刷新 profile，拿到后端重新签名后的头像。
              void refreshProfileFromServer(set, get)

            } else {
              // 没有存储的认证信息，确保状态为未认证
              set({
                authPhase: 'unauthenticated' as const,
                user: null,
                accessToken: null,
                refreshToken: null,
              })
              log.info('No stored auth → unauthenticated')
            }
          } catch (error: any) {
            log.error('Failed to load auth info (entering unauthenticated):', error)
            // 加载失败，清除状态
            set({
              authPhase: 'unauthenticated' as const,
              user: null,
              accessToken: null,
              refreshToken: null,
              error: i18n.t('errors.loadAuthFailed', { ns: 'auth' }),
            })
          }
        },

        // 清除认证状态
        clearAuth: () => {
          set({
            authPhase: 'unauthenticated' as const,
            user: null,
            accessToken: null,
            refreshToken: null,
            error: null,
          })
        },

        // 设置加载状态
        setLoading: (loading: boolean) => {
          set({ isLoading: loading })
        },

        // 设置错误信息
        setError: (error: string | null) => {
          set({ error })
        },
      }),
      withPersistSafety({
        name: PERSIST_KEYS.auth,
        storage: createJSONStorage(() => createMigratingStorage(localStorage, ['tabtin-auth-store'])),
        partialize: (state) => ({
          authPhase: state.authPhase === 'initializing' ? 'unauthenticated' as const : state.authPhase,
          user: state.user,
          logoutReason: state.logoutReason,
        }),
        version: 3,
        migrate: (persisted: unknown, version: number) => {
          const state = persisted as Record<string, unknown>
          if (version < 3 && state && !('authPhase' in state)) {
            state.authPhase = state.isAuthenticated ? 'authenticated' : 'unauthenticated'
            delete state.isAuthenticated
          }
          return state
        },
      })
    )
  )
)

const needsInviteCode = (user: AuthStore['user']) =>
  Boolean(user?.invite_code_required && !user?.invite_code_redeemed)

/** 消费方 selector：判断是否已完成认证准入（替代原 s.isAuthenticated） */
export const selectIsAuthenticated = (s: AuthStore) =>
  s.authPhase === 'authenticated' && !needsInviteCode(s.user)

export const selectNeedsInviteCode = (s: AuthStore) =>
  s.authPhase === 'authenticated' && needsInviteCode(s.user)

// 初始化时从安全存储加载认证信息
export const authReadyPromise: Promise<void> = (typeof window !== 'undefined')
  ? (() => {
      log.info('Loading auth data...')
      return useAuthStore.getState().loadAuthFromStorage()
        .then(() => {
          const state = useAuthStore.getState()
          log.info('Auth data loaded:', {
            authPhase: state.authPhase,
            hasUser: !!state.user,
            hasAccessToken: !!state.accessToken,
          })
          // organization membership 预取由 prefetchOrganizationBillingData 在 organization 初始化时触发
        })
        .catch(error => {
          log.error('Failed to initialize auth state:', error)
        })
    })()
  : Promise.resolve()

// 监听认证状态变化，自动处理Token过期
useAuthStore.subscribe(
  (state) => state.authPhase,
  (authPhase) => {
    if (authPhase !== 'authenticated') {
      apiService.clearAuth()
    }
  }
)

// ── 内部通道：接收来自 api.ts 等可信模块的 auth 状态更新 ──
// 数据通过 JS 闭包传递，不经过 DOM，外部脚本/扩展无法拦截或注入。
setAuthSyncHandler(({ accessToken, refreshToken, user }) => {
  if (accessToken) {
    useAuthStore.setState({
      accessToken,
      refreshToken: refreshToken ?? useAuthStore.getState().refreshToken,
      ...(user ? { user } : {}),
    })
    syncUserProfileCache(user)
  }
})

setAuthLogoutHandler((reason) => {
  void useAuthStore.getState().logout(reason as LogoutReason)
})

if (typeof window !== 'undefined' && !window.__tabtin_auth_logout_event_bound__) {
  window.__tabtin_auth_logout_event_bound__ = true

  // CL-1/CL-2 完成迁移：logout / token 同步事件生产者已迁移至内部通道
  // （authPersistence.ts 闭包）。下面的 invite gate 事件只在 renderer 内
  // 由 apiService 发出，用于把服务端强准入结果同步回 auth store。

  window.addEventListener('auth:invite-code-required', () => {
    const state = useAuthStore.getState()
    if (!state.user || state.authPhase !== 'authenticated') return
    const updatedUser = {
      ...state.user,
      invite_code_required: true,
      invite_code_redeemed: false,
    }
    useAuthStore.setState({ user: updatedUser })
    if (state.accessToken && state.refreshToken) {
      void window.tabtin.auth.save(state.accessToken, state.refreshToken, updatedUser)
    }
  })

  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && useAuthStore.getState().authPhase === 'authenticated') {
      void apiService.ensureValidToken()
    }
  })

  // AUTH-RENEW: 定期检查 token 有效性并在即将过期时自动刷新。
  // 覆盖长时间会话中无 API 调用的场景（如持续编辑设计稿），
  // 确保 access token 不会在用户无感知的情况下过期。
  // ensureValidToken 内部有 5 分钟缓冲期 + 带锁去重，不会重复刷新。
  // 后台（document.hidden）时暂停，避免后台窗口持续唤醒 CPU。
  const TOKEN_CHECK_INTERVAL_MS = 10 * 60 * 1000 // 10 分钟
  let _tokenCheckTimer: ReturnType<typeof setInterval> | null = null
  const startTokenCheck = () => {
    if (_tokenCheckTimer) return
    _tokenCheckTimer = setInterval(() => {
      if (useAuthStore.getState().authPhase === 'authenticated') {
        void apiService.ensureValidToken()
      }
    }, TOKEN_CHECK_INTERVAL_MS)
  }
  const stopTokenCheck = () => {
    if (_tokenCheckTimer) {
      clearInterval(_tokenCheckTimer)
      _tokenCheckTimer = null
    }
  }
  _stopTokenCheckFn = stopTokenCheck
  if (!document.hidden) startTokenCheck()
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
      stopTokenCheck()
    } else {
      startTokenCheck()
    }
  })

  if (window.tabtin?.auth?.onForceLogout) {
    // 兄弟窗口 refresh 失败会广播 force-logout；若本窗刚写入新凭证，应 rehydrate 而非 logout。
    window.tabtin.auth.onForceLogout(() => {
      log.info('Received cross-window force-logout')
      void (async () => {
        try {
          const bundle = await window.tabtin.auth.load()
          if (bundle?.accessToken) {
            log.info('Ignoring force-logout: credentials still present, rehydrating store')
            await useAuthStore.getState().loadAuthFromStorage()
            return
          }
        } catch (error) {
          log.warn('force-logout credential check failed, falling back to logout:', error)
        }
        const { authPhase, accessToken, refreshToken } = useAuthStore.getState()
        if (authPhase === 'unauthenticated' && !accessToken && !refreshToken) {
          log.info('Ignoring force-logout: already unauthenticated')
          return
        }
        await useAuthStore.getState().logout('token_refresh_failed')
      })()
    })
  }

  if (window.tabtin?.auth?.onTokenRefreshed) {
    window.tabtin.auth.onTokenRefreshed(async () => {
      try {
        const bundle = await window.tabtin.auth.load()
        if (bundle?.accessToken) {
          apiService.setAuthToken(bundle.accessToken)
          useAuthStore.setState({
            accessToken: bundle.accessToken,
            refreshToken: bundle.refreshToken,
            user: bundle.user,
          })
        }
      } catch (e) {
        log.warn('Failed to reload bundle after token refresh signal:', e)
      }
    })
  }

  if (window.tabtin?.agentMonitor?.onEmitInterrupted) {
    window.tabtin.agentMonitor.onEmitInterrupted(() => {
      toast({
        title: i18n.t('monitor:emitInterrupted'),
        variant: 'destructive',
      })
    })
  }
}
