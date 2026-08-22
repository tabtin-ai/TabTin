import assert from 'node:assert/strict'
import test from 'node:test'
import {
  configureTableRuntime,
  configureTableDataClient,
  resetTableRuntime,
  resetTableDataClientConfig,
  TableApiService,
  ViewApiService,
  RecordApiService,
  RecordCommentApiService,
  FieldApiService,
  AttachmentApiService,
  ImportExportApiService,
  resolveExportViewQuery,
  UndoRedoApiService,
  DEFAULT_TABLE_DATA_ENDPOINTS,
  type TableApiPort,
  type TableHttpRequest,
} from '../src'

test('contract: package root exports current-view query resolver', () => {
  assert.equal(typeof resolveExportViewQuery, 'function')
})

/**
 * Cross-host contract tests for data service layer.
 *
 * These tests verify that Electron and Web hosts produce identical HTTP
 * request shapes when calling the same service methods. The API port is
 * mocked to capture the raw request and return a valid envelope response.
 */

type CapturedRequest = TableHttpRequest & { _body?: unknown }
const captured: CapturedRequest[] = []

/** Return envelope-wrapped mock data matching each service's expected shape. */
const mockApiPort: TableApiPort = {
  request: async <T = unknown>(options: TableHttpRequest) => {
    const bodyParsed = options.body ? JSON.parse(options.body) : undefined
    captured.push({ ...options, _body: bodyParsed })

    // All services expect TableApiEnvelope<T> where the outer response.data
    // IS the envelope. The service then reads envelope.data for the payload.
    const envelope = {
      success: true,
      data: {
        id: 'mock-id',
        name: 'mock',
        tables: [],
        views: [],
        records: [],
        fields: [],
        total: 0,
        table_id: 'mock-t',
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
      },
    }
    return { data: envelope as unknown as T, status: 200 }
  },
  getAccessToken: async () => 'test-token',
  getWindowId: () => 'win-contract-1',
}

const setup = () => {
  captured.length = 0
  resetTableRuntime()
  resetTableDataClientConfig()
  configureTableRuntime({ api: mockApiPort })
  configureTableDataClient({ baseURL: 'https://api.test' })
}

// --- Import/export contracts ---

test('contract: current-view export sends transient query overrides', async () => {
  setup()
  const filters = [{ id: 'filter-1', field_id: 'field-1', operator: 'equal', value: '待处理', enabled: true }]
  const sorts = [{ field_id: 'field-2', direction: 'desc' as const }]

  await ImportExportApiService.exportExcel({
    table_id: 'table-1',
    view_id: 'view-1',
    filters,
    filter_logic: 'and',
    sorts,
    groups: [],
  })

  const body = captured[0]._body as Record<string, unknown>
  assert.deepEqual(body.filters, filters)
  assert.equal(body.filter_logic, 'and')
  assert.deepEqual(body.sorts, sorts)
  assert.deepEqual(body.groups, [])
})

test('contract: current-view export stats serializes transient query overrides', async () => {
  setup()
  const filters = [{ id: 'filter-1', field_id: 'field-1', operator: 'equal', value: '待处理', enabled: true }]

  await ImportExportApiService.getExportStats('table-1', undefined, 'view-1', {
    filters,
    filter_logic: 'or',
    sorts: [],
    groups: [],
  })

  const url = new URL(captured[0].url)
  assert.deepEqual(JSON.parse(url.searchParams.get('filters') ?? 'null'), filters)
  assert.equal(url.searchParams.get('filter_logic'), 'or')
  assert.deepEqual(JSON.parse(url.searchParams.get('sorts') ?? 'null'), [])
  assert.deepEqual(JSON.parse(url.searchParams.get('groups') ?? 'null'), [])
})

// --- TableApiService contracts ---

