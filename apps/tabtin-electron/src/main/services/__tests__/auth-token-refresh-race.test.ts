/**
 * HP12 / SD-039: auth.ts Token 刷新竞态逻辑测试
 *
 * 覆盖核心路径：
 * 1. refreshAccessToken 互斥锁：并发调用共享同一 Promise
 * 2. _doRefreshAccessToken 成功/失败/超时各分支
 * 3. 刷新成功后广播 token-refreshed 到所有窗口
 * 4. 401/403/404 时清除认证 + 广播 force-logout
 * 5. 锁释放后新调用触发新的刷新
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

// ── hoisted mocks ──────────────────────────────────────────────

const mocks = vi.hoisted(() => ({
  getPassword: vi.fn(),
  setPassword: vi.fn(),
  deletePassword: vi.fn(),
  getAllWindows: vi.fn(() => []),
  getAllWebContents: vi.fn(() => []),
  fetch: vi.fn(),
}))

// auth.ts 已从 keytar 迁移到 safe-credential-store（同形态 API）
vi.mock('../../safe-credential-store', () => ({
  credentialStore: {
    getPassword: mocks.getPassword,
    setPassword: mocks.setPassword,
    deletePassword: mocks.deletePassword,
  },
}))

vi.mock('electron', () => ({
  app: {
    isPackaged: false,
    getAppPath: vi.fn(() => '/app'),
    getPath: vi.fn(() => '/tmp'),
  },
  ipcMain: { handle: vi.fn() },
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  webContents: { getAllWebContents: mocks.getAllWebContents },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s: string) => Buffer.from(s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8'),
  },
}))

vi.mock('../../logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}))

vi.mock('../../config/api.js', () => ({
  API_BASE_URL: 'http://localhost:6060',
}))

vi.mock('@tabtin/config', () => ({
  joinApiPath: (base: string, path: string) => `${base}${path}`,
}))

vi.stubGlobal('fetch', mocks.fetch)

import { TokenManager } from '../../auth'

// ── helpers ────────────────────────────────────────────────────

async function seedTokens(accessToken: string, refreshToken: string) {
  await TokenManager.saveAuthData(accessToken, refreshToken, { id: 'test-user' })
}

function mockFetchOk(accessToken = 'new-access', refreshToken = 'new-refresh') {
  mocks.fetch.mockResolvedValue({
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        success: true,
        data: { access_token: accessToken, refresh_token: refreshToken },
      }),
  })
}

function mockFetchStatus(status: number) {
  mocks.fetch.mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ detail: `HTTP ${status}` }),
  })
}

function mockFetchRateLimited(status: 401 | 429 = 401) {
  mocks.fetch.mockResolvedValue({
    ok: false,
    status,
    json: () =>
      Promise.resolve({
        success: false,
        message: '刷新过于频繁，请稍后再试',
        code: 'RATE_LIMITED',
      }),
  })
}

function deferred<T>() {
  let resolve!: (v: T) => void
  let reject!: (e: any) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function makeFetchResponse(accessToken: string, refreshToken: string) {
  return {
    ok: true,
    status: 200,
    json: () =>
      Promise.resolve({
        success: true,
        data: { access_token: accessToken, refresh_token: refreshToken },
      }),
  } as unknown as Response
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve()
  }
}

async function resetTokenManagerTestState() {
  vi.clearAllMocks()
  mocks.getPassword.mockResolvedValue(null)
  mocks.setPassword.mockResolvedValue(undefined)
  mocks.deletePassword.mockResolvedValue(true)
  mocks.getAllWindows.mockReturnValue([])
  mocks.getAllWebContents.mockReturnValue([])
  TokenManager.resetRefreshStateForTests()
  await TokenManager.clearAuthData()
  TokenManager.resetRefreshStateForTests()
}

// ── tests ──────────────────────────────────────────────────────

describe('TokenManager.refreshAccessToken — 互斥锁与竞态', () => {
  beforeEach(async () => {
    await resetTokenManagerTestState()
  })

  it('并发多次调用 refreshAccessToken 应共享同一个 Promise', async () => {
    await seedTokens('at-old', 'rt-old')

    const d = deferred<Response>()
    mocks.fetch.mockReturnValue(d.promise)

    const p1 = TokenManager.refreshAccessToken()
    const p2 = TokenManager.refreshAccessToken()
    const p3 = TokenManager.refreshAccessToken()

    await flushMicrotasks()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    d.resolve(makeFetchResponse('at-new', 'rt-new'))

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toBe('at-new')
    expect(r2).toBe('at-new')
    expect(r3).toBe('at-new')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)
  })

  it('刷新完成后锁释放，后续调用发起新的刷新请求', async () => {
    await seedTokens('at-old', 'rt-old')

    mockFetchOk('at-v1', 'rt-v1')
    const first = await TokenManager.refreshAccessToken()
    expect(first).toBe('at-v1')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    // 清新鲜窗口，专门验证互斥锁释放（新鲜窗口行为见  用例）
    TokenManager.resetRefreshStateForTests()
    mockFetchOk('at-v2', 'rt-v2')
    const second = await TokenManager.refreshAccessToken()
    expect(second).toBe('at-v2')
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })

  it('刷新失败后锁释放，后续调用可重新尝试', async () => {
    await seedTokens('at-old', 'rt-old')

    mockFetchStatus(500)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('服务端错误: 500')

    mockFetchOk('at-recovered', 'rt-recovered')
    const result = await TokenManager.refreshAccessToken()
    expect(result).toBe('at-recovered')
  })

  it('并发调用中所有等待者收到相同的失败', async () => {
    await seedTokens('at-old', 'rt-old')

    mockFetchStatus(500)
    const p1 = TokenManager.refreshAccessToken()
    const p2 = TokenManager.refreshAccessToken()

    const results = await Promise.allSettled([p1, p2])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('rejected')
    expect((results[0] as PromiseRejectedResult).reason.message).toBe('服务端错误: 500')
    expect((results[1] as PromiseRejectedResult).reason.message).toBe('服务端错误: 500')
  })
})

describe('TokenManager._doRefreshAccessToken — 分支覆盖', () => {
  beforeEach(async () => {
    await resetTokenManagerTestState()
  })

  it('无 refresh_token 时抛出错误', async () => {
    await TokenManager.saveAuthData('at', '', null)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('未找到 refresh_token')
  })

  it('刷新成功后正确更新存储的 token', async () => {
    await seedTokens('at-old', 'rt-old')
    mockFetchOk('at-new', 'rt-new')

    await TokenManager.refreshAccessToken()

    const savedAccess = await TokenManager.getAccessToken()
    const savedRefresh = await TokenManager.getRefreshToken()
    expect(savedAccess).toBe('at-new')
    expect(savedRefresh).toBe('rt-new')
  })

  it('刷新成功后广播 token-refreshed-signal 到所有窗口', async () => {
    await seedTokens('at-old', 'rt-old')

    const mockSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: mockSend } },
      { isDestroyed: () => true, webContents: { send: vi.fn() } },
    ])

    mockFetchOk('at-broadcast', 'rt-broadcast')
    await TokenManager.refreshAccessToken()

    expect(mockSend).toHaveBeenCalledWith('auth:token-refreshed-signal')
    expect(mockSend).toHaveBeenCalledTimes(1)
  })

  it('401 响应清除认证 + 广播 force-logout', async () => {
    await seedTokens('at-old', 'rt-old')

    const mockSend = vi.fn()
    mocks.getAllWebContents.mockReturnValue([
      { isDestroyed: () => false, send: mockSend },
    ])

    mockFetchStatus(401)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('登录已过期')

    const authData = await TokenManager.getAuthData()
    expect(authData.accessToken).toBeNull()
    expect(authData.refreshToken).toBeNull()

    expect(mockSend).toHaveBeenCalledWith('auth:force-logout')
  })

  it('#8145: 401 + RATE_LIMITED 保留凭证且不 force-logout', async () => {
    await seedTokens('at-old', 'rt-old')

    const mockSend = vi.fn()
    mocks.getAllWebContents.mockReturnValue([
      { isDestroyed: () => false, send: mockSend },
    ])

    mockFetchRateLimited(401)
    const token = await TokenManager.refreshAccessToken()
    expect(token).toBe('at-old')

    const authData = await TokenManager.getAuthData()
    expect(authData.accessToken).toBe('at-old')
    expect(authData.refreshToken).toBe('rt-old')
    expect(mockSend).not.toHaveBeenCalledWith('auth:force-logout')
  })

  it('#8145: 429 RATE_LIMITED 同样保留凭证', async () => {
    await seedTokens('at-old', 'rt-old')

    mockFetchRateLimited(429)
    await expect(TokenManager.refreshAccessToken()).resolves.toBe('at-old')

    const authData = await TokenManager.getAuthData()
    expect(authData.accessToken).toBe('at-old')
    expect(authData.refreshToken).toBe('rt-old')
  })

  it('#8145: 新鲜窗口内二次 refresh 不打网', async () => {
    await seedTokens('at-old', 'rt-old')
    mockFetchOk('at-new', 'rt-new')

    await expect(TokenManager.refreshAccessToken()).resolves.toBe('at-new')
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    mocks.fetch.mockClear()
    await expect(TokenManager.refreshAccessToken()).resolves.toBe('at-new')
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it('403 响应同样触发清除认证 + force-logout', async () => {
    await seedTokens('at-old', 'rt-old')

    const mockSend = vi.fn()
    mocks.getAllWebContents.mockReturnValue([
      { isDestroyed: () => false, send: mockSend },
    ])

    mockFetchStatus(403)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('登录已过期')
    expect(mockSend).toHaveBeenCalledWith('auth:force-logout')
  })

  it('404 响应同样触发清除认证 + force-logout', async () => {
    await seedTokens('at-old', 'rt-old')

    const mockSend = vi.fn()
    mocks.getAllWebContents.mockReturnValue([
      { isDestroyed: () => false, send: mockSend },
    ])

    mockFetchStatus(404)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('登录已过期')
    expect(mockSend).toHaveBeenCalledWith('auth:force-logout')
  })

  it('500 响应抛出错误但不清除认证', async () => {
    await seedTokens('at-old', 'rt-old')

    mockFetchStatus(500)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('服务端错误: 500')

    const token = await TokenManager.getAccessToken()
    expect(token).toBe('at-old')
  })

  it('网络错误（fetch reject）抛出原始错误', async () => {
    await seedTokens('at-old', 'rt-old')

    mocks.fetch.mockRejectedValue(new Error('Network failure'))
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('Network failure')
  })

  it('AbortError 转换为超时友好提示', async () => {
    await seedTokens('at-old', 'rt-old')

    const abortError = new DOMException('The operation was aborted', 'AbortError')
    mocks.fetch.mockRejectedValue(abortError)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('Token 刷新超时')
  })

  it('响应缺少 access_token 字段时抛出错误', async () => {
    await seedTokens('at-old', 'rt-old')

    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: { refresh_token: 'rt' } }),
    })

    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('缺少有效的 access_token')
  })

  it('响应缺少 refresh_token 字段时抛出错误', async () => {
    await seedTokens('at-old', 'rt-old')

    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ success: true, data: { access_token: 'at' } }),
    })

    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('缺少有效的 refresh_token')
  })

  it('响应体为非包装格式（无 success/data）时仍能正确提取 token', async () => {
    await seedTokens('at-old', 'rt-old')

    mocks.fetch.mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ access_token: 'at-flat', refresh_token: 'rt-flat' }),
    })

    const result = await TokenManager.refreshAccessToken()
    expect(result).toBe('at-flat')
  })
})

describe('Token 刷新竞态场景 — 高并发时序', () => {
  beforeEach(async () => {
    await resetTokenManagerTestState()
  })

  it('第一波并发共享 → 锁释放 → 第二波并发触发新刷新', async () => {
    await seedTokens('at-old', 'rt-old')

    // Wave 1
    const d1 = deferred<Response>()
    mocks.fetch.mockReturnValueOnce(d1.promise)

    const wave1 = [
      TokenManager.refreshAccessToken(),
      TokenManager.refreshAccessToken(),
      TokenManager.refreshAccessToken(),
    ]

    await flushMicrotasks()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    d1.resolve(makeFetchResponse('at-wave1', 'rt-wave1'))
    const results1 = await Promise.all(wave1)
    expect(results1.every((r) => r === 'at-wave1')).toBe(true)

    // Wave 2：清新鲜窗口后应真正再打网（验证锁已释放）
    TokenManager.resetRefreshStateForTests()
    const d2 = deferred<Response>()
    mocks.fetch.mockReturnValueOnce(d2.promise)

    const wave2 = [
      TokenManager.refreshAccessToken(),
      TokenManager.refreshAccessToken(),
    ]

    await flushMicrotasks()
    expect(mocks.fetch).toHaveBeenCalledTimes(2)

    d2.resolve(makeFetchResponse('at-wave2', 'rt-wave2'))
    const results2 = await Promise.all(wave2)
    expect(results2.every((r) => r === 'at-wave2')).toBe(true)
  })

  it('刷新期间 10 个并发调用加入等待队列，仅发起 1 次请求', async () => {
    await seedTokens('at-old', 'rt-old')

    const d = deferred<Response>()
    mocks.fetch.mockReturnValue(d.promise)

    const promises: Promise<string>[] = []
    for (let i = 0; i < 10; i++) {
      promises.push(TokenManager.refreshAccessToken())
    }

    await flushMicrotasks()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    d.resolve(makeFetchResponse('at-shared', 'rt-shared'))

    const results = await Promise.all(promises)
    expect(results).toHaveLength(10)
    expect(new Set(results).size).toBe(1)
    expect(results[0]).toBe('at-shared')
  })

  it('刷新请求发送正确的 refresh_token', async () => {
    await seedTokens('at-old', 'my-refresh-token-123')

    mockFetchOk()
    await TokenManager.refreshAccessToken()

    expect(mocks.fetch).toHaveBeenCalledWith(
      'http://localhost:6060/auth/refresh-token',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ refresh_token: 'my-refresh-token-123' }),
      }),
    )
  })

  it('已销毁窗口不接收 token-refreshed-signal 广播', async () => {
    await seedTokens('at-old', 'rt-old')

    const liveSend = vi.fn()
    const deadSend = vi.fn()

    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: liveSend } },
      { isDestroyed: () => true, webContents: { send: deadSend } },
    ])

    mockFetchOk('at-new', 'rt-new')
    await TokenManager.refreshAccessToken()

    expect(liveSend).toHaveBeenCalledTimes(1)
    expect(deadSend).not.toHaveBeenCalled()
  })

  it('广播 send 抛出异常不影响刷新流程', async () => {
    await seedTokens('at-old', 'rt-old')

    mocks.getAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: {
          send: vi.fn(() => {
            throw new Error('WebContents destroyed')
          }),
        },
      },
    ])

    mockFetchOk('at-new', 'rt-new')
    const result = await TokenManager.refreshAccessToken()
    expect(result).toBe('at-new')
  })
})

describe('多窗口并发场景', () => {
  beforeEach(async () => {
    await resetTokenManagerTestState()
  })

  it('force-logout 广播到所有非销毁 webContents（多窗口 + webview）', async () => {
    await seedTokens('at-old', 'rt-old')

    const sends = [vi.fn(), vi.fn(), vi.fn()]
    mocks.getAllWebContents.mockReturnValue([
      { isDestroyed: () => false, send: sends[0] },
      { isDestroyed: () => true, send: sends[1] },
      { isDestroyed: () => false, send: sends[2] },
    ])

    mockFetchStatus(401)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('登录已过期')

    expect(sends[0]).toHaveBeenCalledWith('auth:force-logout')
    expect(sends[1]).not.toHaveBeenCalled()
    expect(sends[2]).toHaveBeenCalledWith('auth:force-logout')
  })

  it('token-refreshed 广播到多个活跃窗口，跳过已销毁窗口', async () => {
    await seedTokens('at-old', 'rt-old')

    const sends = [vi.fn(), vi.fn(), vi.fn()]
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: sends[0] } },
      { isDestroyed: () => false, webContents: { send: sends[1] } },
      { isDestroyed: () => true, webContents: { send: sends[2] } },
    ])

    mockFetchOk('at-broadcast', 'rt-broadcast')
    await TokenManager.refreshAccessToken()

    expect(sends[0]).toHaveBeenCalledWith('auth:token-refreshed-signal')
    expect(sends[1]).toHaveBeenCalledWith('auth:token-refreshed-signal')
    expect(sends[2]).not.toHaveBeenCalled()
  })

  it('多窗口并发触发刷新 — 共享 Promise + 广播仅一次', async () => {
    await seedTokens('at-old', 'rt-old')

    const sends = [vi.fn(), vi.fn()]
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => false, webContents: { send: sends[0] } },
      { isDestroyed: () => false, webContents: { send: sends[1] } },
    ])

    const d = deferred<Response>()
    mocks.fetch.mockReturnValue(d.promise)

    const p1 = TokenManager.refreshAccessToken()
    const p2 = TokenManager.refreshAccessToken()
    const p3 = TokenManager.refreshAccessToken()

    await flushMicrotasks()
    expect(mocks.fetch).toHaveBeenCalledTimes(1)

    d.resolve(makeFetchResponse('at-multi', 'rt-multi'))

    const [r1, r2, r3] = await Promise.all([p1, p2, p3])
    expect(r1).toBe('at-multi')
    expect(r2).toBe('at-multi')
    expect(r3).toBe('at-multi')

    expect(sends[0]).toHaveBeenCalledWith('auth:token-refreshed-signal')
    expect(sends[1]).toHaveBeenCalledWith('auth:token-refreshed-signal')
    expect(sends[0]).toHaveBeenCalledTimes(1)
    expect(sends[1]).toHaveBeenCalledTimes(1)
  })

  it('某个窗口 send 异常不阻塞其他窗口的广播', async () => {
    await seedTokens('at-old', 'rt-old')

    const goodSend = vi.fn()
    mocks.getAllWindows.mockReturnValue([
      {
        isDestroyed: () => false,
        webContents: { send: vi.fn(() => { throw new Error('destroyed mid-send') }) },
      },
      { isDestroyed: () => false, webContents: { send: goodSend } },
    ])

    mockFetchOk('at-ok', 'rt-ok')
    const result = await TokenManager.refreshAccessToken()

    expect(result).toBe('at-ok')
    expect(goodSend).toHaveBeenCalledWith('auth:token-refreshed-signal')
  })

  it('force-logout 中 send 异常不阻塞其他 webContents', async () => {
    await seedTokens('at-old', 'rt-old')

    const goodSend = vi.fn()
    mocks.getAllWebContents.mockReturnValue([
      { isDestroyed: () => false, send: vi.fn(() => { throw new Error('gone') }) },
      { isDestroyed: () => false, send: goodSend },
    ])

    mockFetchStatus(401)
    await expect(TokenManager.refreshAccessToken()).rejects.toThrow('登录已过期')

    expect(goodSend).toHaveBeenCalledWith('auth:force-logout')
  })
})
