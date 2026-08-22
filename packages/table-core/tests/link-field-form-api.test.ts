import assert from 'node:assert/strict'
import test, { beforeEach, afterEach, mock } from 'node:test'
import {
  configureTableDataClient,
  resetTableDataClientConfig,
  LinkFieldApiService,
} from '../src'

/**
 * Regression tests for LinkFieldApiService.getFormLinkRecords —
 * verifies that public form link records endpoint:
 *
 * - Uses the correct public URL (no JWT required)                    [FMF-001 / CMT-009]
 * - Passes X-Form-Password header for password-protected forms       [FMF-013]
 * - Propagates errors instead of silently returning empty             [FMF-012]
 */

let fetchCalls: Array<{ url: string; init: RequestInit }> = []
let fetchResponse: { ok: boolean; status: number; body: unknown } = {
  ok: true,
  status: 200,
  body: { success: true, data: { records: [], total: 0 } },
}
let originalFetch: typeof globalThis.fetch

beforeEach(() => {
  fetchCalls = []
  fetchResponse = {
    ok: true,
    status: 200,
    body: { success: true, data: { records: [{ id: 'r1', title: 'Record 1' }], total: 1 } },
  }
  resetTableDataClientConfig()
  configureTableDataClient({ baseURL: 'https://api.example.com' })

  originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} })
    return {
      ok: fetchResponse.ok,
      status: fetchResponse.status,
      json: async () => fetchResponse.body,
      headers: new Headers(),
    } as Response
  }) as typeof globalThis.fetch
})

afterEach(() => {
  globalThis.fetch = originalFetch
  resetTableDataClientConfig()
})

// ── FMF-001 / CMT-009: 公开端点 URL 正确性 ──

test('getFormLinkRecords calls /tabdata/forms/{shareId}/link-records/{fieldId}', async () => {
  const res = await LinkFieldApiService.getFormLinkRecords('share-abc', 'field-123')

  assert.equal(fetchCalls.length, 1)
  const calledUrl = fetchCalls[0].url
  assert.ok(
    calledUrl.includes('/tabdata/forms/share-abc/link-records/field-123'),
    `Expected public form endpoint in URL, got: ${calledUrl}`,
  )
  assert.ok(
    calledUrl.startsWith('https://api.example.com'),
    `Expected baseURL prefix, got: ${calledUrl}`,
  )
  assert.equal(res.records.length, 1)
  assert.equal(res.records[0].id, 'r1')
})

test('getFormLinkRecords does NOT use JWT (no Authorization header)', async () => {
  await LinkFieldApiService.getFormLinkRecords('share-abc', 'field-123')

  assert.equal(fetchCalls.length, 1)
  const headers = fetchCalls[0].init.headers as Record<string, string> | undefined
  assert.ok(!headers?.['Authorization'], 'Should not include Authorization header')
})

test('getFormLinkRecords appends search/page/page_size query params', async () => {
  await LinkFieldApiService.getFormLinkRecords('share-abc', 'field-123', {
    search: 'hello',
    page: 2,
    page_size: 25,
  })

  assert.equal(fetchCalls.length, 1)
  const calledUrl = fetchCalls[0].url
  assert.ok(calledUrl.includes('search=hello'), `Missing search param: ${calledUrl}`)
  assert.ok(calledUrl.includes('page=2'), `Missing page param: ${calledUrl}`)
  assert.ok(calledUrl.includes('page_size=25'), `Missing page_size param: ${calledUrl}`)
})

// ── FMF-013: 密码保护表单凭证传递 ──

test('getFormLinkRecords sends X-Form-Password header when formPassword provided', async () => {
  await LinkFieldApiService.getFormLinkRecords('share-abc', 'field-123', {}, 'secret123')

  assert.equal(fetchCalls.length, 1)
  const headers = fetchCalls[0].init.headers as Record<string, string>
  assert.equal(headers['X-Form-Password'], 'secret123')
})

test('getFormLinkRecords omits X-Form-Password header when formPassword is undefined', async () => {
  await LinkFieldApiService.getFormLinkRecords('share-abc', 'field-123')

  assert.equal(fetchCalls.length, 1)
  const headers = fetchCalls[0].init.headers as Record<string, string>
  assert.equal(headers['X-Form-Password'], undefined)
})

// ── FMF-012: 错误不再静默吞噬 ──

test('getFormLinkRecords throws on non-ok response (no silent empty return)', async () => {
  fetchResponse = {
    ok: false,
    status: 403,
    body: { message: '密码错误' },
  }

  await assert.rejects(
    () => LinkFieldApiService.getFormLinkRecords('share-abc', 'field-123'),
    (err: Error) => {
      assert.ok(err.message.includes('密码错误'), `Expected error message about password, got: ${err.message}`)
      return true
    },
  )
})

test('getFormLinkRecords throws on 404 with meaningful message', async () => {
  fetchResponse = {
    ok: false,
    status: 404,
    body: { message: '表单不存在' },
  }

  await assert.rejects(
    () => LinkFieldApiService.getFormLinkRecords('bad-share', 'field-123'),
    (err: Error) => {
      assert.ok(err.message.includes('表单不存在'), `Expected not-found message, got: ${err.message}`)
      return true
    },
  )
})

test('getFormLinkRecords throws with HTTP status on unparseable error body', async () => {
  fetchResponse = {
    ok: false,
    status: 500,
    body: null,
  }
  // Override fetch to simulate JSON parse failure
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    fetchCalls.push({ url: String(input), init: init ?? {} })
    return {
      ok: false,
      status: 500,
      json: async () => { throw new SyntaxError('Unexpected token') },
      headers: new Headers(),
    } as unknown as Response
  }) as typeof globalThis.fetch

  await assert.rejects(
    () => LinkFieldApiService.getFormLinkRecords('share-abc', 'field-123'),
    (err: Error) => {
      assert.ok(err.message.includes('500'), `Expected HTTP status in error, got: ${err.message}`)
      return true
    },
  )
})
