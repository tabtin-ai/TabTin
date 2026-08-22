import { describe, it, expect, beforeEach, vi } from 'vitest'
import { useTableCollabStore } from '../useTableCollabStore'
import {
  useCollabPeersForTable,
  useCollabIsOnlineForTable,
  useCollabDocumentRuntimeForTable,
  useCollabStatusForTable,
  useCollabPeerCursorsForTable,
  useCollabUndoRedoForTable,
} from '../useTableCollabStore'
import { renderHook, act } from '@testing-library/react'
import { CollabStatus } from '@tabtin/collab-core'
import type { ViewMeta } from '@tabtin/table-core'
import { COLLAB_PENDING_VIEW_TTL_MS } from '@tabtin/table-engine/collab'

const makePeer = (id: string, cursor?: { recordId: string; fieldId: string }) => ({
  user: { id, name: `User ${id}`, color: '#FF0000', type: 'user' as const },
  cursor: cursor ? { module: 'tabdata' as const, ...cursor } : null,
})

beforeEach(() => {
  act(() => useTableCollabStore.getState().reset())
})

// ── E-06: 多表并发隔离 ──

describe('E-06: useTableCollabStore 多表并发隔离', () => {
  it('syncPresence 不同 tableId 的数据互不覆盖', () => {
    const { syncPresence } = useTableCollabStore.getState()
    const peersA = [makePeer('u1')]
    const peersB = [makePeer('u2'), makePeer('u3')]

    act(() => {
      syncPresence({ tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers: peersA })
      syncPresence({ tableId: 'table-B', status: CollabStatus.SYNCING, isOnline: false, peers: peersB })
    })

    const state = useTableCollabStore.getState()
    expect(state.tables['table-A']?.peers).toBe(peersA)
    expect(state.tables['table-A']?.isOnline).toBe(true)
    expect(state.tables['table-A']?.status).toBe(CollabStatus.SYNCED)

    expect(state.tables['table-B']?.peers).toBe(peersB)
    expect(state.tables['table-B']?.isOnline).toBe(false)
    expect(state.tables['table-B']?.status).toBe(CollabStatus.SYNCING)
  })

  it('selector hooks 按 tableId 隔离返回正确数据', () => {
    const peersA = [makePeer('u1', { recordId: 'r1', fieldId: 'f1' })]
    const peersB = [makePeer('u2')]

    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers: peersA,
      })
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-B', status: CollabStatus.SYNCING, isOnline: false, peers: peersB,
      })
    })

    const { result: peersResultA } = renderHook(() => useCollabPeersForTable('table-A'))
    const { result: peersResultB } = renderHook(() => useCollabPeersForTable('table-B'))
    const { result: peersResultC } = renderHook(() => useCollabPeersForTable('table-C'))

    expect(peersResultA.current).toBe(peersA)
    expect(peersResultB.current).toBe(peersB)
    expect(peersResultC.current).toEqual([])

    const { result: onlineA } = renderHook(() => useCollabIsOnlineForTable('table-A'))
    const { result: onlineB } = renderHook(() => useCollabIsOnlineForTable('table-B'))
    expect(onlineA.current).toBe(true)
    expect(onlineB.current).toBe(false)

    const { result: statusA } = renderHook(() => useCollabStatusForTable('table-A'))
    const { result: statusB } = renderHook(() => useCollabStatusForTable('table-B'))
    expect(statusA.current).toBe(CollabStatus.SYNCED)
    expect(statusB.current).toBe(CollabStatus.SYNCING)

    const { result: cursorsA } = renderHook(() => useCollabPeerCursorsForTable('table-A'))
    expect(cursorsA.current).toHaveLength(1)
    expect(cursorsA.current[0].recordId).toBe('r1')
  })

  it('在线但已降级到 REST 时不启用 Y.Doc 视图运行时', () => {
    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-fallback',
        status: CollabStatus.SYNCED,
        isOnline: true,
        isFallback: true,
        peers: [],
      })
    })

    const { result: online } = renderHook(() =>
      useCollabIsOnlineForTable('table-fallback'),
    )
    const { result: documentRuntime } = renderHook(() =>
      useCollabDocumentRuntimeForTable('table-fallback'),
    )

    expect(online.current).toBe(true)
    expect(documentRuntime.current).toBe(false)
  })

  it('syncPresence 对 null tableId 不写入', () => {
    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: null, status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
    })
    expect(Object.keys(useTableCollabStore.getState().tables)).toHaveLength(0)
  })

  it('syncUndoRedo 隔离到对应 table', () => {
    const undoFnA = () => {}
    const redoFnA = () => {}
    const undoFnB = () => {}
    const redoFnB = () => {}

    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-B', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
      useTableCollabStore.getState().syncUndoRedo({
        tableId: 'table-A', canUndo: true, canRedo: false, undoFn: undoFnA, redoFn: redoFnA,
      })
      useTableCollabStore.getState().syncUndoRedo({
        tableId: 'table-B', canUndo: false, canRedo: true, undoFn: undoFnB, redoFn: redoFnB,
      })
    })

    const { result: undoRedoA } = renderHook(() => useCollabUndoRedoForTable('table-A'))
    const { result: undoRedoB } = renderHook(() => useCollabUndoRedoForTable('table-B'))

    expect(undoRedoA.current.canUndo).toBe(true)
    expect(undoRedoA.current.canRedo).toBe(false)
    expect(undoRedoA.current.undoFn).toBe(undoFnA)

    expect(undoRedoB.current.canUndo).toBe(false)
    expect(undoRedoB.current.canRedo).toBe(true)
    expect(undoRedoB.current.undoFn).toBe(undoFnB)
  })

  it('syncUndoRedo 无 tableId 时回退到 _lastSyncedTableId', () => {
    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-X', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
      useTableCollabStore.getState().syncUndoRedo({
        canUndo: true, canRedo: true, undoFn: () => {}, redoFn: () => {},
      })
    })

    const slice = useTableCollabStore.getState().tables['table-X']
    expect(slice?.collabCanUndo).toBe(true)
    expect(slice?.collabCanRedo).toBe(true)
  })

  it('removeTable 清理单个表格切片', () => {
    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-B', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
    })

    expect(Object.keys(useTableCollabStore.getState().tables)).toHaveLength(2)

    act(() => useTableCollabStore.getState().removeTable('table-A'))

    const state = useTableCollabStore.getState()
    expect(state.tables['table-A']).toBeUndefined()
    expect(state.tables['table-B']).toBeDefined()
  })

  it('多个 surface 持有同一表时，仅最后一个释放才清理协同切片', () => {
    act(() => {
      useTableCollabStore.getState().retainTable('table-A', 'surface-1')
      useTableCollabStore.getState().retainTable('table-A', 'surface-2')
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
    })

    act(() => useTableCollabStore.getState().releaseTable('table-A', 'surface-1'))
    expect(useTableCollabStore.getState().tables['table-A']).toBeDefined()

    act(() => useTableCollabStore.getState().releaseTable('table-A', 'surface-2'))
    expect(useTableCollabStore.getState().tables['table-A']).toBeUndefined()
  })

  it('待确认视图跨 surface 释放保留，直到原始 REST 快照确认', () => {
    act(() => {
      useTableCollabStore.getState().retainTable('table-A', 'surface-1')
      useTableCollabStore.getState().markPendingOptimisticView('table-A', {
        id: 'view-pending',
      } as ViewMeta)
      useTableCollabStore.getState().releaseTable('table-A', 'surface-1')
    })

    expect(useTableCollabStore.getState().pendingOptimisticViewsByTable['table-A']?.map(item => item.view.id))
      .toEqual(['view-pending'])
    expect(useTableCollabStore.getState().reconcilePendingOptimisticViews('table-A', ['view-1']))
      .toMatchObject([{ id: 'view-pending' }])
    expect(useTableCollabStore.getState().reconcilePendingOptimisticViews('table-A', ['view-1', 'view-pending']))
      .toEqual([])
    expect(useTableCollabStore.getState().pendingOptimisticViewsByTable['table-A'])
      .toBeUndefined()
  })

  it('待确认视图超过收敛窗口后不再回填', () => {
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000)
    try {
      act(() => {
        useTableCollabStore.getState().markPendingOptimisticView('table-A', {
          id: 'view-pending',
        } as ViewMeta)
      })
      now.mockReturnValue(1_000 + COLLAB_PENDING_VIEW_TTL_MS)

      expect(useTableCollabStore.getState().reconcilePendingOptimisticViews('table-A', []))
        .toEqual([])
      expect(useTableCollabStore.getState().pendingOptimisticViewsByTable['table-A'])
        .toBeUndefined()
    } finally {
      now.mockRestore()
    }
  })

  it('reset 清空所有表格', () => {
    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-B', status: CollabStatus.SYNCED, isOnline: true, peers: [],
      })
    })

    act(() => useTableCollabStore.getState().reset())

    expect(Object.keys(useTableCollabStore.getState().tables)).toHaveLength(0)
  })

  it('syncPresence 跳过无变化的更新（同一 peers 引用）', () => {
    const peers = [makePeer('u1')]
    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers,
      })
    })

    const tablesRef1 = useTableCollabStore.getState().tables

    act(() => {
      useTableCollabStore.getState().syncPresence({
        tableId: 'table-A', status: CollabStatus.SYNCED, isOnline: true, peers,
      })
    })

    // 引用不变 → 不触发 set，tables 对象引用应相同
    expect(useTableCollabStore.getState().tables).toBe(tablesRef1)
  })
})
