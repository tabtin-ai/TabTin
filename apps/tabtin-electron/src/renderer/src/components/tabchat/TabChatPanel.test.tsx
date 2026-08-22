import React from 'react';
import { act, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLoadConversations,
  mockLoadMembers,
  mockLoadLabels,
  mockDismissSendError,
  mockDismissLoadError,
  mockMessageError,
  organizationRef,
  imStoreRef,
} = vi.hoisted(() => ({
  mockLoadConversations: vi.fn(() => Promise.resolve()),
  mockLoadMembers: vi.fn(() => Promise.resolve()),
  mockLoadLabels: vi.fn(() => Promise.resolve()),
  mockDismissSendError: vi.fn(),
  mockDismissLoadError: vi.fn(),
  mockMessageError: vi.fn(),
  organizationRef: { current: 'ws-1' as string | null },
  imStoreRef: {
    current: {
      conversations: [] as Array<{ id: string; organization_id: string }>,
      currentConversationId: null as string | null,
      connectionStatus: 'connected' as const,
      sendError: null as string | null,
      loadError: null as string | null,
      imSidebarView: 'inbox' as 'inbox' | 'contacts',
    },
  },
}));

vi.mock('@tabtin/smartsheet-ui/message', () => ({
  message: { error: mockMessageError },
  MESSAGE_ERROR_DURATION: 2_000,
}));

vi.mock('@stores/useAuthStore', () => {
  return {
    useAuthStore: (selector) => selector({ user: { id: 'user-1' } }),
  }
})

vi.mock('@/services/tabchatApi', () => {
  return {
    startIMProvider: vi.fn(() => Promise.resolve()),
  }
})

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        selectedOrganization: organizationRef.current
          ? { id: organizationRef.current }
          : null,
        members: [],
        loadMembers: mockLoadMembers,
      }),
    { subscribe: vi.fn() },
  ),
}));

vi.mock('@stores/useIMStore', () => {
  const useIMStore = ((selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      currentConversationId: imStoreRef.current.currentConversationId,
      conversations: imStoreRef.current.conversations,
      loadConversations: mockLoadConversations,
      loadLabels: mockLoadLabels,
      activeLabelFilters: [] as string[],
      connectionStatus: imStoreRef.current.connectionStatus,
      sendError: imStoreRef.current.sendError,
      dismissSendError: mockDismissSendError,
      loadError: imStoreRef.current.loadError,
      dismissLoadError: mockDismissLoadError,
      imSidebarView: imStoreRef.current.imSidebarView,
      setImSidebarView: vi.fn(),
    })) as typeof import('@stores/useIMStore').useIMStore;

  return { useIMStore };
});

vi.mock('@components/layout/IMContactsPanel', () => ({
  IMContactsPanel: () =>
    React.createElement('div', { 'data-testid': 'im-contacts-panel' }),
}));

vi.mock('./ConversationList', () => ({
  ConversationList: () =>
    React.createElement('div', { 'data-testid': 'conversation-list' }),
}));

vi.mock('./ChatView', () => ({
  ChatView: ({ conversationId }: { conversationId: string }) =>
    React.createElement('div', { 'data-testid': 'chat-view' }, conversationId),
}));

vi.mock('@components/layout/OrganizationProfileButton', () => ({
  OrganizationProfileButton: () =>
    React.createElement('div', { 'data-testid': 'organization-profile' }),
}));

