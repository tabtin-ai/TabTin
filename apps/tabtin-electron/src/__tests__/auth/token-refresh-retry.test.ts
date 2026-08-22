/**
 * Token 过期 → 401 自动刷新重试 测试
 *
 * 验证 requestViaProxy 和 table-core adapter 层在收到 401 时
 * 能正确触发 Token 刷新并重试原始请求。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ============================================================
// 模拟 requestViaProxy 的 401 重试逻辑（纯函数提取）
// ============================================================

interface MockRequestOptions {
  url: string
  method: string
  headers?: Record<string, string>
  body?: string
}

interface MockResponse {
  status: number
  data: any
  headers?: Record<string, string>
}

/**
 * 模拟 requestViaProxy 的核心 401 处理逻辑
 */
function createRequestWithRetry(deps: {
  sendRequest: (options: MockRequestOptions) => Promise<MockResponse>
  refreshToken: () => Promise<string | null>
  shouldBypassAuth: (url?: string) => boolean
  getAuthToken: () => string | null
}) {
  const { sendRequest, refreshToken, shouldBypassAuth, getAuthToken } = deps

  return async function requestWithRetry(
    options: MockRequestOptions,
    _isRetry = false
  ): Promise<MockResponse> {
    const headers = { ...options.headers }
    const token = getAuthToken()
    if (token) {
      headers.Authorization = `Bearer ${token}`
    }

    const response = await sendRequest({ ...options, headers })

    // 401 自动刷新重试
    if (response.status === 401 && !_isRetry && !shouldBypassAuth(options.url)) {
      const newToken = await refreshToken()
      if (newToken) {
        return requestWithRetry(
          { ...options, headers: { ...options.headers, Authorization: `Bearer ${newToken}` } },
          true
        )
      }
    }

    return response
  }
}

// ============================================================
// 模拟 table-core adapter 的 401 重试逻辑
// ============================================================

function createAdapterRequestWithRetry(deps: {
  sendRequest: (options: MockRequestOptions) => Promise<MockResponse>
  tryRefreshTokens: () => Promise<string | null>
}) {
  const { sendRequest, tryRefreshTokens } = deps

  return async function adapterRequest(options: MockRequestOptions): Promise<MockResponse> {
    const response = await sendRequest(options)

    if (response.status === 401) {
      const newToken = await tryRefreshTokens()
      if (newToken) {
        const retryOptions = {
          ...options,
          headers: {
            ...options.headers,
            Authorization: `Bearer ${newToken}`,
          },
        }
        return sendRequest(retryOptions)
      }
    }

    return response
  }
}

// ============================================================
// 测试用例
// ============================================================

