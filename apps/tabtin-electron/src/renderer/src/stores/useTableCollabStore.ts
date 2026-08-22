/** @store-category session */

/**
 * 表格协作 Presence Store
 *
 * 轻量 zustand store，用于在 DataGridAdapter 和 TablePaneHeader 之间
 * 共享协作者列表和选中状态（跨 React context 边界）。
 *
 * E-06 fix: 以 tableId 为 key 的 Record 存储，支持分屏多表并发而互不污染。
 * 每个 tableId 独立持有自身的 presence / undo-redo 状态切片。
 */

import { create } from 'zustand'
import { useShallow } from 'zustand/react/shallow'
import type { CollabPeerState, CollabStatus } from '@tabtin/collab-core'
import type { ViewMeta, ViewUpdateRequest, ViewCreateRequest } from '@tabtin/table-core'
import { registerResetAction } from './sessionResetRegistry'
import { isTableCollabDocumentRuntimeActive } from './tableCollabRuntime'
import { COLLAB_PENDING_VIEW_TTL_MS } from '@tabtin/table-engine/collab'

type CollabViewUpdateOptions = {
  silent?: boolean
  refreshRecords?: boolean
  optimisticConfig?: Record<string, unknown>
}

type CollabViewUpdater = (
  viewId: string,
  payload: ViewUpdateRequest,
  options?: CollabViewUpdateOptions,
) => Promise<unknown>

type CollabViewDeleter = (viewId: string) => Promise<boolean>

type CollabViewCreator = (
  payload: Omit<ViewCreateRequest, 'table_id'> & { table_id?: string },
) => Promise<ViewMeta | null>

interface PendingOptimisticView {
  view: ViewMeta
  expiresAt: number
}

/** 协作者正在编辑的单元格 */
export interface PeerCellCursor {
  userId: string
  userName: string
  userColor: string
  recordId: string
  fieldId: string
}

