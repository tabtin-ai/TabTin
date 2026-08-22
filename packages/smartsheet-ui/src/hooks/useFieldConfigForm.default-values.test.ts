import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it } from 'vitest'

import {
  buildFieldDefaultValueFromState,
  type FieldSettingFormState,
  useFieldConfigForm,
} from './useFieldConfigForm'

const baseState: FieldSettingFormState = {
  name: 'Field',
  description: '',
  fieldType: 'text',
  defaultMode: 'none',
  defaultLiteral: '',
  datetimeDateFormat: 'YYYY/MM/DD',
  datetimeTimeFormat: 'HH:mm',
  datetimeTimeZone: 'Asia/Shanghai',
  ratingMax: 5,
  currencySymbol: '¥',
  userMultiple: false,
  choices: [],
  linkForeignTableId: '',
  linkRelationship: 'ManyOne',
  linkIsOneWay: false,
  linkLookupFieldId: '',
  linkFilterByViewId: '',
  linkFilter: null,
  linkVisibleFieldIds: [],
  width: '',
  minLength: '',
  maxLength: '',
  pattern: '',
  validationMessage: '',
  visibilityRoles: [],
  showAdvanced: false,
}

globalThis.IS_REACT_ACT_ENVIRONMENT = true

function renderFieldConfigFormHook() {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  let current: ReturnType<typeof useFieldConfigForm> | null = null

  const Harness = () => {
    current = useFieldConfigForm()
    return null
  }

  act(() => root.render(React.createElement(Harness)))

  return {
    get current() {
      if (!current) throw new Error('hook did not render')
      return current
    },
    cleanup() {
      act(() => root.unmount())
      container.remove()
    },
  }
}

describe('buildFieldDefaultValueFromState', () => {
  it('builds literal defaults for text fields', () => {
    expect(buildFieldDefaultValueFromState({
      ...baseState,
      defaultMode: 'literal',
      defaultLiteral: 'Alice',
    })).toEqual({
      mode: 'literal',
      value: 'Alice',
    })
  })

  it('builds literal defaults for select fields', () => {
    expect(buildFieldDefaultValueFromState({
      ...baseState,
      fieldType: 'select',
      defaultMode: 'literal',
      defaultLiteral: 'todo',
    })).toEqual({
      mode: 'literal',
      value: 'todo',
    })
  })

  it('builds list literal defaults for multi-select and multi-user fields', () => {
    expect(buildFieldDefaultValueFromState({
      ...baseState,
      fieldType: 'multi_select',
      defaultMode: 'literal',
      defaultLiteral: 'todo, done',
    })).toEqual({
      mode: 'literal',
      value: ['todo', 'done'],
    })

    expect(buildFieldDefaultValueFromState({
      ...baseState,
      fieldType: 'user',
      userMultiple: true,
      defaultMode: 'literal',
      defaultLiteral: 'user-1, user-2',
    })).toEqual({
      mode: 'literal',
      value: ['user-1', 'user-2'],
    })
  })

  it('builds creator defaults for user fields', () => {
    expect(buildFieldDefaultValueFromState({
      ...baseState,
      fieldType: 'user',
      defaultMode: 'creator',
    })).toEqual({
      mode: 'creator',
    })
  })

  it.each(['percent', 'currency'] as const)('does not build defaults for %s fields', (fieldType) => {
    expect(buildFieldDefaultValueFromState({
      ...baseState,
      fieldType,
      defaultMode: 'literal',
      defaultLiteral: '100',
    })).toBeNull()
  })
})

describe('useFieldConfigForm default contract', () => {
  it('preserves structured select colors when editing and building the payload', () => {
    const hook = renderFieldConfigFormHook()

    try {
      act(() => {
        hook.current.initFromField({
          name: 'Priority',
          description: '',
          field_type: 'select',
          options: {
            choices: [{ value: 'P0', label: 'P0', color: '#D90A19' }],
          },
        })
      })

      expect(hook.current.state.choices).toEqual([
        { value: 'P0', label: 'P0', color: '#D90A19' },
      ])
      expect(hook.current.buildPayload()).toMatchObject({
        options: {
          choices: [{ value: 'P0', label: 'P0', color: '#D90A19' }],
        },
      })
    } finally {
      hook.cleanup()
    }
  })

  it('preserves the default value', () => {
    const hook = renderFieldConfigFormHook()

    try {
      act(() => {
        hook.current.setName('Owner')
        hook.current.setField('defaultMode', 'literal')
        hook.current.setField('defaultLiteral', 'Alice')
      })

      expect(hook.current.buildPayload()).toMatchObject({
        name: 'Owner',
        default_value: { mode: 'literal', value: 'Alice' },
      })
    } finally {
      hook.cleanup()
    }
  })

})
