import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useDataGridFieldOps } from './useDataGridFieldOps'

vi.mock('@tabtin/table-core', () => ({
  FieldApiService: {
    createField: vi.fn(),
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

const targetField = {
  id: 'field-status',
  name: 'Status',
  field_type: 'text',
  table_id: 'table-1',
} as any

const makeParams = (
  overrides: Partial<Parameters<typeof useDataGridFieldOps>[0]> = {},
): Parameters<typeof useDataGridFieldOps>[0] => ({
  fields: [targetField],
  selectedTableId: 'table-1',
  currentViewId: 'view-1',
  resolvedCurrentView: { id: 'view-1' } as any,
  allowViewMutation: true,
  draftFilters: [],
  setDraftFilters: vi.fn(),
  setDraftGroups: vi.fn(),
  applyDraft: vi.fn().mockResolvedValue(undefined),
  refreshFieldsAndView: vi.fn().mockResolvedValue(undefined),
  t: (key: string) => key,
  ...overrides,
})

describe('useDataGridFieldOps', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not duplicate an existing filter and still opens the filter popover', async () => {
    const params = makeParams({
      draftFilters: [
        {
          id: 'filter-1',
          field_id: targetField.id,
          operator: 'contains',
          value: '',
          enabled: true,
        } as any,
      ],
    })
    const { result } = renderHook(() => useDataGridFieldOps(params))

    let shouldOpen = false
    await act(async () => {
      shouldOpen = await result.current.handleFilterFieldFromMenu(targetField)
    })

    expect(shouldOpen).toBe(true)
    expect(params.setDraftFilters).not.toHaveBeenCalled()
    expect(params.applyDraft).not.toHaveBeenCalled()
  })

  it('initializes date filters with an exactDate value', async () => {
    const dateField = {
      ...targetField,
      id: 'field-date',
      field_type: 'date',
    } as any
    const params = makeParams({
      fields: [dateField],
      draftFilters: [],
    })
    const { result } = renderHook(() => useDataGridFieldOps(params))

    let shouldOpen = false
    await act(async () => {
      shouldOpen = await result.current.handleFilterFieldFromMenu(dateField)
    })

    expect(shouldOpen).toBe(true)
    expect(params.setDraftFilters).toHaveBeenCalledTimes(1)
    const nextFilters = (params.setDraftFilters as any).mock.calls[0][1] as any[]
    expect(nextFilters).toHaveLength(1)
    expect(nextFilters[0].value).toMatchObject({
      mode: 'exactDate',
      exactDate: '',
      timeZone: expect.any(String),
    })
    expect(params.applyDraft).toHaveBeenCalledWith('view-1')
  })
})