/** 单个表格的协作状态切片 */
interface TableSlice {
  status: CollabStatus | null
  /** Provider 连接生命周期（stuck-connecting 供 UI 区分挂起与正常连接中，） */
  connectionStatus: string | null
  isOnline: boolean
  /** 资源级 legacy / REST 投影（含字段可见性降级） */
  isFallback: boolean
  /** 进入 legacy 的原因；供全局连接指示器区分预期降级与故障 */
  syncModeReason: string | null
  /** 手动重连入口（重建 Provider 保留 Y.Doc），供 TablePaneHeader 徽标点击 */
  reconnectFn: (() => void) | null
  /** 服务端快照被截断（超大表）——此时视图记录走 REST 而非 Y.Doc 投影 */
  isTruncated: boolean
  peers: CollabPeerState[]
  peerCursors: PeerCellCursor[]
  collabCanUndo: boolean
  collabCanRedo: boolean
  collabUndoFn: (() => void) | null
  collabRedoFn: (() => void) | null
  /** 订阅 Yjs UndoManager stack 事件，供会话级 UndoTimeline 压 collab 标记 */
  subscribeStackEvent: ((
    cb: (e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void,
  ) => () => void) | null
  updateViewFn: CollabViewUpdater | null
  deleteViewFn: CollabViewDeleter | null
  createViewFn: CollabViewCreator | null
  /** 协作在线时 Y.Doc 视图元数据快照，供 ViewFilterGroupBar 等跨组件读取配置 */
  viewsMeta: ReadonlyArray<ViewMeta> | null
}

interface TableCollabStoreState {
  /** 按 tableId 隔离的协作状态 */
  tables: Record<string, TableSlice>
  /** 最近一次 syncPresence 传入的 tableId（syncUndoRedo 未携带 tableId 时的回退） */
  _lastSyncedTableId: string | null
  /** 当前持有表资源协同状态的 surface owner，防止任一 surface 卸载误删共享切片。 */
  _tableOwners: Record<string, string[]>
  /**
   * 已写入 Y.Doc、但 REST 快照尚未出现的本地新视图。
   *
   * 这份注册表不能放在 `tables[tableId]`：最后一个 surface 切走时该切片会释放，
   * 而服务端对协作视图的异步持久化可能仍未完成。
   */
  pendingOptimisticViewsByTable: Record<string, PendingOptimisticView[]>
}

interface TableCollabStoreActions {
  /** 声明一个 surface 正在使用该表的协同状态；相同 owner 重复调用幂等。 */
  retainTable: (tableId: string, ownerId: string) => void
  /** 释放 surface；最后一个 owner 离开时才清理表协同切片。 */
  releaseTable: (tableId: string, ownerId: string) => void
  markPendingOptimisticView: (tableId: string, view: ViewMeta) => void
  reconcilePendingOptimisticViews: (tableId: string, restViewIds: readonly string[]) => ViewMeta[]
  clearPendingOptimisticView: (tableId: string, viewId: string) => void
  /** DataGridAdapter 同步最新状态 */
  syncPresence: (data: {
    tableId: string | null
    status: CollabStatus | null
    connectionStatus?: string | null
    isOnline: boolean
    isFallback?: boolean
    syncModeReason?: string | null
    isTruncated?: boolean
    peers: CollabPeerState[]
    reconnectFn?: (() => void) | null
  }) => void
  /** 通过 awareness 订阅独立更新光标（绕过 fingerprint 节流） */
  syncPeerCursors: (tableId: string, peers: CollabPeerState[]) => void
  /** 同步 undo/redo 状态（tableId 可选，缺省时关联最近 syncPresence 的表） */
  syncUndoRedo: (data: {
    tableId?: string | null
    canUndo: boolean
    canRedo: boolean
    undoFn: () => void
    redoFn: () => void
    subscribeStackEvent?: ((
      cb: (e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void,
    ) => () => void) | null
  }) => void
  /** 同步当前表的 Y.Doc 视图更新入口，供 Header 跨组件调用 */
  syncViewRuntime: (data: {
    tableId: string | null
    updateViewFn: TableSlice['updateViewFn']
    deleteViewFn?: TableSlice['deleteViewFn']
    createViewFn?: TableSlice['createViewFn']
    viewsMeta?: TableSlice['viewsMeta']
  }) => void
  /** 移除单个表格的切片（卸载时清理） */
  removeTable: (tableId: string) => void
  /** 清空（会话重置） */
  reset: () => void
}

type TableCollabStore = TableCollabStoreState & TableCollabStoreActions

const EMPTY_PEERS: CollabPeerState[] = []
const EMPTY_CURSORS: PeerCellCursor[] = []

const DEFAULT_SLICE: TableSlice = {
  status: null,
  connectionStatus: null,
  isOnline: false,
  isFallback: false,
  syncModeReason: null,
  reconnectFn: null,
  isTruncated: false,
  peers: EMPTY_PEERS,
  peerCursors: EMPTY_CURSORS,
  collabCanUndo: false,
  collabCanRedo: false,
  collabUndoFn: null,
  collabRedoFn: null,
  subscribeStackEvent: null,
  updateViewFn: null,
  deleteViewFn: null,
  createViewFn: null,
  viewsMeta: null,
}

const initialState: TableCollabStoreState = {
  tables: {},
  _lastSyncedTableId: null,
  _tableOwners: {},
  pendingOptimisticViewsByTable: {},
}

function parsePeerCursors(peers: CollabPeerState[]): PeerCellCursor[] {
  const cursors: PeerCellCursor[] = []
  for (const peer of peers) {
    const cursor = peer.cursor as { module?: string; recordId?: string; fieldId?: string } | null | undefined
    if (cursor?.module === 'tabdata' && cursor?.recordId && cursor?.fieldId) {
      cursors.push({
        userId: peer.user.id,
        userName: peer.user.name,
        userColor: peer.user.color,
        recordId: cursor.recordId,
        fieldId: cursor.fieldId,
      })
    }
  }
  return cursors
}

export const useTableCollabStore = create<TableCollabStore>((set, get) => ({
  ...initialState,

  retainTable: (tableId, ownerId) => {
    const { _tableOwners } = get()
    const owners = _tableOwners[tableId] ?? []
    if (owners.includes(ownerId)) return
    set({
      _tableOwners: {
        ..._tableOwners,
        [tableId]: [...owners, ownerId],
      },
    })
  },

  releaseTable: (tableId, ownerId) => {
    const { _tableOwners, tables, _lastSyncedTableId } = get()
    const owners = _tableOwners[tableId] ?? []
    if (!owners.includes(ownerId)) return

    const nextOwnersForTable = owners.filter(owner => owner !== ownerId)
    const nextOwners = { ..._tableOwners }
    if (nextOwnersForTable.length > 0) {
      nextOwners[tableId] = nextOwnersForTable
      set({ _tableOwners: nextOwners })
      return
    }

    delete nextOwners[tableId]
    const nextTables = { ...tables }
    delete nextTables[tableId]
    set({
      _tableOwners: nextOwners,
      tables: nextTables,
      _lastSyncedTableId: _lastSyncedTableId === tableId ? null : _lastSyncedTableId,
    })
  },

  markPendingOptimisticView: (tableId, view) => {
    const { pendingOptimisticViewsByTable } = get()
    const current = pendingOptimisticViewsByTable[tableId] ?? []
    if (current.some(item => item.view.id === view.id)) return
    const expiresAt = Date.now() + COLLAB_PENDING_VIEW_TTL_MS
    set({
      pendingOptimisticViewsByTable: {
        ...pendingOptimisticViewsByTable,
        [tableId]: [...current, { view, expiresAt }],
      },
    })
    globalThis.setTimeout(() => {
      get().reconcilePendingOptimisticViews(tableId, [])
    }, COLLAB_PENDING_VIEW_TTL_MS)
  },

  reconcilePendingOptimisticViews: (tableId, restViewIds) => {
    const { pendingOptimisticViewsByTable } = get()
    const current = pendingOptimisticViewsByTable[tableId] ?? []
    if (current.length === 0) return []

    const restViewIdSet = new Set(restViewIds)
    const now = Date.now()
    const remaining = current.filter(item =>
      !restViewIdSet.has(item.view.id) && item.expiresAt > now,
    )
    if (remaining.length === current.length) return remaining.map(item => item.view)

    const next = { ...pendingOptimisticViewsByTable }
    if (remaining.length > 0) {
      next[tableId] = remaining
    } else {
      delete next[tableId]
    }
    set({ pendingOptimisticViewsByTable: next })
    return remaining.map(item => item.view)
  },

  clearPendingOptimisticView: (tableId, viewId) => {
    const { pendingOptimisticViewsByTable } = get()
    const current = pendingOptimisticViewsByTable[tableId] ?? []
    if (!current.some(item => item.view.id === viewId)) return

    const remaining = current.filter(item => item.view.id !== viewId)
    const next = { ...pendingOptimisticViewsByTable }
    if (remaining.length > 0) {
      next[tableId] = remaining
    } else {
      delete next[tableId]
    }
    set({ pendingOptimisticViewsByTable: next })
  },

  syncPresence: ({
    tableId,
    status,
    connectionStatus = null,
    isOnline,
    isFallback = false,
    syncModeReason = null,
    isTruncated = false,
    peers,
    reconnectFn = null,
  }) => {
    if (!tableId) return
    const { tables } = get()
    const existing = tables[tableId]
    const nextReason = syncModeReason ?? null

    if (
      existing &&
      existing.status === status &&
      existing.connectionStatus === connectionStatus &&
      existing.isOnline === isOnline &&
      existing.isFallback === isFallback &&
      existing.syncModeReason === nextReason &&
      existing.isTruncated === isTruncated &&
      existing.peers === peers &&
      existing.reconnectFn === reconnectFn
    ) {
      return
    }

    const peerCursors = parsePeerCursors(peers)
    set({
      tables: {
        ...tables,
        [tableId]: {
          ...(existing ?? DEFAULT_SLICE),
          status,
          connectionStatus,
          isOnline,
          isFallback,
          syncModeReason: nextReason,
          isTruncated,
          peers,
          peerCursors,
          reconnectFn,
        },
      },
      _lastSyncedTableId: tableId,
    })
  },

  syncPeerCursors: (tableId: string, peers: CollabPeerState[]) => {
    const { tables } = get()
    const existing = tables[tableId]
    const peerCursors = parsePeerCursors(peers)

    const prev = existing?.peerCursors ?? EMPTY_CURSORS
    if (
      prev.length === peerCursors.length &&
      prev.every((c, i) =>
        c.userId === peerCursors[i].userId &&
        c.recordId === peerCursors[i].recordId &&
        c.fieldId === peerCursors[i].fieldId
      )
    ) {
      return
    }

    set({
      tables: {
        ...tables,
        [tableId]: {
          ...(existing ?? DEFAULT_SLICE),
          peerCursors,
        },
      },
    })
  },

  syncUndoRedo: ({
    tableId: explicitTableId,
    canUndo,
    canRedo,
    undoFn,
    redoFn,
    subscribeStackEvent,
  }) => {
    const { tables, _lastSyncedTableId } = get()
    const resolvedId = explicitTableId ?? _lastSyncedTableId
    if (!resolvedId) return

    const existing = tables[resolvedId]
    const nextSubscribe =
      subscribeStackEvent === undefined
        ? (existing?.subscribeStackEvent ?? null)
        : subscribeStackEvent
    if (
      existing &&
      existing.collabCanUndo === canUndo &&
      existing.collabCanRedo === canRedo &&
      existing.collabUndoFn === undoFn &&
      existing.collabRedoFn === redoFn &&
      existing.subscribeStackEvent === nextSubscribe
    ) {
      return
    }
    set({
      tables: {
        ...tables,
        [resolvedId]: {
          ...(existing ?? DEFAULT_SLICE),
          collabCanUndo: canUndo,
          collabCanRedo: canRedo,
          collabUndoFn: undoFn,
          collabRedoFn: redoFn,
          subscribeStackEvent: nextSubscribe,
        },
      },
    })
  },

  syncViewRuntime: ({ tableId, updateViewFn, deleteViewFn, createViewFn, viewsMeta }) => {
    if (!tableId) return
    const { tables } = get()
    const existing = tables[tableId]
    const nextViewsMeta = viewsMeta === undefined ? (existing?.viewsMeta ?? null) : viewsMeta
    const nextDeleteViewFn = deleteViewFn === undefined ? (existing?.deleteViewFn ?? null) : deleteViewFn
    const nextCreateViewFn = createViewFn === undefined ? (existing?.createViewFn ?? null) : createViewFn
    if (
      existing?.updateViewFn === updateViewFn &&
      existing?.deleteViewFn === nextDeleteViewFn &&
      existing?.createViewFn === nextCreateViewFn &&
      existing?.viewsMeta === nextViewsMeta
    ) {
      return
    }
    set({
      tables: {
        ...tables,
        [tableId]: {
          ...(existing ?? DEFAULT_SLICE),
          updateViewFn,
          deleteViewFn: nextDeleteViewFn,
          createViewFn: nextCreateViewFn,
          viewsMeta: nextViewsMeta,
        },
      },
    })
  },

  removeTable: (tableId: string) => {
    const { tables, _tableOwners, _lastSyncedTableId } = get()
    if (!tables[tableId]) return
    const next = { ...tables }
    const nextOwners = { ..._tableOwners }
    delete next[tableId]
    delete nextOwners[tableId]
    set({
      tables: next,
      _tableOwners: nextOwners,
      _lastSyncedTableId: _lastSyncedTableId === tableId ? null : _lastSyncedTableId,
    })
  },

  reset: () => set(initialState),
}))

// ── 按 tableId 隔离的 selector hooks（消费端使用） ──

/** 返回指定 tableId 的 peers，不存在则返回空数组 */
export function useCollabPeersForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.peers ?? EMPTY_PEERS) : EMPTY_PEERS
  )
}

