import assert from 'node:assert/strict'
import { describe, it } from 'node:test'

import { validateFieldDefinitions } from './field-contract.js'

describe('TabData CLI field contract', () => {
  it('accepts every type exposed by the field selector', () => {
    const fieldTypes = [
      'text', 'long_text',
      'number', 'percent', 'currency', 'rating',
      'select', 'multi_select', 'checkbox',
      'date',
      'url', 'email', 'phone',
      'user',
      'attachment',
    ]

    for (const fieldType of fieldTypes) {
      assert.equal(
        validateFieldDefinitions([{ name: fieldType, field_type: fieldType }]),
        null,
        `expected ${fieldType} to remain creatable`,
      )
    }

    assert.equal(
      validateFieldDefinitions([{
        name: '关联',
        field_type: 'link',
        options: { foreignTableId: 'table-1' },
      }]),
      null,
    )
  })

  it('rejects field types that the UI does not offer', () => {
    for (const fieldType of [
      'auto_number', 'datetime', 'created_time', 'last_modified_time',
      'created_by', 'last_modified_by',
      'lookup', 'formula', 'rollup', 'nested_list',
    ]) {
      assert.match(
        validateFieldDefinitions([{ name: fieldType, field_type: fieldType }]) ?? '',
        /尚未在 TabData UI 开放/,
      )
    }
  })
})
