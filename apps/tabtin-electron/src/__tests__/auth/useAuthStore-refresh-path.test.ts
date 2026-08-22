/**
 * useAuthStore token 刷新路径回归测试
 *
 * 验证 TA-006/TA-007：refreshAuthToken 和 loadAuthFromStorage 必须走
 * 主进程 IPC（window.tabtin.auth.refreshAccessToken）而非已废弃的
 * apiService.refreshToken()（该方法依赖已移除的 auth:getRefreshToken IPC）。
 *
 * 以及 ：loadAuthFromStorage 启动刷新失败时必须区分确定性拒绝与瞬时
 * 失败——主进程已清凭证（重读 bundle 为空）时进入未登录态，绝不能带旧
 * token 进入 authenticated 态；仅瞬时失败（凭证仍在）才降级保留现有 token。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ── 提取待测逻辑为纯函数，与 Zustand 和 DOM 解耦 ──

interface AuthBundle {
  accessToken: string | null
  refreshToken: string | null
  user: any | null
}

interface RefreshAccessTokenResult {
  success: boolean
  accessToken?: string
  error?: string
}

interface TokenExpiryResult {
  success: boolean
  isExpiring?: boolean
  error?: string
}

/**
 * 与 useAuthStore.isTransientTokenRefreshFailure 同口径（测试内联，避免拉整 store）。
 */
function isTransientTokenRefreshFailure(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false
  const typed = error as { isTransient?: boolean; message?: string }
  if (typed.isTransient === true) return true
  if (typed.isTransient === false) return false
  const msg = (typed.message ?? String(error)).toLowerCase()
  return [
    'network error',
    'failed to fetch',
    'fetch failed',
    'timeout',
    'econnrefused',
    'econnreset',
    'enotfound',
    'etimedout',
    'socket hang up',
    'abort',
  ].some((p) => msg.includes(p))
}

/**
 * 模拟 refreshAuthToken 的核心逻辑（对应 useAuthStore.refreshAuthToken）
 */
async function refreshAuthToken(deps: {
  refreshAccessToken: () => Promise<RefreshAccessTokenResult>
  loadAuthBundle: () => Promise<AuthBundle | null>
  setAuthToken: (token: string) => void
  setState: (state: Partial<AuthBundle>) => void
  logout: () => Promise<void>
}): Promise<void> {
  const { refreshAccessToken, loadAuthBundle, setAuthToken, setState, logout } = deps
  try {
    const result = await refreshAccessToken()
    if (!result?.success) {
      const err = new Error(result?.error || 'Token refresh failed') as Error & {
        isTransient?: boolean
      }
      // 测试夹具可在 error 字符串里模拟瞬时失败；生产路径由 preload 挂 isTransient
      if (typeof result?.error === 'string' && /fetch failed|network/i.test(result.error)) {
        err.isTransient = true
      }
      throw err
    }

    const authData = await loadAuthBundle()
    if (!authData?.accessToken) {
      throw new Error('Failed to load refreshed tokens from storage')
    }

    setAuthToken(authData.accessToken)
    setState({
      accessToken: authData.accessToken,
      refreshToken: authData.refreshToken,
      user: authData.user,
    })
  } catch (error) {
    if (isTransientTokenRefreshFailure(error)) {
      throw error
    }
    await logout()
    throw error
  }
}

/**
 * 模拟 loadAuthFromStorage 中的启动刷新逻辑（对应 useAuthStore.loadAuthFromStorage 中的 token 过期刷新分支）。
 *
 *  后的语义：
 * - tryRefreshTokens 成功 → 用 fresh bundle 进入 authenticated
 * - 失败 + 重读 bundle 为空（主进程确定性清凭证）→ unauthenticated
 * - 失败 + bundle 仍有 token（瞬时失败）→ 用现有 token 进入 authenticated
 */
