import { renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const {
  mockHandleOrganizationChange,
  mockEnsureActiveSelection,
  mockLoadOrganizations,
  mockSelectOrganization,
  mockRefreshOrganizationAccess,
  mockGetEffectiveOrganization,
  mockLoadAllOrganizationSpaces,
  mockLoadConversations,
  mockSetActiveSpace,
  mockRegisterCurrentDevice,
  mockLoadDevices,
  mockInitGlobalWsListener,
  mockOrganizationState,
  mockAuthState,
  mockSpaceState,
  mockIMState,
  mockSelectionState,
  mockOnForegroundOrganizationChanged,
  mockEnsureLocalWorkspaceForOrganization,
  mockDismissOrgScopedTransientUi,
  mockDeviceState,
  mockListAgents,
} = vi.hoisted(() => ({
  mockHandleOrganizationChange: vi.fn(),
  mockEnsureActiveSelection: vi.fn(),
  mockLoadOrganizations: vi.fn().mockResolvedValue(undefined),
  mockSelectOrganization: vi.fn().mockResolvedValue(undefined),
  mockRefreshOrganizationAccess: vi.fn().mockResolvedValue(undefined),
  mockGetEffectiveOrganization: vi.fn(),
  mockLoadAllOrganizationSpaces: vi.fn().mockResolvedValue(undefined),
  mockLoadConversations: vi.fn().mockResolvedValue(undefined),
  mockSetActiveSpace: vi.fn(),
  mockRegisterCurrentDevice: vi.fn().mockResolvedValue(null),
  mockLoadDevices: vi.fn().mockResolvedValue(undefined),
  mockInitGlobalWsListener: vi.fn(),
  mockEnsureLocalWorkspaceForOrganization: vi.fn().mockResolvedValue(undefined),
  mockListAgents: vi.fn().mockResolvedValue([]),
  mockOrganizationState: {
    organizations: [{ id: 'ws-1' }] as Array<{ id: string }>,
    selectedOrganization: { id: 'ws-1' } as { id: string } | null,
    lastOpenedOrganizationId: 'ws-1' as string | null,
    members: [] as Array<{ user_id: string }>,
    loadOrganizations: vi.fn().mockResolvedValue(undefined),
    getEffectiveOrganization: vi.fn(),
    selectOrganization: vi.fn().mockResolvedValue(undefined),
    refreshOrganizationAccess: vi.fn().mockResolvedValue(undefined),
    completeOrganizationContextSwitch: vi.fn(),
    error: null as string | null,
  },
  mockAuthState: {
    authPhase: 'authenticated' as const,
  },
  mockSpaceState: {
    spaces: [] as any[],
    isLoading: false,
    error: null as string | null,
    lastLoadError: null as string | null,
    loadErrorByOrganizationId: {} as Record<string, string>,
    loadAllOrganizationSpaces: vi.fn().mockResolvedValue(undefined),
  },
  mockIMState: {
    conversations: [] as any[],
    isLoadingConversations: false,
    loadError: null as string | null,
  },
  mockSelectionState: {
    selectedSpaceId: null as string | null,
    selectedSpaceKind: null as string | null,
  },
  mockDeviceState: {
    currentDevice: { id: 'device-1' } as { id: string } | null,
  },
  mockOnForegroundOrganizationChanged: vi.fn().mockReturnValue([]),
  mockDismissOrgScopedTransientUi: vi.fn(),
}));

vi.mock('@/services/dismissOrgScopedTransientUi', () => ({
  dismissOrgScopedTransientUi: mockDismissOrgScopedTransientUi,
}));

vi.mock('@stores/useOrganizationStore', () => {
  const useOrganizationStore = Object.assign(
    (selector: (state: typeof mockOrganizationState) => unknown) =>
      selector(mockOrganizationState),
    {
      getState: () => mockOrganizationState,
    },
  );
  return { useOrganizationStore };
});

vi.mock('@stores/useAuthStore', () => ({
  useAuthStore: Object.assign(
    (selector: (state: typeof mockAuthState) => unknown) =>
      selector(mockAuthState),
    { getState: () => mockAuthState, setState: vi.fn(), subscribe: vi.fn(() => () => {}) },
  ),
  selectIsAuthenticated: (state: typeof mockAuthState) =>
    state.authPhase === 'authenticated',
}));

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: Object.assign(
    (selector: (state: typeof mockSpaceState) => unknown) =>
      selector(mockSpaceState),
    {
      getState: () => mockSpaceState,
    },
  ),
}));

