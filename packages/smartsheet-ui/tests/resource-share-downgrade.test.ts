import assert from 'node:assert/strict'
import test from 'node:test'
import {
  hasLiveResourceAccess,
  resolveResourceShareDowngrade,
  shouldShowRemovedOverlay,
  type ResourceShareNotificationLike,
} from '../src/share-dialog/hooks/useResourceShareDowngrade'

function notif(
  partial: Partial<ResourceShareNotificationLike> & {
    id: string
    created_at: string
    action: string
  },
): ResourceShareNotificationLike {
  const { action, ...rest } = partial
  return {
    type: 'resource_shared',
    metadata: {
      resource_type: 'doc',
      resource_id: 'doc-1',
      resource_title: '未命名文档',
      action,
    },
    ...rest,
  }
}

test('resolveResourceShareDowngrade: 仅 removed 时显示遮罩', () => {
  const state = resolveResourceShareDowngrade('doc', 'doc-1', [
    notif({ id: 'n1', created_at: '2026-07-29T09:43:00.000Z', action: 'removed' }),
  ])
  assert.equal(state.isRemoved, true)
  assert.equal(state.removalAction, 'removed')
  assert.equal(state.sourceNotificationId, 'n1')
})

test('resolveResourceShareDowngrade: 先 removed 后 invited → 不遮罩', () => {
  const state = resolveResourceShareDowngrade('doc', 'doc-1', [
    notif({ id: 'n-removed', created_at: '2026-07-29T09:43:00.000Z', action: 'removed' }),
    notif({ id: 'n-invited', created_at: '2026-07-29T12:20:00.000Z', action: 'invited' }),
  ])
  assert.equal(state.isRemoved, false)
  assert.equal(state.removalAction, null)
  assert.equal(state.sourceNotificationId, null)
})

test('resolveResourceShareDowngrade: 先 removed 后 permission_changed → 不遮罩', () => {
  const state = resolveResourceShareDowngrade('doc', 'doc-1', [
    notif({ id: 'n-removed', created_at: '2026-07-29T09:43:00.000Z', action: 'removed' }),
    {
      id: 'n-changed',
      type: 'resource_shared',
      created_at: '2026-07-29T12:21:00.000Z',
      metadata: {
        resource_type: 'doc',
        resource_id: 'doc-1',
        action: 'permission_changed',
        permission_from: 'editor',
        permission_to: 'viewer',
        resource_title: '未命名文档',
      },
    },
  ])
  assert.equal(state.isRemoved, false)
  assert.equal(state.changedPermission, 'viewer')
  assert.equal(state.changedFromPermission, 'editor')
  assert.equal(state.sourceNotificationId, 'n-changed')
})

test('resolveResourceShareDowngrade: 最新仍是 removed → 遮罩', () => {
  const state = resolveResourceShareDowngrade('doc', 'doc-1', [
    notif({ id: 'n-invited', created_at: '2026-07-29T08:00:00.000Z', action: 'invited' }),
    notif({ id: 'n-removed', created_at: '2026-07-29T09:43:00.000Z', action: 'removed' }),
  ])
  assert.equal(state.isRemoved, true)
  assert.equal(state.sourceNotificationId, 'n-removed')
})

test('resolveResourceShareDowngrade: auto_removed 与 removed 同口径', () => {
  const state = resolveResourceShareDowngrade('doc', 'doc-1', [
    notif({ id: 'n1', created_at: '2026-07-29T09:43:00.000Z', action: 'auto_removed' }),
  ])
  assert.equal(state.isRemoved, true)
  assert.equal(state.removalAction, 'auto_removed')
})

test('hasLiveResourceAccess: viewer+/owner 为真', () => {
  assert.equal(hasLiveResourceAccess('viewer'), true)
  assert.equal(hasLiveResourceAccess('editor'), true)
  assert.equal(hasLiveResourceAccess('admin'), true)
  assert.equal(hasLiveResourceAccess('owner'), true)
  assert.equal(hasLiveResourceAccess(null), false)
  assert.equal(hasLiveResourceAccess(undefined), false)
  assert.equal(hasLiveResourceAccess(''), false)
})

test('shouldShowRemovedOverlay: 陈旧 role 不压住实时 removed', () => {
  assert.equal(
    shouldShowRemovedOverlay({
      isRemoved: true,
      role: 'editor',
      removedAt: '2026-07-29T12:00:00.000Z',
      roleFetchedAtMs: Date.parse('2026-07-29T11:00:00.000Z'),
    }),
    true,
  )
})

test('shouldShowRemovedOverlay: 通知之后重新确认 viewer+ → 不遮罩', () => {
  assert.equal(
    shouldShowRemovedOverlay({
      isRemoved: true,
      role: 'viewer',
      removedAt: '2026-07-29T12:00:00.000Z',
      roleFetchedAtMs: Date.parse('2026-07-29T12:05:00.000Z'),
    }),
    false,
  )
})

test('shouldShowRemovedOverlay: 无 live role → 遮罩', () => {
  assert.equal(
    shouldShowRemovedOverlay({
      isRemoved: true,
      role: null,
      removedAt: '2026-07-29T12:00:00.000Z',
      roleFetchedAtMs: Date.parse('2026-07-29T12:05:00.000Z'),
    }),
    true,
  )
})
