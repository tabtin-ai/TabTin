/**
 * 导入失败态应展示完成/错误明细，而不是只剩一句红字。
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  shouldShowImportFatalErrorBox,
  shouldShowImportResultDetails,
  type ImportResult,
} from '../src/components/import/import-progress'

const failedResult: ImportResult = {
  created_count: 0,
  updated_count: 0,
  skipped_count: 0,
  error_summary: { column_mismatch: 1 },
  errors: [
    {
      type: 'column_mismatch',
      row: 4,
      field_name: null,
      message: '没有可导入的有效字段',
    },
  ],
}

test('error status with structured result shows result details', () => {
  assert.equal(shouldShowImportResultDetails('error', failedResult), true)
  assert.equal(shouldShowImportFatalErrorBox('error', '没有可导入的有效字段', failedResult), false)
})

test('error status without result falls back to fatal error box', () => {
  assert.equal(shouldShowImportResultDetails('error', null), false)
  assert.equal(shouldShowImportFatalErrorBox('error', '网络错误', null), true)
})

test('success status with result still shows details', () => {
  assert.equal(
    shouldShowImportResultDetails('success', {
      created_count: 2,
      updated_count: 0,
      errors: [],
    }),
    true,
  )
})

test('importing status never shows result details cards', () => {
  assert.equal(shouldShowImportResultDetails('importing', failedResult), false)
})

test('failed result payload retains row for UI grouping', () => {
  const err = failedResult.errors[0]
  assert.equal(typeof err === 'object' && err !== null && 'row' in err, true)
  if (typeof err === 'object' && err !== null && 'row' in err) {
    assert.equal(err.row, 4)
    assert.equal(err.message, '没有可导入的有效字段')
  }
})
