import { describe, expect, it } from 'vitest'

import { findFieldMetaIndex, orderFieldsMeta } from './field-meta-order'

describe('field metadata ordering for positional inserts', () => {
  it('uses persisted order instead of Y.Map insertion order', () => {
    const fields = [
      { id: 'tail', order: 2 },
      { id: 'reference', order: 1 },
      { id: 'first', order: 0 },
    ]

    expect(orderFieldsMeta(fields).map(field => field.id)).toEqual([
      'first',
      'reference',
      'tail',
    ])
    expect(findFieldMetaIndex(fields, 'reference')).toBe(1)
  })

  it('matches UUID references with or without dashes', () => {
    const fields = [{ id: 'aabbccdd-eeff-0011-2233-445566778899', order: 0 }]

    expect(findFieldMetaIndex(fields, 'aabbccddeeff00112233445566778899')).toBe(0)
  })
})
