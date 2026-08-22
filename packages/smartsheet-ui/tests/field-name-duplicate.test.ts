import assert from 'node:assert/strict'
import test from 'node:test'

import { getDuplicateFieldNameError } from '../src/hooks/useFieldConfigForm'

const existing = [
  { id: 'f1', name: '标题' },
  { id: 'f2', name: '状态' },
  { id: 'f3', name: ' 日期 ' },
]

test('create: duplicate name returns Chinese error with the input name', () => {
  const err = getDuplicateFieldNameError('状态', { existingFields: existing })
  assert.equal(err, '字段名称「状态」已存在，请输入其他字段名称')
})

test('create: unique name passes', () => {
  assert.equal(getDuplicateFieldNameError('优先级', { existingFields: existing }), null)
})

test('edit: keeping own name is allowed', () => {
  assert.equal(
    getDuplicateFieldNameError('状态', {
      existingFields: existing,
      excludeFieldId: 'f2',
    }),
    null,
  )
})

test('edit: renaming to another existing field is blocked', () => {
  const err = getDuplicateFieldNameError('标题', {
    existingFields: existing,
    excludeFieldId: 'f2',
  })
  assert.equal(err, '字段名称「标题」已存在，请输入其他字段名称')
})

test('trims input and compares against trimmed existing names', () => {
  const err = getDuplicateFieldNameError('  日期  ', { existingFields: existing })
  assert.equal(err, '字段名称「日期」已存在，请输入其他字段名称')
})

test('empty or missing existingFields does not report duplicate', () => {
  assert.equal(getDuplicateFieldNameError('状态'), null)
  assert.equal(getDuplicateFieldNameError('状态', { existingFields: [] }), null)
  assert.equal(getDuplicateFieldNameError('   ', { existingFields: existing }), null)
})