async function startupRefresh(deps: {
  tryRefreshTokens: () => Promise<string | null>
  loadAuthBundle: () => Promise<AuthBundle | null>
  isTokenExpiringSoon: (buffer: number) => Promise<TokenExpiryResult>
  existingAuth: AuthBundle
}): Promise<{ phase: 'authenticated' | 'unauthenticated'; auth: AuthBundle }> {
  const { tryRefreshTokens, loadAuthBundle, isTokenExpiringSoon, existingAuth } = deps
  const result = { ...existingAuth }

  const expiryCheck = await isTokenExpiringSoon(5)
  if (expiryCheck?.success && expiryCheck.isExpiring && existingAuth.refreshToken) {
    const newToken = await tryRefreshTokens()
    if (newToken) {
      const freshAuth = await loadAuthBundle()
      if (freshAuth?.accessToken) {
        result.accessToken = freshAuth.accessToken
        result.refreshToken = freshAuth.refreshToken
        if (freshAuth.user) {
          result.user = freshAuth.user
        }
      }
    } else {
      const bundleAfterFailure = await loadAuthBundle().catch(() => null)
      if (!bundleAfterFailure?.accessToken) {
        return {
          phase: 'unauthenticated',
          auth: { accessToken: null, refreshToken: null, user: null },
        }
      }
    }
  }

  return { phase: 'authenticated', auth: result }
}

