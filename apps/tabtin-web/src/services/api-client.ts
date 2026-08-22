import { ApiError, createApiClient, type TabTinApiClient } from '@tabtin/api-client'
import { API_BASE_URL } from '@/config/api'
import {
  authAdapter,
  hasNativeAuthHost,
  refreshAccessTokenFromNativeHost,
  STORAGE_KEYS,
} from '@/platform'
import { resetSessionState } from '@/stores/session-reset'
import { updateAuthState } from '@/stores/auth-state-bridge'
import { refreshAccessToken } from './token-refresh'
import type { UserInfo } from '@/types/auth'

let _client: TabTinApiClient | null = null
const INVITE_CODE_REQUIRED = 'INVITE_CODE_REQUIRED'

function clearAuthState() {
  authAdapter.clear()
  resetSessionState()
  updateAuthState({ isAuthenticated: false, user: null })
}

async function markInviteCodeRequired() {
  const snapshot = await authAdapter.getSnapshot()
  if (!snapshot.user) return
  const user = {
    ...(snapshot.user as UserInfo),
    invite_code_required: true,
    invite_code_redeemed: false,
  }
  await authAdapter.save({
    accessToken: snapshot.accessToken,
    refreshToken: snapshot.refreshToken,
    expiresAt: snapshot.expiresAt,
    user,
  })
  updateAuthState({ isAuthenticated: false, user })
}

export function getApiClient(): TabTinApiClient {
  if (!_client) {
    const client = createApiClient({
      baseUrl: API_BASE_URL || `${window.location.origin}/api`,
      clientType: 'web',
      getToken: () => localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
      onUnauthorized: () => {
        clearAuthState()
      },
      refresh: {
        getRefreshToken: () => hasNativeAuthHost()
          ? { delegateToMain: true as const }
          : localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN),
        onRefreshToken: async (refreshToken) => {
          if (hasNativeAuthHost()) {
            return refreshAccessTokenFromNativeHost(authAdapter)
          }
          if (!refreshToken) return null
          const result = await refreshAccessToken(refreshToken, authAdapter)
          if (!result) return null

          if (result.user) {
            updateAuthState({
              user: result.user as UserInfo,
              isAuthenticated: true,
            })
          }

          return { access_token: result.access_token, refresh_token: result.refresh_token }
        },
        onRefreshFailed: () => {
          // 由 createApiClient 内部统一调用 onUnauthorized
        },
      },
    })
    const raw = client.raw
    client.raw = (async (...args: Parameters<typeof raw>) => {
      try {
        return await raw(...args)
      } catch (error) {
        if (error instanceof ApiError && error.code === INVITE_CODE_REQUIRED) {
          await markInviteCodeRequired()
        }
        throw error
      }
    }) as typeof raw
    _client = client
  }
  return _client
}
