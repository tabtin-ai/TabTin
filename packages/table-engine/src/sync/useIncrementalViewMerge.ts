import { useCallback, useMemo } from 'react'
import {
  coerceMonotonicVersionToken,
  patchVersionInEtag,
  type TableRecord,
  type ViewRecordsResponse,
} from '@tabtin/table-core'
import type { IncrementalSyncSnapshot } from './types'

export interface ViewStoreApiLike {
  setState: (updater: (state: any) => any) => void
}

type ViewRecordsLike = Pick<
  ViewRecordsResponse,
  'records' | 'total' | 'page' | 'page_size'
> &
  Partial<ViewRecordsResponse>

const normalizeCount = (value: unknown): number | undefined => {
  if (!Number.isFinite(value)) {
    return undefined
  }
  return Math.max(0, Math.floor(value as number))
}

const isObjectRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const mergeViewMetadata = (
  currentMetadata: unknown,
  snapshotMetadata: unknown,
): Record<string, unknown> | undefined => {
  if (!isObjectRecord(currentMetadata) && !isObjectRecord(snapshotMetadata)) {
    return undefined
  }
  if (!isObjectRecord(snapshotMetadata)) {
    return currentMetadata as Record<string, unknown> | undefined
  }
  if (!isObjectRecord(currentMetadata)) {
    return snapshotMetadata
  }

  const currentSubRecords = currentMetadata.sub_records
  const snapshotSubRecords = snapshotMetadata.sub_records
  if (!isObjectRecord(currentSubRecords) || !isObjectRecord(snapshotSubRecords)) {
    return {
      ...currentMetadata,
      ...snapshotMetadata,
    }
  }

  const currentTreeData = currentSubRecords.tree_data
  const snapshotTreeData = snapshotSubRecords.tree_data
  const mergedTreeData =
    isObjectRecord(currentTreeData) || isObjectRecord(snapshotTreeData)
      ? {
          ...(isObjectRecord(currentTreeData) ? currentTreeData : {}),
          ...(isObjectRecord(snapshotTreeData) ? snapshotTreeData : {}),
        }
      : undefined

  return {
    ...currentMetadata,
    ...snapshotMetadata,
    sub_records: {
      ...currentSubRecords,
      ...snapshotSubRecords,
      ...(mergedTreeData ? { tree_data: mergedTreeData } : {}),
    },
  }
}

const toFiniteOrder = (record: TableRecord): number | null => {
  const raw = (record as { order?: unknown }).order
  const value = typeof raw === 'number' ? raw : Number(raw)
  return Number.isFinite(value) ? value : null
}

// 与后端 order_by('order', 'created_at', 'id') 对齐的稳定排序比较，
// 让前端增量合并复用同一套排序真相，避免新增记录被 append 到末尾。
const compareRecordsByOrder = (a: TableRecord, b: TableRecord): number => {
  const ao = toFiniteOrder(a)
  const bo = toFiniteOrder(b)
  if (ao !== null && bo !== null && ao !== bo) return ao - bo
  const ac = String((a as { created_at?: unknown }).created_at ?? '')
  const bc = String((b as { created_at?: unknown }).created_at ?? '')
  if (ac !== bc) return ac < bc ? -1 : 1
  const ai = String(a.id)
  const bi = String(b.id)
  if (ai === bi) return 0
  return ai < bi ? -1 : 1
}

// 现有记录已按 order 单调升序排列时，视为「按 order 排序的视图」（树视图 / 默认序）。
// 自定义排序视图的数组不按 order 单调，返回 false 以维持原有 append 行为，避免破坏排序。
const isMonotonicByOrder = (records: TableRecord[]): boolean => {
  if (records.length === 0) return false
  for (const record of records) {
    if (toFiniteOrder(record) === null) return false
  }
  for (let i = 1; i < records.length; i += 1) {
    if (compareRecordsByOrder(records[i - 1], records[i]) > 0) return false
  }
  return true
}

// 在已按 order 单调的数组里，按 order 找到插入点（插到相等元素之后，保持稳定）。
const insertByOrder = (records: TableRecord[], record: TableRecord): void => {
  let lo = 0
  let hi = records.length
  while (lo < hi) {
    const mid = (lo + hi) >> 1
    if (compareRecordsByOrder(records[mid], record) <= 0) lo = mid + 1
    else hi = mid
  }
  records.splice(lo, 0, record)
}

export const isPartialViewSnapshot = (
  currentViewRecords: Pick<ViewRecordsLike, 'records' | 'total' | 'page'> | null | undefined
): boolean => {
  if (!currentViewRecords) {
    return false
  }
  const page = Number.isFinite(currentViewRecords.page) ? Math.max(1, Math.floor(currentViewRecords.page as number)) : 1
  if (page > 1) {
    return true
  }
  const total = normalizeCount(currentViewRecords.total) ?? 0
  const recordsLength = currentViewRecords.records?.length ?? 0
  return total > recordsLength
}

