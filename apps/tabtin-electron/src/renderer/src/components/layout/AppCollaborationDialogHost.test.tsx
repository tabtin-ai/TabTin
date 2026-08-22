import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => {
  const order: string[] = []
  const state = {
    request: {
      sourceLabel: '文档',
      prompt: '总结当前文档',
      preferredSpaceId: 'space-a',
      sourceItem: null,
    },
    spaces: [
      { id: 'space-a', name: '工作空间 A', organization_id: 'org-1', type: 'workspace' },
      { id: 'space-b', name: '工作空间 B', organization_id: 'org-1', type: 'workspace' },
    ],
    selectedAgent: null as null | { id: string },
    currentSessionId: 'old-session',
    currentSessionIdBySpaceId: {} as Record<string, string>,
  }
  return {
    order,
    state,
    close: vi.fn(),
    createSession: vi.fn(async (spaceId: string) => {
      state.currentSessionIdBySpaceId[spaceId] = 'new-session-b'
    }),
    sendMessage: vi.fn(async () => {
      order.push('send')
    }),
    enterChatSession: vi.fn(async () => {
      order.push('navigate')
      return 1
    }),
    openResourceTab: vi.fn(),
    setTaskViewModeForScope: vi.fn(),
    setSidebarModeForOrganizationUser: vi.fn(),
    setCurrentTab: vi.fn(),
    toastError: vi.fn(),
  }
})

vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>()
  return {
    ...actual,
    AgentApiService: {
      listAgents: vi.fn(async () => [
        { id: 'agent-active', name: 'Active Agent', organization_id: 'org-1', is_active: true },
        { id: 'agent-disabled', name: 'Disabled Agent', organization_id: 'org-1', is_active: false },
      ]),
    },
  }
})

vi.mock('@components/ui', () => ({
  Button: ({ children, ...props }: React.ButtonHTMLAttributes<HTMLButtonElement>) => (
    <button {...props}>{children}</button>
  ),
  Dialog: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h1>{children}</h1>,
  toast: { error: mocks.toastError },
}))

vi.mock('@stores/useAppCollaborationStore', () => ({
  useAppCollaborationStore: (selector: (state: unknown) => unknown) => selector({
    request: mocks.state.request,
    close: mocks.close,
  }),
}))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: unknown) => unknown) => selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: (selector: (state: unknown) => unknown) => selector({
    selectedOrganization: { id: 'org-1' },
  }),
}))

vi.mock('@stores/useSpaceStore', () => {
  const useSpaceStore = (selector: (state: unknown) => unknown) => selector(mocks.state)
  useSpaceStore.setState = (patch: { selectedAgent?: { id: string } }) => {
    if (patch.selectedAgent) mocks.state.selectedAgent = patch.selectedAgent
  }
  return { useSpaceStore }
})

vi.mock('@stores/chat/useChatStore', () => ({
  useChatStore: {
    getState: () => ({
      currentSessionId: mocks.state.currentSessionId,
      currentSessionIdBySpaceId: mocks.state.currentSessionIdBySpaceId,
      createSession: mocks.createSession,
      sendMessage: mocks.sendMessage,
    }),
  },
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: { getState: () => ({ setCurrentTab: mocks.setCurrentTab }) },
}))

vi.mock('@stores/useSpaceViewPrefsStore', () => ({
  useSpaceViewPrefsStore: Object.assign(
    (selector: (state: unknown) => unknown) => selector({
      getLastUsedWorkspaceId: () => 'space-b',
    }),
    { getState: () => ({
      setTaskViewModeForScope: mocks.setTaskViewModeForScope,
      setSidebarModeForOrganizationUser: mocks.setSidebarModeForOrganizationUser,
    }) },
  ),
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab: mocks.openResourceTab }),
  },
}))

vi.mock('@/services/chatSessionNavigation', () => ({
  enterChatSession: mocks.enterChatSession,
}))

vi.mock('@/utils/logger', () => ({
  createLogger: () => ({ warn: vi.fn() }),
}))

import { AppCollaborationDialogHost } from './AppCollaborationDialogHost'

describe('AppCollaborationDialogHost', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.order.length = 0
    mocks.state.currentSessionId = 'old-session'
    mocks.state.currentSessionIdBySpaceId = {}
    mocks.state.selectedAgent = null
    mocks.state.request.preferredSpaceId = 'space-a'
  })

  it('跨工作空间使用目标桶的新会话，过滤停用 Agent，并先导航再发送', async () => {
    render(<AppCollaborationDialogHost />)

    await waitFor(() => {
      expect(screen.getByRole('option', { name: 'Active Agent' })).toBeTruthy()
    })
    expect(screen.queryByRole('option', { name: 'Disabled Agent' })).toBeNull()

    fireEvent.change(screen.getByLabelText('工作空间'), { target: { value: 'space-b' } })
    fireEvent.click(screen.getByRole('button', { name: '确认发起' }))

    await waitFor(() => {
      expect(mocks.sendMessage).toHaveBeenCalled()
    })
    expect(mocks.createSession).toHaveBeenCalledWith('space-b', 'org-1')
    expect(mocks.sendMessage.mock.calls[0]?.[4]).toBe('new-session-b')
    expect(mocks.enterChatSession).toHaveBeenCalledWith(
      'space-b',
      'new-session-b',
      { organizationId: 'org-1' },
    )
    expect(mocks.order).toEqual(['navigate', 'send'])
  })

  it('首选工作空间失效时沿用组织内最后使用工作空间', async () => {
    mocks.state.request.preferredSpaceId = 'missing-space'
    render(<AppCollaborationDialogHost />)

    await waitFor(() => {
      expect((screen.getByLabelText('工作空间') as HTMLSelectElement).value).toBe('space-b')
    })
  })
})
