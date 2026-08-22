import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { CommentThread } from '../../comment-threads/types'
import { CommentThreadCard } from './CommentThreadCard'

function sampleThread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: 'thread-1',
    document_id: 'doc-1',
    scope: 'block',
    status: 'open',
    anchor_status: 'attached',
    anchor: { version: 1, block_ids: ['b1'], block_type: 'paragraph' },
    selected_text: 'hello',
    resolved_at: null,
    resolved_by_user_id: null,
    created_at: '2026-08-06T00:00:00Z',
    updated_at: '2026-08-06T00:00:00Z',
    messages: [{
      id: 'msg-1',
      thread_id: 'thread-1',
      kind: 'root',
      body: '第一条',
      author_user_id: 'user-1',
      author_name: 'Alice',
      author_avatar: null,
      mention_user_ids: [],
      attachments: [],
      is_deleted: false,
      created_at: '2026-08-06T00:00:00Z',
      updated_at: '2026-08-06T00:00:00Z',
    }],
    ...overrides,
  }
}

describe('CommentThreadCard confirms', () => {
  it('图片评论展示引用内容', () => {
    render(
      <CommentThreadCard
        thread={sampleThread({
          scope: 'block',
          anchor: {
            version: 1,
            block_ids: ['image-paragraph'],
            block_type: 'image',
            selected_text: '图片：diagram.png',
          },
          selected_text: '图片：diagram.png',
        })}
      />,
    )

    expect(screen.getByText('图片：diagram.png')).toBeTruthy()
  })

  it('本地解析失效的评论提示锚点已失效', () => {
    render(
      <CommentThreadCard
        thread={sampleThread({ anchor_status: 'detached' })}
      />,
    )

    expect(screen.getByText('锚点已失效')).toBeTruthy()
  })

  it('点击回复后才展示并聚焦回复输入框', async () => {
    const onSelect = vi.fn()
    render(
      <CommentThreadCard
        thread={sampleThread()}
        labels={{ reply: '回复', replyPlaceholder: '写下回复…' }}
        replyValue=""
        onSelect={onSelect}
        onReplyValueChange={vi.fn()}
        onReply={vi.fn(async () => undefined)}
      />,
    )

    expect(screen.queryByTestId('comment-composer')).toBeNull()
    fireEvent.click(screen.getByTestId('comment-message-reply'))

    const input = screen.getByRole('textbox', { name: '写下回复…' })
    expect(screen.getByTestId('comment-composer')).toBeTruthy()
    await waitFor(() => expect(document.activeElement).toBe(input))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('点击取消后清空草稿并收起回复输入框', () => {
    const onReplyValueChange = vi.fn()
    render(
      <CommentThreadCard
        thread={sampleThread()}
        labels={{ reply: '回复', cancel: '取消' }}
        replyValue="未发送的回复"
        onReplyValueChange={onReplyValueChange}
        onReply={vi.fn(async () => undefined)}
      />,
    )

    fireEvent.click(screen.getByTestId('comment-message-reply'))
    expect(screen.getByTestId('comment-composer')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '取消' }))

    expect(onReplyValueChange).toHaveBeenCalledWith('')
    expect(screen.queryByTestId('comment-composer')).toBeNull()
  })

  it('删除前弹出确认，确认后才调用 onDeleteMessage', async () => {
    const onDeleteMessage = vi.fn(async () => undefined)
    const onSelect = vi.fn()
    render(
      <CommentThreadCard
        thread={sampleThread()}
        currentUserId="user-1"
        onSelect={onSelect}
        onDeleteMessage={onDeleteMessage}
      />,
    )

    fireEvent.click(screen.getByTestId('comment-message-delete'))
    expect(onDeleteMessage).not.toHaveBeenCalled()
    expect(screen.getByText('删除这条评论？')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认删除' }))
    await waitFor(() => {
      expect(onDeleteMessage).toHaveBeenCalledWith('thread-1', 'msg-1')
    })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('解决前弹出确认，确认后才调用 onResolve', async () => {
    const onResolve = vi.fn(async () => undefined)
    const onSelect = vi.fn()
    render(
      <CommentThreadCard
        thread={sampleThread()}
        onSelect={onSelect}
        onResolve={onResolve}
      />,
    )

    fireEvent.click(screen.getByTestId('comment-thread-resolve'))
    expect(onResolve).not.toHaveBeenCalled()
    expect(screen.getByText('标记为已解决？')).toBeTruthy()

    fireEvent.click(screen.getByRole('button', { name: '确认解决' }))
    await waitFor(() => {
      expect(onResolve).toHaveBeenCalledWith('thread-1')
    })
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('重开评论不会触发卡片选择', async () => {
    const onReopen = vi.fn(async () => undefined)
    const onSelect = vi.fn()
    render(
      <CommentThreadCard
        thread={sampleThread({ status: 'resolved' })}
        onSelect={onSelect}
        onReopen={onReopen}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '重开' }))

    await waitFor(() => expect(onReopen).toHaveBeenCalledWith('thread-1'))
    expect(onSelect).not.toHaveBeenCalled()
  })

  it('点击图片先换签，再把新地址交给宿主应用内预览', async () => {
    const onRefreshAttachmentPreview = vi.fn(async () => 'https://oss.example/new-signature')
    const onSelect = vi.fn()
    const onOpenAttachmentPreview = vi.fn(async () => undefined)
    const openSpy = vi.spyOn(window, 'open')
    const attachment = {
      id: 'attachment-1',
      file_id: 'file-1',
      type: 'image' as const,
      metadata: { file_name: 'proof.png' },
      preview_url: 'https://oss.example/expired-signature',
    }
    const thread = sampleThread({
      messages: [{
        ...sampleThread().messages[0]!,
        attachments: [attachment],
      }],
    })

    render(
      <CommentThreadCard
        thread={thread}
        onSelect={onSelect}
        onRefreshAttachmentPreview={onRefreshAttachmentPreview}
        onOpenAttachmentPreview={onOpenAttachmentPreview}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'proof.png' }))

    await waitFor(() => {
      expect(onRefreshAttachmentPreview).toHaveBeenCalledWith('file-1')
      expect(onOpenAttachmentPreview).toHaveBeenCalledWith({
        attachment,
        attachments: [attachment],
        previewUrl: 'https://oss.example/new-signature',
      })
    })
    expect(openSpy).not.toHaveBeenCalled()
    expect(onSelect).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('多图评论把点击项和同消息附件组一起交给宿主', async () => {
    const onOpenAttachmentPreview = vi.fn(async () => undefined)
    const attachments = [
      {
        id: 'attachment-1',
        file_id: 'file-1',
        type: 'image' as const,
        metadata: { file_name: 'first.png' },
        preview_url: 'https://oss.example/first',
      },
      {
        id: 'attachment-2',
        file_id: 'file-2',
        type: 'image' as const,
        metadata: { file_name: 'second.png' },
        preview_url: 'https://oss.example/second',
      },
    ]
    const thread = sampleThread({
      messages: [{ ...sampleThread().messages[0]!, attachments }],
    })

    render(
      <CommentThreadCard
        thread={thread}
        onOpenAttachmentPreview={onOpenAttachmentPreview}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'second.png' }))

    await waitFor(() => {
      expect(onOpenAttachmentPreview).toHaveBeenCalledWith({
        attachment: attachments[1],
        attachments,
        previewUrl: 'https://oss.example/second',
      })
    })
  })

  it('非图片附件继续换签后按原行为在新窗口打开', async () => {
    const onRefreshAttachmentPreview = vi.fn(async () => 'https://oss.example/new-file-signature')
    const onOpenAttachmentPreview = vi.fn(async () => undefined)
    const onSelect = vi.fn()
    const replace = vi.fn()
    const popup = { location: { replace }, close: vi.fn() }
    const openSpy = vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window)
    const thread = sampleThread({
      messages: [{
        ...sampleThread().messages[0]!,
        attachments: [{
          id: 'attachment-1',
          file_id: 'file-1',
          type: 'file',
          metadata: { file_name: 'notes.txt' },
          preview_url: 'https://oss.example/expired-file-signature',
        }],
      }],
    })

    render(
      <CommentThreadCard
        thread={thread}
        onSelect={onSelect}
        onRefreshAttachmentPreview={onRefreshAttachmentPreview}
        onOpenAttachmentPreview={onOpenAttachmentPreview}
      />,
    )
    fireEvent.click(screen.getByRole('link', { name: 'notes.txt' }))

    await waitFor(() => {
      expect(onRefreshAttachmentPreview).toHaveBeenCalledWith('file-1')
      expect(replace).toHaveBeenCalledWith('https://oss.example/new-file-signature')
    })
    expect(onSelect).not.toHaveBeenCalled()
    expect(onOpenAttachmentPreview).not.toHaveBeenCalled()
    openSpy.mockRestore()
  })

  it('滚动并高亮通知指定的评论消息', async () => {
    const scrollIntoView = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: scrollIntoView,
    })
    const firstMessage = sampleThread().messages[0]!
    const thread = sampleThread({
      messages: [
        firstMessage,
        {
          ...firstMessage,
          id: 'msg-2',
          kind: 'reply',
          body: '@Bob 请看这里',
        },
      ],
    })

    render(<CommentThreadCard thread={thread} focusMessageId="msg-2" />)

    const focusedMessage = screen.getByTestId('comment-message-msg-2')
    await waitFor(() => expect(scrollIntoView).toHaveBeenCalledWith({ block: 'nearest' }))
    expect(focusedMessage.getAttribute('data-notification-focus')).toBe('true')
    expect(screen.getByTestId('comment-message-msg-1').getAttribute('data-notification-focus')).toBe('false')
  })
})
