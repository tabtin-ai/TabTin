import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { CHAT_CONTENT_FILTER_MESSAGE } from '@/constants/tabchat'

const mocks = vi.hoisted(() => ({
  closeIM: vi.fn(),
  setCurrentConversation: vi.fn(),
  setSpaceListState: vi.fn(),
  activateSpace: vi.fn(() => false),
  setSelectedProjectId: vi.fn(),
  setCurrentTab: vi.fn(),
  enterTeamSpaceProject: vi.fn(),
}))

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: Record<string, string>) => options?.defaultValue ?? _key,
  }),
}))

vi.mock('@tabtin/smartsheet-ui', () => ({ toast: vi.fn() }))

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: (selector: (state: { user: { id: string } }) => unknown) =>
    selector({ user: { id: 'user-1' } }),
}))

vi.mock('@stores/useIMStore', () => {
  const useIMStore = Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        conversations: [
          {
            id: 'conv-general',
            type: 2,
            name: '#general',
            member_count: 2,
            is_team_space_channel: true,
            space_id: 'team-space-1',
            space_name: 'Live验证房间',
          },
        ],
        conversationMembers: {
          'conv-general': [],
        },
      }),
    {
      getState: () => ({
        closeIM: mocks.closeIM,
        setCurrentConversation: mocks.setCurrentConversation,
      }),
    },
  )
  return { useIMStore }
})

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({ activateSpace: mocks.activateSpace }),
    { setState: mocks.setSpaceListState },
  ),
}))

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({
      setCurrentTab: mocks.setCurrentTab,
    }),
  },
}))

vi.mock('@components/layout/projectWorkspaceSelectionStore', () => ({
  useProjectWorkspaceSelectionStore: {
    getState: () => ({
      setSelectedProjectId: mocks.setSelectedProjectId,
    }),
  },
}))

vi.mock('@components/layout/project/teamSpaceProjectNavigation', () => ({
  enterTeamSpaceProject: (...args: unknown[]) => mocks.enterTeamSpaceProject(...args),
}))

vi.mock('./conversationMembers', () => ({
  countMemberBreakdown: vi.fn(() => ({ human: 2, agent: 0 })),
}))

vi.mock('@components/common/ChipTabBar', () => ({
  ChipTabBar: () => <div data-testid="chip-tab-bar" />,
}))

vi.mock('@/services/tabchatApi', () => ({
  updateConversation: vi.fn(),
}))

describe('ChatHeader Project navigation', () => {
  it('消息会话为 Shell 级侧栏开关预留标题栏安全区', async () => {
    const { ChatHeader } = await import('./ChatHeader')

    render(
      <ChatHeader
        conversationId="conv-general"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
        topBarLeftInset={72}
      />,
    )

    const header = screen.getByRole('heading', { name: '#general' }).closest('div.flex.min-h-12')
    expect(header?.getAttribute('style')).toContain('padding-left: 84px')
    expect(screen.queryByRole('button', { name: '展开侧边栏' })).toBeNull()
    await waitFor(() => {
      expect(screen.getByText('Project 频道')).toBeTruthy()
    })
  })

  it('会话信息按钮提供扩大的点击热区', async () => {
    const onToggleDetail = vi.fn()
    const { ChatHeader } = await import('./ChatHeader')

    render(
      <ChatHeader
        conversationId="conv-general"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
        onToggleDetail={onToggleDetail}
      />,
    )

    const detailButton = screen.getByRole('button', { name: 'members' })
    expect(detailButton.className).toContain('before:-inset-1.5')
    expect(detailButton.className).toContain('no-drag')
    fireEvent.click(detailButton)
    expect(onToggleDetail).toHaveBeenCalledTimes(1)
    await waitFor(() => {
      expect(screen.getByText('Project 频道')).toBeTruthy()
    })
  })

  it('点击所属 Project 时进入项目视图而不是激活 workspace', async () => {
    const { ChatHeader } = await import('./ChatHeader')

    render(
      <ChatHeader
        conversationId="conv-general"
        contentFilter={CHAT_CONTENT_FILTER_MESSAGE}
        onContentFilterChange={vi.fn()}
      />,
    )

    fireEvent.click(screen.getByRole('button', { name: 'Live验证房间' }))

    expect(mocks.activateSpace).not.toHaveBeenCalled()
    expect(mocks.enterTeamSpaceProject).toHaveBeenCalledWith('team-space-1')
    await waitFor(() => {
      expect(screen.getByText('Project 频道')).toBeTruthy()
    })
  })
})