/** 返回指定 tableId 的 isOnline */
export function useCollabIsOnlineForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.isOnline ?? false) : false
  )
}

/** 返回指定 tableId 是否正在使用 Y.Doc 视图配置运行时（REST fallback 时为 false） */
export function useCollabDocumentRuntimeForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? isTableCollabDocumentRuntimeActive(state.tables[tableId]) : false
  )
}

/** 返回指定 tableId 的 isTruncated（超大表快照截断，视图记录走 REST 而非投影） */
export function useCollabIsTruncatedForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.isTruncated ?? false) : false
  )
}

/** 返回指定 tableId 的协作连接状态（供 header CollabStatusBadge 消费） */
export function useCollabStatusForTable(tableId: string | null): CollabStatus | null {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.status ?? null) : null
  )
}

/** 返回指定 tableId 的 Provider 连接生命周期（stuck-connecting 供 badge 区分挂起，） */
export function useCollabConnectionStatusForTable(tableId: string | null): string | null {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.connectionStatus ?? null) : null
  )
}

/** 返回指定 tableId 的手动重连入口（重建 Provider 保留 Y.Doc） */
export function useCollabReconnectForTable(tableId: string | null): (() => void) | null {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.reconnectFn ?? null) : null
  )
}

/** 返回指定 tableId 的 Y.Doc 视图更新入口 */
export function useCollabViewUpdaterForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.updateViewFn ?? null) : null
  )
}

