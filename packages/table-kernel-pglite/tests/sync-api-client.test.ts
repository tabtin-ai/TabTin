import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  createSyncApiClient,
  createTableSchemaFetcher,
} from '../../../apps/tabtin-daemon/src/services/sync-api-client.js'

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
    },
  })
}

describe('createSyncApiClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('unwraps Django success envelopes for delta fetches', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      data: {
        records: [
          {
            id: 'rec_1',
            fields: { fld_name: 'Alice' },
            record_version: 7,
          },
        ],
        total: 1,
        latest_version: 7,
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createSyncApiClient({
      baseUrl: 'https://example.com',
      getAuthToken: async () => 'token_123',
    })

    const delta = await client.fetchDelta('tbl_1', 0)

    expect(delta.version).toBe(7)
    expect(delta.records).toEqual([
      {
        id: 'rec_1',
        action: 'update',
        data: { id: 'rec_1', fld_name: 'Alice' },
        version: 7,
      },
    ])
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/tabdata/open/v1/tables/tbl_1/records?'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer token_123',
        }),
      }),
    )
  })

  it('treats HTTP 304 as a no-op delta sync instead of an error', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 304 }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createSyncApiClient({
      baseUrl: 'https://example.com',
      getAuthToken: async () => 'token_123',
    })

    const delta = await client.fetchDelta('tbl_1', 7)

    expect(delta).toEqual({ version: 7, records: [] })
  })

  it('treats business-level batch errors as push failures', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      data: {
        created_count: 0,
        errors: ['duplicate field mapping'],
      },
    }, 201))
    vi.stubGlobal('fetch', fetchMock)

    const client = createSyncApiClient({
      baseUrl: 'https://example.com',
      getAuthToken: async () => 'token_123',
    })

    await expect(client.pushChanges(
      'tbl_1',
      [{ id: 'rec_1', action: 'create', data: { fld_name: 'Alice' } }],
      { idempotencyKey: 'chg_1' },
    )).rejects.toThrow('duplicate field mapping')
  })

  it('sends idempotency headers and validates successful batch counts', async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({
      success: true,
      data: {
        updated_count: 1,
        errors: [],
      },
    }))
    vi.stubGlobal('fetch', fetchMock)

    const client = createSyncApiClient({
      baseUrl: 'https://example.com',
      getAuthToken: async () => 'token_123',
    })

    const result = await client.pushChanges(
      'tbl_1',
      [{ id: 'rec_1', action: 'update', data: { fld_name: 'Alice' } }],
      { idempotencyKey: 'chg_1' },
    )

    expect(result).toEqual({ newVersion: -1 })
    expect(fetchMock).toHaveBeenCalledWith(
      'https://example.com/api/tabdata/open/v1/tables/tbl_1/records/batch-update?field_key_type=id',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token_123',
          'Idempotency-Key': 'chg_1:update',
          'X-Change-Id': 'chg_1',
        }),
      }),
    )
  })
})

describe('createTableSchemaFetcher', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('hydrates daemon table schemas from api-info + fields endpoints', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          table: {
            id: 'tbl_1',
            name: 'Contacts',
            db_table_name: 'tbl_contacts',
          },
          fields: [
            {
              id: 'fld_name',
              name: 'Name',
              type: 'text',
              db_column_name: 'col_name',
              is_primary: false,
            },
          ],
        },
      }))
      .mockResolvedValueOnce(jsonResponse({
        success: true,
        data: {
          fields: [
            {
              id: 'fld_name',
              name: 'Name',
              field_type: 'text',
              options: { maxLength: 100 },
            },
          ],
          total: 1,
        },
      }))
    vi.stubGlobal('fetch', fetchMock)

    const fetchSchema = createTableSchemaFetcher({
      baseUrl: 'https://example.com',
      getAuthToken: async () => 'token_123',
    })

    const schema = await fetchSchema('tbl_1')

    expect(schema).toEqual({
      tableId: 'tbl_1',
      dbTableName: 'tbl_contacts',
      fields: [
        {
          id: 'fld_name',
          name: 'Name',
          fieldType: 'text',
          dbColumnName: 'col_name',
          isPrimary: false,
          options: { maxLength: 100 },
        },
      ],
    })
  })
})
