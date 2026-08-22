import { act, renderHook, waitFor } from '@testing-library/react'
import { vi } from 'vitest'
import { useUndoRedoCore, type FieldRestoreNotSupportedDetail } from '../useUndoRedoCore'

const mocks = vi.hoisted(() => ({
  toast: vi.fn(),
  getUndoStack: vi.fn(),
  getRedoStack: vi.fn(),
  undoTable: vi.fn(),
  redoTable: vi.fn(),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  useToast: () => ({ toast: mocks.toast }),
}))

vi.mock('@tabtin/table-core', () => ({
  UndoRedoApiService: {
    getUndoStack: mocks.getUndoStack,
    getRedoStack: mocks.getRedoStack,
    undoTable: mocks.undoTable,
    redoTable: mocks.redoTable,
  },
}))

const translate = (key: string) => key

describe('useUndoRedoCore', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getUndoStack.mockResolvedValue({ total: 1, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 0, operations: [] })
    mocks.undoTable.mockResolvedValue({ success: true, message: 'undone', operations: [] })
    mocks.redoTable.mockResolvedValue({ success: true, message: 'redone', operations: [] })
  })

  it('协作在线时仍使用后端持久 undo 栈；skipRecordsRefresh 时只刷新元数据且不 forceReconnect', async () => {
    const refreshRecords = vi.fn().mockResolvedValue(undefined)
    const refreshViews = vi.fn().mockResolvedValue(undefined)
    const collabUndo = vi.fn()
    const restoredEvents: unknown[] = []
    const onRestored = (event: Event) => restoredEvents.push((event as CustomEvent).detail)
    window.addEventListener('tabtin:collab-resource-restored', onRestored)

    try {
      const { result } = renderHook(() => useUndoRedoCore({
        selectedTableId: 'table-1',
        refreshRecords,
        refreshViews,
        translate,
        skipRecordsRefreshOnStackOperation: true,
        collabUndoRedo: {
          isOnline: true,
          canUndo: false,
          canRedo: true,
          undoFn: collabUndo,
          redoFn: vi.fn(),
        },
      }))

      await waitFor(() => expect(result.current.canUndo).toBe(true))

      await act(async () => {
        await result.current.handleUndo()
      })

      expect(collabUndo).not.toHaveBeenCalled()
      expect(mocks.undoTable).toHaveBeenCalledWith('table-1', {
        only_my_operations: true,
      })
      expect(refreshRecords).not.toHaveBeenCalled()
      expect(refreshViews).toHaveBeenCalled()
      // 删字段等 schema undo 后不应派发 collab-resource-restored（会 forceReconnect 闪空表）
      expect(restoredEvents).toEqual([])
    } finally {
      window.removeEventListener('tabtin:collab-resource-restored', onRestored)
    }
  })

  it('离线态表级 undo 仍刷新记录视图', async () => {
    const refreshRecords = vi.fn().mockResolvedValue(undefined)
    const refreshViews = vi.fn().mockResolvedValue(undefined)

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords,
      refreshViews,
      translate,
      skipRecordsRefreshOnStackOperation: false,
      collabUndoRedo: {
        isOnline: false,
        canUndo: false,
        canRedo: false,
        undoFn: null,
        redoFn: null,
      },
    }))

    await waitFor(() => expect(result.current.canUndo).toBe(true))

    await act(async () => {
      await result.current.handleUndo()
    })

    expect(refreshRecords).toHaveBeenCalled()
  })

  it('协作在线且 Yjs 有可撤项时走 Yjs 会话栈，不打后端', async () => {
    const refreshRecords = vi.fn().mockResolvedValue(undefined)
    const collabUndo = vi.fn()
    const collabRedo = vi.fn()
    mocks.getUndoStack.mockResolvedValue({ total: 0, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 0, operations: [] })

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords,
      translate,
      collabUndoRedo: {
        isOnline: true,
        canUndo: true,
        canRedo: true,
        undoFn: collabUndo,
        redoFn: collabRedo,
      },
    }))

    // 后端栈为空，但 Yjs 可撤 → 按钮仍应可用
    await waitFor(() => expect(result.current.canUndo).toBe(true))
    expect(result.current.canRedo).toBe(true)

    await act(async () => {
      await result.current.handleUndo()
    })
    await act(async () => {
      await result.current.handleRedo()
    })

    expect(collabUndo).toHaveBeenCalledTimes(1)
    expect(collabRedo).toHaveBeenCalledTimes(1)
    expect(mocks.undoTable).not.toHaveBeenCalled()
    expect(mocks.redoTable).not.toHaveBeenCalled()
  })

  it('离线态 dataVersion 变化后去重刷新后端栈，点亮按钮', async () => {
    mocks.getUndoStack.mockResolvedValue({ total: 0, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 0, operations: [] })

    const { result, rerender } = renderHook(
      ({ dataVersion }: { dataVersion: object }) => useUndoRedoCore({
        selectedTableId: 'table-1',
        refreshRecords: vi.fn().mockResolvedValue(undefined),
        translate,
        dataVersion,
      }),
      { initialProps: { dataVersion: { v: 0 } } },
    )

    await waitFor(() => expect(result.current.canUndo).toBe(false))

    // 模拟本地编辑落库：后端栈出现 1 条 + records 引用变化
    mocks.getUndoStack.mockResolvedValue({ total: 1, operations: [] })
    rerender({ dataVersion: { v: 1 } })

    await waitFor(() => expect(result.current.canUndo).toBe(true))
  })

  it('协作降级态（isOnline=true 但 Yjs 不可撤）dataVersion 变化仍刷新后端栈点亮按钮', async () => {
    mocks.getUndoStack.mockResolvedValue({ total: 0, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 0, operations: [] })

    const { result, rerender } = renderHook(
      ({ dataVersion }: { dataVersion: object }) => useUndoRedoCore({
        selectedTableId: 'table-1',
        refreshRecords: vi.fn().mockResolvedValue(undefined),
        translate,
        // 连上了（isOnline=true）但 Yjs 降级（fallback）→ collab 不上报可撤项
        collabUndoRedo: {
          isOnline: true,
          canUndo: false,
          canRedo: false,
          undoFn: null,
          redoFn: null,
        },
        dataVersion,
      }),
      { initialProps: { dataVersion: { v: 0 } } },
    )

    await waitFor(() => expect(result.current.canUndo).toBe(false))

    mocks.getUndoStack.mockResolvedValue({ total: 1, operations: [] })
    rerender({ dataVersion: { v: 1 } })

    await waitFor(() => expect(result.current.canUndo).toBe(true))
  })

  it('redo 成功后刷新视图元数据', async () => {
    const refreshRecords = vi.fn().mockResolvedValue(undefined)
    const refreshViews = vi.fn().mockResolvedValue(undefined)
    mocks.getUndoStack.mockResolvedValue({ total: 0, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 1, operations: [] })

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords,
      refreshViews,
      translate,
    }))

    await waitFor(() => expect(result.current.canRedo).toBe(true))

    await act(async () => {
      await result.current.handleRedo()
    })

    expect(mocks.redoTable).toHaveBeenCalledWith('table-1', {
      only_my_operations: true,
    })
    expect(refreshViews).toHaveBeenCalled()
    expect(refreshRecords).toHaveBeenCalled()
  })

  it('字段不可恢复 409 仍进入分类引导回调', async () => {
    const detail: FieldRestoreNotSupportedDetail = {
      field_id: 'field-1',
      field_name: '复杂字段',
      field_type: 'long_text',
      reason_code: 'not_in_wave1',
      deferred_to: 'version_history',
      unrestorable_fields: [{ id: 'field-1', name: '复杂字段', type: 'long_text' }],
      restorable_fields: [],
    }
    const onFieldRestoreNotSupported = vi.fn()
    mocks.undoTable.mockRejectedValue({
      status: 409,
      code: 'FIELD_RESTORE_NOT_SUPPORTED',
      data: detail,
    })

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords: vi.fn().mockResolvedValue(undefined),
      translate,
      onFieldRestoreNotSupported,
    }))

    await waitFor(() => expect(result.current.canUndo).toBe(true))

    await act(async () => {
      await result.current.handleUndo()
    })

    expect(onFieldRestoreNotSupported).toHaveBeenCalledWith(detail)
    expect(mocks.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'table:toolbar.undoFailed' }),
    )
  })

  it('栈为空（NO_UNDO_OPERATIONS）走中性提示，不报"撤销失败"', async () => {
    mocks.undoTable.mockRejectedValue({
      status: 400,
      code: 'NO_UNDO_OPERATIONS',
      message: '没有可撤销的操作',
    })

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords: vi.fn().mockResolvedValue(undefined),
      translate,
    }))

    await waitFor(() => expect(result.current.canUndo).toBe(true))
    await act(async () => {
      await result.current.handleUndo()
    })

    expect(mocks.toast).toHaveBeenCalledWith({ title: 'table:toolbar.noUndoOperations' })
    expect(mocks.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'table:toolbar.undoFailed' }),
    )
  })

  it('执行失败（非栈空）展示 undoFailed + 后端具体原因', async () => {
    // 生产里 createHttpError 返回真 Error（带 status/code），description 取 error.message
    const err = Object.assign(
      new Error('无法撤销删除「状态」：当前表已存在同名字段。'),
      { status: 400, code: 'UNDO_FAILED' },
    )
    mocks.undoTable.mockRejectedValue(err)

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords: vi.fn().mockResolvedValue(undefined),
      translate,
    }))

    await waitFor(() => expect(result.current.canUndo).toBe(true))
    await act(async () => {
      await result.current.handleUndo()
    })

    expect(mocks.toast).toHaveBeenCalledWith(
      expect.objectContaining({
        variant: 'destructive',
        title: 'table:toolbar.undoFailed',
        description: '无法撤销删除「状态」：当前表已存在同名字段。',
      }),
    )
  })

  it('redo 栈为空（NO_REDO_OPERATIONS）走中性提示', async () => {
    mocks.getUndoStack.mockResolvedValue({ total: 0, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 1, operations: [] })
    mocks.redoTable.mockRejectedValue({
      status: 400,
      code: 'NO_REDO_OPERATIONS',
      message: '没有可重做的操作',
    })

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords: vi.fn().mockResolvedValue(undefined),
      translate,
    }))

    await waitFor(() => expect(result.current.canRedo).toBe(true))
    await act(async () => {
      await result.current.handleRedo()
    })

    expect(mocks.toast).toHaveBeenCalledWith({ title: 'table:toolbar.noRedoOperations' })
    expect(mocks.toast).not.toHaveBeenCalledWith(
      expect.objectContaining({ title: 'table:toolbar.redoFailed' }),
    )
  })

  it('删字段(backend)→编辑单元格(collab)→Ctrl+Z 先走 collabUndo，再走 REST', async () => {
    const collabUndo = vi.fn()
    const collabRedo = vi.fn()
    const listeners = new Set<(e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void>()
    const subscribeStackEvent = (
      cb: (e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void,
    ) => {
      listeners.add(cb)
      return () => { listeners.delete(cb) }
    }
    const emitAddedUndo = () => {
      for (const cb of listeners) cb({ kind: 'added', changedStack: 'undo' })
    }

    mocks.getUndoStack.mockResolvedValue({ total: 1, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 0, operations: [] })

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords: vi.fn().mockResolvedValue(undefined),
      translate,
      skipRecordsRefreshOnStackOperation: true,
      collabUndoRedo: {
        isOnline: true,
        canUndo: true,
        canRedo: false,
        undoFn: collabUndo,
        redoFn: collabRedo,
        subscribeStackEvent,
      },
    }))

    await waitFor(() => expect(result.current.canUndo).toBe(true))

    // 删字段 → backend 标记；再编辑单元格 → collab 标记（后进先出）
    act(() => {
      result.current.recordBackendUndoable()
      emitAddedUndo()
    })

    await act(async () => {
      await result.current.handleUndo()
    })
    expect(collabUndo).toHaveBeenCalledTimes(1)
    expect(mocks.undoTable).not.toHaveBeenCalled()

    await act(async () => {
      await result.current.handleUndo()
    })
    expect(mocks.undoTable).toHaveBeenCalledWith('table-1', {
      only_my_operations: true,
    })
    expect(collabUndo).toHaveBeenCalledTimes(1)
  })

  it('后端 undo 失败时时间线标记回栈，仍可再试', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    try {
      mocks.undoTable.mockRejectedValue(
        Object.assign(new Error('同名冲突'), { status: 400, code: 'UNDO_FAILED' }),
      )

      const { result } = renderHook(() => useUndoRedoCore({
        selectedTableId: 'table-1',
        refreshRecords: vi.fn().mockResolvedValue(undefined),
        translate,
        collabUndoRedo: {
          isOnline: true,
          canUndo: false,
          canRedo: false,
          undoFn: null,
          redoFn: null,
        },
      }))

      await waitFor(() => expect(result.current.canUndo).toBe(true))

      act(() => {
        result.current.recordBackendUndoable()
      })

      await act(async () => {
        await result.current.handleUndo()
      })
      expect(mocks.undoTable).toHaveBeenCalledTimes(1)
      // 失败回栈后仍可 undo
      expect(result.current.canUndo).toBe(true)

      // 越过 UNDO_REDO_MIN_INTERVAL_MS 节流
      await act(async () => {
        vi.advanceTimersByTime(350)
      })

      mocks.undoTable.mockResolvedValue({ success: true, message: 'ok', operations: [] })
      await act(async () => {
        await result.current.handleUndo()
      })
      expect(mocks.undoTable).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('forceReconnect 事件后 collab 标记被修剪', async () => {
    const collabUndo = vi.fn()
    mocks.getUndoStack.mockResolvedValue({ total: 1, operations: [] })
    mocks.getRedoStack.mockResolvedValue({ total: 0, operations: [] })

    const { result } = renderHook(() => useUndoRedoCore({
      selectedTableId: 'table-1',
      refreshRecords: vi.fn().mockResolvedValue(undefined),
      translate,
      collabUndoRedo: {
        isOnline: true,
        canUndo: true,
        canRedo: false,
        undoFn: collabUndo,
        redoFn: vi.fn(),
      },
    }))

    await waitFor(() => expect(result.current.canUndo).toBe(true))

    act(() => {
      result.current.recordTimelineEvent('backend')
      result.current.recordTimelineEvent('collab')
    })

    // 时间线顶是 collab → 应走 Yjs
    await act(async () => {
      window.dispatchEvent(new CustomEvent('tabtin:collab-resource-restored', {
        detail: { resourceTypes: ['table'], tableId: 'table-1', source: 'force-reconnect' },
      }))
    })

    // collab 标记已修剪，顶变为 backend → 走 REST
    await act(async () => {
      await result.current.handleUndo()
    })
    expect(collabUndo).not.toHaveBeenCalled()
    expect(mocks.undoTable).toHaveBeenCalled()
  })
})
