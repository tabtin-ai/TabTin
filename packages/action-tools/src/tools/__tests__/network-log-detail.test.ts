import { afterEach, describe, expect, it } from 'vitest'
import { getSharedNetworkLog, resetSharedRuntimeLogs } from '@tabtin/browser-core'
import { networkLogTool, routeTool, unrouteTool } from '../network'

/**
 * BR-8 P3b：browser_network 工具现读 browser-core 共享缓冲（不再自持并行 Map）。
 * 本测试经共享缓冲的 record/recordBody 喂入 CDP 事件，断言工具的 include-* 投影
 * 与脱敏行为不回归。
 */

afterEach(() => {
  resetSharedRuntimeLogs()
})

function seedRequest(tabId: string, params: Record<string, unknown>): void {
  getSharedNetworkLog().record(tabId, { method: 'Network.requestWillBeSent', params })
}

function seedResponse(tabId: string, params: Record<string, unknown>): void {
  getSharedNetworkLog().record(tabId, { method: 'Network.responseReceived', params })
}

describe('browser_network detail projection', () => {
  it('hides headers and bodies by default, and exposes them only via include flags', async () => {
    const tabId = `tab-${Date.now()}`
    seedRequest(tabId, {
      requestId: 'req-1',
      type: 'XHR',
      request: {
        url: 'https://example.com/api/list?access_token=secret-token&page=1',
        method: 'POST',
        headers: { authorization: 'Bearer secret', accept: 'application/json' },
        postData: '{"page":1,"token":"secret-token"}',
      },
    })
    seedResponse(tabId, {
      requestId: 'req-1',
      type: 'XHR',
      response: { status: 200, mimeType: 'application/json', headers: { 'content-type': 'application/json' } },
    })
    getSharedNetworkLog().recordBody(tabId, 'req-1', {
      responseBody: '{"items":[1],"refresh_token":"secret-refresh"}',
      responseBodyBase64Encoded: false,
    })

    const basic = await networkLogTool.execute({ crawlTabId: tabId })
    expect(basic.success).toBe(true)
    expect(basic.data?.[0].url).toContain('access_token=%5Bredacted%5D')
    expect(basic.data?.[0].requestBody).toBeUndefined()
    expect(basic.data?.[0].responseBody).toBeUndefined()
    expect(basic.data?.[0].requestHeaders).toBeUndefined()

    const detailed = await networkLogTool.execute({
      crawlTabId: tabId,
      includeRequestHeaders: true,
      includeRequestBody: true,
      includeResponseHeaders: true,
      includeResponseBody: true,
    })
    expect(detailed.success).toBe(true)
    expect(detailed.data?.[0].requestHeaders?.authorization).toBe('[redacted]')
    expect(detailed.data?.[0].requestHeaders?.accept).toBe('application/json')
    expect(detailed.data?.[0].requestBody).toBe('{"page":1,"token":"[redacted]"}')
    expect(detailed.data?.[0].responseBody).toBe('{"items":[1],"refresh_token":"[redacted]"}')
  })

  it('filters by resource type and mime type as well as URL', async () => {
    const tabId = `tab-filter-${Date.now()}`
    seedRequest(tabId, {
      requestId: 'req-xhr',
      type: 'XHR',
      request: { url: 'https://example.com/data', method: 'POST' },
    })
    seedResponse(tabId, { requestId: 'req-xhr', type: 'XHR', response: { status: 200, mimeType: 'application/json' } })
    seedRequest(tabId, {
      requestId: 'req-img',
      type: 'Image',
      request: { url: 'https://example.com/logo.png', method: 'GET' },
    })
    seedResponse(tabId, { requestId: 'req-img', type: 'Image', response: { status: 200, mimeType: 'image/png' } })

    const xhr = await networkLogTool.execute({ crawlTabId: tabId, filter: 'xhr' })
    expect(xhr.success).toBe(true)
    expect(xhr.data?.map(entry => entry.requestId)).toEqual(['req-xhr'])

    const json = await networkLogTool.execute({ crawlTabId: tabId, filter: 'json' })
    expect(json.success).toBe(true)
    expect(json.data?.map(entry => entry.requestId)).toEqual(['req-xhr'])
  })
})

describe('browser_unroute', () => {
  it('can remove a route by the urlPattern used at registration', async () => {
    const tabId = `tab-route-${Date.now()}`
    const pattern = '**/*.png'

    const route = await routeTool.execute({ crawlTabId: tabId, urlPattern: pattern })
    expect(route.success).toBe(true)

    const unroute = await unrouteTool.execute({ crawlTabId: tabId, urlPattern: pattern })
    expect(unroute.success).toBe(true)
    expect(unroute.data?.removed).toBe(true)
  })
})
