import { describe, expect, it } from 'vitest'

import { applyRecordCreateDefaults, type FieldDefinition } from './record-form-dialog'

const userField = (multiple: boolean): FieldDefinition => ({
  id: 'field-owner',
  name: 'Owner',
  field_type: 'user',
  is_primary: false,
  is_hidden: false,
  options: { multiple },
  default_value: { mode: 'creator' },
})

describe('applyRecordCreateDefaults', () => {
  it('prefills creator defaults using the current user shape', () => {
    expect(applyRecordCreateDefaults({}, [userField(false)], 'user-1')).toEqual({
      Owner: 'user-1',
    })
    expect(applyRecordCreateDefaults({}, [userField(true)], 'user-1')).toEqual({
      Owner: ['user-1'],
    })
  })

  it('preserves an explicit clear instead of applying the creator again', () => {
    expect(applyRecordCreateDefaults({ Owner: null }, [userField(false)], 'user-1')).toEqual({
      Owner: null,
    })
  })
})
