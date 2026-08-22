import { API_ENDPOINTS } from '@tabtin/config'
import { RefreshTemporarilyUnavailableError } from '@tabtin/api-client'
import type { AuthAdapter } from '@tabtin/platform-adapter'
import type { RefreshTokenResponse } from '@/types/auth'
import { buildApiUrl } from '@/config/api'

/**
 * 统一的 Token 刷新函数，供 api-client 和 auth-store 共用。
 * 返回新 token 对象或 null（刷新失败）。
 */
export async function refreshAccessToken(
  refreshToken: string,
  adapter: AuthAdapter,
): Promise<RefreshTokenResponse | null> {
  let resp: Response
  try {
    resp = await fetch(buildApiUrl(API_ENDPOINTS.AUTH.REFRESH), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refresh_token: refreshToken }),
    })
  } catch (error) {
    throw new RefreshTemporarilyUnavailableError(
      error instanceof Error ? error.message : undefined,
    )
  }

  const raw = await resp.json().catch(() => null)
  if (!resp.ok) {
    const errorCode = raw?.code ?? raw?.error_code
    if (resp.status === 409 || resp.status === 429 || resp.status >= 500 || errorCode === 'RATE_LIMITED') {
      throw new RefreshTemporarilyUnavailableError()
    }
    return null
  }

  const data = raw?.success === true && raw?.data ? raw.data : raw
  if (!data?.access_token) return null

  await adapter.save({
    accessToken: data.access_token,
    refreshToken: data.refresh_token || refreshToken,
    user: data.user ?? null,
    expiresAt: null,
  })

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token,
    user: data.user,
  }
}
