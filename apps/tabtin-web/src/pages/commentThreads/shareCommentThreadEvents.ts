/**
 * 分享页评论实时事件（与 Django DocEventService share.events.* 对齐）。
 */

export const SHARE_COMMENT_EVENT = 'share.events.comment' as const
export const SHARE_COMMENT_THREAD_EVENT = 'share.events.comment_thread' as const
export const SHARE_COMMENT_MESSAGE_EVENT = 'share.events.comment_message' as const

export const SHARE_COMMENT_THREAD_EVENT_TYPES = [
  SHARE_COMMENT_EVENT,
  SHARE_COMMENT_THREAD_EVENT,
  SHARE_COMMENT_MESSAGE_EVENT,
] as const

export type ShareCommentThreadEventType = (typeof SHARE_COMMENT_THREAD_EVENT_TYPES)[number]

export function isShareCommentThreadRealtimeEvent(eventType: string | null | undefined): boolean {
  return Boolean(
    eventType
    && (SHARE_COMMENT_THREAD_EVENT_TYPES as readonly string[]).includes(eventType),
  )
}

/** 线程列表应重载的动作 */
export function shouldReloadShareCommentThreadsOnEvent(
  eventType: string,
  action?: string | null,
): boolean {
  if (!isShareCommentThreadRealtimeEvent(eventType)) return false
  if (eventType === SHARE_COMMENT_EVENT) return true
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
