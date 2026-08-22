import assert from 'node:assert/strict'
import test from 'node:test'
import { resolveSharedTableAccess } from './sharedTableAccess.ts'

test('comment 分享使用分享限定的只读记录详情，不进入普通表格工作台', () => {
  assert.deepEqual(
    resolveSharedTableAccess({
      shareType: 'data', permission: 'comment', requiresLogin: false, isAuthenticated: true,
    }),
    {
      requiresLogin: false,
      useWorkspace: false,
      canOpenRecordDetail: true,
      canComment: true,
      canEdit: false,
      showLoginToEdit: false,
    },
  )
})

test('edit 分享保持现有完整工作台', () => {
  assert.deepEqual(
    resolveSharedTableAccess({
      shareType: 'data', permission: 'edit', requiresLogin: true, isAuthenticated: true,
    }),
    {
      requiresLogin: false,
      useWorkspace: true,
      canOpenRecordDetail: true,
      canComment: true,
      canEdit: true,
      showLoginToEdit: false,
    },
  )
})

test('匿名 comment 分享保持旧客户端可读，但不开放详情评论入口', () => {
  assert.deepEqual(
    resolveSharedTableAccess({
      shareType: 'data', permission: 'comment', requiresLogin: false, isAuthenticated: false,
    }),
    {
      requiresLogin: false,
      useWorkspace: false,
      canOpenRecordDetail: false,
      canComment: false,
      canEdit: false,
      showLoginToEdit: false,
    },
  )
})

test('公开 edit 分享允许匿名读取并展示登录编辑入口，但不开放评论或编辑能力', () => {
  assert.deepEqual(
    resolveSharedTableAccess({
      shareType: 'data', permission: 'edit', requiresLogin: true, isAuthenticated: false,
    }),
    {
      requiresLogin: false,
      useWorkspace: false,
      canOpenRecordDetail: false,
      canComment: false,
      canEdit: false,
      showLoginToEdit: true,
    },
  )
})

test('view 分享始终使用只读展示且不开放评论', () => {
  for (const isAuthenticated of [false, true]) {
    assert.deepEqual(
      resolveSharedTableAccess({
        shareType: 'data', permission: 'view', requiresLogin: false, isAuthenticated,
      }),
      {
        requiresLogin: false,
        useWorkspace: false,
        canOpenRecordDetail: false,
        canComment: false,
        canEdit: false,
        showLoginToEdit: false,
      },
    )
  }
})

test('组织限定的 view 分享仍先要求匿名用户登录', () => {
  assert.equal(
    resolveSharedTableAccess({
      shareType: 'organization',
      permission: 'view',
      requiresLogin: false,
      isAuthenticated: false,
    }).requiresLogin,
    true,
  )
})