describe('TabChatPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    organizationRef.current = 'ws-1';
    imStoreRef.current = {
      conversations: [],
      currentConversationId: null,
      connectionStatus: 'connected',
      sendError: null,
      loadError: null,
      imSidebarView: 'inbox',
    };
  });

  it('消息页沿用聊天头部的内容筛选，不在右侧重复渲染会话资产栏', async () => {
    imStoreRef.current.conversations = [{ id: 'conversation-1', organization_id: 'ws-1' }];
    imStoreRef.current.currentConversationId = 'conversation-1';
    const { TabChatPanel } = await import('./TabChatPanel');

    render(React.createElement(TabChatPanel, { mode: 'full' }));

    expect(screen.getByTestId('chat-view').textContent).toBe('conversation-1');
    expect(screen.queryByLabelText('会话资产')).toBeNull();
  }, 15_000);

  it('历史恢复的会话不属于当前组织时不挂载聊天区', async () => {
    imStoreRef.current.conversations = [{ id: 'conversation-1', organization_id: 'ws-2' }];
    imStoreRef.current.currentConversationId = 'conversation-1';
    const { TabChatPanel } = await import('./TabChatPanel');

    render(React.createElement(TabChatPanel, { mode: 'panel' }));

    expect(screen.queryByTestId('chat-view')).toBeNull();
    expect(screen.getByText('selectConversation')).toBeTruthy();
  }, 15_000);

  it('提供整行创建群组入口，私信从通讯录发起', async () => {
    const { TabChatPanel } = await import('./TabChatPanel');

    render(React.createElement(TabChatPanel, { mode: 'full', surface: 'card' }));

    const createGroupButton = screen.getByTestId('sidebar-im-create-group-button');
    expect(createGroupButton.textContent).toContain('createGroup');
    expect(createGroupButton.className).toContain('mx-1.5');
    expect(screen.queryByRole('button', { name: 'newDM' })).toBeNull();
  });

  it('通讯录在右侧主内容区打开，不替换会话聊天以外的左栏列表', async () => {
    imStoreRef.current.currentConversationId = 'conversation-1';
    imStoreRef.current.imSidebarView = 'contacts';
    const { TabChatPanel } = await import('./TabChatPanel');

    render(React.createElement(TabChatPanel, { mode: 'panel' }));

    expect(screen.getByTestId('im-contacts-panel')).toBeTruthy();
    expect(screen.queryByTestId('chat-view')).toBeNull();
  });

  it('panel 模式不渲染会话列表列（列表在 shell 第二列）', async () => {
    const { TabChatPanel } = await import('./TabChatPanel');

    render(React.createElement(TabChatPanel, { mode: 'panel' }));

    expect(screen.queryByTestId('conversation-list')).toBeNull();
  });

  it('organization 切换时只刷新当前 organization 的会话列表，不在组件里编排 reset / 导航态', async () => {
    const { TabChatPanel } = await import('./TabChatPanel');

    const { rerender } = render(
      React.createElement(TabChatPanel, { mode: 'panel' }),
    );

    expect(mockLoadConversations).toHaveBeenCalledWith('ws-1');

    mockLoadConversations.mockClear();
    organizationRef.current = 'ws-2';
    rerender(React.createElement(TabChatPanel, { mode: 'panel' }));

    expect(mockLoadConversations).toHaveBeenCalledWith('ws-2');
  });

  it('发送失败提示跨 organization 切换后仍按出现时间在 2 秒自动消失', async () => {
    const { TabChatPanel } = await import('./TabChatPanel');
    vi.useFakeTimers();
    imStoreRef.current.sendError = 'sendFailed';

    const { rerender } = render(
      React.createElement(TabChatPanel, { mode: 'panel' }),
    );

    expect(mockMessageError).toHaveBeenCalledWith({
      key: 'tabchat-send-error',
      content: 'sendFailed',
    });

    organizationRef.current = 'ws-2';
    rerender(React.createElement(TabChatPanel, { mode: 'panel' }));

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(mockDismissSendError).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mockDismissSendError).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it('标记已读失败提示在 2 秒后自动消失', async () => {
    const { TabChatPanel } = await import('./TabChatPanel');
    vi.useFakeTimers();
    imStoreRef.current.loadError = 'markReadFailed';

    render(React.createElement(TabChatPanel, { mode: 'panel' }));

    expect(mockMessageError).toHaveBeenCalledWith({
      key: 'tabchat-load-error',
      content: 'markReadFailed',
    });

    act(() => {
      vi.advanceTimersByTime(1_999);
    });
    expect(mockDismissLoadError).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(mockDismissLoadError).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });
});
