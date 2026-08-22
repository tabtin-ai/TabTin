import { generateKeyBetween } from 'fractional-indexing'

export const RECORD_POSITION_VERSION_PREFIX = 'p1:'
export const RECORD_POSITION_FIELD = '__position_id'
export const MAX_RECORD_POSITION_KEY_LENGTH = 1024

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'
const FRACTIONAL_INTEGER_PREFIX = 'a0'

export interface PositionableRecord {
  recordId: string
  positionId?: unknown
  /** Stable legacy scalar used for the in-memory lift (__order, then rowOrderMap). */
  legacyPosition?: unknown
  /** Ephemeral rowOrderMap scalar projected for old collaboration clients. */
  legacyMapPosition?: unknown
  /** Numeric REST/query projection (normally __order). */
  legacyOrder?: unknown
}

export interface RecordPositionAllocation {
  recordId: string
  positionId: string
  legacyOrder: number
  legacyPosition: string | number
  /** Preserve the current legacy projection; only materialize effective PositionId. */
  preserveLegacyProjection?: boolean
}

export interface RecordPositionPlan {
  allocations: RecordPositionAllocation[]
  orderedRecordIds: string[]
}

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function encodeBase62Fixed(value: number, width: number): string {
  let remaining = value
  let encoded = ''
  for (let index = 0; index < width; index += 1) {
    encoded = BASE62[remaining % BASE62.length] + encoded
    remaining = Math.floor(remaining / BASE62.length)
  }
  if (remaining !== 0) throw new Error(`value ${value} exceeds base62 width ${width}`)
  return encoded
}

function encodeUtf16(value: string): string {
  let encoded = ''
  for (let index = 0; index < value.length; index += 1) {
    // +1 reserves 000 as the terminator, so a string prefix sorts before
    // every longer string exactly as JavaScript's UTF-16 comparison does.
    encoded += encodeBase62Fixed(value.charCodeAt(index) + 1, 3)
  }
  return `${encoded}000`
}

function encodeRecordId(recordId: string): string {
  // The final non-zero digit keeps the generated fractional key valid.
  return `${encodeUtf16(recordId)}1`
}

function encodeSortableNumber(value: number): string {
  const normalized = Object.is(value, -0) ? 0 : value
  const bytes = new Uint8Array(8)
  new DataView(bytes.buffer).setFloat64(0, normalized, false)

  if ((bytes[0] & 0x80) !== 0) {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] ^= 0xff
  } else {
    bytes[0] ^= 0x80
  }

  let encoded = ''
  for (const byte of bytes) encoded += encodeBase62Fixed(byte, 2)
  return encoded
}

function isValidFractionalKey(key: string): boolean {
  if (!key) return false
  try {
    generateKeyBetween(key, null)
    return true
  } catch {
    try {
      generateKeyBetween(null, key)
      return true
    } catch {
      return false
    }
  }
}

export function parseRecordPositionKey(positionId: unknown): string | null {
  if (typeof positionId !== 'string' || !positionId.startsWith(RECORD_POSITION_VERSION_PREFIX)) {
    return null
  }
  const key = positionId.slice(RECORD_POSITION_VERSION_PREFIX.length)
  if (key.length > MAX_RECORD_POSITION_KEY_LENGTH) return null
  return isValidFractionalKey(key) ? key : null
}

export function isValidRecordPositionId(positionId: unknown): positionId is string {
  return parseRecordPositionKey(positionId) !== null
}

function positionIdFromKey(key: string): string {
  return `${RECORD_POSITION_VERSION_PREFIX}${key}`
}

/**
 * Deterministically lift a legacy scalar into the same valid fractional-key
 * space as new PositionIds. The record id is part of the key, so duplicate
 * legacy values become strictly ordered without writing anything back.
 */
