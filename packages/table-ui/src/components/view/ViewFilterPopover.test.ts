import React from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import {
  ViewFilterPopover,
  type FilterOperatorTexts,
  type FilterPanelTexts,
} from './ViewFilterPopover'

const operatorTexts: FilterOperatorTexts = {
  common: {
    is: 'is',
    contains: 'contains',
    not_contains: 'not contains',
    equals: 'equals',
    not_equals: 'not equals',
    in: 'in',
    not_in: 'not in',
    is_empty: 'is empty',
    is_not_empty: 'is not empty',
  },
  number: {
    greater_than: 'greater than',
    greater_than_or_equals: 'greater than or equals',
    less_than: 'less than',
    less_than_or_equals: 'less than or equals',
  },
  date: {
    greater_than: 'after',
    greater_than_or_equals: 'on or after',
    less_than: 'before',
    less_than_or_equals: 'before or on',
    is_within: 'is within',
  },
  select: {
    any_of: 'any of',
    none_of: 'none of',
  },
  multiSelect: {
    has_any_of: 'has any of',
    has_all_of: 'has all of',
    has_none_of: 'has none of',
    is_exactly: 'is exactly',
    is_not_exactly: 'is not exactly',
  },
}

const panelTexts: FilterPanelTexts = {
  logicLabel: 'Match',
  logicAnd: 'All',
  logicOr: 'Any',
  title: 'Filters',
  empty: 'No filters',
  add: 'Add condition',
  remove: 'Remove',
  fieldPlaceholder: 'Field',
  operatorPlaceholder: 'Operator',
  valuePlaceholder: 'Value',
  multiValuePlaceholder: 'Values',
  numberPlaceholder: 'Number',
  datePlaceholder: 'Date',
  dateTimePlaceholder: 'Date time',
  datePresetExact: 'Specific date',
  datePresetToday: 'Today',
  datePresetTomorrow: 'Tomorrow',
  datePresetYesterday: 'Yesterday',
  datePresetThisWeek: 'This week',
  datePresetLastWeek: 'Last week',
  datePresetThisMonth: 'This month',
  datePresetLastMonth: 'Last month',
  datePresetPast7Days: 'Past 7 days',
  datePresetNext7Days: 'Next 7 days',
  datePresetPast30Days: 'Past 30 days',
  datePresetNext30Days: 'Next 30 days',
  booleanTrue: 'True',
  booleanFalse: 'False',
  selectValuePlaceholder: 'Select value',
  emptyOption: 'None',
  enabledLabel: 'Enable filter',
  searchPlaceholder: 'Search',
  noResults: 'No results',
}

