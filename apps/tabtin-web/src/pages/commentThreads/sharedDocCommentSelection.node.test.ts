import assert from 'node:assert/strict'
import test from 'node:test'
import { selectSharedDocCommentThread } from './sharedDocCommentSelection.ts'

function createActions(calls: string[]) {
  return {
    selectDocumentThread: (threadId: string) => calls.push(`document:${threadId}`),
    selectAnchoredThread: (threadId: string) => calls.push(`anchored:${threadId}`),
    closeRail: () => calls.push('close-rail'),
    openRail: () => calls.push('open-rail'),
    focusAnchor: (threadId: string) => calls.push(`focus:${threadId}`),
  }
}

test('全文评论只更新底部选中态，不影响正文批注栏', () => {
  const calls: string[] = []

  selectSharedDocCommentThread(
    { id: 'document-thread', scope: 'document' },
    createActions(calls),
  )

  assert.deepEqual(calls, ['document:document-thread', 'close-rail'])
})

test('selection 与 block 评论继续打开并定位正文批注栏', () => {
  for (const scope of ['text_range', 'block'] as const) {
    const calls: string[] = []

    selectSharedDocCommentThread(
      { id: `${scope}-thread`, scope },
      createActions(calls),
    )

    assert.deepEqual(calls, [
      `anchored:${scope}-thread`,
      'open-rail',
      `focus:${scope}-thread`,
    ])
  }
})
