import { beforeEach, describe, expect, it, vi } from 'vitest'
import http from 'node:http'

const {
  mockDjangoRequest,
  mockErrorResponse,
  mockGetCLISpaceId,
} = vi.hoisted(() => ({
  mockDjangoRequest: vi.fn(),
  mockErrorResponse: vi.fn((code: string, message: string) => ({
    ok: false,
    error: { code, message },
  })),
  mockGetCLISpaceId: vi.fn(() => 'space-1'),
}))

vi.mock('../shared/error-handler', () => ({
  djangoRequest: mockDjangoRequest,
  errorResponse: mockErrorResponse,
}))

vi.mock('../../cli-context', () => ({
  getCLISpaceId: mockGetCLISpaceId,
}))

import { handleSlideRoute } from '../slide'

describe('handleSlideRoute', () => {
  const res = {} as http.ServerResponse
  const sendJSON = vi.fn()

  beforeEach(() => {
    vi.clearAllMocks()
    process.env.TABTIN_ORGANIZATION_ID = 'wt-1'
  })

  it('拒绝在非空项目上无 --replace 的 generate，避免覆盖旧页面', async () => {
    mockDjangoRequest.mockResolvedValueOnce({
      status: 200,
      data: { data: { pages: [{ id: 'page-1' }] } },
    })

    await handleSlideRoute(
      '/slide/generate',
      'POST',
      { project_id: 'project-1', html: '<div class="ppt-slide">new</div>' },
      res,
      sendJSON,
    )

    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    expect(mockDjangoRequest).toHaveBeenCalledWith(
      'GET',
      '/api/tabslide/projects/project-1/page-outline/',
    )
    expect(sendJSON).toHaveBeenCalledWith(res, 409, expect.objectContaining({
      error: expect.objectContaining({
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('slide add-page --html'),
      }),
    }))
  })

  it('generate 带 --replace 时直达 create-slides 覆盖入口', async () => {
    mockDjangoRequest.mockResolvedValueOnce({
      status: 200,
      data: { ok: true, data: { id: 'project-1' } },
    })

    await handleSlideRoute(
      '/slide/generate',
      'POST',
      { project_id: 'project-1', html: '<div class="ppt-slide">new</div>', replace: true },
      res,
      sendJSON,
    )

    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    expect(mockDjangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/tabslide/projects/project-1/create-slides/',
      { html: '<div class="ppt-slide">new</div>', title: undefined, mode: 'direct' },
    )
    expect(sendJSON).toHaveBeenCalledWith(res, 200, { ok: true, data: { id: 'project-1' } })
  })

  it('add-page --html 走 append-slides 并透传 after_page_id', async () => {
    mockDjangoRequest.mockResolvedValueOnce({
      status: 200,
      data: { ok: true, data: { id: 'project-1', page_count: 2 } },
    })

    await handleSlideRoute(
      '/slide/add-page',
      'POST',
      {
        project_id: 'project-1',
        html: '<div class="ppt-slide">append</div>',
        title: 'Append',
        after_page: 'page-1',
      },
      res,
      sendJSON,
    )

    expect(mockDjangoRequest).toHaveBeenCalledTimes(1)
    expect(mockDjangoRequest).toHaveBeenCalledWith(
      'POST',
      '/api/tabslide/projects/project-1/append-slides/',
      {
        html: '<div class="ppt-slide">append</div>',
        title: 'Append',
        mode: 'direct',
        page_id: undefined,
        after_page_id: 'page-1',
        base_version: undefined,
      },
      { timeout: 120_000 },
    )
    expect(sendJSON).toHaveBeenCalledWith(res, 200, { ok: true, data: { id: 'project-1', page_count: 2 } })
  })
})
