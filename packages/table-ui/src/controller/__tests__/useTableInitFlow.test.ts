import { act, renderHook, waitFor } from '@testing-library/react'
import type { Table } from '@tabtin/table-core'
import { pickFresherTableMetadata, useTableInitFlow } from '../useTableInitFlow'

const table = (
  id: string,
  name: string,
  role: Table['current_user_role'] = 'owner',
  updatedAt = '',
): Table => ({
  id,
  name,
  space_id: 'space-1',
  created_by_id: 'user-1',
  is_archived: false,
  created_at: '',
  updated_at: updatedAt,
  default_view_id: `view-${id}`,
  current_user_role: role,
})

describe('useTableInitFlow', () => {
  it('不会把其他 tab 残留的 selectedTable 当成当前表', async () => {
    const staleSelected = table('table-a', '旧表', 'editor')
    const current = table('table-b', '共享只读表', 'viewer')
    const getGlobalTable = vi.fn().mockResolvedValue(current)
    const selectTable = vi.fn()
    const initializeView = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useTableInitFlow({
        tableId: 'table-b',
        globalTables: [current],
        getGlobalTable,
        selectTable,
        selectedTable: staleSelected,
        initializeView,
        viewTableId: 'table-b',
        currentViewId: 'view-table-b',
        viewLoading: false,
        isActive: true,
      }),
    )

    await waitFor(() => expect(selectTable).toHaveBeenCalledWith(current))
    await waitFor(() => expect(initializeView).toHaveBeenCalledWith('table-b'))

    expect(result.current.displayTable?.id).toBe('table-b')
    expect(result.current.displayTable?.name).toBe('共享只读表')
    expect(result.current.displayTable?.current_user_role).toBe('viewer')
  })

  it('当前激活 tab 即使已有缓存表，也会刷新详情拿最新角色和标题', async () => {
    const cached = table('table-b', '旧缓存标题', 'editor')
    const fresh = table('table-b', '真实共享表标题', 'viewer')
    const getGlobalTable = vi.fn().mockResolvedValue(fresh)
    const selectTable = vi.fn()
    const initializeView = vi.fn().mockResolvedValue(undefined)

    renderHook(() =>
      useTableInitFlow({
        tableId: 'table-b',
        globalTables: [cached],
        getGlobalTable,
        selectTable,
        selectedTable: null,
        initializeView,
        viewTableId: 'table-b',
        currentViewId: 'view-table-b',
        viewLoading: false,
        isActive: true,
      }),
    )

    await waitFor(() => expect(getGlobalTable).toHaveBeenCalledWith('table-b'))
  })

  it('详情刷新后 force 同步 current_user_role 到 per-tab selectedTable', async () => {
    const cached = table('table-b', '旧缓存标题', 'editor', '2026-01-01T00:00:00Z')
    const fresh = table('table-b', '真实共享表标题', 'viewer', '2026-06-08T00:00:00Z')
    const getGlobalTable = vi.fn().mockResolvedValue(fresh)
    const selectTable = vi.fn()
    const initializeView = vi.fn().mockResolvedValue(undefined)

    const baseProps = {
      tableId: 'table-b',
      getGlobalTable,
      selectTable,
      initializeView,
      viewTableId: 'table-b',
      currentViewId: 'view-table-b',
      viewLoading: false,
      isActive: true,
    }

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableInitFlow>[0]) => useTableInitFlow(props),
      {
        initialProps: {
          ...baseProps,
          globalTables: [cached],
          selectedTable: cached,
        },
      },
    )

    rerender({
      ...baseProps,
      globalTables: [fresh],
      selectedTable: cached,
    })

    await waitFor(() => expect(selectTable).toHaveBeenCalledWith(fresh, { force: true }))
    expect(result.current.displayTable?.current_user_role).toBe('viewer')
    expect(result.current.displayTable?.name).toBe('真实共享表标题')
  })

  it('本地 updateTable 后 per-tab 新元数据优先于未同步的全局缓存', async () => {
    const staleGlobal = table('table-b', '旧标题', 'owner', '2026-01-01T00:00:00Z')
    const freshSelected = table('table-b', '新标题', 'owner', '2026-06-17T12:00:00Z')
    const getGlobalTable = vi.fn().mockResolvedValue(staleGlobal)
    const selectTable = vi.fn()
    const initializeView = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() =>
      useTableInitFlow({
        tableId: 'table-b',
        globalTables: [staleGlobal],
        getGlobalTable,
        selectTable,
        selectedTable: freshSelected,
        initializeView,
        viewTableId: 'table-b',
        currentViewId: 'view-table-b',
        viewLoading: false,
        isActive: true,
      }),
    )

    expect(result.current.displayTable?.name).toBe('新标题')
    expect(selectTable).not.toHaveBeenCalledWith(staleGlobal, { force: true })
  })

  it('currentViewId 就绪后不再因 initializeView 未结束而全屏 loading（不等待首屏 records）', async () => {
    const current = table('table-b', '共享表', 'viewer')
    let resolveInit!: () => void
    const initializeView = vi.fn(
      () =>
        new Promise<void>(resolve => {
          resolveInit = resolve
        }),
    )

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableInitFlow>[0]) => useTableInitFlow(props),
      {
        initialProps: {
          tableId: 'table-b',
          globalTables: [current],
          getGlobalTable: vi.fn().mockResolvedValue(current),
          selectTable: vi.fn(),
          selectedTable: current,
          initializeView,
          viewTableId: null,
          currentViewId: null,
          viewLoading: true,
          isActive: true,
        },
      },
    )

    await waitFor(() => expect(initializeView).toHaveBeenCalledWith('table-b'))
    expect(result.current.showPaneLoading).toBe(true)

    rerender({
      tableId: 'table-b',
      globalTables: [current],
      getGlobalTable: vi.fn().mockResolvedValue(current),
      selectTable: vi.fn(),
      selectedTable: current,
      initializeView,
      viewTableId: 'table-b',
      currentViewId: 'view-table-b',
      viewLoading: false,
      isActive: true,
    })

    expect(result.current.showPaneLoading).toBe(false)

    resolveInit()
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.showPaneLoading).toBe(false)
  })

  it('initializeView 失败时立即展示可重试态，且重试可恢复', async () => {
    const current = table('table-b', '共享表', 'viewer')
    const initializeView = vi
      .fn()
      .mockRejectedValueOnce(new Error('获取视图列表失败'))
      .mockResolvedValueOnce(undefined)
    const getGlobalTable = vi.fn().mockResolvedValue(current)

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableInitFlow>[0]) => useTableInitFlow(props),
      {
        initialProps: {
          tableId: 'table-b',
          globalTables: [current],
          getGlobalTable,
          selectTable: vi.fn(),
          selectedTable: current,
          initializeView,
          viewTableId: null,
          currentViewId: null,
          viewLoading: false,
          isActive: true,
        },
      },
    )

    await waitFor(() => expect(result.current.loadingTimedOut).toBe(true))
    expect(result.current.showPaneLoading).toBe(true)

    result.current.handleForceRetry()

    await waitFor(() => expect(initializeView).toHaveBeenCalledTimes(2))

    rerender({
      tableId: 'table-b',
      globalTables: [current],
      getGlobalTable,
      selectTable: vi.fn(),
      selectedTable: current,
      initializeView,
      viewTableId: 'table-b',
      currentViewId: 'view-table-b',
      viewLoading: false,
      isActive: true,
    })

    await waitFor(() => expect(result.current.showPaneLoading).toBe(false))
    expect(result.current.loadingTimedOut).toBe(false)
  })

  it('active → inactive（初始化未完成）→ active 时会重新 initialize', async () => {
    const current = table('table-b', '共享表', 'viewer')
    let resolveFirst!: () => void
    const initializeView = vi.fn(
      () =>
        new Promise<void>(resolve => {
          if (initializeView.mock.calls.length === 1) {
            resolveFirst = resolve
            return
          }
          resolve()
        }),
    )
    const getGlobalTable = vi.fn().mockResolvedValue(current)
    const base = {
      tableId: 'table-b',
      globalTables: [current],
      getGlobalTable,
      selectTable: vi.fn(),
      selectedTable: current,
      initializeView,
      viewTableId: null as string | null,
      currentViewId: null as string | null,
      viewLoading: false,
    }

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableInitFlow>[0]) => useTableInitFlow(props),
      { initialProps: { ...base, isActive: true } },
    )

    await waitFor(() => expect(initializeView).toHaveBeenCalledTimes(1))
    expect(result.current.showPaneLoading).toBe(true)

    rerender({ ...base, isActive: false })
    expect(result.current.loadingTimedOut).toBe(false)

    // 停靠期间旧回调完成也不应卡住门闩
    resolveFirst()

    rerender({ ...base, isActive: true })
    await waitFor(() => expect(initializeView).toHaveBeenCalledTimes(2))

    rerender({
      ...base,
      isActive: true,
      viewTableId: 'table-b',
      currentViewId: 'view-table-b',
    })
    await waitFor(() => expect(result.current.showPaneLoading).toBe(false))
  })

  it('曾 ready 后 currentViewId 丢失，再经 active 边沿可重新 initialize', async () => {
    const current = table('table-b', '共享表', 'viewer')
    const initializeView = vi.fn().mockResolvedValue(undefined)
    const getGlobalTable = vi.fn().mockResolvedValue(current)
    const base = {
      tableId: 'table-b',
      globalTables: [current],
      getGlobalTable,
      selectTable: vi.fn(),
      selectedTable: current,
      initializeView,
      viewLoading: false,
    }

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableInitFlow>[0]) => useTableInitFlow(props),
      {
        initialProps: {
          ...base,
          viewTableId: 'table-b',
          currentViewId: 'view-table-b',
          isActive: true,
        },
      },
    )

    await waitFor(() => expect(result.current.showPaneLoading).toBe(false))
    const callsAfterReady = initializeView.mock.calls.length

    // sticky success 被清掉；持续 active 时不自动风暴重试
    rerender({
      ...base,
      viewTableId: 'table-b',
      currentViewId: null,
      isActive: true,
    })
    expect(result.current.showPaneLoading).toBe(true)
    expect(initializeView).toHaveBeenCalledTimes(callsAfterReady)

    // active 边沿允许重新 initialize
    rerender({
      ...base,
      viewTableId: 'table-b',
      currentViewId: null,
      isActive: false,
    })
    rerender({
      ...base,
      viewTableId: 'table-b',
      currentViewId: null,
      isActive: true,
    })
    await waitFor(() => expect(initializeView.mock.calls.length).toBeGreaterThan(callsAfterReady))
  })

  it('初始化 resolve 但无 currentViewId 时给出可重试态，且不永久卡死', async () => {
    const current = table('table-b', '共享表', 'viewer')
    const initializeView = vi.fn().mockResolvedValue(undefined)
    const getGlobalTable = vi.fn().mockResolvedValue(current)

    const { result } = renderHook(() =>
      useTableInitFlow({
        tableId: 'table-b',
        globalTables: [current],
        getGlobalTable,
        selectTable: vi.fn(),
        selectedTable: current,
        initializeView,
        viewTableId: null,
        currentViewId: null,
        viewLoading: false,
        isActive: true,
      }),
    )

    await waitFor(() => expect(initializeView).toHaveBeenCalledWith('table-b'))
    await waitFor(() => expect(result.current.loadingTimedOut).toBe(true))
    expect(result.current.showPaneLoading).toBe(true)

    // 用户 retry 可再次启动（门闩已释放）
    result.current.handleForceRetry()
    await waitFor(() => expect(initializeView).toHaveBeenCalledTimes(2))
  })

  it('inactive / parked 时不启动 3 秒 loading 超时', async () => {
    vi.useFakeTimers()
    const current = table('table-b', '共享表', 'viewer')
    const initializeView = vi.fn(() => new Promise<void>(() => {}))
    const getGlobalTable = vi.fn().mockResolvedValue(current)

    const { result, rerender } = renderHook(
      (props: Parameters<typeof useTableInitFlow>[0]) => useTableInitFlow(props),
      {
        initialProps: {
          tableId: 'table-b',
          globalTables: [current],
          getGlobalTable,
          selectTable: vi.fn(),
          selectedTable: current,
          initializeView,
          viewTableId: null,
          currentViewId: null,
          viewLoading: true,
          isActive: false,
        },
      },
    )

    expect(result.current.showPaneLoading).toBe(true)
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500)
    })
    expect(result.current.loadingTimedOut).toBe(false)
    expect(initializeView).not.toHaveBeenCalled()

    rerender({
      tableId: 'table-b',
      globalTables: [current],
      getGlobalTable,
      selectTable: vi.fn(),
      selectedTable: current,
      initializeView,
      viewTableId: null,
      currentViewId: null,
      viewLoading: true,
      isActive: true,
    })
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3_500)
    })
    expect(result.current.loadingTimedOut).toBe(true)
    vi.useRealTimers()
  })
})

describe('pickFresherTableMetadata', () => {
  it('updated_at 较新的 per-tab 元数据优先', () => {
    const perTab = table('t1', '新名', 'owner', '2026-06-17T12:00:00Z')
    const global = table('t1', '旧名', 'owner', '2026-01-01T00:00:00Z')
    expect(pickFresherTableMetadata(perTab, global).name).toBe('新名')
  })

  it('updated_at 较新的 global 元数据优先', () => {
    const perTab = table('t1', '旧名', 'editor', '2026-01-01T00:00:00Z')
    const global = table('t1', '新名', 'viewer', '2026-06-08T00:00:00Z')
    expect(pickFresherTableMetadata(perTab, global).name).toBe('新名')
    expect(pickFresherTableMetadata(perTab, global).current_user_role).toBe('viewer')
  })
})