export function legacyToPositionId(legacyPosition: unknown, recordId: string): string {
  let payload: string
  if (typeof legacyPosition === 'number' && !Number.isNaN(legacyPosition)) {
    payload = `1${encodeSortableNumber(legacyPosition)}`
  } else if (typeof legacyPosition === 'string') {
    payload = `2${encodeUtf16(legacyPosition)}`
  } else {
    // Missing and malformed positions remain visible at a deterministic tail.
    payload = '3'
  }
  return positionIdFromKey(`${FRACTIONAL_INTEGER_PREFIX}${payload}${encodeRecordId(recordId)}`)
}

export function effectiveRecordPosition(record: PositionableRecord): string {
  const explicitKey = parseRecordPositionKey(record.positionId)
  return explicitKey
    ? positionIdFromKey(explicitKey)
    : legacyToPositionId(record.legacyPosition, record.recordId)
}

export function compareRecordPositions(a: PositionableRecord, b: PositionableRecord): number {
  const aKey = parseRecordPositionKey(effectiveRecordPosition(a))!
  const bKey = parseRecordPositionKey(effectiveRecordPosition(b))!
  return compareStrings(aKey, bKey) || compareStrings(a.recordId, b.recordId)
}

export function projectLegacyPosition(positionId: string): string {
  const key = parseRecordPositionKey(positionId)
  if (!key) throw new Error(`Invalid record PositionId: ${positionId}`)
  return key
}

function encodeRecordIdentityToken(recordId: string): string {
  // UTF-16 fixed-width encoding is injective for every JavaScript string,
  // including prefix ids and lone surrogates (unlike TextEncoder replacement).
  return `2${encodeUtf16(recordId)}1`
}

function encodeSuffixFreeIdentityTail(separator: string, recordId: string): string {
  const body = `${separator}${encodeRecordIdentityToken(recordId)}`
  // A fixed-width total-length trailer makes the set of tails suffix-free.
  // If `baseA + tailA === baseB + tailB` for different base lengths, the
  // shorter tail would have to be a proper suffix of the longer one; their
  // equal final length trailer makes that impossible.
  const trailerWidth = 4
  const totalLength = body.length + trailerWidth + 1
  return `${body}${encodeBase62Fixed(totalLength, trailerWidth)}1`
}

function allocateUniqueKeyBetween(
  left: string | null,
  right: string | null,
  recordId: string,
): string {
  if ((left?.length ?? 0) > MAX_RECORD_POSITION_KEY_LENGTH) {
    throw new Error('Left record PositionId exceeds the allocation limit')
  }
  if ((right?.length ?? 0) > MAX_RECORD_POSITION_KEY_LENGTH) {
    throw new Error('Right record PositionId exceeds the allocation limit')
  }
  const base = generateKeyBetween(left, right)
  let separator = '0'
  if (right?.startsWith(base)) {
    const rightSuffix = right.slice(base.length)
    let leadingZeroes = 0
    while (rightSuffix[leadingZeroes] === '0') leadingZeroes += 1
    // A valid FI key cannot end in zero, so rightSuffix always eventually has
    // a larger digit. One extra zero keeps every identity token below right.
    separator = '0'.repeat(leadingZeroes + 1)
  }
  const key = `${base}${encodeSuffixFreeIdentityTail(separator, recordId)}`
  if (key.length > MAX_RECORD_POSITION_KEY_LENGTH) {
    throw new Error('Allocated record PositionId exceeds the allocation limit')
  }
  if (
    !isValidFractionalKey(key)
    || (left !== null && key <= left)
    || (right !== null && key >= right)
  ) throw new Error('Unable to allocate a valid record PositionId inside the requested bounds')
  return key
}

