import assert from 'node:assert/strict'
import test from 'node:test'
import {
  isRecordRequestCurrent,
  matchesPendingRecordCommentSubmit,
} from './shared-record-comments-state.ts'

const pending = {
  recordId: 'record-1',
  content: 'Retry safely',
  mentionUserIds: ['user-1'],
  clientRequestId: 'request-original',
}

test('an unchanged normal submit matches the pending idempotency request', () => {
  assert.equal(matchesPendingRecordCommentSubmit(pending, {
    recordId: 'record-1',
    content: 'Retry safely',
    mentionUserIds: ['user-1'],
  }), true)
})

test('editing content, mentions, or reply target starts a distinct idempotency request', () => {
  assert.equal(matchesPendingRecordCommentSubmit(pending, {
    recordId: 'record-1',
    content: 'Changed',
    mentionUserIds: ['user-1'],
  }), false)
  assert.equal(matchesPendingRecordCommentSubmit(pending, {
    recordId: 'record-1',
    content: 'Retry safely',
    mentionUserIds: ['user-2'],
  }), false)
  assert.equal(matchesPendingRecordCommentSubmit(pending, {
    recordId: 'record-1',
    content: 'Retry safely',
    mentionUserIds: ['user-1'],
    replyToCommentId: 'comment-parent',
  }), false)
})

test('a mutation for the previous record cannot invalidate the active record request', () => {
  assert.equal(isRecordRequestCurrent('record-2', 'record-1'), false)
  assert.equal(isRecordRequestCurrent('record-2', 'record-2'), true)
})
