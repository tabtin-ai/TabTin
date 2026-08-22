/**
 * ：MessageBubble 用 message.agent_id 驱动 TurnAgentBadge。
 * message_start 建壳写入 agent_id 后，首帧即应出现身份头像（不等 server merge）。
 */
import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import type { ChatMessage } from '@tabtin/chat-client'

const chatStoreState = vi.hoisted(() => ({
  currentSessionId: 'sess-1' as string | null,
  restoringSessionId: null as string | null,
  messagesBySessionId: {} as Record<string, ChatMessage[]>,
}))

const runtimeState = vi.hoisted(() => ({
  runStateBySessionId: {} as Record<string, unknown>,
  toolEventsBySessionId: {} as Record<string, unknown[]>,
  runProjectionBySessionId: {} as Record<string, { busy: boolean }>,
}))

const spaceState = vi.hoisted(() => ({
  agentCache: {
    'agent-exec-now': { id: 'agent-exec-now', name: '查令' },
  } as Record<string, { id: string; name: string }>,
  selectedAgent: null as { id: string; name: string } | null,
  loadAgent: vi.fn(),
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

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (s: typeof spaceState) => unknown) => selector(spaceState),
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
  BlockTimeline: () => <div data-testid="mock-block-timeline" />,
}))

vi.mock('../messages/common/', () => ({
  MessageActions: () => <div data-testid="message-actions" />,
}))

vi.mock('../messages/common/', () => ({
  MSG_COLLAPSE_ENABLED: true,
  MSG_COLLAPSE_CHAR_THRESHOLD: 50_000,
  CollapsibleMessage: ({ children }: { children: () => React.ReactNode }) => <>{children()}</>,
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

function makeAssistant(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: 'asst-1',
    role: 'assistant',
    content: '',
    created_at: '2026-07-12T00:00:00Z',
    message_kind: 'llm',
    ...overrides,
  } as ChatMessage
}

describe('MessageBubble TurnAgentBadge ', () => {
  it('message.agent_id 存在时首帧渲染 turn-agent-badge（中性头像）', () => {
    render(
      <MessageBubble
        message={makeAssistant({ agent_id: 'agent-exec-now' })}
        sessionId="sess-1"
        isLastAssistantMsg
        sessionPulseVisible
        isLastInTurn
      />,
    )
    expect(screen.getByTestId('turn-agent-badge')).toBeTruthy()
    expect(screen.getByTestId('agent-avatar')).toBeTruthy()
    expect(screen.getByTestId('agent-avatar').className).not.toMatch(/destructive|warning|success|animate/)
  })

  it('message.agent_id 缺省时不渲染徽章（避免编造身份）', () => {
    render(
      <MessageBubble
        message={makeAssistant()}
        sessionId="sess-1"
        isLastAssistantMsg
        sessionPulseVisible
        isLastInTurn
      />,
    )
    expect(screen.queryByTestId('turn-agent-badge')).toBeNull()
  })

  it('共享消息使用服务端下发的 Agent 展示身份，不依赖接收者的私有 Agent 缓存', () => {
    render(
      <MessageBubble
        message={makeAssistant({
          agent_id: 'owner-private-agent',
          agent_name: '所有者 Agent',
          agent_avatar: 'https://example.com/owner-agent.png',
        })}
        sessionId="sess-1"
        isLastAssistantMsg
        sessionPulseVisible
        isLastInTurn
      />,
    )

    expect(screen.getByText('所有者 Agent')).toBeTruthy()
  })
})
