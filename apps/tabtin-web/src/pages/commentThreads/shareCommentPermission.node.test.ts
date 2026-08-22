import assert from 'node:assert/strict'
import test from 'node:test'
import {
  canAccessShareComments,
  canEditShareDocument,
  needsSelectableReadonlyShareEditor,
} from './shareCommentPermission.ts'

test('view 不可读评论', () => {
  assert.equal(canAccessShareComments('view'), false)
})

test('comment / edit 可读评论', () => {
  assert.equal(canAccessShareComments('comment'), true)
  assert.equal(canAccessShareComments('edit'), true)
})

test('仅 edit 可改正文', () => {
  assert.equal(canEditShareDocument('edit'), true)
  assert.equal(canEditShareDocument('comment'), false)
  assert.equal(canEditShareDocument('view'), false)
})

test('comment 需要可选中只读编辑器', () => {
  assert.equal(needsSelectableReadonlyShareEditor('comment'), true)
  assert.equal(needsSelectableReadonlyShareEditor('edit'), false)
  assert.equal(needsSelectableReadonlyShareEditor('view'), false)
})
