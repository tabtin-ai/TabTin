/**
 * useUndoRedoCore — undo/redo 操作 + stack 管理
 *
 * Phase 3：会话级 UndoTimeline 统一调度 collab（Yjs）与 backend（REST）。
 * - 时间线有标记时按 peek 决定走哪条路径（交错操作不再「Yjs 永远优先」）
 * - 时间线空时回退旧逻辑：在线且 Yjs 有栈 → collab，否则 REST（兼容未接线压标记路径）
 * - 离线态始终走后端持久栈
 */

import { useState, useCallback, useEffect, useRef } from 'react'
import { UndoRedoApiService } from '@tabtin/table-core'
import { useToast } from '@tabtin/smartsheet-ui'
import {
  createUndoTimeline,
  type UndoTimeline,
  type UndoTimelineSource,
} from './undoTimeline'
import { registerBackendUndoableRecorder } from './undoTimelineBridge'

const STACK_PREVIEW_LIMIT = 10
const UNDO_REDO_MIN_INTERVAL_MS = 300

/**
 * 表级 undo/redo **不要**派发 `tabtin:collab-resource-restored`。
 *
 * 该事件会触发 `useTableCollaboration.forceReconnect`：清空 Yjs UndoManager、
 * 修剪时间线 collab 标记、整表断线重连——用户体感是「闪好几下 + 撤销栈没了」。
 * 字段/视图结构变更已由后端 `_resync_collab_after_schema_change` 增量同步 Y.Doc；
 * 客户端刷新字段/视图，并对 schema 操作强制 refreshRecords（协作投影以 Y.Doc
 * 为准，若只跳过 REST 刷新，空/脏 doc 会把表「闪空」粘住，见 ）。
 * checkpoint / 版本历史还原仍走该事件（见 collabVersionHistory 等）。
 */

const SCHEMA_UNDO_OPERATION_NAMES = new Set([
  'createFields',
  'deleteFields',
  'updateFields',
  'createView',
  'deleteView',
  'updateView',
])

function operationsTouchSchema(operations: unknown): boolean {
  if (!Array.isArray(operations)) return false
  return operations.some((op) => {
    if (!op || typeof op !== 'object') return false
    const row = op as {
      name?: unknown
      field_changes?: Record<string, unknown>
      items?: Array<{ field_key?: unknown }>
    }
    if (SCHEMA_UNDO_OPERATION_NAMES.has(String(row.name ?? ''))) return true
    const fc = row.field_changes
    if (fc && ('_fields' in fc || '_views' in fc)) return true
    return Boolean(
      row.items?.some((item) => {
        const key = String(item.field_key ?? '')
        return key.startsWith('field:') || key.startsWith('view:')
      }),
    )
  })
}

function notifySchemaStackOperation(tableId: string) {
  if (typeof window === 'undefined') return
  window.dispatchEvent(
    new CustomEvent('tabtin:table-schema-stack-op', {
      detail: { tableId, resourceTypes: ['table'], source: 'undo-redo' },
    }),
  )
}

export type CollabUndoStackEvent = {
  kind: 'added' | 'popped'
  changedStack: 'undo' | 'redo'
}

export interface CollabUndoRedoState {
  isOnline: boolean
  canUndo: boolean
  canRedo: boolean
  undoFn: (() => void) | null
  redoFn: (() => void) | null
  /**
   * 订阅 Yjs UndoManager stack 事件。
   * useUndoRedoCore 只在 `added` + `undo` 时 timeline.push('collab')；
   * `added`+`redo` 与 `popped` 忽略（由 handleUndo/Redo 驱动时间线，避免双计）。
   */
  subscribeStackEvent?: ((
    cb: (e: CollabUndoStackEvent) => void,
  ) => () => void) | null
}

export const COLLAB_OFFLINE: CollabUndoRedoState = {
  isOnline: false,
  canUndo: false,
  canRedo: false,
  undoFn: null,
  redoFn: null,
  subscribeStackEvent: null,
}

/** W1.4 / 字段批量恢复 409 元数据(后端 FIELD_RESTORE_NOT_SUPPORTED 响应的 data) */
export interface FieldRestoreNotSupportedDetail {
  field_id: string
  field_name: string
  field_type: string
  reason_code: string
  deferred_to?: 'version_history' | null
  unrestorable_fields: Array<{ id: string; name: string; type: string }>
  restorable_fields: Array<{ id: string; name: string; type: string }>
}

