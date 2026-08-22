/**
 * MessageBubble turn-end 收尾窗口：spacer / tail 互斥 / markClosingUiReady + release。
 * 渲染真实 MessageBubble 条件分支；重依赖可 mock。
 */
import React from 'react'
import { act, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import { STEP_ROW } from '../../registry/chatDesignTokens'
import {
  IDLE_TURN_END_LAYOUT,
  TurnEndLayoutProvider,
  type TurnEndLayoutValue,
} from '../../viewport/TurnEndLayoutContext'

const chatStoreState = vi.hoisted(() => ({
  currentSessionId: 'sess-1' as string | null,
  restoringSessionId: null as string | null,
  messagesBySessionId: {} as Record<string, ChatMessage[]>,
}))

const runtimeState = vi.hoisted(() => ({
  runStateBySessionId: {} as Record<string, unknown>,
  toolEventsBySessionId: {} as Record<string, unknown[]>,
  // ：会话 busy 走执行态单一投影（useSessionBusy 读它）。
  runProjectionBySessionId: {} as Record<string, { busy: boolean }>,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('../../../../stores/chat/useChatStore', () => ({
  useChatStore: Object.assign(
    (selector: (s: typeof chatStoreState) => unknown) => selector(chatStoreState),
    {
      getState: () => ({
        ...chatStoreState,
        requestRewindPreview: vi.fn(),
        rollbackAgentRun: vi.fn(),
        setReplyTarget: vi.fn(),
        navigateToMessage: vi.fn(),
      }),
    },
  ),
}))

vi.mock('../../../../stores/useAuthStore', () => ({
  useAuthStore: (selector: (s: { user: { id: string } | null }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('../../../../stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: (selector: (s: typeof runtimeState) => unknown) => selector(runtimeState),
}))

vi.mock('../../../../stores/chat/messages/messageBlocks', () => ({
  useMessageBlocksById: () => [],
}))

vi.mock('../../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => (
    <div data-testid="mock-markdown">{content}</div>
  ),
}))

vi.mock('../../blocks', () => ({
  BlockTimeline: ({
    blocks,
    suppressInlineLoading,
  }: {
    blocks: Array<{
      block?: { type?: string; thinking?: string }
      finalized?: boolean
    }>
    suppressInlineLoading?: boolean
  }) => (
    <div
      data-testid="mock-block-timeline"
      data-suppress-inline-loading={String(!!suppressInlineLoading)}
    >
      {blocks.some(
        (entry) =>
          entry.block?.type === 'thinking'
          && entry.finalized === false
          && !!entry.block.thinking?.trim(),
      ) && <div data-testid="mock-thinking-streaming" />}
    </div>
  ),
}))

vi.mock('../../tool/CodeDiffReviewCard', () => ({
  CodeDiffReviewCard: () => <div data-testid="code-diff-review-card" />,
}))

vi.mock('../../turn/TurnArtifactsCard', () => ({
  TurnArtifactsCard: () => <div data-testid="turn-artifacts-card" />,
}))

vi.mock('../messages/common/', () => ({
  MessageActions: () => <div data-testid="message-actions" />,
}))

vi.mock('../../billing/MessageCostLabel', () => ({
  MessageCostLabel: () => null,
}))

vi.mock('../messages/common/', () => ({
  MSG_COLLAPSE_ENABLED: true,
  MSG_COLLAPSE_CHAR_THRESHOLD: 50_000,
  CollapsibleMessage: ({
    children,
  }: {
    children: () => React.ReactNode
  }) => <>{children()}</>,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  ConfirmDialog: () => null,
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
}))

import { MessageBubble } from '../messages'
import { MessageListTimelineRow } from '../messageList/MessageListTimelineRow'
import { projectTaskEpisodeTimeline } from '@stores/chat/presentation/messageTimeline/taskEpisodeTimelineProjection'
import type { TurnArtifact } from '../../turn/turnArtifacts'

function makeAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'asst-1',
    role: 'assistant',
    content: 'hello from agent',
    created_at: '2026-07-12T00:00:00Z',
    message_kind: 'llm',
    ...overrides,
  } as ChatMessage
}

function makeTurnEndValue(
  partial: Partial<TurnEndLayoutValue> = {},
): TurnEndLayoutValue {
  return {
    phase: 'committing',
    closingUiReady: false,
    shouldHoldThinkingPreviewBudget: true,
    shouldHoldClosingSpacer: true,
    markClosingUiReady: vi.fn(),
    release: vi.fn(),
    ...partial,
  }
}

function renderBubble(
  props: Partial<React.ComponentProps<typeof MessageBubble>> & {
    message?: ChatMessage
  },
  turnEnd?: TurnEndLayoutValue | null,
) {
  const message = props.message ?? makeAssistant()
  const bubble = (
    <MessageBubble
      message={message}
      sessionId="sess-1"
      isLastAssistantMsg
      sessionPulseVisible={false}
      isLastInTurn
      {...props}
    />
  )
  if (turnEnd === null) {
    return render(bubble)
  }
  return render(
    <TurnEndLayoutProvider value={turnEnd ?? makeTurnEndValue()}>
      {bubble}
    </TurnEndLayoutProvider>,
  )
}

describe('MessageBubble turn-end closing window', () => {
  beforeEach(() => {
    chatStoreState.currentSessionId = 'sess-1'
    runtimeState.runProjectionBySessionId = {}
    chatStoreState.restoringSessionId = null
    chatStoreState.messagesBySessionId = { 'sess-1': [] }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('committing 且无会话脉冲时渲染 turn-end spacer，高度对齐 STEP_ROW.inline', () => {
    const value = makeTurnEndValue({
      // 受控 Provider：ready 不推进，便于断言 spacer 存在
      markClosingUiReady: vi.fn(),
      release: vi.fn(),
    })
    renderBubble({}, value)

    const spacer = screen.getByTestId('agent-turn-end-spacer')
    expect(spacer).toBeTruthy()
    expect(spacer.className).toContain(STEP_ROW.inline.split(' ')[0]!)
    expect(screen.queryByTestId('agent-streaming-tail')).toBeNull()
  })

  it('正文直出时由正文块独占，不与等待壳并存', () => {
    const value = makeTurnEndValue()
    renderBubble(
      {
        sessionPulseVisible: true,
        message: makeAssistant({
          content: '',
          blocks: [
            {
              index: 0,
              block_id: 'b1',
              block: { type: 'text', text: 'streaming' },
              finalized: false,
              partial: true,
            },
          ] as ChatMessage['blocks'],
        }),
      },
      value,
    )

    // 正文已经可见，等待壳立即让位；无圆环
    expect(screen.queryByTestId('agent-awaiting-thought')).toBeNull()
    expect(screen.queryByTestId('agent-streaming-tail')).toBeNull()
    expect(screen.queryByTestId('agent-turn-end-spacer')).toBeNull()
    // BlockTimeline 收到 suppressInlineLoading，避免块内第二 spinner
    expect(screen.getByTestId('mock-block-timeline').getAttribute('data-suppress-inline-loading')).toBe(
      'true',
    )
  })

  it('工具后真实 thinking 正文出现时，Thinking 独占且不显示 planningNext', () => {
    renderBubble(
      {
        sessionPulseVisible: true,
        message: makeAssistant({
          content: '',
          blocks: [
            {
              index: 0,
              block_id: 'tool-1',
              block: { type: 'tool_use', id: 'tu-1', name: 'read_file' },
              finalized: true,
              partial: false,
            },
            {
              index: 1,
              block_id: 'result-1',
              block: { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
              finalized: true,
              partial: false,
            },
            {
              index: 2,
              block_id: 't1',
              block: { type: 'thinking', thinking: '...' },
              finalized: false,
              partial: true,
            },
          ] as ChatMessage['blocks'],
        }),
      },
      makeTurnEndValue(),
    )

    expect(screen.queryByTestId('agent-awaiting-thought')).toBeNull()
    expect(screen.getByTestId('mock-thinking-streaming')).toBeTruthy()
    expect(screen.queryByTestId('agent-streaming-tail')).toBeNull()
    expect(screen.getByTestId('mock-block-timeline').getAttribute('data-suppress-inline-loading')).toBe(
      'true',
    )
  })

  it('空 thinking 块到达时仍挂「正在计划下一步」（与 Thinking 空壳不打架）', () => {
    vi.useFakeTimers()
    renderBubble(
      {
        sessionPulseVisible: true,
        message: makeAssistant({
          content: '',
          blocks: [
            {
              index: 0,
              block_id: 'tool-1',
              block: { type: 'tool_use', id: 'tu-1', name: 'read_file' },
              finalized: true,
              partial: false,
            },
            {
              index: 1,
              block_id: 'result-1',
              block: { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
              finalized: true,
              partial: false,
            },
            {
              index: 2,
              block_id: 't-empty',
              block: { type: 'thinking', text: '' },
              finalized: false,
              partial: true,
            },
          ] as ChatMessage['blocks'],
        }),
      },
      makeTurnEndValue(),
    )

    act(() => {
      vi.advanceTimersByTime(200)
    })

    const shell = screen.getByTestId('agent-awaiting-thought')
    expect(shell.getAttribute('data-mode')).toBe('planningNext')
  })

  it('工具执行结束后仍在脉冲时显示「正在计划下一步...」', () => {
    vi.useFakeTimers()
    // tool_result 同条 blocks 表示工具已 settle；否则仍算执行中，不挂 planningNext
    renderBubble(
      {
        sessionPulseVisible: true,
        message: makeAssistant({
          content: '',
          blocks: [
            {
              index: 0,
              block_id: 'tool-1',
              block: { type: 'tool_use', id: 'tu-1', name: 'read_file' },
              finalized: true,
              partial: false,
            },
            {
              index: 1,
              block_id: 'result-1',
              block: { type: 'tool_result', tool_use_id: 'tu-1', content: 'ok' },
              finalized: true,
              partial: false,
            },
          ] as ChatMessage['blocks'],
        }),
      },
      makeTurnEndValue(),
    )

    act(() => {
      vi.advanceTimersByTime(200)
    })

    const shell = screen.getByTestId('agent-awaiting-thought')
    expect(shell.getAttribute('data-mode')).toBe('planningNext')
    expect(shell.textContent).toContain('blockTimeline.thinking.planningNext')
  })

  it('工具仍在执行时不显示「正在计划下一步...」', () => {
    vi.useFakeTimers()
    renderBubble(
      {
        sessionPulseVisible: true,
        message: makeAssistant({
          content: '',
          blocks: [
            {
              index: 0,
              block_id: 'tool-1',
              block: { type: 'tool_use', id: 'tu-1', name: 'read_file' },
              finalized: true,
              partial: false,
            },
          ] as ChatMessage['blocks'],
        }),
      },
      makeTurnEndValue(),
    )

    act(() => {
      vi.advanceTimersByTime(200)
    })

    expect(screen.queryByTestId('agent-awaiting-thought')).toBeNull()
  })

  it('layout effect 标记 ready 后 spacer 消失，footer / artifacts 仍可见', () => {
    const markClosingUiReady = vi.fn()
    const release = vi.fn()
    const value = makeTurnEndValue({ markClosingUiReady, release })
    const artifacts: TurnArtifact[] = [
      {
        id: 'art-1',
        title: 'doc',
        kind: 'doc',
        href: 'tabtin://doc/r1',
        subtitleKey: 'previewDoc',
      },
    ]

    const { rerender } = render(
      <TurnEndLayoutProvider value={value}>
        <MessageBubble
          message={makeAssistant({
            diff_summary: { changed: 1, insertions: 1, deletions: 0, files: [] },
          })}
          timelineMessages={[makeAssistant({
            diff_summary: { changed: 1, insertions: 1, deletions: 0, files: [] },
          })]}
          sessionId="sess-1"
          isLastAssistantMsg
          sessionPulseVisible={false}
          isLastInTurn
          turnArtifacts={artifacts}
        />
      </TurnEndLayoutProvider>,
    )

    expect(markClosingUiReady).toHaveBeenCalled()
    expect(screen.getByTestId('agent-turn-end-spacer')).toBeTruthy()
    expect(screen.getByTestId('message-actions')).toBeTruthy()
    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()
    expect(screen.getByTestId('turn-artifacts-card')).toBeTruthy()

    const readyValue = makeTurnEndValue({
      closingUiReady: true,
      shouldHoldClosingSpacer: false,
      markClosingUiReady,
      release,
    })
    rerender(
      <TurnEndLayoutProvider value={readyValue}>
        <MessageBubble
          message={makeAssistant({
            diff_summary: { changed: 1, insertions: 1, deletions: 0, files: [] },
          })}
          timelineMessages={[makeAssistant({
            diff_summary: { changed: 1, insertions: 1, deletions: 0, files: [] },
          })]}
          sessionId="sess-1"
          isLastAssistantMsg
          sessionPulseVisible={false}
          isLastInTurn
          turnArtifacts={artifacts}
        />
      </TurnEndLayoutProvider>,
    )

    expect(screen.queryByTestId('agent-turn-end-spacer')).toBeNull()
    expect(screen.getByTestId('message-actions')).toBeTruthy()
    expect(screen.queryByTestId('code-diff-review-card')).toBeNull()
    expect(screen.getByTestId('turn-artifacts-card')).toBeTruthy()
  })

  it('合并 assistant run 后仍在最终回复展示轮末产物', () => {
    const messages = [
      makeAssistant({ id: 'user-1', role: 'user', created_at: '2026-08-13T00:00:00Z' }),
      makeAssistant({ id: 'assistant-tools', created_at: '2026-08-13T00:00:01Z' }),
      makeAssistant({
        id: 'context',
        role: 'system',
        message_kind: 'agent_profile_context',
        created_at: '2026-08-13T00:00:02Z',
      }),
      makeAssistant({ id: 'assistant-final', created_at: '2026-08-13T00:00:03Z' }),
    ]
    const timeline = projectTaskEpisodeTimeline(messages)
    const mergedRow = timeline.rows.find(
      (row) => row.renderMessage.id === 'assistant-final' && !row.isRunPlaceholder,
    )
    const artifacts: TurnArtifact[] = [{
      id: 'artifact-1',
      title: 'file1.txt',
      kind: 'file',
      href: 'tabtin://resource/file/file1.txt',
      subtitleKey: 'previewFile',
    }]

    expect(mergedRow).toBeTruthy()
    render(
      <MessageListTimelineRow
        row={mergedRow!}
        rendering={{
          messages: timeline.messages,
          sessionId: 'sess-1',
          tabScopeKey: null,
          lastAssistantMsgId: 'assistant-final',
          includeSubagentMessages: false,
          isStreaming: false,
          highlightedMessageId: null,
          highlightKey: '',
          turnArtifactsByEndIndex: new Map([[mergedRow!.renderMessageIndex, artifacts]]),
          userAlign: 'right',
          onUserMessageExpand: vi.fn(),
        }}
      />,
    )

    expect(screen.getByTestId('turn-artifacts-card')).toBeTruthy()
  })

  it('markClosingUiReady 后不抢先 release（由 phase settleMs 释放）', async () => {
    vi.useFakeTimers({ toFake: ['requestAnimationFrame', 'cancelAnimationFrame'] })
    const markClosingUiReady = vi.fn()
    const release = vi.fn()
    const value = makeTurnEndValue({ markClosingUiReady, release })

    const { unmount } = renderBubble({}, value)
    expect(markClosingUiReady).toHaveBeenCalledTimes(1)
    expect(release).not.toHaveBeenCalled()

    await act(async () => {
      vi.runOnlyPendingTimers()
    })
    // Bubble 只宣告 closing UI ready；Thinking/工具组预算留给 TurnEndLayoutPhase
    expect(release).not.toHaveBeenCalled()
    unmount()
  })

  it('非末条 assistant / 无 Provider（历史）不调用 ready/release', () => {
    const markClosingUiReady = vi.fn()
    const release = vi.fn()

    renderBubble(
      { isLastAssistantMsg: false },
      makeTurnEndValue({ markClosingUiReady, release }),
    )
    expect(markClosingUiReady).not.toHaveBeenCalled()
    expect(release).not.toHaveBeenCalled()
    expect(screen.queryByTestId('agent-turn-end-spacer')).toBeNull()

    // 无 Provider → idle no-op；不得因历史渲染误触发（用 spy 包一层 IDLE）
    const idleReady = vi.fn()
    const idleRelease = vi.fn()
    render(
      <TurnEndLayoutProvider
        value={{
          ...IDLE_TURN_END_LAYOUT,
          markClosingUiReady: idleReady,
          release: idleRelease,
        }}
      >
        <MessageBubble
          message={makeAssistant({ id: 'hist-1' })}
          sessionId="sess-1"
          isLastAssistantMsg
          sessionPulseVisible={false}
          isLastInTurn
        />
      </TurnEndLayoutProvider>,
    )
    expect(idleReady).not.toHaveBeenCalled()
    expect(idleRelease).not.toHaveBeenCalled()
  })

  it('tool_artifact 跳过 footer 仍视为 closing ready（避免等 maxMs）', () => {
    const markClosingUiReady = vi.fn()
    const release = vi.fn()
    renderBubble(
      {
        message: makeAssistant({
          message_kind: 'tool_artifact',
          content: 'tool output',
        }),
      },
      makeTurnEndValue({ markClosingUiReady, release }),
    )
    expect(markClosingUiReady).toHaveBeenCalled()
    expect(screen.queryByTestId('message-actions')).toBeNull()
  })

  it('现有 footer 条件回归：llm 非 streaming 显示 footer；streaming 末条隐藏', () => {
    const { unmount } = renderBubble(
      { message: makeAssistant({ content: 'done' }) },
      makeTurnEndValue({ shouldHoldClosingSpacer: false, closingUiReady: true }),
    )
    expect(screen.getByTestId('message-actions')).toBeTruthy()
    unmount()

    runtimeState.runProjectionBySessionId = { 'sess-1': { busy: true } }
    renderBubble(
      {
        message: makeAssistant({ content: 'streaming…' }),
        sessionPulseVisible: true,
      },
      makeTurnEndValue({ shouldHoldClosingSpacer: false }),
    )
    expect(screen.queryByTestId('message-actions')).toBeNull()
  })

  it('settling 阶段同样可持有 spacer', () => {
    renderBubble(
      {},
      makeTurnEndValue({
        phase: 'settling',
        closingUiReady: false,
        shouldHoldClosingSpacer: true,
        markClosingUiReady: vi.fn(),
        release: vi.fn(),
      }),
    )
    expect(screen.getByTestId('agent-turn-end-spacer')).toBeTruthy()
  })
})