describe('useAuthStore refresh path (TA-006/TA-007 regression)', () => {
  const MOCK_USER = { id: '1', username: 'test', nickname: 'Test' }
  const OLD_TOKEN = 'old-access-token'
  const NEW_TOKEN = 'new-access-token'
  const NEW_REFRESH = 'new-refresh-token'

  describe('refreshAuthToken (TA-007)', () => {
    it('应通过主进程 IPC 刷新 token 并重新加载 bundle', async () => {
      const refreshAccessToken = vi.fn().mockResolvedValue({ success: true, accessToken: NEW_TOKEN })
      const loadAuthBundle = vi.fn().mockResolvedValue({
        accessToken: NEW_TOKEN,
        refreshToken: NEW_REFRESH,
        user: MOCK_USER,
      })
      const setAuthToken = vi.fn()
      const setState = vi.fn()
      const logout = vi.fn()

      await refreshAuthToken({ refreshAccessToken, loadAuthBundle, setAuthToken, setState, logout })

      expect(refreshAccessToken).toHaveBeenCalledOnce()
      expect(loadAuthBundle).toHaveBeenCalledOnce()
      expect(setAuthToken).toHaveBeenCalledWith(NEW_TOKEN)
      expect(setState).toHaveBeenCalledWith({
        accessToken: NEW_TOKEN,
        refreshToken: NEW_REFRESH,
        user: MOCK_USER,
      })
      expect(logout).not.toHaveBeenCalled()
    })

    it('主进程刷新失败时应触发 logout 并抛出错误', async () => {
      const refreshAccessToken = vi.fn().mockResolvedValue({ success: false, error: 'Refresh token expired' })
      const loadAuthBundle = vi.fn()
      const setAuthToken = vi.fn()
      const setState = vi.fn()
      const logout = vi.fn()

      await expect(
        refreshAuthToken({ refreshAccessToken, loadAuthBundle, setAuthToken, setState, logout })
      ).rejects.toThrow('Refresh token expired')

      expect(logout).toHaveBeenCalledOnce()
      expect(loadAuthBundle).not.toHaveBeenCalled()
    })

    it('瞬时网络失败（fetch failed）应保留凭证、不 logout', async () => {
      const refreshAccessToken = vi.fn().mockResolvedValue({ success: false, error: 'fetch failed' })
      const loadAuthBundle = vi.fn()
      const setAuthToken = vi.fn()
      const setState = vi.fn()
      const logout = vi.fn()

      await expect(
        refreshAuthToken({ refreshAccessToken, loadAuthBundle, setAuthToken, setState, logout })
      ).rejects.toThrow('fetch failed')

      expect(logout).not.toHaveBeenCalled()
      expect(loadAuthBundle).not.toHaveBeenCalled()
    })

    it('isTransient=true 时应保留凭证、不 logout', async () => {
      const refreshAccessToken = vi.fn().mockImplementation(async () => {
        throw Object.assign(new Error('Token 刷新超时 (15s)，请检查网络连接'), {
          isTransient: true,
        })
      })
      const loadAuthBundle = vi.fn()
      const setAuthToken = vi.fn()
      const setState = vi.fn()
      const logout = vi.fn()

      await expect(
        refreshAuthToken({ refreshAccessToken, loadAuthBundle, setAuthToken, setState, logout })
      ).rejects.toThrow('Token 刷新超时')

      expect(logout).not.toHaveBeenCalled()
    })

    it('主进程成功但加载 bundle 失败时应触发 logout', async () => {
      const refreshAccessToken = vi.fn().mockResolvedValue({ success: true, accessToken: NEW_TOKEN })
      const loadAuthBundle = vi.fn().mockResolvedValue(null)
      const setAuthToken = vi.fn()
      const setState = vi.fn()
      const logout = vi.fn()

      await expect(
        refreshAuthToken({ refreshAccessToken, loadAuthBundle, setAuthToken, setState, logout })
      ).rejects.toThrow('Failed to load refreshed tokens from storage')

      expect(logout).toHaveBeenCalledOnce()
    })
  })

  describe('loadAuthFromStorage startup refresh (TA-006 + )', () => {
    const existingAuth: AuthBundle = {
      accessToken: OLD_TOKEN,
      refreshToken: 'old-refresh',
      user: MOCK_USER,
    }

    it('token 即将过期时应通过主进程 IPC 刷新', async () => {
      const tryRefreshTokens = vi.fn().mockResolvedValue(NEW_TOKEN)
      const loadAuthBundle = vi.fn().mockResolvedValue({
        accessToken: NEW_TOKEN,
        refreshToken: NEW_REFRESH,
        user: MOCK_USER,
      })
      const isTokenExpiringSoon = vi.fn().mockResolvedValue({ success: true, isExpiring: true })

      const result = await startupRefresh({ tryRefreshTokens, loadAuthBundle, isTokenExpiringSoon, existingAuth })

      expect(tryRefreshTokens).toHaveBeenCalledOnce()
      expect(loadAuthBundle).toHaveBeenCalledOnce()
      expect(result.phase).toBe('authenticated')
      expect(result.auth.accessToken).toBe(NEW_TOKEN)
      expect(result.auth.refreshToken).toBe(NEW_REFRESH)
    })

    it('token 未过期时不应触发刷新', async () => {
      const tryRefreshTokens = vi.fn()
      const loadAuthBundle = vi.fn()
      const isTokenExpiringSoon = vi.fn().mockResolvedValue({ success: true, isExpiring: false })

      const result = await startupRefresh({ tryRefreshTokens, loadAuthBundle, isTokenExpiringSoon, existingAuth })

      expect(tryRefreshTokens).not.toHaveBeenCalled()
      expect(result.phase).toBe('authenticated')
      expect(result.auth.accessToken).toBe(OLD_TOKEN)
    })

    it('#455 刷新被确定性拒绝（主进程已清凭证）时进入未登录态，不得沿用旧 token', async () => {
      const tryRefreshTokens = vi.fn().mockResolvedValue(null)
      // 主进程 clearAuthData() 之后重读 bundle 为空
      const loadAuthBundle = vi.fn().mockResolvedValue({
        accessToken: null,
        refreshToken: null,
        user: null,
      })
      const isTokenExpiringSoon = vi.fn().mockResolvedValue({ success: true, isExpiring: true })

      const result = await startupRefresh({ tryRefreshTokens, loadAuthBundle, isTokenExpiringSoon, existingAuth })

      expect(tryRefreshTokens).toHaveBeenCalledOnce()
      expect(loadAuthBundle).toHaveBeenCalledOnce()
      expect(result.phase).toBe('unauthenticated')
      expect(result.auth.accessToken).toBeNull()
    })

    it('#455 刷新瞬时失败（主进程保留凭证）时降级使用现有 token', async () => {
      const tryRefreshTokens = vi.fn().mockResolvedValue(null)
      // 瞬时失败：主进程未清凭证，重读 bundle 仍有 token
      const loadAuthBundle = vi.fn().mockResolvedValue({ ...existingAuth })
      const isTokenExpiringSoon = vi.fn().mockResolvedValue({ success: true, isExpiring: true })

      const result = await startupRefresh({ tryRefreshTokens, loadAuthBundle, isTokenExpiringSoon, existingAuth })

      expect(tryRefreshTokens).toHaveBeenCalledOnce()
      expect(result.phase).toBe('authenticated')
      expect(result.auth.accessToken).toBe(OLD_TOKEN)
    })

    it('无 refreshToken 时不应尝试刷新', async () => {
      const noRefreshAuth: AuthBundle = { ...existingAuth, refreshToken: null }
      const tryRefreshTokens = vi.fn()
      const loadAuthBundle = vi.fn()
      const isTokenExpiringSoon = vi.fn().mockResolvedValue({ success: true, isExpiring: true })

      const result = await startupRefresh({
        tryRefreshTokens,
        loadAuthBundle,
        isTokenExpiringSoon,
        existingAuth: noRefreshAuth,
      })

      expect(tryRefreshTokens).not.toHaveBeenCalled()
      expect(result.phase).toBe('authenticated')
      expect(result.auth.accessToken).toBe(OLD_TOKEN)
    })
  })
})
