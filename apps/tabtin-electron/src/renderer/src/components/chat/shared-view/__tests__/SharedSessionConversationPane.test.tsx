import React from 'react'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  setSharedAccess: vi.fn(),
  clearSharedAccess: vi.fn(),
  getSessionShare: vi.fn(),
  listIncomingSessionShares: vi.fn(),
  openResourceTab: vi.fn(),
  chatPanel: vi.fn(() => <div data-testid="chat-panel" />),
  gatewayListeners: new Set<(envelope: Record<string, unknown>) => void>(),
  gatewayReconnectListeners: new Set<() => void>(),
  gateway: {
    addListener: vi.fn((listener: (envelope: Record<string, unknown>) => void) => {
      mocks.gatewayListeners.add(listener)
    }),
    removeListener: vi.fn((listener: (envelope: Record<string, unknown>) => void) => {
      mocks.gatewayListeners.delete(listener)
    }),
    onReconnectedEvent: vi.fn((listener: () => void) => {
      mocks.gatewayReconnectListeners.add(listener)
    }),
    offReconnectedEvent: vi.fn((listener: () => void) => {
      mocks.gatewayReconnectListeners.delete(listener)
    }),
    connect: vi.fn().mockResolvedValue(true),
  },
  spaces: [
    { id: 'workspace-owner', name: 'Owner workspace', organization_id: 'organization-1' },
  ],
  imState: {
    sessionShares: {} as Record<string, {
      detail: Record<string, unknown> | null
    }>,
  },
}))

vi.mock('@/components/chat/panel/ChatPanel', () => ({
  ChatPanel: (props: Record<string, unknown>) => mocks.chatPanel(props),
}))

vi.mock('@/stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: { spaces: typeof mocks.spaces }) => unknown) =>
    selector({ spaces: mocks.spaces }),
}))

vi.mock('@/stores/chat/session/sessionAccessStore', () => ({
  useSessionAccessStore: {
    getState: () => ({
      setSharedAccess: mocks.setSharedAccess,
      clearSharedAccess: mocks.clearSharedAccess,
    }),
  },
}))

vi.mock('@/services/tabchatApi', () => ({
  getSessionShare: mocks.getSessionShare,
  listIncomingSessionShares: mocks.listIncomingSessionShares,
}))

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({ openResourceTab: mocks.openResourceTab }),
  },
}))

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({ getGateway: () => mocks.gateway }),
}))

vi.mock('@/stores/useIMStore', () => ({
  useIMStore: (selector: (state: typeof mocks.imState) => unknown) => selector(mocks.imState),
}))

import { SharedSessionConversationPane } from '../SharedSessionConversationPane'

