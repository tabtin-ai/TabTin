import type http from 'node:http'
import { describe, expect, it, vi } from 'vitest'
import { handleCollectRoute } from '../collect'
import type { SendJSON } from '../_helpers'
import { getBrowserApprovalThreadId } from '../../../browser-policy-middleware'

const mocks = vi.hoisted(() => ({
  djangoRequest: vi.fn(),
}))

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => '/tmp'),
    isPackaged: false,
  },
}))

vi.mock('../_helpers', async () => {
  const actual =
    await vi.importActual<typeof import('../_helpers')>('../_helpers')
  return {
    ...actual,
    makeTaskId: vi.fn((name: string) => name),
    resolveTabId: vi.fn(async (tabId: string | undefined) => tabId),
  }
})

vi.mock('../../shared/error-handler', async () => {
  const actual = await vi.importActual<
    typeof import('../../shared/error-handler')
  >('../../shared/error-handler')
  return {
    ...actual,
    djangoRequest: mocks.djangoRequest,
  }
})

describe('browser collect table route', () => {
  it('reuses an existing tab without requiring url and derives source url from location.href', async () => {
    mocks.djangoRequest
      .mockResolvedValueOnce({
        status: 200,
        data: { data: { id: 'tbl-1', name: '当前网页数据' } },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: { data: { success_count: 2, total_count: 2 } },
      })
      .mockResolvedValueOnce({
        status: 200,
        data: {
          data: {
            records: [{ id: 'rec-1' }, { id: 'rec-2' }],
            success_count: 2,
            total_count: 2,
          },
        },
      })

    const executor = vi.fn(async (task: any) => {
      if (task.type === 'eval') {
        expect(getBrowserApprovalThreadId()).toBe('chat-session-collect')
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
        expect(getBrowserApprovalThreadId()).toBe('chat-session-collect')
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
              responseBody: JSON.stringify({
                items: [
                  { name: 'Alpha', price: 12 },
                  { name: 'Beta', price: 18 },
                ],
              }),
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
        target: 'tabdata',
        tableName: '当前网页数据',
        spaceId: 'space-1',
        _thread_id: 'chat-session-collect',
      },
      {} as http.ServerResponse,
      sendJSON,
      executor as any,
    )

    expect(handled).toBe(true)
    expect(responses).toHaveLength(1)
    if (responses[0].status !== 200) {
      throw new Error(JSON.stringify(responses[0].data, null, 2))
    }
    expect(responses[0].status).toBe(200)

    const result = responses[0].data.data
    expect(result.capture_scope.url).toBe('https://example.com/products')
    expect(result.table).toEqual({ id: 'tbl-1', name: '当前网页数据' })
    expect(result.episode_events).toContainEqual(
      expect.objectContaining({
        type: 'episode.stage.completed',
        stage_id: 'open_source',
        label: '复用已有网页',
        metrics: expect.objectContaining({
          tab_id: 'view-1',
          reused_tab: true,
          url: 'https://example.com/products',
        }),
      }),
    )
    expect(executor).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: 'browser_open' }),
    )
    expect(mocks.djangoRequest).toHaveBeenCalledWith(
      'POST',
      '/tabdata/tables',
      expect.objectContaining({
        space_id: 'space-1',
        name: '当前网页数据',
      }),
    )
  })
})
