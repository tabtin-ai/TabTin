/**
 * useDataGridCollabBridge — DataGrid 协作桥接层
 *
 * 在 Y.js 协作模式和现有 HTTP 模式之间做桥接。
 * 纯 React Hook，无 Electron 特有依赖。
 */

import { useCallback, useEffect, useMemo, useRef } from 'react'
import * as Y from 'yjs'
import type { Field, CreateRecordRequest, UpdateRecordRequest, TableRecord } from '@tabtin/table-core'
import {
  clearCreateLifecycles,
  markCreateDeleting,
  markCreatePending,
  markCreatesPersisted,
  partitionDeleteRecordIds,
  promoteStalePendingCreates,
  type CollabCreateLifecycleEntry,
  type CollabCreateLifecycleState,
  type PartitionDeleteRecordIdsResult,
} from './collabRecordLifecycle'
import {
  useTableCollaboration,
  type UseTableCollaborationInput,
  type UseTableCollaborationResult,
} from './useTableCollaboration'

/** 超过该窗口仍无 persist 回写时，按已落库处理，避免删除长期误折叠。 */
const PENDING_CREATE_STALE_MS = 8_000

/**
 * 安全的深比较，避免 JSON.stringify 的 undefined 丢失、NaN→null、循环引用异常。
 */
function safeDeepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  if (a == null || b == null) return a == b
  if (typeof a !== typeof b) return false

  if (typeof a === 'number' && typeof b === 'number' && isNaN(a) && isNaN(b)) return true

  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false
    return a.every((v, i) => safeDeepEqual(v, b[i]))
  }

  if (typeof a === 'object' && typeof b === 'object') {
    const keysA = Object.keys(a as object)
    const keysB = Object.keys(b as object)
    if (keysA.length !== keysB.length) return false
    return keysA.every(k => safeDeepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  }

  return false
}

export interface UseDataGridCollabBridgeInput {
  selectedTableId: string | null
  fields: Field[]
  updateRecord: (recordId: string, data: UpdateRecordRequest) => Promise<TableRecord | null>
  createRecord: (data: CreateRecordRequest, options?: { skipLocalInsert?: boolean }) => Promise<TableRecord | null>
  mergeIncrementalRecords: (records: TableRecord[], newVersion: number) => void
  mergeIncrementalViewRecords?: (records: TableRecord[], newVersion: number) => void
  removeRecordsByIds: (recordIds: string[], newVersion?: number) => void
  onFieldChange?: (info: { action: string; field_ids?: string[] }) => void
  onViewChange?: () => void
  /** 断线重连时检测到冲突、部分离线编辑被丢弃时的回调 */
  onConflictDiscarded?: (discardedCount: number, replayedCount: number) => void
  /** 编辑了已被删除的字段时的回调（字段 ID 在本地映射中不存在） */
  onStaleFieldEdit?: (staleFieldIds: string[]) => void
  collabInput: Omit<UseTableCollaborationInput, 'tableId' | 'enabled'>
}

export interface UseDataGridCollabBridgeResult {
  updateRecord: (recordId: string, data: UpdateRecordRequest) => Promise<TableRecord | null>
  createRecord: (data: CreateRecordRequest, options?: { skipLocalInsert?: boolean }) => Promise<TableRecord | null>
  collab: UseTableCollaborationResult
  isConnected: boolean
  /** 查询协作新建生命周期（无记录时 undefined） */
  getCreateLifecycle: (recordId: string) => CollabCreateLifecycleState | undefined
  /**
   * 取消尚未服务端确认的协作新建：从 Y.Doc 移除并清理生命周期。
   * 返回实际折叠取消的 ID（调用方应同步清 overlay / 本地投影，且不得对这些 ID 发 REST bulk-delete）。
   */
  cancelPendingCreates: (recordIds: readonly string[]) => string[]
  /** 将指定新建标记为已落库（随后删除走权威 REST） */
  markCreatesPersisted: (recordIds: readonly string[]) => void
  /** 按生命周期拆分删除目标（pending 折叠 / 其余 REST） */
  partitionDeleteTargets: (recordIds: readonly string[]) => PartitionDeleteRecordIdsResult
}

