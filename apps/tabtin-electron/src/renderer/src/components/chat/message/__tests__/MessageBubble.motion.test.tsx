/**
 * 消息历史识别 + 流式段尾光标（纯表现层）。
 */
import React from 'react'
import { render } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import {
  IDLE_TURN_END_LAYOUT,
  TurnEndLayoutProvider,
} from '../../viewport/TurnEndLayoutContext'
import { resolveHistoricalMessageEnterKeys } from '../messageList/messageEnterMotion'

const blockTimelineSpy = vi.hoisted(() => vi.fn())

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) => key,
    i18n: { language: 'zh-CN' },
  }),
}))

vi.mock('../../markdown/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content, isStreaming }: { content: string; isStreaming?: boolean }) => (
    <div data-testid="mock-markdown" data-is-streaming={isStreaming ? 'true' : undefined}>
      {content}
    </div>
  ),
}))

vi.mock('../../blocks', () => ({
  BlockTimeline: (props: unknown) => {
    blockTimelineSpy(props)
    return <div data-testid="mock-block-timeline" />
  },
}))

vi.mock('../messages/assistant/ErrorClassCard', () => ({
  ErrorClassCard: () => <div data-testid="mock-error-class-card" />,
}))

vi.mock('../../billing/BillingErrorCard', () => ({
  BillingErrorCard: () => <div data-testid="mock-billing-error-card" />,
}))

vi.mock('../messages/common/', () => ({
  MSG_COLLAPSE_ENABLED: true,
  MSG_COLLAPSE_CHAR_THRESHOLD: 50_000,
  CollapsibleMessage: ({ children }: { children: () => React.ReactNode }) => <>{children()}</>,
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  PopoverContent: () => null,
  TooltipProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Tooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  cn: (...classes: Array<string | false | null | undefined>) => classes.filter(Boolean).join(' '),
  resolveChoiceTagColors: () => ({}),
  FALLBACK_TAG_COLORS: {},
}))

import { AssistantMessageBody } from '../messages/assistant/AssistantMessageBody'

function makeAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'asst-1',
    role: 'assistant',
    content: 'streaming body',
    created_at: '2026-07-20T00:00:01Z',
    message_kind: 'llm',
    ...overrides,
  } as ChatMessage
}

describe('message enter historical window detection', () => {
  it('只把 prepend / 整窗替换识别为历史，普通 append 与头部淘汰返回空', () => {
    expect(resolveHistoricalMessageEnterKeys(
      ['m1', 'm2'],
      ['old-1', 'old-2', 'm1', 'm2'],
    )).toEqual(['old-1', 'old-2'])
    expect(resolveHistoricalMessageEnterKeys(
      ['m1', 'm2'],
      ['around-1', 'around-2'],
    )).toEqual(['around-1', 'around-2'])
    expect(resolveHistoricalMessageEnterKeys(
      ['m1', 'm2'],
      ['m1', 'm2', 'new-1'],
    )).toEqual([])
    expect(resolveHistoricalMessageEnterKeys(
      ['evicted', 'm2'],
      ['m2', 'new-1'],
    )).toEqual([])
  })
})

