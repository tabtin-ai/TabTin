/**
 * fts-api 单测：URL 拼装 / Auth header / AbortController / 错误归一 / response 形态归一
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { configureAppShell } from '../runtime.js'
import { unifiedSearch, UnifiedSearchError } from './fts-api.js'

const mockTransport = vi.fn()
const mockGetToken = vi.fn().mockResolvedValue('token-xyz')
const fetchMock = vi.fn()

beforeEach(() => {
  configureAppShell({
    apiBaseUrl: 'http://localhost:6060/api',
    transport: mockTransport,
    auth: { getToken: mockGetToken, getCurrentUserId: () => 'user-1' },
    bridge: {
      setActiveSpace: () => {},
      resetChatClient: () => {},
    },
  })
  globalThis.fetch = fetchMock as unknown as typeof fetch
})

afterEach(() => {
  vi.clearAllMocks()
})

function jsonOk(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

describe('unifiedSearch', () => {
  it('q 为空抛 UnifiedSearchError(400)', async () => {
    await expect(unifiedSearch({ q: ' ', organization_id: 'w1' })).rejects.toMatchObject({
      name: 'UnifiedSearchError',
      status: 400,
    })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('organization_id 为空抛 UnifiedSearchError(400)', async () => {
    await expect(unifiedSearch({ q: 'hi', organization_id: '' })).rejects.toMatchObject({
      status: 400,
    })
  })

  it('URL 拼装：含全部 query 参数 + Authorization header', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [], total: 0, facets: {}, suggestions: [],
      took_ms: 12, search_mode: 'normal', degraded: false, partial_indices: [],
    }))
    await unifiedSearch({
      q: '"精确短语"',
      organization_id: 'w1',
      types: 'messages,resources',
      item_type: 'tabdoc',
      space_id: 's1',
      agent_id: 'a1',
      creator_type: 'agent',
      role: 'assistant',
      created_after: '2026-04-01T00:00:00Z',
      created_before: '2026-04-30T00:00:00Z',
      limit: 30,
      offset: 0,
      mode: 'fast',
    })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, opts] = fetchMock.mock.calls[0]
    expect(url).toContain('http://localhost:6060/api/search?')
    expect(url).toContain('q=%22%E7%B2%BE%E7%A1%AE%E7%9F%AD%E8%AF%AD%22')
    expect(url).toContain('organization_id=w1')
    expect(url).toContain('types=messages%2Cresources')
    expect(url).toContain('item_type=tabdoc')
    expect(url).toContain('space_id=s1')
    expect(url).toContain('agent_id=a1')
    expect(url).toContain('creator_type=agent')
    expect(url).toContain('role=assistant')
    expect(url).toContain('limit=30')
    expect(url).toContain('mode=fast')
    expect(opts.headers.Authorization).toBe('Bearer token-xyz')
    expect(opts.method).toBe('GET')
  })

  it('AbortSignal 透传给 fetch；abort 后 fetch 抛 AbortError 被原样向上抛', async () => {
    const controller = new AbortController()
    fetchMock.mockImplementation(async (_url: string, opts: RequestInit) => {
      return new Promise((_, reject) => {
        // 注册 abort listener；如果 abort 已经发生，立即 reject
        if (opts.signal?.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        opts.signal?.addEventListener('abort', () => {
          reject(new DOMException('aborted', 'AbortError'))
        })
      })
    })
    const promise = unifiedSearch({ q: 'x', organization_id: 'w1' }, { signal: controller.signal })
    // 等一拍让 fetchMock 注册好 listener
    await new Promise((r) => setTimeout(r, 5))
    controller.abort()
    await expect(promise).rejects.toThrow('aborted')
  }, 2000)

  it('401 抛"登录失效" UnifiedSearchError', async () => {
    fetchMock.mockResolvedValue(jsonOk({ detail: 'unauthorized' }, 401))
    await expect(unifiedSearch({ q: 'x', organization_id: 'w1' })).rejects.toMatchObject({
      status: 401,
      message: expect.stringContaining('登录'),
    })
  })

  it('500 抛 UnifiedSearchError + body 透传到 cause', async () => {
    fetchMock.mockResolvedValue(jsonOk({ detail: 'internal' }, 500))
    try {
      await unifiedSearch({ q: 'x', organization_id: 'w1' })
      expect.fail('应抛错')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(UnifiedSearchError)
      expect((err as UnifiedSearchError).status).toBe(500)
    }
  })

  it('response 字段缺失 → 归一化为安全默认值', async () => {
    fetchMock.mockResolvedValue(jsonOk({}))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.results).toEqual([])
    expect(resp.total).toBe(0)
    expect(resp.facets).toEqual({})
    expect(resp.suggestions).toEqual([])
    expect(resp.search_mode).toBe('normal')
    expect(resp.degraded).toBe(false)
    expect(resp.degraded_reason).toBe(null)
    expect(resp.partial_indices).toEqual([])
  })

  it('result item 字段缺失 → 归一化（type 兜底为 message，metadata 兜底空对象）', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [{ id: 'a' }],  // 大量字段缺失
      total: 1,
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.results).toHaveLength(1)
    const item = resp.results[0]
    expect(item.id).toBe('a')
    expect(item.type).toBe('message')
    expect(item.title).toBe('')
    expect(item.snippet).toBe('')
    expect(item.highlight).toEqual({})
    expect(item.metadata).toEqual({})
    expect(item.score).toBe(0)
    expect(item.rrf_score).toBe(0)
  })

  it('degraded=true 不抛错（合法 200）', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [], total: 0, facets: {}, suggestions: [],
      took_ms: 5, search_mode: 'fallback',
      degraded: true, degraded_reason: 'opensearch_unavailable',
      partial_indices: ['messages'],
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.degraded).toBe(true)
    expect(resp.degraded_reason).toBe('opensearch_unavailable')
    expect(resp.partial_indices).toEqual(['messages'])
    expect(resp.search_mode).toBe('fallback')
  })

  it('网络异常（非 abort）包成 UnifiedSearchError(0)', async () => {
    fetchMock.mockRejectedValue(new Error('NetworkDown'))
    try {
      await unifiedSearch({ q: 'x', organization_id: 'w1' })
      expect.fail('应抛错')
    } catch (err: unknown) {
      expect(err).toBeInstanceOf(UnifiedSearchError)
      expect((err as UnifiedSearchError).status).toBe(0)
    }
  })

  it('运行时枚举校验：未知 degraded_reason 归 null', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [], total: 0, facets: {}, suggestions: [], took_ms: 1,
      search_mode: 'fallback', degraded: true,
      degraded_reason: 'NOT_A_REAL_REASON',  // 不在 9 种枚举里
      partial_indices: [],
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.degraded).toBe(true)
    expect(resp.degraded_reason).toBe(null)  // 未知值兜底归 null
  })

  it('运行时枚举校验：partial_indices 中未知 logical index 被过滤', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [], total: 0, facets: {},
      degraded: true, degraded_reason: 'partial_failure',
      partial_indices: ['messages', 'unknown_idx', 'memos'],
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.partial_indices).toEqual(['messages', 'memos'])
  })

  it('运行时枚举校验：未知 type 兜底为 message 并打 warning', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    fetchMock.mockResolvedValue(jsonOk({
      results: [{ id: 'a', type: 'NOT_A_TYPE' }], total: 1,
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.results[0].type).toBe('message')
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it('运行时枚举校验：creator_type 非 user/agent 归 null', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [{ id: 'a', type: 'message', creator_type: 'system' }], total: 1,
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.results[0].creator_type).toBe(null)
  })

  // ── Wave 5 R4-09：notice 字段（"无访问 Space" 等明确状态） ──
  it('Wave 5 R4-09: 后端返回 notice=no_accessible_spaces 时透传到归一结果', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [], total: 0,
      facets: { messages: 0, resources: 0, agents: 0, spaces: 0, memos: 0, im: 0 },
      suggestions: [], took_ms: 1, search_mode: 'normal',
      degraded: false, partial_indices: [],
      notice: 'no_accessible_spaces',
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.notice).toBe('no_accessible_spaces')
    expect(resp.results).toEqual([])
    expect(resp.degraded).toBe(false)  // notice 不是 degraded
  })

  it('Wave 5 R4-09: 缺失 notice 字段时归 null（向后兼容旧后端）', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [], total: 0, facets: {}, suggestions: [], took_ms: 1,
      search_mode: 'normal', degraded: false, partial_indices: [],
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.notice).toBe(null)
  })

  it('Wave 5 R4-09: 未知 notice 值归 null（前端不认识的特殊状态不展示）', async () => {
    fetchMock.mockResolvedValue(jsonOk({
      results: [], total: 0, facets: {}, suggestions: [], took_ms: 1,
      search_mode: 'normal', degraded: false, partial_indices: [],
      notice: 'NOT_A_REAL_NOTICE',
    }))
    const resp = await unifiedSearch({ q: 'x', organization_id: 'w1' })
    expect(resp.notice).toBe(null)
  })
})
