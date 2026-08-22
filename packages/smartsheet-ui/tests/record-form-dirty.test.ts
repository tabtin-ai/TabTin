import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isReadonlyRecordFieldType,
  serializeComparableFormData,
} from '../src/components/record/record-form-dirty'

const fields = [
  { name: 'title', field_type: 'text', is_hidden: false },
  { name: 'tags', field_type: 'multi_select', is_hidden: false },
  { name: 'secret', field_type: 'text', is_hidden: true },
  { name: 'created', field_type: 'created_by', is_hidden: false },
  { name: 'modified', field_type: 'last_modified_time', is_hidden: false },
]

test('serializeComparableFormData ignores hidden and readonly field types', () => {
  const serialized = serializeComparableFormData(
    {
      title: 'Hello',
      tags: ['a', 'b'],
      secret: 'hidden-value',
      created: 'user-1',
      modified: '2026-08-20T00:00:00Z',
    },
    fields,
  )

  assert.equal(
    serialized,
    JSON.stringify({
      title: 'Hello',
      tags: ['a', 'b'],
    }),
  )
})

test('serializeComparableFormData treats missing and undefined as null', () => {
  const a = serializeComparableFormData({}, fields)
  const b = serializeComparableFormData({ title: undefined }, fields)
  assert.equal(a, b)
  assert.equal(
    a,
    JSON.stringify({
      title: null,
      tags: null,
    }),
  )
})

test('dirty detection catches editable field edits', () => {
  const baseline = serializeComparableFormData({ title: 'A', tags: [] }, fields)
  const edited = serializeComparableFormData({ title: 'B', tags: [] }, fields)
  assert.notEqual(baseline, edited)
})

test('isReadonlyRecordFieldType covers system field types', () => {
  assert.equal(isReadonlyRecordFieldType('created_time'), true)
  assert.equal(isReadonlyRecordFieldType('last_modified_by'), true)
  assert.equal(isReadonlyRecordFieldType('text'), false)
})
