/**
 * Wave 4 search route 单测
 *
 * 覆盖：
 *   - 参数透传：6+ flags 组合
 *   - q 必填、organization_id 必填
 *   - 未知参数静默丢弃（防 ninja 422）
 *   - 降级响应原样透传（不 raise stack trace，符合 ADR-12 / ADR-09）
 *   - HTTP method 限制（仅 GET）
 *   - 上游 401 透传
 *
 * 测试模式参考 tableRoute.test.ts：vi.hoisted + vi.mock 注入 djangoRequest。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configureCLIRoutes, handleSearchRoute } from '@tabtin/cli-routes'

// search.ts 已迁移到 @tabtin/cli-routes（packages/cli-routes/src/routes/search.ts）。
// 通过 cli-routes 的 configureCLIRoutes() 注入 mock djangoRequest，这与运行时
// 宿主（Electron / Daemon）注入的方式完全一致——比 vi.mock 模块替换更贴近真实路径。
const mockDjangoRequest = vi.fn()
configureCLIRoutes({
  djangoRequest: mockDjangoRequest,
  getSpaceId: () => null,
})

describe('handleSearchRoute', () => {
  const res = {} as any
  const sendJSON = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    mockDjangoRequest.mockResolvedValue({
      status: 200,
      data: {
        results: [],
        total: 0,
        facets: { messages: 0, resources: 0, agents: 0, spaces: 0, memos: 0, im: 0 },
        suggestions: [],
        took_ms: 12,
        search_mode: 'normal',
        degraded: false,
        partial_indices: [],
      },
    })
    delete process.env.TABTIN_ORGANIZATION_ID
  })

  it('GET /search 透传 q + organization_id 到 Django', async () => {
    await handleSearchRoute(
      '/search?q=python&organization_id=wt-1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    const [method, path] = mockDjangoRequest.mock.calls[0]
    expect(method).toBe('GET')
    // path 契约：djangoRequest 期望不带 /api 前缀（baseUrl 已带 /api 结尾，由 host
    // 实现的 djangoRequest 用 joinApiPath 拼接）。详见 cli-routes/host-bindings.ts。
    expect(path).toBe('/search?q=python&organization_id=wt-1')
    expect(sendJSON).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      results: [],
      degraded: false,
    }))
  })

  it('完整 6+ flags 组合全部透传', async () => {
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1&types=messages,resources&item_type=tabdoc&space_id=sp-1&agent_id=ag-1&creator_type=agent&role=assistant&created_after=2026-01-01T00:00:00Z&limit=15&offset=20&mode=fast',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    const path = mockDjangoRequest.mock.calls[0][1]
    expect(path).toContain('q=hello')
    expect(path).toContain('organization_id=wt-1')
    expect(path).toContain('types=messages%2Cresources')
    expect(path).toContain('item_type=tabdoc')
    expect(path).toContain('space_id=sp-1')
    expect(path).toContain('agent_id=ag-1')
    expect(path).toContain('creator_type=agent')
    expect(path).toContain('role=assistant')
    expect(path).toContain('created_after=2026-01-01T00%3A00%3A00Z')
    expect(path).toContain('limit=15')
    expect(path).toContain('offset=20')
    expect(path).toContain('mode=fast')
  })

  it('q 缺失 → 400 + 友好错误，不调 Django', async () => {
    await handleSearchRoute('/search?organization_id=wt-1', 'GET', undefined, res, sendJSON)
    expect(mockDjangoRequest).not.toHaveBeenCalled()
    expect(sendJSON).toHaveBeenCalledWith(res, 400, expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('q'),
      }),
    }))
  })

  it('q 为空字符串 → 400', async () => {
    await handleSearchRoute('/search?q=&organization_id=wt-1', 'GET', undefined, res, sendJSON)
    expect(mockDjangoRequest).not.toHaveBeenCalled()
    expect(sendJSON).toHaveBeenCalledWith(res, 400, expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    }))
  })

  it('q 仅空白 → 400', async () => {
    await handleSearchRoute('/search?q=%20%20%20&organization_id=wt-1', 'GET', undefined, res, sendJSON)
    expect(mockDjangoRequest).not.toHaveBeenCalled()
    expect(sendJSON).toHaveBeenCalledWith(res, 400, expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    }))
  })

  it('organization_id 缺失 + 无 env fallback → 400 友好提示', async () => {
    await handleSearchRoute('/search?q=hello', 'GET', undefined, res, sendJSON)
    expect(mockDjangoRequest).not.toHaveBeenCalled()
    expect(sendJSON).toHaveBeenCalledWith(res, 400, expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('organization_id'),
      }),
    }))
  })

  it('organization_id 缺失但 env TABTIN_ORGANIZATION_ID 存在 → 自动注入', async () => {
    process.env.TABTIN_ORGANIZATION_ID = 'wt-from-env'
    await handleSearchRoute('/search?q=hello', 'GET', undefined, res, sendJSON)
    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    const path = mockDjangoRequest.mock.calls[0][1]
    expect(path).toContain('q=hello')
    expect(path).toContain('organization_id=wt-from-env')
  })

  it('未知参数静默丢弃，不透传到 Django（避免 ninja 422）', async () => {
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1&_evil=drop_table&unknown=1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    const path = mockDjangoRequest.mock.calls[0][1]
    expect(path).not.toContain('_evil')
    expect(path).not.toContain('unknown')
    expect(path).toContain('q=hello')
    expect(path).toContain('organization_id=wt-1')
  })

  it('? 缺失（无 query string）→ 400', async () => {
    await handleSearchRoute('/search', 'GET', undefined, res, sendJSON)
    expect(mockDjangoRequest).not.toHaveBeenCalled()
    expect(sendJSON).toHaveBeenCalledWith(res, 400, expect.objectContaining({
      ok: false,
      error: expect.objectContaining({ code: 'VALIDATION_ERROR' }),
    }))
  })

  it('降级响应（200 + degraded=true）原样透传，不 raise', async () => {
    mockDjangoRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        results: [{ id: 'r-1', type: 'resource', title: 'fallback', snippet: '', highlight: {}, score: 0.5, rrf_score: 0.5 }],
        total: 1,
        facets: { messages: 0, resources: 1, agents: 0, spaces: 0, memos: 0, im: 0 },
        suggestions: [],
        took_ms: 8,
        search_mode: 'fallback',
        degraded: true,
        degraded_reason: 'engine_disabled',
        partial_indices: ['messages', 'agents', 'spaces', 'memos', 'im'],
      },
    })
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(sendJSON).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      degraded: true,
      degraded_reason: 'engine_disabled',
      partial_indices: expect.arrayContaining(['messages']),
    }))
  })

  it('partial_failure 降级 200 透传', async () => {
    mockDjangoRequest.mockResolvedValueOnce({
      status: 200,
      data: {
        results: [],
        total: 0,
        facets: {},
        suggestions: [],
        took_ms: 100,
        search_mode: 'normal',
        degraded: true,
        degraded_reason: 'partial_failure',
        partial_indices: ['messages'],
      },
    })
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(sendJSON).toHaveBeenCalledWith(res, 200, expect.objectContaining({
      degraded: true,
      degraded_reason: 'partial_failure',
    }))
  })

  it('上游 401 透传（让 CLI 引导用户重登）', async () => {
    mockDjangoRequest.mockResolvedValueOnce({
      status: 401,
      data: { message: '登录已失效' },
    })
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(sendJSON).toHaveBeenCalledWith(res, 401, expect.objectContaining({
      message: '登录已失效',
    }))
  })

  it('POST 方法 → 405', async () => {
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1',
      'POST',
      { q: 'hello' },
      res,
      sendJSON,
    )
    expect(mockDjangoRequest).not.toHaveBeenCalled()
    expect(sendJSON).toHaveBeenCalledWith(res, 405, expect.objectContaining({
      ok: false,
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('GET'),
      }),
    }))
  })

  it('上游 500 透传 status code', async () => {
    mockDjangoRequest.mockResolvedValueOnce({
      status: 500,
      data: { detail: 'something broke' },
    })
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(sendJSON).toHaveBeenCalledWith(res, 500, expect.objectContaining({
      detail: 'something broke',
    }))
  })

  it('CJK query 正确 URL 编码', async () => {
    await handleSearchRoute(
      '/search?q=' + encodeURIComponent('性能优化') + '&organization_id=wt-1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    const path = mockDjangoRequest.mock.calls[0][1]
    expect(path).toContain('q=' + encodeURIComponent('性能优化'))
  })

  it('多值 q 参数（?q=a&q=b）只取第一个，丢弃后续', async () => {
    // Wave 4 Review H2 技术修复：防御 ninja 422 多值不友好响应
    await handleSearchRoute(
      '/search?q=first&q=second&organization_id=wt-1',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    const path = mockDjangoRequest.mock.calls[0][1]
    expect(path).toContain('q=first')
    expect(path).not.toContain('q=second')
    expect(path).toContain('organization_id=wt-1')
  })

  it('多值 organization_id 参数也只取第一个', async () => {
    await handleSearchRoute(
      '/search?q=hi&organization_id=wt-1&organization_id=wt-2',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    const path = mockDjangoRequest.mock.calls[0][1]
    expect(path).toContain('organization_id=wt-1')
    expect(path).not.toContain('organization_id=wt-2')
  })

  it('完整 6+ flags 组合 + 多值 limit 也只取第一个', async () => {
    await handleSearchRoute(
      '/search?q=hello&organization_id=wt-1&limit=15&limit=99',
      'GET',
      undefined,
      res,
      sendJSON,
    )
    const path = mockDjangoRequest.mock.calls[0][1]
    expect(path).toContain('limit=15')
    expect(path).not.toContain('limit=99')
  })
})
