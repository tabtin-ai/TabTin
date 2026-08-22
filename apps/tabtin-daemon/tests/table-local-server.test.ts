/**
 * Tests for TableLocalServer HTTP routes.
 *
 * Tests route dispatch, parameter validation, and bearer token auth
 * for Field/Table/View endpoints.
 * Uses a real HTTP server with a mocked TableKernelService.
 */
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest'
import http from 'node:http'
import { TableLocalServer, type TableConnectionInfoPublisher } from '../src/transport/table/table-local-server.js'
import type { TableApplicationPort } from '../src/application/table/table-application-port.js'

function ok<T>(data?: T) {
  return { success: true, data, errors: [] }
}

function createMockKernelService(): TableApplicationPort {
  return {
    isReady: true,
    listSyncStatus: vi.fn().mockResolvedValue([]),
    getCachedTableIds: vi.fn().mockReturnValue(['t1']),
    getRecoveredProcessingCount: vi.fn().mockReturnValue(0),
    getSyncStatus: vi.fn().mockResolvedValue({ tableId: 't1', backlog: 0, pending: 0, processing: 0, failed: 0, acked: 0, lastAckVersion: null, lastFlushError: null, lastSyncedVersion: 0 }),
    createField: vi.fn().mockResolvedValue(ok({ fieldId: 'f1' })),
    updateField: vi.fn().mockResolvedValue(ok()),
    deleteField: vi.fn().mockResolvedValue(ok()),
    createTable: vi.fn().mockResolvedValue(ok({ tableId: 't2' })),
    updateTable: vi.fn().mockResolvedValue(ok()),
    deleteTable: vi.fn().mockResolvedValue(ok()),
    archiveTable: vi.fn().mockResolvedValue(ok()),
    restoreTable: vi.fn().mockResolvedValue(ok()),
    createView: vi.fn().mockResolvedValue(ok({ viewId: 'v1' })),
    updateView: vi.fn().mockResolvedValue(ok()),
    deleteView: vi.fn().mockResolvedValue(ok()),
    query: vi.fn().mockResolvedValue([{ id: '1' }]),
    queryWithFilter: vi.fn().mockResolvedValue([{ id: '1' }]),
    createRecord: vi.fn().mockResolvedValue(ok({ recordId: 'r1' })),
    updateRecord: vi.fn().mockResolvedValue(ok()),
    deleteRecord: vi.fn().mockResolvedValue(ok()),
    batchCreateRecords: vi.fn().mockResolvedValue(ok({ recordIds: ['r1'], count: 1 })),
    batchUpdateRecords: vi.fn().mockResolvedValue(ok({ count: 1 })),
    batchDeleteRecords: vi.fn().mockResolvedValue(ok({ count: 1 })),
  } as TableApplicationPort
}

function request(port: number, method: string, path: string, body?: unknown, token?: string): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined
    const headers: Record<string, string> = {}
    if (payload) headers['Content-Type'] = 'application/json'
    if (token) headers['Authorization'] = `Bearer ${token}`
    const req = http.request({
      hostname: '127.0.0.1',
      port,
      path,
      method,
      headers,
    }, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (c) => chunks.push(c))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString()
        let data: any
        try { data = JSON.parse(raw) } catch { data = raw }
        resolve({ status: res.statusCode ?? 0, data })
      })
    })
    req.on('error', reject)
    if (payload) req.write(payload)
    req.end()
  })
}

