import assert from 'node:assert/strict'
import test from 'node:test'

// resolveBlobResponse is internal, so we re-implement the core logic for testing
// This mirrors packages/table-core/src/data/services/import-export-api.ts resolveBlobResponse

function resolveBlobResponse(
  data: { __isBinary: true; __buffer: string; __contentType: string } | Blob | Record<string, unknown> | string | null | undefined,
  fallbackContentType = 'application/octet-stream'
): Blob {
  if (data == null) {
    throw new Error('导出响应为空')
  }

  if (typeof data === 'object' && '__isBinary' in data && (data as any).__isBinary) {
    const binary = data as { __isBinary: true; __buffer: string; __contentType: string }
    const base64 = String(binary.__buffer || '')
    const contentType = String(binary.__contentType || fallbackContentType)
    const binaryStr = atob(base64)
    const bytes = new Uint8Array(binaryStr.length)
    for (let i = 0; i < binaryStr.length; i++) {
      bytes[i] = binaryStr.charCodeAt(i)
    }
    return new Blob([bytes], { type: contentType })
  }

  if (data instanceof Blob) {
    return data
  }

  if (typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>
    if (obj.success === false || obj.error) {
      const msg = (obj.message ?? obj.error ?? 'Export failed') as string
      throw new Error(msg)
    }
    return new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' })
  }

  if (typeof data === 'string') {
    return new Blob([data], { type: 'text/plain' })
  }

  throw new Error('不支持的导出响应类型')
}

test('resolveBlobResponse: __isBinary response → Blob', async () => {
  const base64 = btoa('hello')
  const blob = resolveBlobResponse({
    __isBinary: true,
    __buffer: base64,
    __contentType: 'text/csv',
  })
  assert.ok(blob instanceof Blob)
  assert.equal(blob.type, 'text/csv')
  assert.equal(blob.size, 5)
})

test('resolveBlobResponse: Blob passthrough', () => {
  const input = new Blob(['abc'], { type: 'text/plain' })
  const result = resolveBlobResponse(input)
  assert.strictEqual(result, input)
})

test('resolveBlobResponse: Object → JSON Blob', async () => {
  const obj = { name: 'test', value: 42 }
  const blob = resolveBlobResponse(obj as Record<string, unknown>)
  assert.equal(blob.type, 'application/json')
  const text = await blob.text()
  assert.deepEqual(JSON.parse(text), obj)
})

test('resolveBlobResponse: string → text Blob', async () => {
  const blob = resolveBlobResponse('hello world' as any)
  assert.equal(blob.type, 'text/plain')
  const text = await blob.text()
  assert.equal(text, 'hello world')
})

test('resolveBlobResponse: null → throw', () => {
  assert.throws(() => resolveBlobResponse(null as any), /导出响应为空/)
})

test('resolveBlobResponse: undefined → throw', () => {
  assert.throws(() => resolveBlobResponse(undefined as any), /导出响应为空/)
})

test('resolveBlobResponse: error JSON (success: false) → throw', () => {
  assert.throws(
    () => resolveBlobResponse({ success: false, message: '权限不足' } as Record<string, unknown>),
    /权限不足/,
  )
})

test('resolveBlobResponse: error JSON (error field) → throw', () => {
  assert.throws(
    () => resolveBlobResponse({ error: 'table not found' } as Record<string, unknown>),
    /table not found/,
  )
})