export interface UseUndoRedoCoreInput {
  selectedTableId: string | null
  refreshRecords: () => Promise<void>
  refreshViews?: () => Promise<void>
  translate: (key: string, opts?: Record<string, unknown>) => string
  enableUndoRedo?: boolean
  /** When false, skip the eager stack fetch on mount/table-change (portal-parked tabs). */
  isActive?: boolean
  collabUndoRedo?: CollabUndoRedoState
  /**
   * 表数据版本信号（如 record store 的 records 引用）。变化即视为本地编辑落库，
   * 用于离线/降级态在编辑后去重刷新后端撤回栈，让撤回/重做按钮及时点亮。
   * 真在线态由 Yjs 会话栈驱动按钮、schema 操作各自显式刷新，不消费此信号。
   */
  dataVersion?: number | string | object | null
  /**
   * W1.4 / C1:tableUndo 收到 409 + FIELD_RESTORE_NOT_SUPPORTED 时回调,
   * 上层(DataGridAdapter)用此弹出 FieldBatchUndoConflictDialog 显示分类。
   * 不传则默认 fallback 到 destructive toast。
   */
  onFieldRestoreNotSupported?: (detail: FieldRestoreNotSupportedDetail) => void
  /**
   * 协作在线且 Y.Doc 投影为记录真相源时，表级 undo/redo 由后端 collab resync /
   * 记录投影驱动刷新，跳过 refreshRecords，避免全量 REST 覆盖未落库的 Yjs 乐观编辑。
   * （不再依赖 forceReconnect；见 runBackendUndo 注释。）
   */
  skipRecordsRefreshOnStackOperation?: boolean
}

export interface UseUndoRedoCoreResult {
  handleUndo: () => Promise<void>
  handleRedo: () => Promise<void>
  canUndo: boolean
  canRedo: boolean
  isUndoing: boolean
  isRedoing: boolean
  undoStackTotal: number
  redoStackTotal: number
  refreshStacks: () => Promise<void>
  /** 字段/视图删除等仅走 REST 的 schema 操作成功后，压一条 backend 时间线标记 */
  recordBackendUndoable: () => void
  /** 通用压标记（测试 / 上层扩展）；等价于 timeline.push */
  recordTimelineEvent: (source: UndoTimelineSource) => void
}