vi.mock('@stores/useIMStore', () => {
  const useIMStore = Object.assign(
    (selector: (state: typeof mockIMState) => unknown) =>
      selector(mockIMState),
    {
      getState: () => ({
        loadConversations: mockLoadConversations,
        conversations: mockIMState.conversations,
      }),
    },
  );
  return { useIMStore };
});

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (
    selector: (state: {
      currentDevice: { id: string } | null;
      registerCurrentDevice: typeof mockRegisterCurrentDevice;
      loadDevices: typeof mockLoadDevices;
      initGlobalWsListener: typeof mockInitGlobalWsListener;
    }) => unknown,
  ) =>
    selector({
      currentDevice: mockDeviceState.currentDevice,
      registerCurrentDevice: mockRegisterCurrentDevice,
      loadDevices: mockLoadDevices,
      initGlobalWsListener: mockInitGlobalWsListener,
    }),
}));

vi.mock('./ensureLocalWorkspace', () => ({
  ensureLocalWorkspaceForOrganization: mockEnsureLocalWorkspaceForOrganization,
}));

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: (
    selector: (
      state: typeof mockSelectionState & {
        handleOrganizationChange: typeof mockHandleOrganizationChange;
        ensureActiveSelection: typeof mockEnsureActiveSelection;
      },
    ) => unknown,
  ) =>
    selector({
      ...mockSelectionState,
      handleOrganizationChange: mockHandleOrganizationChange,
      ensureActiveSelection: mockEnsureActiveSelection,
    }),
}));

vi.mock('@stores/useBackgroundEventStore', () => ({
  onForegroundOrganizationChanged: mockOnForegroundOrganizationChanged,
  // chatApi.getChatClient 在首次 import 时会 registerBackgroundOrganizationIdResolver；
  // 对这个 hook 测试来说不关心 resolver 注入，mock 成 no-op 即可
  registerBackgroundOrganizationIdResolver: vi.fn(),
  routeEnvelopeToBackgroundBucket: vi.fn(),
  resolveEnvelopeOrganizationId: vi.fn(),
  useBackgroundEventStore: {
    getState: () => ({ clearAll: vi.fn(), subscribe: vi.fn(() => () => {}) }),
  },
}));

vi.mock('@/hooks/useConnectionRecovery', () => ({
  reconnectGatewayIfOrganizationNotSynced: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/services/chatApi', () => ({
  getChatClient: () => ({
    getGateway: vi.fn(() => ({})),
  }),
}));

vi.mock('@/stores/useWsConnectionStore', () => {
  const wsState = {
    organizationAccessBlocked: false,
    organizationAccessBlockedId: null as string | null,
    organizationAccessRecoveryInFlight: false,
  };
  const useWsConnectionStore = Object.assign(
    (selector: (state: typeof wsState) => unknown) => selector(wsState),
    { getState: () => wsState },
  );
  return {
    isOrganizationAccessBlockedFor: (
      blocked: boolean,
      blockedId: string | null,
      organizationId: string | null,
    ) => blocked && organizationId !== null && blockedId === organizationId,
    useWsConnectionStore,
  };
});

vi.mock('@/services/membershipEventHandler', () => ({
  recoverFromInvalidOrganizationAccess: vi.fn().mockResolvedValue(false),
}));

// Wave 3 收口：chatApi.ts → useWsConnectionStore → sessionResetRegistry
// 这条链在 module 加载时会访问若干 @tabtin/app-shell 的顶层 export（
// registerResetAction / ZIndex / useOrganizationStore / ...）。
// 本测试只测 hook 行为，对 reset 注册表不关心，因此采用 importOriginal 模式
// 保留真实 module，只 override `getRuntime` 注入测试 bridge。
vi.mock('@tabtin/app-shell', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@tabtin/app-shell')>();
  return {
    ...actual,
    AgentApiService: {
      ...actual.AgentApiService,
      listAgents: (...args: unknown[]) => mockListAgents(...args),
    },
    getRuntime: () => ({
      bridge: {
        setActiveSpace: mockSetActiveSpace,
      },
    }),
  };
});

