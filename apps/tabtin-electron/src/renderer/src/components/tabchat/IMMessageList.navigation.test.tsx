/**
 * 搜索/引用跳转历史消息：定位期间不能被自动贴底拽回底部。
 * 长消息进入视口后高度回稳最容易触发这个竞态。
 */
import React from 'react'
import { act, render, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { MESSAGE_TYPE_TEXT } from '@/constants/tabchat'
import type { IMMessage } from '@/services/tabchatApi'

const {
  scrollToIndex,
  autoscrollToBottom,
  storeState,
  clearScrollTarget,
  capture,
} = vi.hoisted(() => {
  const capture: {
    totalListHeightChanged?: () => void
    followOutput?: (atBottom: boolean) => 'auto' | false
    minOverscanItemCount?: number | { top: number; bottom: number }
  } = {}
  return {
    scrollToIndex: vi.fn(),
    autoscrollToBottom: vi.fn(),
    clearScrollTarget: vi.fn(),
    capture,
    storeState: {
      conversations: [{ id: 'conv-1', type: 1, organization_id: 'org-1' }],
      readReceipts: {} as Record<string, Record<string, number>>,
      scrollTargetConversationId: null as string | null,
      scrollToMessageId: null as number | null,
      scrollToMessageRef: null as string | null,
      retryFailedMessage: vi.fn(),
      clearScrollTarget: (...args: unknown[]) => clearScrollTarget(...args),
    },
  }
})

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  toast: vi.fn(),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useIMStore', () => ({
  useIMStore: Object.assign(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
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
      totalListHeightChanged?: () => void
      followOutput?: (atBottom: boolean) => 'auto' | false
      data?: IMMessage[]
      minOverscanItemCount?: number | { top: number; bottom: number }
    },
    ref: React.ForwardedRef<{ scrollToIndex: typeof scrollToIndex; autoscrollToBottom: typeof autoscrollToBottom }>,
  ) {
    capture.totalListHeightChanged = props.totalListHeightChanged
    capture.followOutput = props.followOutput
    capture.minOverscanItemCount = props.minOverscanItemCount
    React.useImperativeHandle(ref, () => ({
      scrollToIndex,
      autoscrollToBottom,
    }))
    return <div data-testid="virtuoso" data-count={props.data?.length ?? 0} />
  }),
}))

function msg(id: number, content = `m-${id}`): IMMessage {
  return {
    id,
    conversation_id: 'conv-1',
    sender_id: 'user-2',
    content,
    message_type: MESSAGE_TYPE_TEXT,
    created_at: `2026-07-25T0${id}:00:00Z`,
    is_deleted: false,
    metadata: {},
  }
}

describe('IMMessageList navigation locate vs auto-stick', () => {
  beforeEach(() => {
    scrollToIndex.mockReset()
    autoscrollToBottom.mockReset()
    clearScrollTarget.mockReset()
    capture.totalListHeightChanged = undefined
    capture.followOutput = undefined
    capture.minOverscanItemCount = undefined
    storeState.scrollTargetConversationId = null
    storeState.scrollToMessageId = null
    storeState.scrollToMessageRef = null
  })

  it('定位到历史消息后，长消息高度回稳不再触发贴底', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const messages = [
      msg(1),
      msg(2, `${'很长的历史消息 '.repeat(80)}https://github.com/larchiveai/TabTin/issues/7632`),
      msg(3),
      msg(4),
      msg(5),
    ]
    const { IMMessageList } = await import('./IMMessageList')
    const { rerender } = render(
      <IMMessageList
        messages={messages}
        conversationId="conv-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    await waitFor(() => expect(capture.totalListHeightChanged).toBeTypeOf('function'))

    storeState.scrollTargetConversationId = 'conv-1'
    storeState.scrollToMessageId = 2
    rerender(
      <IMMessageList
        messages={messages}
        conversationId="conv-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, align: 'center', behavior: 'auto' }),
    )
    expect(capture.followOutput?.(true)).toBe(false)

    const callsAfterLocate = scrollToIndex.mock.calls.length
    autoscrollToBottom.mockClear()

    act(() => {
      capture.totalListHeightChanged?.()
    })

    expect(autoscrollToBottom).not.toHaveBeenCalled()
    expect(scrollToIndex.mock.calls.length).toBe(callsAfterLocate)
    expect(capture.followOutput?.(true)).toBe(false)

    vi.useRealTimers()
  })

  it('C2C 双方序号相同时按 message_ref 定位', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const messages = [
      { ...msg(1, 'mine'), sender_id: 'user-1', metadata: { message_ref: 'mine-ref' } },
      { ...msg(1, 'peer'), sender_id: 'user-2', metadata: { message_ref: 'peer-ref' } },
    ]
    const { IMMessageList } = await import('./IMMessageList')
    const { rerender } = render(
      <IMMessageList
        messages={messages}
        conversationId="conv-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    storeState.scrollTargetConversationId = 'conv-1'
    storeState.scrollToMessageId = 1
    storeState.scrollToMessageRef = 'peer-ref'
    rerender(
      <IMMessageList
        messages={messages}
        conversationId="conv-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    await act(async () => {
      await vi.runAllTimersAsync()
    })

    expect(scrollToIndex).toHaveBeenCalledWith(
      expect.objectContaining({ index: 1, align: 'center' }),
    )
    expect(clearScrollTarget).toHaveBeenCalledWith(expect.objectContaining({
      messageId: 1,
      messageRef: 'peer-ref',
    }))
    vi.useRealTimers()
  })

  it('pre-renders one history page above the viewport before the user scrolls', async () => {
    const { IMMessageList } = await import('./IMMessageList')
    render(
      <IMMessageList
        messages={[msg(1), msg(2)]}
        conversationId="conv-1"
        isLoading={false}
        onLoadMore={async () => false}
      />,
    )

    expect(capture.minOverscanItemCount).toEqual({ top: 15, bottom: 3 })
  })
})