export function useUndoRedoCore({
  selectedTableId,
  refreshRecords,
  refreshViews,
  translate,
  enableUndoRedo = true,
  isActive = true,
  collabUndoRedo = COLLAB_OFFLINE,
  dataVersion = null,
  onFieldRestoreNotSupported,
  skipRecordsRefreshOnStackOperation = false,
}: UseUndoRedoCoreInput): UseUndoRedoCoreResult {
  const { toast } = useToast()
  const onFieldRestoreNotSupportedRef = useRef(onFieldRestoreNotSupported)
  onFieldRestoreNotSupportedRef.current = onFieldRestoreNotSupported

  const collabIsOnline = collabUndoRedo.isOnline
  const collabCanUndo = collabUndoRedo.canUndo
  const collabCanRedo = collabUndoRedo.canRedo
  const collabUndoFn = collabUndoRedo.undoFn
  const collabRedoFn = collabUndoRedo.redoFn
  const subscribeStackEvent = collabUndoRedo.subscribeStackEvent

  const lastUndoRedoTs = useRef(0)

  const [undoStackTotal, setUndoStackTotal] = useState(0)
  const [redoStackTotal, setRedoStackTotal] = useState(0)
  const [isUndoing, setIsUndoing] = useState(false)
  const [isRedoing, setIsRedoing] = useState(false)
  // 时间线深度变化时触发重渲染（canUndo/canRedo 依赖 peek）
  const [, setTimelineEpoch] = useState(0)

  const timelineRef = useRef<UndoTimeline>(createUndoTimeline())
  /** handleUndo/Redo 驱动时间线期间抑制 Yjs added 回调，避免 redo 把项加回 undo 栈时双计 */
  const suppressCollabPushRef = useRef(false)

  // 切表时清空会话时间线
  useEffect(() => {
    timelineRef.current.clear()
    setTimelineEpoch((n) => n + 1)
  }, [selectedTableId])

  useEffect(() => {
    return timelineRef.current.subscribe(() => {
      setTimelineEpoch((n) => n + 1)
    })
  }, [selectedTableId])

  // forceReconnect / 资源恢复后 Yjs 栈已清空 → 修剪时间线里的 collab 标记
  useEffect(() => {
    if (typeof window === 'undefined') return
    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail as {
        resourceTypes?: string[]
        tableId?: string
      } | undefined
      if (detail?.resourceTypes && !detail.resourceTypes.includes('table')) return
      if (detail?.tableId && selectedTableId && detail.tableId !== selectedTableId) return
      timelineRef.current.clearCollabMarks()
    }
    window.addEventListener('tabtin:collab-resource-restored', handler)
    return () => window.removeEventListener('tabtin:collab-resource-restored', handler)
  }, [selectedTableId])

  // 订阅 Yjs stack-item-added：仅 undo 栈新增 → 压 collab 标记
  useEffect(() => {
    if (!subscribeStackEvent) return
    return subscribeStackEvent((event) => {
      if (suppressCollabPushRef.current) return
      if (event.kind === 'added' && event.changedStack === 'undo') {
        timelineRef.current.push('collab')
      }
      // added+redo：通常是 undo 产生的 redo 项，时间线已在 handleUndo 里推进，忽略
      // popped：由 handleUndo/Redo 驱动时间线，忽略以免双计
    })
  }, [subscribeStackEvent, selectedTableId])

  const timeline = timelineRef.current
  const timelineUndoDepth = timeline.getUndoDepth()
  const timelineRedoDepth = timeline.getRedoDepth()
  const peekUndo = timeline.peekUndo()
  const peekRedo = timeline.peekRedo()

  // 时间线有标记时按时间线；否则回退「Yjs 优先 / 后端兜底」
  const backendCanUndo = enableUndoRedo && undoStackTotal > 0 && !isUndoing
  const backendCanRedo = enableUndoRedo && redoStackTotal > 0 && !isRedoing
  const yjsCanUndo = Boolean(collabIsOnline && collabCanUndo && collabUndoFn)
  const yjsCanRedo = Boolean(collabIsOnline && collabCanRedo && collabRedoFn)

  const canUndo =
    timelineUndoDepth > 0
      ? peekUndo === 'collab'
        // collab 顶但 Yjs 已空时仍允许点（handleUndo 会 REST 兜底）
        ? yjsCanUndo || backendCanUndo
        : backendCanUndo
      : yjsCanUndo || backendCanUndo

  const canRedo =
    timelineRedoDepth > 0
      ? peekRedo === 'collab'
        ? yjsCanRedo || backendCanRedo
        : backendCanRedo
      : yjsCanRedo || backendCanRedo

  const refreshStacks = useCallback(async () => {
    if (!selectedTableId || !enableUndoRedo) {
      setUndoStackTotal(0)
      setRedoStackTotal(0)
      return
    }
    try {
      const [undoResult, redoResult] = await Promise.all([
        UndoRedoApiService.getUndoStack(selectedTableId, {
          only_my_operations: true,
          limit: STACK_PREVIEW_LIMIT,
        }),
        UndoRedoApiService.getRedoStack(selectedTableId, {
          only_my_operations: true,
          limit: STACK_PREVIEW_LIMIT,
        }),
      ])
      setUndoStackTotal(undoResult.total)
      setRedoStackTotal(redoResult.total)
    } catch (error) {
      console.warn('[useUndoRedoCore] refreshStacks failed:', error)
    }
  }, [selectedTableId, enableUndoRedo])

  useEffect(() => {
    if (isActive) {
      void refreshStacks()
    }
  }, [refreshStacks, isActive])

  // ── 本地编辑落库（dataVersion 变化）后去重刷新后端栈 ──
  // 不按 collabIsOnline 门控：store 的 isOnline 只表示「连上了」，并不代表 Yjs 会话栈
  // 在驱动按钮——协作降级（isFallback，如孤儿字段）时 isOnline 仍为 true 但 collabCanUndo
  // 恒 false，此时编辑走 REST 落后端窗口栈，必须刷新后端才能点亮按钮。健康在线态下
  // 单元格编辑经 collab 持久化（window_id=None），窗口栈查询返回 0、按钮仍由 Yjs 驱动，
  // 多一次刷新无害。
  const lastDataVersionRef = useRef(dataVersion)
  useEffect(() => {
    if (lastDataVersionRef.current === dataVersion) return
    lastDataVersionRef.current = dataVersion
    if (!isActive) return
    const timer = setTimeout(() => {
      void refreshStacks()
    }, UNDO_REDO_MIN_INTERVAL_MS)
    return () => clearTimeout(timer)
  }, [dataVersion, isActive, refreshStacks])

  const recordTimelineEvent = useCallback((source: UndoTimelineSource) => {
    timelineRef.current.push(source)
  }, [])

  const recordBackendUndoable = useCallback(() => {
    timelineRef.current.push('backend')
  }, [])

  // 供 Header 侧 ViewSwitcher 等 Provider 外组件压 backend 标记
  useEffect(() => {
    if (!selectedTableId) return
    return registerBackendUndoableRecorder(selectedTableId, recordBackendUndoable)
  }, [selectedTableId, recordBackendUndoable])

  const runBackendUndo = useCallback(async (): Promise<boolean> => {
    if (!enableUndoRedo || !selectedTableId || isUndoing) return false
    const now = Date.now()
    if (now - lastUndoRedoTs.current < UNDO_REDO_MIN_INTERVAL_MS) return false
    lastUndoRedoTs.current = now
    setIsUndoing(true)
    try {
      const result = await UndoRedoApiService.undoTable(selectedTableId, {
        only_my_operations: true,
      })
      if (result.success) {
        toast({
          title: translate('table:toolbar.undoSuccess'),
          description: result.message || undefined,
        })
        const schemaOp = operationsTouchSchema(result.operations)
        // 不 forceReconnect：后端 schema resync 已推 Y.Doc；此处刷新字段/视图。
        // schema 操作即使协作在线也必须 refreshRecords，并通知宿主把 REST 行镜像回 Y.Doc
        // （否则空 doc 投影会把表粘成空白，见 ）。
        await refreshViews?.()
        if (!skipRecordsRefreshOnStackOperation || schemaOp) {
          await refreshRecords()
        }
        if (schemaOp) {
          notifySchemaStackOperation(selectedTableId)
        }
        await refreshStacks()
        return true
      }
      toast({
        variant: 'destructive',
        title: translate('table:toolbar.noUndoOperations'),
        description: result.message || undefined,
      })
      return false
    } catch (error: unknown) {
      // W1.4 / C1:识别 409 + FIELD_RESTORE_NOT_SUPPORTED → 弹出分类 dialog
      // 而不是只显示 destructive toast
      const errLike = error as {
        status?: number
        code?: string
        data?: FieldRestoreNotSupportedDetail
      } | undefined
      const isFieldRestoreError =
        errLike?.status === 409 &&
        errLike?.code === 'FIELD_RESTORE_NOT_SUPPORTED' &&
        errLike?.data
      if (isFieldRestoreError && onFieldRestoreNotSupportedRef.current) {
        onFieldRestoreNotSupportedRef.current(errLike.data as FieldRestoreNotSupportedDetail)
      } else if (errLike?.code === 'NO_UNDO_OPERATIONS') {
        // 栈为空是中性状态（没得撤），不是执行失败——用非破坏性提示，
        // 避免误导用户以为"撤销出错了"。
        toast({
          title: translate('table:toolbar.noUndoOperations'),
        })
      } else {
        // 真正执行失败（如字段恢复因同名冲突失败）：透出后端具体原因，
        // 不再落到"没有可撤销的操作"这种误导性文案。
        toast({
          variant: 'destructive',
          title: translate('table:toolbar.undoFailed'),
          description: error instanceof Error ? error.message : undefined,
        })
      }
      return false
    } finally {
      setIsUndoing(false)
    }
  }, [
    enableUndoRedo,
    selectedTableId,
    isUndoing,
    refreshRecords,
    refreshViews,
    refreshStacks,
    skipRecordsRefreshOnStackOperation,
    toast,
    translate,
  ])

  const runBackendRedo = useCallback(async (): Promise<boolean> => {
    if (!enableUndoRedo || !selectedTableId || isRedoing) return false
    const now = Date.now()
    if (now - lastUndoRedoTs.current < UNDO_REDO_MIN_INTERVAL_MS) return false
    lastUndoRedoTs.current = now
    setIsRedoing(true)
    try {
      const result = await UndoRedoApiService.redoTable(selectedTableId, {
        only_my_operations: true,
      })
      if (result.success) {
        toast({
          title: translate('table:toolbar.redoSuccess'),
          description: result.message || undefined,
        })
        const schemaOp = operationsTouchSchema(result.operations)
        await refreshViews?.()
        if (!skipRecordsRefreshOnStackOperation || schemaOp) {
          await refreshRecords()
        }
        if (schemaOp) {
          notifySchemaStackOperation(selectedTableId)
        }
        await refreshStacks()
        return true
      }
      toast({
        variant: 'destructive',
        title: translate('table:toolbar.noRedoOperations'),
        description: result.message || undefined,
      })
      return false
    } catch (error: unknown) {
      const errLike = error as { code?: string } | undefined
      if (errLike?.code === 'NO_REDO_OPERATIONS') {
        toast({
          title: translate('table:toolbar.noRedoOperations'),
        })
      } else {
        toast({
          variant: 'destructive',
          title: translate('table:toolbar.redoFailed'),
          description: error instanceof Error ? error.message : undefined,
        })
      }
      return false
    } finally {
      setIsRedoing(false)
    }
  }, [
    enableUndoRedo,
    selectedTableId,
    isRedoing,
    refreshRecords,
    refreshViews,
    refreshStacks,
    skipRecordsRefreshOnStackOperation,
    toast,
    translate,
  ])

  const handleUndo = useCallback(async () => {
    // 快捷键不经按钮 disabled；无可用项时直接返回，避免误报「没有可执行的撤销」
    const source = timelineRef.current.peekUndo()
    const hasTimeline = source === 'collab' || source === 'backend'
    const yjsReady = Boolean(collabIsOnline && collabCanUndo && collabUndoFn)
    if (hasTimeline) {
      if (source === 'collab' && !yjsReady && !(enableUndoRedo && undoStackTotal > 0)) return
      if (source === 'backend' && !(enableUndoRedo && undoStackTotal > 0)) return
    } else if (!yjsReady && !(enableUndoRedo && undoStackTotal > 0)) {
      return
    }

    // ── 时间线驱动 ──
    if (source === 'collab') {
      if (collabIsOnline && collabUndoFn) {
        // pop 进 redo，再调 Yjs；抑制期间 Yjs 的 added/popped 以免双计
        suppressCollabPushRef.current = true
        try {
          timelineRef.current.popUndo()
          collabUndoFn()
        } finally {
          suppressCollabPushRef.current = false
        }
        return
      }
      // collab 标记在但 Yjs 不可用：回退 REST；先 pop，失败再 pushBack
      timelineRef.current.popUndo()
      const ok = await runBackendUndo()
      if (!ok) {
        timelineRef.current.pushBackUndo('collab')
      }
      return
    }

    if (source === 'backend') {
      // 先 pop 进 redo；REST 失败则 pushBackUndo，标记仍可再试
      timelineRef.current.popUndo()
      const ok = await runBackendUndo()
      if (!ok) {
        timelineRef.current.pushBackUndo('backend')
      }
      return
    }

    // ── 时间线空：兼容未接线压标记路径（Yjs 优先 / REST 兜底）──
    if (collabIsOnline && collabCanUndo && collabUndoFn) {
      suppressCollabPushRef.current = true
      try {
        collabUndoFn()
      } finally {
        suppressCollabPushRef.current = false
      }
      return
    }

    await runBackendUndo()
  }, [
    collabIsOnline,
    collabCanUndo,
    collabUndoFn,
    enableUndoRedo,
    undoStackTotal,
    runBackendUndo,
  ])

  const handleRedo = useCallback(async () => {
    const source = timelineRef.current.peekRedo()
    const hasTimeline = source === 'collab' || source === 'backend'
    const yjsReady = Boolean(collabIsOnline && collabCanRedo && collabRedoFn)
    if (hasTimeline) {
      if (source === 'collab' && !yjsReady && !(enableUndoRedo && redoStackTotal > 0)) return
      if (source === 'backend' && !(enableUndoRedo && redoStackTotal > 0)) return
    } else if (!yjsReady && !(enableUndoRedo && redoStackTotal > 0)) {
      return
    }

    if (source === 'collab') {
      if (collabIsOnline && collabRedoFn) {
        // redo 会把项加回 Yjs undo 栈并触发 added+undo；必须抑制以免双计
        suppressCollabPushRef.current = true
        try {
          timelineRef.current.popRedo()
          collabRedoFn()
        } finally {
          suppressCollabPushRef.current = false
        }
        return
      }
      timelineRef.current.popRedo()
      const ok = await runBackendRedo()
      if (!ok) {
        timelineRef.current.pushBackRedo('collab')
      }
      return
    }

    if (source === 'backend') {
      timelineRef.current.popRedo()
      const ok = await runBackendRedo()
      if (!ok) {
        timelineRef.current.pushBackRedo('backend')
      }
      return
    }

    if (collabIsOnline && collabCanRedo && collabRedoFn) {
      suppressCollabPushRef.current = true
      try {
        collabRedoFn()
      } finally {
        suppressCollabPushRef.current = false
      }
      return
    }

    await runBackendRedo()
  }, [
    collabIsOnline,
    collabCanRedo,
    collabRedoFn,
    enableUndoRedo,
    redoStackTotal,
    runBackendRedo,
  ])

  return {
    handleUndo,
    handleRedo,
    canUndo,
    canRedo,
    isUndoing,
    isRedoing,
    undoStackTotal,
    redoStackTotal,
    refreshStacks,
    recordBackendUndoable,
    recordTimelineEvent,
  }
}