describe('TableLocalServer routes', () => {
  let server: TableLocalServer
  let port: number
  let token: string
  let mockService: TableApplicationPort

  beforeAll(async () => {
    mockService = createMockKernelService()
    server = new TableLocalServer(mockService, undefined, inMemoryConnectionInfo())
    port = await server.start()
    token = server.getBearerToken()
  })

  afterAll(async () => {
    await server.stop()
  })

  // ── Auth (SVC-02) ──

  it('GET /health returns ok without auth', async () => {
    const { status, data } = await request(port, 'GET', '/health')
    expect(status).toBe(200)
    expect(data.status).toBe('ok')
  })

  it('rejects non-health requests without auth token', async () => {
    const { status } = await request(port, 'POST', '/table/query', { sql: 'SELECT 1' })
    expect(status).toBe(401)
  })

  it('rejects requests with wrong auth token', async () => {
    const { status } = await request(port, 'POST', '/table/query', { sql: 'SELECT 1' }, 'wrong-token')
    expect(status).toBe(401)
  })

  it('accepts requests with valid auth token', async () => {
    const { status, data } = await request(port, 'POST', '/table/query', {
      sql: 'SELECT * FROM tbl', params: [],
    }, token)
    expect(status).toBe(200)
    expect(data.rows).toBeDefined()
  })

  // ── Field routes ──

  it('POST /fields creates a field', async () => {
    const { status, data } = await request(port, 'POST', '/fields', {
      tableId: 't1', name: 'Age', fieldType: 'number',
    }, token)
    expect(status).toBe(201)
    expect(data.success).toBe(true)
    expect((mockService.createField as any)).toHaveBeenCalled()
  })

  it('POST /fields returns 400 if required params missing', async () => {
    const { status } = await request(port, 'POST', '/fields', { tableId: 't1' }, token)
    expect(status).toBe(400)
  })

  it('PATCH /fields/:id updates a field', async () => {
    const { status, data } = await request(port, 'PATCH', '/fields/f1', {
      tableId: 't1', changes: { name: 'Renamed' },
    }, token)
    expect(status).toBe(200)
    expect(data.success).toBe(true)
  })

  it('PATCH /fields/:id returns 400 if tableId missing', async () => {
    const { status } = await request(port, 'PATCH', '/fields/f1', { changes: {} }, token)
    expect(status).toBe(400)
  })

  it('DELETE /fields/:id deletes a field', async () => {
    const { status } = await request(port, 'DELETE', '/fields/f1?tableId=t1', undefined, token)
    expect(status).toBe(200)
  })

  it('DELETE /fields/:id returns 400 if tableId query missing', async () => {
    const { status } = await request(port, 'DELETE', '/fields/f1', undefined, token)
    expect(status).toBe(400)
  })

  // ── Table routes ──

  it('POST /tables creates a table', async () => {
    const { status, data } = await request(port, 'POST', '/tables', {
      spaceId: 'as1', name: 'New Table',
    }, token)
    expect(status).toBe(201)
    expect(data.success).toBe(true)
  })

  it('POST /tables returns 400 if required params missing', async () => {
    const { status } = await request(port, 'POST', '/tables', { name: 'oops' }, token)
    expect(status).toBe(400)
  })

  it('PATCH /tables/:id updates a table', async () => {
    const { status } = await request(port, 'PATCH', '/tables/t1', {
      changes: { name: 'Updated' },
    }, token)
    expect(status).toBe(200)
  })

  it('DELETE /tables/:id deletes a table', async () => {
    const { status } = await request(port, 'DELETE', '/tables/t1', undefined, token)
    expect(status).toBe(200)
  })

  it('POST /tables/:id/archive archives a table', async () => {
    const { status } = await request(port, 'POST', '/tables/t1/archive', {}, token)
    expect(status).toBe(200)
    expect((mockService.archiveTable as any)).toHaveBeenCalledWith('t1')
  })

  it('POST /tables/:id/restore restores a table', async () => {
    const { status } = await request(port, 'POST', '/tables/t1/restore', {}, token)
    expect(status).toBe(200)
    expect((mockService.restoreTable as any)).toHaveBeenCalledWith('t1')
  })

  // ── View routes ──

  it('POST /views creates a view', async () => {
    const { status, data } = await request(port, 'POST', '/views', {
      tableId: 't1', name: 'Grid', viewType: 'grid',
    }, token)
    expect(status).toBe(201)
    expect(data.success).toBe(true)
  })

  it('POST /views 归一化 column_meta，并优先 canonical 字段', async () => {
    await request(port, 'POST', '/views', {
      tableId: 't1',
      name: 'Grid',
      viewType: 'grid',
      column_meta: { fld_title: { width: 220 } },
      columnMeta: { fld_title: { width: 180 } },
    }, token)

    expect((mockService.createView as any)).toHaveBeenLastCalledWith({
      tableId: 't1',
      name: 'Grid',
      viewType: 'grid',
      column_meta: { fld_title: { width: 220 } },
    })
  })

  it('POST /views returns 400 if required params missing', async () => {
    const { status } = await request(port, 'POST', '/views', { tableId: 't1' }, token)
    expect(status).toBe(400)
  })

  it('PATCH /views/:id updates a view', async () => {
    const { status } = await request(port, 'PATCH', '/views/v1', {
      changes: { name: 'Updated View' },
    }, token)
    expect(status).toBe(200)
  })

  it('PATCH /views/:id 将 legacy columnMeta 归一到 column_meta', async () => {
    const { status } = await request(port, 'PATCH', '/views/v1', {
      changes: {
        columnMeta: { fld_title: { width: 260 } },
      },
    }, token)
    expect(status).toBe(200)
    expect((mockService.updateView as any)).toHaveBeenLastCalledWith({
      viewId: 'v1',
      changes: {
        column_meta: { fld_title: { width: 260 } },
      },
    })
  })

  it('DELETE /views/:id deletes a view', async () => {
    const { status } = await request(port, 'DELETE', '/views/v1', undefined, token)
    expect(status).toBe(200)
  })

  // ── 404 ──

  it('returns 404 for unknown routes', async () => {
    const { status } = await request(port, 'GET', '/nonexistent', undefined, token)
    expect(status).toBe(404)
  })

  // ── Record routes ──

  it('POST /table/query executes SELECT query', async () => {
    const { status, data } = await request(port, 'POST', '/table/query', {
      sql: 'SELECT * FROM tbl', params: [],
    }, token)
    expect(status).toBe(200)
    expect(data.rows).toBeDefined()
    expect((mockService.query as any)).toHaveBeenCalled()
  })

  it('POST /table/query rejects write SQL', async () => {
    const { status } = await request(port, 'POST', '/table/query', {
      sql: 'DELETE FROM tbl WHERE 1=1',
    }, token)
    expect(status).toBe(403)
  })

  it('POST /table/query rejects multi-statement SQL', async () => {
    const { status } = await request(port, 'POST', '/table/query', {
      sql: 'SELECT 1; DROP TABLE tbl',
    }, token)
    expect(status).toBe(403)
  })

  it('POST /table/filter-query returns filtered rows', async () => {
    const { status, data } = await request(port, 'POST', '/table/filter-query', {
      tableId: 't1',
      filter: { conjunction: 'and', filterSet: [] },
      limit: 10,
    }, token)
    expect(status).toBe(200)
    expect(data.rows).toBeDefined()
  })

  it('POST /table/filter-query returns 400 if tableId missing', async () => {
    const { status } = await request(port, 'POST', '/table/filter-query', {
      filter: { conjunction: 'and', filterSet: [] },
    }, token)
    expect(status).toBe(400)
  })

  it('POST /table/records creates a record', async () => {
    const { status, data } = await request(port, 'POST', '/table/records', {
      tableId: 't1', data: { name: 'Alice' },
    }, token)
    expect(status).toBe(201)
    expect(data.success).toBe(true)
  })

  it('POST /table/records returns 400 if required params missing', async () => {
    const { status } = await request(port, 'POST', '/table/records', { tableId: 't1' }, token)
    expect(status).toBe(400)
  })

  it('PATCH /table/records/:id updates a record', async () => {
    const { status, data } = await request(port, 'PATCH', '/table/records/r1', {
      tableId: 't1', data: { name: 'Bob' },
    }, token)
    expect(status).toBe(200)
    expect(data.success).toBe(true)
  })

  it('DELETE /table/records/:id deletes a record', async () => {
    const { status } = await request(port, 'DELETE', '/table/records/r1?tableId=t1', undefined, token)
    expect(status).toBe(200)
  })

  it('DELETE /table/records/:id returns 400 if tableId missing', async () => {
    const { status } = await request(port, 'DELETE', '/table/records/r1', undefined, token)
    expect(status).toBe(400)
  })

  it('POST /table/records/batch create', async () => {
    const { status, data } = await request(port, 'POST', '/table/records/batch', {
      tableId: 't1', action: 'create', records: [{ name: 'A' }],
    }, token)
    expect(status).toBe(201)
    expect(data.success).toBe(true)
  })

  it('POST /table/records/batch update', async () => {
    const { status } = await request(port, 'POST', '/table/records/batch', {
      tableId: 't1', action: 'update', records: [{ id: 'r1', data: { name: 'B' } }],
    }, token)
    expect(status).toBe(200)
  })

  it('POST /table/records/batch delete', async () => {
    const { status } = await request(port, 'POST', '/table/records/batch', {
      tableId: 't1', action: 'delete', recordIds: ['r1'],
    }, token)
    expect(status).toBe(200)
  })

  it('POST /table/records/batch returns 400 for unknown action', async () => {
    const { status } = await request(port, 'POST', '/table/records/batch', {
      tableId: 't1', action: 'invalid',
    }, token)
    expect(status).toBe(400)
  })

  it('POST /table/records/batch returns 400 if tableId missing', async () => {
    const { status } = await request(port, 'POST', '/table/records/batch', {
      action: 'create', records: [],
    }, token)
    expect(status).toBe(400)
  })
})