export const mergeCurrentViewRecords = (
  currentViewRecords: ViewRecordsLike,
  records: TableRecord[],
  snapshot?: IncrementalSyncSnapshot
): ViewRecordsLike => {
  const existingRecords = (currentViewRecords.records ?? []) as TableRecord[]
  const partialSnapshot = isPartialViewSnapshot(currentViewRecords)
  const updatedMap = new Map<string, TableRecord>(
    records.map((record: TableRecord) => [record.id, record] as const)
  )

  const existingIdSet = new Set(existingRecords.map((record: TableRecord) => record.id))
  const mergedRecords: TableRecord[] = existingRecords.map((record: TableRecord) => {
    const updatedRecord = updatedMap.get(record.id)
    if (!updatedRecord) return record
    // 增量 patch（如 collab optimistic、单元格更新）通常只携带被改字段，
    // spread 顺序会让 updatedRecord.fields 整体覆盖 record.fields，导致该行
    // 其他列在 cellRenderer/valueGetter 按 record.fields[fieldId] 取值时变空。
    // data 与 fields 都必须做浅 patch merge 才能保证视图一致性。
    const recordFields = (record as Record<string, unknown>).fields
    const updatedFields = (updatedRecord as Record<string, unknown>).fields
    const mergedFields =
      typeof recordFields === 'object' && recordFields !== null
        ? typeof updatedFields === 'object' && updatedFields !== null
          ? { ...(recordFields as Record<string, unknown>), ...(updatedFields as Record<string, unknown>) }
          : recordFields
        : updatedFields
    return {
      ...record,
      ...updatedRecord,
      data: { ...record.data, ...updatedRecord.data },
      ...(mergedFields !== undefined ? { fields: mergedFields } : {}),
    } as TableRecord
  })

  if (!partialSnapshot) {
    const seenNewIds = new Set<string>()
    const newRecords: TableRecord[] = []
    for (const record of records) {
      if (existingIdSet.has(record.id) || seenNewIds.has(record.id)) continue
      seenNewIds.add(record.id)
      newRecords.push(record)
    }

    if (newRecords.length > 0) {
      // 仅当当前视图按 order 单调（树视图 / 默认序）且新记录都带 order 时，
      // 才按 order 插入到正确位置；否则（自定义排序视图 / 缺 order）维持 append，
      // 避免破坏用户自定义排序。order 升序与后端 DFS 扁平序由分数索引保证一致。
      const canInsertByOrder =
        isMonotonicByOrder(mergedRecords) &&
        newRecords.every((record) => toFiniteOrder(record) !== null)
      if (canInsertByOrder) {
        for (const record of [...newRecords].sort(compareRecordsByOrder)) {
          insertByOrder(mergedRecords, record)
        }
      } else {
        for (const record of newRecords) {
          mergedRecords.push(record)
        }
      }
    }
  }

  const nextTotalFromSnapshot = normalizeCount(snapshot?.total)
  const nextTotal =
    nextTotalFromSnapshot ??
    (partialSnapshot ? normalizeCount(currentViewRecords.total) ?? existingRecords.length : mergedRecords.length)
  const mergedMetadata = mergeViewMetadata(
    currentViewRecords.metadata,
    snapshot?.metadata,
  )

  return {
    ...currentViewRecords,
    records: mergedRecords,
    total: nextTotal,
    ...(mergedMetadata !== undefined ? { metadata: mergedMetadata } : {}),
  }
}

export const removeCurrentViewRecords = (
  currentViewRecords: ViewRecordsLike,
  recordIds: string[],
  snapshot?: IncrementalSyncSnapshot
): ViewRecordsLike => {
  const idSet = new Set(recordIds)
  const existingRecords = (currentViewRecords.records ?? []) as TableRecord[]
  const nextRecords = existingRecords.filter(
    (record: TableRecord) => !idSet.has(record.id)
  )
  const removedCount = existingRecords.length - nextRecords.length
  const nextTotalFromSnapshot = normalizeCount(snapshot?.total)
  const baseTotal = normalizeCount(currentViewRecords.total) ?? existingRecords.length

  return {
    ...currentViewRecords,
    records: nextRecords,
    total: nextTotalFromSnapshot ?? Math.max(0, baseTotal - removedCount),
  }
}

export function useIncrementalViewMerge(viewStoreApi: ViewStoreApiLike) {
  const merge = useCallback(
    (records: TableRecord[], newVersion: number, snapshot?: IncrementalSyncSnapshot) => {
      viewStoreApi.setState((state: any) => {
        const currentViewRecords = state.currentViewRecords
        if (!currentViewRecords) return state

        const nextVersion = coerceMonotonicVersionToken(newVersion) ?? state.currentViewLatestVersion
        return {
          ...state,
          currentViewRecords: {
            ...mergeCurrentViewRecords(currentViewRecords, records, snapshot),
            latest_version: nextVersion,
            has_changes: true,
            delta: true,
          },
          currentViewLatestVersion: nextVersion,
          currentViewEtag:
            nextVersion != null
              ? patchVersionInEtag(state.currentViewEtag, nextVersion)
              : state.currentViewEtag,
        }
      })
    },
    [viewStoreApi]
  )

  const remove = useCallback(
    (recordIds: string[], newVersion?: number, snapshot?: IncrementalSyncSnapshot) => {
      if (recordIds.length === 0) return
      viewStoreApi.setState((state: any) => {
        const currentViewRecords = state.currentViewRecords
        if (!currentViewRecords) return state

        const resolvedVersion =
          coerceMonotonicVersionToken(newVersion) ?? state.currentViewLatestVersion

        return {
          ...state,
          currentViewRecords: {
            ...removeCurrentViewRecords(currentViewRecords, recordIds, snapshot),
            latest_version: resolvedVersion,
            has_changes: true,
            delta: true,
          },
          currentViewLatestVersion: resolvedVersion,
          currentViewEtag:
            resolvedVersion != null
              ? patchVersionInEtag(state.currentViewEtag, resolvedVersion)
              : state.currentViewEtag,
        }
      })
    },
    [viewStoreApi]
  )

  return useMemo(() => ({ merge, remove }), [merge, remove])
}
