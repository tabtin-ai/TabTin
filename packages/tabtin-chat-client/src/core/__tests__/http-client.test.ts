import { describe, it, expect, beforeEach, vi } from 'vitest'
import { HttpClient } from '../http-client'
import { ChatAPIError } from '../../types'

vi.mock('../../i18n', () => ({
  t: (key: string) => key,
  getLocale: () => 'zh-CN',
}))

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function makeClient() {
  return new HttpClient({
    baseURL: 'https://api.test',
    getToken: () => 'token-test',
  })
}

function mockJsonResponse(json: unknown, status = 200) {
  mockFetch.mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 200 ? 'OK' : 'Error',
    json: () => Promise.resolve(json),
  })
}

beforeEach(() => {
  mockFetch.mockReset()
})

describe('HttpClient.unwrapResponse — 新 envelope 形态（W0 / W1）', () => {
  it('ok:true + data → 解包 data', async () => {
    mockJsonResponse({ ok: true, data: { hello: 'world' } })
    const client = makeClient()
    const result = await client.get<{ hello: string }>('/anything')
    expect(result).toEqual({ hello: 'world' })
  })

  it('ok:true + data + trace_id → 解包 data（trace_id 透传仅在错误时暴露给 caller）', async () => {
    mockJsonResponse({ ok: true, data: 42, trace_id: 'polaris-abc123' })
    const client = makeClient()
    const result = await client.get<number>('/foo')
    expect(result).toBe(42)
  })

  it('ok:true 但缺 data 字段 → 退回返整个 envelope（保留观察性）', async () => {
    mockJsonResponse({ ok: true, message: 'no payload' })
    const client = makeClient()
    const result = await client.get<{ ok: boolean; message: string }>('/empty')
    expect(result).toEqual({ ok: true, message: 'no payload' })
  })

  it('ok:false + SOFT_FAIL → throw ChatAPIError 含完整 code / trace_id / detail', async () => {
    mockJsonResponse({
      ok: false,
      error: {
        code: 'SOFT_FAIL',
        message: 'LLM 暂不可用',
        retryable: true,
        detail: { fallback: { title: '新对话' }, reason: 'llm_unavailable' },
      },
      trace_id: 'polaris-abc123def',
    })
    const client = makeClient()
    let caught: unknown = null
    try {
      await client.post('/chat/sessions/x/title', { force: false })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChatAPIError)
    const err = caught as ChatAPIError
    expect(err.message).toBe('LLM 暂不可用')
    expect(err.statusCode).toBe(0)
    expect(err.code).toBe('SOFT_FAIL')
    expect(err.trace_id).toBe('polaris-abc123def')
    expect(err.detail).toEqual({ fallback: { title: '新对话' }, reason: 'llm_unavailable' })
  })

  it('ok:false + UNAUTHORIZED → throw 含 code', async () => {
    mockJsonResponse({
      ok: false,
      error: { code: 'UNAUTHORIZED', message: '未授权' },
      trace_id: 'polaris-zzzz99',
    })
    const client = makeClient()
    await expect(client.get('/secret')).rejects.toMatchObject({
      name: 'ChatAPIError',
      code: 'UNAUTHORIZED',
      trace_id: 'polaris-zzzz99',
      message: '未授权',
    })
  })

  it('ok:false + NOT_FOUND（无 trace_id）→ trace_id 是 undefined 但 throw 仍生效', async () => {
    mockJsonResponse({
      ok: false,
      error: { code: 'NOT_FOUND', message: '会话不存在' },
    })
    const client = makeClient()
    let caught: unknown = null
    try {
      await client.get('/chat/sessions/missing')
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChatAPIError)
    const err = caught as ChatAPIError
    expect(err.code).toBe('NOT_FOUND')
    expect(err.trace_id).toBeUndefined()
  })

  it('ok:false + error 缺 message → fallback 用 code 当 message', async () => {
    mockJsonResponse({
      ok: false,
      error: { code: 'INTERNAL_ERROR' },
    })
    const client = makeClient()
    await expect(client.get('/x')).rejects.toMatchObject({
      message: 'INTERNAL_ERROR',
      code: 'INTERNAL_ERROR',
    })
  })

  it('ok:false + error 完全缺 → fallback 到 i18n unknownError key', async () => {
    mockJsonResponse({ ok: false })
    const client = makeClient()
    await expect(client.get('/x')).rejects.toMatchObject({
      name: 'ChatAPIError',
      message: 'errors.unknownError',
      code: undefined,
    })
  })
})

