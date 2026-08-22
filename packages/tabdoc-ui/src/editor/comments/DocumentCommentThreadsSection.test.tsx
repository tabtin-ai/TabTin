import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CommentThread } from '../../comment-threads/types'
import { DocumentCommentThreadsSection } from './DocumentCommentThreadsSection'

function thread(id: string, scope: CommentThread['scope']): CommentThread {
  return {
    id,
    document_id: 'doc-1',
    scope,
    status: 'open',
    anchor_status: 'attached',
    anchor: scope === 'document'
      ? { version: 1 }
      : { version: 1, block_ids: ['block-1'], block_type: 'paragraph' },
    selected_text: scope === 'document' ? '' : '正文引用',
    resolved_at: null,
    resolved_by_user_id: null,
    created_at: '2026-08-14T00:00:00Z',
    updated_at: '2026-08-14T00:00:00Z',
    messages: [{
      id: `message-${id}`,
      thread_id: id,
      kind: 'root',
      body: `${id} 内容`,
      author_user_id: 'user-1',
      author_name: 'Alice',
      author_avatar: null,
      mention_user_ids: [],
      attachments: [],
      is_deleted: false,
      created_at: '2026-08-14T00:00:00Z',
      updated_at: '2026-08-14T00:00:00Z',
    }],
  }
}

describe('DocumentCommentThreadsSection', () => {
  it('只展示全文评论，并把卡片选择留给底部区域的选择回调', () => {
    const onSelectThread = vi.fn()

    render(
      <DocumentCommentThreadsSection
        threads={[
          thread('document-thread', 'document'),
          thread('block-thread', 'block'),
        ]}
        activeThreadId="document-thread"
        onSelectThread={onSelectThread}
      />,
    )

    const card = screen.getByTestId('comment-thread-card')
    expect(card.dataset.threadId).toBe('document-thread')
    expect(card.dataset.active).toBe('true')

    fireEvent.click(card)

    expect(onSelectThread).toHaveBeenCalledOnce()
    expect(onSelectThread).toHaveBeenCalledWith('document-thread')
  })
})
