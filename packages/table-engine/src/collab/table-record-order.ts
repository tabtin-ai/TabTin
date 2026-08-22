import * as Y from 'yjs'

import {
  allocateRecordPositions,
  compareRecordPositions,
  parseRecordPositionKey,
  RECORD_POSITION_FIELD,
  type PositionableRecord,
  type RecordPositionAllocation,
  type RecordPositionPlan,
} from './record-position.js'
import { YDOC_META, YDOC_RECORDS, YDOC_ROW_ORDER, YDOC_ROW_ORDER_MAP } from './ydoc-schema.js'

export const LEGACY_RECORD_ORDER_FIELD = '__order'
export const TRUNCATED_TABLE_UNKNOWN_TAIL_ERROR =
  'Cannot allocate a TabData record position at the unknown tail of a truncated snapshot'

export interface TableRecordOrderContext {
  anchor_record_id?: string
  position?: 'before' | 'after' | 'end'
}

export interface TableRecordInsertInput {
  recordId: string
  fieldValues: Record<string, unknown>
  legacyOrder?: number
  orderContext?: TableRecordOrderContext
  origin: unknown
}

export interface TableRecordInsertResult {
  inserted: boolean
  allocation: RecordPositionAllocation | null
}

function legacyScalar(value: unknown): string | number | undefined {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && !Number.isNaN(value)) return value
  return undefined
}

function uniqueArrayIndex(rowOrder: Y.Array<string>): Map<string, number> {
  const result = new Map<string, number>()
  for (let index = 0; index < rowOrder.length; index += 1) {
    const recordId = rowOrder.get(index)
    if (!result.has(recordId)) result.set(recordId, index)
  }
  return result
}

/** Pure read: historical rows are lifted in memory and never materialized. */
export function readPositionableTableRecords(ydoc: Y.Doc): PositionableRecord[] {
  const recordsMap = ydoc.getMap(YDOC_RECORDS)
  const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER)
  const rowOrderMap = ydoc.getMap<unknown>(YDOC_ROW_ORDER_MAP)
  const arrayIndex = uniqueArrayIndex(rowOrder)
  const records: PositionableRecord[] = []

  recordsMap.forEach((value, recordId) => {
    if (!(value instanceof Y.Map)) return
    // __order is persisted per record and survives snapshot reconstruction.
    // rowOrderMap is only an old-client projection and may be regenerated.
    const projectedPosition = legacyScalar(value.get(LEGACY_RECORD_ORDER_FIELD))
      ?? legacyScalar(rowOrderMap.get(recordId))
      ?? arrayIndex.get(recordId)
    records.push({
      recordId,
      positionId: value.get(RECORD_POSITION_FIELD),
      legacyPosition: projectedPosition,
      legacyMapPosition: legacyScalar(rowOrderMap.get(recordId)),
      legacyOrder: legacyScalar(value.get(LEGACY_RECORD_ORDER_FIELD)),
    })
  })
  return records
}

export function getEffectiveTableRecordOrder(ydoc: Y.Doc): string[] {
  return readPositionableTableRecords(ydoc)
    .sort(compareRecordPositions)
    .map(record => record.recordId)
}

function compareLegacyOrderScalars(
  left: string | number,
  right: string | number,
): number {
  if (typeof left === 'number' && typeof right === 'number') {
    return left < right ? -1 : left > right ? 1 : 0
  }
  if (typeof left === 'string' && typeof right === 'string') {
    return left < right ? -1 : left > right ? 1 : 0
  }
  return typeof left === 'number' ? -1 : 1
}

/**
 * Resolve a complete old-client record.__order intent without allowing stale
 * PositionIds to override it. Missing and equal scalars preserve the current
 * effective order, so malformed legacy data remains visible and deterministic.
 */
