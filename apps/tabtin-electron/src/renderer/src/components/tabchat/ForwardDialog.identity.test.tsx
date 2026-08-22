import React from 'react'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CONVERSATION_TYPE_GROUP, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

const { mockSendMessage } = vi.hoisted(() => ({
  mockSendMessage: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

vi.mock('@components/ui', () => ({
  Dialog: ({ open, children }: { open: boolean; children: React.ReactNode }) => open ? <>{children}</> : null,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}))

const conversations = [{
  id: 'group-1',
  organization_id: 'org-1',
  type: CONVERSATION_TYPE_GROUP,
  name: '产品群',
  avatar_url: '',
  member_count: 3,
  last_message_at: null,
  last_message_preview: '',
  unread_count: 0,
  created_at: '2026-08-04T00:00:00Z',
}]

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: { conversations: typeof conversations }) => unknown) => selector({ conversations }),
    { getState: () => ({ sendMessage: mockSendMessage }) },
  ),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: { selectedOrganization: { id: string } }) => unknown) =>
    selector({ selectedOrganization: { id: 'org-1' } }),
}))

vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (state: {
    profiles: Record<string, never>
    ensureProfiles: ReturnType<typeof vi.fn>
  }) => unknown) => selector({ profiles: {}, ensureProfiles: vi.fn() }),
}))

import { ForwardDialog } from './ForwardDialog'

const message: IMMessage = {
  id: 1,
  conversation_id: 'group-1',
  sender_id: 'sender-1',
  sender_name: '发送者',
  content: '测试消息',
  message_type: MESSAGE_TYPE_TEXT,
  reply_to_id: null,
  has_attachment: false,
  metadata: {
    client_request_id: 'source-request-id',
    message_ref: 'source-message-ref',
    custom_field: '不应继承',
    card: { type: 'resource', name: '应继承的展示卡片' },
  },
  created_at: '2026-08-04T00:00:00Z',
  is_deleted: false,
  reactions: {},
}

describe('ForwardDialog message identity', () => {
  beforeEach(() => {
    mockSendMessage.mockReset()
    mockSendMessage.mockResolvedValue(true)
  })
  afterEach(cleanup)

  it('转发会创建新消息身份，不复用源消息的稳定身份', async () => {
    render(<ForwardDialog isOpen onClose={vi.fn()} message={message} />)

    fireEvent.click(screen.getByText('产品群'))

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1))
    expect(mockSendMessage).toHaveBeenCalledWith(expect.objectContaining({
      convId: 'group-1',
      metadata: expect.objectContaining({
        card: { type: 'resource', name: '应继承的展示卡片' },
        forwarded_from: expect.objectContaining({ original_message_id: message.id }),
      }),
    }))
    const forwardedMetadata = mockSendMessage.mock.calls[0][0].metadata
    expect(forwardedMetadata).not.toHaveProperty('client_request_id')
    expect(forwardedMetadata).not.toHaveProperty('message_ref')
    expect(forwardedMetadata).not.toHaveProperty('custom_field')
  })

  it.each([
    ['Agent 实时终态', {
      kind: 'agent_final',
      agent_session_ref: '018f4b30-a7ad-7b32-b946-827ea2a26983',
      agent_progress: { stage: 'responding', index: 2, summary: '生成中' },
      stream_seq: 3,
      source_message_id: '42',
      tabtin_message_id: '43',
    }],
    ['TabTin 稳定引用', {
      kind: 'tabtin_ref',
      agent_session_ref: '018f4b30-a7ad-7b32-b946-827ea2a26983',
      tabtin_message_id: '43',
      business_projection_revision: '018f4b30-a7ad-7b32-b946-827ea2a26984',
    }],
  ])('转发%s时不继承源消息的运行态或引用态', async (_label, sourceMetadata) => {
    render(<ForwardDialog
      isOpen
      onClose={vi.fn()}
      message={{
        ...message,
        sender_type: 'agent',
        metadata: {
          ...sourceMetadata,
          mentioned_user_ids: ['user-2'],
          mentioned_agent_ids: ['agent-2'],
          mention_all: true,
          card: { type: 'resource', name: 'Agent 产物' },
        },
      }}
    />)

    fireEvent.click(screen.getByText('产品群'))

    await waitFor(() => expect(mockSendMessage).toHaveBeenCalledTimes(1))
    expect(mockSendMessage.mock.calls[0][0].metadata).toEqual({
      card: { type: 'resource', name: 'Agent 产物' },
      forwarded_from: expect.objectContaining({
        original_message_id: message.id,
        original_sender_id: message.sender_id,
      }),
    })
  })
})
