import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import React, { createRef } from 'react'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ConversationViewportEvent, ViewportMode } from '../../viewport/types'
import type { MessageListHandle } from '../MessageList'

type VirtualizerAdjustCallback = (item: { start: number }, delta: number, instance: { scrollOffset: number | null; scrollAdjustments?: number }) => boolean

type VirtualizerMockInstance = {
  getTotalSize: () => number
  getVirtualItems: () => Array<{
    index: number
    key: string | number
    start: number
    size: number
    end: number
  }>
  measureElement: Mock
  measure: Mock
  scrollToIndex: Mock
  shouldAdjustScrollPositionOnItemSizeChange?: VirtualizerAdjustCallback
}

const viewportHarness = vi.hoisted(() => {
  const dispatch = vi.fn<(event: ConversationViewportEvent) => void>()
  const state: {
    mode: ViewportMode
    showReturnToLatest: boolean
  } = {
    mode: { kind: 'follow-latest' },
    showReturnToLatest: false,
  }
  return { dispatch, state }
})

const virtualizerHarness = vi.hoisted(() => {
  const scrollToIndex = vi.fn()
  const measure = vi.fn()
  let totalSize = 240
  let itemCountOverride: number | null = null
  let latestInstance: VirtualizerMockInstance | null = null
  return {
    scrollToIndex,
    measure,
    getTotalSize: () => totalSize,
    setTotalSize: (next: number) => {
      totalSize = next
    },
    setItemCountOverride: (next: number | null) => {
      itemCountOverride = next
    },
    getItemCountOverride: () => itemCountOverride,
    setLatestInstance: (instance: VirtualizerMockInstance) => {
      latestInstance = instance
    },
    getLatestInstance: () => latestInstance,
  }
})

const chatStoreHarness = vi.hoisted(() => ({
  streamingBySession: {} as Record<string, boolean>,
  sessionAgentById: {} as Record<string, string | null>,
  sessionAgentNameById: {} as Record<string, string | null>,
  sessionAgentAvatarById: {} as Record<string, string | null>,
  selectedAgentId: null as string | null,
  messagesBySessionId: {} as Record<string, ChatMessage[]>,
}))

const blocksHarness = vi.hoisted(() => ({
  //  assembleRunContentBlocks 要求非 null record
  record: {} as Record<string, unknown>,
}))

const activityHarness = vi.hoisted(() => ({
  isForeground: true,
}))

const intersectionHarness = vi.hoisted(() => ({
  callback: null as IntersectionObserverCallback | null,
  root: null as Element | Document | null,
  observe: vi.fn(),
  disconnect: vi.fn(),
}))

const bridgeHarness = vi.hoisted(() => ({
  adjustInputs: [] as Array<{
    mode: ViewportMode
    itemStart: number
    scrollOffset: number
    scrollAdjustments?: number
  }>,
}))

vi.mock('../../viewport/useConversationViewport', () => ({
  useConversationViewport: vi.fn(() => ({
    mode: viewportHarness.state.mode,
    showReturnToLatest: viewportHarness.state.showReturnToLatest,
    dispatch: viewportHarness.dispatch,
  })),
}))

vi.mock('@hooks/useSafeVirtualizer', () => ({
  useSafeVirtualizer: ({ count, getItemKey }: { count: number; getItemKey?: (index: number) => string | number }) => {
    const instance: VirtualizerMockInstance = {
      getTotalSize: () => virtualizerHarness.getTotalSize(),
      getVirtualItems: () => {
        const n = virtualizerHarness.getItemCountOverride() ?? count
        return Array.from({ length: n }, (_, index) => ({
          index,
          key: getItemKey ? getItemKey(index) : `row-${index}`,
          start: index * 80,
          size: 80,
          end: (index + 1) * 80,
        }))
      },
      measureElement: vi.fn(),
      measure: virtualizerHarness.measure,
      scrollToIndex: virtualizerHarness.scrollToIndex,
    }
    virtualizerHarness.setLatestInstance(instance)
    return instance
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, defaultValueOrOptions?: unknown) => {
      if (typeof defaultValueOrOptions === 'string') return defaultValueOrOptions
      if (defaultValueOrOptions && typeof defaultValueOrOptions === 'object' && typeof (defaultValueOrOptions as { defaultValue?: unknown }).defaultValue === 'string') {
        return (defaultValueOrOptions as { defaultValue: string }).defaultValue
      }
      return key
    },
  }),
}))

