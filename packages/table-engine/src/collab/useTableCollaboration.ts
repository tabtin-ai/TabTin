/**
 * useTableCollaboration — TabData Y.js 实时协作 Hook
 *
 * 纯 React Hook，无 Electron 特有依赖。
 * Electron/Web 等宿主通过 UseTableCollaborationInput 注入
 * getAuthToken / serverUrl / user / collabDisabled 等运行时参数。
 */

import { useEffect, useMemo, useState, useCallback, useRef } from 'react'
import * as Y from 'yjs'
import type { RecordOrderContext } from '@tabtin/table-core'
import {
  useCollabProvider,
  useOfflineReplay,
  CollabStatus,
  type CollabConnectionStatus,
  type CollabProviderOptions,
  type CollabPeerState,
  type CollabSyncMode,
  type CollabSyncModeReason,
} from '@tabtin/collab-core'
import { acquireTableUndoRuntime } from './tableUndoRuntime'
import { YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_ROW_ORDER_MAP, YDOC_META, YDOC_VIEWS, YDOC_VIEW_ORDER_MAP } from './ydoc-schema'
import { getOrderedIds } from './y-utils'
import { RECORD_POSITION_FIELD } from './record-position'
import {
  applyTableRecordOrderPlan,
  getEffectiveTableRecordOrder,
  insertTableRecordAtomically,
  LEGACY_RECORD_ORDER_FIELD,
  planLegacyTableRecordOrderReconcile,
  planTableRecordOrderReconcile,
  reorderTableRecordsAtomically,
} from './table-record-order'
import { orderFieldsMeta } from './field-meta-order'
import {
  buildTableCollabConnectionParameters,
  FIELD_VISIBILITY_RESTRICTED,
  isRestProjectionAccess,
  resolveTableCollabDeniedReason,
  type TableCollabAccessDecision,
} from './collabAccess'

// ── 类型 ──

/**
 * Yjs UndoManager 只跟踪真正的用户编辑。
 * - `local`：用户在本端的单元格/行操作，进入 UndoManager
 * - `mirror`：REST 结果镜像 / pending replay 等系统同步，不进 UndoManager
 */
export const COLLAB_ORIGIN_LOCAL = 'local'
export const COLLAB_ORIGIN_MIRROR = 'mirror'
export const COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE = 'legacy-position-reconcile'

export interface DiscardedRecordUpdateNotice {
  event_id: string
  record_id: string
  target_editor_id: string
  deleted_by_id: string
  deleted_by_name: string
  created_at: number
}

export const DISCARDED_RECORD_UPDATE_NOTICE_TTL_MS = 5 * 60 * 1000
const DISCARDED_NOTICE_SEEN_STORAGE_PREFIX = 'tabtin:table:discarded-update-seen:'
const MAX_PERSISTED_DISCARDED_NOTICE_IDS = 200
const discardedNoticeMemorySeen = new Map<string, Set<string>>()

function readPersistedDiscardedNoticeIds(userId: string): Set<string> {
  const result = new Set(discardedNoticeMemorySeen.get(userId) ?? [])
  try {
    const raw = globalThis.localStorage?.getItem(`${DISCARDED_NOTICE_SEEN_STORAGE_PREFIX}${userId}`)
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      for (const eventId of parsed) {
        if (typeof eventId === 'string') result.add(eventId)
      }
    }
  } catch { /* storage unavailable/corrupt: in-memory de-dup still works */ }
  return result
}

function persistDiscardedNoticeIds(userId: string, eventIds: Set<string>): void {
  const bounded = Array.from(eventIds).slice(-MAX_PERSISTED_DISCARDED_NOTICE_IDS)
  discardedNoticeMemorySeen.set(userId, new Set(bounded))
  try {
    globalThis.localStorage?.setItem(
      `${DISCARDED_NOTICE_SEEN_STORAGE_PREFIX}${userId}`,
      JSON.stringify(bounded),
    )
  } catch { /* storage unavailable: memory fallback remains */ }
}

export function selectUnseenDiscardedRecordUpdates(
  raw: unknown,
  currentUserId: string,
  seenEventIds: Set<string>,
  now: number = Date.now(),
): DiscardedRecordUpdateNotice[] {
  if (!Array.isArray(raw)) return []
  const selected: DiscardedRecordUpdateNotice[] = []
  for (const value of raw) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue
    const notice = value as Record<string, unknown>
    if (
      typeof notice.event_id !== 'string'
      || typeof notice.record_id !== 'string'
      || notice.target_editor_id !== currentUserId
      || typeof notice.created_at !== 'number'
      || now - notice.created_at > DISCARDED_RECORD_UPDATE_NOTICE_TTL_MS
      || notice.created_at - now > 30_000
      || seenEventIds.has(notice.event_id)
    ) continue
    seenEventIds.add(notice.event_id)
    selected.push({
      event_id: notice.event_id,
      record_id: notice.record_id,
      target_editor_id: currentUserId,
      deleted_by_id: typeof notice.deleted_by_id === 'string' ? notice.deleted_by_id : '',
      deleted_by_name: typeof notice.deleted_by_name === 'string' ? notice.deleted_by_name : '',
      created_at: notice.created_at,
    })
  }
  return selected
}

export interface CellChange {
  recordId: string
  fieldId: string
  value: unknown
  isLocal: boolean
}

export type PendingTableWrite =
  | { op: 'setCellValue'; recordId: string; fieldId: string; value: unknown }
  | { op: 'batchSetCellValues'; changes: Array<{ recordId: string; fieldId: string; value: unknown }> }
  | { op: 'addRecord'; recordId: string; fieldValues: Record<string, unknown>; order: number; orderContext?: RecordOrderContext }
  | { op: 'deleteRecord'; recordId: string }

/**
 * O(1) 查找：优先使用调用方提供的 Set 索引，
 * 回退到 Y.Array 线性扫描（仅在 replay 等无 Set 场景）。
 */
export function rowOrderHas(arr: Y.Array<string>, id: string, indexSet?: Set<string>): boolean {
  if (indexSet) return indexSet.has(id)
  for (let i = 0; i < arr.length; i++) {
    if (arr.get(i) === id) return true
  }
  return false
}

