import React from 'react'
import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ChatMessage } from '@tabtin/chat-client'
import type { ContentBlockEntry } from '../../blocks/types'
import { EmbeddedMessageTimeline } from '../EmbeddedMessageTimeline'

const chatStoreHarness = vi.hoisted(() => ({
  messagesBySessionId: {} as Record<string, ChatMessage[]>,
}))

const blockTimelineHarness = vi.hoisted(() => ({
  calls: [] as Array<{ ownerRunId?: string; messageId: string }>,
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: { messagesBySessionId: Record<string, ChatMessage[]> }) => unknown) =>
    selector({ messagesBySessionId: chatStoreHarness.messagesBySessionId }),
}))

vi.mock('../blockTimelineRendererRegistry', async () => {
  const ReactActual = await vi.importActual<typeof import('react')>('react')
  return {
    registerBlockTimelineRenderer: () => undefined,
    getBlockTimelineRenderer: () => (props: { ownerRunId?: string; messageId: string; blocks: readonly ContentBlockEntry[] }) => {
      blockTimelineHarness.calls.push({ ownerRunId: props.ownerRunId, messageId: props.messageId })
      return ReactActual.createElement(
        'div',
        { 'data-testid': 'mock-block-timeline', 'data-owner-run-id': props.ownerRunId ?? '' },
        props.blocks.map((entry) => (entry.block as { text?: string }).text).join(''),
      )
    },
  }
})

function message(id: string, role: ChatMessage['role'], overrides: Partial<ChatMessage> = {}): ChatMessage {
  const contentBlocksJson = [{ type: 'text', text: id }]
  return {
    id,
    role,
    content: id,
    content_blocks_json: contentBlocksJson,
    blocks: contentBlocksJson.map((block, index) => ({
      index,
      block_id: `${id}-${index}`,
      block,
      finalized: true,
      partial: false,
    })) as ContentBlockEntry[],
    created_at: `2026-08-07T00:00:0${id === 'user' ? 0 : 1}.000Z`,
    ...overrides,
  } as ChatMessage
}

describe('EmbeddedMessageTimeline', () => {
  beforeEach(() => {
    blockTimelineHarness.calls = []
    chatStoreHarness.messagesBySessionId = {}
  })

  it('使用自然文档流完整展开，不创建第二个滚动视口', () => {
    chatStoreHarness.messagesBySessionId = {
      'subagent-replay:child': [message('user', 'user'), message('assistant', 'assistant')],
    }
    render(<EmbeddedMessageTimeline sessionId="subagent-replay:child" subagentRunSessionId="parent" />)

    expect(screen.getByTestId('embedded-message-timeline')).toBeTruthy()
    expect(screen.queryByTestId('chat-message-list-scroller')).toBeNull()
    expect(screen.getByText('user')).toBeTruthy()
    expect(screen.getByText('assistant')).toBeTruthy()
  })

  it('在嵌入子代理详情时用当前 run 作为缺省 owner，供孙代理 tool call 反查状态', () => {
    chatStoreHarness.messagesBySessionId = {
      'subagent-replay:child': [message('assistant', 'assistant')],
    }

    render(
      <EmbeddedMessageTimeline
        sessionId="subagent-replay:child"
        subagentRunSessionId="parent-session"
        ownerRunId="child-run"
      />,
    )

    expect(blockTimelineHarness.calls).toEqual([
      expect.objectContaining({ messageId: 'assistant', ownerRunId: 'child-run' }),
    ])
  })

  it('消息自带 subagent_run_id 时优先使用消息 owner，避免更深层嵌套被外层覆盖', () => {
    chatStoreHarness.messagesBySessionId = {
      'subagent-replay:grandchild': [
        message('assistant', 'assistant', { subagent_run_id: 'grandchild-run' }),
      ],
    }

    render(
      <EmbeddedMessageTimeline
        sessionId="subagent-replay:grandchild"
        subagentRunSessionId="parent-session"
        ownerRunId="child-run"
      />,
    )

    expect(blockTimelineHarness.calls).toEqual([
      expect.objectContaining({ messageId: 'assistant', ownerRunId: 'grandchild-run' }),
    ])
  })
})