function legacyMapPositionForRecord(record: PositionableRecord): string | number | undefined {
  if (typeof record.legacyMapPosition === 'number' && !Number.isNaN(record.legacyMapPosition)) {
    return record.legacyMapPosition
  }
  if (typeof record.legacyMapPosition === 'string') return record.legacyMapPosition
  if (typeof record.legacyPosition === 'number' && !Number.isNaN(record.legacyPosition)) {
    return record.legacyPosition
  }
  if (typeof record.legacyPosition === 'string') return record.legacyPosition
  return parseRecordPositionKey(record.positionId) ?? undefined
}

function legacyNumericOrderForRecord(record: PositionableRecord, fallback: number): number {
  if (typeof record.legacyOrder === 'number' && Number.isFinite(record.legacyOrder)) {
    return record.legacyOrder
  }
  if (typeof record.legacyPosition === 'number' && Number.isFinite(record.legacyPosition)) {
    return record.legacyPosition
  }
  return fallback
}

function explicitLegacyNumericOrderForRecord(record: PositionableRecord): number | undefined {
  if (typeof record.legacyOrder === 'number' && Number.isFinite(record.legacyOrder)) {
    return record.legacyOrder
  }
  if (typeof record.legacyPosition === 'number' && Number.isFinite(record.legacyPosition)) {
    return record.legacyPosition
  }
  return undefined
}

function allocateNumberBetween(left: number | null, right: number | null): number {
  if (left === null && right === null) return 0
  if (left === null) return right === -Infinity ? right : right! - 1
  if (right === null) return left === Infinity ? left : left + 1
  if (left >= right) return left
  if (left === -Infinity && right === Infinity) return 0
  if (left === -Infinity) return right - 1
  if (right === Infinity) return left + 1
  return left / 2 + right / 2
}

/** Keep the legacy scalar projection usable by old clients. */
function allocateLegacyPositionBetween(
  left: string | number | undefined,
  right: string | number | undefined,
  positionId: string,
): string | number {
  if (typeof left === 'number' && typeof right === 'number') {
    return allocateNumberBetween(left, right)
  }
  if (typeof left === 'number' && right === undefined) {
    return allocateNumberBetween(left, null)
  }
  if (left === undefined && typeof right === 'number') {
    return allocateNumberBetween(null, right)
  }
  if (typeof left === 'number' && typeof right === 'string') {
    return allocateNumberBetween(left, null)
  }

  if (typeof left === 'string' && typeof right === 'string') {
    if (left >= right) return left
    if (isValidFractionalKey(left) && isValidFractionalKey(right)) {
      return generateKeyBetween(left, right)
    }
  } else if (typeof left === 'string' && right === undefined) {
    if (isValidFractionalKey(left)) return generateKeyBetween(left, null)
  } else if (left === undefined && typeof right === 'string') {
    if (isValidFractionalKey(right)) return generateKeyBetween(null, right)
  }

  const projected = projectLegacyPosition(positionId)
  if (left !== undefined && compareLegacyScalars(left, projected) >= 0) return left
  if (right !== undefined && compareLegacyScalars(projected, right) >= 0) return right
  return projected
}

function compareLegacyScalars(a: string | number, b: string | number): number {
  if (typeof a === 'number' && typeof b === 'number') return a < b ? -1 : a > b ? 1 : 0
  if (typeof a === 'string' && typeof b === 'string') return compareStrings(a, b)
  return typeof a === 'number' ? -1 : 1
}

function resolveStrictBounds(
  records: readonly PositionableRecord[],
  targetIndex: number,
): [string | null, string | null] {
  const keys = records.map(record => parseRecordPositionKey(effectiveRecordPosition(record))!)
  let leftIndex = targetIndex - 1
  let rightIndex = targetIndex
  let left = leftIndex >= 0 ? keys[leftIndex] : null
  let right = rightIndex < keys.length ? keys[rightIndex] : null

  if (left !== null && right !== null && left >= right) {
    // New allocations are unique. This branch only handles malformed/old
    // duplicate explicit ids: widen across the duplicate run instead of ever
    // passing equal bounds to fractional-indexing.
    const duplicate = left
    while (leftIndex >= 0 && keys[leftIndex] >= duplicate) leftIndex -= 1
    while (rightIndex < keys.length && keys[rightIndex] <= duplicate) rightIndex += 1
    left = leftIndex >= 0 ? keys[leftIndex] : null
    right = rightIndex < keys.length ? keys[rightIndex] : null
  }
  if (left !== null && right !== null && left >= right) return [null, null]
  return [left, right]
}

