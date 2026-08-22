import { RefreshTemporarilyUnavailableError } from '@tabtin/api-client'
import type { AuthAdapter } from '@tabtin/platform-adapter'

export type NativeAuthRefreshResult =
  | { status: 'succeeded'; accessToken: string; expiresAt: number | null }
  | { status: 'unauthenticated' }
  | { status: 'temporarily_unavailable'; message?: string }

interface NativeAuthHost {
  platform: 'ios' | 'android'
  refresh(): Promise<NativeAuthRefreshResult>
}

declare global {
  interface Window {
    __TABTIN_NATIVE_AUTH__?: NativeAuthHost
  }
}

export function hasNativeAuthHost(): boolean {
  return typeof window !== 'undefined'
    && typeof window.__TABTIN_NATIVE_AUTH__?.refresh === 'function'
}

/**
 * Requests a token from the native session owner without exposing the native
 * refresh token to the WebView. Definitive invalidation returns null;
 * transient host/network failures preserve the current web session.
 */
export async function refreshAccessTokenFromNativeHost(
  adapter: AuthAdapter,
): Promise<{ access_token: string; refresh_token: string } | null> {
  const host = window.__TABTIN_NATIVE_AUTH__
  if (!host) return null

  let result: NativeAuthRefreshResult
  try {
    result = await host.refresh()
  } catch (error) {
    throw new RefreshTemporarilyUnavailableError(
      error instanceof Error ? error.message : undefined,
    )
  }

  if (result.status === 'temporarily_unavailable') {
    throw new RefreshTemporarilyUnavailableError(result.message)
  }
  if (result.status === 'unauthenticated') return null

  const snapshot = await adapter.getSnapshot()
  await adapter.save({
    accessToken: result.accessToken,
    refreshToken: null,
    expiresAt: result.expiresAt,
    user: snapshot.user,
  })
  return { access_token: result.accessToken, refresh_token: '' }
}

