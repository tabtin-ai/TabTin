import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configureTableDataClient,
  configureTableRuntime,
  getTableSpaceId,
  resetTableDataClientConfig,
  resetTableRuntime,
  TableApiService,
  type TableApiPort,
  type TableHttpRequest,
} from '../src'

const setup = (payload: unknown) => {
  resetTableRuntime()
  resetTableDataClientConfig()

  const mockApiPort: TableApiPort = {
    request: async <T = unknown>(_options: TableHttpRequest) => ({
      data: {
        success: true,
        data: payload,
      } as T,
      status: 200,
    }),
    getAccessToken: async () => 'test-token',
    getWindowId: () => 'win-normalize-1',
  }

  configureTableRuntime({ api: mockApiPort })
  configureTableDataClient({ baseURL: 'https://api.test' })
}

test('table-api: getTablesBySpace normalizes space_id-only payloads', async () => {
  setup({
    tables: [
      {
        id: 'table-1',
        space_id: 'space-1',
        name: 'Table 1',
        created_by_id: 'user-1',
        is_archived: false,
        created_at: '2026-01-01T00:00:00Z',
        updated_at: '2026-01-01T00:00:00Z',
      },
    ],
    total: 1,
  })

  const response = await TableApiService.getTablesBySpace('ws-1', 'space-1')

  assert.equal(response.tables.length, 1)
  assert.equal(response.tables[0].space_id, 'space-1')
})

test('table-api: getTable normalizes space_id-only payloads', async () => {
  setup({
    id: 'table-1',
    space_id: 'space-1',
    name: 'Table 1',
    created_by_id: 'user-1',
    is_archived: false,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  })

  const table = await TableApiService.getTable('table-1')

  assert.equal(table.space_id, 'space-1')
})

test('table-api: getTableSpaceId returns null when space_id is blank', () => {
  assert.equal(
    getTableSpaceId({ space_id: '   ' }),
    null,
  )
})
