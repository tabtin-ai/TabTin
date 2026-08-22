import assert from 'node:assert/strict'
import { afterEach, describe, it } from 'node:test'

import {
  requestJsonApi,
  snapshotTableRequestHeaders,
  withTableRequestHeaders,
} from '../src/data/http'
import {
  resetTableRuntime,
  setAppHostClient,
  setTableApiPort,
} from '../src/runtime/registry'
import type { TableHttpRequest, TableHttpResponse } from '../src/runtime/ports'
import { RecordApiService } from '../src/data/services/record-api'

describe('withTableRequestHeaders', () => {
  afterEach(() => {
    resetTableRuntime()
  })

  it('adds the parent document only to requests started in the scoped operation', async () => {
    const requests: Array<{ headers?: Record<string, string> }> = []
    const request = async (input: { headers?: Record<string, string> }) => {
      requests.push(input)
      return { ok: true }
    }
    setAppHostClient({ request } as never)

    await withTableRequestHeaders(
      { 'X-TabTin-Parent-Document-Id': 'doc-parent' },
      () => requestJsonApi({
        method: 'GET',
        endpoint: '/tabdata/tables/table-child',
        fallbackError: 'failed',
      }),
    )
    await requestJsonApi({
      method: 'GET',
      endpoint: '/tabdata/tables/table-standalone',
      fallbackError: 'failed',
    })

    assert.equal(
      requests[0]?.headers?.['X-TabTin-Parent-Document-Id'],
      'doc-parent',
    )
    assert.equal(
      requests[1]?.headers?.['X-TabTin-Parent-Document-Id'],
      undefined,
    )
  })

  it('can carry a request header snapshot across an async token lookup', async () => {
    const pending = withTableRequestHeaders(
      { 'X-TabTin-Parent-Document-Id': 'parent-doc' },
      async () => {
        const headers = snapshotTableRequestHeaders()
        await Promise.resolve()
        return headers
      },
    )

    assert.deepEqual(await pending, {
      'X-TabTin-Parent-Document-Id': 'parent-doc',
    })
    assert.deepEqual(snapshotTableRequestHeaders(), {})
  })

  it('keeps the parent header on record loading after token lookup', async () => {
    const requests: TableHttpRequest[] = []
    setTableApiPort({
      getAccessToken: async () => 'token',
      request: async <T>(options: TableHttpRequest): Promise<TableHttpResponse<T>> => {
        requests.push(options)
        return {
          status: 200,
          data: {
            success: true,
            data: { records: [], total: 0, page: 1, page_size: 100 },
          } as T,
        }
      },
    })

    await withTableRequestHeaders(
      { 'X-TabTin-Parent-Document-Id': 'parent-doc' },
      () => RecordApiService.getRecordsByTable('child-table'),
    )

    assert.equal(
      requests[0]?.headers?.['X-TabTin-Parent-Document-Id'],
      'parent-doc',
    )
  })

  it('distinguishes a temporary embedded-access verification failure', async () => {
    setTableApiPort({
      getAccessToken: async () => 'token',
      request: async <T>(): Promise<TableHttpResponse<T>> => ({
        status: 403,
        headers: { 'X-TabTin-Embedded-Access-Unavailable': '1' },
        data: {
          success: false,
          code: 'PERMISSION_DENIED',
          message: 'permission denied',
        } as T,
      }),
    })

    await assert.rejects(
      requestJsonApi({
        method: 'GET',
        endpoint: '/tabdata/tables/child-table',
        fallbackError: 'failed',
      }),
      (error: unknown) => {
        const actual = error as { status?: number; code?: string }
        return actual.status === 403
          && actual.code === 'EMBEDDED_ACCESS_UNAVAILABLE'
      },
    )
  })
})