describe('SharedSessionConversationPane', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.gatewayListeners.clear()
    mocks.gatewayReconnectListeners.clear()
    mocks.imState.sessionShares = {}
    mocks.getSessionShare.mockReset()
    mocks.listIncomingSessionShares.mockReset()
    mocks.getSessionShare.mockResolvedValue({
      id: 'share-1',
      session_id: 'session-shared',
      status: 'active',
      workspace_id: 'workspace-owner',
      workspace_name: 'Owner workspace',
      owner_user_id: 'owner-1',
      owner_display_name: 'Owner',
    })
    mocks.listIncomingSessionShares.mockResolvedValue([{
      id: 'share-1',
      session_id: 'session-shared',
      workspace_id: 'workspace-owner',
      workspace_name: 'Owner workspace',
      owner_user_id: 'owner-1',
      owner_display_name: 'Owner',
    }])
  })

  it('从持久化 sharedsession tab 恢复 shareId，避免退回普通会话链路', async () => {
    render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        workspaceId="workspace-owner"
        workspaceName="Owner workspace"
        ownerUserId="owner-1"
        ownerDisplayName="Owner"
        incoming
      />,
    )

    await waitFor(() => {
      expect(mocks.setSharedAccess).toHaveBeenCalledWith({
        sessionId: 'session-shared',
        shareId: 'share-1',
        organizationId: 'organization-1',
        workspaceId: 'workspace-owner',
        workspaceName: 'Owner workspace',
        ownerUserId: 'owner-1',
        ownerDisplayName: 'Owner',
        role: 'grantee',
      })
    })
    expect(mocks.chatPanel).toHaveBeenCalledWith(expect.objectContaining({
      controlledSessionId: 'session-shared',
      forceControlledSessionHydration: true,
      sharedSessionAccess: {
        sessionId: 'session-shared',
        shareId: 'share-1',
        organizationId: 'organization-1',
        workspaceId: 'workspace-owner',
        workspaceName: 'Owner workspace',
        ownerUserId: 'owner-1',
        ownerDisplayName: 'Owner',
        role: 'grantee',
      },
      tabScopeKeyOverride: 'im:conversation-1',
    }))
  })

  it('持久标签缺少 shareId 时不登记或传递共享访问上下文', () => {
    render(
      <SharedSessionConversationPane
        sessionId="session-without-share"
        conversationId="conversation-1"
      organizationId="organization-1"
      incoming={false}
      />,
    )

    expect(mocks.setSharedAccess).not.toHaveBeenCalled()
    expect(mocks.chatPanel).toHaveBeenCalledWith(expect.objectContaining({
      controlledSessionId: 'session-without-share',
      sharedSessionAccess: null,
    }))
  })

  it('owner 首次渲染同步使用标签授权且不查询 incoming 列表', () => {
    render(
      <SharedSessionConversationPane
        sessionId="session-owner"
        conversationId="conversation-1"
        shareId="share-owner"
        organizationId="organization-1"
        incoming={false}
      />,
    )

    expect(mocks.chatPanel).toHaveBeenCalledWith(expect.objectContaining({
      sharedSessionAccess: expect.objectContaining({
        sessionId: 'session-owner',
        shareId: 'share-owner',
        role: 'owner',
      }),
    }))
    expect(mocks.getSessionShare).not.toHaveBeenCalled()
    expect(mocks.listIncomingSessionShares).not.toHaveBeenCalled()
  })

  it('接收者恢复时自动切换到同会话的最新有效授权并静默更新标签', async () => {
    mocks.getSessionShare.mockResolvedValueOnce({
      id: 'share-revoked',
      session_id: 'session-shared',
      status: 'revoked',
    })
    mocks.listIncomingSessionShares.mockResolvedValueOnce([{
      id: 'share-new',
      session_id: 'session-shared',
      session_title: '共享任务',
      workspace_id: 'workspace-new',
      workspace_name: 'New workspace',
      owner_user_id: 'owner-new',
      owner_display_name: 'New owner',
    }])

    const view = render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-revoked"
        organizationId="organization-1"
        workspaceId="workspace-old"
        incoming
      />,
    )

    expect(screen.queryByTestId('chat-panel')).toBeNull()
    await waitFor(() => expect(mocks.chatPanel).toHaveBeenCalledWith(expect.objectContaining({
      sharedSessionAccess: expect.objectContaining({
        sessionId: 'session-shared',
        shareId: 'share-new',
        workspaceId: 'workspace-new',
        role: 'grantee',
      }),
    })))
    expect(mocks.openResourceTab).toHaveBeenCalledWith('im:conversation-1', expect.objectContaining({
      id: 'session-shared',
      silent: true,
      meta: expect.objectContaining({ shareId: 'share-new' }),
    }))

    view.rerender(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-new"
        organizationId="organization-1"
        workspaceId="workspace-new"
        incoming
      />,
    )
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
    expect(mocks.getSessionShare).toHaveBeenCalledTimes(1)
    expect(mocks.listIncomingSessionShares).toHaveBeenCalledTimes(1)
  })

  it('接收者没有有效授权时不渲染聊天链路', async () => {
    mocks.getSessionShare.mockResolvedValueOnce({
      id: 'share-revoked',
      session_id: 'session-revoked',
      status: 'revoked',
    })
    mocks.listIncomingSessionShares.mockResolvedValueOnce([])

    render(
      <SharedSessionConversationPane
        sessionId="session-revoked"
        conversationId="conversation-1"
        shareId="share-revoked"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(screen.getByText('sharedPane.deniedEmpty')).toBeTruthy())
    expect(mocks.chatPanel).not.toHaveBeenCalled()
    expect(mocks.setSharedAccess).not.toHaveBeenCalled()
    expect(mocks.clearSharedAccess).not.toHaveBeenCalled()
  })

  it('收到撤权事件后立即卸载已打开的共享任务', async () => {
    mocks.imState.sessionShares['share-1'] = {
      detail: { id: 'share-1', status: 'active', version: 1, access_epoch: 1 },
    }
    render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
    await act(async () => {
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_revoked',
          payload: { object_id: 'share-1', version: 2, access_epoch: 2 },
        })
      }
    })

    expect(screen.getByText('sharedPane.deniedEmpty')).toBeTruthy()
    expect(screen.queryByTestId('chat-panel')).toBeNull()
    expect(mocks.clearSharedAccess).toHaveBeenCalledWith('session-shared')
  })

  it('卡片权威状态变为已停止后立即卸载已打开的共享任务', async () => {
    mocks.imState.sessionShares['share-1'] = {
      detail: { id: 'share-1', status: 'active', version: 1, access_epoch: 1 },
    }
    const view = render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
    mocks.imState.sessionShares['share-1'] = {
      detail: { id: 'share-1', status: 'revoked', version: 2, access_epoch: 2 },
    }
    view.rerender(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        incoming
      />,
    )

    expect(screen.getByText('sharedPane.deniedEmpty')).toBeTruthy()
    expect(screen.queryByTestId('chat-panel')).toBeNull()
    expect(mocks.clearSharedAccess).toHaveBeenCalledWith('session-shared')
  })

  it('恢复授权查询期间忽略重放的旧撤权事件', async () => {
    let resolveRestoredShare!: (value: Record<string, unknown>) => void
    mocks.getSessionShare
      .mockResolvedValueOnce({
        id: 'share-1',
        session_id: 'session-shared',
        status: 'active',
        version: 1,
        access_epoch: 1,
      })
      .mockReturnValueOnce(new Promise(resolve => { resolveRestoredShare = resolve }))

    const view = render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
    await act(async () => {
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_revoked',
          payload: { object_id: 'share-1', version: 2, access_epoch: 2 },
        })
      }
    })
    expect(screen.getByText('sharedPane.deniedEmpty')).toBeTruthy()

    mocks.imState.sessionShares['share-1'] = {
      detail: { id: 'share-1', status: 'active', version: 3, access_epoch: 3 },
    }
    view.rerender(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(mocks.getSessionShare).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.queryByText('sharedPane.deniedEmpty')).toBeNull())
    await act(async () => {
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_revoked',
          payload: { object_id: 'share-1', version: 2, access_epoch: 2 },
        })
      }
      resolveRestoredShare({
        id: 'share-1',
        session_id: 'session-shared',
        status: 'active',
        version: 3,
        access_epoch: 3,
      })
      await Promise.resolve()
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_revoked',
          payload: { object_id: 'share-1', version: 2, access_epoch: 2 },
        })
      }
    })

    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
  })

  it('收到恢复授权通知后重拉权威详情并恢复已打开页面', async () => {
    mocks.getSessionShare
      .mockResolvedValueOnce({
        id: 'share-1',
        session_id: 'session-shared',
        status: 'active',
        version: 1,
        access_epoch: 1,
      })
      .mockResolvedValueOnce({
        id: 'share-1',
        session_id: 'session-shared',
        status: 'active',
        version: 1,
        access_epoch: 1,
      })
      .mockResolvedValueOnce({
        id: 'share-1',
        session_id: 'session-shared',
        status: 'active',
        version: 3,
        access_epoch: 3,
      })

    render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
    await act(async () => {
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_revoked',
          payload: { object_id: 'share-1', version: 2, access_epoch: 2 },
        })
      }
    })
    expect(screen.getByText('sharedPane.deniedEmpty')).toBeTruthy()

    await act(async () => {
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_restored',
          payload: { object_id: 'share-1', version: 3, access_epoch: 3 },
        })
      }
    })

    await waitFor(() => expect(mocks.getSessionShare).toHaveBeenCalledTimes(3))
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())

    await act(async () => {
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_restored',
          payload: { object_id: 'share-1', version: 3, access_epoch: 3 },
        })
      }
    })
    expect(mocks.getSessionShare).toHaveBeenCalledTimes(3)
  })

  it('重连时通过 HTTP 对账恢复断线期间错过的授权事件', async () => {
    mocks.getSessionShare
      .mockResolvedValueOnce({
        id: 'share-1',
        session_id: 'session-shared',
        status: 'active',
        version: 1,
        access_epoch: 1,
      })
      .mockResolvedValueOnce({
        id: 'share-1',
        session_id: 'session-shared',
        status: 'active',
        version: 3,
        access_epoch: 3,
      })

    render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-1"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
    await act(async () => {
      for (const listener of mocks.gatewayListeners) {
        listener({
          type: 'session.collaboration.access_revoked',
          payload: { object_id: 'share-1', version: 2, access_epoch: 2 },
        })
      }
    })
    expect(screen.getByText('sharedPane.deniedEmpty')).toBeTruthy()

    await act(async () => {
      for (const listener of mocks.gatewayReconnectListeners) listener()
    })

    await waitFor(() => expect(mocks.getSessionShare).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(screen.getByTestId('chat-panel')).toBeTruthy())
  })

  it('接收者授权查询失败时不使用旧授权并允许重试', async () => {
    mocks.getSessionShare
      .mockRejectedValueOnce(new Error('network'))
      .mockRejectedValueOnce(new Error('network'))
    mocks.listIncomingSessionShares
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce([{
        id: 'share-after-retry',
        session_id: 'session-shared',
        workspace_id: 'workspace-owner',
        owner_user_id: 'owner-1',
      }])

    render(
      <SharedSessionConversationPane
        sessionId="session-shared"
        conversationId="conversation-1"
        shareId="share-old"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(screen.getByText('sharedPane.loadFailed')).toBeTruthy())
    expect(mocks.chatPanel).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'sharedPane.retry' }))
    await waitFor(() => expect(mocks.chatPanel).toHaveBeenCalledWith(expect.objectContaining({
      sharedSessionAccess: expect.objectContaining({ shareId: 'share-after-retry' }),
    })))
  })

  it('标签切换后忽略上一会话迟到的授权结果', async () => {
    let resolveFirst!: (value: Record<string, unknown>) => void
    mocks.getSessionShare
      .mockReturnValueOnce(new Promise(resolve => { resolveFirst = resolve }))
      .mockResolvedValueOnce({
        id: 'share-new-session',
        session_id: 'session-new',
        status: 'active',
        owner_user_id: 'owner-new',
      })

    const view = render(
      <SharedSessionConversationPane
        sessionId="session-old"
        conversationId="conversation-1"
        shareId="share-old"
        organizationId="organization-1"
        incoming
      />,
    )
    view.rerender(
      <SharedSessionConversationPane
        sessionId="session-new"
        conversationId="conversation-1"
        shareId="share-new-session"
        organizationId="organization-1"
        incoming
      />,
    )

    await waitFor(() => expect(mocks.chatPanel).toHaveBeenCalledWith(expect.objectContaining({
      controlledSessionId: 'session-new',
      sharedSessionAccess: expect.objectContaining({ shareId: 'share-new-session' }),
    })))
    await act(async () => {
      resolveFirst({
        id: 'share-old',
        session_id: 'session-old',
        status: 'active',
        owner_user_id: 'owner-old',
      })
      await Promise.resolve()
    })
    expect(mocks.setSharedAccess).not.toHaveBeenCalledWith(expect.objectContaining({
      sessionId: 'session-old',
    }))
  })
})
