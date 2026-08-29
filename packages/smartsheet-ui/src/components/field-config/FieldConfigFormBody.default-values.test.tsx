import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import { describe, expect, it, vi } from 'vitest'

import {
  FieldConfigFormBody,
  type FieldConfigFormBodyProps,
} from './FieldConfigFormBody'
import type { FieldSettingFormState } from '../../hooks/useFieldConfigForm'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}))

globalThis.IS_REACT_ACT_ENVIRONMENT = true

class ResizeObserverMock {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverMock as unknown as typeof ResizeObserver
Element.prototype.scrollIntoView = vi.fn()

const baseState: FieldSettingFormState = {
  name: 'Status',
  description: '',
  fieldType: 'multi_select',
  defaultMode: 'literal',
  defaultLiteral: '',
  datetimeDateFormat: 'YYYY/MM/DD',
  datetimeTimeFormat: 'HH:mm',
  datetimeTimeZone: 'Asia/Shanghai',
  ratingMax: 5,
  currencySymbol: '¥',
  userMultiple: false,
  choices: [
    { value: 'Todo', label: 'Todo', color: '#0066CC' },
    { value: 'Done', label: 'Done', color: '#28A745' },
    { value: 'Blocked', label: 'Blocked', color: '#D90A19' },
  ],
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

function renderFieldConfigForm(initialState: FieldSettingFormState, options?: { isPrimary?: boolean }) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)

  const Harness = () => {
    const [state, setState] = React.useState(initialState)
    const setField: FieldConfigFormBodyProps['setField'] = (key, value) => {
      setState((prev) => ({ ...prev, [key]: value }))
    }

    return (
      <FieldConfigFormBody
        state={state}
        errors={{}}
        setName={(name) => setState((prev) => ({ ...prev, name }))}
        setDescription={(description) => setState((prev) => ({ ...prev, description }))}
        setField={setField}
        handleFieldTypeChange={(fieldType) => setState((prev) => ({ ...prev, fieldType }))}
        setDatetimeDateFormat={(datetimeDateFormat) => setState((prev) => ({ ...prev, datetimeDateFormat }))}
        setDatetimeTimeFormat={(datetimeTimeFormat) => setState((prev) => ({ ...prev, datetimeTimeFormat }))}
        setDatetimeTimeZone={(datetimeTimeZone) => setState((prev) => ({ ...prev, datetimeTimeZone }))}
        setRatingMax={(ratingMax) => setState((prev) => ({ ...prev, ratingMax }))}
        setCurrencySymbol={(currencySymbol) => setState((prev) => ({ ...prev, currencySymbol }))}
        setUserMultiple={(userMultiple) => setState((prev) => ({ ...prev, userMultiple }))}
        setChoices={(choices) => setState((prev) => ({ ...prev, choices }))}
        setShowAdvanced={(showAdvanced) => setState((prev) => ({ ...prev, showAdvanced }))}
        setWidth={(width) => setState((prev) => ({ ...prev, width }))}
        setMinLength={(minLength) => setState((prev) => ({ ...prev, minLength }))}
        setMaxLength={(maxLength) => setState((prev) => ({ ...prev, maxLength }))}
        setPattern={(pattern) => setState((prev) => ({ ...prev, pattern }))}
        setValidationMessage={(validationMessage) => setState((prev) => ({ ...prev, validationMessage }))}
        setVisibilityRoles={(visibilityRoles) => setState((prev) => ({ ...prev, visibilityRoles }))}
        isDatetimeField={state.fieldType === 'date'}
        isRatingField={state.fieldType === 'rating'}
        isCurrencyField={state.fieldType === 'currency'}
        isUserField={state.fieldType === 'user'}
        isSelectField={state.fieldType === 'select' || state.fieldType === 'multi_select'}
        isLinkField={state.fieldType === 'link'}
        currentTableId="table-1"
        isPrimary={options?.isPrimary}
        organizationMembers={[
          { id: 'user-1', name: 'Alice' },
          { id: 'user-2', name: 'Bob' },
        ]}
      />
    )
  }

  act(() => {
    root.render(<Harness />)
  })

  return {
    container,
    cleanup: () => {
      act(() => root.unmount())
      container.remove()
      document.body.querySelectorAll('[data-radix-popper-content-wrapper]').forEach((node) => node.remove())
    },
  }
}

function click(element: Element | null) {
  expect(element).not.toBeNull()
  act(() => {
    element!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  })
}

function typeInto(input: HTMLInputElement | null, value: string) {
  expect(input).not.toBeNull()
  act(() => {
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
    valueSetter?.call(input, value)
    input!.dispatchEvent(new Event('input', { bubbles: true }))
  })
}