export function replayPendingTableWrites(ydoc: Y.Doc, writes: PendingTableWrite[]): void {
  if (writes.length === 0) return
  const recordsMap = ydoc.getMap(YDOC_RECORDS)
  const rowOrderArr = ydoc.getArray<string>(YDOC_ROW_ORDER)
  const rowOrderMap = ydoc.getMap<string>(YDOC_ROW_ORDER_MAP)

  const sortedWrites = [...writes].sort((a, b) => {
    if (a.op === 'addRecord' && b.op === 'addRecord') return a.order - b.order
    return 0
  })

  // : pending replay 是系统同步，不得用 'local' 污染 UndoManager。
  // addRecord 自己先规划再原子写入；不要用一个外层 transaction 把规划
  // 和之前的写入混在一起，否则后续分配失败时会留下半条记录。
  for (const w of sortedWrites) {
    switch (w.op) {
      case 'setCellValue': {
        ydoc.transact(() => {
          let record = recordsMap.get(w.recordId) as Y.Map<unknown> | undefined
          if (!record) { record = new Y.Map<unknown>(); recordsMap.set(w.recordId, record) }
          record.set(w.fieldId, w.value)
        }, COLLAB_ORIGIN_MIRROR)
        break
      }
      case 'batchSetCellValues': {
        ydoc.transact(() => {
          for (const { recordId, fieldId, value } of w.changes) {
            let record = recordsMap.get(recordId) as Y.Map<unknown> | undefined
            if (!record) { record = new Y.Map<unknown>(); recordsMap.set(recordId, record) }
            record.set(fieldId, value)
          }
        }, COLLAB_ORIGIN_MIRROR)
        break
      }
      case 'addRecord': {
        insertTableRecordAtomically(ydoc, {
          recordId: w.recordId,
          fieldValues: w.fieldValues,
          legacyOrder: w.order,
          orderContext: w.orderContext,
          origin: COLLAB_ORIGIN_MIRROR,
        })
        break
      }
      case 'deleteRecord': {
        ydoc.transact(() => {
          recordsMap.delete(w.recordId)
          for (let i = 0; i < rowOrderArr.length; i++) {
            if (rowOrderArr.get(i) === w.recordId) { rowOrderArr.delete(i, 1); break }
          }
          rowOrderMap.delete(w.recordId)
        }, COLLAB_ORIGIN_MIRROR)
        break
      }
    }
  }
}

// ── Input / Output ──

export interface UseTableCollaborationInput {
  tableId: string | null
  enabled?: boolean
  getAuthToken: () => Promise<string>
  serverUrl: string
  user: { id: string; name: string; color: string; type?: string }
  collabDisabled?: boolean
  /** 内嵌表格宿主文档；服务端仍会校验文档权限、同组织关系和真实嵌入引用。 */
  parentDocumentId?: string | null
  /**
   * ：连接 Hocuspocus 前的统一 collab auth/preflight。
   * 返回 `rest_projection` / `field_visibility_restricted` 时不建 Provider。
   * 未注入或 preflight 网络失败时回退为直接取 JWT 建连（保留临时故障重试）。
   */
  preflightCollabAccess?: (
    tableId: string,
    parentDocumentId?: string | null,
  ) => Promise<TableCollabAccessDecision | null>
  /** 服务端请求刷新 token 时回调（如 share collab token TTL 过期） */
  onTokenRefreshRequired?: () => void
  /** 服务端持久化失败时回调（宿主可 toast / banner） */
  onStoreFailed?: (message: string) => void
  /** delete-wins：本用户的迟到修改因记录已删除而被舍弃。 */
  onDiscardedRecordUpdate?: (notice: DiscardedRecordUpdateNotice) => void
  /**
   * A4-L1: 自己 originId 跳过 —— 抑制窗口(ms)。
   * 收到 table.cells.pushed 且 origin_id 匹配时，
   * 在此窗口内跳过远端变更回调（避免"自己编辑闪烁"）。
   * collab-live 保证 stateless 事件先于 Y.Doc 更新到达（TCP 保序），
   * 此窗口仅需覆盖两者间的短延迟。默认 300ms。设 0 关闭。
   */
  originSuppressWindowMs?: number

}

export interface UseTableCollaborationResult {
  status: CollabStatus
  /** Provider 连接生命周期状态（STUCK_CONNECTING 供 UI 区分「挂起」与正常连接中） */
  connectionStatus: CollabConnectionStatus
  isOnline: boolean
  readOnly: boolean
  canEdit: boolean
  syncMode: CollabSyncMode
  syncModeReason?: CollabSyncModeReason
  isFallback: boolean
  isHttpFallback: boolean
  peers: CollabPeerState[]
  ydoc: Y.Doc | null

  getCellValue: (recordId: string, fieldId: string) => unknown
  setCellValue: (recordId: string, fieldId: string, value: unknown) => void
  /**
   * @param origin 默认 `local`（进 UndoManager）；REST 镜像请传 `mirror`
   */
  batchSetCellValues: (
    changes: Array<{ recordId: string; fieldId: string; value: unknown }>,
    origin?: string,
  ) => void
  /**
   * @param origin 默认 `local`；REST 镜像请传 `mirror`
   */
  addRecord: (
    recordId: string,
    fieldValues: Record<string, unknown>,
    order: number,
    orderContext?: RecordOrderContext,
    origin?: string,
  ) => void
  /**
   * @param origin 默认 `local`；REST 镜像请传 `mirror`
   */
  deleteRecord: (recordId: string, origin?: string) => void

  /**
   * 拖拽排序：仅更新被移动行的 position（Fractional Indexing）。
   * 利用 Y.Map LWW 语义，并发拖拽不同行时互不覆盖。
   *
   * @param movedIds    被拖拽的行 ID 列表（保持拖拽前的相对顺序）
   * @param targetIndex 目标位置索引（在排除 movedIds 后的列表中）
   */
  reorderRows: (movedIds: string[], targetIndex: number) => void

  recordsSnapshot: Map<string, Map<string, unknown>>
  rowOrder: string[]
  fieldsMeta: Array<{ id: string; id_hex: string; name: string; field_type: string; config: Record<string, unknown>; order: number }>
  viewsMeta: Array<Record<string, unknown>>
  viewOrder: string[]

  onRemoteChange: (callback: (changes: CellChange[]) => void) => () => void
  onRemoteDelete: (callback: (recordIds: string[]) => void) => () => void
  onStatelessEvent: (type: string, callback: (payload: unknown) => void) => () => void

  setAwareness: (key: string, value: unknown) => void
  broadcastCellFocus: (
    recordId: string | null,
    fieldId: string | null,
    surfaceId?: string,
  ) => void

