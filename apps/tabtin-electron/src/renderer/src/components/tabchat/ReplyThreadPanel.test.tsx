import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'
import { useResourcePreviewStore } from '@components/chat/preview/useResourcePreviewStore'

const attachmentState = {
  statuses: {} as Record<string, { status: 'available'; downloadUrl: string | null }>,
  ensureChecked: vi.fn(),
}

vi.mock('@stores/useFileAttachmentStore', () => ({
  useFileAttachmentStore: Object.assign(
    (selector: (state: typeof attachmentState) => unknown) => selector(attachmentState),
    {
      getState: () => ({
        ...attachmentState,
        statuses: attachmentState.statuses,
        resolveDownloadUrl: vi.fn(async () => ''),
        markUnavailable: vi.fn(),
        reset: vi.fn(),
      }),
    },
  ),
}))

vi.mock('@/services/tabchatApi', () => ({
  getMessages: vi.fn(async () => []),
  getMessageAttachmentDownloadUrl: vi.fn(),
}))

function buildMessage(overrides: Partial<IMMessage>): IMMessage {
  return {
    id: 1,
    conversation_id: 'conv-1',
    sender_id: 'user-1',
    content: '一条消息',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-07-20T10:00:00Z',
    ...overrides,
  }
}

describe('ReplyThreadPanel', () => {
  it('被撤回的图片在回复详情中显示内容不可用', async () => {
    attachmentState.statuses = {
      1: { status: 'available', downloadUrl: 'https://example.com/recalled-image.png' },
    }
    const { ReplyThreadPanel } = await import('./ReplyThreadPanel')
    render(
      <ReplyThreadPanel
        root={buildMessage({
          message_type: MESSAGE_TYPE_IMAGE,
          content: '',
          has_attachment: true,
          is_deleted: true,
        })}
        replies={[]}
        isOpen
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByText('消息内容不可用')).toBeTruthy()
    expect(screen.queryByText('图片')).toBeNull()
    expect(screen.queryByRole('img')).toBeNull()
  })

  it('在侧栏展示已加载图片，加载失败时降级为图片文字', async () => {
    attachmentState.statuses = { 1: { status: 'available', downloadUrl: 'https://example.com/image.png' } }
    useResourcePreviewStore.getState().close()
    const { ReplyThreadPanel } = await import('./ReplyThreadPanel')
    render(
      <ReplyThreadPanel
        root={buildMessage({
          message_type: MESSAGE_TYPE_IMAGE,
          content: '',
          has_attachment: true,
          metadata: { file_name: '截图.png', file_id: 'file-1' },
        })}
        replies={[]}
        isOpen
        onClose={vi.fn()}
      />,
    )

    const image = screen.getByRole('img', { name: '截图.png' })
    expect(image.getAttribute('src')).toBe('https://example.com/image.png')

    fireEvent.click(image)
    expect(useResourcePreviewStore.getState().isOpen).toBe(true)
    expect(useResourcePreviewStore.getState().resources[0]).toMatchObject({
      kind: 'image',
      url: 'https://example.com/image.png',
      name: '截图.png',
    })

    fireEvent.error(image)
    expect(screen.getByText('图片')).toBeTruthy()
    useResourcePreviewStore.getState().close()
  })

  it('在回复详情同时展示图片消息的图片和文本', async () => {
    attachmentState.statuses = { 1: { status: 'available', downloadUrl: 'https://example.com/image.png' } }
    const { ReplyThreadPanel } = await import('./ReplyThreadPanel')
    render(
      <ReplyThreadPanel
        root={buildMessage({
          message_type: MESSAGE_TYPE_IMAGE,
          content: '测试文案',
          has_attachment: true,
          metadata: { file_name: '测试图片.png', file_id: 'file-1' },
        })}
        replies={[]}
        isOpen
        onClose={vi.fn()}
      />,
    )

    expect(screen.getByRole('img', { name: '测试图片.png' })).toBeTruthy()
    expect(screen.getByText('测试文案')).toBeTruthy()
  })
})
