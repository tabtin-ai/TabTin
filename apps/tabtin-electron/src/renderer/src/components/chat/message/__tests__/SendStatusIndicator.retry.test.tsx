import React from 'react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  sendMessage: vi.fn(),
  removeMessages: vi.fn(),
  setPrefillForSession: vi.fn(),
  armFailedMessageEditResend: vi.fn(),
  retryPendingFirstSend: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { defaultValue?: string }) => o?.defaultValue ?? k,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({
  Popover: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverTrigger: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  PopoverContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock('@/stores/chat/messages/product/delivery/projectTaskSendGate', () => ({
  isProjectTaskEditAndResendBlocked: () => false,
  PROJECT_TASK_RUN_REQUIRED_MESSAGE: 'blocked',
}))

vi.mock('../../../../stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      sendMessage: mocks.sendMessage,
      removeMessages: mocks.removeMessages,
    }),
  },
}))

vi.mock('../../../../stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      setPrefillForSession: mocks.setPrefillForSession,
    }),
  },
}))

vi.mock('@/stores/chat/messages/actions/failedMessageEditResend', () => ({
  armFailedMessageEditResend: (...args: unknown[]) =>
    mocks.armFailedMessageEditResend(...args),
}))

vi.mock('@/stores/chat/session/actions/pendingFirstSendRetry', () => ({
  retryPendingFirstSend: (...args: unknown[]) => mocks.retryPendingFirstSend(...args),
}))

import { SendStatusIndicator } from '../messages/user/SendStatusIndicator'

describe('SendStatusIndicator retry ', () => {
  beforeEach(() => {
    mocks.sendMessage.mockReset()
    mocks.removeMessages.mockReset()
    mocks.setPrefillForSession.mockReset()
    mocks.armFailedMessageEditResend.mockReset()
    mocks.retryPendingFirstSend.mockReset().mockReturnValue(true)
  })

  it('A. 重试不先删气泡，经 store sendMessage 传 existingClientMessageId', () => {
    render(
      <SendStatusIndicator
        sendStatus="failed"
        messageId="msg-failed"
        messageContent="hello"
        sessionId="sess-1"
      />,
    )
    fireEvent.click(screen.getByText('sendStatus.sendFailed'))
    fireEvent.click(screen.getByText('sendStatus.retry'))

    expect(mocks.removeMessages).not.toHaveBeenCalled()
    expect(mocks.sendMessage).toHaveBeenCalledWith(
      'hello',
      true,
      undefined,
      undefined,
      'sess-1',
      { existingClientMessageId: 'msg-failed' },
    )
  })

  it('B1.  local-pending 重试：路由回面板首发编排，不直接 sendMessage', () => {
    render(
      <SendStatusIndicator
        sendStatus="failed"
        messageId="msg-failed"
        messageContent="first send"
        sessionId="local-pending-abc"
      />,
    )
    fireEvent.click(screen.getByText('sendStatus.sendFailed'))
    fireEvent.click(screen.getByText('sendStatus.retry'))

    expect(mocks.retryPendingFirstSend).toHaveBeenCalledWith('local-pending-abc', {
      message: 'first send',
      contextBlocks: undefined,
    })
    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(mocks.removeMessages).not.toHaveBeenCalled()
  })

  it('B2.  面板未挂载/episode 已取消：降级为编辑重发回填 Composer', () => {
    mocks.retryPendingFirstSend.mockReturnValue(false)
    render(
      <SendStatusIndicator
        sendStatus="failed"
        messageId="msg-failed"
        messageContent="first send"
        sessionId="local-pending-abc"
      />,
    )
    fireEvent.click(screen.getByText('sendStatus.sendFailed'))
    fireEvent.click(screen.getByText('sendStatus.retry'))

    expect(mocks.sendMessage).not.toHaveBeenCalled()
    expect(mocks.armFailedMessageEditResend).toHaveBeenCalledWith('local-pending-abc', 'msg-failed')
    expect(mocks.setPrefillForSession).toHaveBeenCalledWith('local-pending-abc', 'first send')
  })

  it('C. 编辑并重发：成功前保留 failed 气泡并登记 edit resend id', () => {
    render(
      <SendStatusIndicator
        sendStatus="failed"
        messageId="msg-failed"
        messageContent="edit me"
        sessionId="sess-1"
      />,
    )
    fireEvent.click(screen.getByText('sendStatus.sendFailed'))
    fireEvent.click(screen.getByText('sendStatus.editAndResend'))

    expect(mocks.removeMessages).not.toHaveBeenCalled()
    expect(mocks.armFailedMessageEditResend).toHaveBeenCalledWith('sess-1', 'msg-failed')
    expect(mocks.setPrefillForSession).toHaveBeenCalledWith('sess-1', 'edit me')
  })
})
