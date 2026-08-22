import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { describe, it } from 'node:test'

import { configureCLIRoutes } from '../../host-bindings.js'
import { handleTableSchemaRoute } from './schema.js'

function captureSendJSON() {
  const calls: Array<{ status: number; data: any }> = []
  return {
    calls,
    sendJSON: (_res: ServerResponse, status: number, data: any) => {
      calls.push({ status, data })
    },
  }
}

describe('table schema /create-view', () => {
  it('expands group_by_field_id into standard groups', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/create-view',
      'POST',
      {
        table_id: 'table-1',
        name: '跟进看板',
        view_type: 'kanban',
        group_by_field_id: 'f56fb0ef-f572-45e9-9f2e-8aec62b8fe5d',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests.length, 1)
    assert.equal(requests[0]?.path, '/tabdata/views')
    assert.deepEqual(requests[0]?.body?.groups, [{
      field_id: 'f56fb0ef-f572-45e9-9f2e-8aec62b8fe5d',
      direction: 'asc',
    }])
    assert.equal('group_by_field_id' in (requests[0]?.body ?? {}), false)
  })

  it('forwards explicit groups unchanged', async () => {
    const requests: Array<{ method: string; path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (method, path, body) => {
        requests.push({ method, path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()
    const groups = [{ field_id: 'field-a', direction: 'desc' }]

    await handleTableSchemaRoute(
      '/create-view',
      'POST',
      {
        table_id: 'table-1',
        name: '看板',
        view_type: 'kanban',
        groups,
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.deepEqual(requests[0]?.body?.groups, groups)
  })

  it('rejects group_by_field_id together with groups', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called')
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/create-view',
      'POST',
      {
        table_id: 'table-1',
        name: '看板',
        view_type: 'kanban',
        group_by_field_id: 'field-a',
        groups: [{ field_id: 'field-a', direction: 'asc' }],
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 400)
    assert.equal(capture.calls[0]?.data?.error?.code, 'VALIDATION_ERROR')
  })
})

describe('table schema /field type parity', () => {
  it('forwards the active field contract', async () => {
    const requests: Array<{ path: string; body: any }> = []
    configureCLIRoutes({
      djangoRequest: async (_method, path, body) => {
        requests.push({ path, body })
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/add-field',
      'POST',
      { table_id: 'table-1', name: 'Notes', field_type: 'text' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(requests[0]?.path, '/tabdata/fields')
    assert.deepEqual(requests[0]?.body, {
      table_id: 'table-1',
      name: 'Notes',
      field_type: 'text',
      description: '',
      options: undefined,
    })
  })

  it('rejects a create request for a type not exposed in the UI', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called')
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/add-field',
      'POST',
      { table_id: 'table-1', name: '公式', field_type: 'formula' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 400)
    assert.match(capture.calls[0]?.data?.error?.message ?? '', /尚未在 TabData UI 开放/)
  })

  it('rejects conversion to a type not exposed in the UI', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called')
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/field-convert',
      'POST',
      { field_id: 'field-1', target_type: 'nested_list' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 400)
    assert.match(capture.calls[0]?.data?.error?.message ?? '', /尚未在 TabData UI 开放/)
  })
})

describe('table schema /attachment-upload（一步编排：本地文件 → OSS → reuse）', () => {
  it('缺少 table_id 时 400，不触发上传', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called')
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/attachment-upload',
      'POST',
      { file: '/tmp/whatever.png', field_id: 'field-1', record_id: 'rec-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 400)
    assert.equal(capture.calls[0]?.data?.error?.code, 'VALIDATION_ERROR')
  })

  it('缺少 field_id 时 400，不触发上传', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called')
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/attachment-upload',
      'POST',
      { file: '/tmp/whatever.png', table_id: 'table-1', record_id: 'rec-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 400)
    assert.equal(capture.calls[0]?.data?.error?.code, 'VALIDATION_ERROR')
  })

  it('缺少 record_id 时 400，不触发上传', async () => {
    configureCLIRoutes({
      djangoRequest: async () => {
        throw new Error('djangoRequest should not be called')
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/attachment-upload',
      'POST',
      { file: '/tmp/whatever.png', table_id: 'table-1', field_id: 'field-1' },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(capture.calls[0]?.status, 400)
    assert.equal(capture.calls[0]?.data?.error?.code, 'VALIDATION_ERROR')
  })

  it('参数齐全但本地文件不存在时，走 OSS guard 失败短路，不调用 attachments/reuse', async () => {
    let djangoCalled = false
    configureCLIRoutes({
      djangoRequest: async () => {
        djangoCalled = true
        return { status: 200, data: { ok: true } }
      },
      getSpaceId: () => 'space-1',
    })
    const capture = captureSendJSON()

    await handleTableSchemaRoute(
      '/attachment-upload',
      'POST',
      {
        file: '/tmp/tabtin-cli-attachment-upload-does-not-exist.bin',
        table_id: 'table-1',
        field_id: 'field-1',
        record_id: 'rec-1',
      },
      {} as ServerResponse,
      capture.sendJSON,
    )

    assert.equal(djangoCalled, false)
    assert.equal(capture.calls[0]?.status, 400)
    assert.equal(capture.calls[0]?.data?.error?.code, 'FILE_NOT_FOUND')
  })
})
