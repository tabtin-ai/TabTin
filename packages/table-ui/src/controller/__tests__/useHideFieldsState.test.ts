/* @vitest-environment jsdom */

import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import type { Field, ViewMeta } from '../../types'
import { useHideFieldsState } from '../useHideFieldsState'

const buildField = (id: string, name: string, overrides: Partial<Field> = {}): Field => ({
  id,
  table_id: 'table-1',
  name,
  field_type: 'text' as any,
  is_primary: false,
  is_hidden: false,
  sort_order: 0,
  ...overrides,
})

const buildView = (overrides: Partial<ViewMeta> = {}): ViewMeta => ({
  id: 'view-1',
  table_id: 'table-1',
  name: 'Grid View',
  view_type: 'grid',
  order: 0,
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config: {},
  is_default: true,
  is_shared: false,
  is_locked: false,
  column_meta: {},
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  ...overrides,
})

const fields = [
  buildField('fld_primary', 'Title', { is_primary: true }),
  buildField('fld_status', 'Status'),
  buildField('fld_owner', 'Owner'),
]

describe('useHideFieldsState', () => {
  it('keeps the primary field visible when toggled in locked view types', () => {
    const { result } = renderHook(() => useHideFieldsState({
      currentView: buildView({ view_type: 'grid' }),
      fields,
    }))

    act(() => {
      result.current.setVisibleFieldIds(fields.map(field => field.id))
    })
    act(() => {
      result.current.toggleFieldVisibility('fld_primary')
    })

    expect(result.current.visibleFieldIds).toContain('fld_primary')
  })

  it('keeps primary fields visible when hiding all fields in locked view types', () => {
    const { result } = renderHook(() => useHideFieldsState({
      currentView: buildView({ view_type: 'grid' }),
      fields,
    }))

    act(() => {
      result.current.setVisibleFieldIds(fields.map(field => field.id))
    })
    act(() => {
      result.current.hideAllFields()
    })

    expect(result.current.visibleFieldIds).toEqual(['fld_primary'])
  })

  it('restores the primary field when opening a locked view with stale hidden metadata', () => {
    const { result } = renderHook(() => useHideFieldsState({
      currentView: buildView({
        view_type: 'grid',
        column_meta: {
          fld_primary: { order: 0, hidden: true },
          fld_status: { order: 1, hidden: false },
          fld_owner: { order: 2, hidden: true },
        },
      }),
      fields,
    }))

    act(() => {
      result.current.setHideFieldsOpen(true)
    })

    expect(result.current.visibleFieldIds).toContain('fld_primary')
    expect(result.current.visibleFieldIds).toContain('fld_status')
  })

  it('keeps a restored hidden field visible when the same view refreshes while editing', () => {
    const hiddenView = buildView({
      view_type: 'grid',
      column_meta: {
        fld_primary: { order: 0, hidden: false },
        fld_status: { order: 1, hidden: false },
        fld_owner: { order: 2, hidden: true },
      },
    })
    const { result, rerender } = renderHook(
      ({ view, fieldList }: { view: ViewMeta; fieldList: Field[] }) => useHideFieldsState({
        currentView: view,
        fields: fieldList,
      }),
      {
        initialProps: {
          view: hiddenView,
          fieldList: fields,
        },
      },
    )

    act(() => {
      result.current.setHideFieldsOpen(true)
    })
    expect(result.current.visibleFieldIds).not.toContain('fld_owner')

    act(() => {
      result.current.toggleFieldVisibility('fld_owner')
    })
    expect(result.current.visibleFieldIds).toContain('fld_owner')

    rerender({
      view: buildView({
        ...hiddenView,
        updated_at: '2026-01-01T00:00:01Z',
      }),
      fieldList: fields.map(field => ({ ...field })),
    })

    expect(result.current.visibleFieldIds).toContain('fld_owner')
  })

  it('allows the primary field to be hidden in view types without primary visibility lock', () => {
    const { result } = renderHook(() => useHideFieldsState({
      currentView: buildView({ view_type: 'calendar' }),
      fields,
    }))

    act(() => {
      result.current.setVisibleFieldIds(fields.map(field => field.id))
    })
    act(() => {
      result.current.toggleFieldVisibility('fld_primary')
    })

    expect(result.current.visibleFieldIds).not.toContain('fld_primary')
  })
})