/**
 * Y.Doc 只在通道明确可写且已就绪时承担写入；其余状态交给 REST。
 * REST 仍执行服务端权限校验，因此协作 token 缺失或权限状态短暂不同步时不会
 * 静默吞掉用户操作，也不会把客户端的 fallback 当作授权依据。
 */
export function resolveDataGridRecordWriteMode(input: {
  canEdit: boolean
  isFallback: boolean
  isOnline: boolean
  hasYdoc: boolean
}): 'collab' | 'rest' {
  return input.canEdit && !input.isFallback && input.isOnline && input.hasYdoc
    ? 'collab'
    : 'rest'
}

/**
 * 把按「字段 UUID」给出的 cell patch 拆成存储约定的两个 key 空间，与后端
 * ``serialize_record`` 的 data/fields 双表征契约对齐：
 *   - ``data``   按「字段名」——兼容旧协议，编辑对话框读 ``record.data[字段名]``。
 *   - ``fields`` 按「字段 UUID」——网格 cellRenderer/valueGetter 读 ``record.fields[fieldId]``。
 *
 * 协作链路此前把 UUID-keyed patch 原样塞进 ``data``（见历史 bug：行内编辑后重开
 * 对话框拿到陈旧值——网格读 ``fields[id]`` 是新的，对话框读 ``data[name]`` 仍是旧的，
 * 因为新值落在了 ``data`` 的 UUID key 上、name key 没刷新）。本函数确保两个 key
 * 空间都按各自约定写入。找不到字段名的 key（字段已删等）在 ``data`` 侧回退用 UUID 兜底，
 * 避免静默丢值。
 */
export function splitCellPatchKeySpaces(
  patchByFieldId: Record<string, unknown>,
  fieldIdToName: ReadonlyMap<string, string>,
): { data: Record<string, unknown>; fields: Record<string, unknown> } {
  const data: Record<string, unknown> = {}
  const fields: Record<string, unknown> = {}
  for (const [fieldId, value] of Object.entries(patchByFieldId)) {
    fields[fieldId] = value
    data[fieldIdToName.get(fieldId) ?? fieldId] = value
  }
  return { data, fields }
}

const isNonEmptyRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null &&
  typeof value === 'object' &&
  !Array.isArray(value) &&
  Object.keys(value as Record<string, unknown>).length > 0

export function resolveFieldPayload(
  data: { fields?: Record<string, unknown>; data?: Record<string, unknown> },
): Record<string, unknown> {
  if (isNonEmptyRecord(data.fields)) return data.fields
  if (isNonEmptyRecord(data.data)) return data.data
  return {}
}

/**
 * 将远端 Y.Doc cell 变更（hex 字段 ID）转换为 REST record 格式。
 * 已删除字段（hex 不在 fieldHexToId 中）的变更会被跳过，防止 id_hex 污染 REST records。
 *
 * 输出的每条 record 同时带 ``data``（字段名 key）与 ``fields``（字段 UUID key），
 * 见 {@link splitCellPatchKeySpaces}——这样远端改动既能刷新网格（读 fields[id]）
 * 又能刷新编辑对话框（读 data[name]）。
 */
export function mapRemoteChangesToRecords(
  changes: ReadonlyArray<{ recordId: string; fieldId: string; value: unknown }>,
  fieldHexToId: ReadonlyMap<string, string>,
  fieldIdToName: ReadonlyMap<string, string>,
): {
  records: Array<{ id: string; data: Record<string, unknown>; fields: Record<string, unknown>; version: 0 }>
  skippedOrphans: number
  skippedOrphanFields: Array<{ recordId: string; fieldId: string; valueType: string }>
} {
  const recordChanges = new Map<string, Record<string, unknown>>()
  const skippedOrphanFields: Array<{ recordId: string; fieldId: string; valueType: string }> = []

  for (const { recordId, fieldId, value } of changes) {
    if (fieldId.startsWith('__')) {
      continue
    }
    const fid = fieldHexToId.get(fieldId)
    if (!fid) {
      skippedOrphanFields.push({
        recordId,
        fieldId,
        valueType: Array.isArray(value) ? 'array' : typeof value,
      })
      continue
    }
    if (!recordChanges.has(recordId)) recordChanges.set(recordId, {})
    recordChanges.get(recordId)![fid] = value
  }

  const records = Array.from(recordChanges.entries()).map(([id, patchByFieldId]) => {
    const { data, fields } = splitCellPatchKeySpaces(patchByFieldId, fieldIdToName)
    return { id, data, fields, version: 0 as const }
  })
  return { records, skippedOrphans: skippedOrphanFields.length, skippedOrphanFields }
}