describe('TableLocalServer lifecycle', () => {
  it('shares one listener and one publication across concurrent starts', async () => {
    const connectionInfo = inMemoryConnectionInfo()
    const server = new TableLocalServer(createMockKernelService(), undefined, connectionInfo)

    const [firstPort, secondPort] = await Promise.all([server.start(), server.start()])

    expect(firstPort).toBe(secondPort)
    expect(connectionInfo.publish).toHaveBeenCalledTimes(1)
    await server.stop()
  })

  it('rolls back the listener when publishing connection info fails', async () => {
    const publishError = new Error('config directory is read-only')
    const server = new TableLocalServer(
      createMockKernelService(),
      undefined,
      { publish: vi.fn().mockRejectedValue(publishError), unpublish: vi.fn().mockResolvedValue(undefined) },
    )

    await expect(server.start()).rejects.toBe(publishError)
    await expect(server.stop()).resolves.toBeUndefined()
  })

  it('can retry cleanly after connection-info publication fails', async () => {
    const connectionInfo: TableConnectionInfoPublisher = {
      publish: vi.fn()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce(undefined),
      unpublish: vi.fn().mockResolvedValue(undefined),
    }
    const server = new TableLocalServer(createMockKernelService(), undefined, connectionInfo)

    await expect(server.start()).rejects.toThrow('temporary failure')
    const port = await server.start()

    expect(port).toBeGreaterThan(0)
    expect(connectionInfo.publish).toHaveBeenCalledTimes(2)
    await server.stop()
  })
})

function inMemoryConnectionInfo(): TableConnectionInfoPublisher {
  return { publish: vi.fn().mockResolvedValue(undefined), unpublish: vi.fn().mockResolvedValue(undefined) }
}
