/**
 * Wave 2A 限流方法感知重试 + retryAfter 透传 集成测试。
 *
 * 测试对象:`executeApiRequestWithRetry(options, makeRequestFn, delayFn)`
 *  — 与 IPC 解耦的重试 loop 主体。
 *
 * 覆盖矩阵:
 *  1. GET 429 时,默认重试 3 次(协议 §3.2 推荐 max_retries=3)
 *  2. 普通 POST 不自动重试；仅幂等只读 POST（IM 发消息 / 导入预览）有限重试
 *  3. 每次重试间隔 = `retry_after_seconds`(从 body 优先,header fallback)
 *  4. 重试用尽后 result.retryAfter 被透传给上层(renderer 端 ApiError 接收)
 *  5. PUT/PATCH/DELETE 走幂等路径(3 次)
 *
 * 协议来源:`docs/api/rate-limit-protocol.md` §3。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// guardedHandle 不需要,executeApiRequestWithRetry 不依赖 IPC。
// 但导入 api-proxy 时 module 顶部会 import './utils/guarded-handle' 实际无副作用。
vi.mock('./config/api', () => ({
  API_BASE_URL: 'http://localhost:6060/api',
  DISTRIBUTION_KIND: 'official',
}))

vi.mock('./utils/guarded-handle', () => ({
  guardedHandle: vi.fn(),
}))

vi.mock('./logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}))

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: vi.fn(() => []),
  },
  ipcMain: {
    handle: vi.fn(),
    removeHandler: vi.fn(),
  },
}))

import {
  executeApiRequestWithRetry,
  getOfficeImportRequestStage,
  registerApiProxyHandlers,
  toProxyNetworkError,
  getRequestTimeoutMs,
  isAllowedApiHost,
  isBlockedApiHost,
} from './api-proxy'
import { guardedHandle } from './utils/guarded-handle'

const NO_DELAY = (_: number) => Promise.resolve()

const RATE_LIMITED_BODY = {
  success: false,
  code: 'RATE_LIMITED',
  message: '请求频率过高,请稍后再试',
  data: null,
  retry_after_seconds: 2,
}

function build429Response(retrySeconds = 2): any {
  return {
    status: 429,
    statusText: 'Too Many Requests',
    headers: {
      'retry-after': String(retrySeconds),
      'x-ratelimit-limit': '200',
      'x-ratelimit-remaining': '0',
      'x-ratelimit-reset': String(retrySeconds),
    },
    data: { ...RATE_LIMITED_BODY, retry_after_seconds: retrySeconds },
  }
}

function build200Response(): any {
  return {
    status: 200,
    statusText: 'OK',
    headers: {},
    data: { success: true, data: { ok: true } },
  }
}

describe('Wave 2A — executeApiRequestWithRetry 方法感知重试', () => {
  let consoleWarnSpy: ReturnType<typeof vi.spyOn>
  let consoleErrorSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    consoleWarnSpy.mockRestore()
    consoleErrorSpy.mockRestore()
  })

  it('GET 429 时,重试 3 次(协议 §3.2 max_retries=3),最后一次也失败则透传 retryAfter', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValueOnce(build429Response(2))
      .mockResolvedValueOnce(build429Response(2))
      .mockResolvedValueOnce(build429Response(2))
      .mockResolvedValueOnce(build429Response(2)) // 第 4 次也是 429,重试用尽

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      NO_DELAY,
    )

    // GET 路径:1 初始 + 3 重试 = 4 次调用
    expect(makeRequest).toHaveBeenCalledTimes(4)
    expect(result.status).toBe(429)
    // 重试用尽后 retryAfter 透传给上层(renderer 端 ApiError 用)
    expect(result.retryAfter).toBe(2)
  })

  it('GET 429 后第 2 次返 200,提前结束,不再重试', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValueOnce(build429Response(1))
      .mockResolvedValueOnce(build200Response())

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(200)
  })

  it('普通副作用 POST 遇到 429 时不自动重试', async () => {
    const makeRequest = vi.fn().mockResolvedValue(build429Response(2))

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/create/', method: 'POST' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(429)
    expect(result.retryAfter).toBe(2)
  })

  it('仅带 client_request_id 的 IM 发消息遇到 429 时有限重试一次', async () => {
    const makeRequest = vi.fn().mockResolvedValue(build429Response(2))

    await executeApiRequestWithRetry(
      {
        url: 'http://localhost:6060/api/im/conversations/conv-1/messages',
        method: 'POST',
        body: JSON.stringify({ content: 'hello', client_request_id: 'request-1' }),
      },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(2)
  })

  it('IM 发消息 429 后网络错误时仍最多自动重试一次', async () => {
    const networkError = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    const makeRequest = vi.fn()
      .mockResolvedValueOnce(build429Response(2))
      .mockRejectedValueOnce(networkError)

    await expect(executeApiRequestWithRetry(
      {
        url: 'http://localhost:6060/api/im/conversations/conv-1/messages',
        method: 'POST',
        body: JSON.stringify({ content: 'hello', client_request_id: 'request-1' }),
      },
      makeRequest,
      NO_DELAY,
    )).rejects.toMatchObject({ code: 'ECONNREFUSED' })

    expect(makeRequest).toHaveBeenCalledTimes(2)
  })

  it('IM 发消息网络错误后 429 时仍最多自动重试一次', async () => {
    const networkError = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    const makeRequest = vi.fn()
      .mockRejectedValueOnce(networkError)
      .mockResolvedValueOnce(build429Response(2))

    const result = await executeApiRequestWithRetry(
      {
        url: 'http://localhost:6060/api/im/conversations/conv-1/messages',
        method: 'POST',
        body: JSON.stringify({ content: 'hello', client_request_id: 'request-1' }),
      },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(429)
  })

  it('IM 发消息 429 后 5xx 时仍最多自动重试一次', async () => {
    const makeRequest = vi.fn()
      .mockResolvedValueOnce(build429Response(2))
      .mockResolvedValueOnce({ status: 503, headers: {}, data: {} })

    const result = await executeApiRequestWithRetry(
      {
        url: 'http://localhost:6060/api/im/conversations/conv-1/messages',
        method: 'POST',
        body: JSON.stringify({ content: 'hello', client_request_id: 'request-1' }),
      },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(503)
  })

  it('普通副作用 POST 遇到网络错误也不自动重试', async () => {
    const networkError = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    const makeRequest = vi.fn().mockRejectedValue(networkError)

    await expect(executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/create/', method: 'POST' },
      makeRequest,
      NO_DELAY,
    )).rejects.toMatchObject({ code: 'ECONNREFUSED' })

    expect(makeRequest).toHaveBeenCalledTimes(1)
  })

  it('带 client_request_id 的 IM 发消息网络失败时有限重试一次', async () => {
    const networkError = Object.assign(new Error('connect refused'), { code: 'ECONNREFUSED' })
    const makeRequest = vi.fn().mockRejectedValue(networkError)

    await expect(executeApiRequestWithRetry(
      {
        url: 'http://localhost:6060/api/im/conversations/conv-1/messages',
        method: 'POST',
        body: JSON.stringify({ content: 'hello', client_request_id: 'request-1' }),
      },
      makeRequest,
      NO_DELAY,
    )).rejects.toMatchObject({ code: 'ECONNREFUSED' })

    expect(makeRequest).toHaveBeenCalledTimes(2)
  })

  it('导入预览 POST 首次 TLS/网络失败后重试成功', async () => {
    const tlsError = Object.assign(
      new Error('Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET' },
    )
    const makeRequest = vi
      .fn()
      .mockRejectedValueOnce(tlsError)
      .mockResolvedValueOnce(build200Response())

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tabdata/import/preview', method: 'POST' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(200)
  })

  it('导入预览 POST 首次 503 后重试成功；普通创建 POST 仍只请求一次', async () => {
    const previewRequest = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, headers: {}, data: {} })
      .mockResolvedValueOnce(build200Response())

    const previewResult = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tabdata/import/preview/', method: 'POST' },
      previewRequest,
      NO_DELAY,
    )
    expect(previewRequest).toHaveBeenCalledTimes(2)
    expect(previewResult.status).toBe(200)

    const createRequest = vi
      .fn()
      .mockResolvedValueOnce({ status: 503, headers: {}, data: {} })
      .mockResolvedValueOnce(build200Response())

    const createResult = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/create/', method: 'POST' },
      createRequest,
      NO_DELAY,
    )
    expect(createRequest).toHaveBeenCalledTimes(1)
    expect(createResult.status).toBe(503)
  })

  it('导入预览 POST 持续网络失败时只重试一次后抛出', async () => {
    const tlsError = Object.assign(
      new Error('Client network socket disconnected before secure TLS connection was established'),
      { code: 'ECONNRESET' },
    )
    const makeRequest = vi.fn().mockRejectedValue(tlsError)

    await expect(executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tabdata/import/preview', method: 'POST' },
      makeRequest,
      NO_DELAY,
    )).rejects.toMatchObject({ code: 'ECONNRESET' })

    expect(makeRequest).toHaveBeenCalledTimes(2)
  })

  it('PUT 走幂等路径,重试 3 次', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValue(build429Response(1))

    await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/123/', method: 'PUT' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(4) // 1 + 3
  })

  it('PATCH 走幂等路径,重试 3 次', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValue(build429Response(1))

    await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/123/', method: 'PATCH' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(4)
  })

  it('DELETE 走幂等路径,重试 3 次', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValue(build429Response(1))

    await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/123/', method: 'DELETE' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(4)
  })

  it('每次重试间隔 = retry_after_seconds(从 body 读)', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValueOnce(build429Response(3)) // base=3s
      .mockResolvedValueOnce(build200Response())

    const delayFn = vi.fn().mockResolvedValue(undefined)

    await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      delayFn,
    )

    // 第 0 次重试:base = 3s = 3000ms ± 20% jitter,但 ceiling = 10s
    // 实际值会被 jitter 漂移,只断言"sleep 在合理范围内"
    expect(delayFn).toHaveBeenCalledTimes(1)
    const sleptMs = delayFn.mock.calls[0][0] as number
    expect(sleptMs).toBeGreaterThanOrEqual(2400) // 3000 - 20%
    expect(sleptMs).toBeLessThanOrEqual(3600) // 3000 + 20%
  })

  it('body 缺 retry_after_seconds 时 fallback 到 Retry-After header', async () => {
    const responseHeaderOnly: any = {
      status: 429,
      statusText: 'Too Many Requests',
      headers: { 'retry-after': '5' },
      data: { other: 'noise' }, // 没有 retry_after_seconds
    }
    const makeRequest = vi
      .fn()
      .mockResolvedValueOnce(responseHeaderOnly)
      .mockResolvedValueOnce(build200Response())

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(2)
    expect(result.status).toBe(200)
  })

  it('body + header 都没 retry-after 时,不重试,直接返 429 给上层', async () => {
    const responseNoRetry: any = {
      status: 429,
      statusText: 'Too Many Requests',
      headers: {},
      data: {},
    }
    const makeRequest = vi.fn().mockResolvedValue(responseNoRetry)

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(1) // 没退避秒数,不重试
    expect(result.status).toBe(429)
    expect(result.retryAfter).toBeUndefined()
  })

  it('retry_after_seconds > 60 时不自动重试(协议 §3.4 用户感知)', async () => {
    const longResponse = build429Response(120) // 2 分钟
    const makeRequest = vi.fn().mockResolvedValue(longResponse)

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      NO_DELAY,
    )

    expect(makeRequest).toHaveBeenCalledTimes(1)
    expect(result.status).toBe(429)
    // 仍透传 retryAfter,由 renderer 端业务决定怎么展示
    expect(result.retryAfter).toBe(120)
  })

  it('重试期间命中 200 → result 不再带 retryAfter(成功路径不污染)', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValueOnce(build429Response(1))
      .mockResolvedValueOnce(build200Response())

    const result = await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      NO_DELAY,
    )

    expect(result.status).toBe(200)
    expect(result.retryAfter).toBeUndefined()
  })
})

describe('api:request 网络错误 IPC 契约', () => {
  it('保留 Node 网络错误 code 与原始原因，不降级成 IPC_REJECT', async () => {
    registerApiProxyHandlers()
    const listener = vi.mocked(guardedHandle).mock.calls
      .find(([channel]) => channel === 'api:request')?.[1]
    expect(listener).toBeTypeOf('function')

    const result = await listener!({} as never, {
      url: 'http://localhost:1/api/tracker/create/',
      method: 'POST',
    }) as { ok: boolean; error?: { code?: string; detail?: { reason?: string } } }

    expect(result).toMatchObject({
      ok: false,
      error: {
        code: 'ECONNREFUSED',
        detail: { reason: expect.any(String) },
      },
    })
  })

  it('从 Node 错误保留 code 与原始 reason', () => {
    const error = toProxyNetworkError(Object.assign(new Error('connect refused'), {
      code: 'ECONNREFUSED',
    }))

    expect(error).toMatchObject({ code: 'ECONNREFUSED', reason: 'connect refused' })
  })
})

// Wave 1 D3 — X-Request-Id trace_id 透传测试。
//
// 依赖 trace-context 模块的 ALS 单例，所以 import 顺序很重要：
// 上面的 retry 测试不碰 trace context，下面的 D3 测试在每个 it
// 内部按需 enter/exit context 验证行为。
import {
  runWithTraceId,
  runWithGeneratedTrace,
  getCurrentTraceId,
  __disableTraceContextForTesting,
} from './utils/trace-context'

describe('Wave 1 D3 — X-Request-Id 自动注入与反读', () => {
  beforeEach(() => {
    __disableTraceContextForTesting()
  })
  afterEach(() => {
    __disableTraceContextForTesting()
  })

  it('已在 ALS context 内：X-Request-Id 用当前 trace_id', async () => {
    const makeRequest = vi.fn().mockResolvedValue(build200Response())

    await runWithTraceId('outer-trace-12', async () => {
      await executeApiRequestWithRetry(
        { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
        makeRequest,
        NO_DELAY,
      )
    })

    expect(makeRequest).toHaveBeenCalledTimes(1)
    const sentHeaders = makeRequest.mock.calls[0][0].headers as Record<string, string>
    expect(sentHeaders['X-Request-Id']).toBe('outer-trace-12')
  })

  it('不在 ALS context 内：自动 generate 一个 trace_id 并写到 X-Request-Id', async () => {
    const makeRequest = vi.fn().mockResolvedValue(build200Response())

    await executeApiRequestWithRetry(
      { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
      makeRequest,
      NO_DELAY,
    )

    const sentHeaders = makeRequest.mock.calls[0][0].headers as Record<string, string>
    // nanoid(12) 形态
    expect(sentHeaders['X-Request-Id']).toMatch(/^[A-Za-z0-9_-]{12}$/)
  })

  it('调用方显式传 X-Request-Id 时尊重之，并把它写回 ALS', async () => {
    const makeRequest = vi.fn().mockResolvedValue({
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {},
    })
    const seen: Array<string | undefined> = []

    await runWithGeneratedTrace(async () => {
      await executeApiRequestWithRetry(
        {
          url: 'http://localhost:6060/api/tracker/list/',
          method: 'GET',
          headers: { 'X-Request-Id': 'caller-supplied' },
        },
        makeRequest,
        NO_DELAY,
      )
      seen.push(getCurrentTraceId())
    })

    const sentHeaders = makeRequest.mock.calls[0][0].headers as Record<string, string>
    expect(sentHeaders['X-Request-Id']).toBe('caller-supplied')
    // 写回 ALS — 后续 envelope.trace_id 会跟它一致
    expect(seen[0]).toBe('caller-supplied')
  })

  it('retry loop 内多次 attempt 共享同一 X-Request-Id（trace 不变）', async () => {
    const makeRequest = vi
      .fn()
      .mockResolvedValueOnce(build429Response(1))
      .mockResolvedValueOnce(build429Response(1))
      .mockResolvedValueOnce(build200Response())

    await runWithTraceId('retry-stable', async () => {
      await executeApiRequestWithRetry(
        { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
        makeRequest,
        NO_DELAY,
      )
    })

    expect(makeRequest).toHaveBeenCalledTimes(3)
    for (const call of makeRequest.mock.calls) {
      const headers = call[0].headers as Record<string, string>
      expect(headers['X-Request-Id']).toBe('retry-stable')
    }
  })

  it('响应 X-Request-Id 跟发出去的不同 → 反读写回 ALS（防御服务端覆盖）', async () => {
    const responseWithDifferentTrace = {
      status: 200,
      statusText: 'OK',
      // 服务端 echo 回了一个跟我们发的不同的 trace（极端场景）
      headers: { 'x-request-id': 'server-authoritative-trace' },
      data: {},
    }
    const makeRequest = vi.fn().mockResolvedValue(responseWithDifferentTrace)
    const seen: Array<string | undefined> = []

    await runWithTraceId('client-original', async () => {
      await executeApiRequestWithRetry(
        { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
        makeRequest,
        NO_DELAY,
      )
      seen.push(getCurrentTraceId())
    })

    expect(seen[0]).toBe('server-authoritative-trace')
  })

  it('响应 X-Request-Id 跟发出去的相同 → ALS 不变（normal path）', async () => {
    const responseWithSameTrace = {
      status: 200,
      statusText: 'OK',
      headers: { 'x-request-id': 'echo-same-trace' },
      data: {},
    }
    const makeRequest = vi.fn().mockResolvedValue(responseWithSameTrace)
    const seen: Array<string | undefined> = []

    await runWithTraceId('echo-same-trace', async () => {
      await executeApiRequestWithRetry(
        { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
        makeRequest,
        NO_DELAY,
      )
      seen.push(getCurrentTraceId())
    })

    expect(seen[0]).toBe('echo-same-trace')
  })

  it('响应没 X-Request-Id 头 → ALS 不变（向后兼容老 Django 部署）', async () => {
    const responseNoTrace = {
      status: 200,
      statusText: 'OK',
      headers: {},
      data: {},
    }
    const makeRequest = vi.fn().mockResolvedValue(responseNoTrace)
    const seen: Array<string | undefined> = []

    await runWithTraceId('client-only-trace', async () => {
      await executeApiRequestWithRetry(
        { url: 'http://localhost:6060/api/tracker/list/', method: 'GET' },
        makeRequest,
        NO_DELAY,
      )
      seen.push(getCurrentTraceId())
    })

    expect(seen[0]).toBe('client-only-trace')
  })
})

/**
 * Allowlist / blocklist 守恒 — 主进程 IPC 入口的最后一道安全边界。
 *
 * 历史背景：production / preprod 域名是 `*.api-preprod.example.com`，渲染进程包
 * 在打包时已经把 `VITE_API_BASE_URL` 冷冻，主进程的 allowlist 只能靠
 * 硬编码 + `allowedDevHost`（运行时 API_BASE_URL 推导）兜底。
 * 一旦运行时 .env 把主进程指向别处（譬如本地 IP 测预览），
 * `allowedDevHost` 不再覆盖渲染端冻结的 host，硬编码就是兜底。
 *
 * 这组测试钉住：所有当前在用的官方域名都进 allowlist；元数据 / 私网
 * IP / 非 http(s) 协议都被 blocklist 挡住。下次新增官方域名时 grep
 * 这个测试名就能找到要补的位置。
 */
