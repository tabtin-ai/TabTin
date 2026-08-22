import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveWebNotificationNavigateTarget } from './notificationTargetResolver.ts'

test('resolves a record comment mention into an exact comment-opening target', () => {
  assert.deepEqual(resolveWebNotificationNavigateTarget({
    id: 'notification-1',
    type: 'tabdata.comment.mention',
    organization_id: 'organization-1',
    space_id: 'space-1',
    metadata: {
      resource_type: 'table',
      resource_id: 'table-1',
      record_id: 'record-1',
      comment_id: 'comment-1',
    },
  }), {
    type: 'resource-shared',
    id: 'table-1',
    resourceType: 'table',
    recordId: 'record-1',
    commentId: 'comment-1',
    openComments: true,
    intentKey: 'notification-1',
    organizationId: 'organization-1',
    spaceId: 'space-1',
  })
})

test('accepts camelCase metadata and rejects a comment mention without a record', () => {
  const base = {
    id: 'notification-2',
    type: 'tabdata.comment.mention',
    organization_id: '',
    metadata: {
      resourceType: 'table',
      resourceId: 'table-2',
      recordId: 'record-2',
      commentId: 'comment-2',
      organizationId: 'organization-2',
      spaceId: 'space-2',
    },
  }
  const target = resolveWebNotificationNavigateTarget(base)
  assert.ok(target && 'recordId' in target)
  assert.equal(target.recordId, 'record-2')
  assert.equal(resolveWebNotificationNavigateTarget({
    ...base,
    metadata: { resource_type: 'table', resource_id: 'table-2' },
  }), undefined)
})
