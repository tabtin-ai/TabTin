import { describe, it, expect } from 'vitest'
import {
  snakeToCamelKey,
  camelToSnakeKey,
  snakeToCamelObject,
  camelToSnakeObject,
  externalFilterToKernel,
  kernelFilterToExternal,
  externalSortToKernel,
  externalSortsToKernel,
  kernelSortToExternal,
  buildFieldColumnMap,
  translateFieldId,
} from '../src/index.js'
import type { TableSchema } from '../src/index.js'

describe('field-name-adapter', () => {
  it('converts known snake_case keys to camelCase', () => {
    expect(snakeToCamelKey('field_id')).toBe('fieldId')
    expect(snakeToCamelKey('field_type')).toBe('fieldType')
    expect(snakeToCamelKey('db_column_name')).toBe('dbColumnName')
    expect(snakeToCamelKey('default_value')).toBe('defaultValue')
  })

  it('converts unknown snake_case keys via regex', () => {
    expect(snakeToCamelKey('custom_field_name')).toBe('customFieldName')
  })

  it('converts camelCase back to snake_case', () => {
    expect(camelToSnakeKey('fieldId')).toBe('field_id')
    expect(camelToSnakeKey('fieldType')).toBe('field_type')
    expect(camelToSnakeKey('dbColumnName')).toBe('db_column_name')
  })

  it('converts object keys', () => {
    const obj = { field_id: 'fld_1', field_type: 'text', default_value: null }
    const result = snakeToCamelObject(obj)
    expect(result).toEqual({ fieldId: 'fld_1', fieldType: 'text', defaultValue: null })
  })

  it('converts object keys back', () => {
    const obj = { fieldId: 'fld_1', fieldType: 'text', defaultValue: null }
    const result = camelToSnakeObject(obj)
    expect(result).toEqual({ field_id: 'fld_1', field_type: 'text', default_value: null })
  })
})

describe('filter-adapter', () => {
  it('converts a simple FilterItem', () => {
    const ext = { field_id: 'fld_name', operator: 'contains', value: 'hello' }
    const kernel = externalFilterToKernel(ext)
    expect(kernel).toEqual({ fieldId: 'fld_name', operator: 'contains', value: 'hello' })
  })

  it('converts a nested FilterSet', () => {
    const ext = {
      conjunction: 'and' as const,
      filterSet: [
        { field_id: 'fld_a', operator: 'equals', value: 'x' },
        {
          conjunction: 'or' as const,
          filterSet: [
            { field_id: 'fld_b', operator: 'greater_than', value: 10 },
            { field_id: 'fld_c', operator: 'is_empty' },
          ],
        },
      ],
    }
    const kernel = externalFilterToKernel(ext)
    expect(kernel).toEqual({
      conjunction: 'and',
      filterSet: [
        { fieldId: 'fld_a', operator: 'equals', value: 'x' },
        {
          conjunction: 'or',
          filterSet: [
            { fieldId: 'fld_b', operator: 'greater_than', value: 10 },
            { fieldId: 'fld_c', operator: 'is_empty', value: undefined },
          ],
        },
      ],
    })
  })

  it('round-trips kernel → external → kernel', () => {
    const kernel = { fieldId: 'fld_x', operator: 'contains', value: 'test' }
    const ext = kernelFilterToExternal(kernel)
    expect(ext).toEqual({ field_id: 'fld_x', operator: 'contains', value: 'test' })
    const back = externalFilterToKernel(ext)
    expect(back).toEqual(kernel)
  })
})

describe('sort-adapter', () => {
  it('converts a single sort', () => {
    const ext = { field_id: 'fld_name', direction: 'asc' as const }
    const kernel = externalSortToKernel(ext)
    expect(kernel).toEqual({ fieldId: 'fld_name', order: 'asc' })
  })

  it('converts and sorts by priority', () => {
    const exts = [
      { field_id: 'fld_b', direction: 'desc' as const, priority: 2 },
      { field_id: 'fld_a', direction: 'asc' as const, priority: 1 },
    ]
    const kernels = externalSortsToKernel(exts)
    expect(kernels[0].fieldId).toBe('fld_a')
    expect(kernels[1].fieldId).toBe('fld_b')
  })

  it('round-trips kernel → external → kernel', () => {
    const kernel = { fieldId: 'fld_x', order: 'desc' as const }
    const ext = kernelSortToExternal(kernel)
    expect(ext).toEqual({ field_id: 'fld_x', direction: 'desc' })
  })
})

describe('column-map', () => {
  const schema: TableSchema = {
    tableId: 'tbl_1',
    dbTableName: 'tbl_data_1',
    fields: [
      { id: 'fld_name', name: 'Name', fieldType: 'text', dbColumnName: 'col_name', isPrimary: false },
      { id: 'fld_age', name: 'Age', fieldType: 'number', dbColumnName: 'col_age', isPrimary: false },
    ],
  }

  it('builds map from schema', () => {
    const map = buildFieldColumnMap(schema)
    expect(map.get('fld_name')).toBe('col_name')
    expect(map.get('fld_age')).toBe('col_age')
  })

  it('translates known fieldId', () => {
    const map = buildFieldColumnMap(schema)
    expect(translateFieldId('fld_name', map)).toBe('col_name')
  })

  it('falls back to original for unknown fieldId', () => {
    const map = buildFieldColumnMap(schema)
    expect(translateFieldId('fld_unknown', map)).toBe('fld_unknown')
  })
})