describe('isAllowedApiHost / isBlockedApiHost — host 守恒', () => {
  it('community 只放行构建时声明的 API origin', () => {
    const communityProfile = {
      kind: 'community' as const,
      apiOrigins: Object.freeze(['https://api.example.org']),
      updater: Object.freeze({ enabled: false as const }),
    }
    expect(isAllowedApiHost('https://api.example.org/x', communityProfile)).toBe(true)
    expect(isAllowedApiHost('https://other.example.org/x', communityProfile)).toBe(false)
    expect(isAllowedApiHost('https://api.example.com/x', communityProfile)).toBe(false)
  })

  it('官方根域名（裸）通过 allowlist', () => {
    expect(isAllowedApiHost('https://www.example.com/api/x')).toBe(true)
    expect(isAllowedApiHost('https://api-preprod.example.com/api/x')).toBe(true)
  })

  it('官方域名子域（preprod / api / static 等）通过 allowlist', () => {
    expect(isAllowedApiHost('https://api-preprod.example.com/api/x')).toBe(true)
    expect(isAllowedApiHost('https://api-preprod.example.com/api/x')).toBe(true)
    expect(isAllowedApiHost('https://api.example.com/x')).toBe(true)
  })

  it('localhost / 由 API_BASE_URL 推导的 dev host 通过 allowlist', () => {
    // mock 的 API_BASE_URL = http://localhost:6060/api → allowedDevHost = localhost
    expect(isAllowedApiHost('http://localhost:6060/api/x')).toBe(true)
  })

  it('未授权第三方 host 被 allowlist 拒绝', () => {
    expect(isAllowedApiHost('https://attacker.invalid/api/x')).toBe(false)
    expect(isAllowedApiHost('https://api-preprod.example.com.evil.com/api/x')).toBe(false)
    expect(isAllowedApiHost('https://notexample.com/api/x')).toBe(false)
  })

  it('非 http(s) 协议被 allowlist 拒绝（防 file:// / data: 等）', () => {
    expect(isAllowedApiHost('file:///etc/passwd')).toBe(false)
    expect(isAllowedApiHost('data:text/plain,abc')).toBe(false)
  })

  it('云元数据端点 / 私网 IP 直连被 blocklist 拒绝', () => {
    expect(isBlockedApiHost('http://169.254.169.254/latest/meta-data/')).toBe(true)
    expect(isBlockedApiHost('http://metadata.google.internal/')).toBe(true)
    expect(isBlockedApiHost('http://10.0.0.1/x')).toBe(true)
    expect(isBlockedApiHost('http://192.168.1.1/x')).toBe(true)
    expect(isBlockedApiHost('http://172.16.0.1/x')).toBe(true)
    expect(isBlockedApiHost('http://127.0.0.1/x')).toBe(true)
  })

  it('运行时 API_BASE_URL 推导的 dev host 不被 blocklist 拒（dev 体验保护）', () => {
    // mock API_BASE_URL = http://localhost:6060/api → allowedDevHosts = {localhost}
    // localhost 在 ipv4 私网检测前会被 allowedDevHosts 短路 → 放行
    expect(isBlockedApiHost('http://localhost:6060/api/x')).toBe(false)
  })

  it('blocklist 对官方域名 no-op（不会误伤生产 host）', () => {
    expect(isBlockedApiHost('https://api-preprod.example.com/api/x')).toBe(false)
    expect(isBlockedApiHost('https://api.example.com/x')).toBe(false)
  })
})