  collabUndo: () => void
  collabRedo: () => void
  collabCanUndo: boolean
  collabCanRedo: boolean
  /**
   * 订阅 Yjs UndoManager 的 stack-item-added / stack-item-popped。
   * 供上层 UndoTimeline 只在 `added`+`undo` 时压 collab 标记（popped 由 handleUndo/Redo 驱动，避免双计）。
   */
  onUndoManagerEvent: (
    cb: (e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void,
  ) => () => void

  /**
   * 将最新的字段列表同步写入 Y.Doc metaMap['fields']（IS-05 修复）。
   *
   * 在 REST refetch 完成后调用，确保 fieldsMeta 与数据库保持一致。
   * 若 Y.Doc 未连接（isFallback / ydoc 为 null），则无操作。
   */
  updateFieldsMeta: (fields: UseTableCollaborationResult['fieldsMeta']) => void
  updateViewsMeta: (views: Array<Record<string, unknown>>) => void
  /**
   * 单视图写入：在 Y.Doc 事务内以 Y.Map 当前值为基线，仅覆盖目标视图。
   *
   * 相比 updateViewsMeta 的「整批重写」，此方法不依赖调用方持有的 React 快照，
   * 因此不会用落后的快照把他端刚写入的其它视图配置回退回旧值。
   * bumpConfigRev 为 true 时递增该视图的单调版本号 config_rev（供快照/合并回退防护）。
   * updater 返回 null 表示放弃写入。返回实际写入的视图对象（或 null）。
   */
  updateSingleViewMeta: (
    viewId: string,
    updater: (current: Record<string, unknown> | undefined) => Record<string, unknown> | null,
    options?: { bumpConfigRev?: boolean },
  ) => Record<string, unknown> | null
  /** 单视图删除：仅移除目标视图键，保留其余视图配置。返回是否删除成功。 */
  removeSingleViewMeta: (viewId: string) => boolean
  /** CC-016: 长时间离线后重连检测 */
  longOfflineDetected: boolean
  acknowledgeLongOffline: () => void
  /**
   * VS-008: 强制重连——销毁当前 Y.Doc + IndexedDB 并重新连接。
   * 用于 rollback/checkpoint-restore 后重新拉取服务端最新状态。
   */
  forceReconnect: () => void
  /**
   * 用户手动重连：重建底层 Provider，保留 Y.Doc（ 挂起兜底）。
   * CONNECTING 挂起 / STUCK / DISCONNECTED 态可用。
   */
  manualReconnect: () => void

  /**
   * 订阅高频 Awareness 变更（绕过 fingerprint 节流）。
   *
   * CC-014 优化后 peers state 不再随 cursor 变化更新，需要实时光标数据的消费者
   * 应通过此方法直接订阅 awareness 变化。返回取消订阅函数。
   */
  subscribeAwareness: (callback: (peers: CollabPeerState[]) => void) => () => void

  /** 服务端快照超过 5000 行时为 true，协同仅同步部分数据 */
  isTruncated: boolean
  /** 截断时，表格实际总行数 */
  truncatedTotalRecords: number
}

export function buildTableCollabSharedRuntimeKey(input: {
  serverUrl: string
  userId: string
  tableId: string
}): string {
  const normalizedServerUrl = input.serverUrl.trim().replace(/\/+$/, '')
  return [
    'tabdata',
    encodeURIComponent(normalizedServerUrl),
    encodeURIComponent(input.userId),
    encodeURIComponent(input.tableId),
  ].join(':')
}

export function useTableCollaboration(
  input: UseTableCollaborationInput
): UseTableCollaborationResult {
  const discardedUpdateCallbackRef = useRef(input.onDiscardedRecordUpdate)
  discardedUpdateCallbackRef.current = input.onDiscardedRecordUpdate
  const seenDiscardedUpdateEventsRef = useRef<Set<string>>(new Set())
  const seenDiscardedUpdateUserRef = useRef('')
  if (seenDiscardedUpdateUserRef.current !== input.user.id) {
    seenDiscardedUpdateUserRef.current = input.user.id
    seenDiscardedUpdateEventsRef.current = readPersistedDiscardedNoticeIds(input.user.id)
  }
  const [token, setToken] = useState<string>('')
  /** 业务终态降级原因；非 null 时禁止创建 Provider、禁止重试 */
  const [forcedLegacyReason, setForcedLegacyReason] = useState<CollabSyncModeReason | null>(null)

  const [recordsSnapshot, setRecordsSnapshot] = useState<Map<string, Map<string, unknown>>>(new Map())
  const [rowOrder, setRowOrder] = useState<string[]>([])
  const [fieldsMeta, setFieldsMeta] = useState<UseTableCollaborationResult['fieldsMeta']>([])
  const [viewsMeta, setViewsMeta] = useState<Array<Record<string, unknown>>>([])
  const [viewOrder, setViewOrder] = useState<string[]>([])
  const [isTruncated, setIsTruncated] = useState(false)
  const [truncatedTotalRecords, setTruncatedTotalRecords] = useState(0)

  const remoteChangeCallbacksRef = useRef<Set<(changes: CellChange[]) => void>>(new Set())
  const remoteDeleteCallbacksRef = useRef<Set<(recordIds: string[]) => void>>(new Set())

  // A4-L1: origin 抑制 — 自己发起的 Y.Doc 推送不触发远端变更回调
  const originSuppressUntilRef = useRef<number>(0)
  const originSuppressWindowMs = input.originSuppressWindowMs ?? 300

  // T-03: O(1) rowOrder membership index
  const rowOrderSetRef = useRef<Set<string>>(new Set())

  const enabled = !input.collabDisabled && (input.enabled !== false)
  const preflightCollabAccessRef = useRef(input.preflightCollabAccess)
  preflightCollabAccessRef.current = input.preflightCollabAccess
  const getAuthTokenRef = useRef(input.getAuthToken)
  getAuthTokenRef.current = input.getAuthToken

  useEffect(() => {
    if (!enabled || !input.tableId) {
      setToken('')
      setForcedLegacyReason(null)
      return
    }

    let cancelled = false
    const tableId = input.tableId

    const bootstrap = async () => {
      setToken('')
      setForcedLegacyReason(null)

      const preflight = preflightCollabAccessRef.current
      if (preflight) {
        try {
          const decision = await preflight(tableId, input.parentDocumentId)
          if (cancelled) return
          if (isRestProjectionAccess(decision)) {
            console.info('[useTableCollaboration] degraded to REST projection', {
              tableId,
              reason: decision?.reason ?? FIELD_VISIBILITY_RESTRICTED,
              visible_field_count: decision?.visible_field_count,
              total_field_count: decision?.total_field_count,
            })
            setForcedLegacyReason(resolveTableCollabDeniedReason(decision))
            setToken('')
            return
          }
        } catch (err) {
          // preflight 临时失败：放行建连，由运行时退避处理网络/服务故障
          console.warn('[useTableCollaboration] collab auth preflight failed, falling through', err)
        }
      }

      try {
        const nextToken = await getAuthTokenRef.current()
        if (!cancelled) setToken(nextToken)
      } catch {
        if (!cancelled) setToken('')
      }
    }

    void bootstrap()
    return () => {
      cancelled = true
    }
  }, [enabled, input.tableId, input.parentDocumentId])

  const collabOptions = useMemo<CollabProviderOptions | null>(() => {
    if (!enabled || !input.tableId || !token || forcedLegacyReason) return null
    return {
      sharedRuntimeKey: buildTableCollabSharedRuntimeKey({
        serverUrl: input.serverUrl,
        userId: input.user.id,
        tableId: input.tableId,
      }),
      serverUrl: input.serverUrl,
      documentName: `table:${input.tableId}`,
      token,
      user: {
        id: input.user.id,
        name: input.user.name,
        color: input.user.color,
        type: input.user.type ?? 'user',
      },
      // TabData 的权威数据来自 Django/View API。整表 Y.Doc 本地缓存会在重连时
      // 把旧 snapshot 当作客户端编辑同步回服务端，造成记录值回退/消失。
      enableIndexedDB: false,
      parameters: buildTableCollabConnectionParameters(input.parentDocumentId),
      onStoreFailed: input.onStoreFailed,
      onTokenRefreshRequired: input.onTokenRefreshRequired,
    }
  }, [enabled, input.tableId, input.parentDocumentId, token, forcedLegacyReason, input.serverUrl, input.user.id, input.user.name, input.user.color, input.user.type, input.onStoreFailed, input.onTokenRefreshRequired])

  const collab = useCollabProvider(collabOptions)

  const syncMode: CollabSyncMode = forcedLegacyReason ? 'legacy' : collab.syncMode
  const syncModeReason: CollabSyncModeReason | undefined = forcedLegacyReason ?? collab.syncModeReason
  const isFallback = syncMode === 'legacy'

  const isOnline = collab.status === CollabStatus.SYNCED || collab.status === CollabStatus.SYNCING
  const isHttpFallback = !isFallback && !isOnline
  const isHttpFallbackRef = useRef(isHttpFallback)
  isHttpFallbackRef.current = isHttpFallback

  const pendingWritesRef = useRef<PendingTableWrite[]>([])

  // ── 监听 Y.Doc 变更 ──
  useEffect(() => {
    if (!collab.ydoc || isFallback) return

    const ydoc = collab.ydoc
    const recordsMap = ydoc.getMap(YDOC_RECORDS)
    const rowOrderArr = ydoc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMapRef = ydoc.getMap<string>(YDOC_ROW_ORDER_MAP)
    const metaMap = ydoc.getMap(YDOC_META)
    const viewsMap = ydoc.getMap<Record<string, unknown>>(YDOC_VIEWS)
    const viewOrderMap = ydoc.getMap<number>(YDOC_VIEW_ORDER_MAP)

    const transactionWritesPosition = (
      transaction: Y.Transaction,
      recordId: string,
      record: Y.Map<unknown>,
    ): boolean => {
      const changed = transaction.changed as Map<unknown, Set<string | null>>
      if (changed.get(recordsMap)?.has(recordId)) return true
      return changed.get(record)?.has(RECORD_POSITION_FIELD) === true
    }

    const refreshSnapshot = () => {
      const snap = new Map<string, Map<string, unknown>>()
      recordsMap.forEach((value, recordId) => {
        if (value instanceof Y.Map) {
          const fields = new Map<string, unknown>()
          value.forEach((v, k) => { fields.set(k, v) })
          snap.set(recordId, fields)
        }
      })
      setRecordsSnapshot(snap)
    }

    // T-02: 增量 patch — 只更新事件中涉及的 recordId
    const patchSnapshot = (affectedIds: Set<string>, deletedIds: Set<string>) => {
      setRecordsSnapshot(prev => {
        const next = new Map(prev)
        for (const recordId of deletedIds) {
          next.delete(recordId)
        }
        for (const recordId of affectedIds) {
          const value = recordsMap.get(recordId)
          if (value instanceof Y.Map) {
            const fields = new Map<string, unknown>()
            value.forEach((v, k) => { fields.set(k, v) })
            next.set(recordId, fields)
          }
        }
        return next
      })
    }

    const refreshRowOrder = () => {
      // PositionId 是新客户端真相；NULL/历史记录只在内存中从 legacy
      // rowOrderMap / __order / rowOrder lift，不做读取时回填。排序输入以
      // recordsMap 为全集，坏掉或缺失的 order metadata 不会隐藏真实记录。
      const order = getEffectiveTableRecordOrder(ydoc)
      // T-03: sync Set index
      rowOrderSetRef.current = new Set(order)
      setRowOrder(order)
    }

    const notifyDiscardedRecordUpdates = () => {
      // 多窗口/重挂载先合并持久 seen 集合；TTL 内、此账号尚未见过的事件补发一次。
      for (const eventId of readPersistedDiscardedNoticeIds(input.user.id)) {
        seenDiscardedUpdateEventsRef.current.add(eventId)
      }
      const notices = selectUnseenDiscardedRecordUpdates(
        metaMap.get('discarded_record_updates'),
        input.user.id,
        seenDiscardedUpdateEventsRef.current,
      )
      if (notices.length > 0) {
        persistDiscardedNoticeIds(input.user.id, seenDiscardedUpdateEventsRef.current)
      }
      for (const notice of notices) {
        try { discardedUpdateCallbackRef.current?.(notice) } catch { /* ignore host feedback errors */ }
      }
    }

    const refreshMeta = (event?: Y.YMapEvent<unknown>) => {
      const fields = metaMap.get('fields')
      if (Array.isArray(fields)) {
        setFieldsMeta(orderFieldsMeta(fields as UseTableCollaborationResult['fieldsMeta']))
      }
      setIsTruncated(metaMap.get('is_truncated') === true)
      const totalRec = metaMap.get('total_records')
      setTruncatedTotalRecords(typeof totalRec === 'number' ? totalRec : 0)
      if (event?.keysChanged.has('discarded_record_updates')) {
        notifyDiscardedRecordUpdates()
      }
    }

    const refreshViews = () => {
      const views: Array<Record<string, unknown>> = []
      viewsMap.forEach((value, viewId) => {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          views.push({ ...value, id: String((value as { id?: unknown }).id ?? viewId) })
        }
      })
      const order = getOrderedIds(viewOrderMap)
      const orderIndex = new Map(order.map((id, index) => [id, index]))
      views.sort((a, b) => {
        const ai = orderIndex.get(String(a.id)) ?? Number.MAX_SAFE_INTEGER
        const bi = orderIndex.get(String(b.id)) ?? Number.MAX_SAFE_INTEGER
        if (ai !== bi) return ai - bi
        const ao = typeof a.order === 'number' ? a.order : Number(a.order ?? 0)
        const bo = typeof b.order === 'number' ? b.order : Number(b.order ?? 0)
        return ao - bo
      })
      const nextOrder = order.length > 0 ? order : views.map(view => String(view.id))
      // 值相等去重：Y.Doc view observer 可能在视图内容未变时频繁触发，
      // 每次都 set 新数组会让 viewsMeta 引用每帧变化 → 下游 updateViewForRuntime /
      // syncViewRuntime effect churn → Maximum update depth 死循环（ 回归）。
      // 仅在内容真正变化时才替换引用。
      setViewsMeta(prev =>
        prev.length === views.length && JSON.stringify(prev) === JSON.stringify(views)
          ? prev
          : views,
      )
      setViewOrder(prev =>
        prev.length === nextOrder.length && prev.every((id, i) => id === nextOrder[i])
          ? prev
          : nextOrder,
      )
    }

    const recordsObserver = (events: Y.YEvent<any>[], txn: Y.Transaction) => {
      try {
        const affectedIds = new Set<string>()
        const deletedIds = new Set<string>()
        const changes: CellChange[] = []
        const deletedRecordIds: string[] = []
        let needsFullRefresh = false
        let orderMetadataChanged = false
        const legacyOrderIntentIds = new Set<string>()

        for (const event of events) {
          if (event.target === recordsMap) {
            orderMetadataChanged = true
            ;(event as Y.YMapEvent<any>).changes.keys.forEach((change, recordId) => {
              if (change.action === 'add' || change.action === 'update') {
                affectedIds.add(recordId)
                if (txn.origin !== 'local') {
                  const recordMap = recordsMap.get(recordId) as Y.Map<unknown> | undefined
                  if (recordMap) {
                    recordMap.forEach((value, fieldId) => {
                      changes.push({ recordId, fieldId, value, isLocal: false })
                    })
                  }
                }
              } else if (change.action === 'delete') {
                deletedIds.add(recordId)
                if (txn.origin !== 'local') deletedRecordIds.push(recordId)
              }
            })
          } else if (event.target instanceof Y.Map && event.target !== metaMap) {
            const path = event.path
            if (path.length >= 1 && typeof path[0] === 'string') {
              const recordId = path[0] as string
              affectedIds.add(recordId)
              const changedKeys = (event as Y.YMapEvent<any>).changes.keys
              if (
                changedKeys.has(RECORD_POSITION_FIELD)
                || changedKeys.has(LEGACY_RECORD_ORDER_FIELD)
              ) orderMetadataChanged = true
              const positionChange = changedKeys.get(RECORD_POSITION_FIELD)
              const writesValidPosition = (
                positionChange != null
                && positionChange.action !== 'delete'
                && typeof (event.target as Y.Map<unknown>).get(RECORD_POSITION_FIELD) === 'string'
              )
              if (
                txn.origin !== COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE
                && changedKeys.has(LEGACY_RECORD_ORDER_FIELD)
                && !writesValidPosition
              ) legacyOrderIntentIds.add(recordId)
              if (txn.origin !== 'local') {
                changedKeys.forEach((change, fieldId) => {
                  if (change.action === 'add' || change.action === 'update') {
                    changes.push({ recordId, fieldId, value: (event.target as Y.Map<unknown>).get(fieldId), isLocal: false })
                  } else if (change.action === 'delete') {
                    changes.push({ recordId, fieldId, value: undefined, isLocal: false })
                  }
                })
              }
            } else {
              needsFullRefresh = true
            }
          } else {
            needsFullRefresh = true
          }
        }
        if (legacyOrderIntentIds.size > 0) {
          const plan = planLegacyTableRecordOrderReconcile(
            ydoc,
            [...legacyOrderIntentIds],
          )
          ydoc.transact(() => {
            applyTableRecordOrderPlan(ydoc, plan)
          }, COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE)
        }

        if (needsFullRefresh) {
          refreshSnapshot()
        } else if (affectedIds.size > 0 || deletedIds.size > 0) {
          patchSnapshot(affectedIds, deletedIds)
        }
        if (orderMetadataChanged) refreshRowOrder()

        if (txn.origin !== 'local') {
          const suppressed = originSuppressUntilRef.current > 0
            && Date.now() < originSuppressUntilRef.current
          if (!suppressed) {
            if (changes.length > 0) {
              remoteChangeCallbacksRef.current.forEach(cb => { try { cb(changes) } catch { /* ignore */ } })
            }
            if (deletedRecordIds.length > 0) {
              remoteDeleteCallbacksRef.current.forEach(cb => { try { cb(deletedRecordIds) } catch { /* ignore */ } })
            }
          }
        }
      } catch (error) {
        console.error('[TableCollab] recordsObserver error, attempting full refresh:', error)
        try {
          refreshSnapshot()
        } catch (refreshError) {
          console.error('[TableCollab] refreshSnapshot also failed:', refreshError)
        }
      }
    }

    const rowOrderMapObserver = (
      event: Y.YMapEvent<string>,
      transaction: Y.Transaction,
    ) => {
      if (transaction.origin !== COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE) {
        const legacyOnlyWriteIds = [...event.keysChanged].filter((recordId) => {
          const record = recordsMap.get(recordId)
          return record instanceof Y.Map
            && !transactionWritesPosition(transaction, recordId, record)
        })
        if (legacyOnlyWriteIds.length > 0) {
          const desiredOrder: string[] = []
          const seen = new Set<string>()
          for (const recordId of getOrderedIds(rowOrderMapRef)) {
            if (recordsMap.has(recordId) && !seen.has(recordId)) {
              desiredOrder.push(recordId)
              seen.add(recordId)
            }
          }
          for (const recordId of getEffectiveTableRecordOrder(ydoc)) {
            if (!seen.has(recordId)) desiredOrder.push(recordId)
          }
          const plan = planTableRecordOrderReconcile(
            ydoc,
            desiredOrder,
            legacyOnlyWriteIds,
          )
          ydoc.transact(() => {
            applyTableRecordOrderPlan(ydoc, plan)
          }, COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE)
        }
      }
      refreshRowOrder()
    }

    const rowOrderArrayObserver = (_event: Y.YArrayEvent<string>, transaction: Y.Transaction) => {
      // The new client always updates rowOrderMap in the same transaction.
      // An array-only write therefore comes from the oldest compatible client.
      if (
        transaction.origin !== COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE
        && !(transaction.changed as Map<unknown, Set<string | null>>).has(rowOrderMapRef)
      ) {
        const reconciledOrder: string[] = []
        const seen = new Set<string>()
        for (const recordId of rowOrderArr.toArray()) {
          if (recordsMap.has(recordId) && !seen.has(recordId)) {
            reconciledOrder.push(recordId)
            seen.add(recordId)
          }
        }
        for (const recordId of getEffectiveTableRecordOrder(ydoc)) {
          if (!seen.has(recordId)) reconciledOrder.push(recordId)
        }
        const plan = planTableRecordOrderReconcile(ydoc, reconciledOrder)
        if (plan.allocations.length > 0) {
          ydoc.transact(() => {
            applyTableRecordOrderPlan(ydoc, plan)
          }, COLLAB_ORIGIN_LEGACY_POSITION_RECONCILE)
        }
      }
      refreshRowOrder()
    }

    recordsMap.observeDeep(recordsObserver)
    rowOrderArr.observe(rowOrderArrayObserver)
    rowOrderMapRef.observe(rowOrderMapObserver)
    metaMap.observe(refreshMeta)
    viewsMap.observe(refreshViews)
    viewOrderMap.observe(refreshViews)

    refreshSnapshot()
    refreshRowOrder()
    // observer 注册后读取一次槽位：覆盖 ACK 先于本次挂载到达的短暂断线/切表场景。
    notifyDiscardedRecordUpdates()
    refreshMeta()
    refreshViews()

    return () => {
      recordsMap.unobserveDeep(recordsObserver)
      rowOrderArr.unobserve(rowOrderArrayObserver)
      rowOrderMapRef.unobserve(rowOrderMapObserver)
      metaMap.unobserve(refreshMeta)
      viewsMap.unobserve(refreshViews)
      viewOrderMap.unobserve(refreshViews)
    }
  }, [collab.ydoc, isFallback, input.user.id])