function findCommandItem(label: string): Element | null {
  return Array.from(document.body.querySelectorAll('[cmdk-item]'))
    .find((item) => item.textContent?.trim() === label) ?? null
}

function findVisibleCommandItem(label: string): Element | null {
  return Array.from(document.body.querySelectorAll('[cmdk-item]:not([hidden])'))
    .find((item) => item.textContent?.trim() === label) ?? null
}

describe('FieldConfigFormBody select defaults', () => {
  it('uses the shared Select trigger for default mode', () => {
    const { container, cleanup } = renderFieldConfigForm(baseState)

    try {
      const trigger = container.querySelector('#field-default-mode')
      expect(trigger).not.toBeNull()
      expect(trigger?.tagName).toBe('BUTTON')
      expect(container.querySelector('select#field-default-mode')).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('searches and chooses single select default values from the combobox', () => {
    const { container, cleanup } = renderFieldConfigForm({
      ...baseState,
      fieldType: 'select',
      defaultLiteral: '',
    })

    try {
      const trigger = container.querySelector('[aria-label="选择默认值"]')
      expect(trigger).not.toBeNull()
      expect(trigger?.tagName).toBe('BUTTON')
      expect(trigger?.getAttribute('role')).toBe('combobox')

      click(trigger)
      const searchInput = document.body.querySelector<HTMLInputElement>('input[placeholder="搜索选项"]')
      typeInto(searchInput, 'Missing')
      expect(document.body.textContent).toContain('没有匹配的选项')

      typeInto(searchInput, 'Block')

      expect(findVisibleCommandItem('Todo')).toBeNull()
      expect(findVisibleCommandItem('Blocked')).not.toBeNull()

      click(findVisibleCommandItem('Blocked'))
      expect(trigger?.textContent).toContain('Blocked')
      expect(document.body.querySelector('input[placeholder="搜索选项"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  it('lets multi-select default values choose multiple options from the picker', () => {
    const { container, cleanup } = renderFieldConfigForm(baseState)

    try {
      expect(container.querySelector('select[multiple]')).toBeNull()

      const trigger = container.querySelector('[aria-label="选择默认值"]')
      click(trigger)
      click(findCommandItem('Todo'))
      click(findCommandItem('Done'))

      expect(trigger?.textContent).toContain('Todo')
      expect(trigger?.textContent).toContain('Done')
    } finally {
      cleanup()
    }
  })

  it('shows time format controls for date fields', () => {
    const { container, cleanup } = renderFieldConfigForm({
      ...baseState,
      fieldType: 'date',
    })

    try {
      expect(container.textContent).toContain('fieldSettingPanel.datetime.timeFormat')
      expect(container.textContent).toContain('fieldSettingPanel.datetime.timeZone')
    } finally {
      cleanup()
    }
  })

  it('uses the member selector for fixed user defaults', () => {
    const { container, cleanup } = renderFieldConfigForm({
      ...baseState,
      fieldType: 'user',
      defaultLiteral: 'user-1',
    })

    try {
      expect(container.textContent).toContain('允许多选')
      expect(container.querySelector('[role="checkbox"]')).not.toBeNull()
      expect(container.textContent).toContain('Alice')
      expect(
        Array.from(container.querySelectorAll('button')).some((button) => button.textContent?.includes('Alice')),
      ).toBe(true)
    } finally {
      cleanup()
    }
  })

  it('renders a boolean control for checkbox defaults', () => {
    const { container, cleanup } = renderFieldConfigForm({
      ...baseState,
      fieldType: 'checkbox',
      defaultLiteral: 'true',
    })

    try {
      const checkbox = container.querySelector('#field-default-checkbox')
      expect(checkbox).not.toBeNull()
      expect(checkbox?.getAttribute('data-state')).toBe('checked')
      expect(container.querySelector('input[placeholder="fieldSettingPanel.defaultLiteralPlaceholder"]')).toBeNull()
    } finally {
      cleanup()
    }
  })

  it.each(['percent', 'currency'] as const)('does not show default value controls for %s fields', (fieldType) => {
    const { container, cleanup } = renderFieldConfigForm({
      ...baseState,
      fieldType,
      defaultMode: 'literal',
      defaultLiteral: '100',
    })

    try {
      expect(container.querySelector('#field-default-mode')).toBeNull()
      expect(container.textContent).not.toContain('fieldSettingPanel.defaultValue')
    } finally {
      cleanup()
    }
  })
})