export function resolveLegacyTableRecordOrderIntent(ydoc: Y.Doc): string[] {
  const records = readPositionableTableRecords(ydoc)
  const fallbackOrder = records.slice().sort(compareRecordPositions)
    .map(record => record.recordId)
  const fallbackIndex = new Map(
    fallbackOrder.map((recordId, index) => [recordId, index]),
  )

  return records.slice().sort((left, right) => {
    const leftOrder = legacyScalar(left.legacyOrder)
    const rightOrder = legacyScalar(right.legacyOrder)
    if (leftOrder !== undefined && rightOrder !== undefined) {
      const compared = compareLegacyOrderScalars(leftOrder, rightOrder)
      if (compared !== 0) return compared
    }
    if (leftOrder !== undefined) return -1
    if (rightOrder !== undefined) return 1
    return (fallbackIndex.get(left.recordId) ?? Number.MAX_SAFE_INTEGER)
      - (fallbackIndex.get(right.recordId) ?? Number.MAX_SAFE_INTEGER)
      || (left.recordId < right.recordId ? -1 : left.recordId > right.recordId ? 1 : 0)
  }).map(record => record.recordId)
}

function readPlanningRecords(ydoc: Y.Doc): PositionableRecord[] {
  const records = readPositionableTableRecords(ydoc)
  const knownIds = new Set(records.map(record => record.recordId))
  const rowOrderMap = ydoc.getMap<unknown>(YDOC_ROW_ORDER_MAP)
  rowOrderMap.forEach((value, recordId) => {
    if (knownIds.has(recordId)) return
    const legacyPosition = legacyScalar(value)
    records.push({ recordId, legacyPosition, legacyMapPosition: legacyPosition })
    knownIds.add(recordId)
  })
  const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER)
  for (let index = 0; index < rowOrder.length; index += 1) {
    const recordId = rowOrder.get(index)
    if (knownIds.has(recordId)) continue
    records.push({ recordId, legacyPosition: index })
    knownIds.add(recordId)
  }
  return records
}

function targetIndexForContext(
  records: readonly PositionableRecord[],
  context?: TableRecordOrderContext,
): number {
  if (context?.position === 'end') return records.length
  if (!context?.anchor_record_id) return context?.position === 'before' ? 0 : records.length
  const anchorIndex = records.findIndex(record => record.recordId === context.anchor_record_id)
  if (anchorIndex < 0) return records.length
  return context.position === 'before' ? anchorIndex : anchorIndex + 1
}

function assertKnownTableRecordRightBound(
  ydoc: Y.Doc,
  targetIndex: number,
  knownRecordCount: number,
): void {
  if (ydoc.getMap(YDOC_META).get('is_truncated') !== true) return
  const normalizedTargetIndex = Number.isFinite(targetIndex)
    ? Math.trunc(targetIndex)
    : knownRecordCount
  const clampedIndex = Math.max(0, Math.min(normalizedTargetIndex, knownRecordCount))
  if (knownRecordCount === 0 || clampedIndex === knownRecordCount) {
    throw new Error(TRUNCATED_TABLE_UNKNOWN_TAIL_ERROR)
  }
}

/** Plan an insertion at a known loaded index without treating a truncated prefix as the table tail. */
function planTableRecordInsertAtIndex(
  ydoc: Y.Doc,
  recordId: string,
  targetIndex: number,
): RecordPositionPlan {
  const records = readPlanningRecords(ydoc)
    .filter(record => record.recordId !== recordId)
    .sort(compareRecordPositions)
  assertKnownTableRecordRightBound(ydoc, targetIndex, records.length)
  return allocateRecordPositions(records, [recordId], targetIndex)
}

export function planTableRecordInsert(
  ydoc: Y.Doc,
  recordId: string,
  context?: TableRecordOrderContext,
): RecordPositionPlan {
  const records = readPlanningRecords(ydoc)
    .filter(record => record.recordId !== recordId)
    .sort(compareRecordPositions)
  return planTableRecordInsertAtIndex(
    ydoc,
    recordId,
    targetIndexForContext(records, context),
  )
}

