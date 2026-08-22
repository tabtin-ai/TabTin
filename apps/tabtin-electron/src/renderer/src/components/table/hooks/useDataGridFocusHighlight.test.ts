import { act, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useDataGridFocusHighlight } from './useDataGridFocusHighlight'

describe('useDataGridFocusHighlight', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it('创建后继续编辑路径应在定位到新行后直接进入首个可编辑单元格', async () => {
    vi.useFakeTimers()
    const ensureIndexVisible = vi.fn()
    const setFocusedCell = vi.fn()
    const startEditingCell = vi.fn()

    const { result } = renderHook(() =>
      useDataGridFocusHighlight({
        gridApiRef: {
          current: {
            getDisplayedRowCount: () => 1,
            getDisplayedRowAtIndex: () => ({
              data: { id: 'row-1', Name: 'Alice' },
              setSelected: vi.fn(),
            }),
            ensureIndexVisible,
            setFocusedCell,
            startEditingCell,
          } as any,
        },
        fieldById: new Map(),
        fieldByName: new Map(),
        columns: [{ field: 'Name' }],
        firstEditableField: 'Name',
        useViewData: true,
        currentViewId: 'view-1',
        clearGroupCollapse: vi.fn(),
        setDraftFilters: vi.fn(),
        applyDraft: vi.fn().mockResolvedValue(undefined),
        registerHighlightCells: vi.fn(),
      })
    )

    await act(async () => {
      await result.current.handleRecordCreatedVisibleForEditing({ id: 'row-1' })
      await vi.runAllTimersAsync()
    })

    expect(ensureIndexVisible).toHaveBeenCalledWith(0, 'middle')
    expect(setFocusedCell).toHaveBeenCalledWith(0, 'Name')
    expect(startEditingCell).toHaveBeenCalledWith({
      rowIndex: 0,
      colKey: 'Name',
    })
    expect(ensureIndexVisible.mock.invocationCallOrder[0]).toBeGreaterThan(
      startEditingCell.mock.invocationCallOrder[0],
    )
  })

  it('资源链接的记录定位意图到达后应将记录滚动到视口中央并聚焦单元格', async () => {
    vi.useFakeTimers()
    const ensureIndexVisible = vi.fn()
    const setFocusedCell = vi.fn()
    const ensureRecordFocusGroupsVisible = vi.fn()
    const onRecordFocusIntentConsumed = vi.fn()

    renderHook(() =>
      useDataGridFocusHighlight({
        gridApiRef: {
          current: {
            getDisplayedRowCount: () => 2,
            getDisplayedRowAtIndex: (index: number) => ({
              data: index === 0
                ? { id: 'row-1', Name: 'Alice' }
                : { id: 'row-from-link', Name: 'Target' },
              setSelected: vi.fn(),
            }),
            ensureIndexVisible,
            setFocusedCell,
          } as any,
        },
        fieldById: new Map(),
        fieldByName: new Map(),
        columns: [{ field: 'Name' }],
        firstEditableField: 'Name',
        useViewData: true,
        currentViewId: 'view-1',
        clearGroupCollapse: vi.fn(),
        setDraftFilters: vi.fn(),
        applyDraft: vi.fn().mockResolvedValue(undefined),
        registerHighlightCells: vi.fn(),
        recordFocusIntent: { requestId: 1, recordId: 'row-from-link' },
        ensureRecordFocusGroupsVisible,
        onRecordFocusIntentConsumed,
      })
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(ensureIndexVisible).toHaveBeenCalledWith(1, 'middle')
    expect(setFocusedCell).toHaveBeenCalledWith(1, 'Name')
    expect(ensureIndexVisible.mock.invocationCallOrder[0]).toBeGreaterThan(
      setFocusedCell.mock.invocationCallOrder[0],
    )
    expect(ensureRecordFocusGroupsVisible).toHaveBeenCalledWith('row-from-link')
    expect(onRecordFocusIntentConsumed).toHaveBeenCalledWith(1)
    expect(setFocusedCell).toHaveBeenCalledTimes(1)
  })

  it('首次加载在早期行模型命中后应等最终数据集重建聚焦再消费意图', async () => {
    vi.useFakeTimers()
    const earlySetFocusedCell = vi.fn()
    const stableSetFocusedCell = vi.fn()
    const onRecordFocusIntentConsumed = vi.fn()
    const gridApiRef = {
      current: {
        getDisplayedRowCount: () => 1,
        getDisplayedRowAtIndex: () => ({
          data: { id: 'row-from-link', Name: 'Early target' },
          setSelected: vi.fn(),
        }),
        ensureIndexVisible: vi.fn(),
        setFocusedCell: earlySetFocusedCell,
      } as any,
    }
    const baseParams = {
      gridApiRef,
      fieldById: new Map(),
      fieldByName: new Map(),
      columns: [{ field: 'Name' }],
      firstEditableField: 'Name',
      useViewData: true,
      currentViewId: 'view-1',
      clearGroupCollapse: vi.fn(),
      setDraftFilters: vi.fn(),
      applyDraft: vi.fn().mockResolvedValue(undefined),
      registerHighlightCells: vi.fn(),
      recordFocusIntent: { requestId: 1, recordId: 'row-from-link' },
      onRecordFocusIntentConsumed,
    }

    const { rerender } = renderHook(
      ({ isRecordFocusDataLoading }) => useDataGridFocusHighlight({
        ...baseParams,
        isRecordFocusDataLoading,
      }),
      { initialProps: { isRecordFocusDataLoading: true } },
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(earlySetFocusedCell).not.toHaveBeenCalled()
    expect(onRecordFocusIntentConsumed).not.toHaveBeenCalled()

    gridApiRef.current = {
      getDisplayedRowCount: () => 2,
      getDisplayedRowAtIndex: (index: number) => ({
        data: index === 0
          ? { id: 'other-row', Name: 'Other' }
          : { id: 'row-from-link', Name: 'Stable target' },
        setSelected: vi.fn(),
      }),
      ensureIndexVisible: vi.fn(),
      setFocusedCell: stableSetFocusedCell,
    } as any
    rerender({ isRecordFocusDataLoading: false })

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(stableSetFocusedCell).toHaveBeenCalledWith(1, 'Name')
    expect(onRecordFocusIntentConsumed).toHaveBeenCalledOnce()
    expect(onRecordFocusIntentConsumed).toHaveBeenCalledWith(1)
  })

  it('只读表格也应将资源链接的目标记录聚焦到首个可见单元格', async () => {
    vi.useFakeTimers()
    const setFocusedCell = vi.fn()

    renderHook(() =>
      useDataGridFocusHighlight({
        gridApiRef: {
          current: {
            getDisplayedRowCount: () => 1,
            getDisplayedRowAtIndex: () => ({
              data: { id: 'readonly-row', Name: 'Target' },
              setSelected: vi.fn(),
            }),
            ensureIndexVisible: vi.fn(),
            setFocusedCell,
          } as any,
        },
        fieldById: new Map(),
        fieldByName: new Map(),
        columns: [{ field: 'Name' }],
        firstEditableField: null,
        useViewData: true,
        currentViewId: 'view-1',
        clearGroupCollapse: vi.fn(),
        setDraftFilters: vi.fn(),
        applyDraft: vi.fn().mockResolvedValue(undefined),
        registerHighlightCells: vi.fn(),
        recordFocusIntent: { requestId: 1, recordId: 'readonly-row' },
      })
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(setFocusedCell).toHaveBeenCalledWith(0, 'Name')
  })

  it('列定义异步到达时不应过早消费记录定位意图', async () => {
    vi.useFakeTimers()
    const setFocusedCell = vi.fn()
    const baseParams = {
      gridApiRef: {
        current: {
          getDisplayedRowCount: () => 1,
          getDisplayedRowAtIndex: () => ({
            data: { id: 'late-column-row', Name: 'Target' },
            setSelected: vi.fn(),
          }),
          ensureIndexVisible: vi.fn(),
          setFocusedCell,
        } as any,
      },
      fieldById: new Map(),
      fieldByName: new Map(),
      firstEditableField: null,
      useViewData: true,
      currentViewId: 'view-1',
      clearGroupCollapse: vi.fn(),
      setDraftFilters: vi.fn(),
      applyDraft: vi.fn().mockResolvedValue(undefined),
      registerHighlightCells: vi.fn(),
      recordFocusIntent: { requestId: 1, recordId: 'late-column-row' },
    }

    const { rerender } = renderHook(
      ({ columns }) => useDataGridFocusHighlight({ ...baseParams, columns }),
      { initialProps: { columns: [] as Array<{ field?: string }> } },
    )

    rerender({ columns: [{ field: 'Name' }] })
    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(setFocusedCell).toHaveBeenCalledWith(0, 'Name')
  })

  it('目标不在首批数据时应加载更多并在行到达后聚焦', async () => {
    vi.useFakeTimers()
    let targetLoaded = false
    const setFocusedCell = vi.fn()
    const onRecordFocusIntentConsumed = vi.fn()
    const ensureRecordAvailable = vi.fn().mockImplementation(async () => {
      targetLoaded = true
      return true
    })

    renderHook(() =>
      useDataGridFocusHighlight({
        gridApiRef: {
          current: {
            getDisplayedRowCount: () => targetLoaded ? 2 : 1,
            getDisplayedRowAtIndex: (index: number) => ({
              data: index === 1
                ? { id: 'moving-target', Name: 'Target' }
                : { id: 'other-0', Name: 'Other' },
              setSelected: vi.fn(),
            }),
            ensureIndexVisible: vi.fn(),
            setFocusedCell,
          } as any,
        },
        fieldById: new Map(),
        fieldByName: new Map(),
        columns: [{ field: 'Name' }],
        firstEditableField: 'Name',
        useViewData: true,
        currentViewId: 'view-1',
        clearGroupCollapse: vi.fn(),
        setDraftFilters: vi.fn(),
        applyDraft: vi.fn().mockResolvedValue(undefined),
        registerHighlightCells: vi.fn(),
        recordFocusIntent: { requestId: 2, recordId: 'moving-target' },
        ensureRecordAvailable,
        onRecordFocusIntentConsumed,
      })
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(ensureRecordAvailable).toHaveBeenCalledWith('moving-target')
    expect(setFocusedCell).toHaveBeenLastCalledWith(1, 'Name')
    expect(onRecordFocusIntentConsumed).toHaveBeenCalledOnce()
    expect(setFocusedCell).toHaveBeenCalledTimes(1)
  })
})