  // ── A4-L1: 监听 table.cells.pushed 设置 origin 抑制窗口 ──
  useEffect(() => {
    if (!collab.provider || isFallback) return
    const userId = input.user.id

    const unsub = collab.provider.onStatelessEvent(
      'table.cells.pushed',
      (event: { type: string; payload: unknown }) => {
        const p = event.payload as Record<string, unknown> | undefined
        if (!p || typeof p.origin_id !== 'string') return
        const originId = p.origin_id
        // A4-L1: 用户自己编辑 → suppress
        if (userId && originId === userId && originSuppressWindowMs > 0) {
          originSuppressUntilRef.current = Date.now() + originSuppressWindowMs
        }
      },
    )
    return unsub
  }, [collab.provider, isFallback, input.user.id, originSuppressWindowMs])

  // ── Y.Doc 操作方法 ──

  const getCellValue = useCallback((recordId: string, fieldId: string): unknown => {
    if (!collab.ydoc) return undefined
    const record = collab.ydoc.getMap(YDOC_RECORDS).get(recordId) as Y.Map<unknown> | undefined
    return record?.get(fieldId)
  }, [collab.ydoc])

  const setCellValue = useCallback((recordId: string, fieldId: string, value: unknown) => {
    if (!collab.canEdit) return
    if (isHttpFallbackRef.current) {
      pendingWritesRef.current.push({ op: 'setCellValue', recordId, fieldId, value })
      return
    }
    if (!collab.ydoc) return
    const recordsMap = collab.ydoc.getMap(YDOC_RECORDS)
    let record = recordsMap.get(recordId) as Y.Map<unknown> | undefined
    collab.ydoc.transact(() => {
      if (!record) { record = new Y.Map<unknown>(); recordsMap.set(recordId, record) }
      record.set(fieldId, value)
    }, COLLAB_ORIGIN_LOCAL)
  }, [collab.canEdit, collab.ydoc])