function longestIncreasingCurrentIndices(
  current: readonly string[],
  target: readonly string[],
): Set<number> {
  const targetIndex = new Map(target.map((recordId, index) => [recordId, index]))
  const sequence: Array<{ currentIndex: number; targetIndex: number }> = []
  current.forEach((recordId, currentIndex) => {
    const index = targetIndex.get(recordId)
    if (index !== undefined) sequence.push({ currentIndex, targetIndex: index })
  })
  const tails: number[] = []
  const previous = new Array<number>(sequence.length).fill(-1)
  for (let sequenceIndex = 0; sequenceIndex < sequence.length; sequenceIndex += 1) {
    const value = sequence[sequenceIndex].targetIndex
    let low = 0
    let high = tails.length
    while (low < high) {
      const middle = (low + high) >> 1
      if (sequence[tails[middle]].targetIndex < value) low = middle + 1
      else high = middle
    }
    if (low > 0) previous[sequenceIndex] = tails[low - 1]
    tails[low] = sequenceIndex
  }
  const kept = new Set<number>()
  let cursor = tails.at(-1) ?? -1
  while (cursor >= 0) {
    kept.add(sequence[cursor].currentIndex)
    cursor = previous[cursor]
  }
  return kept
}

export function findReorderedRecordIds(
  previousOrder: readonly string[],
  nextOrder: readonly string[],
): string[] {
  const keptIndices = longestIncreasingCurrentIndices(previousOrder, nextOrder)
  const keptIds = new Set(previousOrder.filter((_, index) => keptIndices.has(index)))
  return nextOrder.filter(recordId => !keptIds.has(recordId))
}

/**
 * Plan an old-client complete rowOrder-array rewrite without invalidating the
 * entire table. Only records outside the longest preserved subsequence, plus
 * the sparse effective bounds required by allocation, receive PositionIds.
 */
export function planTableRecordOrderReconcile(
  ydoc: Y.Doc,
  requestedOrder: readonly string[],
  preferredMovedRecordIds: readonly string[] = [],
): RecordPositionPlan {
  let virtualRecords = readPositionableTableRecords(ydoc)
  const knownIds = new Set(virtualRecords.map(record => record.recordId))
  const reconciledOrder: string[] = []
  const seen = new Set<string>()
  for (const recordId of requestedOrder) {
    if (knownIds.has(recordId) && !seen.has(recordId)) {
      reconciledOrder.push(recordId)
      seen.add(recordId)
    }
  }
  const previousOrder = virtualRecords.slice().sort(compareRecordPositions)
    .map(record => record.recordId)
  for (const recordId of previousOrder) {
    if (!seen.has(recordId)) reconciledOrder.push(recordId)
  }

  const defaultMovedIds = findReorderedRecordIds(previousOrder, reconciledOrder)
  const preferredSet = new Set(
    preferredMovedRecordIds.filter(recordId => knownIds.has(recordId)),
  )
  let movedIds = defaultMovedIds
  if (preferredSet.size > 0) {
    const previousStable = previousOrder.filter(recordId => !preferredSet.has(recordId))
    const requestedStable = reconciledOrder.filter(recordId => !preferredSet.has(recordId))
    if (
      previousStable.length === requestedStable.length
      && previousStable.every((recordId, index) => recordId === requestedStable[index])
    ) {
      // A scalar legacy write identifies the row the old client actually
      // moved. Prefer that row when it alone explains the requested order;
      // the generic LIS may otherwise choose its unchanged neighbour.
      const preferredMovedIds = reconciledOrder.filter(recordId => preferredSet.has(recordId))
      if (
        preferredMovedIds.length !== defaultMovedIds.length
        || preferredMovedIds.some((recordId, index) => recordId !== defaultMovedIds[index])
      ) movedIds = preferredMovedIds
    }
  }
  if (movedIds.length === 0) return { allocations: [], orderedRecordIds: reconciledOrder }
  const movedSet = new Set(movedIds)
  const allocationsById = new Map<string, RecordPositionAllocation>()

  for (let index = 0; index < reconciledOrder.length;) {
    if (!movedSet.has(reconciledOrder[index])) {
      index += 1
      continue
    }
    const segment: string[] = []
    while (index < reconciledOrder.length && movedSet.has(reconciledOrder[index])) {
      segment.push(reconciledOrder[index])
      index += 1
    }
    const nextStableId = reconciledOrder[index]
    const sortedVirtual = virtualRecords.slice().sort(compareRecordPositions)
    const segmentSet = new Set(segment)
    const remaining = sortedVirtual.filter(record => !segmentSet.has(record.recordId))
    const nextStableIndex = nextStableId
      ? remaining.findIndex(record => record.recordId === nextStableId)
      : remaining.length
    const plan = allocateRecordPositions(
      sortedVirtual,
      segment,
      nextStableIndex < 0 ? remaining.length : nextStableIndex,
    )
    for (const allocation of plan.allocations) allocationsById.set(allocation.recordId, allocation)
    const positions = new Map(plan.allocations.map(allocation => [allocation.recordId, allocation]))
    virtualRecords = virtualRecords.map((record) => {
      const allocation = positions.get(record.recordId)
      if (!allocation) return record
      return {
        ...record,
        positionId: allocation.positionId,
        legacyPosition: allocation.preserveLegacyProjection
          ? record.legacyPosition
          : allocation.legacyPosition,
        legacyMapPosition: allocation.preserveLegacyProjection
          ? record.legacyMapPosition
          : allocation.legacyPosition,
        legacyOrder: allocation.preserveLegacyProjection
          ? record.legacyOrder
          : allocation.legacyOrder,
      }
    })
  }
  return { allocations: [...allocationsById.values()], orderedRecordIds: reconciledOrder }
}

