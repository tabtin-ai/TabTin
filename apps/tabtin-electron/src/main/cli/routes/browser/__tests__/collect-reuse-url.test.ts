import type http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import type { SendJSON } from '../_helpers'

const mocks = vi.hoisted(() => ({
  djangoRequest: vi.fn(),
  handleTabsRoute: vi.fn(),
}))

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => '/tmp'), isPackaged: false },
}))

vi.mock('../_helpers', async () => {
  const actual = await vi.importActual<typeof import('../_helpers')>('../_helpers')
  return {
    ...actual,
    makeTaskId: vi.fn((name: string) => name),
    resolveTabId: vi.fn(async (tabId: string | undefined) => tabId),
  }
})

vi.mock('../../shared/error-handler', async () => {
  const actual = await vi.importActual<typeof import('../../shared/error-handler')>(
    '../../shared/error-handler',
  )
  return { ...actual, djangoRequest: mocks.djangoRequest }
})

// mock /open 路由：既隔离掉导航守卫的脆性，又能断言「复用 tab 带 url 时确实触发了导航」。
vi.mock('../tabs', () => ({
  handleTabsRoute: mocks.handleTabsRoute,
}))

import { handleCollectRoute } from '../collect'

describe('browser collect · 复用 tab 带 url 时先导航', () => {
  it('reuse tab with url triggers /open (load_tab_url settled) before collecting', async () => {
    mocks.handleTabsRoute.mockImplementation(
      async (_route: string, body: any, _res: any, sendJSON: SendJSON) => {
        sendJSON({} as http.ServerResponse, 200, {
          ok: true,
          data: { tabId: body.tabId, viewId: body.tabId },
        })
        return true
      },
    )

    mocks.djangoRequest
      .mockResolvedValueOnce({ status: 200, data: { data: { id: 'tbl-1', name: '当前网页数据' } } })
      .mockResolvedValueOnce({ status: 200, data: { data: { success_count: 2, total_count: 2 } } })
      .mockResolvedValueOnce({
        status: 200,
        data: { data: { records: [{ id: 'rec-1' }, { id: 'rec-2' }], success_count: 2, total_count: 2 } },
      })

    const executor = vi.fn(async (task: any) => {
      if (task.type === 'eval') {
        return {
          success: true,
          data: {
            result: JSON.stringify({
              ready_state: 'complete',
              url: 'https://example.com/products',
              title: 'Products',
              body_text_length: 120,
            }),
          },
        }
      }
      if (task.type === 'browser_network') {
        return {
          success: true,
          data: [
            {
              requestId: 'items-1',
              url: 'https://example.com/api/products',
              method: 'GET',
              status: 200,
              resourceType: 'XHR',
              mimeType: 'application/json',
              responseBody: JSON.stringify({ items: [{ name: 'Alpha', price: 12 }, { name: 'Beta', price: 18 }] }),
            },
          ],
        }
      }
      throw new Error(`unexpected task type: ${task.type}`)
    })

    const responses: Array<{ status: number; data: any }> = []
    const sendJSON: SendJSON = (_res, status, data) => {
      responses.push({ status, data })
    }

    const handled = await handleCollectRoute(
      '/collect/table',
      {
        tabId: 'view-1',
        url: 'https://example.com/products',
        target: 'tabdata',
        tableName: '当前网页数据',
        spaceId: 'space-1',
      },
      {} as http.ServerResponse,
      sendJSON,
      executor as any,
    )

    expect(handled).toBe(true)
    // 核心断言：复用 tab 且带 url → 经 /open 走导航（tabId + url 一并传入）
    expect(mocks.handleTabsRoute).toHaveBeenCalledWith(
      '/open',
      expect.objectContaining({ tabId: 'view-1', url: 'https://example.com/products' }),
      expect.anything(),
      expect.any(Function),
      expect.any(Function),
    )
  })
})
