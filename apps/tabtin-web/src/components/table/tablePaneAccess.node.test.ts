import assert from 'node:assert/strict'
import test from 'node:test'
import {
  resolveTableOrganizationId,
  resolveTableReadonly,
} from './tablePaneAccess.ts'

test('viewer and commenter resources are readonly while editor resources stay writable', () => {
  assert.equal(resolveTableReadonly({ currentUserRole: 'viewer' }), true)
  assert.equal(resolveTableReadonly({ currentUserRole: 'commenter' }), true)
  assert.equal(resolveTableReadonly({ currentUserRole: 'editor' }), false)
  assert.equal(resolveTableReadonly({ currentUserRole: null }), false)
})

test('share, live collaboration and downgrade permissions can each force readonly', () => {
  assert.equal(resolveTableReadonly({ sharePermission: 'comment' }), true)
  assert.equal(resolveTableReadonly({ sharePermission: 'edit' }), false)
  assert.equal(resolveTableReadonly({ collabActive: true, collabCanEdit: false }), true)
  assert.equal(resolveTableReadonly({ collabActive: false, collabCanEdit: false }), false)
  assert.equal(resolveTableReadonly({ downgradeInsufficient: true }), true)
})

test('sharing uses the resource organization before the current shell organization', () => {
  assert.equal(resolveTableOrganizationId('resource-org', 'shell-org'), 'resource-org')
  assert.equal(resolveTableOrganizationId(null, 'shell-org'), 'shell-org')
  assert.equal(resolveTableOrganizationId('  ', 'shell-org'), 'shell-org')
})
