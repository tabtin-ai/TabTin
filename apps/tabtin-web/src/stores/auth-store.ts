import { create } from 'zustand'
import { persist } from 'zustand/middleware'
import { toast } from '@tabtin/smartsheet-ui'
import { authApi } from '@/services/auth-api'
import {
  authAdapter,
  hasNativeAuthHost,
  refreshAccessTokenFromNativeHost,
} from '@/platform'
import { isNetworkError } from '@/services/network-error'
import { refreshAccessToken } from '@/services/token-refresh'
import { resetSessionState } from './session-reset'
import { withPersistSafety } from '@tabtin/shared'
import { extractErrorMessage } from '@/utils/extract-api-error'
import { registerAuthStateUpdater } from './auth-state-bridge'
import { refreshStoredUserProfile } from './auth-profile-refresh'
import type {
  UserInfo,
  LoginRequest,
  VerificationCodeLoginRequest,
  RegisterRequest,
} from '@/types/auth'

const INIT_AUTH_TIMEOUT_MS = 10_000

interface AuthState {
  isInitializing: boolean
  isAuthenticated: boolean
  user: UserInfo | null
  isLoading: boolean
  error: string | null
}

interface AuthActions {
  login: (data: LoginRequest) => Promise<void>
  loginWithVerificationCode: (data: VerificationCodeLoginRequest) => Promise<void>
  register: (data: RegisterRequest) => Promise<void>
  redeemInviteCode: (inviteCode: string) => Promise<void>
  logout: () => Promise<void>
  initAuth: () => Promise<void>
}

async function showToast(message: string, variant?: 'default' | 'destructive') {
  toast({ title: message, variant })
}

async function tryRefreshToken(): Promise<boolean> {
  if (hasNativeAuthHost()) {
    try {
      return (await refreshAccessTokenFromNativeHost(authAdapter)) !== null
    } catch (err) {
      if (isNetworkError(err)) {
        await showToast(extractErrorMessage(err, 'errors.networkErrorDetail'), 'destructive')
      }
      return false
    }
  }

  const snapshot = await authAdapter.getSnapshot()
  if (!snapshot.refreshToken) return false

  try {
    const result = await refreshAccessToken(snapshot.refreshToken, authAdapter)
    return result !== null
  } catch (err) {
    if (isNetworkError(err)) {
      await showToast(extractErrorMessage(err, 'errors.networkErrorDetail'), 'destructive')
    }
    return false
  }
}

let _visibilityHandler: (() => void) | null = null

function needsInviteCode(user: UserInfo | null): boolean {
  return Boolean(user?.invite_code_required && !user?.invite_code_redeemed)
}

function isUserFullyAuthenticated(user: UserInfo | null): boolean {
  return Boolean(user && !needsInviteCode(user))
}

async function refreshProfileFromServer(): Promise<void> {
  const startedSnapshot = await authAdapter.getSnapshot()
  const storedUser = startedSnapshot.user as UserInfo | null
  if (!startedSnapshot.accessToken || !storedUser) return

  await refreshStoredUserProfile({
    storedUser,
    loadProfile: () => authApi.getProfile(),
    persistUser: async (latestUser) => {
      const currentSnapshot = await authAdapter.getSnapshot()
      const currentState = useAuthStore.getState()
      if (
        !currentState.isAuthenticated
        || currentSnapshot.accessToken !== startedSnapshot.accessToken
      ) {
        return
      }

      await authAdapter.save({
        accessToken: currentSnapshot.accessToken,
        refreshToken: currentSnapshot.refreshToken,
        expiresAt: currentSnapshot.expiresAt,
        user: latestUser,
      })
      useAuthStore.setState({
        user: latestUser,
        isAuthenticated: isUserFullyAuthenticated(latestUser),
      })
    },
  })
}

function registerVisibilityRefresh() {
  if (_visibilityHandler) {
    document.removeEventListener('visibilitychange', _visibilityHandler)
  }

  _visibilityHandler = async () => {
    if (document.visibilityState !== 'visible') return
    const { isAuthenticated } = useAuthStore.getState()
    if (!isAuthenticated) return

    const expiringSoon = await authAdapter.isTokenExpiringSoon?.(5)
    if (expiringSoon) {
      const success = await tryRefreshToken()
      if (success) {
        const snapshot = await authAdapter.getSnapshot()
        const user = snapshot.user as UserInfo | null
        useAuthStore.setState({
          user,
          isAuthenticated: isUserFullyAuthenticated(user),
        })
      }
    }
  }

  document.addEventListener('visibilitychange', _visibilityHandler)
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), ms)
    promise.then(resolve, reject).finally(() => clearTimeout(timer))
  })
}

