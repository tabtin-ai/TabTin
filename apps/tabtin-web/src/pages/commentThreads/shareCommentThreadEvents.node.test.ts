import assert from 'node:assert/strict'
import test from 'node:test'
import {
  SHARE_COMMENT_EVENT,
  SHARE_COMMENT_MESSAGE_EVENT,
  SHARE_COMMENT_THREAD_EVENT,
  isShareCommentThreadRealtimeEvent,
  shouldReloadShareCommentThreadsOnEvent,
} from './shareCommentThreadEvents.ts'

test('识别线程/消息/旧评论事件', () => {
  assert.equal(isShareCommentThreadRealtimeEvent(SHARE_COMMENT_THREAD_EVENT), true)
  assert.equal(isShareCommentThreadRealtimeEvent(SHARE_COMMENT_MESSAGE_EVENT), true)
  assert.equal(isShareCommentThreadRealtimeEvent(SHARE_COMMENT_EVENT), true)
  assert.equal(isShareCommentThreadRealtimeEvent('share.events.save'), false)
})

test('创建/回复/解决/重关联触发刷新', () => {
  assert.equal(shouldReloadShareCommentThreadsOnEvent(SHARE_COMMENT_THREAD_EVENT, 'created'), true)
  assert.equal(shouldReloadShareCommentThreadsOnEvent(SHARE_COMMENT_THREAD_EVENT, 'status_changed'), true)
  assert.equal(shouldReloadShareCommentThreadsOnEvent(SHARE_COMMENT_THREAD_EVENT, 'anchor_changed'), true)
  assert.equal(shouldReloadShareCommentThreadsOnEvent(SHARE_COMMENT_MESSAGE_EVENT, 'created'), true)
  assert.equal(shouldReloadShareCommentThreadsOnEvent(SHARE_COMMENT_MESSAGE_EVENT, 'deleted'), true)
  assert.equal(shouldReloadShareCommentThreadsOnEvent(SHARE_COMMENT_EVENT, 'created'), true)
})

test('无关 action 不刷新线程列表', () => {
  assert.equal(shouldReloadShareCommentThreadsOnEvent(SHARE_COMMENT_THREAD_EVENT, 'noop'), false)
})
