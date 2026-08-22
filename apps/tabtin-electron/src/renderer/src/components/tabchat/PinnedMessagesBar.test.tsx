import React from 'react'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

const { state, mockNavigate, mockUnpinStore, mockLoadPinned, mockUnpinApi } = vi.hoisted(() => ({
  state: { value: {} as Record<string, IMMessage[]> },
  mockNavigate: vi.fn(),
  mockUnpinStore: vi.fn(),
  mockLoadPinned: vi.fn(),
  mockUnpinApi: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, string>) => opts?.defaultValue ?? key }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (s: { pinnedMessages: Record<string, IMMessage[]> }) => unknown) =>
      selector({ pinnedMessages: state.value }),
    {
      getState: () => ({
        navigateToMessage: mockNavigate,
        onMessageUnpinned: mockUnpinStore,
        loadPinnedMessages: mockLoadPinned,
      }),
    },
  ),
}))

vi.mock('@/services/tabchatApi', () => ({
  unpinMessage: (...args: unknown[]) => mockUnpinApi(...args),
}))

function pinned(id: number, content: string, sender = 'Alice'): IMMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: 'u1',
    sender_name: sender,
    content,
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-06-24T00:00:00Z',
    is_pinned: true,
  }
}

describe('PinnedMessagesBar (功能3)', () => {
  beforeEach(() => {
    state.value = {}
    mockNavigate.mockReset()
    mockUnpinStore.mockReset()
    mockUnpinApi.mockReset().mockResolvedValue(undefined)
  })

  it('renders nothing when there are no pinned messages', async () => {
    const { PinnedMessagesBar } = await import('./PinnedMessagesBar')
    const { container } = render(<PinnedMessagesBar conversationId="conv-1" canManage />)
    expect(container.firstChild).toBeNull()
  })

  it('shows latest pinned message and jumps on click when single', async () => {
    const message = pinned(10, 'Hello pin')
    state.value = { 'conv-1': [message] }
    const { PinnedMessagesBar } = await import('./PinnedMessagesBar')
    render(<PinnedMessagesBar conversationId="conv-1" canManage={false} />)
    expect(screen.getByText(/Hello pin/)).toBeTruthy()
    fireEvent.click(screen.getByText(/Hello pin/))
    expect(mockNavigate).toHaveBeenCalledWith('conv-1', message)
  })

  it('expands list when multiple and jumps to a chosen one', async () => {
    state.value = { 'conv-1': [pinned(11, 'second'), pinned(10, 'first')] }
    const { PinnedMessagesBar } = await import('./PinnedMessagesBar')
    render(<PinnedMessagesBar conversationId="conv-1" canManage={false} />)
    // 顶条显示最近一条 + 计数 2，点击展开
    fireEvent.click(screen.getByText(/second/))
    fireEvent.click(screen.getByText('first'))
    expect(mockNavigate).toHaveBeenCalledWith('conv-1', state.value['conv-1'][1])
  })

  it('updates the store only after Tencent confirms unpinning', async () => {
    let resolveUnpin!: () => void
    mockUnpinApi.mockReturnValueOnce(new Promise<void>((resolve) => {
      resolveUnpin = resolve
    }))
    state.value = { 'conv-1': [pinned(10, 'Hello pin')] }
    const { PinnedMessagesBar } = await import('./PinnedMessagesBar')
    render(<PinnedMessagesBar conversationId="conv-1" canManage />)
    fireEvent.click(screen.getByTitle('取消置顶'))
    expect(mockUnpinApi).toHaveBeenCalledWith('conv-1', state.value['conv-1'][0])
    expect(mockUnpinStore).not.toHaveBeenCalled()

    resolveUnpin()
    await waitFor(() => {
      expect(mockUnpinStore).toHaveBeenCalledWith('conv-1', 10)
    })
  })
})