// ：MessageList 的 busy 改订阅执行态投影（useSessionBusy），mock 同步跟进。
vi.mock('@/stores/chat/execution/sessionRunProjection', () => ({
  useSessionBusy: (sessionId: string | null) => (sessionId ? Boolean(chatStoreHarness.streamingBySession[sessionId]) : false),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: {
    restoringSessionId: string | null
    messagesBySessionId: Record<string, ChatMessage[]>
    getSessionById: (sessionId: string) => {
      agent_id?: string | null
      agent_name?: string | null
      agent_avatar?: string | null
    } | undefined
  }) => unknown) =>
    selector({
      restoringSessionId: null,
      messagesBySessionId: chatStoreHarness.messagesBySessionId,
      getSessionById: (sessionId: string) =>
        Object.prototype.hasOwnProperty.call(chatStoreHarness.sessionAgentById, sessionId)
          ? {
              agent_id: chatStoreHarness.sessionAgentById[sessionId],
              agent_name: chatStoreHarness.sessionAgentNameById[sessionId],
              agent_avatar: chatStoreHarness.sessionAgentAvatarById[sessionId],
            }
          : undefined,
    }),
}))

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { selectedAgent: { id: string } | null }) => unknown) =>
    selector({
      selectedAgent: chatStoreHarness.selectedAgentId ? { id: chatStoreHarness.selectedAgentId } : null,
    }),
}))

vi.mock('@stores/chat/messages/messageBlocks', () => ({
  useSessionBlocksRecord: () => blocksHarness.record,
}))

const pulseHarness = vi.hoisted(() => ({
  visible: false,
}))

vi.mock('../../hooks/useAgentStreamingTailVisible', () => ({
  useAgentStreamingTailVisible: () => pulseHarness.visible,
}))

vi.mock('@components/layout/SpaceActivityContext', () => ({
  useSpaceActivity: () => ({ isForeground: activityHarness.isForeground }),
}))

vi.mock('@hooks/spaceActivity', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  useScopedInterval: () => {},
  useScopedResizeObserver: () => {},
}))

vi.mock('framer-motion', () => ({
  motion: {
    div: ({ children, ...props }: React.HTMLAttributes<HTMLDivElement>) => <div {...props}>{children}</div>,
  },
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  LoadingSpinner: () => <div data-testid="loading-spinner" />,
  // table-ui ViewFilterRulesEditor 经深依赖链可能被拉进本套件；补齐常用 export 避免 mock 缺口。
  resolveChoiceTagColors: () => ({}),
  FALLBACK_TAG_COLORS: {},
}))

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: { info: vi.fn(), success: vi.fn(), error: vi.fn() },
}))

vi.mock('../messages', () => ({
  MessageBubble: ({ message, onUserMessageExpand }: { message: ChatMessage; onUserMessageExpand?: (messageId: string) => void }) => (
    <div data-testid={`bubble-${message.id}`}>
      <button type="button" data-testid={`expand-${message.id}`} onClick={() => onUserMessageExpand?.(message.id)}>
        expand
      </button>
    </div>
  ),
}))

vi.mock('../../turn/AgentAwaitingThought', () => ({
  AgentAwaitingThought: () => <div data-testid="agent-awaiting-thought" />,
}))

vi.mock('../messages/assistant/TurnAgentBadge', () => ({
  TurnAgentBadge: ({ agentId, displayNameOverride, avatarUrlOverride }: {
    agentId?: string | null
    displayNameOverride?: string | null
    avatarUrlOverride?: string | null
  }) => (agentId ? (
    <div
      data-testid="turn-agent-badge"
      data-agent-id={agentId}
      data-agent-name={displayNameOverride}
      data-agent-avatar={avatarUrlOverride}
    />
  ) : null),
}))

vi.mock('../MessageErrorFallback', () => ({
  MessageErrorFallback: () => <div data-testid="message-error-fallback" />,
}))

vi.mock('../../../common/ErrorBoundary', () => ({
  ErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../panel/ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../../checkpoint/RevertBanner', () => ({
  RevertBanner: () => null,
}))

vi.mock('../../turn/TurnNavigatorRail', () => ({
  TurnNavigatorRail: () => null,
}))

vi.mock('@components/common/ListSkeletons', () => ({
  MessageListSkeleton: () => <div data-testid="message-list-skeleton" />,
}))

vi.mock('../../viewport/virtualizerViewportBridge', async () => {
  const actual = await vi.importActual<typeof import('../viewport/virtualizerViewportBridge')>('../../viewport/virtualizerViewportBridge')
  return {
    ...actual,
    shouldAdjustForMeasuredSizeChange: vi.fn((input: { mode: ViewportMode; itemStart: number; scrollOffset: number; scrollAdjustments?: number }) => {
      bridgeHarness.adjustInputs.push(input)
      return actual.shouldAdjustForMeasuredSizeChange(input)
    }),
  }
})

import { streamingContent } from '@/stores/chat/execution/streamingContent'
import { useConversationViewport } from '../../viewport/useConversationViewport'
import { MessageList as StoreMessageList } from '../MessageList'

