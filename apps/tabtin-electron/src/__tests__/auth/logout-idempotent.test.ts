/**
 *  / : 已 unauthenticated 时 logout / force-logout 应幂等短路。
 * 用与 production 同口径的守卫逻辑做轻量单测，避免拉起完整 zustand store。
 */
import { describe, expect, it } from 'vitest'

function shouldSkipLogout(input: {
  isLoggingOut: boolean
  authPhase: 'authenticated' | 'unauthenticated' | 'loading'
  accessToken: string | null
  refreshToken: string | null
}): boolean {
  if (input.isLoggingOut) return true
  const hasInMemoryCreds = Boolean(input.accessToken || input.refreshToken)
  return input.authPhase === 'unauthenticated' && !hasInMemoryCreds
}

function shouldIgnoreForceLogout(input: {
  hasStoredAccessToken: boolean
  authPhase: 'authenticated' | 'unauthenticated' | 'loading'
  accessToken: string | null
  refreshToken: string | null
}): 'rehydrate' | 'ignore' | 'logout' {
  if (input.hasStoredAccessToken) return 'rehydrate'
  if (input.authPhase === 'unauthenticated' && !input.accessToken && !input.refreshToken) {
    return 'ignore'
  }
  return 'logout'
}

describe('#5200 logout / force-logout 幂等', () => {
  it('已未登录且无内存凭证时跳过 logout', () => {
    expect(
      shouldSkipLogout({
        isLoggingOut: false,
        authPhase: 'unauthenticated',
        accessToken: null,
        refreshToken: null,
      }),
    ).toBe(true)
  })

  it('仍 authenticated 时不跳过', () => {
    expect(
      shouldSkipLogout({
        isLoggingOut: false,
        authPhase: 'authenticated',
        accessToken: 'at',
        refreshToken: 'rt',
      }),
    ).toBe(false)
  })

  it('force-logout：无凭证且已未登录 → ignore', () => {
    expect(
      shouldIgnoreForceLogout({
        hasStoredAccessToken: false,
        authPhase: 'unauthenticated',
        accessToken: null,
        refreshToken: null,
      }),
    ).toBe('ignore')
  })

  it('force-logout：Keychain 仍有凭证 → rehydrate', () => {
    expect(
      shouldIgnoreForceLogout({
        hasStoredAccessToken: true,
        authPhase: 'unauthenticated',
        accessToken: null,
        refreshToken: null,
      }),
    ).toBe('rehydrate')
  })

  it('force-logout：内存仍有会话 → logout', () => {
    expect(
      shouldIgnoreForceLogout({
        hasStoredAccessToken: false,
        authPhase: 'authenticated',
        accessToken: 'at',
        refreshToken: null,
      }),
    ).toBe('logout')
  })
})
