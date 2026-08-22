/**
 * TabDoc 评论线程实时事件名（与 Django DocEventService 对齐）。
 */
export const DOC_COMMENT_EVENT = 'doc.events.comment' as const
export const DOC_COMMENT_THREAD_EVENT = 'doc.events.comment_thread' as const
export const DOC_COMMENT_MESSAGE_EVENT = 'doc.events.comment_message' as const

export const DOC_COMMENT_THREAD_EVENT_TYPES = [
  DOC_COMMENT_EVENT,
  DOC_COMMENT_THREAD_EVENT,
  DOC_COMMENT_MESSAGE_EVENT,
] as const

export type DocCommentThreadEventType = (typeof DOC_COMMENT_THREAD_EVENT_TYPES)[number]

export function isDocCommentThreadRealtimeEvent(eventType: string | null | undefined): boolean {
  return Boolean(
    eventType
    && (DOC_COMMENT_THREAD_EVENT_TYPES as readonly string[]).includes(eventType),
  )
}

/** 线程列表应重载的动作（创建 / 回复 / 解决 / 重关联 / 删除消息） */
export function shouldReloadCommentThreadsOnEvent(
  eventType: string,
  action?: string | null,
): boolean {
  if (!isDocCommentThreadRealtimeEvent(eventType)) return false
  if (eventType === DOC_COMMENT_EVENT) {
    // 旧根评论事件仍可能伴随线程投影变化
    return true
  }
  const normalized = (action || '').trim().toLowerCase()
  if (!normalized) return true
  return (
    normalized === 'created'
    || normalized === 'status_changed'
    || normalized === 'anchor_changed'
    || normalized === 'deleted'
    || normalized === 'updated'
  )
}
