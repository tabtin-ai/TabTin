export interface RecordCommentNotificationIntent {
  scopeKey: string
  recordId: string
  commentId?: string
  intentKey: string
}

type TabItemLike = {
  meta?: Record<string, unknown>
}

export function selectRecordCommentNotificationIntent(
  itemsBySpace: Record<string, Record<string, TabItemLike> | undefined>,
  tabKey: string | null,
): string | null {
  if (!tabKey) return null
  for (const [scopeKey, items] of Object.entries(itemsBySpace)) {
    const meta = items?.[tabKey]?.meta
    const recordId = typeof meta?.recordId === 'string' ? meta.recordId : ''
    const commentId = typeof meta?.commentId === 'string' ? meta.commentId : ''
    const intentKey = meta?.notificationIntentKey
    if (meta?.openComments === true && recordId && intentKey != null) {
      // Zustand selector 返回 primitive，避免每次 snapshot 生成新对象触发无限重渲染。
      return JSON.stringify([scopeKey, recordId, commentId, String(intentKey)])
    }
  }
  return null
}

export function parseRecordCommentNotificationIntent(
  encoded: string | null,
): RecordCommentNotificationIntent | null {
  if (!encoded) return null
  try {
    const parts = JSON.parse(encoded) as string[]
    const [scopeKey, recordId] = parts
    const commentId = parts.length >= 4 ? parts[2] : ''
    const intentKey = parts.length >= 4 ? parts[3] : parts[2]
    return scopeKey && recordId && intentKey
      ? { scopeKey, recordId, ...(commentId ? { commentId } : {}), intentKey }
      : null
  } catch {
    return null
  }
}