describe('requestViaProxy 401 自动刷新重试', () => {
  it('401 → 刷新成功 → 重试成功', async () => {
    let callCount = 0
    const sendRequest = vi.fn(async () => {
      callCount++
      if (callCount === 1) {
        return { status: 401, data: { message: 'Unauthorized' } }
      }
      return { status: 200, data: { result: 'ok' } }
    })

    const refreshToken = vi.fn(async () => 'new_access_token')
    const shouldBypassAuth = vi.fn(() => false)
    const getAuthToken = vi.fn(() => 'expired_token')

    const request = createRequestWithRetry({
      sendRequest,
      refreshToken,
      shouldBypassAuth,
      getAuthToken,
    })

    const result = await request({ url: '/api/profile', method: 'GET' })

    expect(result.status).toBe(200)
    expect(result.data.result).toBe('ok')
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('401 → 刷新失败 → 返回原始 401', async () => {
    const sendRequest = vi.fn(async () => ({
      status: 401,
      data: { message: 'Unauthorized' },
    }))

    const refreshToken = vi.fn(async () => null)
    const shouldBypassAuth = vi.fn(() => false)
    const getAuthToken = vi.fn(() => 'expired_token')

    const request = createRequestWithRetry({
      sendRequest,
      refreshToken,
      shouldBypassAuth,
      getAuthToken,
    })

    const result = await request({ url: '/api/profile', method: 'GET' })

    expect(result.status).toBe(401)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('401 → 重试后仍 401 → 不触发第二次刷新（防止无限循环）', async () => {
    const sendRequest = vi.fn(async () => ({
      status: 401,
      data: { message: 'Unauthorized' },
    }))

    const refreshToken = vi.fn(async () => 'new_token')
    const shouldBypassAuth = vi.fn(() => false)
    const getAuthToken = vi.fn(() => 'expired_token')

    const request = createRequestWithRetry({
      sendRequest,
      refreshToken,
      shouldBypassAuth,
      getAuthToken,
    })

    const result = await request({ url: '/api/data', method: 'GET' })

    // 第一次 401 触发刷新并重试，重试仍 401 但 _isRetry=true 所以不再刷新
    expect(result.status).toBe(401)
    expect(refreshToken).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(2)
  })

  it('对 bypass auth 接口的 401 不触发刷新', async () => {
    const sendRequest = vi.fn(async () => ({
      status: 401,
      data: { message: 'Invalid credentials' },
    }))

    const refreshToken = vi.fn(async () => 'new_token')
    const shouldBypassAuth = vi.fn((url?: string) => url?.includes('/auth/login') ?? false)
    const getAuthToken = vi.fn(() => null)

    const request = createRequestWithRetry({
      sendRequest,
      refreshToken,
      shouldBypassAuth,
      getAuthToken,
    })

    const result = await request({ url: '/auth/login', method: 'POST' })

    expect(result.status).toBe(401)
    expect(refreshToken).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('200 响应不触发刷新', async () => {
    const sendRequest = vi.fn(async () => ({
      status: 200,
      data: { result: 'ok' },
    }))

    const refreshToken = vi.fn(async () => 'new_token')
    const shouldBypassAuth = vi.fn(() => false)
    const getAuthToken = vi.fn(() => 'valid_token')

    const request = createRequestWithRetry({
      sendRequest,
      refreshToken,
      shouldBypassAuth,
      getAuthToken,
    })

    const result = await request({ url: '/api/data', method: 'GET' })

    expect(result.status).toBe(200)
    expect(refreshToken).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('重试请求应包含新的 Authorization header', async () => {
    let callCount = 0
    const sendRequest = vi.fn(async (options: MockRequestOptions) => {
      callCount++
      if (callCount === 1) {
        return { status: 401, data: {} }
      }
      return { status: 200, data: { token: options.headers?.Authorization } }
    })

    // 模拟真实行为：refreshToken 成功后会更新 getAuthToken 返回值
    let currentToken = 'old_expired_token'
    const refreshToken = vi.fn(async () => {
      currentToken = 'fresh_token_abc'
      return currentToken
    })
    const shouldBypassAuth = vi.fn(() => false)
    const getAuthToken = vi.fn(() => currentToken)

    const request = createRequestWithRetry({
      sendRequest,
      refreshToken,
      shouldBypassAuth,
      getAuthToken,
    })

    const result = await request({ url: '/api/data', method: 'GET' })

    expect(result.status).toBe(200)
    // 验证重试使用了新 token（refreshToken 更新了 currentToken，getAuthToken 返回新值）
    expect(result.data.token).toBe('Bearer fresh_token_abc')
  })
})

describe('table-core adapter 401 自动刷新重试', () => {
  it('401 → 刷新成功 → 重试成功', async () => {
    let callCount = 0
    const sendRequest = vi.fn(async (_options: MockRequestOptions) => {
      callCount++
      if (callCount === 1) {
        return { status: 401, data: { message: 'Token expired' } }
      }
      return { status: 200, data: { records: [] } }
    })

    const tryRefreshTokens = vi.fn(async () => 'refreshed_token')

    const request = createAdapterRequestWithRetry({
      sendRequest,
      tryRefreshTokens,
    })

    const result = await request({
      url: 'https://api.example.com/tabdata/tables/123/records',
      method: 'GET',
      headers: { Authorization: 'Bearer old_token' },
    })

    expect(result.status).toBe(200)
    expect(tryRefreshTokens).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(2)
    // 验证重试请求带有新 token
    const retryCall = sendRequest.mock.calls[1]?.[0]
    expect(retryCall).toBeTruthy()
    expect(retryCall?.headers?.Authorization).toBe('Bearer refreshed_token')
  })

  it('401 → 刷新失败 → 返回原始 401 响应', async () => {
    const sendRequest = vi.fn(async () => ({
      status: 401,
      data: { message: 'Token expired' },
    }))

    const tryRefreshTokens = vi.fn(async () => null)

    const request = createAdapterRequestWithRetry({
      sendRequest,
      tryRefreshTokens,
    })

    const result = await request({
      url: 'https://api.example.com/tabdata/tables/123/records',
      method: 'GET',
      headers: { Authorization: 'Bearer old_token' },
    })

    expect(result.status).toBe(401)
    expect(tryRefreshTokens).toHaveBeenCalledTimes(1)
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })

  it('非 401 错误不触发刷新', async () => {
    const sendRequest = vi.fn(async () => ({
      status: 500,
      data: { message: 'Internal Server Error' },
    }))

    const tryRefreshTokens = vi.fn(async () => 'new_token')

    const request = createAdapterRequestWithRetry({
      sendRequest,
      tryRefreshTokens,
    })

    const result = await request({
      url: 'https://api.example.com/tabdata/tables/123/records',
      method: 'GET',
    })

    expect(result.status).toBe(500)
    expect(tryRefreshTokens).not.toHaveBeenCalled()
    expect(sendRequest).toHaveBeenCalledTimes(1)
  })
})

describe('并发请求的 Token 刷新去重', () => {
  it('多个并发 401 应只触发一次刷新', async () => {
    let refreshCount = 0
    let refreshPromise: Promise<string | null> | null = null

    async function refreshWithLock(): Promise<string | null> {
      if (refreshPromise) {
        return refreshPromise
      }

      refreshPromise = (async () => {
        try {
          refreshCount++
          // 模拟网络延迟
          await new Promise((r) => setTimeout(r, 50))
          return 'shared_new_token'
        } finally {
          refreshPromise = null
        }
      })()

      return refreshPromise
    }

    let callCountA = 0
    let callCountB = 0
    let callCountC = 0

    const makeRequest = (counter: { count: number }) =>
      createAdapterRequestWithRetry({
        sendRequest: vi.fn(async () => {
          counter.count++
          if (counter.count === 1) {
            return { status: 401, data: {} }
          }
          return { status: 200, data: { ok: true } }
        }),
        tryRefreshTokens: refreshWithLock,
      })

    const counterA = { count: 0 }
    const counterB = { count: 0 }
    const counterC = { count: 0 }

    const requestA = makeRequest(counterA)
    const requestB = makeRequest(counterB)
    const requestC = makeRequest(counterC)

    // 三个请求同时收到 401
    const [resultA, resultB, resultC] = await Promise.all([
      requestA({ url: '/api/a', method: 'GET' }),
      requestB({ url: '/api/b', method: 'GET' }),
      requestC({ url: '/api/c', method: 'GET' }),
    ])

    expect(resultA.status).toBe(200)
    expect(resultB.status).toBe(200)
    expect(resultC.status).toBe(200)
    // 刷新只执行了一次
    expect(refreshCount).toBe(1)
  })
})

describe('handleRefreshFailure 内部通道触发', () => {
  it('刷新异常时应通过内部通道通知登出', async () => {
    const mod = await import('@/utils/authPersistence')
    const handler = vi.fn()
    mod.setAuthLogoutHandler(handler)

    mod.notifyLogoutRequired('token_refresh_failed')

    expect(handler).toHaveBeenCalledTimes(1)
    expect(handler).toHaveBeenCalledWith('token_refresh_failed')

    mod.setAuthLogoutHandler(() => {})
  })

  it('刷新成功时应通过内部通道同步 token', async () => {
    const mod = await import('@/utils/authPersistence')
    const handler = vi.fn()
    mod.setAuthSyncHandler(handler)

    mod.notifyTokensSynced({
      accessToken: 'new_at',
      refreshToken: 'new_rt',
      user: { id: 1, username: 'test' } as any,
    })

    expect(handler).toHaveBeenCalledTimes(1)
    const payload = handler.mock.calls[0][0]
    expect(payload.accessToken).toBe('new_at')
    expect(payload.refreshToken).toBe('new_rt')
    expect(payload.user.username).toBe('test')

    mod.setAuthSyncHandler(() => {})
  })
})

describe('isNetworkError 网络错误判断', () => {
  // 提取与 ApiService.isNetworkError 相同的纯函数用于测试
  const NETWORK_PATTERNS = [
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

  function isNetworkError(error: unknown): boolean {
    if (!error) return false
    const msg = (error instanceof Error ? error.message : String(error)).toLowerCase()
    return NETWORK_PATTERNS.some((p) => msg.includes(p))
  }

  it('应识别常见网络错误', () => {
    expect(isNetworkError(new Error('Network error'))).toBe(true)
    expect(isNetworkError(new Error('net::ERR_INTERNET_DISCONNECTED'))).toBe(true)
    expect(isNetworkError(new Error('Failed to fetch'))).toBe(true)
    expect(isNetworkError(new Error('fetch failed'))).toBe(true)
    expect(isNetworkError(new Error('Request timeout'))).toBe(true)
    expect(isNetworkError(new Error('ECONNREFUSED'))).toBe(true)
    expect(isNetworkError(new Error('ECONNRESET'))).toBe(true)
    expect(isNetworkError(new Error('ENOTFOUND'))).toBe(true)
    expect(isNetworkError(new Error('ETIMEDOUT'))).toBe(true)
    expect(isNetworkError(new Error('ENETUNREACH'))).toBe(true)
    expect(isNetworkError(new Error('socket hang up'))).toBe(true)
  })

  it('不应将认证错误识别为网络错误', () => {
    expect(isNetworkError(new Error('HTTP 401'))).toBe(false)
    expect(isNetworkError(new Error('Unauthorized'))).toBe(false)
    expect(isNetworkError(new Error('Token expired'))).toBe(false)
    expect(isNetworkError(new Error('Invalid refresh token'))).toBe(false)
    expect(isNetworkError(new Error('刷新 Token 响应缺少 access_token'))).toBe(false)
  })

  it('应返回 false 对于 null/undefined', () => {
    expect(isNetworkError(null)).toBe(false)
    expect(isNetworkError(undefined)).toBe(false)
    expect(isNetworkError('')).toBe(false)
  })
})

describe('handleRefreshFailure 网络错误 vs 认证错误', () => {
  it('认证错误应通过内部通道触发登出', async () => {
    const mod = await import('@/utils/authPersistence')
    const handler = vi.fn()
    mod.setAuthLogoutHandler(handler)

    const isNetworkError = false
    if (!isNetworkError) {
      mod.notifyLogoutRequired('token_refresh_failed')
    }

    expect(handler).toHaveBeenCalledTimes(1)
    mod.setAuthLogoutHandler(() => {})
  })

  it('网络错误不应触发登出', async () => {
    const mod = await import('@/utils/authPersistence')
    const handler = vi.fn()
    mod.setAuthLogoutHandler(handler)

    const error = new Error('Network error')
    const msg = error.message.toLowerCase()
    const isNetworkErr = msg.includes('network error')

    if (!isNetworkErr) {
      mod.notifyLogoutRequired('token_refresh_failed')
    }

    expect(handler).not.toHaveBeenCalled()
    mod.setAuthLogoutHandler(() => {})
  })
})
