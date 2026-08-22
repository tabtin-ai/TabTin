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

const WRAPPED_SUMMARY = [
  '[对话摘要]',
  '',
  '1. 用户请求：设计自动化测试用例',
  '',
  '[摘要结束]',
  '',
  '[最近对话如下]',
].join('\n')

describe('#7339 MessageBubble compaction_summary', () => {
  it('role=user + message_kind=compaction_summary → 分隔 pill，不渲染摘要正文', () => {
    render(
      <MessageBubble
        message={{
          id: 'compact-1',
          role: 'user',
          content: WRAPPED_SUMMARY,
          created_at: '2026-07-23T12:38:38Z',
          message_kind: 'compaction_summary',
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.getByText('agentSteps.compactionCheckpoint')).toBeTruthy()
    expect(screen.queryByText(/用户请求：设计自动化测试用例/)).toBeNull()
    expect(screen.queryByTestId('mock-markdown')).toBeNull()
  })

  it('role=user + 完整 marker（无 kind）→ 仍走 pill，堵住存量脏数据', () => {
    render(
      <MessageBubble
        message={{
          id: 'compact-legacy',
          role: 'user',
          content: WRAPPED_SUMMARY,
          created_at: '2026-07-23T12:38:38Z',
          message_kind: 'llm',
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.getByText('agentSteps.compactionCheckpoint')).toBeTruthy()
    expect(screen.queryByText(/用户请求：设计自动化测试用例/)).toBeNull()
  })
})

describe('MessageBubble hidden context messages', () => {
  it('未标记的 role=system 默认不渲染', () => {
    render(
      <MessageBubble
        message={{
          id: 'plain-system',
          role: 'system',
          content: 'PLAIN SYSTEM SHOULD NOT RENDER',
          created_at: '2026-07-29T12:00:00Z',
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.queryByText(/PLAIN SYSTEM SHOULD NOT RENDER/)).toBeNull()
  })

  it('带产品 system_fact 的 role=system 才渲染系统 pill', () => {
    render(
      <MessageBubble
        message={{
          id: 'checkpoint-summary',
          role: 'system',
          content: '回退完成',
          created_at: '2026-07-29T12:00:00Z',
          metadata: { system_fact: 'checkpoint_rewind_summary' },
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.getByText('回退完成')).toBeTruthy()
  })

  it('role=user + message_kind=system_prompt_context → 不渲染 system prompt 正文', () => {
    render(
      <MessageBubble
        message={{
          id: 'system-prompt-1',
          role: 'user',
          content: '<identity>\nSECRET SYSTEM PROMPT SHOULD NOT RENDER\n</identity>',
          created_at: '2026-07-29T12:00:00Z',
          message_kind: 'system_prompt_context',
          metadata: { source: 'system_prompt' },
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.queryByText(/SECRET SYSTEM PROMPT SHOULD NOT RENDER/)).toBeNull()
    expect(screen.queryByTestId('mock-markdown')).toBeNull()
    expect(screen.queryByTestId('message-actions')).toBeNull()
  })

  it('legacy role=system + agent-profile wrapper → 不渲染内部上下文标签', () => {
    render(
      <MessageBubble
        message={{
          id: 'legacy-system-profile',
          role: 'system',
          content: '<context type="agent-profile">\nSECRET PROFILE SHOULD NOT RENDER\n</context>',
          created_at: '2026-07-29T12:00:00Z',
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.queryByText(/SECRET PROFILE SHOULD NOT RENDER/)).toBeNull()
    expect(screen.queryByText(/<context/)).toBeNull()
  })

  it('legacy role=system + 纯子 Agent 完成通知 → 由聚合卡表达，不渲染 XML', () => {
    render(
      <MessageBubble
        message={{
          id: 'legacy-system-subagent',
          role: 'system',
          content: [
            'A background sub-agent finished while you were doing other work:',
            '',
            '<task-notification kind = "subagent-completed">',
            '<subagent-run-id>run-1</subagent-run-id>',
            '<label>后台子 Agent</label>',
            '<status>completed</status>',
            '</task-notification>',
          ].join('\n'),
          created_at: '2026-07-29T12:00:00Z',
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.queryByText(/task-notification/)).toBeNull()
    expect(screen.queryByText(/后台子 Agent/)).toBeNull()
  })

  it('嵌入子代理详情可显式展示子 Agent 完成通知', () => {
    render(
      <MessageBubble
        message={{
          id: 'nested-system-subagent',
          role: 'system',
          content: [
            'A background sub-agent finished while you were doing other work:',
            '',
            '<task-notification kind = "subagent-completed">',
            '<subagent-run-id>run-1</subagent-run-id>',
            '<label>后台孙 Agent</label>',
            '<status>completed</status>',
            '</task-notification>',
          ].join('\n'),
          created_at: '2026-07-29T12:00:00Z',
        } as ChatMessage}
        sessionId="sess-1"
        showSubagentCompletionPush
      />,
    )

    expect(screen.getByTestId('push-notification-bubble')).toBeTruthy()
    expect(screen.getByTestId('push-notification-summary')).toBeTruthy()
    expect(screen.queryByText(/task-notification/)).toBeNull()
  })

  it('legacy role=system + 后台命令通知 → 收敛成摘要，不展示 XML 标签', () => {
    render(
      <MessageBubble
        message={{
          id: 'legacy-system-shell',
          role: 'system',
          content: [
            'A background command completed while you were doing other work:',
            '',
            '<task-notification>',
            '<command>sleep 1</command>',
            '<exit-code>0</exit-code>',
            '<exited-by>normal_exit</exited-by>',
            '</task-notification>',
          ].join('\n'),
          created_at: '2026-07-29T12:00:00Z',
        } as ChatMessage}
        sessionId="sess-1"
      />,
    )

    expect(screen.getByText('pushNotification.shellDone')).toBeTruthy()
    expect(screen.getByTestId('push-notification-bubble')).toBeTruthy()
    expect(screen.queryByText(/task-notification/)).toBeNull()
    expect(screen.queryByText(/<command>/)).toBeNull()
  })
})
