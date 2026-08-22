import assert from 'node:assert/strict'
import test from 'node:test'

import {
  FieldApiService,
  configureTableDataClient,
  configureTableRuntime,
  findMatchingCreatedField,
  isCreateFieldTimeoutError,
  resetTableDataClientConfig,
  resetTableRuntime,
  type Field,
  type TableApiPort,
  type TableHttpRequest,
} from '../src'

const sampleField = (overrides: Partial<Field> = {}): Field => ({
  id: 'f1',
  table_id: 't1',
  name: '状态',
  field_type: 'text',
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

test('isCreateFieldTimeoutError: 识别中英文超时文案', () => {
  assert.equal(isCreateFieldTimeoutError(new Error('请求超时（30s）')), true)
  assert.equal(isCreateFieldTimeoutError(new Error('Network error: Request timeout')), true)
  assert.equal(isCreateFieldTimeoutError(new Error('字段名称"状态"已存在')), false)
})

test('findMatchingCreatedField: 同名同类型命中', () => {
  const fields = [
    sampleField({ id: 'a', name: '标题', field_type: 'text' }),
    sampleField({ id: 'b', name: '状态', field_type: 'text' }),
  ]
  const hit = findMatchingCreatedField(fields, { name: '状态', field_type: 'text' })
  assert.equal(hit?.id, 'b')
  assert.equal(
    findMatchingCreatedField(fields, { name: '状态', field_type: 'number' }),
    null,
  )
})

test('FieldApiService.createField: 超时后对账到已存在字段视为成功', async () => {
  const calls: TableHttpRequest[] = []
  const existing = sampleField({ id: 'existing', name: '状态', field_type: 'text' })

  const mockApiPort: TableApiPort = {
    request: async <T = unknown>(options: TableHttpRequest) => {
      calls.push(options)
      if (options.method === 'POST') {
        throw new Error('请求超时（30s）')
      }
      const envelope = {
        success: true,
        data: {
          fields: [existing],
          total: 1,
        },
      }
      return { data: envelope as unknown as T, status: 200 }
    },
    getAccessToken: async () => 'test-token',
    getWindowId: () => 'win-6754',
  }

  resetTableRuntime()
  resetTableDataClientConfig()
  configureTableRuntime({ api: mockApiPort })
  configureTableDataClient({ baseURL: 'https://api.test' })

  try {
    const field = await FieldApiService.createField({
      table_id: 't1',
      name: '状态',
      field_type: 'text',
    })
    assert.equal(calls.length, 2)
    assert.equal(calls[0].method, 'POST')
    assert.equal(calls[1].method, 'GET')
    assert.equal(field.id, 'existing')
    assert.equal(field.name, '状态')
  } finally {
    resetTableRuntime()
    resetTableDataClientConfig()
  }
})

test('FieldApiService.createField: 超时且列表无同名字段时继续抛超时', async () => {
  const mockApiPort: TableApiPort = {
    request: async <T = unknown>(options: TableHttpRequest) => {
      if (options.method === 'POST') {
        throw new Error('Network error: Request timeout')
      }
      const envelope = {
        success: true,
        data: { fields: [], total: 0 },
      }
      return { data: envelope as unknown as T, status: 200 }
    },
    getAccessToken: async () => 'test-token',
    getWindowId: () => 'win-6754',
  }

  resetTableRuntime()
  resetTableDataClientConfig()
  configureTableRuntime({ api: mockApiPort })
  configureTableDataClient({ baseURL: 'https://api.test' })

  try {
    await assert.rejects(
      () =>
        FieldApiService.createField({
          table_id: 't1',
          name: '状态',
          field_type: 'text',
        }),
      /Request timeout|请求超时/,
    )
  } finally {
    resetTableRuntime()
    resetTableDataClientConfig()
  }
})