  const batchSetCellValues = useCallback(
    (
      changes: Array<{ recordId: string; fieldId: string; value: unknown }>,
      origin: string = COLLAB_ORIGIN_LOCAL,
    ) => {
      if (!collab.canEdit) return
      if (isHttpFallbackRef.current) {
        // HTTP fallback 不经 Yjs UndoManager；pending 重放时用 mirror origin
        pendingWritesRef.current.push({ op: 'batchSetCellValues', changes })
        return
      }
      if (!collab.ydoc) return
      const recordsMap = collab.ydoc.getMap(YDOC_RECORDS)
      collab.ydoc.transact(() => {
        for (const { recordId, fieldId, value } of changes) {
          let record = recordsMap.get(recordId) as Y.Map<unknown> | undefined
          if (!record) { record = new Y.Map<unknown>(); recordsMap.set(recordId, record) }
          record.set(fieldId, value)
        }
      }, origin)
    },
    [collab.canEdit, collab.ydoc]
  )

  const addRecord = useCallback(
    (
      recordId: string,
      fieldValues: Record<string, unknown>,
      order: number,
      orderContext?: RecordOrderContext,
      origin: string = COLLAB_ORIGIN_LOCAL,
    ) => {
      if (!collab.canEdit) return
      if (isHttpFallbackRef.current) {
        pendingWritesRef.current.push({ op: 'addRecord', recordId, fieldValues, order, orderContext })
        return
      }
      if (!collab.ydoc) return
      insertTableRecordAtomically(collab.ydoc, {
        recordId,
        fieldValues,
        legacyOrder: order,
        orderContext,
        origin,
      })
    },
    [collab.canEdit, collab.ydoc]
  )