describe('allowedDevHosts — 本机多服务放行', () => {
  const ORIGINAL_DAEMON_CONTROL_BASE = process.env.TABTIN_DAEMON_CONTROL_API_BASE_URL

  afterEach(() => {
    if (ORIGINAL_DAEMON_CONTROL_BASE === undefined) {
      delete process.env.TABTIN_DAEMON_CONTROL_API_BASE_URL
    } else {
      process.env.TABTIN_DAEMON_CONTROL_API_BASE_URL = ORIGINAL_DAEMON_CONTROL_BASE
    }
    vi.resetModules()
  })

  async function loadProxy(
    apiBaseUrl: string,
    daemonControlBaseUrl?: string,
  ) {
    vi.resetModules()
    if (daemonControlBaseUrl === undefined) {
      delete process.env.TABTIN_DAEMON_CONTROL_API_BASE_URL
    } else {
      process.env.TABTIN_DAEMON_CONTROL_API_BASE_URL = daemonControlBaseUrl
    }
    vi.doMock('./config/api', () => ({
      API_BASE_URL: apiBaseUrl,
      DISTRIBUTION_KIND: 'official',
    }))
    return await import('./api-proxy')
  }

  it('没写进 env 的私网 / 回环地址依旧被拦（SSRF 边界不变）', async () => {
    const proxy = await loadProxy('http://192.168.0.103:6060/api')
    // 同为回环但端口/地址没配置过 → 只有 hostname 命中才放行，127.0.0.2 不在集合里
    expect(proxy.isBlockedApiHost('http://127.0.0.2/x')).toBe(true)
    expect(proxy.isAllowedApiHost('http://10.0.0.5/x')).toBe(false)
    expect(proxy.isBlockedApiHost('http://169.254.169.254/latest/meta-data/')).toBe(true)
  })

  it('API host 与 Daemon Control host 不同时，只放行 env 显式配置的设备服务', async () => {
    const proxy = await loadProxy(
      'http://192.168.0.103:6060/api',
      'http://127.0.0.1:6080/api',
    )

    const listUrl = 'http://127.0.0.1:6080/api/daemon-control/v1/devices'
    expect(proxy.isAllowedApiHost(listUrl)).toBe(true)
    expect(proxy.isBlockedApiHost(listUrl)).toBe(false)
    expect(proxy.isAllowedApiHost(
      'http://127.0.0.2:6080/api/daemon-control/v1/devices',
    )).toBe(false)
  })

})

