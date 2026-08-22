import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useViewContainerState } from '../useViewContainerState'
import type { ViewMeta, ViewRecordsResponse } from '../../types'

const VIEW: ViewMeta = {
  id: 'view-1',
  table_id: 'table-1',
  name: 'Grid',
  view_type: 'grid',
  filters: [],
  sorts: [],
  groups: [],
  visible_fields: [],
  field_order: [],
  config: {},
  is_shared: false,
  is_locked: false,
  order: 0,
  created_at: '2026-01-01T00:00:00Z',
}

const recordsForView = (viewId: string): ViewRecordsResponse => ({
  view: { id: viewId, name: 'Grid', view_type: 'grid', config: {} },
  records: [{ id: 'r1' } as ViewRecordsResponse['records'][number]],
  total: 1,
  page: 1,
  page_size: 100,
  metadata: {},
})

describe('useViewContainerState', () => {
  it('keeps grid mounted while refreshing when current view already has records', () => {
    // 首次导入自动建字段会触发 loadViews；若保留 currentViewRecords，
    // 即使 isRecordsLoading=true 也不能进骨架屏，否则 GridToolbar/drawer 会被卸载。
    const { result } = renderHook(() =>
      useViewContainerState({
        views: [VIEW],
        currentViewId: 'view-1',
        currentViewRecords: recordsForView('view-1'),
        isRecordsLoading: true,
      }),
    )

    expect(result.current.shouldShowLoading).toBe(false)
  })

  it('shows loading skeleton only when records are missing or belong to another view', () => {
    const { result } = renderHook(() =>
      useViewContainerState({
        views: [VIEW],
        currentViewId: 'view-1',
        currentViewRecords: null,
        isRecordsLoading: true,
      }),
    )

    expect(result.current.shouldShowLoading).toBe(true)
  })
})
