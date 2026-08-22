/**
 * 分享页评论 UI 策略：权限 / 能力回退 / 渲染模式（纯函数口径，供 Task 5 验收）。
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { canAccessShareComments } from './shareCommentPermission.ts'

/** 与 tabdoc-ui COMMENT_RAIL_BREAKPOINT_PX 对齐 */
const COMMENT_RAIL_BREAKPOINT_PX = 1180

export type CapabilityMode = 'loading' | 'threads' | 'legacy'

export function resolveShareCommentUi(input: {
  permission: string
  capabilityMode: CapabilityMode
  viewportWidth: number
}): {
  fetchThreads: boolean
  fetchLegacyComments: boolean
  selectableReadonly: boolean
  showThreadHost: boolean
  showLegacyComments: boolean
  railLayout: 'rail' | 'drawer'
} {
  const canComment = canAccessShareComments(input.permission)
  const showThreadHost = canComment && input.capabilityMode !== 'legacy'
  const showLegacyComments = canComment && input.capabilityMode === 'legacy'
  return {
    fetchThreads: showThreadHost,
    fetchLegacyComments: showLegacyComments,
    selectableReadonly: canComment && input.permission === 'comment',
    showThreadHost,
    showLegacyComments,
    railLayout: input.viewportWidth >= COMMENT_RAIL_BREAKPOINT_PX ? 'rail' : 'drawer',
  }
}

test('view：不请求线程也不请求旧评论', () => {
  const ui = resolveShareCommentUi({
    permission: 'view',
    capabilityMode: 'loading',
    viewportWidth: 1400,
  })
  assert.equal(ui.fetchThreads, false)
  assert.equal(ui.fetchLegacyComments, false)
  assert.equal(ui.showThreadHost, false)
  assert.equal(ui.selectableReadonly, false)
})

test('comment：loading/threads 挂线程宿主且可选中只读', () => {
  const loading = resolveShareCommentUi({
    permission: 'comment',
    capabilityMode: 'loading',
    viewportWidth: 1400,
  })
  assert.equal(loading.fetchThreads, true)
  assert.equal(loading.selectableReadonly, true)
  assert.equal(loading.railLayout, 'rail')

  const threads = resolveShareCommentUi({
    permission: 'comment',
    capabilityMode: 'threads',
    viewportWidth: 900,
  })
  assert.equal(threads.showThreadHost, true)
  assert.equal(threads.showLegacyComments, false)
  assert.equal(threads.railLayout, 'drawer')
})

test('edit：能力缺失回退旧 comments', () => {
  const ui = resolveShareCommentUi({
    permission: 'edit',
    capabilityMode: 'legacy',
    viewportWidth: 1200,
  })
  assert.equal(ui.fetchThreads, false)
  assert.equal(ui.fetchLegacyComments, true)
  assert.equal(ui.showLegacyComments, true)
  assert.equal(ui.selectableReadonly, false)
})
