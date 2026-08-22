import assert from 'node:assert/strict'
import test from 'node:test'
import {
  ViewApiService,
  configureTableDataClient,
  configureTableRuntime,
  resetTableDataClientConfig,
  resetTableRuntime,
  type TableApiPort,
  type TableHttpRequest,
} from '../src'

const createViewPayload = (overrides: Record<string, unknown> = {}) => ({
  id: 'view-1',
  table_id: 'table-1',
  name: 'Grid',
  view_type: 'grid',
  is_default: false,
  is_shared: false,
  is_locked: false,
  order: 0,
  config: {},
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  created_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

const setup = (request: TableApiPort['request']) => {
  resetTableRuntime()
  resetTableDataClientConfig()

  const mockApiPort: TableApiPort = {
    request,
    getAccessToken: async () => 'test-token',
  }

  configureTableRuntime({ api: mockApiPort })
  configureTableDataClient({ baseURL: 'https://api.test' })
}

test('ViewApiService.getViewsByTable 会将 is_locked 字符串归一化为布尔值', async () => {
  setup(async <T = unknown>(_options: TableHttpRequest) => ({
    status: 200,
    data: {
      success: true,
      data: {
        views: [
          createViewPayload({ id: 'view-unlocked', is_locked: '0' }),
          createViewPayload({ id: 'view-locked', is_locked: '1' }),
        ],
        total: 2,
      },
    } as T,
  }))

  const response = await ViewApiService.getViewsByTable('table-1')
  assert.equal(response.views[0].is_locked, false)
  assert.equal(response.views[1].is_locked, true)
})

test('ViewApiService.getViewsByTable 会把旧默认视图名归一为表格视图', async () => {
  setup(async <T = unknown>(_options: TableHttpRequest) => ({
    status: 200,
    data: {
      success: true,
      data: {
        views: [
          createViewPayload({ id: 'view-legacy', name: '默认视图', view_type: 'grid' }),
        ],
        total: 1,
      },
    } as T,
  }))

  const response = await ViewApiService.getViewsByTable('table-1')
  assert.equal(response.views[0].name, '表格视图')
})

test('ViewApiService 在 create/get/update 中统一归一化 is_locked', async () => {
  const queue = [
    { status: 201, is_locked: 'false' },
    { status: 200, is_locked: 1 },
    { status: 200, is_locked: 0 },
  ]

  setup(async <T = unknown>(_options: TableHttpRequest) => {
    const next = queue.shift()
    if (!next) {
      throw new Error('unexpected request')
    }

    return {
      status: next.status,
      data: {
        success: true,
        data: createViewPayload({ is_locked: next.is_locked }),
      } as T,
    }
  })

  const created = await ViewApiService.createView({ table_id: 'table-1', name: 'Create View' })
  const fetched = await ViewApiService.getView('view-1')
  const updated = await ViewApiService.updateView('view-1', { name: 'Renamed' })

  assert.equal(created.is_locked, false)
  assert.equal(fetched.is_locked, true)
  assert.equal(updated.is_locked, false)
})

test('ViewApiService 会将 legacy columnMeta 响应归一到 column_meta', async () => {
  setup(async <T = unknown>(_options: TableHttpRequest) => ({
    status: 200,
    data: {
      success: true,
      data: createViewPayload({
        columnMeta: {
          fld_title: { order: 1, width: 220 },
        },
      }),
    } as T,
  }))

  const view = await ViewApiService.getView('view-1')

  assert.deepEqual(view.column_meta, {
    fld_title: { order: 1, width: 220 },
  })
  assert.equal('columnMeta' in view, false)
})
