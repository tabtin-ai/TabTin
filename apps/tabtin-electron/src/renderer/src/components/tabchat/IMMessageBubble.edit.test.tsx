import React from 'react'
import { act, render, screen, fireEvent, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_FILE, MESSAGE_TYPE_IMAGE, MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage, MessageReadReceipts } from '@/services/tabchatApi'

const {
  mockCreateConversationAndActivate,
  mockGetMessageReadReceipts,
  mockNavigateToMessage,
} = vi.hoisted(() => ({
  mockCreateConversationAndActivate: vi.fn().mockResolvedValue('dm-1'),
  mockGetMessageReadReceipts: vi.fn().mockResolvedValue({ readers: [], unreaders: [] }),
  mockNavigateToMessage: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: Record<string, string>) => opts?.defaultValue ?? key }),
}))
vi.mock('react-markdown', () => ({ default: ({ children }: { children: React.ReactNode }) => <>{children}</> }))
// ：homeRegistry glob 会误加载 *.test.tsx；进气泡前先挡住。
vi.mock('@components/context-space/registry/homeRegistry', () => ({}))
vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: vi.fn(),
}))
vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn() }),
  // TeamSpaceCreateTaskDialog → table-ui 会再取这个导出；缺了整文件 import 即红。
  resolveChoiceTagColors: () => ({ bg: '', text: '', border: '' }),
}))
vi.mock('./downloadImAttachment', () => ({ downloadImAttachment: vi.fn() }))
vi.mock('@/services/openResourceLink', () => ({ handleResourceLinkClick: vi.fn(), handleResourceLinkContextMenu: vi.fn() }))
vi.mock('@/services/tabchatApi', () => ({
  deleteMessage: vi.fn(),
  getMessageAttachmentDownloadUrl: vi.fn(),
  getMessageReadReceipts: mockGetMessageReadReceipts,
}))
vi.mock('@/services/tabchatAttachmentApi', () => ({ formatFileSize: vi.fn((s: number) => `${s} B`) }))
vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'me' } }),
}))
vi.mock('@stores/useIMStore', () => {
  const state = {
    conversations: [{ id: 'conv-1', organization_id: 'wt-1' }],
    readReceipts: {},
    createConversationAndActivate: mockCreateConversationAndActivate,
    navigateToMessage: mockNavigateToMessage,
  }
  return {
    useIMStore: Object.assign(
      (selector: (store: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
  }
})
vi.mock('@stores/useFileAttachmentStore', () => ({
  useFileAttachmentStore: (selector: (s: { statuses: Record<string, unknown>; markUnavailable: () => void; ensureChecked: () => void; reset: () => void }) => unknown) =>
    selector({ statuses: {}, markUnavailable: vi.fn(), ensureChecked: vi.fn(), reset: vi.fn() }),
}))
vi.mock('@stores/useUserProfileCache', () => ({
  useUserProfileCache: (selector: (s: {
    ensureProfiles: () => void
    profiles: Record<string, { nickname: string; username: string; avatar: string }>
  }) => unknown) => selector({
    ensureProfiles: vi.fn(),
    profiles: {
      'user-2': { nickname: '郑十', username: 'user_5318', avatar: 'tabtin-avatar' },
    },
  }),
  useDisplayName: (userId?: string | null) => userId === 'user-2' ? 'Alice' : 'Me',
  useDisplayNames: () => ({}),
  useAvatar: () => '',
}))
vi.mock('./ForwardDialog', () => ({ ForwardDialog: () => null }))
vi.mock('./EmojiReactionBar', () => ({ EmojiReactionBar: () => null, EmojiQuickPicker: () => null }))
vi.mock('./IMMessageActionBar', () => ({
  IMMessageActionBar: ({
    onEdit,
    canEdit,
    visible,
    onMoreMenuOpenChange,
  }: {
    onEdit?: () => void
    canEdit?: boolean
    visible?: boolean
    onMoreMenuOpenChange?: (open: boolean) => void
  }) => (visible ? (
    <>
      <button
        type="button"
        aria-label="更多"
        onClick={() => onMoreMenuOpenChange?.(true)}
      >
        更多
      </button>
      {canEdit && onEdit ? (
        <button type="button" aria-label="编辑" onClick={onEdit}>编辑</button>
      ) : null}
    </>
  ) : null),
}))
vi.mock('./SpaceCard', () => ({ SpaceCard: () => null }))
vi.mock('./IMResourceCard', () => ({ IMResourceCard: () => null }))
vi.mock('./ContactCard', () => ({ ContactCard: () => null }))
vi.mock('./TeamSpaceCreateTaskDialog', () => ({ TeamSpaceCreateTaskDialog: () => null }))

function buildMessage(overrides: Partial<IMMessage>): IMMessage {
  return {
    id: 10,
    conversation_id: 'conv-1',
    sender_id: 'me',
    content: 'hello',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    metadata: {},
    created_at: '2026-06-24T00:00:00Z',
    is_deleted: false,
    reactions: {},
    ...overrides,
  }
}

async function findReadReceiptDetail(): Promise<HTMLElement> {
  await waitFor(() => {
    expect(document.querySelector('[data-im-read-receipt-detail]')).toBeTruthy()
  })
  return document.querySelector('[data-im-read-receipt-detail]') as HTMLElement
}

describe('IMMessageBubble edit (功能4)', () => {
  beforeEach(() => {
    mockGetMessageReadReceipts.mockReset()
    mockGetMessageReadReceipts.mockResolvedValue({ readers: [], unreaders: [] })
  })

  it('点击回复引用打开侧边详情，不跳转主消息流', async () => {
    const onOpenReplyThread = vi.fn()
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const message = buildMessage({
      id: 10,
      reply_to_id: 5,
      reply_to_preview: { sender_id: 'user-2', content: '被引用的消息' },
    })
    render(<IMMessageBubble message={message} prevMessage={null} onOpenReplyThread={onOpenReplyThread} />)

    fireEvent.click(screen.getByRole('button', { name: '查看回复详情' }))

    expect(onOpenReplyThread).toHaveBeenCalledWith(message)
    expect(mockNavigateToMessage).not.toHaveBeenCalled()
  })

  it('没有原消息 ID 的引用预览也仅展示', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          reply_to_preview: { sender_id: 'user-2', content: '仅有预览的旧消息' },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.queryByRole('button', { name: /跳转到.*被引用消息/ })).toBeNull()
  })

  it('引用按“回复 名字：[资源类型] 文案”展示', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { rerender } = render(
      <IMMessageBubble
        message={buildMessage({
          reply_to_id: 5,
          reply_to_preview: {
            sender_id: 'user-2',
            content: '现场照片',
            message_type: MESSAGE_TYPE_IMAGE,
          },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.getByRole('button', { name: '查看回复详情' }).textContent)
      .toBe('回复Alice:[图片] 现场照片')

    rerender(
      <IMMessageBubble
        message={buildMessage({
          reply_to_id: 6,
          reply_to_preview: {
            sender_id: 'user-2',
            content: '方案.pdf',
            message_type: MESSAGE_TYPE_FILE,
          },
        })}
        prevMessage={null}
      />,
    )
    expect(screen.getByRole('button', { name: '查看回复详情' }).textContent)
      .toBe('回复Alice:[文件] 方案.pdf')

    rerender(
      <IMMessageBubble
        message={buildMessage({
          reply_to_id: 7,
          reply_to_preview: {
            sender_id: 'user-2',
            content: '[文档] 需求说明',
            message_type: MESSAGE_TYPE_TEXT,
          },
        })}
        prevMessage={null}
      />,
    )
    expect(screen.getByRole('button', { name: '查看回复详情' }).textContent)
      .toBe('回复Alice:[文档] 需求说明')
  })

  it('点击群消息发送者的头像或昵称会创建并进入私信', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ sender_id: 'user-2', sender_type: 'user' })}
        prevMessage={null}
      />,
    )

    const senderDMButtons = screen.getAllByRole('button', { name: '向 Alice 发消息' })
    expect(senderDMButtons).toHaveLength(2)
    fireEvent.click(senderDMButtons[0])

    await waitFor(() => {
      expect(mockCreateConversationAndActivate).toHaveBeenCalledWith({
        organizationId: 'wt-1',
        kind: 'dm',
        memberIds: ['user-2'],
      })
    })

    fireEvent.click(senderDMButtons[1])
    await waitFor(() => expect(mockCreateConversationAndActivate).toHaveBeenCalledTimes(2))
  })

  it('不会给自己或 Agent 的群消息发送者提供私信入口', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { rerender } = render(<IMMessageBubble message={buildMessage({})} prevMessage={null} />)
    expect(screen.queryByRole('button', { name: /发消息/ })).toBeNull()

    rerender(<IMMessageBubble message={buildMessage({ sender_id: 'agent-1', sender_type: 'agent' })} prevMessage={null} />)
    expect(screen.queryByRole('button', { name: /发消息/ })).toBeNull()
  })

  it('shows edit action for own text message and fires onEdit', async () => {
    const onEdit = vi.fn()
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage({})} prevMessage={null} onEdit={onEdit} />)
    const trigger = screen.getByText('hello').closest('[data-im-message-action-trigger]') as HTMLElement
    fireEvent.mouseEnter(trigger)
    fireEvent.click(screen.getByRole('button', { name: '编辑' }))
    expect(onEdit).toHaveBeenCalled()
  })

  it('shows an accessible read indicator for every own DM message covered by the peer receipt', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ id: 10 })}
        prevMessage={null}
        isDM
        peerLastReadId={12}
      />,
    )

    expect(screen.getByLabelText('read')).toBeTruthy()
  })

  it('keeps the unread indicator after a DM is delivered but before the peer receipt arrives', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { IM_READ_RECEIPT_ANCHOR_CLASS, IM_UNREAD_RECEIPT_DOT_CLASS } = await import('./tabchatUi')
    render(<IMMessageBubble message={buildMessage({})} prevMessage={null} isDM />)

    expect(screen.getByLabelText('notRead')).toBeTruthy()
    expect(screen.queryByLabelText('sending')).toBeNull()
    const anchor = document.querySelector('[data-im-read-receipt-anchor]')
    expect(anchor?.className).toContain('bottom-0')
    expect(anchor?.className).toContain(IM_READ_RECEIPT_ANCHOR_CLASS)
    expect(anchor?.closest('[data-im-message-action-trigger]')).toBeTruthy()
    const dot = anchor?.querySelector('span[aria-hidden="true"]')
    expect(dot?.className).toContain('bg-transparent')
    expect(dot?.className).not.toContain('bg-white')
    expect(dot?.className).toContain(IM_UNREAD_RECEIPT_DOT_CLASS)
  })

  it('shows the sending circle only while the local DM message is optimistic', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ id: -1, _optimistic: true })}
        prevMessage={null}
        isDM
      />,
    )

    expect(screen.getByLabelText('sending')).toBeTruthy()
    expect(screen.queryByLabelText('notRead')).toBeNull()
  })

  it('hides group read status until Tencent supplies an authoritative recipient count', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage({})} prevMessage={null} />)

    expect(screen.queryByLabelText('readReceiptSummary')).toBeNull()
  })

  it('keeps the authoritative unread total when group receipt details are temporarily empty', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 0, recipient_count: 2 } })}
        prevMessage={null}
        currentHumanMemberIds={['me', 'user-2', 'user-3']}
      />,
    )

    fireEvent.click(screen.getByLabelText('readReceiptSummary'))
    await waitFor(() => expect(mockGetMessageReadReceipts).toHaveBeenCalledTimes(1))

    expect(screen.getByText('2 notRead')).toBeTruthy()
  })

  it('uses a check mark instead of a conic gradient when every group recipient has read', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 1, recipient_count: 1 } })}
        prevMessage={null}
      />,
    )

    const trigger = screen.getByLabelText('readReceiptSummary')
    expect(trigger.querySelector('svg.text-emerald-500')).toBeTruthy()
    expect(trigger.querySelector('[style*="conic-gradient"]')).toBeNull()
  })

  it('shows the TabTin nickname instead of the Tencent account in receipt details', async () => {
    mockGetMessageReadReceipts.mockResolvedValueOnce({
      message_id: 10,
      readers: [],
      unreaders: [{
        user_id: 'user-2',
        name: 'user_5318',
        username: 'user_5318',
        avatar: 'tencent-avatar',
      }],
    })
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 0, recipient_count: 1 } })}
        prevMessage={null}
      />,
    )

    fireEvent.click(screen.getByLabelText('readReceiptSummary'))

    expect(await screen.findByText('郑十')).toBeTruthy()
    expect(screen.queryByText('user_5318')).toBeNull()
  })

  it('shows names and avatars for Tencent provider receipt identities', async () => {
    const providerUserId = 'u_mdxlytf2emhyk2f5fs7xunfiivtpk'
    mockGetMessageReadReceipts.mockResolvedValueOnce({
      message_id: 10,
      readers: [],
      unreaders: [{
        user_id: providerUserId,
        name: 'Bob',
        username: 'bob',
        avatar: 'https://example.com/bob.png',
      }],
    })
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 0, recipient_count: 1 } })}
        prevMessage={null}
        currentHumanMemberIds={[providerUserId]}
      />,
    )

    fireEvent.click(screen.getByLabelText('readReceiptSummary'))

    expect(await screen.findByText('Bob')).toBeTruthy()
    const detail = await findReadReceiptDetail()
    expect(detail.querySelector('img')?.getAttribute('src')).toBe('https://example.com/bob.png')
  })

  it('excludes a member removed after the message was sent from unread details', async () => {
    mockGetMessageReadReceipts.mockResolvedValueOnce({
      message_id: 10,
      readers: [],
      unreaders: [
        { user_id: 'me', name: 'Me', username: 'me', avatar: '' },
        { user_id: 'user-2', name: 'Alice', username: 'alice', avatar: '' },
        { user_id: 'user-3', name: 'Bob', username: 'bob', avatar: '' },
        { user_id: 'removed-user', name: 'Removed', username: 'removed', avatar: '' },
      ],
    })
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 0, recipient_count: 4 } })}
        prevMessage={null}
        currentHumanMemberIds={['me', 'user-2', 'user-3']}
      />,
    )

    fireEvent.click(screen.getByLabelText('readReceiptSummary'))

    expect(await screen.findByText('2 notRead')).toBeTruthy()
    expect(screen.queryByText('Removed')).toBeNull()
  })

  it('reloads open group receipt details when Tencent updates the message counts', async () => {
    let resolveStaleRequest: (detail: MessageReadReceipts) => void = () => {}
    const staleRequest = new Promise<MessageReadReceipts>((resolve) => {
      resolveStaleRequest = resolve
    })
    mockGetMessageReadReceipts
      .mockReturnValueOnce(staleRequest)
      .mockResolvedValueOnce({
        readers: [{ user_id: 'user-2', read_at: '2026-08-04T02:30:00Z' }],
        unreaders: [],
      })
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { rerender } = render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 0, recipient_count: 1 } })}
        prevMessage={null}
      />,
    )

    fireEvent.click(screen.getByLabelText('readReceiptSummary'))
    await waitFor(() => expect(mockGetMessageReadReceipts).toHaveBeenCalledTimes(1))

    rerender(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 1, recipient_count: 1 } })}
        prevMessage={null}
      />,
    )

    await waitFor(() => expect(mockGetMessageReadReceipts).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('1 read')).toBeTruthy()

    await act(async () => {
      resolveStaleRequest({
        readers: [],
        unreaders: [{ user_id: 'user-2', read_at: null }],
      })
      await staleRequest
    })
    expect(screen.getByText('1 read')).toBeTruthy()
    expect(screen.queryByText('0 read')).toBeNull()
  })

  it('reloads cached receipt details whenever the panel is reopened', async () => {
    mockGetMessageReadReceipts
      .mockResolvedValueOnce({
        readers: [],
        unreaders: [
          { user_id: 'zsctest1', name: 'zsctest1' },
          { user_id: 'zsctest2', name: 'zsctest2' },
          { user_id: 'zsc2', name: 'zsc2' },
        ],
      })
      .mockResolvedValueOnce({
        readers: [{ user_id: 'zsc2', name: 'zsc2' }],
        unreaders: [
          { user_id: 'zsctest1', name: 'zsctest1' },
          { user_id: 'zsctest2', name: 'zsctest2' },
        ],
      })
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 0, recipient_count: 3 } })}
        prevMessage={null}
      />,
    )

    const trigger = screen.getByLabelText('readReceiptSummary')
    fireEvent.click(trigger)
    expect(await screen.findByText('0 read')).toBeTruthy()
    fireEvent.click(trigger)
    fireEvent.click(trigger)

    await waitFor(() => expect(mockGetMessageReadReceipts).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('1 read')).toBeTruthy()
    expect(screen.getByText('2 notRead')).toBeTruthy()
  })

  it('closes group read-receipt details when clicking outside the popover', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 1, recipient_count: 2 } })}
        prevMessage={null}
      />,
    )

    const trigger = screen.getByLabelText('readReceiptSummary')
    fireEvent.click(trigger)
    const detail = await findReadReceiptDetail()
    expect(trigger.getAttribute('aria-expanded')).toBe('true')
    expect(detail?.parentElement).toBe(document.body)
    expect(detail?.classList.contains('fixed')).toBe(true)
    expect(detail?.getAttribute('data-placement')).toBe('below')
    expect(trigger.getAttribute('aria-controls')).toBe(detail?.id)

    fireEvent.click(detail)
    expect(document.querySelector('[data-im-read-receipt-detail]')).toBe(detail)

    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('[data-im-read-receipt-detail]')).toBeNull()
    expect(trigger.getAttribute('aria-expanded')).toBe('false')

    fireEvent.click(trigger)
    await findReadReceiptDetail()
    fireEvent.pointerDown(document.body)
    expect(document.querySelector('[data-im-read-receipt-detail]')).toBeNull()
  })

  it('opens read-receipt details upward when the composer leaves insufficient space below', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 1, recipient_count: 2 } })}
        prevMessage={null}
      />,
    )

    const trigger = screen.getByLabelText('readReceiptSummary')
    Object.defineProperty(trigger, 'getBoundingClientRect', {
      value: () => ({
        top: 600,
        bottom: 620,
        left: 400,
        right: 416,
        width: 16,
        height: 20,
      }),
    })
    fireEvent.click(trigger)

    const detail = await findReadReceiptDetail()
    expect(detail?.getAttribute('data-placement')).toBe('above')
    expect(detail?.style.bottom).toBeTruthy()
  })

  it('clamps read-receipt panel into the viewport when the trigger sits near the left edge', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ read_receipt: { read_count: 1, recipient_count: 2 } })}
        prevMessage={null}
      />,
    )

    const trigger = screen.getByLabelText('readReceiptSummary')
    Object.defineProperty(trigger, 'getBoundingClientRect', {
      value: () => ({
        top: 120,
        bottom: 136,
        left: 12,
        right: 28,
        width: 16,
        height: 16,
      }),
    })
    fireEvent.click(trigger)

    const detail = await findReadReceiptDetail()
    expect(detail?.parentElement).toBe(document.body)
    expect(detail.style.left).toBe('8px')
  })

  it('reserves a fixed action rail without shrinking message content below the readable limit', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { container } = render(
      <IMMessageBubble message={buildMessage({})} prevMessage={null} onEdit={vi.fn()} />,
    )
    const row = container.querySelector('[data-im-message-row]') as HTMLElement

    expect(row.style.maxWidth).toBe('min(85%, max(220px, calc(100% - 208px)))')
  })

  it('does not show actions when hovering empty space in the full-width message row', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { container } = render(
      <IMMessageBubble message={buildMessage({})} prevMessage={null} onEdit={vi.fn()} />,
    )
    const row = container.querySelector('.group') as HTMLElement

    fireEvent.mouseEnter(row)

    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('keeps the action bar briefly after mouse leaves so floating buttons remain clickable', async () => {
    vi.useFakeTimers()
    try {
      const { IMMessageBubble } = await import('./IMMessageBubble')
      render(<IMMessageBubble message={buildMessage({})} prevMessage={null} onEdit={vi.fn()} />)
      const trigger = screen.getByText('hello').closest('[data-im-message-action-trigger]') as HTMLElement

      fireEvent.mouseEnter(trigger)
      expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()

      fireEvent.mouseLeave(trigger)
      expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()

      await act(async () => {
        vi.advanceTimersByTime(180)
      })
      expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancels the pending hide when the pointer reaches the floating action bar', async () => {
    vi.useFakeTimers()
    try {
      const { IMMessageBubble } = await import('./IMMessageBubble')
      render(<IMMessageBubble message={buildMessage({})} prevMessage={null} onEdit={vi.fn()} />)
      const trigger = screen.getByText('hello').closest('[data-im-message-action-trigger]') as HTMLElement

      fireEvent.mouseEnter(trigger)
      const editButton = screen.getByRole('button', { name: '编辑' })
      fireEvent.mouseLeave(trigger)
      fireEvent.mouseEnter(editButton)

      await act(async () => {
        vi.advanceTimersByTime(180)
      })
      expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('keeps the action bar visible while the more menu is open after pointer leaves', async () => {
    vi.useFakeTimers()
    try {
      const { IMMessageBubble } = await import('./IMMessageBubble')
      render(<IMMessageBubble message={buildMessage({})} prevMessage={null} onEdit={vi.fn()} />)
      const trigger = screen.getByText('hello').closest('[data-im-message-action-trigger]') as HTMLElement

      fireEvent.mouseEnter(trigger)
      fireEvent.click(screen.getByRole('button', { name: '更多' }))
      fireEvent.mouseLeave(trigger)

      await act(async () => {
        vi.advanceTimersByTime(180)
      })

      // 「更多」菜单经 portal 挂在气泡外；打开期间操作条（含编辑入口）必须仍可见。
      expect(screen.getByRole('button', { name: '更多' })).toBeTruthy()
      expect(screen.getByRole('button', { name: '编辑' })).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })

  it('locks message-list scrolling while the more menu is open', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { IMMessageScrollLockProvider } = await import('./imMessageScrollLock')

    function Wrap() {
      const scrollerRef = React.useRef<HTMLDivElement | null>(null)
      const viewportRef = React.useRef<HTMLDivElement | null>(null)
      return (
        <div ref={viewportRef} data-testid="im-viewport">
          <div
            ref={scrollerRef}
            data-testid="im-scroller"
            style={{ overflowY: 'auto', height: 120 }}
          >
            <IMMessageScrollLockProvider scrollerRef={scrollerRef} viewportRef={viewportRef}>
              <IMMessageBubble message={buildMessage({})} prevMessage={null} onEdit={vi.fn()} />
            </IMMessageScrollLockProvider>
          </div>
        </div>
      )
    }

    render(<Wrap />)
    const trigger = screen.getByText('hello').closest('[data-im-message-action-trigger]') as HTMLElement
    fireEvent.mouseEnter(trigger)
    fireEvent.click(screen.getByRole('button', { name: '更多' }))

    expect(screen.getByTestId('im-scroller').style.overflowY).toBe('hidden')
  })

  it('adds vertical breathing room to a message highlighted by pin/search navigation', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { container } = render(
      <IMMessageBubble message={buildMessage({})} prevMessage={null} isHighlighted />,
    )

    expect((container.querySelector('.group') as HTMLElement).classList.contains('py-2')).toBe(true)
  })

  it('does not highlight the entire message row when the current user is mentioned', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const { container } = render(
      <IMMessageBubble
        message={buildMessage({
          sender_id: 'user-2',
          content: '@Me hello',
          metadata: { mentioned_user_ids: ['me'] },
        })}
        prevMessage={null}
      />,
    )

    expect((container.querySelector('.group') as HTMLElement).classList.contains('bg-warning/10')).toBe(false)
  })

  it('keeps an optimistic message at normal opacity while awaiting confirmation', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage({ _optimistic: true })} prevMessage={null} />)

    const bubble = screen.getByText('hello').closest('.rounded-2xl') as HTMLElement
    expect(bubble.classList.contains('opacity-60')).toBe(false)
    expect(bubble.classList.contains('opacity-40')).toBe(false)
  })

  it('only dims a message after sending has failed', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage({ _optimistic: true, _failed: true })} prevMessage={null} />)

    const bubble = screen.getByText('hello').closest('.rounded-2xl') as HTMLElement
    expect(bubble.classList.contains('opacity-40')).toBe(true)
  })

  it('offers a clear retry action for a failed message', async () => {
    const onRetryFailed = vi.fn()
    const { IMMessageBubble } = await import('./IMMessageBubble')
    const failedMessage = buildMessage({
      id: -1,
      _optimistic: true,
      _failed: true,
      _tempId: '_opt_request-1',
      metadata: { client_request_id: '_opt_request-1' },
    })
    render(<IMMessageBubble message={failedMessage} prevMessage={null} onRetryFailed={onRetryFailed} />)

    expect(screen.getByText('发送失败，请检查网络后重试。')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: '重试' }))
    expect(onRetryFailed).toHaveBeenCalledWith(failedMessage)
  })

  it('disables retry while the failed message is being resent', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ _optimistic: true, _failed: true, _retrying: true })}
        prevMessage={null}
        onRetryFailed={vi.fn()}
      />,
    )

    expect((screen.getByRole('button', { name: '重试中…' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('renders the "edited" marker when edited_at is set', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage({ edited_at: '2026-06-24T01:00:00Z' })} prevMessage={null} onEdit={vi.fn()} />)
    // t mock 无 defaultValue 时返回 key 'edited'
    expect(screen.getByText('edited')).toBeTruthy()
  })

  it('does not label a system-refreshed shared task card as user edited', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({
          edited_at: '2026-06-24T01:00:00Z',
          metadata: { card: { type: 'session_share' } },
        })}
        prevMessage={null}
      />,
    )

    expect(screen.queryByText('edited')).toBeNull()
  })

  it('does not offer edit for a file message', async () => {
    const onEdit = vi.fn()
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(
      <IMMessageBubble
        message={buildMessage({ message_type: MESSAGE_TYPE_FILE, content: 'f.pdf', has_attachment: true, metadata: { file_id: 'x', file_name: 'f.pdf' } })}
        prevMessage={null}
        onEdit={onEdit}
      />,
    )
    const row = document.querySelector('.group') as HTMLElement
    fireEvent.mouseEnter(row)
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })

  it('does not offer edit for messages from others', async () => {
    const { IMMessageBubble } = await import('./IMMessageBubble')
    render(<IMMessageBubble message={buildMessage({ sender_id: 'someone-else' })} prevMessage={null} onEdit={vi.fn()} />)
    const row = screen.getByText('hello').closest('.group') as HTMLElement
    fireEvent.mouseEnter(row)
    expect(screen.queryByRole('button', { name: '编辑' })).toBeNull()
  })
})
