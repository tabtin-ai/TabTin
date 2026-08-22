import React from 'react'
import { render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

const { storeState } = vi.hoisted(() => ({
  storeState: {
    conversations: [{
      id: 'group-1',
      organization_id: 'org-1',
      type: 2,
      name: 'Group',
      avatar_url: '',
      member_count: 2,
      last_message_at: null,
      last_message_preview: '',
      unread_count: 0,
      created_at: '2026-07-31T02:30:00.000Z',
    }],
    hasMoreMessages: { 'group-1': false },
    readReceipts: {} as Record<string, Record<string, number>>,
    scrollTargetConversationId: null as string | null,
    scrollToMessageId: null as number | null,
    scrollToMessageRef: null as string | null,
    retryFailedMessage: vi.fn(),
    clearScrollTarget: vi.fn(),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; time?: string }) =>
      key === 'groupCreatedAt' ? `groupCreatedAt:${options?.time}` : (options?.defaultValue ?? key),
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@components/ui', () => ({
  OVERLAY_SURFACE_CLASS: '',
}))

vi.mock('@hooks/spaceActivity', () => ({
  useScopedResizeObserver: vi.fn(),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (state: typeof storeState) => unknown) => selector(storeState),
    { getState: () => storeState },
  ),
}))

vi.mock('./IMMessageBubble', () => ({
  IMMessageBubble: ({ message }: { message: IMMessage }) => (
    <div data-testid={`bubble-${message.id}`}>{message.content}</div>
  ),
}))

vi.mock('@components/common/ListSkeletons', () => ({
  MessageListSkeleton: () => <div>skeleton</div>,
}))

vi.mock('@components/common/VirtuosoHoverScroller', () => ({
  VirtuosoHoverScroller: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    (props, ref) => <div ref={ref} {...props} />,
  ),
}))

vi.mock('./imMessageScrollLock', () => ({
  IMMessageScrollLockProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('react-virtuoso', () => ({
  Virtuoso: React.forwardRef(function MockVirtuoso(
    props: {
      components?: { Header?: React.ComponentType }
      data?: IMMessage[]
      itemContent?: (index: number, message: IMMessage) => React.ReactNode
      firstItemIndex?: number
    },
    ref: React.ForwardedRef<unknown>,
  ) {
    React.useImperativeHandle(ref, () => ({}))
    const Header = props.components?.Header
    return (
      <div>
        {Header ? <Header /> : null}
        {props.data?.map((message, index) => (
          <React.Fragment key={message.id}>
            {props.itemContent?.((props.firstItemIndex ?? 0) + index, message)}
          </React.Fragment>
        ))}
      </div>
    )
  }),
}))

function message(): IMMessage {
  return {
    id: 1,
    conversation_id: 'group-1',
    sender_id: 'user-2',
    content: 'first message',
    message_type: MESSAGE_TYPE_TEXT,
    reply_to_id: null,
    has_attachment: false,
    created_at: '2026-07-31T03:30:00.000Z',
    is_deleted: false,
    metadata: {},
  }
}

describe('IMMessageList group creation time', () => {
  afterEach(() => {
    storeState.conversations[0].type = 2
    storeState.hasMoreMessages['group-1'] = false
  })

  it('shows the conversation creation time before the first message exists', async () => {
    const { IMMessageList } = await import('./IMMessageList')

    render(
      <IMMessageList
        messages={[]}
        conversationId="group-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    expect(screen.getByText(/^groupCreatedAt:/).closest('time')?.getAttribute('datetime'))
      .toBe('2026-07-31T02:30:00.000Z')
  })

  it('keeps the conversation creation time when the first message arrives', async () => {
    const { IMMessageList } = await import('./IMMessageList')

    render(
      <IMMessageList
        messages={[message()]}
        conversationId="group-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    expect(screen.getByText(/^groupCreatedAt:/).closest('time')?.getAttribute('datetime'))
      .toBe('2026-07-31T02:30:00.000Z')
    expect(screen.getByTestId('bubble-1')).toBeTruthy()
  })

  it('waits until the oldest history page is loaded', async () => {
    storeState.hasMoreMessages['group-1'] = true
    const { IMMessageList } = await import('./IMMessageList')

    render(
      <IMMessageList
        messages={[message()]}
        conversationId="group-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    expect(screen.queryByText(/^groupCreatedAt:/)).toBeNull()
  })

  it('does not add a group creation marker to direct messages', async () => {
    storeState.conversations[0].type = 1
    const { IMMessageList } = await import('./IMMessageList')

    render(
      <IMMessageList
        messages={[]}
        conversationId="group-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    expect(screen.queryByText(/^groupCreatedAt:/)).toBeNull()
  })

  it('does not insert a layout-affecting loading row while cached messages refresh', async () => {
    const { IMMessageList } = await import('./IMMessageList')

    render(
      <IMMessageList
        messages={[message()]}
        conversationId="group-1"
        isLoading
        onLoadMore={async () => false}
      />,
    )

    expect(document.querySelector('.animate-spin')).toBeNull()
    expect(screen.getByText(/^groupCreatedAt:/).closest('time')?.getAttribute('datetime'))
      .toBe('2026-07-31T02:30:00.000Z')
    expect(screen.getByTestId('bubble-1')).toBeTruthy()
  })

  it('uses a stable canvas only for an uncached initial load', async () => {
    const { IMMessageList } = await import('./IMMessageList')

    render(
      <IMMessageList
        messages={[]}
        conversationId="group-1"
        isLoading
        isInitialLoading
        onLoadMore={async () => false}
      />,
    )

    expect(screen.getByTestId('im-message-list-initial-loading')).toBeTruthy()
  })
})
