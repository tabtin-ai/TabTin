export interface RecordCommentRouteIntent {
  recordId: string
  commentId?: string
  intentKey?: string
}

const RECORD_ID_PARAM = 'recordId'
const COMMENT_ID_PARAM = 'commentId'
const OPEN_COMMENTS_PARAM = 'openComments'
const INTENT_KEY_PARAM = 'commentIntent'

export function appendRecordCommentRouteIntent(
  url: string,
  intent: RecordCommentRouteIntent,
): string {
  const [pathAndSearch, hash = ''] = url.split('#', 2)
  const [pathname, existingSearch = ''] = pathAndSearch.split('?', 2)
  const params = new URLSearchParams(existingSearch)
  params.set(RECORD_ID_PARAM, intent.recordId)
  params.set(OPEN_COMMENTS_PARAM, '1')
  if (intent.commentId) params.set(COMMENT_ID_PARAM, intent.commentId)
  else params.delete(COMMENT_ID_PARAM)
  if (intent.intentKey) params.set(INTENT_KEY_PARAM, intent.intentKey)
  else params.delete(INTENT_KEY_PARAM)
  const search = params.toString()
  return `${pathname}${search ? `?${search}` : ''}${hash ? `#${hash}` : ''}`
}

export function parseRecordCommentRouteIntent(search: string): RecordCommentRouteIntent | null {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  const recordId = params.get(RECORD_ID_PARAM)?.trim()
  if (!recordId || params.get(OPEN_COMMENTS_PARAM) !== '1') return null
  const commentId = params.get(COMMENT_ID_PARAM)?.trim()
  const intentKey = params.get(INTENT_KEY_PARAM)?.trim()
  return {
    recordId,
    ...(commentId ? { commentId } : {}),
    ...(intentKey ? { intentKey } : {}),
  }
}

/** Removes only this feature's one-shot params and preserves unrelated route state. */
export function clearRecordCommentRouteIntent(search: string): string {
  const params = new URLSearchParams(search.startsWith('?') ? search.slice(1) : search)
  params.delete(RECORD_ID_PARAM)
  params.delete(COMMENT_ID_PARAM)
  params.delete(OPEN_COMMENTS_PARAM)
  params.delete(INTENT_KEY_PARAM)
  const next = params.toString()
  return next ? `?${next}` : ''
}