export function planLegacyTableRecordOrderReconcile(
  ydoc: Y.Doc,
  changedRecordIds: readonly string[],
): RecordPositionPlan {
  return planTableRecordOrderReconcile(
    ydoc,
    resolveLegacyTableRecordOrderIntent(ydoc),
    changedRecordIds,
  )
}

function replaceLegacyRowOrder(rowOrder: Y.Array<string>, orderedRecordIds: readonly string[]): void {
  const current = rowOrder.toArray()
  if (
    current.length === orderedRecordIds.length
    && current.every((recordId, index) => recordId === orderedRecordIds[index])
  ) return
  const keptCurrentIndices = longestIncreasingCurrentIndices(current, orderedRecordIds)
  for (let index = current.length - 1; index >= 0; index -= 1) {
    if (!keptCurrentIndices.has(index)) rowOrder.delete(index, 1)
  }
  let targetIndex = 0
  for (const recordId of orderedRecordIds) {
    if (rowOrder.get(targetIndex) !== recordId) rowOrder.insert(targetIndex, [recordId])
    targetIndex += 1
  }
  if (rowOrder.length > orderedRecordIds.length) {
    rowOrder.delete(orderedRecordIds.length, rowOrder.length - orderedRecordIds.length)
  }
}

/** Apply a precomputed plan inside the caller's existing Yjs transaction. */
export function applyTableRecordOrderPlan(
  ydoc: Y.Doc,
  plan: RecordPositionPlan,
): void {
  const recordsMap = ydoc.getMap(YDOC_RECORDS)
  const rowOrderMap = ydoc.getMap<string | number>(YDOC_ROW_ORDER_MAP)
  const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER)
  for (const allocation of plan.allocations) {
    const record = recordsMap.get(allocation.recordId)
    if (!(record instanceof Y.Map)) continue
    record.set(RECORD_POSITION_FIELD, allocation.positionId)
    if (!allocation.preserveLegacyProjection) {
      record.set(LEGACY_RECORD_ORDER_FIELD, allocation.legacyOrder)
      rowOrderMap.set(allocation.recordId, allocation.legacyPosition)
    }
  }
  replaceLegacyRowOrder(rowOrder, plan.orderedRecordIds)
}

function assertInsertValuesAreSafe(fieldValues: Record<string, unknown>): Array<[string, unknown]> {
  const entries = Object.entries(fieldValues).filter(
    ([fieldId]) => fieldId !== RECORD_POSITION_FIELD && fieldId !== LEGACY_RECORD_ORDER_FIELD,
  )
  for (const [, value] of entries) {
    if (value instanceof Y.AbstractType) {
      throw new Error('A shared Yjs type cannot be inserted as a TabData cell value')
    }
  }
  return entries
}

