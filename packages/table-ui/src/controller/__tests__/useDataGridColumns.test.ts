import { renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { useDataGridColumns } from '../useDataGridColumns'
import type { Field } from '../../types'

const createField = (overrides: Partial<Field>): Field => ({
  id: 'f_status',
  table_id: 'table-1',
  name: 'Status',
  field_type: 'select',
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  created_at: '',
  updated_at: '',
  ...overrides,
})

describe('useDataGridColumns', () => {
  it('select editor values use canonical id before translated label', () => {
    const field = createField({
      options: {
        choices: [
          { id: 'open', label: '打开' },
          { id: 'closed', label: '关闭' },
        ],
      },
    })

    const { result } = renderHook(() =>
      useDataGridColumns({
        orderedFields: [field],
        currentView: null,
        hasGrouping: false,
        formatAttachmentCount: count => String(count),
        t: key => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.columns[0].cellEditorParams?.values).toEqual(['open', 'closed'])
  })

  it('select and multi_select still expose editors when choices are empty', () => {
    const selectField = createField({
      id: 'f_empty_select',
      name: 'Empty Select',
      field_type: 'select',
      options: { choices: [] },
    })
    const multiField = createField({
      id: 'f_empty_multi',
      name: 'Empty Multi',
      field_type: 'multi_select',
      options: {},
    })

    const { result } = renderHook(() =>
      useDataGridColumns({
        orderedFields: [selectField, multiField],
        currentView: null,
        hasGrouping: false,
        formatAttachmentCount: count => String(count),
        t: key => key,
        locale: 'zh-CN',
      })
    )

    expect(result.current.columns[0].cellEditor).toBe('selectCellEditor')
    expect(result.current.columns[0].cellEditorParams).toEqual({
      values: [],
      choices: [],
      allowTyping: true,
    })
    expect(result.current.columns[1].cellEditor).toBe('selectCellEditor')
    expect(result.current.columns[1].cellEditorParams).toEqual({
      values: [],
      choices: [],
      allowTyping: true,
    })
  })

  it('readonly table disables editable columns and editable field focus', () => {
    const field = createField({ field_type: 'text', name: 'Name' })

    const { result } = renderHook(() =>
      useDataGridColumns({
        orderedFields: [field],
        currentView: null,
        hasGrouping: false,
        formatAttachmentCount: count => String(count),
        t: key => key,
        locale: 'zh-CN',
        isReadonly: true,
      })
    )

    expect(result.current.columns[0].editable).toBe(false)
    expect(result.current.firstEditableField).toBeNull()
  })

  it('does not mark attachments as missing', () => {
    const field = createField({
      field_type: 'attachment',
      name: 'Files',
    })
    const { result } = renderHook(() =>
      useDataGridColumns({
        orderedFields: [field],
        currentView: null,
        hasGrouping: false,
        formatAttachmentCount: count => String(count),
        t: key => key,
        locale: 'zh-CN',
      })
    )
    const column = result.current.columns[0]

    expect((column.tooltipValueGetter as any)({ value: [] })).toBe('')
  })

  it('percent valueFormatter shows at most two decimals without trailing zeros', () => {
    const field = createField({
      id: 'f_pct',
      name: 'Percent',
      field_type: 'percent',
      options: { precision: 2 },
    })

    const { result } = renderHook(() =>
      useDataGridColumns({
        orderedFields: [field],
        currentView: null,
        hasGrouping: false,
        formatAttachmentCount: count => String(count),
        t: key => key,
        locale: 'zh-CN',
      })
    )

    const formatter = result.current.columns[0].valueFormatter as (params: {
      value: unknown
    }) => string
    expect(formatter({ value: 0.12 })).toBe('12%')
    expect(formatter({ value: 0.123 })).toBe('12.3%')
    expect(formatter({ value: 0.1234 })).toBe('12.34%')
    expect(formatter({ value: 0.12345 })).toBe('12.35%')
    expect(formatter({ value: null })).toBe('')
  })
})