describe('HttpClient.unwrapResponse — 老 success_response 形态（向后兼容）', () => {
  it('success:true + data → 解包 data（无业务字段）', async () => {
    mockJsonResponse({ success: true, code: 'SUCCESS', message: 'ok', data: { user: 'alice' } })
    const client = makeClient()
    const result = await client.get<{ user: string }>('/me')
    expect(result).toEqual({ user: 'alice' })
  })

  it('success:true + data + 业务字段（如 ModelsResponse）→ 返整个 json', async () => {
    const json = { success: true, data: [], models: ['gpt-4'], total: 1 }
    mockJsonResponse(json)
    const client = makeClient()
    const result = await client.get('/models')
    expect(result).toEqual(json)
  })

  it('success:false → throw ChatAPIError 含 code 与 trace_id 透传', async () => {
    mockJsonResponse({
      success: false,
      code: 'VALIDATION_ERROR',
      message: '参数错误',
      trace_id: 'polaris-old456',
    })
    const client = makeClient()
    let caught: unknown = null
    try {
      await client.post('/legacy', {})
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(ChatAPIError)
    const err = caught as ChatAPIError
    expect(err.message).toBe('参数错误')
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.trace_id).toBe('polaris-old456')
  })

  it('success:false + 数字 code（HTTP 风格）→ 顶层 code 不污染', async () => {
    mockJsonResponse({ success: false, code: 400, message: 'Bad' })
    const client = makeClient()
    let caught: unknown = null
    try {
      await client.get('/x')
    } catch (e) {
      caught = e
    }
    const err = caught as ChatAPIError
    expect(err).toBeInstanceOf(ChatAPIError)
    expect(err.message).toBe('Bad')
    expect(err.code).toBeUndefined()
    expect((err.response as { code?: number } | undefined)?.code).toBe(400)
  })
})

describe('HttpClient.unwrapResponse — corner cases', () => {
  it('裸返回（无 ok / 无 success）→ 直接透传', async () => {
    mockJsonResponse([1, 2, 3])
    const client = makeClient()
    const result = await client.get<number[]>('/raw')
    expect(result).toEqual([1, 2, 3])
  })

  it('裸 object（无契约字段）→ 直接透传', async () => {
    mockJsonResponse({ foo: 1, bar: 'baz' })
    const client = makeClient()
    const result = await client.get<{ foo: number; bar: string }>('/raw-obj')
    expect(result).toEqual({ foo: 1, bar: 'baz' })
  })

  it('null / 非 object → 直接返回', async () => {
    mockJsonResponse(null)
    const client = makeClient()
    const result = await client.get('/null')
    expect(result).toBeNull()
  })

  it('envelope 优先于老形态：同时含 ok:false 和 success:true → envelope throw 优先', async () => {
    mockJsonResponse({
      ok: false,
      error: { code: 'CONFLICT', message: 'envelope wins' },
      success: true,
      data: { wont: 'be returned' },
    })
    const client = makeClient()
    await expect(client.get('/conflict')).rejects.toMatchObject({
      name: 'ChatAPIError',
      code: 'CONFLICT',
      message: 'envelope wins',
    })
  })
})

describe('ChatAPIError — 顶层字段', () => {
  it('构造时不传 extras → 顶层字段全 undefined', () => {
    const err = new ChatAPIError('boom', 500)
    expect(err.code).toBeUndefined()
    expect(err.trace_id).toBeUndefined()
    expect(err.detail).toBeUndefined()
    expect(err.message).toBe('boom')
    expect(err.statusCode).toBe(500)
  })

  it('构造时传 extras → 顶层字段就位', () => {
    const err = new ChatAPIError('boom', 0, { message: 'raw' }, {
      code: 'SOFT_FAIL',
      trace_id: 'polaris-xyz',
      detail: { fallback: 'default' },
    })
    expect(err.code).toBe('SOFT_FAIL')
    expect(err.trace_id).toBe('polaris-xyz')
    expect(err.detail).toEqual({ fallback: 'default' })
  })

  it('extras 是只读的（class field readonly）— 防 caller 误改', () => {
    const err = new ChatAPIError('boom', 0, undefined, { code: 'X' })
    // readonly 仅是 TS 编译期约束；运行期值仍可读
    expect(err.code).toBe('X')
  })
})