describe('ViewFilterPopover', () => {
  it('caps its preferred width to the available popover boundary', () => {
    render(
      React.createElement(
        ViewFilterPopover,
        {
          open: true,
          onOpenChange: vi.fn(),
          viewId: 'view-1',
          fields: [],
          draft: undefined,
          store: {
            initializeDraft: vi.fn(),
            setDraftFilters: vi.fn(),
            setDraftFilterLogic: vi.fn(),
            applyDraft: vi.fn(),
          },
          operatorTexts,
          texts: panelTexts,
        },
        React.createElement('button', { type: 'button' }, 'Filters'),
      ),
    )

    const content = screen.getByRole('dialog')
    expect(content.className).toContain(
      'w-[min(640px,var(--radix-popover-content-available-width))]',
    )
    expect(content.className).toContain('max-w-[calc(100vw-1rem)]')
  })

  it('starts member filters with the multi-select operator', () => {
    const store = {
      initializeDraft: vi.fn(),
      setDraftFilters: vi.fn(),
      setDraftFilterLogic: vi.fn(),
      applyDraft: vi.fn(),
    }

    render(
      React.createElement(
        ViewFilterPopover,
        {
          open: true,
          onOpenChange: vi.fn(),
          viewId: 'view-1',
          fields: [{ id: 'owner', name: '负责人', field_type: 'user' }],
          draft: { filter_logic: 'and', filters: [] },
          store,
          operatorTexts,
          texts: panelTexts,
          userOptions: [{ value: 'user-1', label: '张三' }],
        },
        React.createElement('button', { type: 'button' }, 'Filters'),
      ),
    )

    fireEvent.click(screen.getByRole('button', { name: 'Add condition' }))

    expect(store.setDraftFilters).toHaveBeenCalledWith('view-1', [
      expect.objectContaining({
        field_id: 'owner',
        operator: 'is_any_of',
        value: [],
      }),
    ])
  })

  it('updates filter draft without applying it before save', () => {
    const store = {
      initializeDraft: vi.fn(),
      setDraftFilters: vi.fn(),
      setDraftFilterLogic: vi.fn(),
      applyDraft: vi.fn(),
    }

    render(
      React.createElement(
        ViewFilterPopover,
        {
          open: true,
          onOpenChange: vi.fn(),
          viewId: 'view-1',
          fields: [
            {
              id: 'title',
              name: 'Title',
              field_type: 'text',
            },
          ],
          draft: {
            filter_logic: 'and',
            filters: [
              {
                id: 'filter-1',
                field_id: 'title',
                operator: 'contains',
                value: 'hello',
                enabled: true,
              },
            ],
          },
          store,
          operatorTexts,
          texts: panelTexts,
        },
        React.createElement('button', { type: 'button' }, 'Filters'),
      ),
    )

    fireEvent.click(screen.getByRole('switch', { name: 'Enable filter' }))

    expect(store.setDraftFilters).toHaveBeenCalledWith('view-1', [
      {
        id: 'filter-1',
        field_id: 'title',
        operator: 'contains',
        value: 'hello',
        enabled: false,
      },
    ])
    expect(store.applyDraft).not.toHaveBeenCalled()
  })

  it('keeps typing local and commits the final text after 300 ms of inactivity', () => {
    vi.useFakeTimers()
    const store = {
      initializeDraft: vi.fn(),
      setDraftFilters: vi.fn(),
      setDraftFilterLogic: vi.fn(),
      applyDraft: vi.fn(),
    }

    try {
      render(
        React.createElement(
          ViewFilterPopover,
          {
            open: true,
            onOpenChange: vi.fn(),
            viewId: 'view-1',
            fields: [{ id: 'title', name: 'Title', field_type: 'text' }],
            draft: {
              filter_logic: 'and',
              filters: [
                {
                  id: 'filter-1',
                  field_id: 'title',
                  operator: 'contains',
                  value: 'hello',
                  enabled: true,
                },
              ],
            },
            store,
            operatorTexts,
            texts: panelTexts,
          },
          React.createElement('button', { type: 'button' }, 'Filters'),
        ),
      )

      const input = screen.getByRole('textbox') as HTMLInputElement
      fireEvent.change(input, { target: { value: '查' } })
      act(() => vi.advanceTimersByTime(200))
      expect(store.setDraftFilters).not.toHaveBeenCalled()

      fireEvent.change(input, { target: { value: '查找' } })
      act(() => vi.advanceTimersByTime(200))
      expect(store.setDraftFilters).not.toHaveBeenCalled()

      fireEvent.change(input, { target: { value: '查找内容' } })

      expect(input.value).toBe('查找内容')
      expect(store.setDraftFilters).not.toHaveBeenCalled()

      act(() => vi.advanceTimersByTime(299))
      expect(store.setDraftFilters).not.toHaveBeenCalled()

      act(() => vi.advanceTimersByTime(1))
      expect(store.setDraftFilters).toHaveBeenCalledTimes(1)
      expect(store.setDraftFilters).toHaveBeenCalledWith('view-1', [
        {
          id: 'filter-1',
          field_id: 'title',
          operator: 'contains',
          value: '查找内容',
          enabled: true,
        },
      ])

      fireEvent.change(input, { target: { value: '查找内容完成' } })
      fireEvent.blur(input)
      expect(store.setDraftFilters).toHaveBeenCalledTimes(2)
      expect(store.setDraftFilters).toHaveBeenLastCalledWith('view-1', [
        {
          id: 'filter-1',
          field_id: 'title',
          operator: 'contains',
          value: '查找内容完成',
          enabled: true,
        },
      ])

      act(() => vi.advanceTimersByTime(300))
      expect(store.setDraftFilters).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })
})
