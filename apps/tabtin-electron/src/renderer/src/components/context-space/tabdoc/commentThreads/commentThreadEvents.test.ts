import { describe, expect, it } from 'vitest'
import {
  DOC_COMMENT_EVENT,
  DOC_COMMENT_MESSAGE_EVENT,
  DOC_COMMENT_THREAD_EVENT,
  isDocCommentThreadRealtimeEvent,
  shouldReloadCommentThreadsOnEvent,
} from './commentThreadEvents'

describe('commentThreadEvents', () => {
  it('识别线程/消息/旧评论事件', () => {
    expect(isDocCommentThreadRealtimeEvent(DOC_COMMENT_THREAD_EVENT)).toBe(true)
    expect(isDocCommentThreadRealtimeEvent(DOC_COMMENT_MESSAGE_EVENT)).toBe(true)
    expect(isDocCommentThreadRealtimeEvent(DOC_COMMENT_EVENT)).toBe(true)
    expect(isDocCommentThreadRealtimeEvent('doc.events.save')).toBe(false)
  })

  it('创建/回复/解决/重关联触发刷新', () => {
    expect(shouldReloadCommentThreadsOnEvent(DOC_COMMENT_THREAD_EVENT, 'created')).toBe(true)
    expect(shouldReloadCommentThreadsOnEvent(DOC_COMMENT_THREAD_EVENT, 'status_changed')).toBe(true)
    expect(shouldReloadCommentThreadsOnEvent(DOC_COMMENT_THREAD_EVENT, 'anchor_changed')).toBe(true)
    expect(shouldReloadCommentThreadsOnEvent(DOC_COMMENT_MESSAGE_EVENT, 'created')).toBe(true)
    expect(shouldReloadCommentThreadsOnEvent(DOC_COMMENT_MESSAGE_EVENT, 'deleted')).toBe(true)
    expect(shouldReloadCommentThreadsOnEvent(DOC_COMMENT_EVENT, 'created')).toBe(true)
  })
})