test('contract: TableApiService.getTablesBySpace sends GET', async () => {
  setup()
  await TableApiService.getTablesBySpace('ws-1', 'p-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
})

test('contract: TableApiService.createTable sends POST with body', async () => {
  setup()
  await TableApiService.createTable({ name: 'New Table', space_id: 'p-1' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.ok(captured[0]._body)
  assert.equal((captured[0]._body as Record<string, unknown>).name, 'New Table')
})

test('contract: TableApiService.createTable supports org-only body', async () => {
  setup()
  await TableApiService.createTable({ name: 'Org Table', organization_id: 'org-1' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  const body = captured[0]._body as Record<string, unknown>
  assert.equal(body.name, 'Org Table')
  assert.equal(body.organization_id, 'org-1')
  assert.equal(body.space_id, undefined)
})

// --- ViewApiService contracts ---

test('contract: ViewApiService.getViewsByTable sends GET', async () => {
  setup()
  await ViewApiService.getViewsByTable('t-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
})

test('contract: ViewApiService.updateView sends PATCH with partial payload', async () => {
  setup()
  await ViewApiService.updateView('v-1', { name: 'Renamed View' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'PUT')
  assert.equal((captured[0]._body as Record<string, unknown>).name, 'Renamed View')
})

test('contract: ViewApiService.updateViewColumnMeta sends columnMetaRo array payload', async () => {
  setup()
  await ViewApiService.updateViewColumnMeta('v-1', {
    column_meta: {
      fld_title: { order: 1, width: 220 },
      fld_status: { order: 2, hidden: true },
    },
  })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'PUT')
  assert.deepEqual(captured[0]._body, [
    { fieldId: 'fld_title', columnMeta: { order: 1, width: 220 } },
    { fieldId: 'fld_status', columnMeta: { order: 2, hidden: true } },
  ])
  assert.equal(captured[0].headers?.['X-Window-Id'], 'win-contract-1')
})

test('contract: ViewApiService.deleteView includes X-Window-Id header', async () => {
  setup()
  await ViewApiService.deleteView('v-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'DELETE')
  assert.equal(captured[0].headers?.['X-Window-Id'], 'win-contract-1')
})

test('contract: ViewApiService.getViewRecords supports field_key_type query', async () => {
  setup()
  await ViewApiService.getViewRecords('v-1', { field_key_type: 'id' })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].url.includes('field_key_type=id'))
})

test('contract: ViewApiService.getViewRecords supports sub-record search query params', async () => {
  setup()
  await ViewApiService.getViewRecords('v-1', {
    search: 'child',
    search_field_ids: ['fld-a', 'fld-b'],
    search_hide_not_match_rows: true,
  })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].url.includes('search=child'))
  assert.ok(captured[0].url.includes('search_field_ids=fld-a%2Cfld-b'))
  assert.ok(captured[0].url.includes('search_hide_not_match_rows=true'))
})

test('contract: ViewApiService.getViewRecords 仅发送单调 since_version', async () => {
  setup()
  await ViewApiService.getViewRecords('v-1', { since_version: 1_700_000_000_000 as number })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].url.includes('since_version='), false)

  setup()
  await ViewApiService.getViewRecords('v-1', { since_version: 4_000_000_000_123 as number })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].url.includes('since_version=4000000000123'))
})

// --- RecordApiService contracts ---

test('contract: RecordApiService.getRecordsByTable sends GET', async () => {
  setup()
  await RecordApiService.getRecordsByTable('t-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
})

test('contract: RecordApiService.getRecordsByTable supports field_key_type query', async () => {
  setup()
  await RecordApiService.getRecordsByTable('t-1', { field_key_type: 'id' })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].url.includes('field_key_type=id'))
})

test('contract: RecordApiService.getRecordsByTable 仅发送单调 since_version', async () => {
  setup()
  await RecordApiService.getRecordsByTable('t-1', { since_version: 1_700_000_000_000 as number })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].url.includes('since_version='), false)

  setup()
  await RecordApiService.getRecordsByTable('t-1', { since_version: 4_000_000_000_123 as number })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].url.includes('since_version=4000000000123'))
})

test('contract: RecordApiService.getRecord supports field_key_type query', async () => {
  setup()
  await RecordApiService.getRecord('rec-1', { fieldKeyType: 'id', fields: ['fld-1'] })
  assert.equal(captured.length, 1)
  assert.ok(captured[0].url.includes('field_key_type=id'))
  assert.ok(captured[0].url.includes('fields=fld-1'))
})

test('contract: RecordApiService.createRecord sends POST', async () => {
  setup()
  await RecordApiService.createRecord({ table_id: 't-1', data: { name: 'Row 1' } })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.ok(captured[0]._body)
})