/**
 * 从字段列表构建协作所需的三张映射（fieldId↔hex、fieldId→name）。
 *
 * hex 是 fieldId 去掉连字符的纯派生值（Y.Doc 单元格键空间）。抽成纯函数以便
 * 单测，并让映射能在渲染期同步构建（见调用点），避免 useEffect 提交后窗口。
 */
export function buildFieldMaps(
  fields: ReadonlyArray<Pick<Field, 'id' | 'name'>>,
): {
  idToHex: Map<string, string>
  hexToId: Map<string, string>
  idToName: Map<string, string>
} {
  const idToHex = new Map<string, string>()
  const hexToId = new Map<string, string>()
  const idToName = new Map<string, string>()
  for (const field of fields) {
    const hex = field.id.replace(/-/g, '')
    idToHex.set(field.id, hex)
    hexToId.set(hex, field.id)
    idToName.set(field.id, field.name)
  }
  return { idToHex, hexToId, idToName }
}

export function mapFieldPayloadToHexValues(
  payload: Record<string, unknown>,
  fieldIdToHex: ReadonlyMap<string, string>,
): { fieldValues: Record<string, unknown>; staleFields: string[] } {
  const fieldValues: Record<string, unknown> = {}
  const staleFields: string[] = []

  for (const [fieldId, value] of Object.entries(payload)) {
    const hex = fieldIdToHex.get(fieldId)
    if (hex) {
      fieldValues[hex] = value
    } else {
      staleFields.push(fieldId)
    }
  }

  return { fieldValues, staleFields }
}

export function resolveCreatePayloadWithDefaults(
  payload: Record<string, unknown>,
  fields: ReadonlyArray<Pick<Field, 'id' | 'field_type' | 'default_value' | 'options' | 'isMultipleCellValue'>>,
  actorId?: string,
  now: Date = new Date(),
): Record<string, unknown> {
  const next = { ...payload }
  const nowIso = now.toISOString()

  for (const field of fields) {
    if (Object.prototype.hasOwnProperty.call(next, field.id)) continue
    const spec = field.default_value
    if (!spec || typeof spec !== 'object') continue

    if (spec.mode === 'literal') {
      next[field.id] = spec.value
      continue
    }

    if (spec.mode === 'created_time' || spec.mode === 'last_modified_time') {
      const timeFormat = field.options?.formatting?.time
      const dateOnly = field.field_type === 'date' && (
        typeof timeFormat !== 'string' || timeFormat === 'None'
      )
      next[field.id] = dateOnly
        ? formatDateOnlyInTimeZone(now, field.options?.formatting?.timeZone)
        : nowIso
      continue
    }

    if (spec.mode === 'creator' && actorId) {
      next[field.id] = field.isMultipleCellValue === true || field.options?.multiple === true
        ? [actorId]
        : actorId
    }
  }

  return next
}

