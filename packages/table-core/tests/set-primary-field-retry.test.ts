import assert from 'node:assert/strict'
import test from 'node:test'

import { FieldApiService, isSchemaVersionConflictError } from '../src'

test('isSchemaVersionConflictError: 识别 code / 409 文案', () => {
  const byCode = Object.assign(new Error('conflict'), {
    status: 409,
    code: 'SCHEMA_VERSION_CONFLICT',
  })
  assert.equal(isSchemaVersionConflictError(byCode), true)

  const byMessage = Object.assign(new Error('字段结构已被他人修改（期望版本 6，当前版本 7），请刷新后重试'), {
    statusCode: 409,
  })
  assert.equal(isSchemaVersionConflictError(byMessage), true)

  assert.equal(isSchemaVersionConflictError(new Error('other')), false)
})

test('FieldApiService.setPrimaryField: 版本冲突时刷新后用新版本重试', async () => {
  const original = FieldApiService.updateField
  let calls = 0
  let refreshed = false
  let schemaVersion: number | undefined = 6

  FieldApiService.updateField = (async (_fieldId, data) => {
    calls += 1
    if (calls === 1) {
      assert.equal(data.expected_schema_version, 6)
      const err = Object.assign(new Error('字段结构已被他人修改'), {
        status: 409,
        code: 'SCHEMA_VERSION_CONFLICT',
      })
      throw err
    }
    assert.equal(data.expected_schema_version, 7)
    assert.equal(data.is_primary, true)
    return {
      id: 'f1',
      table_id: 't1',
      name: 'title',
      field_type: 'text',
      is_primary: true,
      is_hidden: false,
      sort_order: 0,
      created_at: '2026-01-01T00:00:00Z',
      updated_at: '2026-01-01T00:00:00Z',
    }
  }) as typeof FieldApiService.updateField

  try {
    const field = await FieldApiService.setPrimaryField('f1', {
      getExpectedSchemaVersion: () => schemaVersion,
      refreshSchemaVersion: async () => {
        refreshed = true
        schemaVersion = 7
      },
    })
    assert.equal(refreshed, true)
    assert.equal(calls, 2)
    assert.equal(field.is_primary, true)
  } finally {
    FieldApiService.updateField = original
  }
})