test('contract: RecordApiService.deleteRecord retries transient 503 responses', async () => {
  setup()
  let attempts = 0
  const retryingPort: TableApiPort = {
    request: async <T = unknown>(options: TableHttpRequest) => {
      captured.push(options)
      attempts += 1
      if (attempts < 3) {
        return {
          data: {
            success: false,
            code: 'SAVE_BUSY',
            message: 'save busy',
            data: { retryable: true, retry_after_ms: 500 },
          } as unknown as T,
          status: 503,
        }
      }
      return {
        data: { success: true, data: null } as unknown as T,
        status: 200,
      }
    },
    getAccessToken: async () => 'test-token',
    getWindowId: () => 'win-contract-1',
  }
  configureTableRuntime({ api: retryingPort })

  await RecordApiService.deleteRecord('rec-1')

  assert.equal(attempts, 3)
  assert.equal(captured.length, 3)
  assert.ok(captured.every((request) => request.method === 'DELETE'))
})

test('contract: RecordApiService.bulkDeleteRecords retries transient 503 responses', async () => {
  setup()
  let attempts = 0
  const retryingPort: TableApiPort = {
    request: async <T = unknown>(options: TableHttpRequest) => {
      captured.push(options)
      attempts += 1
      if (attempts === 1) {
        return {
          data: {
            success: false,
            code: 'SAVE_BUSY',
            message: 'save busy',
            data: { retryable: true, retry_after_ms: 500 },
          } as unknown as T,
          status: 503,
        }
      }
      return {
        data: { success: true, data: { success_count: 1, errors: [] } } as unknown as T,
        status: 200,
      }
    },
    getAccessToken: async () => 'test-token',
    getWindowId: () => 'win-contract-1',
  }
  configureTableRuntime({ api: retryingPort })

  const result = await RecordApiService.bulkDeleteRecords({
    record_ids: ['rec-1'],
    operation_group_id: 'operation-1',
  })

  assert.equal(result.success_count, 1)
  assert.equal(attempts, 2)
  assert.equal(captured.length, 2)
  assert.ok(captured.every((request) => request.method === 'POST'))
})

// --- RecordCommentApiService contracts ---