function formatDateOnlyInTimeZone(date: Date, timeZone?: string): string {
  if (timeZone) {
    try {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).formatToParts(date)
      const values = Object.fromEntries(parts.map(part => [part.type, part.value]))
      if (values.year && values.month && values.day) {
        return `${values.year}-${values.month}-${values.day}`
      }
    } catch {
      // Invalid legacy timezone: fall through to the user's local calendar day.
    }
  }

  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function useDataGridCollabBridge(
  input: UseDataGridCollabBridgeInput
): UseDataGridCollabBridgeResult {
  const collab = useTableCollaboration({
    tableId: input.selectedTableId,
    ...input.collabInput,
  })

  const fieldIdToHexRef = useRef<Map<string, string>>(new Map())
  const fieldHexToIdRef = useRef<Map<string, string>>(new Map())
  const fieldIdToNameRef = useRef<Map<string, string>>(new Map())

  const mergeRecordsRef = useRef(input.mergeIncrementalRecords)
  mergeRecordsRef.current = input.mergeIncrementalRecords
  const mergeViewRecordsRef = useRef(input.mergeIncrementalViewRecords)
  mergeViewRecordsRef.current = input.mergeIncrementalViewRecords
  const removeRecordsRef = useRef(input.removeRecordsByIds)
  removeRecordsRef.current = input.removeRecordsByIds

  // 渲染期同步重建字段映射，而非 useEffect（提交后才落地）。
  // 首次开层级插入子记录时，父链字段刚进 input.fields 但映射尚未就绪，会被
  // wrappedCreateRecord 误判为 stale field → 触发「字段已被删除，编辑已跳过」误报。
  // 同步构建消除这一「fields 已更新但映射滞后」的提交后窗口，是竞态的确定性根治。
  const fieldMaps = useMemo(() => buildFieldMaps(input.fields), [input.fields])
  fieldIdToHexRef.current = fieldMaps.idToHex
  fieldHexToIdRef.current = fieldMaps.hexToId
  fieldIdToNameRef.current = fieldMaps.idToName

  useEffect(() => {
    if (collab.isFallback) return

    const unsub = collab.onRemoteChange((changes) => {
      const { records, skippedOrphans, skippedOrphanFields } = mapRemoteChangesToRecords(
        changes,
        fieldHexToIdRef.current,
        fieldIdToNameRef.current,
      )

      if (skippedOrphans > 0 && process.env.NODE_ENV !== 'production') {
        console.warn(
          `[useDataGridCollabBridge] Skipped ${skippedOrphans} orphan field hex value(s) — field(s) may have been deleted`,
          {
            skipped: skippedOrphanFields.slice(0, 10),
            knownFieldCount: fieldHexToIdRef.current.size,
            knownFieldHexes: Array.from(fieldHexToIdRef.current.keys()).slice(0, 20),
            incomingChangeCount: changes.length,
          },
        )
      }

      if (records.length > 0) {
        // persist 回写系统时间等 cell 会走 remote change；据此把对应新建升为 persisted。
        markCreatesPersisted(
          createLifecycleRef.current,
          records.map((record) => record.id),
        )
        mergeRecordsRef.current(records as TableRecord[], 0)
        mergeViewRecordsRef.current?.(records as TableRecord[], 0)
      }
    })

    const unsubDel = collab.onRemoteDelete((deletedIds) => {
      if (deletedIds.length > 0) {
        clearCreateLifecycles(createLifecycleRef.current, deletedIds)
        removeRecordsRef.current(deletedIds)
      }
    })

    return () => { unsub(); unsubDel() }
  }, [collab.isFallback, collab.onRemoteChange, collab.onRemoteDelete])

  useEffect(() => {
    if (collab.isFallback || !collab.onStatelessEvent) return
    const unsubField = collab.onStatelessEvent('table.schema.changed', (payload) => {
      const p = payload as Record<string, unknown>
      input.onFieldChange?.({ action: (p.action as string) ?? '', field_ids: p.field_ids as string[] | undefined })
    })
    const unsubView = collab.onStatelessEvent('table.view.changed', () => { input.onViewChange?.() })
    return () => { unsubField(); unsubView() }
  }, [collab.isFallback, collab.onStatelessEvent])

  const isCollabDisconnected = !collab.isFallback && !collab.isOnline

  const pendingHttpWritesRef = useRef<Map<string, { recordId: string; fieldHex: string; value: unknown; snapshotValue: unknown }>>(new Map())
  const createLifecycleRef = useRef<Map<string, CollabCreateLifecycleEntry>>(new Map())
  const prevOnlineRef = useRef(collab.isOnline)

  const getCreateLifecycle = useCallback((recordId: string): CollabCreateLifecycleState | undefined => {
    promoteStalePendingCreates(createLifecycleRef.current, Date.now(), PENDING_CREATE_STALE_MS)
    return createLifecycleRef.current.get(recordId)?.state
  }, [])

  const markCreatesPersistedCb = useCallback((recordIds: readonly string[]) => {
    markCreatesPersisted(createLifecycleRef.current, recordIds)
  }, [])

  const partitionDeleteTargets = useCallback(
    (recordIds: readonly string[]): PartitionDeleteRecordIdsResult => {
      promoteStalePendingCreates(createLifecycleRef.current, Date.now(), PENDING_CREATE_STALE_MS)
      return partitionDeleteRecordIds(
        recordIds,
        (id) => createLifecycleRef.current.get(id)?.state,
      )
    },
    [],
  )

  const cancelPendingCreates = useCallback(
    (recordIds: readonly string[]): string[] => {
      promoteStalePendingCreates(createLifecycleRef.current, Date.now(), PENDING_CREATE_STALE_MS)
      const { pendingCancelIds } = partitionDeleteRecordIds(
        recordIds,
        (id) => createLifecycleRef.current.get(id)?.state,
      )
      if (pendingCancelIds.length === 0) return []

      for (const recordId of pendingCancelIds) {
        markCreateDeleting(createLifecycleRef.current, recordId)
        collab.deleteRecord(recordId)
      }
      clearCreateLifecycles(createLifecycleRef.current, pendingCancelIds)
      if (pendingCancelIds.length > 0) {
        removeRecordsRef.current(pendingCancelIds)
      }
      return pendingCancelIds
    },
    [collab.deleteRecord],
  )

  useEffect(() => {
    const wasOffline = !prevOnlineRef.current
    prevOnlineRef.current = collab.isOnline
    if (!wasOffline || !collab.isOnline || collab.isFallback) return

    const pending = pendingHttpWritesRef.current
    if (pending.size === 0) return

    queueMicrotask(() => {
      const recordsMap = collab.ydoc?.getMap('records')
      const safeCells: Array<{ recordId: string; fieldId: string; value: unknown }> = []
      let discardedCount = 0
      for (const entry of pending.values()) {
        const yRecord = recordsMap?.get(entry.recordId) as Y.Map<unknown> | undefined
        if (!yRecord) {
          discardedCount++
          continue
        }
        if (!fieldHexToIdRef.current.has(entry.fieldHex)) {
          discardedCount++
          continue
        }
        const currentYValue = yRecord.get(entry.fieldHex)
        const unchanged = safeDeepEqual(currentYValue, entry.snapshotValue)
        if (unchanged) {
          safeCells.push({ recordId: entry.recordId, fieldId: entry.fieldHex, value: entry.value })
        } else {
          discardedCount++
        }
      }
      pendingHttpWritesRef.current = new Map()
      if (safeCells.length > 0) collab.batchSetCellValues(safeCells)
      if (discardedCount > 0) {
        input.onConflictDiscarded?.(discardedCount, safeCells.length)
      }
    })
  }, [collab.isOnline, collab.isFallback, collab.batchSetCellValues])

  const wrappedUpdateRecord = useCallback(
    async (recordId: string, updateData: UpdateRecordRequest): Promise<TableRecord | null> => {
      const writeMode = resolveDataGridRecordWriteMode({
        canEdit: collab.canEdit,
        isFallback: collab.isFallback,
        isOnline: collab.isOnline,
        hasYdoc: Boolean(collab.ydoc),
      })
      if (writeMode === 'collab') {
        const payload = resolveFieldPayload(updateData)
        const { fieldValues, staleFields } = mapFieldPayloadToHexValues(
          payload,
          fieldIdToHexRef.current,
        )
        if (staleFields.length > 0) {
          input.onStaleFieldEdit?.(staleFields)
          input.onFieldChange?.({ action: 'field_mapping_missing', field_ids: staleFields })
          return null
        }
        const changes = Object.entries(fieldValues).map(([fieldId, value]) => ({
          recordId,
          fieldId,
          value,
        }))
        if (changes.length > 0) collab.batchSetCellValues(changes)
        // data 按字段名、fields 按字段 UUID——对齐后端 serialize_record 契约，
        // 否则对话框读 data[name] 会拿到陈旧值（见 splitCellPatchKeySpaces）。
        const { data: optimisticData, fields: optimisticFields } = splitCellPatchKeySpaces(
          payload,
          fieldIdToNameRef.current,
        )
        const optimistic = {
          id: recordId,
          data: optimisticData,
          fields: optimisticFields,
          __optimistic: true,
          __optimisticSource: 'collab',
        } as unknown as TableRecord
        mergeRecordsRef.current([optimistic], 0)
        mergeViewRecordsRef.current?.([optimistic], 0)
        return optimistic
      }

      if (collab.canEdit && !collab.isFallback) {
        const payload = resolveFieldPayload(updateData)
        const recordsMap = collab.ydoc?.getMap('records')
        const yRecord = recordsMap?.get(recordId) as Y.Map<unknown> | undefined
        const staleFields: string[] = []
        for (const [fieldId, value] of Object.entries(payload)) {
          const hex = fieldIdToHexRef.current.get(fieldId)
          if (hex) {
            pendingHttpWritesRef.current.set(`${recordId}:${hex}`, { recordId, fieldHex: hex, value, snapshotValue: yRecord?.get(hex) })
          } else {
            staleFields.push(fieldId)
          }
        }
        if (staleFields.length > 0) input.onStaleFieldEdit?.(staleFields)
      }
      return input.updateRecord(recordId, updateData)
    },
    [
      collab.isFallback,
      collab.isOnline,
      collab.ydoc,
      collab.canEdit,
      collab.batchSetCellValues,
      input.onFieldChange,
      input.onStaleFieldEdit,
      input.updateRecord,
    ]
  )

  const wrappedCreateRecord = useCallback(
    async (createData: CreateRecordRequest): Promise<TableRecord | null> => {
      const writeMode = resolveDataGridRecordWriteMode({
        canEdit: collab.canEdit,
        isFallback: collab.isFallback,
        isOnline: collab.isOnline,
        hasYdoc: Boolean(collab.ydoc),
      })
      if (writeMode === 'collab') {
        const recordId = crypto.randomUUID()
        const payload = resolveCreatePayloadWithDefaults(
          resolveFieldPayload(createData),
          input.fields,
          input.collabInput.user.id,
        )
        const { fieldValues, staleFields } = mapFieldPayloadToHexValues(
          payload,
          fieldIdToHexRef.current,
        )
        if (staleFields.length > 0) {
          input.onStaleFieldEdit?.(staleFields)
          input.onFieldChange?.({ action: 'field_mapping_missing', field_ids: staleFields })
          return null
        }
        // The authoritative order is derived by collab persist from rowOrderMap.
        // Do not encode wall-clock time as a row sort value.
        collab.addRecord(recordId, fieldValues, 0, createData.order_context)
        // data 按字段名、fields 按字段 UUID（见 splitCellPatchKeySpaces）。
        const { data: optimisticData, fields: optimisticFields } = splitCellPatchKeySpaces(
          payload,
          fieldIdToNameRef.current,
        )
        const optimistic = {
          id: recordId,
          data: optimisticData,
          fields: optimisticFields,
          __optimistic: true,
          __optimisticSource: 'collab',
        } as unknown as TableRecord
        markCreatePending(createLifecycleRef.current, recordId)
        mergeRecordsRef.current([optimistic], 0)
        mergeViewRecordsRef.current?.([optimistic], 0)

        return optimistic
      }
      return input.createRecord(createData)
    },
    [
      collab.isFallback,
      collab.isOnline,
      collab.ydoc,
      collab.canEdit,
      collab.addRecord,
      input.createRecord,
      input.fields,
      input.collabInput.user.id,
      input.onFieldChange,
      input.onStaleFieldEdit,
    ]
  )

  return {
    updateRecord: wrappedUpdateRecord,
    createRecord: wrappedCreateRecord,
    collab,
    isConnected: !isCollabDisconnected,
    getCreateLifecycle,
    cancelPendingCreates,
    markCreatesPersisted: markCreatesPersistedCb,
    partitionDeleteTargets,
  }
}
