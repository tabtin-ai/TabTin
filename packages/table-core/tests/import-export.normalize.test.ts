/**
 * normalizeImportResult 测试
 *
 * 自包含模式：不通过 barrel 导入（避免 @tabtin/table-kernel CJS 解析问题）。
 * 镜像 src/data/services/import-export-api.ts 中的 normalizeImportResult 逻辑。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

interface ImportResultPayload {
  created_count: number
  updated_count: number
  skipped_count?: number
  error_summary?: Record<string, number>
  errors?: unknown[] | null
  import_metadata?: Record<string, unknown>
}

function normalizeImportResult(payload: ImportResultPayload): ImportResultPayload {
  return {
    created_count: payload.created_count ?? 0,
    updated_count: payload.updated_count ?? 0,
    skipped_count: payload.skipped_count ?? 0,
    error_summary: payload.error_summary ?? {},
    errors: Array.isArray(payload.errors) ? payload.errors : [],
    import_metadata: payload.import_metadata,
  }
}

function shouldTreatImportResultAsFailure(result: ImportResultPayload): boolean {
  return result.created_count + result.updated_count === 0 && (result.errors?.length ?? 0) > 0
}

function getImportResultErrorMessage(errors: unknown[] | null | undefined): string {
  const first = errors?.[0]
  if (typeof first === 'string') return first
  if (first && typeof first === 'object' && 'message' in first && typeof first.message === 'string') {
    return first.message
  }
  return first == null ? '导入失败：没有导入任何记录' : JSON.stringify(first)
}

class ImportResultError extends Error {
  readonly result: ImportResultPayload

  constructor(result: ImportResultPayload, message?: string) {
    super(message ?? getImportResultErrorMessage(result.errors))
    this.name = 'ImportResultError'
    this.result = result
  }
}

function isImportResultError(error: unknown): error is ImportResultError {
  return error instanceof ImportResultError
}

function normalizeAndValidateImportResult(payload: ImportResultPayload): ImportResultPayload {
  const result = normalizeImportResult(payload)
  if (shouldTreatImportResultAsFailure(result)) {
    throw new ImportResultError(result)
  }
  return result
}

test('normalizeImportResult: passes through all fields when present', () => {
  const input: ImportResultPayload = {
    created_count: 10,
    updated_count: 5,
    skipped_count: 3,
    error_summary: { type_mismatch: 2, null_violation: 1 },
    errors: [{ type: 'type_mismatch', row: 1, field_name: 'name', message: 'bad' }],
    import_metadata: { auto_create_missing_fields: true },
  }
  const result = normalizeImportResult(input)
  assert.equal(result.created_count, 10)
  assert.equal(result.updated_count, 5)
  assert.equal(result.skipped_count, 3)
  assert.deepEqual(result.error_summary, { type_mismatch: 2, null_violation: 1 })
  assert.deepEqual(result.errors, input.errors)
  assert.deepEqual(result.import_metadata, { auto_create_missing_fields: true })
})

test('normalizeImportResult: skipped_count defaults to 0 when missing', () => {
  const input = { created_count: 1, updated_count: 2, errors: [] }
  const result = normalizeImportResult(input)
  assert.equal(result.skipped_count, 0)
})

test('normalizeImportResult: error_summary defaults to {} when missing', () => {
  const input = { created_count: 0, updated_count: 0, errors: [] }
  const result = normalizeImportResult(input)
  assert.deepEqual(result.error_summary, {})
})

test('normalizeImportResult: errors normalizes null to []', () => {
  const input = { created_count: 0, updated_count: 0, errors: null } as unknown as ImportResultPayload
  const result = normalizeImportResult(input)
  assert.deepEqual(result.errors, [])
})

test('normalizeImportResult: errors normalizes undefined to []', () => {
  const input = { created_count: 0, updated_count: 0 } as ImportResultPayload
  const result = normalizeImportResult(input)
  assert.deepEqual(result.errors, [])
})

test('normalizeImportResult: created_count and updated_count pass through', () => {
  const input = { created_count: 42, updated_count: 99, errors: ['row 3 failed'] }
  const result = normalizeImportResult(input)
  assert.equal(result.created_count, 42)
  assert.equal(result.updated_count, 99)
})

test('normalizeImportResult: all optional fields missing at once', () => {
  const input = { created_count: 0, updated_count: 0 } as ImportResultPayload
  const result = normalizeImportResult(input)
  assert.equal(result.skipped_count, 0)
  assert.deepEqual(result.error_summary, {})
  assert.deepEqual(result.errors, [])
  assert.equal(result.import_metadata, undefined)
})

test('normalizeAndValidateImportResult: zero-write result with errors throws ImportResultError with result', () => {
  const errors = [
    { type: 'column_mismatch', row: 4, field_name: null, message: '没有可导入的有效字段' },
  ]
  try {
    normalizeAndValidateImportResult({
      created_count: 0,
      updated_count: 0,
      skipped_count: 0,
      error_summary: { column_mismatch: 1 },
      errors,
    })
    assert.fail('expected throw')
  } catch (error) {
    assert.equal(isImportResultError(error), true)
    assert.equal((error as ImportResultError).message, '没有可导入的有效字段')
    assert.equal((error as ImportResultError).result.created_count, 0)
    assert.equal((error as ImportResultError).result.updated_count, 0)
    assert.deepEqual((error as ImportResultError).result.errors, errors)
    assert.deepEqual((error as ImportResultError).result.error_summary, { column_mismatch: 1 })
  }
})

test('normalizeAndValidateImportResult: partial success with errors does not throw', () => {
  const result = normalizeAndValidateImportResult({
    created_count: 1,
    updated_count: 0,
    errors: ['第3行格式不符'],
  })
  assert.equal(result.created_count, 1)
})