export function useCollabViewDeleterForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.deleteViewFn ?? null) : null
  )
}

export function useCollabViewCreatorForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.createViewFn ?? null) : null
  )
}

/** 返回指定 tableId 的 Y.Doc 视图元数据（协作在线时供工具栏读取配置） */
export function useCollabViewsMetaForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.viewsMeta ?? null) : null
  )
}

/** 返回指定 tableId 的 peerCursors */
export function useCollabPeerCursorsForTable(tableId: string | null) {
  return useTableCollabStore(state =>
    tableId ? (state.tables[tableId]?.peerCursors ?? EMPTY_CURSORS) : EMPTY_CURSORS
  )
}

/** 返回指定 tableId 的 undo/redo 状态和回调 */
export function useCollabUndoRedoForTable(tableId: string | null) {
  return useTableCollabStore(useShallow(state => {
    const slice = tableId ? state.tables[tableId] : undefined
    if (!slice) {
      return {
        isOnline: false as boolean,
        canUndo: false as boolean,
        canRedo: false as boolean,
        undoFn: null as (() => void) | null,
        redoFn: null as (() => void) | null,
        subscribeStackEvent: null as ((
          cb: (e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void,
        ) => () => void) | null,
      }
    }
    return {
      isOnline: slice.isOnline,
      canUndo: slice.collabCanUndo,
      canRedo: slice.collabCanRedo,
      undoFn: slice.collabUndoFn,
      redoFn: slice.collabRedoFn,
      subscribeStackEvent: slice.subscribeStackEvent,
    }
  }))
}

registerResetAction('table-collab', 'reset', () => useTableCollabStore.getState().reset())