describe('useSpaceListLifecycle', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    mockLoadAllOrganizationSpaces.mockReset().mockResolvedValue(undefined);
    mockLoadConversations.mockReset().mockResolvedValue(undefined);
    const { __resetColdStartMemberHydrationForTests } = await import('./useSpaceListLifecycle');
    __resetColdStartMemberHydrationForTests();
    mockOrganizationState.organizations = [{ id: 'ws-1' }];
    mockOrganizationState.selectedOrganization = { id: 'ws-1' };
    mockOrganizationState.members = [];
    mockOrganizationState.loadOrganizations = mockLoadOrganizations;
    mockOrganizationState.getEffectiveOrganization = mockGetEffectiveOrganization;
    mockOrganizationState.selectOrganization = mockSelectOrganization;
    mockOrganizationState.refreshOrganizationAccess = mockRefreshOrganizationAccess;
    mockOrganizationState.error = null;
    mockGetEffectiveOrganization.mockImplementation(
      () => mockOrganizationState.organizations[0] ?? null,
    );
    mockAuthState.authPhase = 'authenticated' as const;
    mockSpaceState.spaces = [];
    mockSpaceState.isLoading = false;
    mockSpaceState.error = null;
    mockSpaceState.lastLoadError = null;
    mockSpaceState.loadErrorByOrganizationId = {};
    mockSpaceState.loadAllOrganizationSpaces = mockLoadAllOrganizationSpaces;
    mockIMState.conversations = [];
    mockIMState.isLoadingConversations = false;
    mockIMState.loadError = null;
    mockSelectionState.selectedSpaceId = null;
    mockSelectionState.selectedSpaceKind = null;
    mockDeviceState.currentDevice = { id: 'device-1' };
  });

  it('首次挂载时会加载 organizations、拉取列表依赖并同步 selection', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    const { result } = renderHook(() => useSpaceListLifecycle());

    expect(result.current.isInitialAgentDataLoading).toBe(true);

    await waitFor(() => {
      expect(mockLoadOrganizations).toHaveBeenCalled();
      expect(mockSetActiveSpace).toHaveBeenCalledWith(null, null, 'ws-1');
      expect(mockHandleOrganizationChange).toHaveBeenCalledWith('ws-1', {
        preferCurrentSelectionAsFallback: true,
      });
      expect(mockLoadAllOrganizationSpaces).toHaveBeenCalledWith(['ws-1']);
      expect(mockLoadConversations).toHaveBeenCalledWith('ws-1');
      expect(mockInitGlobalWsListener).toHaveBeenCalled();
      expect(mockRegisterCurrentDevice).toHaveBeenCalledWith('ws-1');
      expect(mockLoadDevices).toHaveBeenCalledWith('ws-1');
      expect(mockEnsureActiveSelection).toHaveBeenCalled();
      // ：打开应用对当前 org 刷一次默认 Agent skill
      expect(mockListAgents).toHaveBeenCalledWith('ws-1');
    });
    await waitFor(() => {
      expect(result.current.isInitialAgentDataLoading).toBe(false);
    });
  });

  it('Workspace 列表就绪后不等待 IM 会话加载就结束首屏 loading', async () => {
    mockLoadConversations.mockImplementation(() => new Promise<void>(() => {}));

    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');
    const { result } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadAllOrganizationSpaces).toHaveBeenCalledWith(['ws-1']);
      expect(mockLoadConversations).toHaveBeenCalledWith('ws-1');
      expect(result.current.isInitialAgentDataLoading).toBe(false);
    });
  });

  it('冷启动已有缓存 organization 时不等待远端列表刷新结束首屏 loading', async () => {
    mockLoadOrganizations.mockImplementationOnce(() => new Promise<void>(() => {}));

    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');
    const { result } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadAllOrganizationSpaces).toHaveBeenCalledWith(['ws-1']);
      expect(result.current.isInitialAgentDataLoading).toBe(false);
    });
  });

  it('优先加载前台 organization，不被后台 organization 的慢 Workspace 请求阻塞', async () => {
    mockOrganizationState.organizations = [{ id: 'ws-1' }, { id: 'ws-2' }];
    mockOrganizationState.selectedOrganization = { id: 'ws-2' };
    mockLoadAllOrganizationSpaces.mockImplementation((organizationIds: string[]) => {
      if (organizationIds.includes('ws-1')) {
        return new Promise<void>(() => {});
      }
      return Promise.resolve();
    });

    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');
    const { result } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadAllOrganizationSpaces).toHaveBeenCalled();
      expect(mockLoadConversations).toHaveBeenCalledWith('ws-2');
      expect(mockLoadConversations).not.toHaveBeenCalledWith('ws-1');
      expect(result.current.isInitialAgentDataLoading).toBe(false);
      expect(mockEnsureLocalWorkspaceForOrganization).toHaveBeenCalledWith('ws-2');
    });
  });

  it('冷启动只加载当前 organization 的 IM 会话', async () => {
    mockOrganizationState.organizations = [{ id: 'ws-1' }, { id: 'ws-2' }];
    mockOrganizationState.selectedOrganization = { id: 'ws-2' };

    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');
    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadConversations).toHaveBeenCalledWith('ws-2');
    });
    expect(mockLoadConversations).not.toHaveBeenCalledWith('ws-1');
  });

  it('#7523 listAgents 失败后重挂载可重试', async () => {
    const { useSpaceListLifecycle, __resetColdStartMemberHydrationForTests } = await import(
      './useSpaceListLifecycle'
    );
    __resetColdStartMemberHydrationForTests();

    mockListAgents
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([]);

    const { unmount } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockListAgents).toHaveBeenCalledTimes(1);
    });
    const firstCall = mockListAgents.mock.results[0]?.value as Promise<unknown> | undefined;
    await firstCall?.catch(() => undefined);

    unmount();
    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockListAgents).toHaveBeenCalledTimes(2);
    });
  });

  it('没有 organization 时，organization 列表确认后结束首轮 Agent loading', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.organizations = [];
    mockOrganizationState.selectedOrganization = null;
    mockGetEffectiveOrganization.mockReturnValue(null);

    const { result } = renderHook(() => useSpaceListLifecycle());

    expect(result.current.isInitialAgentDataLoading).toBe(true);
    await waitFor(() => {
      expect(mockLoadOrganizations).toHaveBeenCalled();
      expect(result.current.isInitialAgentDataLoading).toBe(false);
    });
    expect(mockLoadAllOrganizationSpaces).not.toHaveBeenCalled();
    expect(mockLoadConversations).not.toHaveBeenCalled();
  });

  it('首轮加载完成后，同 ID organization 列表刷新不会重新暴露 initial loading', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    const { result, rerender } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(result.current.isInitialAgentDataLoading).toBe(false);
    });

    mockOrganizationState.organizations = [{ id: 'ws-1' }];
    rerender();

    expect(result.current.isInitialAgentDataLoading).toBe(false);
  });

  it('没有当前团队时会用有效团队兜底', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.selectedOrganization = null;
    mockOrganizationState.organizations = [{ id: 'ws-1' }, { id: 'ws-2' }];

    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockGetEffectiveOrganization).toHaveBeenCalled();
      expect(mockSelectOrganization).toHaveBeenCalledWith({ id: 'ws-1' });
    });
  });

  it('冷启动：已有持久化组织且 members 为空时，组织列表就绪后补一次 refreshOrganizationAccess', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.selectedOrganization = { id: 'ws-1' };
    mockOrganizationState.members = [];

    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadOrganizations).toHaveBeenCalled();
      expect(mockRefreshOrganizationAccess).toHaveBeenCalledTimes(1);
      expect(mockRefreshOrganizationAccess).toHaveBeenCalledWith('ws-1');
    });
    // 已有选中组织，不应再走 selectOrganization 灌水
    expect(mockSelectOrganization).not.toHaveBeenCalled();
  });

  it('冷启动：members 已非空时不重复 refreshOrganizationAccess', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.selectedOrganization = { id: 'ws-1' };
    mockOrganizationState.members = [{ user_id: 'user-1' }];

    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadOrganizations).toHaveBeenCalled();
    });
    expect(mockRefreshOrganizationAccess).not.toHaveBeenCalled();
  });

  it('冷启动：无持久化选中组织时不走 refresh，由 selectOrganization 灌 members', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.selectedOrganization = null;
    mockOrganizationState.members = [];
    mockOrganizationState.organizations = [{ id: 'ws-1' }];

    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockSelectOrganization).toHaveBeenCalledWith({ id: 'ws-1' });
    });
    expect(mockRefreshOrganizationAccess).not.toHaveBeenCalled();
  });

  it('冷启动：StrictMode 重挂载只补水一次', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.selectedOrganization = { id: 'ws-1' };
    mockOrganizationState.members = [];

    renderHook(() => useSpaceListLifecycle(), {
      wrapper: ({ children }) => <StrictMode>{children}</StrictMode>,
    });

    await waitFor(() => {
      expect(mockRefreshOrganizationAccess).toHaveBeenCalledTimes(1);
      expect(mockRefreshOrganizationAccess).toHaveBeenCalledWith('ws-1');
    });
  });

  it('手动切换组织不额外触发冷启动 refreshOrganizationAccess', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.selectedOrganization = { id: 'ws-1' };
    mockOrganizationState.members = [];

    const { rerender } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockRefreshOrganizationAccess).toHaveBeenCalledTimes(1);
    });
    mockRefreshOrganizationAccess.mockClear();
    mockDismissOrgScopedTransientUi.mockClear();

    mockOrganizationState.organizations = [{ id: 'ws-1' }, { id: 'ws-2' }];
    mockOrganizationState.selectedOrganization = { id: 'ws-2' };
    mockOrganizationState.members = [];
    rerender();

    await waitFor(() => {
      expect(mockHandleOrganizationChange).toHaveBeenCalledWith('ws-2', {
        preferCurrentSelectionAsFallback: false,
      });
    });
    expect(
      mockOrganizationState.completeOrganizationContextSwitch,
    ).not.toHaveBeenCalled();
    expect(mockDismissOrgScopedTransientUi).toHaveBeenCalledWith({
      organizationId: 'ws-2',
      previousOrganizationId: 'ws-1',
    });
    expect(mockRefreshOrganizationAccess).not.toHaveBeenCalled();
  });

  it('未认证时不会触发数据加载', async () => {
    mockAuthState.authPhase = 'unauthenticated' as const;
    mockOrganizationState.selectedOrganization = null;

    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    renderHook(() => useSpaceListLifecycle());

    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(mockLoadOrganizations).not.toHaveBeenCalled();
    expect(mockLoadAllOrganizationSpaces).not.toHaveBeenCalled();
    expect(mockLoadConversations).not.toHaveBeenCalled();
    expect(mockRegisterCurrentDevice).not.toHaveBeenCalled();
    expect(mockLoadDevices).not.toHaveBeenCalled();
    expect(mockInitGlobalWsListener).not.toHaveBeenCalled();
  });

  it('organization 列表加载报错时，仍会基于持久化 organizations 继续恢复数据', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockOrganizationState.error = 'organization failed';
    mockOrganizationState.organizations = [{ id: 'ws-1' }];
    mockOrganizationState.selectedOrganization = { id: 'ws-1' };

    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadAllOrganizationSpaces).toHaveBeenCalledWith(['ws-1']);
      expect(mockLoadConversations).toHaveBeenCalledWith('ws-1');
      expect(mockSetActiveSpace).toHaveBeenCalledWith(null, null, 'ws-1');
    });
  });

  it('没有记忆选中但已有 Space 时，会走 ensureActiveSelection', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockSelectionState.selectedSpaceId = null;
    mockSelectionState.selectedSpaceKind = null;
    mockSpaceState.spaces = [{ id: 'space-1', name: '默认 Space', organization_id: 'ws-1' }] as any[];

    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockEnsureActiveSelection).toHaveBeenCalled();
    });
  });

  it('切换 organization 时保留 chat 缓存桶（Wave 3），只重新编排 selection 并触发事件分桶切换', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    const { rerender } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockHandleOrganizationChange).toHaveBeenCalledWith('ws-1', {
        preferCurrentSelectionAsFallback: true,
      });
    });

    mockHandleOrganizationChange.mockClear();
    mockOnForegroundOrganizationChanged.mockClear();
    mockLoadConversations.mockClear();

    mockOrganizationState.organizations = [{ id: 'ws-1' }, { id: 'ws-2' }];
    mockOrganizationState.selectedOrganization = { id: 'ws-2' };

    rerender();

    await waitFor(() => {
      expect(mockHandleOrganizationChange).toHaveBeenCalledWith('ws-2', {
        preferCurrentSelectionAsFallback: false,
      });
      expect(mockOnForegroundOrganizationChanged).toHaveBeenCalledWith('ws-1', 'ws-2');
      // Wave 4：切换 organization 时显式刷新新前台 conversations，缓解 P6/R4-08
      // ——Wave 4 之前 Centrifugo 重连顺势刷新这些元数据，Wave 4 后必须显式触发。
      expect(mockLoadConversations).toHaveBeenCalledWith('ws-2');
    });
  });

  it('新建组织后 spaces 尚未灌入时：保持 loading，不露出 Welcome，也不触发 ensureLocalWorkspace', async () => {
    // 回归：任务页建组织 → handleOrganizationChange 清空选中 → 全局 hasLoadedSpaceListData
    // 仍为 true → 误判空组织并闪「准备好了」中间页 / 双写默认 Workspace。
    let resolveSpacesLoad: (() => void) | undefined;
    mockLoadAllOrganizationSpaces.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSpacesLoad = resolve;
        }),
    );

    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');
    const { result, rerender } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadAllOrganizationSpaces).toHaveBeenCalledWith(['ws-1']);
    });
    resolveSpacesLoad?.();
    await waitFor(() => {
      expect(result.current.isInitialAgentDataLoading).toBe(false);
    });

    mockEnsureLocalWorkspaceForOrganization.mockClear();
    mockLoadAllOrganizationSpaces.mockClear();
    mockLoadAllOrganizationSpaces.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSpacesLoad = resolve;
        }),
    );

    mockOrganizationState.organizations = [{ id: 'ws-1' }, { id: 'ws-2' }];
    mockOrganizationState.selectedOrganization = { id: 'ws-2' };
    mockSelectionState.selectedSpaceId = null;
    mockSelectionState.selectedSpaceKind = null;
    mockSpaceState.spaces = [];

    rerender();

    await waitFor(() => {
      expect(mockHandleOrganizationChange).toHaveBeenCalledWith('ws-2', {
        preferCurrentSelectionAsFallback: false,
      });
      expect(result.current.isInitialAgentDataLoading).toBe(true);
    });
    expect(mockEnsureLocalWorkspaceForOrganization).not.toHaveBeenCalled();

    mockSpaceState.spaces = [
      {
        id: 'space-default-2',
        name: '默认工作空间',
        organization_id: 'ws-2',
        is_default: true,
        type: 'workspace',
      },
    ] as any[];
    mockEnsureActiveSelection.mockClear();
    resolveSpacesLoad?.();
    rerender();

    await waitFor(() => {
      expect(result.current.isInitialAgentDataLoading).toBe(false);
      expect(mockEnsureActiveSelection).toHaveBeenCalled();
    });
    expect(mockEnsureLocalWorkspaceForOrganization).toHaveBeenCalledWith('ws-2');
  });

  it('spaces 就绪且无选中时调用 ensureActiveSelection（默认工作空间由 store 解析）', async () => {
    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');

    mockSelectionState.selectedSpaceId = null;
    mockSelectionState.selectedSpaceKind = null;
    mockSpaceState.spaces = [
      {
        id: 'space-other',
        name: '其他',
        organization_id: 'ws-1',
        is_default: false,
        type: 'workspace',
      },
      {
        id: 'space-default',
        name: '默认工作空间',
        organization_id: 'ws-1',
        is_default: true,
        type: 'workspace',
      },
    ] as any[];

    renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockEnsureActiveSelection).toHaveBeenCalled();
    });
  });

  it('spaces 列表加载失败时：不标 ready，不触发 ensureLocalWorkspace', async () => {
    mockLoadAllOrganizationSpaces.mockImplementation(async () => {
      mockSpaceState.error = 'Failed to load spaces';
      mockSpaceState.lastLoadError = 'Failed to load spaces';
      mockSpaceState.loadErrorByOrganizationId = { 'ws-1': 'Failed to load spaces' };
      mockSpaceState.spaces = [];
    });

    const { useSpaceListLifecycle } = await import('./useSpaceListLifecycle');
    const { result } = renderHook(() => useSpaceListLifecycle());

    await waitFor(() => {
      expect(mockLoadAllOrganizationSpaces).toHaveBeenCalled();
      // 加载结束（结束 loading），但未成功 ready → 仍可视为 initial loading
      expect(result.current.isInitialAgentDataLoading).toBe(true);
    });

    expect(mockEnsureLocalWorkspaceForOrganization).not.toHaveBeenCalled();
  });
});
