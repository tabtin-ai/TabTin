import assert from 'node:assert/strict'
import test from 'node:test'
import {
  appendRecordCommentRouteIntent,
  clearRecordCommentRouteIntent,
  parseRecordCommentRouteIntent,
} from './recordCommentRouteIntent.ts'

test('round-trips an exact record-comment intent without losing unrelated route state', () => {
  const url = appendRecordCommentRouteIntent('/tables/table-1?view=kanban#field', {
    recordId: 'record/1',
    commentId: 'comment/1',
    intentKey: 'notification-1',
  })
  const [, searchAndHash = ''] = url.split('?', 2)
  const [search = ''] = searchAndHash.split('#', 1)

  assert.deepEqual(parseRecordCommentRouteIntent(search), {
    recordId: 'record/1',
    commentId: 'comment/1',
    intentKey: 'notification-1',
  })
  assert.equal(clearRecordCommentRouteIntent(search), '?view=kanban')
  assert.match(url, /#field$/)
})

test('ignores partial or already-consumed intents', () => {
  assert.equal(parseRecordCommentRouteIntent('?recordId=record-1'), null)
  assert.equal(parseRecordCommentRouteIntent('?openComments=1'), null)
})