  const deleteRecord = useCallback(
    (recordId: string, origin: string = COLLAB_ORIGIN_LOCAL) => {
      if (!collab.canEdit) return
      if (isHttpFallbackRef.current) {
        pendingWritesRef.current.push({ op: 'deleteRecord', recordId })
        return
      }
      if (!collab.ydoc) return
      const recordsMap = collab.ydoc.getMap(YDOC_RECORDS)
      const rowOrderArr = collab.ydoc.getArray<string>(YDOC_ROW_ORDER)
      const rowOrderMap = collab.ydoc.getMap<string>(YDOC_ROW_ORDER_MAP)
      collab.ydoc.transact(() => {
        recordsMap.delete(recordId)
        // T-03: O(1) check before linear scan for index
        if (rowOrderSetRef.current.has(recordId)) {
          for (let i = 0; i < rowOrderArr.length; i++) {
            if (rowOrderArr.get(i) === recordId) { rowOrderArr.delete(i, 1); break }
          }
          rowOrderSetRef.current.delete(recordId)
        }
        // 双写 Y.Map：无论 Set 是否命中都尝试删除（防止 Set 与 Map 不同步）
        rowOrderMap.delete(recordId)
      }, origin)
    },
    [collab.canEdit, collab.ydoc]
  )

  const reorderRows = useCallback(
    (movedIds: string[], targetIndex: number) => {
      if (!collab.canEdit) return
      if (!collab.ydoc || movedIds.length === 0) return
      reorderTableRecordsAtomically(
        collab.ydoc,
        movedIds,
        targetIndex,
        COLLAB_ORIGIN_LOCAL,
      )
    },
    [collab.canEdit, collab.ydoc]
  )

