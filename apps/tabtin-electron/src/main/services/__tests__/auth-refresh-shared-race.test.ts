/**
 * HP12 / SD-037: error-handler.ts Token 刷新竞态保护测试
 *
 * 覆盖核心路径：
 * 1. refreshAccessTokenShared TTL 缓存：10s 内返回缓存结果避免重复刷新
 * 2. refreshAccessTokenShared 互斥锁：并发调用共享同一 Promise
 * 3. djangoRequest token 变更检测：401 后检查 token 是否已被其他请求刷新
 * 4. djangoRequest 刷新后重试：使用新 token 重发请求
 * 5. djangoRequest 刷新失败降级为 AUTH_EXPIRED
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// ── hoisted mocks ──────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getAccessToken: vi.fn(),
  getUserInfo: vi.fn(),
  refreshAccessToken: vi.fn(),
  httpRequest: vi.fn(),
}))

vi.mock('keytar', () => ({
  default: {
    getPassword: vi.fn(),
    setPassword: vi.fn(),
    deletePassword: vi.fn(),
  },
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/app'),
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  webContents: { getAllWebContents: vi.fn(() => []) },
}))

vi.mock('../../auth', () => ({
  TokenManager: {
    getAccessToken: mocks.getAccessToken,
    getUserInfo: mocks.getUserInfo,
    refreshAccessToken: mocks.refreshAccessToken,
  },
}))

vi.mock('../../config/api', () => ({
  API_BASE_URL: 'http://localhost:6060',
}))

vi.mock('../../config/api.js', () => ({
  API_BASE_URL: 'http://localhost:6060',
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
  getApiRuntimeConfig: () => ({ apiBaseUrl: 'http://localhost:6060/api', wsBaseUrl: 'ws://localhost:6060' }),
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('node:http', () => ({
  default: { request: mocks.httpRequest },
  request: mocks.httpRequest,
}))

vi.mock('node:https', () => ({
  default: { request: vi.fn() },
  request: vi.fn(),
}))

import { djangoRequest } from '../../cli/routes/shared/error-handler'

// ── helpers ────────────────────────────────────────────────────

// refreshAccessTokenShared 的模块级 TTL 缓存 (lastRefreshedToken/lastRefreshedAt) 跨测试持久化。
// 每个测试必须使用 Date.now spy + 递增 epoch 确保前一测试的 TTL 已过期。
let _epoch = 2_000_000_000_000

function mockHttpResponse(statusCode: number, body: any) {
  mocks.httpRequest.mockImplementationOnce((_opts: any, callback: Function) => {
    const res = {
      statusCode,
      headers: { 'content-type': 'application/json' },
      on: vi.fn(function (this: any, event: string, cb: Function) {
        if (event === 'data') cb(Buffer.from(JSON.stringify(body)))
        if (event === 'end') cb()
        return this
      }),
    }
    setTimeout(() => callback(res), 0)
    return {
      on: vi.fn().mockReturnThis(),
      write: vi.fn(),
      end: vi.fn(),
      destroy: vi.fn(),
    }
  })
}

// ── tests ──────────────────────────────────────────────────────

describe('djangoRequest — Token 变更检测与刷新重试', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
    _epoch += 100_000
    vi.spyOn(Date, 'now').mockReturnValue(_epoch)
    mocks.getUserInfo.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('401 后 token 未变更 → 触发 refreshAccessToken → 用新 token 重试', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken.mockResolvedValue('at-new')

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { success: true, data: 'ok' })

    const result = await djangoRequest('GET', '/api/test')

    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(200)
    expect(result.data.success).toBe(true)
  })

  it('401 后 token 已被其他请求刷新 → 直接用新 token 重试，不触发 refresh', async () => {
    let callCount = 0
    mocks.getAccessToken.mockImplementation(() => {
      callCount++
      return Promise.resolve(callCount <= 1 ? 'at-old' : 'at-new-from-other')
    })

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { data: 'ok' })

    const result = await djangoRequest('GET', '/api/test')

    expect(mocks.refreshAccessToken).not.toHaveBeenCalled()
    expect(result.status).toBe(200)
  })

  it('未登录时直接返回 UNAUTHORIZED，不发请求', async () => {
    mocks.getAccessToken.mockResolvedValue(null)

    const result = await djangoRequest('GET', '/api/test')

    expect(result.status).toBe(401)
    expect(result.data.error.code).toBe('UNAUTHORIZED')
    expect(mocks.httpRequest).not.toHaveBeenCalled()
  })

  it('刷新失败后返回 AUTH_EXPIRED', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken.mockRejectedValue(new Error('登录已过期，请重新登录'))

    mockHttpResponse(401, { detail: 'Unauthorized' })

    const result = await djangoRequest('GET', '/api/test')

    expect(result.status).toBe(401)
    expect(result.data.error.code).toBe('AUTH_EXPIRED')
  })

  it('重试后仍然 401 返回 AUTH_EXPIRED', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken.mockResolvedValue('at-new')

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(401, { detail: 'Still unauthorized' })

    const result = await djangoRequest('GET', '/api/test')

    expect(result.status).toBe(401)
    expect(result.data.error.code).toBe('AUTH_EXPIRED')
  })

  it('非 401 响应直接返回，不触发刷新', async () => {
    mocks.getAccessToken.mockResolvedValue('at-valid')

    mockHttpResponse(200, { success: true, items: [] })

    const result = await djangoRequest('GET', '/api/test')

    expect(result.status).toBe(200)
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('500 响应直接返回，不触发刷新', async () => {
    mocks.getAccessToken.mockResolvedValue('at-valid')

    mockHttpResponse(500, { detail: 'Server error' })

    const result = await djangoRequest('GET', '/api/test')

    expect(result.status).toBe(500)
    expect(mocks.refreshAccessToken).not.toHaveBeenCalled()
  })

  it('请求携带正确的 Authorization header', async () => {
    mocks.getAccessToken.mockResolvedValue('my-access-token')

    mockHttpResponse(200, { ok: true })

    await djangoRequest('GET', '/api/test')

    const requestOpts = mocks.httpRequest.mock.calls[0][0]
    expect(requestOpts.headers.Authorization).toBe('Bearer my-access-token')
  })

  it('POST 请求正确传递 body', async () => {
    mocks.getAccessToken.mockResolvedValue('at-valid')

    let writtenBody = ''
    mocks.httpRequest.mockImplementationOnce((_opts: any, callback: Function) => {
      const res = {
        statusCode: 200,
        headers: { 'content-type': 'application/json' },
        on: vi.fn(function (this: any, event: string, cb: Function) {
          if (event === 'data') cb(Buffer.from(JSON.stringify({ ok: true })))
          if (event === 'end') cb()
          return this
        }),
      }
      setTimeout(() => callback(res), 0)
      return {
        on: vi.fn().mockReturnThis(),
        write: vi.fn((data: string) => { writtenBody = data }),
        end: vi.fn(),
        destroy: vi.fn(),
      }
    })

    await djangoRequest('POST', '/api/test', { key: 'value' })

    expect(writtenBody).toBe(JSON.stringify({ key: 'value' }))
  })

  it('刷新后重试使用新 token 发送请求', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken.mockResolvedValue('at-refreshed')

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })

    await djangoRequest('GET', '/api/test')

    expect(mocks.httpRequest).toHaveBeenCalledTimes(2)
    const retryOpts = mocks.httpRequest.mock.calls[1][0]
    expect(retryOpts.headers.Authorization).toBe('Bearer at-refreshed')
  })
})

// ── refreshAccessTokenShared TTL 缓存 ──────────────────────────

describe('refreshAccessTokenShared — TTL 缓存', () => {
  let currentTime: number

  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
    _epoch += 100_000
    currentTime = _epoch
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime)
    mocks.getUserInfo.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('10s TTL 内第二个 401 使用缓存结果，不触发新的 refreshAccessToken', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken.mockResolvedValueOnce('at-cached')

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    await djangoRequest('GET', '/api/first')
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1)

    currentTime += 5_000

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    await djangoRequest('GET', '/api/second')
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1)
  })

  it('TTL 过期后新的 401 触发新的刷新', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken
      .mockResolvedValueOnce('at-v1')
      .mockResolvedValueOnce('at-v2')

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    await djangoRequest('GET', '/api/first')
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1)

    currentTime += 11_000

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    await djangoRequest('GET', '/api/second')
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2)
  })

  it('刷新失败不写入 TTL 缓存，后续 401 可重新尝试', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken.mockRejectedValueOnce(new Error('fail'))

    mockHttpResponse(401, { detail: 'Unauthorized' })
    const r1 = await djangoRequest('GET', '/api/first')
    expect(r1.data.error.code).toBe('AUTH_EXPIRED')

    currentTime += 1_000
    mocks.refreshAccessToken.mockResolvedValueOnce('at-ok')

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    const r2 = await djangoRequest('GET', '/api/second')
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(2)
    expect(r2.status).toBe(200)
  })

  it('SD-037: 轮转 token — TTL 缓存防止消耗已轮转的 refresh token', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken
      .mockResolvedValueOnce('at-rotated')
      .mockRejectedValueOnce(new Error('Token already consumed'))

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    await djangoRequest('GET', '/api/A')

    currentTime += 3_000

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    const resultB = await djangoRequest('GET', '/api/B')

    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1)
    expect(resultB.status).toBe(200)
  })

  it('TTL 缓存返回的 token 用于重试请求的 Authorization header', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')
    mocks.refreshAccessToken.mockResolvedValueOnce('at-cached-token')

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    await djangoRequest('GET', '/api/first')

    currentTime += 2_000

    mockHttpResponse(401, { detail: 'Unauthorized' })
    mockHttpResponse(200, { ok: true })
    await djangoRequest('GET', '/api/second')

    const retryOpts = mocks.httpRequest.mock.calls[3][0]
    expect(retryOpts.headers.Authorization).toBe('Bearer at-cached-token')
  })
})

// ── 并发 djangoRequest 刷新共享 ────────────────────────────────

describe('并发 djangoRequest — 刷新共享与竞态保护', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    vi.resetAllMocks()
    _epoch += 100_000
    vi.spyOn(Date, 'now').mockReturnValue(_epoch)
    mocks.getUserInfo.mockResolvedValue(null)
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('并发 3 个 401 请求共享刷新 Promise，仅 1 次 refresh', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')

    let resolveRefresh!: (v: string) => void
    mocks.refreshAccessToken.mockImplementation(
      () => new Promise<string>((r) => { resolveRefresh = r }),
    )

    for (let i = 0; i < 3; i++) mockHttpResponse(401, { detail: 'Unauthorized' })
    for (let i = 0; i < 3; i++) mockHttpResponse(200, { ok: true })

    const p1 = djangoRequest('GET', '/api/a')
    const p2 = djangoRequest('GET', '/api/b')
    const p3 = djangoRequest('GET', '/api/c')

    await new Promise((r) => setTimeout(r, 50))
    resolveRefresh('at-shared')

    const results = await Promise.all([p1, p2, p3])
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1)
    results.forEach((r) => expect(r.status).toBe(200))
  })

  it('并发请求中刷新失败 — 所有请求收到 AUTH_EXPIRED', async () => {
    mocks.getAccessToken.mockResolvedValue('at-old')

    let rejectRefresh!: (e: Error) => void
    mocks.refreshAccessToken.mockImplementation(
      () => new Promise<string>((_, rej) => { rejectRefresh = rej }),
    )

    for (let i = 0; i < 2; i++) mockHttpResponse(401, { detail: 'Unauthorized' })

    const p1 = djangoRequest('GET', '/api/a')
    const p2 = djangoRequest('GET', '/api/b')

    await new Promise((r) => setTimeout(r, 50))
    rejectRefresh(new Error('登录已过期'))

    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.data.error.code).toBe('AUTH_EXPIRED')
    expect(r2.data.error.code).toBe('AUTH_EXPIRED')
    expect(mocks.refreshAccessToken).toHaveBeenCalledTimes(1)
  })
})
