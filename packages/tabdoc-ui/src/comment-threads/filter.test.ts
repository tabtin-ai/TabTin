import { describe, expect, it } from 'vitest'
import {
  filterAnchoredCommentThreads,
  filterCommentThreads,
  filterDocumentScopeCommentThreads,
  partitionDetachedThreads,
} from './filter'
import type { CommentThread } from './types'

function thread(partial: Partial<CommentThread> & Pick<CommentThread, 'id' | 'status'>): CommentThread {
  return {
    document_id: 'doc-1',
    scope: 'text_range',
    anchor: { version: 1 },
    anchor_status: 'attached',
    created_at: null,
    updated_at: null,
    messages: [],
    ...partial,
  }
}

describe('filterCommentThreads', () => {
  const threads = [
    thread({ id: 'a', status: 'open' }),
    thread({ id: 'b', status: 'resolved' }),
    thread({ id: 'c', status: 'open' }),
  ]

  it('筛选 open / resolved / all', () => {
    expect(filterCommentThreads(threads, 'open').map((t) => t.id)).toEqual(['a', 'c'])
    expect(filterCommentThreads(threads, 'resolved').map((t) => t.id)).toEqual(['b'])
    expect(filterCommentThreads(threads, 'all').map((t) => t.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('scope filters', () => {
  it('右栏只要锚定线程，底栏只要全文线程', () => {
    const threads = [
      thread({ id: 'doc', status: 'open', scope: 'document' }),
      thread({ id: 'block', status: 'open', scope: 'block' }),
      thread({ id: 'range', status: 'open', scope: 'text_range' }),
    ]
    expect(filterAnchoredCommentThreads(threads).map((t) => t.id)).toEqual(['block', 'range'])
    expect(filterDocumentScopeCommentThreads(threads).map((t) => t.id)).toEqual(['doc'])
  })
})

describe('partitionDetachedThreads', () => {
  it('把 orphaned/detached 与 document 外失效锚点分开', () => {
    const threads = [
      thread({ id: 'ok', status: 'open', anchor_status: 'attached' }),
      thread({ id: 'orphan', status: 'open', anchor_status: 'orphaned' }),
      thread({ id: 'detached', status: 'open', anchor_status: 'detached' }),
      thread({ id: 'doc', status: 'open', scope: 'document', anchor_status: 'none' }),
    ]
    const { attached, detached } = partitionDetachedThreads(threads)
    expect(attached.map((t) => t.id)).toEqual(['ok', 'doc'])
    expect(detached.map((t) => t.id)).toEqual(['orphan', 'detached'])
  })
})