const MESSAGE_LIST_SOURCE = readFileSync(resolve(__dirname, '../MessageList.tsx'), 'utf8')
const MESSAGE_LIST_VIRTUAL_CONTENT_SOURCE = readFileSync(resolve(__dirname, '../messageList/MessageListVirtualContent.tsx'), 'utf8')
const MESSAGE_LIST_SCROLL_STRATEGY_SOURCE = readFileSync(resolve(__dirname, '../messageList/useMessageListScrollStrategy.ts'), 'utf8')
const MESSAGE_LIST_VIEWPORT_LIFECYCLE_SOURCE = readFileSync(resolve(__dirname, '../messageList/useMessageListViewportLifecycle.ts'), 'utf8')
const MESSAGE_LIST_NAVIGATION_SOURCE = readFileSync(resolve(__dirname, '../messageList/useMessageListNavigation.ts'), 'utf8')
const TASK_EPISODE_VIRTUALIZER_SOURCE = readFileSync(resolve(__dirname, '../../viewport/useTaskEpisodeVirtualizer.ts'), 'utf8')

function makeMessage(partial: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'role'>): ChatMessage {
  return {
    ...partial,
    content: partial.content ?? `content-${partial.id}`,
    created_at: partial.created_at ?? (partial.role === 'assistant' ? '2026-07-12T00:00:01.000Z' : '2026-07-12T00:00:00.000Z'),
  } as ChatMessage
}

type MessageListFixtureProps = React.ComponentProps<typeof StoreMessageList> & {
  messages?: ChatMessage[]
}

const MessageList = React.forwardRef<MessageListHandle, MessageListFixtureProps>(function MessageListFixture(
  { messages, sessionId = 'session-viewport', ...props },
  ref,
) {
  if (messages) {
    chatStoreHarness.messagesBySessionId = {
      ...chatStoreHarness.messagesBySessionId,
      [sessionId]: messages,
    }
  }
  return <StoreMessageList ref={ref} sessionId={sessionId} {...props} />
})

function renderList(overrides: Partial<MessageListFixtureProps> = {}, ref?: React.RefObject<MessageListHandle | null>) {
  const messages = overrides.messages ?? [
    makeMessage({ id: 'user-1', role: 'user', content: 'hello user' }),
    makeMessage({
      id: 'assistant-1',
      role: 'assistant',
      content: 'hello assistant',
    }),
  ]
  return render(<MessageList ref={ref as React.Ref<MessageListHandle>} sessionId="session-viewport" messages={messages} {...overrides} />)
}

