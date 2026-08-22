import { act, renderHook } from '@testing-library/react'
import { vi } from 'vitest'
import { useSortEditorState } from '../useSortEditorState'
import type { Field, ViewMeta, ViewSort } from '../../types'

const field = (id: string, name = id): Field => ({
  id,
  name,
  field_type: 'text',
} as Field)

const view = (sorts: ViewSort[]): ViewMeta => ({
  id: 'view-1',
  table_id: 'table-1',
  name: '主视图',
  view_type: 'grid',
  sorts,
} as ViewMeta)

describe('useSortEditorState', () => {
  it('打开弹层后冻结放弃基线，避免协作预览更新 serverSorts 后基线漂移', () => {
    const fetchViewRecords = vi.fn().mockResolvedValue(undefined)

    const { result, rerender } = renderHook(
      ({ sorts }) =>
        useSortEditorState({
          currentView: view(sorts),
          currentViewId: 'view-1',
          fields: [field('saved'), field('draft')],
          fetchViewRecords,
          recordsQuery: { page: 1, page_size: 20 },
          serverSorts: sorts,
        }),
      {
        initialProps: {
          sorts: [{ field_id: 'saved', direction: 'desc' }] as ViewSort[],
        },
      },
    )

    act(() => {
      result.current.setSortOpen(true)
    })
    expect(result.current.sortRules).toEqual([{ field_id: 'saved', direction: 'desc' }])

    rerender({
      sorts: [{ field_id: 'draft', direction: 'asc' }] as ViewSort[],
    })
    act(() => {
      result.current.setSortRules([{ field_id: 'draft', direction: 'asc' }])
    })

    expect(result.current.hasDirtySortDraft).toBe(true)

    act(() => {
      result.current.handleDiscardSortDraft()
    })

    expect(result.current.sortRules).toEqual([{ field_id: 'saved', direction: 'desc' }])
  })

  it('放弃排序草稿时恢复到已保存排序，而不是清空排序', () => {
    const fetchViewRecords = vi.fn().mockResolvedValue(undefined)
    const persistSorts = vi.fn()

    const { result } = renderHook(() =>
      useSortEditorState({
        currentView: view([{ field_id: 'saved', direction: 'desc' }]),
        currentViewId: 'view-1',
        fields: [field('saved'), field('draft')],
        fetchViewRecords,
        recordsQuery: { page: 3, page_size: 20 },
        serverSorts: [{ field_id: 'saved', direction: 'desc' }],
        onPersistSorts: persistSorts,
      })
    )

    act(() => {
      result.current.setSortRules([{ field_id: 'draft', direction: 'asc' }])
    })
    expect(result.current.hasDirtySortDraft).toBe(true)

    act(() => {
      result.current.handleDiscardSortDraft()
    })

    expect(result.current.sortRules).toEqual([{ field_id: 'saved', direction: 'desc' }])
    expect(persistSorts).toHaveBeenLastCalledWith([{ field_id: 'saved', direction: 'desc' }])
    expect(fetchViewRecords).toHaveBeenLastCalledWith('view-1', {
      page: 1,
      page_size: 20,
      sorts: [{ field_id: 'saved', direction: 'desc' }],
    })
  })

  it('清除排序仍保持清空语义，区别于放弃', () => {
    const fetchViewRecords = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useSortEditorState({
        currentView: view([{ field_id: 'saved', direction: 'desc' }]),
        currentViewId: 'view-1',
        fields: [field('saved')],
        fetchViewRecords,
        recordsQuery: { page: 2, page_size: 10 },
        serverSorts: [{ field_id: 'saved', direction: 'desc' }],
      })
    )

    act(() => {
      result.current.setSortRules([{ field_id: 'saved', direction: 'desc' }])
    })
    act(() => {
      result.current.handleClearSortRules()
    })

    expect(result.current.sortRules).toEqual([])
    expect(fetchViewRecords).toHaveBeenLastCalledWith('view-1', {
      page: 1,
      page_size: 10,
      sorts: [],
    })
  })

  it('协作投影态可跳过 REST，仅持久化本地排序草稿', () => {
    const fetchViewRecords = vi.fn().mockResolvedValue(undefined)
    const persistSorts = vi.fn()

    const { result } = renderHook(() =>
      useSortEditorState({
        currentView: view([]),
        currentViewId: 'view-1',
        fields: [field('title')],
        fetchViewRecords,
        recordsQuery: { page: 1, page_size: 20 },
        onPersistSorts: persistSorts,
        skipRecordsFetch: true,
      }),
    )

    act(() => {
      result.current.handleAddSortRule()
    })

    expect(persistSorts).toHaveBeenCalledWith([{ field_id: 'title', direction: 'asc' }])
    expect(fetchViewRecords).not.toHaveBeenCalled()
  })
})