describe('AssistantMessageBody streaming caret', () => {
  const noopNav = () => {}
  const noopMenu = () => {}

  function renderBody(overrides: Partial<React.ComponentProps<typeof AssistantMessageBody>> = {}) {
    return render(
      <TurnEndLayoutProvider value={IDLE_TURN_END_LAYOUT}>
        <AssistantMessageBody
          message={makeAssistant()}
          sessionId="sess-motion"
          isStreaming
          isActiveSession
          runStateSuspended={false}
          suppressInlineLoading={false}
          contentBlocks={[]}
          hasContentBlocks={false}
          displayContent="hello caret"
          errorClassInfo={null}
          suppressBlockPartialReason={false}
          shouldRenderInterruptedBadge={false}
          errorClassSkipContent={false}
          isBillingError={false}
          stalledLevel={0}
          showAwaitingThought={false}
          showPlanningNext={false}
          isLastAssistantMsg
          onResourceNavigate={noopNav}
          onResourceContextMenu={noopMenu}
          {...overrides}
        />
      </TurnEndLayoutProvider>,
    )
  }

  it('流式与已完成 Thinking 都用 filename 替换 file_id', () => {
    const fileId = '209afbfb-0739-4aa9-b5a9-f944cd040581'
    renderBody({
      timelineMessages: [{
        id: 'user-with-file',
        role: 'user',
        content: '读取附件',
        created_at: '2026-08-15T00:00:00Z',
        attachments_json: [{
          type: 'file',
          file_id: fileId,
          filename: '测试word.docx',
          mime_type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          size: 37_600,
        }],
      } as ChatMessage],
      hasContentBlocks: true,
      contentBlocks: [{
        index: 0,
        block_id: 'thinking-streaming',
        block: { type: 'thinking', thinking: `正在解析 ${fileId}`, signature: 'sig' },
        finalized: false,
        partial: false,
      }, {
        index: 1,
        block_id: 'thinking-finalized',
        block: { type: 'thinking', thinking: `已读取 ${fileId}`, signature: 'sig' },
        finalized: true,
        partial: false,
      }],
    })

    const latestProps = blockTimelineSpy.mock.calls.at(-1)?.[0] as {
      blocks: Array<{ block: { thinking?: string } }>
    }
    expect(latestProps.blocks[0].block.thinking).toBe('正在解析 测试word.docx')
    expect(latestProps.blocks[1].block.thinking).toBe('已读取 测试word.docx')
  })

  it('正文 text 块流式时挂 caret 宿主；结束后立即移除', () => {
    const liveBlock = {
      index: 0,
      block_id: 't1',
      block: { type: 'text' as const, text: 'partial' },
      finalized: false,
      partial: false,
    }
    const { rerender } = renderBody({
      hasContentBlocks: true,
      contentBlocks: [liveBlock],
      displayContent: '',
    })
    expect(document.querySelector('[data-streaming-caret="true"]')?.className)
      .toContain('chat-motion-streaming-body')

    rerender(
      <TurnEndLayoutProvider value={IDLE_TURN_END_LAYOUT}>
        <AssistantMessageBody
          message={makeAssistant()}
          sessionId="sess-motion"
          isStreaming={false}
          isActiveSession
          runStateSuspended={false}
          suppressInlineLoading={false}
          contentBlocks={[{ ...liveBlock, finalized: true }]}
          hasContentBlocks
          displayContent=""
          errorClassInfo={null}
          suppressBlockPartialReason={false}
          shouldRenderInterruptedBadge={false}
          errorClassSkipContent={false}
          isBillingError={false}
          stalledLevel={0}
          showAwaitingThought={false}
          showPlanningNext={false}
          isLastAssistantMsg
          onResourceNavigate={noopNav}
          onResourceContextMenu={noopMenu}
        />
      </TurnEndLayoutProvider>,
    )
    expect(document.querySelector('[data-streaming-caret="true"]')).toBeNull()
  })

  it('思考等待壳可见时不渲染 caret，避免与 breathe 并存', () => {
    renderBody({
      showAwaitingThought: true,
      hasContentBlocks: true,
      contentBlocks: [{
        index: 0,
        block_id: 't1',
        block: { type: 'text' as const, text: 'partial' },
        finalized: false,
        partial: false,
      }],
      displayContent: '',
    })
    expect(document.querySelector('[data-streaming-caret="true"]')).toBeNull()
  })

  it('仅有未 finalize 的 text 块时挂 caret；全部 finalize 后不挂', () => {
    const liveBlock = {
      index: 0,
      block_id: 't1',
      block: { type: 'text' as const, text: 'partial' },
      finalized: false,
      partial: false,
    }
    const { rerender } = renderBody({
      hasContentBlocks: true,
      contentBlocks: [liveBlock],
      displayContent: '',
    })
    expect(document.querySelector('[data-streaming-caret="true"]')).toBeTruthy()

    rerender(
      <TurnEndLayoutProvider value={IDLE_TURN_END_LAYOUT}>
        <AssistantMessageBody
          message={makeAssistant()}
          sessionId="sess-motion"
          isStreaming
          isActiveSession
          runStateSuspended={false}
          suppressInlineLoading={false}
          contentBlocks={[{ ...liveBlock, finalized: true }]}
          hasContentBlocks
          displayContent=""
          errorClassInfo={null}
          suppressBlockPartialReason={false}
          shouldRenderInterruptedBadge={false}
          errorClassSkipContent={false}
          isBillingError={false}
          stalledLevel={0}
          showAwaitingThought={false}
          showPlanningNext={false}
          isLastAssistantMsg
          onResourceNavigate={noopNav}
          onResourceContextMenu={noopMenu}
        />
      </TurnEndLayoutProvider>,
    )
    expect(document.querySelector('[data-streaming-caret="true"]')).toBeNull()
  })
})