describe('getRequestTimeoutMs', () => {
  it('gives organization member removal enough time for resource and IM cleanup', () => {
    expect(
      getRequestTimeoutMs(
        'https://api-test.example.com/api/context/organizations/org-1/members/user-2',
        'DELETE',
      ),
    ).toBe(120_000)
  })

  it('gives skills/import a long timeout so URL download is not killed at 30s', () => {
    expect(getRequestTimeoutMs('https://api-test.example.com/api/skills/import')).toBe(120_000)
    expect(getRequestTimeoutMs('https://api.example.com/api/skills/import/')).toBe(120_000)
  })

  it('gives billing/wallet/tabdata CSV export a long timeout ', () => {
    expect(
      getRequestTimeoutMs(
        'https://api-test.example.com/api/services/billing/organizations/org-1/billing/export?start_date=2026-07-01',
      ),
    ).toBe(180_000)
    expect(
      getRequestTimeoutMs(
        'https://api.example.com/api/wallet/organizations/org-1/transactions/export',
      ),
    ).toBe(180_000)
    expect(
      getRequestTimeoutMs('https://api-test.example.com/api/tabdata/export/csv'),
    ).toBe(180_000)
  })

  it('keeps the default timeout for ordinary skill APIs', () => {
    expect(getRequestTimeoutMs('https://api-test.example.com/api/skills/')).toBe(30_000)
    expect(getRequestTimeoutMs('https://api-test.example.com/api/skills/foo')).toBe(30_000)
  })
})