  // IS-05：REST refetch 完成后主动同步最新 fields 到 Y.Doc metaMap，防止 fieldsMeta 过期
  const updateFieldsMeta = useCallback(
    (fields: UseTableCollaborationResult['fieldsMeta']) => {
      if (!collab.canEdit) return
      if (!collab.ydoc || isFallback) return
      const metaMap = collab.ydoc.getMap(YDOC_META)
      const orderedFields = orderFieldsMeta(fields)
      collab.ydoc.transact(() => { metaMap.set('fields', orderedFields) }, 'schema-sync')
    },
    [collab.canEdit, collab.ydoc, isFallback]
  )

  const updateViewsMeta = useCallback(
    (views: Array<Record<string, unknown>>) => {
      if (!collab.canEdit) return
      if (!collab.ydoc || isFallback) return
      const viewsMap = collab.ydoc.getMap<Record<string, unknown>>(YDOC_VIEWS)
      const viewOrderMap = collab.ydoc.getMap<number>(YDOC_VIEW_ORDER_MAP)
      collab.ydoc.transact(() => {
        const incomingIds = new Set<string>()
        views.forEach((view, index) => {
          const id = typeof view.id === 'string' ? view.id : ''
          if (!id) return
          incomingIds.add(id)
          viewsMap.set(id, view)
          const order = typeof view.order === 'number' ? view.order : index
          viewOrderMap.set(id, order)
        })
        Array.from(viewsMap.keys()).forEach(id => {
          if (!incomingIds.has(id)) viewsMap.delete(id)
        })
        Array.from(viewOrderMap.keys()).forEach(id => {
          if (!incomingIds.has(id)) viewOrderMap.delete(id)
        })
      }, 'view-sync')
    },
    [collab.canEdit, collab.ydoc, isFallback]
  )

  const updateSingleViewMeta = useCallback(
    (
      viewId: string,
      updater: (current: Record<string, unknown> | undefined) => Record<string, unknown> | null,
      options?: { bumpConfigRev?: boolean },
    ): Record<string, unknown> | null => {
      if (!collab.canEdit) return null
      if (!collab.ydoc || isFallback) return null
      const viewsMap = collab.ydoc.getMap<Record<string, unknown>>(YDOC_VIEWS)
      const viewOrderMap = collab.ydoc.getMap<number>(YDOC_VIEW_ORDER_MAP)
      let written: Record<string, unknown> | null = null
      collab.ydoc.transact(() => {
        // 事务内从 Y.Map 读取该视图的当前值作为基线，避免 React state 快照落后
        // 导致把他端刚写入的视图配置覆盖回旧值。
        const current = viewsMap.get(viewId)
        const next = updater(current ? { ...current } : undefined)
        if (!next) return
        const nextView: Record<string, unknown> = { ...next, id: viewId }
        if (options?.bumpConfigRev) {
          const baseRev = typeof current?.config_rev === 'number' ? current.config_rev : 0
          nextView.config_rev = baseRev + 1
        }
        viewsMap.set(viewId, nextView)
        if (typeof nextView.order === 'number') {
          viewOrderMap.set(viewId, nextView.order)
        } else if (!viewOrderMap.has(viewId)) {
          viewOrderMap.set(viewId, viewsMap.size)
        }
        written = nextView
      }, 'view-sync')
      return written
    },
    [collab.canEdit, collab.ydoc, isFallback]
  )

  const removeSingleViewMeta = useCallback(
    (viewId: string): boolean => {
      if (!collab.canEdit) return false
      if (!collab.ydoc || isFallback) return false
      const viewsMap = collab.ydoc.getMap<Record<string, unknown>>(YDOC_VIEWS)
      const viewOrderMap = collab.ydoc.getMap<number>(YDOC_VIEW_ORDER_MAP)
      if (!viewsMap.has(viewId)) return false
      // 不允许删到空：至少保留一个视图，避免协作端整表无视图。
      if (viewsMap.size <= 1) return false
      collab.ydoc.transact(() => {
        viewsMap.delete(viewId)
        viewOrderMap.delete(viewId)
      }, 'view-sync')
      return true
    },
    [collab.canEdit, collab.ydoc, isFallback]
  )

  // ── 回调注册 ──

  const onRemoteChange = useCallback(
    (callback: (changes: CellChange[]) => void) => {
      remoteChangeCallbacksRef.current.add(callback)
      return () => { remoteChangeCallbacksRef.current.delete(callback) }
    },
    []
  )

  const onRemoteDelete = useCallback(
    (callback: (recordIds: string[]) => void) => {
      remoteDeleteCallbacksRef.current.add(callback)
      return () => { remoteDeleteCallbacksRef.current.delete(callback) }
    },
    []
  )

  const onStatelessEvent = useCallback(
    (type: string, callback: (payload: unknown) => void) => {
      if (!collab.provider) return () => { /* no-op */ }
      return collab.provider.onStatelessEvent(type, (event: { type: string; payload: unknown }) => {
        callback(event.payload)
      })
    },
    [collab.provider]
  )

