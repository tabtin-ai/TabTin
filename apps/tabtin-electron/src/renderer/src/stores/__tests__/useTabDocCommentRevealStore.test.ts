import { beforeEach, describe, expect, it } from 'vitest'

import { useTabDocCommentRevealStore } from '../useTabDocCommentRevealStore'

describe('useTabDocCommentRevealStore', () => {
  beforeEach(() => {
    useTabDocCommentRevealStore.setState({ pendingByDocumentId: {} })
  })

  it('replaces a request with a new identity and guards consumption', () => {
    const store = useTabDocCommentRevealStore.getState()

    store.requestCommentReveal('doc-1', {
      threadId: 'thread-1',
      commentId: 'comment-1',
    })
    const first = useTabDocCommentRevealStore.getState().pendingByDocumentId['doc-1']

    store.requestCommentReveal('doc-1', {
      threadId: 'thread-2',
      commentId: 'comment-2',
    })
    const second = useTabDocCommentRevealStore.getState().pendingByDocumentId['doc-1']

    expect(first).toMatchObject({ threadId: 'thread-1', commentId: 'comment-1' })
    expect(second).toMatchObject({ threadId: 'thread-2', commentId: 'comment-2' })
    expect(second?.requestId).not.toBe(first?.requestId)

    store.consumeCommentReveal('doc-1', first?.requestId ?? -1)
    expect(useTabDocCommentRevealStore.getState().pendingByDocumentId['doc-1']).toEqual(second)

    store.consumeCommentReveal('doc-1', second?.requestId ?? -1)
    expect(useTabDocCommentRevealStore.getState().pendingByDocumentId['doc-1']).toBeUndefined()
  })
})