test('contract: RecordCommentApiService.listComments scopes pagination and notification anchor to the record', async () => {
  setup()
  await RecordCommentApiService.listComments('rec-1', {
    status: 'resolved',
    limit: 50,
    before: 'cursor-1',
    anchor: 'comment-9',
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
  assert.ok(captured[0].url.includes('/tabdata/records/rec-1/comments'))
  assert.ok(captured[0].url.includes('limit=50'))
  assert.ok(captured[0].url.includes('anchor=comment-9'))
  assert.ok(captured[0].url.includes('status=resolved'))
  assert.equal(captured[0].url.includes('before='), false)
})

test('contract: RecordCommentApiService.createComment preserves actor-safe comment payload', async () => {
  setup()
  await RecordCommentApiService.createComment('rec-1', {
    content: 'Please verify this row',
    mention_user_ids: ['user-2'],
    client_request_id: 'request-1',
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.ok(captured[0].url.includes('/tabdata/records/rec-1/comments'))
  assert.deepEqual(captured[0]._body, {
    content: 'Please verify this row',
    mention_user_ids: ['user-2'],
    client_request_id: 'request-1',
  })
  assert.equal('author_agent_id' in (captured[0]._body as Record<string, unknown>), false)
})

test('contract: RecordCommentApiService.deleteComment addresses comment under its record', async () => {
  setup()
  await RecordCommentApiService.deleteComment('rec-1', 'comment-1')

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'DELETE')
  assert.ok(captured[0].url.includes('/tabdata/records/rec-1/comments/comment-1'))
})

test('contract: RecordCommentApiService.updateThreadStatus uses additive thread endpoint', async () => {
  setup()
  await RecordCommentApiService.updateThreadStatus('rec-1', 'thread-1', 'resolved')

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'PATCH')
  assert.ok(captured[0].url.includes('/tabdata/records/rec-1/comment-threads/thread-1/status'))
  assert.deepEqual(captured[0]._body, { status: 'resolved' })
})

test('contract: RecordCommentApiService.listMentionCandidates uses the canonical record endpoint', async () => {
  setup()
  await RecordCommentApiService.listMentionCandidates('rec-1', 'Ada', 20)

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
  assert.ok(captured[0].url.includes('/tabdata/records/rec-1/comment-mention-candidates'))
  assert.ok(captured[0].url.includes('q=Ada'))
  assert.ok(captured[0].url.includes('limit=20'))
})

test('contract: RecordCommentApiService.listCounts batches visible records by table and status', async () => {
  setup()
  await RecordCommentApiService.listCounts('table-1', ['rec-1', 'rec-2'], 'open')

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
  assert.ok(captured[0].url.includes('/tabdata/tables/table-1/record-comment-counts'))
  assert.ok(captured[0].url.includes('record_ids=rec-1%2Crec-2'))
  assert.ok(captured[0].url.includes('status=open'))
})

// --- AttachmentApiService contracts ---

test('contract: AttachmentApiService.resolveAccessUrl sends exact TabData resource context', async () => {
  setup()
  await AttachmentApiService.resolveAccessUrl({
    file_id: 'file-1',
    table_id: 'table-1',
    field_id: 'field-1',
    record_id: 'record-1',
    reference_id: 'reference-1',
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.ok(captured[0].url.endsWith('/tabdata/attachments/access-url'))
  assert.deepEqual(captured[0]._body, {
    file_id: 'file-1',
    table_id: 'table-1',
    field_id: 'field-1',
    record_id: 'record-1',
    reference_id: 'reference-1',
  })
})

test('contract: AttachmentApiService.uploadPart uses injected direct uploader', async () => {
  setup()
  const originalFetch = globalThis.fetch
  const reportCalls: Array<{ url: string; init?: RequestInit }> = []
  const chunk = new Blob(['hello'])
  let directUploadCalled = false

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    reportCalls.push({ url: String(input), init })
    return new Response(JSON.stringify({
      data: { part_number: 2, etag: '"etag-2"', part_size: chunk.size },
    }), { status: 200 })
  }) as typeof fetch

  try {
    const result = await AttachmentApiService.uploadPart(
      'task-1',
      'item-1',
      2,
      chunk,
      {
        presignedUrl: 'https://oss.example.test/part-2',
        directUploader: async (args) => {
          directUploadCalled = true
          assert.equal(args.presignedUrl, 'https://oss.example.test/part-2')
          assert.equal(args.chunk, chunk)
          return { status: 200, headers: { ETag: '"etag-2"' } }
        },
      },
    )

    assert.equal(directUploadCalled, true)
    assert.equal(reportCalls.length, 1)
    assert.equal(reportCalls[0].init?.method, 'POST')
    assert.match(reportCalls[0].url, /part_number=2/)
    assert.match(reportCalls[0].url, /etag=%22etag-2%22/)
    assert.deepEqual(result, { part_number: 2, etag: '"etag-2"', part_size: chunk.size })
  } finally {
    globalThis.fetch = originalFetch
  }
})

// --- FieldApiService contracts ---

test('contract: FieldApiService.getFields sends GET', async () => {
  setup()
  await FieldApiService.getFields('t-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
})

test('contract: FieldApiService.createField sends POST with field definition', async () => {
  setup()
  await FieldApiService.createField({ table_id: 't-1', name: 'Status', field_type: 'text' })
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.ok(captured[0]._body)
  assert.equal((captured[0]._body as Record<string, unknown>).name, 'Status')
})

test('contract: FieldApiService.deleteField includes X-Window-Id header', async () => {
  setup()
  await FieldApiService.deleteField('fld-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'DELETE')
  assert.equal(captured[0].headers?.['X-Window-Id'], 'win-contract-1')
})

test('contract: UndoRedoApiService.getTableHistory sends GET with expected query', async () => {
  setup()
  await UndoRedoApiService.getTableHistory('t-1', {
    cursor: 'cursor-1',
    startDate: '2026-02-01T00:00:00Z',
    endDate: '2026-02-10T00:00:00Z',
    include_undone: false,
    only_my_operations: true,
    limit: 999,
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
  assert.ok(captured[0].url.includes('/tabdata/tables/t-1/history'))
  assert.ok(captured[0].url.includes('cursor=cursor-1'))
  assert.ok(captured[0].url.includes('startDate=2026-02-01T00%3A00%3A00Z'))
  assert.ok(captured[0].url.includes('endDate=2026-02-10T00%3A00%3A00Z'))
  assert.ok(captured[0].url.includes('include_undone=false'))
  assert.ok(captured[0].url.includes('only_my_operations=true'))
  assert.ok(captured[0].url.includes('limit=200'))
})

test('contract: UndoRedoApiService.getRecordHistory sends GET with expected query', async () => {
  setup()
  await UndoRedoApiService.getRecordHistory('r-1', {
    cursor: 'cursor-2',
    startDate: '2026-01-01T00:00:00Z',
    endDate: '2026-01-31T23:59:59Z',
    include_undone: true,
    limit: 500,
  })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'GET')
  assert.ok(captured[0].url.includes('/tabdata/records/r-1/history'))
  assert.ok(captured[0].url.includes('cursor=cursor-2'))
  assert.ok(captured[0].url.includes('startDate=2026-01-01T00%3A00%3A00Z'))
  assert.ok(captured[0].url.includes('endDate=2026-01-31T23%3A59%3A59Z'))
  assert.ok(captured[0].url.includes('include_undone=true'))
  assert.ok(captured[0].url.includes('limit=200'))
})

test('contract: UndoRedoApiService.restoreRecord uses history restore endpoint', async () => {
  setup()
  await UndoRedoApiService.restoreRecord('r-1', { history_id: 'h-1' })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.ok(captured[0].url.includes('/tabdata/records/r-1/restore-history'))
  assert.equal((captured[0]._body as Record<string, unknown>).history_id, 'h-1')
})

test('contract: RecordApiService.createParentField posts create-parent-field', async () => {
  setup()
  const customPort: TableApiPort = {
    request: async <T = unknown>(options: TableHttpRequest) => {
      const bodyParsed = options.body ? JSON.parse(options.body) : undefined
      captured.push({ ...options, _body: bodyParsed })
      return {
        data: {
          success: true,
          data: {
            field: {
              id: 'fld-parent-1',
              name: '父记录',
              field_type: 'link',
              config: { isSubRecordParentField: true },
            },
          },
        } as unknown as T,
        status: 201,
      }
    },
    getAccessToken: async () => 'test-token',
    getWindowId: () => 'win-contract-1',
  }
  configureTableRuntime({ api: customPort })

  const field = await RecordApiService.createParentField('t-1')

  assert.equal(field.id, 'fld-parent-1')
  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.ok(
    captured[0].url.includes('/tabdata/sub-records/tables/t-1/create-parent-field'),
  )
})

test('contract: RecordApiService.createParentField falls back to ensure on 404', async () => {
  setup()
  const customPort: TableApiPort = {
    request: async <T = unknown>(options: TableHttpRequest) => {
      const bodyParsed = options.body ? JSON.parse(options.body) : undefined
      captured.push({ ...options, _body: bodyParsed })
      if (options.url.includes('/create-parent-field')) {
        return {
          data: { success: false, message: 'Not Found' } as unknown as T,
          status: 404,
        }
      }
      return {
        data: {
          success: true,
          data: {
            field: {
              id: 'fld-ensured',
              name: '父记录',
              field_type: 'link',
              config: { isSubRecordParentField: true },
            },
          },
        } as unknown as T,
        status: 200,
      }
    },
    getAccessToken: async () => 'test-token',
    getWindowId: () => 'win-contract-1',
  }
  configureTableRuntime({ api: customPort })

  const field = await RecordApiService.createParentField('t-1')

  assert.equal(field.id, 'fld-ensured')
  assert.equal(captured.length, 2)
  assert.ok(captured[0].url.includes('/create-parent-field'))
  assert.ok(captured[1].url.includes('/ensure-parent-field'))
})

test('contract: UndoRedoApiService.undoTable includes X-Window-Id header', async () => {
  setup()
  await UndoRedoApiService.undoTable('t-1', { only_my_operations: true })

  assert.equal(captured.length, 1)
  assert.equal(captured[0].method, 'POST')
  assert.equal(captured[0].headers?.['X-Window-Id'], 'win-contract-1')
})

// --- DEFAULT_TABLE_DATA_ENDPOINTS ---

test('contract: DEFAULT_TABLE_DATA_ENDPOINTS contains all required paths', () => {
  const keys = Object.keys(DEFAULT_TABLE_DATA_ENDPOINTS)
  assert.ok(keys.length >= 4, `Expected at least 4 endpoint groups, got ${keys.length}`)
})

// --- Token propagation ---

test('contract: API services propagate Authorization header', async () => {
  setup()
  await TableApiService.getTablesBySpace('ws-1', 'p-1')
  assert.equal(captured.length, 1)
  const headers = captured[0].headers ?? {}
  assert.ok(
    headers['Authorization']?.includes('test-token') ||
      headers['authorization']?.includes('test-token'),
    'Authorization header should contain the access token'
  )
})

// --- URL construction ---

test('contract: API URLs include configured baseURL', async () => {
  setup()
  await FieldApiService.getFields('t-1')
  assert.ok(
    captured[0].url.startsWith('https://api.test'),
    `Expected URL to start with baseURL, got: ${captured[0].url}`
  )
})
