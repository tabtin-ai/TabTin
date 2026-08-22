export function mergeOlderComments<T extends { id: string }>(
  current: T[],
  olderPage: T[],
): T[] {
  const knownIds = new Set(current.map((comment) => comment.id))
  return [
    ...olderPage.filter((comment) => !knownIds.has(comment.id)),
    ...current,
  ]
}

export interface RecordCommentSubmitFingerprint {
  recordId: string
  content: string
  mentionUserIds: string[]
  replyToCommentId?: string
}

export function matchesPendingRecordCommentSubmit(
  pending: RecordCommentSubmitFingerprint | null,
  next: RecordCommentSubmitFingerprint,
): pending is RecordCommentSubmitFingerprint {
  return Boolean(
    pending
    && pending.recordId === next.recordId
    && pending.content === next.content
    && pending.replyToCommentId === next.replyToCommentId
    && pending.mentionUserIds.length === next.mentionUserIds.length
    && pending.mentionUserIds.every((userId, index) => userId === next.mentionUserIds[index])
  )
}

export function isRecordRequestCurrent(
  activeRecordId: string | undefined,
  requestRecordId: string,
): boolean {
  return activeRecordId === requestRecordId
}
