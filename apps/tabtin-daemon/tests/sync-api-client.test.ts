/**
 * Tests for sync-api-client.ts
 *
 * Covers: createRemoteApiClient, createSyncApiClient, createAuthedFetcher (via proxy),
 * ApiError class, and createTableSchemaFetcher.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  createRemoteApiClient,
  createSyncApiClient,
  createTableSchemaFetcher,
  ApiError,
} from '../src/platform/table/sync-api-client.js'

const mockFetch = vi.fn()
const originalFetch = globalThis.fetch

beforeEach(() => {
  globalThis.fetch = mockFetch as any
  mockFetch.mockReset()
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

const config = {
  baseUrl: 'https://api.example.com',
  getAuthToken: async () => 'test-token',
}

function jsonResp(data: unknown, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (h: string) => h.toLowerCase() === 'content-type' ? 'application/json' : null },
    json: () => Promise.resolve(data),
    text: () => Promise.resolve(JSON.stringify(data)),
  }
}

function envelope<T>(data: T) {
  return { success: true, data }
}

// ── createRemoteApiClient ──

describe('createRemoteApiClient', () => {
  it('sets basePath to /tabdata (relative)', () => {
    const client = createRemoteApiClient(config)
    expect(client.basePath).toBe('/tabdata')
  })

  it('constructs correct URL: baseUrl/api + path', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(envelope({})))
    const client = createRemoteApiClient(config)
    await client.post('/tabdata/fields', { name: 'test' })
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/api/tabdata/fields')
  })

  it('does NOT double-prefix basePath', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp(envelope({})))
    const client = createRemoteApiClient(config)
    await client.get('/tabdata/tables/t1')
    const url = mockFetch.mock.calls[0][0]
    expect(url).toBe('https://api.example.com/api/tabdata/tables/t1')
    expect(url).not.toContain('/tabdata/tabdata')
  })

  it('includes Authorization header', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({}))
    const client = createRemoteApiClient(config)
    await client.get('/tabdata/tables')
    expect(mockFetch.mock.calls[0][1].headers['Authorization']).toBe('Bearer test-token')
  })

  it('throws ApiError on non-OK response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 404,
      text: () => Promise.resolve('Not Found'),
      headers: { get: () => null },
    })
    const client = createRemoteApiClient(config)
    await expect(client.get('/tabdata/tables/missing')).rejects.toThrow('API 404')
    try {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 500, text: () => Promise.resolve('ISE'),
        headers: { get: () => null },
      })
      await client.get('/tabdata/tables/x')
    } catch (err) {
      expect(err).toBeInstanceOf(ApiError)
      expect((err as ApiError).status).toBe(500)
    }
  })

  it('strips trailing slashes from baseUrl', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({}))
    const client = createRemoteApiClient({ ...config, baseUrl: 'https://api.example.com/' })
    await client.get('/tabdata/tables')
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/api/tabdata/tables')
  })

  it('returns empty object for non-JSON responses', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true, status: 204,
      headers: { get: () => '' },
      json: () => { throw new Error('no json') },
    })
    const client = createRemoteApiClient(config)
    const result = await client.delete('/tabdata/tables/t1')
    expect(result).toEqual({})
  })
})

// ── createAuthedFetcher behavior (tested via createRemoteApiClient) ──

describe('authedFetcher behavior', () => {
  it('passes AbortSignal.timeout for timeout control', async () => {
    mockFetch.mockResolvedValueOnce(jsonResp({}))
    const client = createRemoteApiClient(config)
    await client.get('/tabdata/tables')
    const init = mockFetch.mock.calls[0][1]
    expect(init.signal).toBeDefined()
  })

  it('handles 304 Not Modified when allowNotModified is set', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false, status: 304,
      headers: { get: () => null },
      text: () => Promise.resolve(''),
    })

    const syncClient = createSyncApiClient(config)
    const delta = await syncClient.fetchDelta('t1', 5)
    expect(delta.version).toBe(5)
    expect(delta.records).toEqual([])
  })
})

// ── createSyncApiClient ──

describe('createSyncApiClient', () => {
  describe('fetchDelta', () => {
    it('returns records from single page', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp(envelope({
        records: [
          { id: 'r1', fields: { name: 'Alice' }, record_version: 3 },
          { id: 'r2', fields: { name: 'Bob' }, record_version: 3 },
        ],
        total: 2,
        latest_version: 3,
      })))

      const client = createSyncApiClient(config)
      const delta = await client.fetchDelta('t1', 1)

      expect(delta.version).toBe(3)
      expect(delta.records).toHaveLength(2)
      expect(delta.records[0].id).toBe('r1')
      expect(delta.records[0].data).toEqual({ id: 'r1', name: 'Alice' })
    })

    it('paginates when first page is full', async () => {
      const pageSize = 1000
      const page1Records = Array.from({ length: pageSize }, (_, i) => ({
        id: `r${i}`, fields: { n: i }, record_version: 10,
      }))
      const page2Records = [{ id: 'r1000', fields: { n: 1000 }, record_version: 10 }]

      mockFetch
        .mockResolvedValueOnce(jsonResp(envelope({ records: page1Records, total: 1001, latest_version: 10 })))
        .mockResolvedValueOnce(jsonResp(envelope({ records: page2Records, total: 1001, latest_version: 10 })))

      const client = createSyncApiClient(config)
      const delta = await client.fetchDelta('t1', 0)

      expect(delta.version).toBe(10)
      expect(delta.records).toHaveLength(1001)
      expect(mockFetch).toHaveBeenCalledTimes(2)
      const url2 = mockFetch.mock.calls[1][0]
      expect(url2).toContain('page=2')
    })

    it('handles 304 Not Modified gracefully', async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false, status: 304,
        headers: { get: () => null },
        text: () => Promise.resolve(''),
      })

      const client = createSyncApiClient(config)
      const delta = await client.fetchDelta('t1', 5)
      expect(delta.version).toBe(5)
      expect(delta.records).toEqual([])
    })

    it('sends correct query parameters', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp(envelope({ records: [], total: 0, latest_version: 0 })))
      const client = createSyncApiClient({ ...config, fieldKeyType: 'name' })
      await client.fetchDelta('t1', 42)

      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('since_version=42')
      expect(url).toContain('only_delta=true')
      expect(url).toContain('field_key_type=name')
    })
  })

  describe('pushChanges', () => {
    it('sends batch-create for create actions', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp(envelope({ created_count: 1 })))
      const client = createSyncApiClient(config)
      const result = await client.pushChanges('t1', [
        { id: 'r1', action: 'create', data: { name: 'New' } },
      ])
      expect(result.newVersion).toBe(-1)
      const url = mockFetch.mock.calls[0][0] as string
      expect(url).toContain('/batch-create')
    })

    it('sends batch-update for update actions', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp(envelope({ updated_count: 1 })))
      const client = createSyncApiClient(config)
      await client.pushChanges('t1', [
        { id: 'r1', action: 'update', data: { name: 'Updated' } },
      ])
      expect(mockFetch.mock.calls[0][0]).toContain('/batch-update')
    })

    it('sends batch-delete for delete actions', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp(envelope({ deleted_count: 2 })))
      const client = createSyncApiClient(config)
      await client.pushChanges('t1', [
        { id: 'r1', action: 'delete' },
        { id: 'r2', action: 'delete' },
      ])
      expect(mockFetch.mock.calls[0][0]).toContain('/batch-delete')
      const body = JSON.parse(mockFetch.mock.calls[0][1].body)
      expect(body.record_ids).toEqual(['r1', 'r2'])
    })

    it('sends idempotency headers when provided', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp(envelope({ created_count: 1 })))
      const client = createSyncApiClient(config)
      await client.pushChanges('t1', [
        { id: 'r1', action: 'create', data: {} },
      ], { idempotencyKey: 'key-123' })

      const headers = mockFetch.mock.calls[0][1].headers
      expect(headers['Idempotency-Key']).toBe('key-123:create')
      expect(headers['X-Change-Id']).toBe('key-123')
    })

    it('splits mixed actions into separate requests', async () => {
      mockFetch
        .mockResolvedValueOnce(jsonResp(envelope({ created_count: 1 })))
        .mockResolvedValueOnce(jsonResp(envelope({ updated_count: 1 })))
        .mockResolvedValueOnce(jsonResp(envelope({ deleted_count: 1 })))

      const client = createSyncApiClient(config)
      await client.pushChanges('t1', [
        { id: 'r1', action: 'create', data: { a: 1 } },
        { id: 'r2', action: 'update', data: { a: 2 } },
        { id: 'r3', action: 'delete' },
      ])
      expect(mockFetch).toHaveBeenCalledTimes(3)
    })

    it('throws when batch count mismatches', async () => {
      mockFetch.mockResolvedValueOnce(jsonResp(envelope({ created_count: 0 })))
      const client = createSyncApiClient(config)
      await expect(
        client.pushChanges('t1', [{ id: 'r1', action: 'create', data: {} }]),
      ).rejects.toThrow('Batch create failed')
    })

    it('skips requests for empty action groups', async () => {
      const client = createSyncApiClient(config)
      const result = await client.pushChanges('t1', [])
      expect(mockFetch).not.toHaveBeenCalled()
      expect(result.newVersion).toBe(-1)
    })
  })
})

// ── ApiError ──

describe('ApiError', () => {
  it('is an instance of Error', () => {
    const err = new ApiError('test', 404)
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(ApiError)
  })

  it('has status and message', () => {
    const err = new ApiError('Not Found', 404)
    expect(err.status).toBe(404)
    expect(err.message).toBe('Not Found')
    expect(err.name).toBe('ApiError')
  })
})

// ── createTableSchemaFetcher ──

describe('createTableSchemaFetcher', () => {
  it('merges api-info and fields into TableSchema', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(envelope({
        table: { id: 't1', name: 'Users', db_table_name: 'tbl_users' },
        fields: [
          { id: 'f1', name: 'Name', type: 'text', db_column_name: 'col_name', is_primary: true },
          { id: 'f2', name: 'Age', type: 'number', db_column_name: 'col_age' },
        ],
      })))
      .mockResolvedValueOnce(jsonResp(envelope({
        fields: [
          { id: 'f1', name: 'Full Name', field_type: 'text', is_primary: true, is_required: true, options: { maxLength: 100 } },
          { id: 'f2', name: 'Age', field_type: 'number', is_required: false },
        ],
        total: 2,
      })))

    const fetcher = createTableSchemaFetcher(config)
    const schema = await fetcher('t1')

    expect(schema.tableId).toBe('t1')
    expect(schema.dbTableName).toBe('tbl_users')
    expect(schema.fields).toHaveLength(2)

    const f1 = schema.fields[0]
    expect(f1.id).toBe('f1')
    expect(f1.name).toBe('Full Name')
    expect(f1.fieldType).toBe('text')
    expect(f1.dbColumnName).toBe('col_name')
    expect(f1.isPrimary).toBe(true)
    expect(f1.isRequired).toBe(true)
    expect(f1.options).toEqual({ maxLength: 100 })

    const f2 = schema.fields[1]
    expect(f2.name).toBe('Age')
    expect(f2.fieldType).toBe('number')
    expect(f2.isPrimary).toBe(false)
    expect(f2.isRequired).toBe(false)
    expect(f2.options).toBeUndefined()
  })

  it('prefers field_type from detail over type from api-info', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(envelope({
        table: { id: 't1', name: 'T', db_table_name: 'tbl' },
        fields: [{ id: 'f1', name: 'F', type: 'varchar', db_column_name: 'col' }],
      })))
      .mockResolvedValueOnce(jsonResp(envelope({
        fields: [{ id: 'f1', name: 'F', field_type: 'text' }],
        total: 1,
      })))

    const fetcher = createTableSchemaFetcher(config)
    const schema = await fetcher('t1')
    expect(schema.fields[0].fieldType).toBe('text')
  })

  it('uses api-info type when no field detail exists', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(envelope({
        table: { id: 't1', name: 'T', db_table_name: 'tbl' },
        fields: [{ id: 'f1', name: 'F', type: 'number', db_column_name: 'col' }],
      })))
      .mockResolvedValueOnce(jsonResp(envelope({ fields: [], total: 0 })))

    const fetcher = createTableSchemaFetcher(config)
    const schema = await fetcher('t1')
    expect(schema.fields[0].fieldType).toBe('number')
    expect(schema.fields[0].isPrimary).toBe(false)
  })

  it('calls correct API endpoints', async () => {
    mockFetch
      .mockResolvedValueOnce(jsonResp(envelope({
        table: { id: 't1', name: 'T', db_table_name: 'tbl' },
        fields: [],
      })))
      .mockResolvedValueOnce(jsonResp(envelope({ fields: [], total: 0 })))

    const fetcher = createTableSchemaFetcher(config)
    await fetcher('t1')

    expect(mockFetch).toHaveBeenCalledTimes(2)
    const url1 = mockFetch.mock.calls[0][0] as string
    const url2 = mockFetch.mock.calls[1][0] as string
    expect(url1).toContain('/tables/t1/api-info')
    expect(url2).toContain('/tables/t1/fields')
  })
})