describe('getOfficeImportRequestStage', () => {
  it.each([
    ['POST', 'https://api-test.example.com/api/tabdata/import/excel', 'tabdata_excel_upload'],
    ['POST', 'https://api-test.example.com/api/services/oss/presign-upload', 'oss_presign'],
    ['POST', 'https://api-test.example.com/api/services/oss/confirm-upload/', 'oss_confirm'],
    ['POST', 'https://api-test.example.com/api/tabdoc/import/jobs', 'tabdoc_job_create'],
    ['GET', 'https://api-test.example.com/api/tabdoc/import/jobs/job-1', 'tabdoc_job_poll'],
    ['GET', 'https://api-test.example.com/api/tabdoc/import/jobs/job-1/result', 'tabdoc_job_result'],
  ])('classifies %s %s without logging request details', (method, url, expected) => {
    expect(getOfficeImportRequestStage(url, method)).toBe(expected)
  })

  it('does not classify unrelated paths or wrong methods', () => {
    expect(getOfficeImportRequestStage('https://api-test.example.com/api/tabdata/tables', 'GET')).toBeNull()
    expect(getOfficeImportRequestStage('https://api-test.example.com/api/tabdata/import/excel', 'GET')).toBeNull()
    expect(getOfficeImportRequestStage('not-a-url', 'POST')).toBeNull()
  })
})