/** Plan first; callers can then apply record + PositionId + legacy projections atomically. */
export function allocateRecordPositions(
  records: readonly PositionableRecord[],
  recordIds: readonly string[],
  targetIndex: number,
): RecordPositionPlan {
  const seenRecordIds = new Set<string>()
  const uniqueRecordIds = recordIds.filter((recordId) => {
    if (!recordId || seenRecordIds.has(recordId)) return false
    seenRecordIds.add(recordId)
    return true
  })
  const movingIds = new Set(uniqueRecordIds)
  const initialRemaining = records
    .filter(record => !movingIds.has(record.recordId))
    .slice()
    .sort(compareRecordPositions)
  if (uniqueRecordIds.length === 0) {
    return { allocations: [], orderedRecordIds: initialRemaining.map(record => record.recordId) }
  }
  const normalizedTargetIndex = Number.isFinite(targetIndex)
    ? Math.trunc(targetIndex)
    : initialRemaining.length
  const clampedIndex = Math.max(0, Math.min(normalizedTargetIndex, initialRemaining.length))

  // A duplicate legacy gap has no scalar between its two bounds. Either old
  // projection can carry the duplicate independently, so materialize the union
  // of their right-hand suffixes. The prefix stays historical/NULL.
  let boundaryEnd = clampedIndex
  const duplicateLeft = clampedIndex > 0
    ? legacyMapPositionForRecord(initialRemaining[clampedIndex - 1])
    : undefined
  const duplicateRight = clampedIndex < initialRemaining.length
    ? legacyMapPositionForRecord(initialRemaining[clampedIndex])
    : undefined
  if (
    duplicateLeft !== undefined
    && duplicateRight !== undefined
    && compareLegacyScalars(duplicateLeft, duplicateRight) === 0
  ) {
    let index = clampedIndex
    for (; index < initialRemaining.length; index += 1) {
      const candidate = initialRemaining[index]
      const position = legacyMapPositionForRecord(candidate)
      if (position === undefined || compareLegacyScalars(position, duplicateLeft) !== 0) break
    }
    boundaryEnd = Math.max(boundaryEnd, index)
  }
  const duplicateOrderLeft = clampedIndex > 0
    ? explicitLegacyNumericOrderForRecord(initialRemaining[clampedIndex - 1])
    : undefined
  const duplicateOrderRight = clampedIndex < initialRemaining.length
    ? explicitLegacyNumericOrderForRecord(initialRemaining[clampedIndex])
    : undefined
  if (duplicateOrderLeft !== undefined && duplicateOrderLeft === duplicateOrderRight) {
    let index = clampedIndex
    for (; index < initialRemaining.length; index += 1) {
      if (explicitLegacyNumericOrderForRecord(initialRemaining[index]) !== duplicateOrderLeft) break
    }
    boundaryEnd = Math.max(boundaryEnd, index)
  }
  const boundaryRecords = initialRemaining.slice(clampedIndex, boundaryEnd)
  const boundaryIds = new Set(boundaryRecords.map(record => record.recordId))
  const remaining = boundaryIds.size > 0
    ? initialRemaining.filter(record => !boundaryIds.has(record.recordId))
    : initialRemaining
  const [initialLeft, right] = resolveStrictBounds(remaining, clampedIndex)
  let left = initialLeft
  let legacyLeft = clampedIndex > 0
    ? legacyMapPositionForRecord(remaining[clampedIndex - 1])
    : undefined
  const legacyRight = clampedIndex < remaining.length
    ? legacyMapPositionForRecord(remaining[clampedIndex])
    : undefined
  let legacyOrderLeft = clampedIndex > 0
    ? legacyNumericOrderForRecord(remaining[clampedIndex - 1], clampedIndex * 1000)
    : null
  const legacyOrderRight = clampedIndex < remaining.length
    ? legacyNumericOrderForRecord(remaining[clampedIndex], (clampedIndex + 1) * 1000)
    : null
  const allocations: RecordPositionAllocation[] = []

  const allocateGroup = (
    recordIdsToAllocate: readonly string[],
    effectiveRight: string | null,
    mapRight: string | number | undefined,
    orderRight: number | null,
  ) => {
    for (const recordId of recordIdsToAllocate) {
      const key = allocateUniqueKeyBetween(left, effectiveRight, recordId)
      const positionId = positionIdFromKey(key)
      const legacyPosition = allocateLegacyPositionBetween(legacyLeft, mapRight, positionId)
      const legacyOrder = allocateNumberBetween(legacyOrderLeft, orderRight)
      allocations.push({ recordId, positionId, legacyOrder, legacyPosition })
      left = key
      legacyLeft = legacyPosition
      legacyOrderLeft = legacyOrder
    }
  }

  if (boundaryRecords.length > 0) {
    // Split the outer strict gap deterministically. Concurrent insertions all
    // stay below the divider, while whichever boundary write wins remains
    // above every concurrent insertion.
    const divider = generateKeyBetween(left, right)
    const dividerPositionId = positionIdFromKey(divider)
    const legacyDivider = allocateLegacyPositionBetween(
      legacyLeft,
      legacyRight,
      dividerPositionId,
    )
    const orderDivider = allocateNumberBetween(legacyOrderLeft, legacyOrderRight)
    allocateGroup(uniqueRecordIds, divider, legacyDivider, orderDivider)
    left = divider
    legacyLeft = legacyDivider
    legacyOrderLeft = orderDivider
    allocateGroup(
      boundaryRecords.map(record => record.recordId),
      right,
      legacyRight,
      legacyOrderRight,
    )
  } else {
    allocateGroup(uniqueRecordIds, right, legacyRight, legacyOrderRight)
  }

  // The effective bounds must survive snapshot/restart in the same comparison
  // space. A NULL historical boundary may otherwise be rebuilt with a new
  // legacy scalar (for example numeric 1000 -> rowOrderMap "a0"), moving the
  // explicit insertion relative to it. Materialize only the bounds that took
  // part in this mutation and leave their legacy projections untouched.
  const allocatedIds = new Set(allocations.map(allocation => allocation.recordId))
  const effectiveBoundaryRecords = [
    clampedIndex > 0 ? remaining[clampedIndex - 1] : undefined,
    clampedIndex < remaining.length ? remaining[clampedIndex] : undefined,
  ]
  for (const boundaryRecord of effectiveBoundaryRecords) {
    if (
      !boundaryRecord
      || allocatedIds.has(boundaryRecord.recordId)
      || parseRecordPositionKey(boundaryRecord.positionId)
    ) continue
    const positionId = effectiveRecordPosition(boundaryRecord)
    allocations.push({
      recordId: boundaryRecord.recordId,
      positionId,
      legacyPosition: legacyMapPositionForRecord(boundaryRecord)
        ?? projectLegacyPosition(positionId),
      legacyOrder: legacyNumericOrderForRecord(boundaryRecord, clampedIndex * 1000),
      preserveLegacyProjection: true,
    })
    allocatedIds.add(boundaryRecord.recordId)
  }

  const orderedRecordIds = remaining.map(record => record.recordId)
  orderedRecordIds.splice(
    clampedIndex,
    0,
    ...uniqueRecordIds,
    ...boundaryRecords.map(record => record.recordId),
  )
  return { allocations, orderedRecordIds }
}
