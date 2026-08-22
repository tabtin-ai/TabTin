import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { describe, it } from 'node:test'

import { configureCLIRoutes } from '../../host-bindings.js'
import { handleTableCrudRoute } from './crud.js'

function captureSendJSON() {
  const calls: Array<{ status: number; data: any }> = []
  return {
    calls,
    sendJSON: (_res: ServerResponse, status: number, data: any) => {
      calls.push({ status, data })
    },
  }
}

describe('table crud /create parent_item_id', () => {
  it('forwards parent_item_id to Django create', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return {
          status: 200,
          data: { ok: true, data: { id: 'table-1', name: '子表', space_id: null } },
        }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/create',
      'POST',
      {
        organization_id: 'org-1',
        name: '子表',
        parent_item_id: 'ctx_parent_1',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.method, 'POST')
    assert.equal(requests[0]?.path, '/tabdata/organizations/org-1/tables')
    assert.equal(requests[0]?.body?.parent_item_id, 'ctx_parent_1')
    assert.equal(capture.calls[0]?.status, 200)
  })

  it('omits parent_item_id when not provided (root create)', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return {
          status: 200,
          data: { ok: true, data: { id: 'table-2', name: '根表', space_id: null } },
        }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/create',
      'POST',
      {
        organization_id: 'org-1',
        name: '根表',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests.length, 1)
    assert.equal('parent_item_id' in (requests[0]?.body ?? {}), false)
    assert.equal(capture.calls[0]?.status, 200)
  })
})

describe('table crud /update bulk', () => {
  it('forwards --records as Django BulkRecordUpdateRequest.updates (not items)', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return {
          status: 200,
          data: { ok: true, data: { success_count: 2 } },
        }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/update',
      'POST',
      {
        table_id: 'table-1',
        records: [
          { record_id: 'rec-1', data: { 标题: 'a' } },
          { id: 'rec-2', fields: { 标题: 'b' } },
        ],
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.method, 'POST')
    assert.equal(requests[0]?.path, '/tabdata/records/bulk-update')
    assert.deepEqual(requests[0]?.body, {
      table_id: 'table-1',
      updates: [
        { record_id: 'rec-1', data: { 标题: 'a' } },
        { record_id: 'rec-2', data: { 标题: 'b' } },
      ],
    })
    assert.equal('items' in (requests[0]?.body ?? {}), false)
    assert.equal(capture.calls[0]?.status, 200)
    assert.equal(capture.calls[0]?.data?.ok, true)
  })

  it('rejects bulk update items missing data/fields/cells', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called')
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/update',
      'POST',
      {
        table_id: 'table-1',
        records: [{ record_id: 'rec-1' }],
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 400)
    assert.equal(capture.calls[0]?.data?.ok, false)
    assert.equal(capture.calls[0]?.data?.error?.code, 'VALIDATION_ERROR')
  })

  it('single-record update still uses PUT /tabdata/records/{id}', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/update',
      'POST',
      {
        table_id: 'table-1',
        record_id: 'rec-1',
        data: { 标题: 'x' },
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.deepEqual(requests, [{
      method: 'PUT',
      path: '/tabdata/records/rec-1',
      body: { data: { 标题: 'x' } },
    }])
    assert.equal(capture.calls[0]?.status, 200)
  })

  it('forwards field_key_type on single-record update', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/update',
      'POST',
      {
        table_id: 'table-1',
        record_id: 'rec-1',
        data: { 测试单选: '好吧' },
        field_key_type: 'name',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.deepEqual(requests[0]?.body, {
      data: { 测试单选: '好吧' },
      field_key_type: 'name',
    })
    assert.equal(capture.calls[0]?.status, 200)
  })

  it('forwards field_key_type as query on bulk update', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/update',
      'POST',
      {
        table_id: 'table-1',
        field_key_type: 'id',
        records: [{ record_id: 'rec-1', data: { f1: 'v' } }],
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.path, '/tabdata/records/bulk-update?field_key_type=id')
    assert.equal('field_key_type' in (requests[0]?.body ?? {}), false)
    assert.equal(capture.calls[0]?.status, 200)
  })

  it('coerces BOM-prefixed JSON string data into object', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/update',
      'POST',
      {
        table_id: 'table-1',
        record_id: 'rec-1',
        data: '\uFEFF{"标题":"123"}',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.deepEqual(requests[0]?.body, { data: { 标题: '123' } })
    assert.equal(capture.calls[0]?.status, 200)
  })

  it('coerces BOM-prefixed JSON string records into array', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableCrudRoute(
      '/update',
      'POST',
      {
        table_id: 'table-1',
        records: '\uFEFF[{"record_id":"rec-1","data":{"标题":"123"}}]',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.path, '/tabdata/records/bulk-update')
    assert.deepEqual(requests[0]?.body, {
      table_id: 'table-1',
      updates: [{ record_id: 'rec-1', data: { 标题: '123' } }],
    })
    assert.equal(capture.calls[0]?.status, 200)
  })
})
