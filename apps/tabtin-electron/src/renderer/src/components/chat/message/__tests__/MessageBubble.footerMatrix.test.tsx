import React from 'react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
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

const renderedProps = vi.hoisted(() => ({
  userBubble: null as Record<string, unknown> | null,
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: Record<string, unknown>) => {
      const template = opts && 'defaultValue' in opts ? String(opts.defaultValue) : key
      return template.replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(opts?.[name] ?? ''))
    },
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
  BlockTimeline: () => <div data-testid="mock-block-timeline" />,
}))

vi.mock('../messages/user/UserMessageBubble', () => ({
  UserMessageBubble: (props: Record<string, unknown>) => {
    renderedProps.userBubble = props
    return <div data-testid="user-message-bubble" />
  },
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
import type { SessionAccessCapabilities } from '../../sessionAccessCapabilities'

const READ_ONLY_SHARED_CAPABILITIES: SessionAccessCapabilities = {
  sendMode: null,
  canSendSharedChat: false,
  canForkWholeSession: false,
  canMutateHistory: false,
  canReply: false,
  canCopy: true,
  canOpenArtifacts: true,
  canChangeModel: false,
}

const FORKABLE_SHARED_CAPABILITIES: SessionAccessCapabilities = {
  ...READ_ONLY_SHARED_CAPABILITIES,
  canForkWholeSession: true,
}

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

describe('MessageBubble footer matrix', () => {
  beforeEach(() => {
    runtimeState.runProjectionBySessionId = {}
    renderedProps.userBubble = null
  })

  it('llm 非 streaming 显示标准 footer', () => {
    render(
      <MessageBubble
        message={makeAssistant({ content: 'done' })}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
      />,
    )
    expect(screen.getByTestId('message-actions')).toBeTruthy()
    expect(screen.queryByTestId('error-envelope-footer')).toBeNull()
  })

  it('BYOK/local 消息只有 usage_json 时仍显示 token 用量入口', () => {
    render(
      <MessageBubble
        message={makeAssistant({
          content: 'done',
          usage_json: {
            input_tokens: 18_104,
            cache_read_input_tokens: 0,
            output_tokens: 5,
          },
        } as Partial<ChatMessage>)}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
      />,
    )
    expect(screen.getByText('18.1K tokens')).toBeTruthy()
  })

  it('BYOK/local 消息优先使用 usage_json 的 per-call token 字段', () => {
    render(
      <MessageBubble
        message={makeAssistant({
          content: 'done',
          metadata: {
            is_byok: true,
            input_tokens: 50_000,
            cache_read_input_tokens: 0,
          },
          usage_json: {
            input_tokens: 8_292,
            cache_read_input_tokens: 10_752,
            output_tokens: 5,
          },
        } as Partial<ChatMessage>)}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
      />,
    )
    expect(screen.getByText('8.3K tokens')).toBeTruthy()
  })

  it('BYOK/local 消息在费用 tooltip 中展示 usage_json 的缓存命中', () => {
    render(
      <MessageBubble
        message={makeAssistant({
          content: 'done',
          metadata: {
            is_byok: true,
            last_input_tokens: 50_000,
            last_cache_read_input_tokens: 0,
          },
          usage_json: {
            input_tokens: 8_292,
            cache_read_input_tokens: 10_752,
            cache_creation_input_tokens: 0,
            output_tokens: 5,
          },
        } as Partial<ChatMessage>)}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: '查看费用详情' }))

    expect(screen.getByText('本次输入：19.0K tokens')).toBeTruthy()
    expect(screen.getByText('缓存命中：10.8K tokens')).toBeTruthy()
    expect(screen.getByText('缓存写入：0 tokens')).toBeTruthy()
    expect(screen.getByText('新增输入：8.3K tokens')).toBeTruthy()
  })

  it('tool_artifact 不显示 footer', () => {
    render(
      <MessageBubble
        message={makeAssistant({ message_kind: 'tool_artifact', content: 'tool output' })}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
      />,
    )
    expect(screen.queryByTestId('message-actions')).toBeNull()
  })

  it('error_envelope 显示简化 footer', () => {
    render(
      <MessageBubble
        message={makeAssistant({ message_kind: 'error_envelope', content: '[unknown] failed' })}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
      />,
    )
    expect(screen.getByTestId('error-envelope-footer')).toBeTruthy()
    expect(screen.queryByTestId('message-actions')).toBeTruthy()
  })

  it('streaming 末条 assistant 隐藏标准 footer', () => {
    runtimeState.runProjectionBySessionId = { 'sess-1': { busy: true } }
    render(
      <MessageBubble
        message={makeAssistant({ content: 'streaming…' })}
        sessionId="sess-1"
        isLastAssistantMsg
        sessionPulseVisible
        isLastInTurn
      />,
    )
    expect(screen.queryByTestId('message-actions')).toBeNull()
  })

  it('只读共享隐藏所有会修改会话的消息操作，仅保留工具栏复制能力', () => {
    render(
      <MessageBubble
        message={makeAssistant({ content: 'shared response', agent_run_id: 'run-1' })}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
        onFork={vi.fn()}
        accessCapabilities={READ_ONLY_SHARED_CAPABILITIES}
      />,
    )

    expect(screen.getByLabelText('common.copy')).toBeTruthy()
    expect(screen.queryByLabelText('messageActions.regenerate')).toBeNull()
    expect(screen.queryByLabelText('messageActions.reply')).toBeNull()
    expect(screen.queryByLabelText('sharedPane.forkWizardTitle')).toBeNull()
  })

  it('只读共享的用户消息正文不能进入编辑态', () => {
    render(
      <MessageBubble
        message={{
          id: 'user-1',
          role: 'user',
          content: 'owner prompt',
          created_at: '2026-07-12T00:00:00Z',
          message_kind: 'llm',
          sender_user_id: 'user-1',
        } as ChatMessage}
        sessionId="sess-1"
        isLastInTurn
        accessCapabilities={READ_ONLY_SHARED_CAPABILITIES}
      />,
    )

    expect(renderedProps.userBubble).toMatchObject({
      canEdit: false,
      isEditing: false,
      message: expect.objectContaining({ id: 'user-1' }),
    })
  })

  it('开放 can_fork 的共享会话显示 fork 操作', () => {
    const onFork = vi.fn()
    render(
      <MessageBubble
        message={makeAssistant({ content: 'forkable shared response' })}
        sessionId="sess-1"
        isLastAssistantMsg
        isLastInTurn
        onFork={onFork}
        accessCapabilities={FORKABLE_SHARED_CAPABILITIES}
      />,
    )

    expect(screen.getByLabelText('复制到我的任务')).toBeTruthy()
    expect(screen.queryByLabelText('messageActions.regenerate')).toBeNull()
    expect(screen.queryByLabelText('messageActions.reply')).toBeNull()
  })
})