  // ── Presence ──

  const setAwareness = useCallback(
    (key: string, value: unknown) => { collab.setAwareness(key, value) },
    [collab.setAwareness]
  )

  const cellFocusTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    return () => {
      if (cellFocusTimerRef.current) {
        clearTimeout(cellFocusTimerRef.current)
        cellFocusTimerRef.current = null
      }
    }
  }, [])

  const broadcastCellFocus = useCallback(
    (recordId: string | null, fieldId: string | null, surfaceId?: string) => {
      if (cellFocusTimerRef.current) {
        clearTimeout(cellFocusTimerRef.current)
      }
      cellFocusTimerRef.current = setTimeout(() => {
        collab.setAwareness('cursor', recordId && fieldId ? {
          module: 'tabdata' as const,
          recordId,
          fieldId,
          surfaceId,
          timestamp: Date.now(),
        } : null)
      }, 50)
    },
    [collab.setAwareness]
  )

  const subscribeAwareness = useCallback(
    (callback: (peers: CollabPeerState[]) => void): (() => void) => {
      if (!collab.provider) return () => { /* no-op */ }
      return collab.provider.subscribeAwareness(callback)
    },
    [collab.provider]
  )

  // ── UndoManager ──
  // 必须在 forceReconnect 之前声明：重连前要先 clear，避免残留栈指向已销毁结构
  const undoManagerRef = useRef<Y.UndoManager | null>(null)
  const [undoRedoVersion, setUndoRedoVersion] = useState(0)

  const clearCollabUndoStacks = useCallback(() => {
    const um = undoManagerRef.current
    if (!um) return
    um.clear()
    setUndoRedoVersion(v => v + 1)
  }, [])

  // VS-008: forceReconnect for rollback/checkpoint-restore scenarios
  const forceReconnect = useCallback(() => {
    clearCollabUndoStacks()
    collab.provider?.forceReconnect()
  }, [collab.provider, clearCollabUndoStacks])

  // VS-008: 监听 checkpoint/rollback 全局事件，自动触发 forceReconnect
  useEffect(() => {
    if (!input.tableId || !collab.provider) return

    const handler = (e: Event) => {
      const detail = (e as CustomEvent).detail
      if (!detail?.resourceTypes || detail.resourceTypes.includes('table')) {
        clearCollabUndoStacks()
        collab.provider?.forceReconnect()
      }
    }
    window.addEventListener('tabtin:collab-resource-restored', handler)
    return () => window.removeEventListener('tabtin:collab-resource-restored', handler)
  }, [input.tableId, collab.provider, clearCollabUndoStacks])

  // ── Replay pending writes on reconnect ──
  useOfflineReplay({
    isOnline: isOnline && !isFallback && collab.canEdit,
    ydoc: collab.ydoc,
    pendingRef: pendingWritesRef,
    replay: replayPendingTableWrites,
  })

  useEffect(() => {
    if (!collab.ydoc || isFallback || !collab.canEdit) {
      undoManagerRef.current = null
      return
    }
    const lease = acquireTableUndoRuntime(collab.ydoc)
    undoManagerRef.current = lease.undoManager
    return () => {
      lease.release()
      if (undoManagerRef.current === lease.undoManager) {
        undoManagerRef.current = null
      }
    }
  }, [collab.ydoc, isFallback, collab.canEdit])

  // UndoManager 事件订阅者（会话级时间线用）；与 version bump 共用同一对 Yjs 监听
  const undoManagerListenersRef = useRef(
    new Set<(e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void>(),
  )

  useEffect(() => {
    const um = undoManagerRef.current
    if (!um) return
    const emit = (
      kind: 'added' | 'popped',
      event: { type: 'undo' | 'redo' },
    ) => {
      setUndoRedoVersion(v => v + 1)
      const changedStack = event?.type === 'redo' ? 'redo' : 'undo'
      const payload = { kind, changedStack } as const
      for (const listener of undoManagerListenersRef.current) {
        listener(payload)
      }
    }
    const onAdded = (event: { type: 'undo' | 'redo' }) => emit('added', event)
    const onPopped = (event: { type: 'undo' | 'redo' }) => emit('popped', event)
    um.on('stack-item-added', onAdded)
    um.on('stack-item-popped', onPopped)
    return () => {
      um.off('stack-item-added', onAdded)
      um.off('stack-item-popped', onPopped)
    }
  }, [collab.ydoc, isFallback])

  const onUndoManagerEvent = useCallback(
    (cb: (e: { kind: 'added' | 'popped'; changedStack: 'undo' | 'redo' }) => void) => {
      undoManagerListenersRef.current.add(cb)
      return () => {
        undoManagerListenersRef.current.delete(cb)
      }
    },
    [],
  )

  const collabUndo = useCallback(() => { if (collab.canEdit) undoManagerRef.current?.undo() }, [collab.canEdit])
  const collabRedo = useCallback(() => { if (collab.canEdit) undoManagerRef.current?.redo() }, [collab.canEdit])
  const collabCanUndo = collab.canEdit && undoManagerRef.current ? undoManagerRef.current.undoStack.length > 0 : false
  const collabCanRedo = collab.canEdit && undoManagerRef.current ? undoManagerRef.current.redoStack.length > 0 : false
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const _undoRedoTrigger = undoRedoVersion

  return {
    status: collab.status,
    connectionStatus: collab.connectionStatus,
    isOnline,
    readOnly: collab.readOnly,
    canEdit: collab.canEdit,
    syncMode,
    syncModeReason,
    isFallback,
    isHttpFallback,
    peers: collab.peers,
    ydoc: isFallback ? null : collab.ydoc,
    getCellValue, setCellValue, batchSetCellValues, addRecord, deleteRecord, reorderRows,
    recordsSnapshot, rowOrder, fieldsMeta, viewsMeta, viewOrder,
    onRemoteChange, onRemoteDelete, onStatelessEvent,
    setAwareness, broadcastCellFocus,
    collabUndo, collabRedo, collabCanUndo, collabCanRedo,
    onUndoManagerEvent,
    updateFieldsMeta,
    updateViewsMeta,
    updateSingleViewMeta,
    removeSingleViewMeta,
    longOfflineDetected: collab.longOfflineDetected,
    acknowledgeLongOffline: collab.acknowledgeLongOffline,
    forceReconnect,
    manualReconnect: collab.manualReconnect,
    subscribeAwareness,
    isTruncated,
    truncatedTotalRecords,
  }
}
