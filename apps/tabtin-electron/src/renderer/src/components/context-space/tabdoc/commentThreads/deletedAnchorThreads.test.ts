import { describe, expect, it } from 'vitest'
import type { CommentThread } from '@tabtin/tabdoc-ui/api-client'
import { findDeletedAnchorThreadIds } from './deletedAnchorThreads'

function thread(id: string, scope: CommentThread['scope'] = 'text_range'): CommentThread {
  return { id, scope } as CommentThread
}

describe('findDeletedAnchorThreadIds', () => {
  it('只返回从有效范围变为空范围的锚点评论', () => {
    const previous = new Map([
      ['collapsed', 'attached'],
      ['still-attached', 'attached'],
    ] as const)
    const current = new Map([
      ['collapsed', 'detached'],
      ['still-attached', 'attached'],
      ['initially-detached', 'detached'],
    ] as const)

    expect(findDeletedAnchorThreadIds(previous, current, [
      thread('collapsed'),
      thread('still-attached'),
      thread('initially-detached'),
      thread('document', 'document'),
    ])).toEqual(['collapsed'])
  })
})
