import React from 'react'
import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  listIncomingSessionShares: vi.fn(),
  onSelectSharedSession: vi.fn(),
  currentSessionId: null as string | null,
  accessBySessionId: {} as Record<string, { shareId: string; sessionId: string }>,
  setSharedAccess: vi.fn(),
  state: {
    conversations: [
      {
        id: 'dm-current-org',
        organization_id: 'org-1',
        type: 1,
        dm_peer_user_id: 'user-owner',
      },
      {
        id: 'dm-other-org',
        organization_id: 'org-2',
        type: 1,
        dm_peer_user_id: 'user-other',
      },
    ],
    sessionShareListVersions: {},
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  listIncomingSessionShares: mocks.listIncomingSessionShares,
}))

vi.mock('@/stores/useIMStore', () => ({
  useIMStore: (selector: (state: typeof mocks.state) => unknown) => selector(mocks.state),
}))

vi.mock('@/stores/chat/useChatStore', () => ({
  useChatStore: (selector: (state: { currentSessionId: string | null }) => unknown) => (
    selector({ currentSessionId: mocks.currentSessionId })
  ),
}))

vi.mock('@/stores/chat/session/sessionAccessStore', () => ({
  useSessionAccessStore: Object.assign((selector: (state: { bySessionId: typeof mocks.accessBySessionId }) => unknown) => (
    selector({ bySessionId: mocks.accessBySessionId })
  ), {
    getState: () => ({
      bySessionId: mocks.accessBySessionId,
      setSharedAccess: mocks.setSharedAccess,
    }),
  }),
}))

import { ChatSidebarSharedTasksSection } from '../ChatSidebarSharedTasksSection'

