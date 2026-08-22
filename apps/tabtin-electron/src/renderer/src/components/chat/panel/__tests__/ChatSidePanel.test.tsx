import React from 'react'
import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ChatSidePanel } from '../ChatSidePanel'

const mocks = vi.hoisted(() => ({
  chatPanelProps: [] as Array<Record<string, unknown>>,
  uiState: {
    toggleChatSidePanel: vi.fn(),
  },
  chatState: {
    currentSessionId: 'team-session-1',
  },
  authState: {
    user: { id: 'user-1' },
  },
  prefsState: {
    getSidebarMode: vi.fn(() => 'conversations'),
    getCanvasCollapsed: vi.fn(() => false),
    toggleCanvasCollapsedForScope: vi.fn(),
  },
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('../../../../stores/useUIStore', () => ({
  useUIStore: (selector: (state: typeof mocks.uiState) => unknown) => selector(mocks.uiState),
}))

vi.mock('../../../../stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: typeof mocks.chatState) => unknown) => selector(mocks.chatState),
}))

vi.mock('../../../../stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: typeof mocks.authState) => unknown) => selector(mocks.authState),
}))

vi.mock('../../../../stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: (selector: (state: typeof mocks.prefsState) => unknown) => selector(mocks.prefsState),
}))

vi.mock('../ChatIconTooltip', () => ({
  ChatIconTooltip: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}))

vi.mock('../ChatPanel', () => ({
  ChatPanel: (props: Record<string, unknown>) => {
    mocks.chatPanelProps.push(props)
    return (
      <div data-testid="chat-panel" data-session-list-scope={String(props.sessionListScope)}>
        {props.panelActions as React.ReactNode}
      </div>
    )
  },
}))

describe('ChatSidePanel team space behavior', () => {
  beforeEach(() => {
    mocks.chatPanelProps.length = 0
    mocks.uiState.toggleChatSidePanel.mockClear()
    mocks.prefsState.getSidebarMode.mockClear()
    mocks.prefsState.getCanvasCollapsed.mockClear()
    mocks.prefsState.toggleCanvasCollapsedForScope.mockClear()
  })

  it('does not pass empty panel actions in conversations mode ', () => {
    render(
      <ChatSidePanel
        spaceContext={{
          id: 'space-1',
          name: '默认 Space',
          organization_id: 'organization-1',
          type: 'personal',
        } as unknown as React.ComponentProps<typeof ChatSidePanel>['spaceContext']}
        organizationId="organization-1"
      />,
    )

    expect(mocks.chatPanelProps.at(-1)?.panelActions).toBeUndefined()
  })

  it('team_space locks ChatPanel to team sessions and collapses the chat rail itself', () => {
    render(
      <ChatSidePanel
        spaceContext={{
          id: 'team-space-1',
          name: '发布Project',
          organization_id: 'organization-1',
          type: 'team_space',
        } as unknown as React.ComponentProps<typeof ChatSidePanel>['spaceContext']}
        organizationId="organization-1"
      />,
    )

    expect(screen.getByTestId('chat-panel').getAttribute('data-session-list-scope')).toBe('selectedSpaceOnly')
    expect(mocks.chatPanelProps.at(-1)?.panelActions).toBeDefined()

    fireEvent.click(screen.getByLabelText('sidePanel.collapse (Ctrl+J)'))

    expect(mocks.uiState.toggleChatSidePanel).toHaveBeenCalled()
    expect(mocks.prefsState.toggleCanvasCollapsedForScope).not.toHaveBeenCalled()
  })
})