/**
 * Allocate first, then attach the record and all order projections in one Yjs
 * transaction. Any allocation/validation error occurs before the document is
 * touched, so callers never observe a half-created row.
 */
export function insertTableRecordAtomically(
  ydoc: Y.Doc,
  input: TableRecordInsertInput,
): TableRecordInsertResult {
  const recordsMap = ydoc.getMap(YDOC_RECORDS)
  const existing = recordsMap.get(input.recordId)
  const entries = assertInsertValuesAreSafe(input.fieldValues)

  if (existing instanceof Y.Map) {
    if (parseRecordPositionKey(existing.get(RECORD_POSITION_FIELD))) {
      ydoc.transact(() => {
        for (const [fieldId, value] of entries) existing.set(fieldId, value)
      }, input.origin)
      return { inserted: false, allocation: null }
    }

    // A prior client may have left a legacy/half-created record. Replay is the
    // necessary creation boundary, so materialize its PositionId once without
    // creating a duplicate record.
    const plan = planTableRecordInsert(ydoc, input.recordId, input.orderContext)
    const allocation = plan.allocations.find(item => item.recordId === input.recordId)
    if (!allocation) throw new Error(`Unable to allocate PositionId for record ${input.recordId}`)
    if (Number.isFinite(input.legacyOrder)) allocation.legacyOrder = input.legacyOrder!
    const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER)
    const rowOrderMap = ydoc.getMap<string | number>(YDOC_ROW_ORDER_MAP)
    ydoc.transact(() => {
      for (const [fieldId, value] of entries) existing.set(fieldId, value)
      applyTableRecordOrderPlan(ydoc, plan)
    }, input.origin)
    return { inserted: false, allocation }
  }

  const plan = planTableRecordInsert(ydoc, input.recordId, input.orderContext)
  const allocation = plan.allocations.find(item => item.recordId === input.recordId)
  if (!allocation) throw new Error(`Unable to allocate PositionId for record ${input.recordId}`)
  if (Number.isFinite(input.legacyOrder)) allocation.legacyOrder = input.legacyOrder!

  // Prepare the detached record before the Y.Doc transaction. Even a bad cell
  // value cannot leave records/order partially written.
  const record = new Y.Map<unknown>()
  for (const [fieldId, value] of entries) record.set(fieldId, value)

  const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER)
  const rowOrderMap = ydoc.getMap<string | number>(YDOC_ROW_ORDER_MAP)
  ydoc.transact(() => {
    recordsMap.set(input.recordId, record)
    applyTableRecordOrderPlan(ydoc, plan)
  }, input.origin)
  return { inserted: true, allocation }
}

export function reorderTableRecordsAtomically(
  ydoc: Y.Doc,
  movedRecordIds: readonly string[],
  targetIndex: number,
  origin: unknown,
): RecordPositionPlan {
  const records = readPositionableTableRecords(ydoc)
  const existingIds = new Set(records.map(record => record.recordId))
  const movableIds = movedRecordIds.filter(
    (recordId, index) => existingIds.has(recordId) && movedRecordIds.indexOf(recordId) === index,
  )
  if (movableIds.length === 0) return allocateRecordPositions(records, [], targetIndex)
  const remainingCount = records.filter(record => !movableIds.includes(record.recordId)).length
  assertKnownTableRecordRightBound(ydoc, targetIndex, remainingCount)
  const plan = allocateRecordPositions(records, movableIds, targetIndex)
  if (plan.allocations.length === 0) return plan

  const recordsMap = ydoc.getMap(YDOC_RECORDS)
  const rowOrder = ydoc.getArray<string>(YDOC_ROW_ORDER)
  const rowOrderMap = ydoc.getMap<string | number>(YDOC_ROW_ORDER_MAP)
  ydoc.transact(() => {
    applyTableRecordOrderPlan(ydoc, plan)
  }, origin)
  return plan
}