describe('ChatSidebarSharedTasksSection', () => {
  beforeEach(() => {
    mocks.listIncomingSessionShares.mockReset()
    mocks.onSelectSharedSession.mockReset()
    mocks.setSharedAccess.mockReset()
    mocks.currentSessionId = null
    mocks.accessBySessionId = {}
  })

  it('只显示选定组织中收到且仍有效的共享任务，并交给上层打开 IM 共享页', async () => {
    mocks.listIncomingSessionShares.mockResolvedValue([
      {
        id: 'share-incoming',
        session_id: 'session-incoming',
        session_title: '准备秋季活动投放计划',
        workspace_id: 'workspace-owner',
        workspace_name: '投放工作空间',
        owner_user_id: 'user-owner',
        grantee_user_id: 'me',
        can_fork: true,
        can_chat: false,
        status: 'active',
        forked_session_id: null,
        created_at: '2026-08-08T10:00:00Z',
        revoked_at: null,
        direction: 'incoming',
      },
      {
        id: 'share-outgoing',
        session_id: 'session-outgoing',
        session_title: '我发出的任务',
        owner_user_id: 'me',
        grantee_user_id: 'user-owner',
        can_fork: false,
        can_chat: false,
        status: 'active',
        forked_session_id: null,
        created_at: '2026-08-08T09:00:00Z',
        revoked_at: null,
        direction: 'outgoing',
      },
    ])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    expect(await screen.findByText('准备秋季活动投放计划')).not.toBeNull()
    expect(screen.queryByText('投放工作空间')).toBeNull()
    expect(screen.queryByText('我发出的任务')).toBeNull()
    expect(mocks.listIncomingSessionShares).toHaveBeenCalledTimes(1)
    expect(mocks.listIncomingSessionShares).toHaveBeenCalledWith('org-1')

    fireEvent.click(screen.getByText('准备秋季活动投放计划'))
    expect(mocks.onSelectSharedSession).toHaveBeenCalledWith({
      share: expect.objectContaining({
        id: 'share-incoming',
        session_id: 'session-incoming',
      }),
    })
  })

  it('加载失败时提供可键盘访问的重试入口', async () => {
    mocks.listIncomingSessionShares.mockRejectedValueOnce(new Error('network'))
    mocks.listIncomingSessionShares.mockResolvedValueOnce([])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    const retry = await screen.findByText('sidebarSharedTasks.retry')
    fireEvent.click(retry)

    await waitFor(() => expect(mocks.listIncomingSessionShares).toHaveBeenCalledTimes(2))
    expect(await screen.findByText('sidebarSharedTasks.empty')).not.toBeNull()
  })

  it('同一任务被重复分享时只显示一行且只使用最新授权', async () => {
    mocks.listIncomingSessionShares.mockResolvedValue([
      {
        id: 'share-new',
        session_id: 'same-session',
        session_title: '新标题',
        can_fork: false,
        status: 'active',
        created_at: '2026-08-08T11:00:00Z',
        direction: 'incoming',
      },
      {
        id: 'share-old',
        session_id: 'same-session',
        session_title: '旧标题',
        can_fork: true,
        status: 'active',
        created_at: '2026-08-08T10:00:00Z',
        direction: 'incoming',
      },
    ])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    expect(await screen.findByText('新标题')).not.toBeNull()
    expect(screen.queryByText('旧标题')).toBeNull()
    expect(screen.getByText('(1)')).not.toBeNull()

    fireEvent.click(screen.getByText('新标题'))
    expect(mocks.onSelectSharedSession).toHaveBeenCalledWith({
      share: expect.objectContaining({
        id: 'share-new',
        session_id: 'same-session',
      }),
    })
  })

  it('同一任务的最新授权已撤销时不再展示旧的有效授权', async () => {
    mocks.listIncomingSessionShares.mockResolvedValue([
      {
        id: 'share-revoked-new',
        session_id: 'same-session',
        session_title: '最新已停止',
        status: 'revoked',
        created_at: '2026-08-08T11:00:00Z',
        direction: 'incoming',
      },
      {
        id: 'share-active-old',
        session_id: 'same-session',
        session_title: '旧授权',
        status: 'active',
        created_at: '2026-08-08T10:00:00Z',
        direction: 'incoming',
      },
    ])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    expect(await screen.findByText('sidebarSharedTasks.empty')).not.toBeNull()
    expect(screen.queryByText('旧授权')).toBeNull()
  })

  it('不同来源 Workspace 的任务直接平铺，任务行不显示分享图标', async () => {
    mocks.listIncomingSessionShares.mockResolvedValue([
      {
        id: 'share-a',
        session_id: 'session-a',
        session_title: '任务 A',
        workspace_id: 'workspace-a',
        workspace_name: '来源 Workspace A',
        owner_user_id: 'user-owner',
        status: 'active',
        created_at: '2026-08-08T12:00:00Z',
        direction: 'incoming',
      },
      {
        id: 'share-b',
        session_id: 'session-b',
        session_title: '任务 B',
        workspace_id: 'workspace-b',
        workspace_name: '来源 Workspace B',
        owner_user_id: 'user-owner',
        status: 'active',
        created_at: '2026-08-08T11:00:00Z',
        direction: 'incoming',
      },
    ])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    const taskA = await screen.findByTestId('chat-sidebar-shared-task-share-a')
    const taskB = screen.getByTestId('chat-sidebar-shared-task-share-b')
    expect(screen.queryByText('来源 Workspace A')).toBeNull()
    expect(screen.queryByText('来源 Workspace B')).toBeNull()
    expect(taskA.querySelector('svg')).toBeNull()
    expect(taskB.querySelector('svg')).toBeNull()
    expect(taskA.querySelector('[data-shared-task-status-slot]')).not.toBeNull()
    expect(taskB.querySelector('[data-shared-task-status-slot]')).not.toBeNull()
  })

  it('全局任务指针不是共享会话时不把历史授权标记为选中', async () => {
    mocks.currentSessionId = 'agent-draft-session'
    mocks.accessBySessionId = {
      'session-active': {
        shareId: 'share-active',
        sessionId: 'session-active',
      },
    }
    mocks.listIncomingSessionShares.mockResolvedValue([{
      id: 'share-active',
      session_id: 'session-active',
      session_title: '已选中的共享任务',
      status: 'active',
      created_at: '2026-08-08T12:00:00Z',
      direction: 'incoming',
    }])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    const row = await screen.findByTestId('chat-sidebar-shared-task-share-active')
    expect(row.getAttribute('aria-current')).toBeNull()
  })

  it('历史授权缓存里有多个共享任务时只高亮当前打开的任务', async () => {
    mocks.currentSessionId = 'session-b'
    mocks.accessBySessionId = {
      'session-a': {
        shareId: 'share-a',
        sessionId: 'session-a',
      },
      'session-b': {
        shareId: 'share-b',
        sessionId: 'session-b',
      },
    }
    mocks.listIncomingSessionShares.mockResolvedValue([
      {
        id: 'share-a',
        session_id: 'session-a',
        session_title: '已点过的共享任务 A',
        status: 'active',
        created_at: '2026-08-08T12:00:00Z',
        direction: 'incoming',
      },
      {
        id: 'share-b',
        session_id: 'session-b',
        session_title: '当前共享任务 B',
        status: 'active',
        created_at: '2026-08-08T12:01:00Z',
        direction: 'incoming',
      },
    ])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    const rowA = await screen.findByTestId('chat-sidebar-shared-task-share-a')
    const rowB = screen.getByTestId('chat-sidebar-shared-task-share-b')
    expect(rowA.getAttribute('aria-current')).toBeNull()
    expect(rowB.getAttribute('aria-current')).toBe('page')
  })

  it('只把当前打开的共享任务标记为选中', async () => {
    mocks.currentSessionId = 'session-active'
    mocks.accessBySessionId = {
      'session-active': {
        shareId: 'share-active',
        sessionId: 'session-active',
      },
    }
    mocks.listIncomingSessionShares.mockResolvedValue([{
      id: 'share-active',
      session_id: 'session-active',
      session_title: '已选中的共享任务',
      status: 'active',
      created_at: '2026-08-08T12:00:00Z',
      direction: 'incoming',
    }])

    render(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />)

    const row = await screen.findByTestId('chat-sidebar-shared-task-share-active')
    expect(row.getAttribute('aria-current')).toBe('page')
    expect(mocks.setSharedAccess).toHaveBeenCalledWith(expect.objectContaining({
      shareId: 'share-active',
    }))
  })

  it('当前会话切换不重拉协作任务列表', async () => {
    mocks.currentSessionId = 'session-a'
    mocks.accessBySessionId = {
      'session-a': {
        shareId: 'share-a',
        sessionId: 'session-a',
      },
      'session-b': {
        shareId: 'share-b',
        sessionId: 'session-b',
      },
    }
    mocks.listIncomingSessionShares.mockResolvedValue([
      {
        id: 'share-a',
        session_id: 'session-a',
        session_title: '共享任务 A',
        status: 'active',
        created_at: '2026-08-08T12:00:00Z',
        direction: 'incoming',
      },
      {
        id: 'share-b',
        session_id: 'session-b',
        session_title: '共享任务 B',
        status: 'active',
        created_at: '2026-08-08T12:01:00Z',
        direction: 'incoming',
      },
    ])

    const { rerender } = render(
      <ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={mocks.onSelectSharedSession} />,
    )

    const rowA = await screen.findByTestId('chat-sidebar-shared-task-share-a')
    expect(rowA.getAttribute('aria-current')).toBe('page')
    expect(mocks.listIncomingSessionShares).toHaveBeenCalledTimes(1)

    mocks.currentSessionId = 'session-b'
    rerender(<ChatSidebarSharedTasksSection organizationId="org-1" onSelectSharedSession={vi.fn()} />)

    const updatedRowA = screen.getByTestId('chat-sidebar-shared-task-share-a')
    const rowB = screen.getByTestId('chat-sidebar-shared-task-share-b')
    expect(updatedRowA.getAttribute('aria-current')).toBeNull()
    expect(rowB.getAttribute('aria-current')).toBe('page')
    expect(mocks.listIncomingSessionShares).toHaveBeenCalledTimes(1)
  })

})
