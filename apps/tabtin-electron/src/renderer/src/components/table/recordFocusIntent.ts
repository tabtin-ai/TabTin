type TabItemWithMeta = {
  meta?: Record<string, unknown>
}

type TabItemsByScope = Record<string, Record<string, TabItemWithMeta>>

export interface RecordFocusIntentMeta {
  scopeKey: string | null
  requestId: string | number | null
  recordId: string | null
}

const EMPTY_RECORD_FOCUS_INTENT: RecordFocusIntentMeta = {
  scopeKey: null,
  requestId: null,
  recordId: null,
}

function readRecordFocusIntent(
  item: TabItemWithMeta | undefined,
  scopeKey: string,
): RecordFocusIntentMeta {
  const requestId = item?.meta?.recordFocusRequestId
  const recordId = item?.meta?.recordFocusRecordId
  return {
    scopeKey,
    requestId:
      typeof requestId === 'string' || typeof requestId === 'number'
        ? requestId
        : null,
    recordId: typeof recordId === 'string' && recordId.trim() ? recordId.trim() : null,
  }
}

function readRequestOrder(requestId: string | number | null): [number, number] {
  if (typeof requestId === 'number') return [requestId, 0]
  if (typeof requestId !== 'string') return [Number.NEGATIVE_INFINITY, 0]
  const match = /^record-focus:(\d+):(\d+)$/.exec(requestId)
  return match ? [Number(match[1]), Number(match[2])] : [Number.NEGATIVE_INFINITY, 0]
}

function isNewerRequest(candidate: RecordFocusIntentMeta, current: RecordFocusIntentMeta): boolean {
  const [candidateTime, candidateSequence] = readRequestOrder(candidate.requestId)
  const [currentTime, currentSequence] = readRequestOrder(current.requestId)
  return candidateTime > currentTime
    || (candidateTime === currentTime && candidateSequence > currentSequence)
}

/**
 * 从当前可见的标签域读取记录定位意图，避免同一张表跨任务打开时串台。
 */
export function resolveRecordFocusIntentMeta(
  itemsByScope: TabItemsByScope,
  tableTabKey: string | null,
  preferredScopeKey: string | null,
): RecordFocusIntentMeta {
  if (!tableTabKey) return EMPTY_RECORD_FOCUS_INTENT
  let resolvedIntent = preferredScopeKey
    ? readRecordFocusIntent(
      itemsByScope[preferredScopeKey]?.[tableTabKey],
      preferredScopeKey,
    )
    : EMPTY_RECORD_FOCUS_INTENT

  for (const [scopeKey, scopedItems] of Object.entries(itemsByScope)) {
    const intent = readRecordFocusIntent(scopedItems[tableTabKey], scopeKey)
    if (intent.requestId === null || !intent.recordId) continue
    if (resolvedIntent.requestId === null || !resolvedIntent.recordId || isNewerRequest(intent, resolvedIntent)) {
      resolvedIntent = intent
    }
  }
  return resolvedIntent
}