export const useAuthStore = create<AuthState & AuthActions>()(
  persist(
    (set) => ({
      isInitializing: true,
      isAuthenticated: false,
      user: null,
      isLoading: false,
      error: null,

      login: async (data) => {
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.login(data)
          await authAdapter.save({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            user: response.user,
            expiresAt: null,
          })
          set({ isAuthenticated: isUserFullyAuthenticated(response.user), user: response.user, isLoading: false })
        } catch (err: unknown) {
          const message = extractErrorMessage(err, 'errors.loginFailed')
          set({ isLoading: false, error: message })
          if (isNetworkError(err)) {
            await showToast(extractErrorMessage(err, 'errors.networkErrorDetail'), 'destructive')
          }
          throw err
        }
      },

      loginWithVerificationCode: async (data) => {
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.loginWithVerificationCode(data)
          await authAdapter.save({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            user: response.user,
            expiresAt: null,
          })
          set({ isAuthenticated: isUserFullyAuthenticated(response.user), user: response.user, isLoading: false })
        } catch (err: unknown) {
          const message = extractErrorMessage(err, 'errors.loginFailed')
          set({ isLoading: false, error: message })
          if (isNetworkError(err)) {
            await showToast(extractErrorMessage(err, 'errors.networkErrorDetail'), 'destructive')
          }
          throw err
        }
      },

      register: async (data) => {
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.register(data)
          await authAdapter.save({
            accessToken: response.access_token,
            refreshToken: response.refresh_token,
            user: response.user,
            expiresAt: null,
          })
          set({ isAuthenticated: isUserFullyAuthenticated(response.user), user: response.user, isLoading: false })
        } catch (err: unknown) {
          const message = extractErrorMessage(err, 'errors.registerFailed')
          set({ isLoading: false, error: message })
          if (isNetworkError(err)) {
            await showToast(extractErrorMessage(err, 'errors.networkErrorDetail'), 'destructive')
          }
          throw err
        }
      },

      redeemInviteCode: async (inviteCode) => {
        const trimmedCode = inviteCode.trim()
        if (!trimmedCode) {
          throw new Error('请输入邀请码')
        }
        set({ isLoading: true, error: null })
        try {
          const response = await authApi.redeemInviteCode(trimmedCode)
          const updatedUser = response.user
          if (!updatedUser) {
            throw new Error('邀请码验证失败')
          }
          const snapshot = await authAdapter.getSnapshot()
          await authAdapter.save({
            accessToken: snapshot.accessToken,
            refreshToken: snapshot.refreshToken,
            user: updatedUser,
            expiresAt: snapshot.expiresAt,
          })
          set({ isAuthenticated: isUserFullyAuthenticated(updatedUser), user: updatedUser, isLoading: false, error: null })
          await showToast('邀请码已验证，欢迎使用 TabTin')
        } catch (err: unknown) {
          const message = extractErrorMessage(err, 'errors.inviteCodeFailed')
          set({ isLoading: false, error: message })
          throw err
        }
      },

      logout: async () => {
        try {
          await authApi.logout()
        } finally {
          await authAdapter.clear()
          resetSessionState()
          set({ isAuthenticated: false, user: null, error: null })
        }
      },

      initAuth: async () => {
        try {
          await withTimeout((async () => {
            const snapshot = await authAdapter.getSnapshot()
            if (!snapshot.accessToken) {
              set({ isAuthenticated: false, user: null })
              return
            }

            const expiringSoon = await authAdapter.isTokenExpiringSoon?.(5)
            if (expiringSoon) {
              const refreshed = await tryRefreshToken()
              if (refreshed) {
                const newSnapshot = await authAdapter.getSnapshot()
                const user = newSnapshot.user as UserInfo | null
                set({
                  isAuthenticated: isUserFullyAuthenticated(user),
                  user,
                })
              } else {
                const hasRefreshToken = !!snapshot.refreshToken
                if (!hasRefreshToken && !hasNativeAuthHost()) {
                  await authAdapter.clear()
                  set({ isAuthenticated: false, user: null })
                }
              }
            } else {
              const user = snapshot.user as UserInfo | null
              set({
                isAuthenticated: isUserFullyAuthenticated(user),
                user,
              })
            }

            registerVisibilityRefresh()
            void refreshProfileFromServer()
          })(), INIT_AUTH_TIMEOUT_MS)
        } catch {
          set({ isAuthenticated: false, user: null })
        } finally {
          set({ isInitializing: false })
        }
      },

    }),
    withPersistSafety({
      name: 'tabtin-auth-storage',
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        user: state.user,
      }),
    }),
  ),
)

registerAuthStateUpdater((state) => {
  useAuthStore.setState({
    ...state,
    isAuthenticated: state.isAuthenticated && isUserFullyAuthenticated(state.user),
  })
})

export const selectNeedsInviteCode = (state: AuthState & AuthActions) =>
  Boolean(state.user?.invite_code_required && !state.user.invite_code_redeemed)