describe('MessageList viewport wiring', () => {
  beforeEach(() => {
    viewportHarness.dispatch.mockClear()
    viewportHarness.state.mode = { kind: 'follow-latest' }
    viewportHarness.state.showReturnToLatest = false
    virtualizerHarness.scrollToIndex.mockClear()
    virtualizerHarness.measure.mockClear()
    virtualizerHarness.setTotalSize(240)
    virtualizerHarness.setItemCountOverride(null)
    chatStoreHarness.streamingBySession = {}
    chatStoreHarness.messagesBySessionId = {}
    blocksHarness.record = {}
    activityHarness.isForeground = true
    intersectionHarness.callback = null
    intersectionHarness.root = null
    intersectionHarness.observe.mockReset()
    intersectionHarness.disconnect.mockReset()
    vi.stubGlobal('IntersectionObserver', class IntersectionObserverMock {
      constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
        intersectionHarness.callback = callback
        intersectionHarness.root = options?.root ?? null
      }

      observe = intersectionHarness.observe
      disconnect = intersectionHarness.disconnect
      unobserve = vi.fn()
      takeRecords = vi.fn(() => [])
      root = null
      rootMargin = '0px'
      thresholds = [0]
    })
    bridgeHarness.adjustInputs = []
    pulseHarness.visible = false
    chatStoreHarness.sessionAgentById = {}
    chatStoreHarness.sessionAgentNameById = {}
    chatStoreHarness.sessionAgentAvatarById = {}
    chatStoreHarness.selectedAgentId = null
    streamingContent.clearAll()
    vi.mocked(useConversationViewport).mockClear()
  })

  it('no longer owns stick-to-bottom APIs or direct scrollTop writes', () => {
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\buseStickToBottom\b/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\bpinToBottom\b/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\bsetPinned\b/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\bnotifyProgrammaticScroll\b/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\brecordConversationViewportWrite\b/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\.scrollTop\s*=/)
    expect(MESSAGE_LIST_SOURCE).toMatch(/\buseMessageListScrollStrategy\b/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\bdispatchViewport\b/)
    expect(MESSAGE_LIST_SCROLL_STRATEGY_SOURCE).toMatch(/\buseConversationViewport\b/)
    expect(MESSAGE_LIST_SCROLL_STRATEGY_SOURCE).toMatch(/\bviewportMode\b/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/data-viewport-mode=\{/)
    expect(MESSAGE_LIST_VIRTUAL_CONTENT_SOURCE).not.toMatch(/transform: `translateY\(/)
    expect(MESSAGE_LIST_VIRTUAL_CONTENT_SOURCE).toMatch(/paddingTop: offsetTop/)
    expect(MESSAGE_LIST_VIRTUAL_CONTENT_SOURCE).not.toMatch(/\bvirtualItems\b/)
    expect(MESSAGE_LIST_VIRTUAL_CONTENT_SOURCE).not.toMatch(/\brows\b/)
    expect(MESSAGE_LIST_VIRTUAL_CONTENT_SOURCE).not.toMatch(/\brenderRow\b/)
  })

  it('末尾留白只承担输入区避让，不随消息视口高度变化', () => {
    renderList({ bottomPadding: 180 })
    const spacer = screen.getByTestId('message-list-bottom-spacer')

    expect(spacer.style.height).toBe('280px')
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/const \[viewportHeight, setViewportHeight\]/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/\(viewportHeight \+ composer\) \/ 2/)
  })

  it('末尾留白跟随真实输入区避让高度，并保留最小安全距离', () => {
    const { rerender } = renderList()
    expect(screen.getByTestId('message-list-bottom-spacer').style.height).toBe('132px')

    rerender(<MessageList sessionId="session-viewport" messages={[makeMessage({ id: 'user-1', role: 'user' })]} bottomPadding={240} />)
    expect(screen.getByTestId('message-list-bottom-spacer').style.height).toBe('340px')
  })

  it('初始历史静态呈现；生命周期内 append 的新虚拟行只入场一次', () => {
    const initialMessages = [makeMessage({ id: 'user-1', role: 'user' }), makeMessage({ id: 'assistant-1', role: 'assistant' })]
    const { rerender } = renderList({ messages: initialMessages })
    expect(document.querySelector('[data-message-enter-key="user-1"]')?.className).not.toContain('chat-motion-message-enter')

    rerender(<MessageList sessionId="session-viewport" messages={[...initialMessages, makeMessage({ id: 'user-2', role: 'user' })]} />)
    const appendedRow = document.querySelector('[data-message-enter-key="user-2"]') as HTMLElement
    expect(appendedRow.className).toContain('chat-motion-message-enter')

    fireEvent.animationEnd(appendedRow, {
      animationName: 'chat-motion-rise-in',
    })
    expect(appendedRow.className).not.toContain('chat-motion-message-enter')

    rerender(<MessageList sessionId="session-viewport" messages={[...initialMessages, makeMessage({ id: 'user-2', role: 'user', content: 'updated' })]} />)
    expect(document.querySelector('[data-message-enter-key="user-2"]')?.className).not.toContain('chat-motion-message-enter')
  })

  it('等待占位已呈现 Agent 后，首条 assistant 消息接管时不重复渐入', () => {
    pulseHarness.visible = true
    chatStoreHarness.streamingBySession['session-viewport'] = true
    chatStoreHarness.sessionAgentById['session-viewport'] = 'agent-now'
    chatStoreHarness.sessionAgentNameById['session-viewport'] = 'Owner Agent'
    chatStoreHarness.sessionAgentAvatarById['session-viewport'] = 'https://example.com/owner-agent.png'
    const initialMessages = [makeMessage({ id: 'user-1', role: 'user', content: 'hello' })]
    const { rerender } = renderList({ messages: initialMessages })

    const placeholder = screen.getByTestId('agent-awaiting-thought-placeholder')
    expect(placeholder.className).toContain('chat-motion-message-enter')
    expect(screen.getByTestId('turn-agent-badge').getAttribute('data-agent-id')).toBe('agent-now')
    expect(screen.getByTestId('turn-agent-badge').getAttribute('data-agent-name')).toBe('Owner Agent')
    expect(screen.getByTestId('turn-agent-badge').getAttribute('data-agent-avatar'))
      .toBe('https://example.com/owner-agent.png')

    rerender(
      <MessageList
        sessionId="session-viewport"
        messages={[
          ...initialMessages,
          makeMessage({ id: 'assistant-1', role: 'assistant', content: '' }),
          makeMessage({
            id: 'assistant-2',
            role: 'assistant',
            content: 'answer',
          }),
        ]}
      />,
    )

    expect(screen.queryByTestId('agent-awaiting-thought-placeholder')).toBeNull()
    for (const id of ['assistant-1', 'assistant-2']) {
      const assistantRow = document.querySelector(`[data-message-enter-key="${id}"]`) as HTMLElement
      expect(assistantRow).toBeTruthy()
      expect(assistantRow.className).not.toContain('chat-motion-message-enter')
    }
  })

  it('隐藏内部注入消息，不把它们渲染成时间线气泡', () => {
    renderList({
      messages: [
        makeMessage({
          id: 'memory-1',
          role: 'user',
          message_kind: 'memory_recall',
          content: '<memory_recall>memo</memory_recall>',
        }),
        makeMessage({ id: 'user-1', role: 'user', content: 'hello' }),
        makeMessage({ id: 'assistant-1', role: 'assistant', content: 'reply' }),
      ],
    })

    expect(screen.queryByTestId('bubble-memory-1')).toBeNull()
    expect(screen.getByTestId('bubble-user-1')).toBeTruthy()
    expect(screen.getByTestId('bubble-assistant-1')).toBeTruthy()
    expect(screen.getByTestId('chat-message-list').getAttribute('data-message-count')).toBe('2')
  })

  it('prepend 的历史虚拟行不入场', () => {
    const initialMessages = [makeMessage({ id: 'user-1', role: 'user' }), makeMessage({ id: 'assistant-1', role: 'assistant' })]
    const { rerender } = renderList({ messages: initialMessages })
    rerender(<MessageList sessionId="session-viewport" messages={[makeMessage({ id: 'older-user', role: 'user' }), ...initialMessages]} />)

    expect(document.querySelector('[data-message-enter-key="older-user"]')?.className).not.toContain('chat-motion-message-enter')
  })

  it('dispatches user-read-here with the expanded message id before child expand work', () => {
    renderList()
    viewportHarness.dispatch.mockClear()

    fireEvent.click(screen.getByTestId('expand-user-1'))

    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'user-read-here',
      source: 'expand',
      messageKey: 'user-1',
    })
  })

  it('does not render an empty interrupted assistant row', () => {
    renderList({
      messages: [
        makeMessage({ id: 'user-1', role: 'user', content: 'hello' }),
        makeMessage({
          id: 'assistant-empty-abort',
          role: 'assistant',
          content: '',
          stop_reason: 'aborted',
        }),
        makeMessage({
          id: 'assistant-with-output',
          role: 'assistant',
          content: 'partial answer',
          stop_reason: 'aborted',
        }),
      ],
    })

    expect(screen.getByTestId('bubble-user-1')).toBeTruthy()
    expect(screen.queryByTestId('bubble-assistant-empty-abort')).toBeNull()
    expect(screen.getByTestId('bubble-assistant-with-output')).toBeTruthy()
    expect(screen.getByTestId('chat-message-list').getAttribute('data-message-count')).toBe('2')
  })

  it('imperative scrollToBottom dispatches follow-latest with send source', () => {
    const ref = createRef<MessageListHandle>()
    renderList({}, ref)
    viewportHarness.dispatch.mockClear()

    act(() => {
      ref.current?.scrollToBottom()
    })

    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'follow-latest',
      source: 'send',
    })
  })

  it('return-to-latest button dispatches follow-latest with return-button source', () => {
    viewportHarness.state.showReturnToLatest = true
    const { rerender } = renderList()
    rerender(
      <MessageList
        sessionId="session-viewport"
        messages={[
          makeMessage({ id: 'user-1', role: 'user', content: 'hello user' }),
          makeMessage({
            id: 'assistant-1',
            role: 'assistant',
            content: 'hello assistant',
          }),
        ]}
      />,
    )
    act(() => {
      intersectionHarness.callback?.(
        [{ isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    viewportHarness.dispatch.mockClear()

    fireEvent.click(screen.getByTestId('chat-scroll-to-bottom'))

    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'follow-latest',
      source: 'return-button',
    })
  })

  it('spacer 后的真实底部标记进入视口时隐藏回到底部按钮，离开后恢复显示', () => {
    viewportHarness.state.showReturnToLatest = true
    renderList()

    const marker = screen.getByTestId('message-list-bottom-marker')
    const spacer = screen.getByTestId('message-list-bottom-spacer')
    expect(spacer.nextElementSibling).toBe(marker)
    expect(intersectionHarness.root).toBe(screen.getByTestId('chat-message-list-scroller'))
    expect(intersectionHarness.observe).toHaveBeenCalledWith(marker)
    expect(screen.queryByTestId('chat-scroll-to-bottom')).toBeNull()

    act(() => {
      intersectionHarness.callback?.(
        [{ target: marker, isIntersecting: false } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    expect(screen.queryByTestId('chat-scroll-to-bottom')).not.toBeNull()

    act(() => {
      intersectionHarness.callback?.(
        [{ target: marker, isIntersecting: true } as IntersectionObserverEntry],
        {} as IntersectionObserver,
      )
    })
    expect(screen.queryByTestId('chat-scroll-to-bottom')).toBeNull()
  })

  it('forwards streamingContent notifications as streaming-tick without local rAF coalescing', () => {
    chatStoreHarness.streamingBySession['session-viewport'] = true
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame')
    renderList()
    viewportHarness.dispatch.mockClear()
    const rafCallsBefore = rafSpy.mock.calls.length

    act(() => {
      streamingContent.set('session-viewport', 'assistant-1', 'token-a')
      streamingContent.set('session-viewport', 'assistant-1', 'token-ab')
      streamingContent.set('session-viewport', 'assistant-1', 'token-abc')
    })

    const streamingTicks = viewportHarness.dispatch.mock.calls.filter(([event]) => event.type === 'layout-changed' && event.reason === 'streaming-tick')
    expect(streamingTicks).toHaveLength(3)
    expect(rafSpy.mock.calls.length).toBe(rafCallsBefore)
    rafSpy.mockRestore()
  })

  it('dispatches turn-ended only on true→false streaming transition', () => {
    chatStoreHarness.streamingBySession['session-viewport'] = false
    const { rerender } = renderList()
    const turnEndedOnMount = viewportHarness.dispatch.mock.calls.some(([event]) => event.type === 'layout-changed' && event.reason === 'turn-ended')
    expect(turnEndedOnMount).toBe(false)
    expect(screen.getByTestId('chat-message-list').getAttribute('data-turn-end-phase')).toBe('idle')

    chatStoreHarness.streamingBySession['session-viewport'] = true
    rerender(
      <MessageList
        sessionId="session-viewport"
        messages={[
          makeMessage({ id: 'user-1', role: 'user', content: 'hello user' }),
          makeMessage({
            id: 'assistant-1',
            role: 'assistant',
            content: 'hello assistant',
          }),
        ]}
      />,
    )
    viewportHarness.dispatch.mockClear()
    expect(screen.getByTestId('chat-message-list').getAttribute('data-turn-end-phase')).toBe('idle')

    chatStoreHarness.streamingBySession['session-viewport'] = false
    rerender(
      <MessageList
        sessionId="session-viewport"
        messages={[
          makeMessage({ id: 'user-1', role: 'user', content: 'hello user' }),
          makeMessage({
            id: 'assistant-1',
            role: 'assistant',
            content: 'hello assistant',
          }),
        ]}
      />,
    )

    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'layout-changed',
      reason: 'turn-ended',
    })
    // 同一 commit：turn-ended dispatch 与 beginTurnEnd 共存；phase 离开 idle
    expect(screen.getByTestId('chat-message-list').getAttribute('data-turn-end-phase')).toBe('committing')
  })
  it('restores the real prepend anchor, suppresses only its append event, then allows the next append', () => {
    const onLoadMore = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    virtualizerHarness.setTotalSize(200)
    const initialMessages = [
      makeMessage({ id: 'user-1', role: 'user', content: 'hello user' }),
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello assistant',
      }),
    ]
    const { rerender } = renderList({
      messages: initialMessages,
      hasMore: true,
      onLoadMore,
    })
    const scroller = screen.getByTestId('chat-message-list-scroller')
    scroller.scrollTop = 37
    fireEvent.scroll(scroller)
    act(() => {
      for (const callback of rafCallbacks.splice(0)) callback(performance.now())
    })
    expect(onLoadMore).toHaveBeenCalledTimes(1)

    rerender(<MessageList sessionId="session-viewport" isLoadingMore hasMore onLoadMore={onLoadMore} messages={initialMessages} />)
    viewportHarness.dispatch.mockClear()

    virtualizerHarness.setTotalSize(500)
    const prependedMessages = [
      makeMessage({
        id: 'user-0',
        role: 'user',
        content: 'older',
        created_at: '2026-07-11T23:59:59.000Z',
      }),
      ...initialMessages,
    ]
    rerender(<MessageList sessionId="session-viewport" isLoadingMore={false} hasMore onLoadMore={onLoadMore} messages={prependedMessages} />)

    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'history-prepended',
      scrollTop: 337,
    })
    expect(viewportHarness.dispatch).not.toHaveBeenCalledWith({
      type: 'layout-changed',
      reason: 'message-appended',
    })

    viewportHarness.dispatch.mockClear()
    rerender(
      <MessageList
        sessionId="session-viewport"
        messages={[
          ...prependedMessages,
          makeMessage({
            id: 'assistant-2',
            role: 'assistant',
            content: 'new reply',
            created_at: '2026-07-12T00:00:02.000Z',
          }),
        ]}
      />,
    )
    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'layout-changed',
      reason: 'message-appended',
    })
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/parentRef\.current\.scrollTop\s*=/)
    rafSpy.mockRestore()
  })

  it('clears a split-commit prepend marker before the next real append', () => {
    const onLoadMore = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    const initialMessages = [makeMessage({ id: 'user-1', role: 'user' }), makeMessage({ id: 'assistant-1', role: 'assistant' })]
    virtualizerHarness.setTotalSize(200)
    const { rerender } = renderList({
      messages: initialMessages,
      hasMore: true,
      onLoadMore,
    })
    const scroller = screen.getByTestId('chat-message-list-scroller')
    scroller.scrollTop = 41
    fireEvent.scroll(scroller)
    act(() => {
      for (const callback of rafCallbacks.splice(0)) callback(performance.now())
    })

    rerender(<MessageList sessionId="session-viewport" isLoadingMore messages={initialMessages} />)
    viewportHarness.dispatch.mockClear()
    virtualizerHarness.setTotalSize(500)
    rerender(<MessageList sessionId="session-viewport" isLoadingMore={false} messages={initialMessages} />)
    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'history-prepended',
      scrollTop: 341,
    })

    viewportHarness.dispatch.mockClear()
    rerender(
      <MessageList
        sessionId="session-viewport"
        messages={[
          ...initialMessages,
          makeMessage({
            id: 'assistant-2',
            role: 'assistant',
            created_at: '2026-07-12T00:00:02.000Z',
          }),
        ]}
      />,
    )
    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'layout-changed',
      reason: 'message-appended',
    })
    rafSpy.mockRestore()
  })

  it('clears a zero-diff prepend completion before the next real append', () => {
    const onLoadMore = vi.fn()
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    const initialMessages = [makeMessage({ id: 'user-1', role: 'user' }), makeMessage({ id: 'assistant-1', role: 'assistant' })]
    virtualizerHarness.setTotalSize(200)
    const { rerender } = renderList({
      messages: initialMessages,
      hasMore: true,
      onLoadMore,
    })
    const scroller = screen.getByTestId('chat-message-list-scroller')
    scroller.scrollTop = 29
    fireEvent.scroll(scroller)
    act(() => {
      for (const callback of rafCallbacks.splice(0)) callback(performance.now())
    })
    rerender(<MessageList sessionId="session-viewport" isLoadingMore messages={initialMessages} />)
    viewportHarness.dispatch.mockClear()

    rerender(<MessageList sessionId="session-viewport" isLoadingMore={false} messages={initialMessages} />)
    expect(viewportHarness.dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'history-prepended' }))

    viewportHarness.dispatch.mockClear()
    rerender(
      <MessageList
        sessionId="session-viewport"
        messages={[
          ...initialMessages,
          makeMessage({
            id: 'assistant-2',
            role: 'assistant',
            created_at: '2026-07-12T00:00:02.000Z',
          }),
        ]}
      />,
    )
    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'layout-changed',
      reason: 'message-appended',
    })
    rafSpy.mockRestore()
  })

  it('dispatches streaming-tail-first-block once for the first blocksRecord change only', () => {
    chatStoreHarness.streamingBySession['session-viewport'] = true
    blocksHarness.record = { version: 0 }
    const messages = [
      makeMessage({ id: 'user-1', role: 'user', content: 'hello user' }),
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello assistant',
      }),
    ]
    const { rerender } = renderList({ messages })
    viewportHarness.dispatch.mockClear()

    blocksHarness.record = { version: 1 }
    rerender(<MessageList sessionId="session-viewport" messages={messages} />)

    expect(viewportHarness.dispatch.mock.calls.filter(([event]) => event.type === 'layout-changed' && event.reason === 'streaming-tail-first-block')).toHaveLength(1)

    blocksHarness.record = { version: 2 }
    rerender(<MessageList sessionId="session-viewport" messages={messages} />)

    blocksHarness.record = { version: 3 }
    rerender(<MessageList sessionId="session-viewport" messages={messages} />)

    expect(viewportHarness.dispatch.mock.calls.filter(([event]) => event.type === 'layout-changed' && event.reason === 'streaming-tail-first-block')).toHaveLength(1)
  })

  it('dispatches navigate before virtualizer.scrollToIndex for scroll targets', () => {
    const messages = [
      makeMessage({
        id: 'user-1',
        role: 'user',
        content: 'hello user',
        created_at: '2026-07-12T00:00:00.000Z',
      }),
      makeMessage({
        id: 'assistant-1',
        role: 'assistant',
        content: 'hello assistant',
        created_at: '2026-07-12T00:00:01.000Z',
      }),
    ]
    const { rerender } = renderList({ messages })
    viewportHarness.dispatch.mockClear()
    virtualizerHarness.scrollToIndex.mockClear()

    rerender(<MessageList sessionId="session-viewport" messages={messages} scrollTargetMessageId="assistant-1" />)

    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'navigate',
      messageKey: 'assistant-1',
      align: 'center',
    })
    expect(virtualizerHarness.scrollToIndex).toHaveBeenCalledWith(1, expect.objectContaining({ align: 'center' }))
    const navigateOrder = viewportHarness.dispatch.mock.invocationCallOrder[viewportHarness.dispatch.mock.calls.findIndex(([event]) => event.type === 'navigate')]
    const scrollOrder = virtualizerHarness.scrollToIndex.mock.invocationCallOrder[0]
    expect(navigateOrder).toBeLessThan(scrollOrder)
  })

  it('keeps measured-size scroll writes disabled in both viewport modes', () => {
    const messages = [makeMessage({ id: 'user-1', role: 'user' }), makeMessage({ id: 'assistant-1', role: 'assistant' })]
    const { rerender } = renderList({ messages })
    const followCallback = virtualizerHarness.getLatestInstance()?.shouldAdjustScrollPositionOnItemSizeChange
    expect(followCallback?.({ start: 20, end: 80 }, 10, { scrollOffset: 100 })).toBe(false)
    expect(bridgeHarness.adjustInputs.at(-1)?.mode.kind).toBe('follow-latest')

    viewportHarness.state.mode = {
      kind: 'anchored-reading',
      reason: 'browse-history',
    }
    rerender(<MessageList sessionId="session-viewport" messages={messages} />)
    const anchoredCallback = virtualizerHarness.getLatestInstance()?.shouldAdjustScrollPositionOnItemSizeChange
    expect(anchoredCallback?.({ start: 20, end: 80 }, 10, { scrollOffset: 100 })).toBe(false)
    expect(bridgeHarness.adjustInputs.at(-1)?.mode.kind).toBe('anchored-reading')

    expect(anchoredCallback?.({ start: 20, end: 900 }, 10, { scrollOffset: 100 })).toBe(false)
  })

  it('routes virtualizer special paths through virtualizerViewportBridge helpers', () => {
    const viewportSource = MESSAGE_LIST_SCROLL_STRATEGY_SOURCE + MESSAGE_LIST_VIEWPORT_LIFECYCLE_SOURCE + MESSAGE_LIST_NAVIGATION_SOURCE
    expect(viewportSource).toMatch(/from '\.\.\/(?:\.\.\/)?viewport\/virtualizerViewportBridge'/)
    expect(TASK_EPISODE_VIRTUALIZER_SOURCE).toMatch(/shouldAdjustForMeasuredSizeChange/)
    expect(MESSAGE_LIST_VIEWPORT_LIFECYCLE_SOURCE).toMatch(/applyPrependCompensation/)
    expect(MESSAGE_LIST_NAVIGATION_SOURCE).toMatch(/navigateToVirtualItem/)
    expect(MESSAGE_LIST_VIEWPORT_LIFECYCLE_SOURCE).toMatch(/restoreForegroundViewport/)
    expect(MESSAGE_LIST_VIEWPORT_LIFECYCLE_SOURCE).toMatch(/recoverEmptyVirtualWindow/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/shouldMessageListAdjustForMeasuredSizeChange/)
    expect(MESSAGE_LIST_SOURCE).not.toMatch(/from '\.\/messageListScrollPolicy'/)
    // scrollToIndex：bridge 闭包 + session 切换时直接滚末条（统一签名 index, options）
    expect(viewportSource.match(/virtualizer\.scrollToIndex/g)?.length).toBe(4)
    expect(viewportSource).not.toMatch(/virtualizer\.scrollToIndex\((?!index[,)])/)
    expect(viewportSource).not.toMatch(/dispatchViewport\(\{\s*type:\s*'navigate'/)
    expect(viewportSource).not.toMatch(/dispatchViewport\(\{\s*type:\s*'history-prepended'/)
    expect(viewportSource).not.toMatch(/reason:\s*'foreground-restored'/)
  })

  it('restores foreground measurement without fabricating follow-latest', () => {
    const rafCallbacks: FrameRequestCallback[] = []
    const rafSpy = vi.spyOn(window, 'requestAnimationFrame').mockImplementation((callback) => {
      rafCallbacks.push(callback)
      return rafCallbacks.length
    })
    const messages = [makeMessage({ id: 'user-1', role: 'user' }), makeMessage({ id: 'assistant-1', role: 'assistant' })]
    activityHarness.isForeground = false
    const { rerender } = renderList({ messages })
    viewportHarness.dispatch.mockClear()
    virtualizerHarness.measure.mockClear()

    activityHarness.isForeground = true
    rerender(<MessageList sessionId="session-viewport" messages={messages} />)
    act(() => {
      for (const callback of rafCallbacks.splice(0)) callback(performance.now())
    })

    expect(virtualizerHarness.measure).toHaveBeenCalled()
    expect(viewportHarness.dispatch).toHaveBeenCalledWith({
      type: 'layout-changed',
      reason: 'foreground-restored',
    })
    expect(viewportHarness.dispatch).not.toHaveBeenCalledWith({
      type: 'follow-latest',
      source: expect.anything(),
    })
    rafSpy.mockRestore()
  })

  it('#6072：message_start 前「思考中」占位与消息列表共用 contentPadding，避免首帧贴边再右移', () => {
    pulseHarness.visible = true
    chatStoreHarness.sessionAgentById['session-viewport'] = 'agent-now'
    renderList({
      messages: [makeMessage({ id: 'user-1', role: 'user', content: 'hello' })],
      contentPadding: 'pl-9 pr-5',
    })

    const placeholder = screen.getByTestId('agent-awaiting-thought-placeholder')
    expect(placeholder.className.split(/\s+/)).toContain('pl-9')
    expect(placeholder.className.split(/\s+/)).toContain('pr-5')
    // 消息行容器也带同一 gutter——占位若缺此 class，会相对消息内容横向跳动。
    expect(MESSAGE_LIST_SOURCE).toMatch(/data-testid="agent-awaiting-thought-placeholder"[\s\S]*?className=\{cn\(contentPadding,/)
    const badge = screen.getByTestId('turn-agent-badge')
    expect(badge.getAttribute('data-agent-id')).toBe('agent-now')
  })
})
