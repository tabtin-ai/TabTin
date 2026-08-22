import React from 'react'
import { describe, expect, it, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import { SendStatusIndicator } from '../messages/user/SendStatusIndicator'

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }),
}))

vi.mock('../../../../stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      removeMessages: vi.fn(),
      sendMessage: vi.fn(),
    }),
  },
}))

vi.mock('../../../../stores/useChatRuntimeStore', () => ({
  useChatRuntimeStore: {
    getState: () => ({
      setPrefillForSession: vi.fn(),
    }),
  },
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
}))

describe('SendStatusIndicator', () => {
  it('only renders an action slot for failed sends', () => {
    const { rerender } = render(
      <SendStatusIndicator
        sendStatus="sending"
        messageId="temp-user-1"
        messageContent="hello"
        sessionId="session-1"
      />,
    )
    expect(screen.queryByTestId('message-send-status')).toBeNull()

    rerender(
      <SendStatusIndicator
        sendStatus="sent"
        messageId="server-user-1"
        messageContent="hello"
        sessionId="session-1"
      />,
    )
    expect(screen.queryByTestId('message-send-status')).toBeNull()

    rerender(
      <SendStatusIndicator
        sendStatus="failed"
        messageId="server-user-1"
        messageContent="hello"
        sessionId="session-1"
      />,
    )
    expect(screen.getByTestId('message-send-status')).toBeTruthy()
  })
})
