import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@tabtin/shared', () => ({
  withPersistSafety: (options: unknown) => options,
}));

const {
  mockRegisterResetAction,
  mockEmitNavigate,
  mockRuntimeBridge,
  mockCompleteOrganizationContextSwitch,
  mockOrganizationId,
  mockOrganizations,
  mockSpaceStoreState,
  mockIMState,
} = vi.hoisted(() => {
  const spaceStoreState = {
    spaces: [] as any[],
    selectedSpace: null as any,
    isLoading: false,
    error: null as string | null,
    selectSpace: vi.fn((space: any) => {
      spaceStoreState.selectedSpace = space;
    }),
    clearSelectedAgentOutsideOrganization: vi.fn(),
  };

  const imState = {
    conversations: [] as any[],
    unreadCounts: {} as Record<string, number>,
    isLoading: false,
    error: null as string | null,
    currentConversationId: null as string | null,
    isIMActive: false,
    isContactsViewActive: false,
    openIM: vi.fn(() => {
      imState.isIMActive = true;
    }),
    closeIM: vi.fn(() => {
      imState.isIMActive = false;
    }),
    setCurrentConversation: vi.fn((id: string | null) => {
      imState.currentConversationId = id;
    }),
    reset: vi.fn(() => {
      imState.conversations = [];
      imState.unreadCounts = {};
      imState.currentConversationId = null;
      imState.isIMActive = false;
    }),
  };

  return {
    mockRegisterResetAction: vi.fn(),
    mockEmitNavigate: vi.fn(),
    mockCompleteOrganizationContextSwitch: vi.fn(),
    mockRuntimeBridge: {
      closeAuxiliaryPanels: vi.fn(),
      purgeInvalidSpaceDerivedState: vi.fn(),
    },
    mockOrganizationId: { value: 'ws-1' as string | null },
    mockOrganizations: {
      value: [{ id: 'ws-1', name: 'Organization', type: 'team' }] as any[],
    },
    mockSpaceStoreState: spaceStoreState,
    mockIMState: imState,
  };
});

vi.mock('./session-reset-registry.js', () => ({
  registerResetAction: mockRegisterResetAction,
}));

vi.mock('./view-navigation.js', () => ({
  emitNavigate: mockEmitNavigate,
}));

vi.mock('../runtime.js', () => ({
  getRuntime: () => ({
    bridge: mockRuntimeBridge,
  }),
}));

vi.mock('./use-organization-store.js', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: mockOrganizationId.value
        ? { id: mockOrganizationId.value }
        : null,
      organizations: mockOrganizationId.value ? mockOrganizations.value : [],
      completeOrganizationContextSwitch: mockCompleteOrganizationContextSwitch,
    }),
    subscribe: vi.fn(() => () => {}),
  },
}));

vi.mock('./use-space-store.js', () => ({
  useSpaceStore: {
    getState: () => mockSpaceStoreState,
  },
}));

let useSpaceListStore: typeof import('./use-space-list-store.js').useSpaceListStore;
let setExternalStoreAdapters: typeof import('./use-space-list-store.js').setExternalStoreAdapters;

beforeEach(async () => {
  vi.clearAllMocks();
  vi.resetModules();
  mockOrganizationId.value = 'ws-1';
  mockOrganizations.value = [{ id: 'ws-1', name: 'Organization', type: 'team' }];
  mockSpaceStoreState.spaces = [];
  mockSpaceStoreState.selectedSpace = null;
  mockSpaceStoreState.isLoading = false;
  mockSpaceStoreState.error = null;
  mockIMState.conversations = [];
  mockIMState.unreadCounts = {};
  mockIMState.isLoading = false;
  mockIMState.error = null;
  mockIMState.currentConversationId = null;
  mockIMState.isIMActive = false;
  mockIMState.isContactsViewActive = false;
  mockRuntimeBridge.closeAuxiliaryPanels.mockReset();
  mockRuntimeBridge.purgeInvalidSpaceDerivedState.mockReset();
  window.localStorage.clear();

  const mod = await import('./use-space-list-store.js');
  useSpaceListStore = mod.useSpaceListStore;
  setExternalStoreAdapters = mod.setExternalStoreAdapters;

  setExternalStoreAdapters({
    im: {
      getConversations: () => mockIMState.conversations,
      getUnreadCounts: () => mockIMState.unreadCounts,
      isLoading: () => mockIMState.isLoading,
      getError: () => mockIMState.error,
      openIM: () => mockIMState.openIM(),
      closeIM: () => mockIMState.closeIM(),
      setCurrentConversation: (id) => mockIMState.setCurrentConversation(id),
      isIMActive: () => mockIMState.isIMActive,
      isContactsViewActive: () => mockIMState.isContactsViewActive,
      getCurrentConversationId: () => mockIMState.currentConversationId,
      reset: () => mockIMState.reset(),
    },
  });

  useSpaceListStore.setState({
    selectedSpaceId: null,
    selectedSpaceKind: null,
    selectionByOrganization: {},
  });
});

describe('useSpaceListStore', () => {
  it('通讯录打开时不恢复已清空的会话选择', () => {
    mockIMState.conversations = [
      {
        id: 'conv-1',
        organization_id: 'ws-1',
        space_id: 'space-conv-1',
        type: 1,
        name: 'DM One',
        unread_count: 0,
        member_count: 2,
      },
    ];
    mockIMState.isContactsViewActive = true;
    useSpaceListStore.setState({
      selectedSpaceId: null,
      selectedSpaceKind: null,
      selectionByOrganization: {
        'ws-1': {
          selectedSpaceId: 'dm:conv-1',
          selectedSpaceKind: 'dm',
        },
      },
    });

    useSpaceListStore.getState().reconcileSelection();

    expect(mockIMState.setCurrentConversation).not.toHaveBeenCalledWith('conv-1');
    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: null,
      selectedSpaceKind: null,
    });
  });

  it('getSpaceList 无过滤参数时保持返回全部 SpaceListItem', () => {
    mockOrganizations.value = [
      { id: 'ws-1', name: 'Personal', type: 'personal' },
      { id: 'ws-2', name: 'Team Two', type: 'team' },
    ];
    mockOrganizationId.value = 'ws-2';
    mockSpaceStoreState.spaces = [
      { id: 'space-1', organization_id: 'ws-1', name: 'Old Team Bot' },
      {
        id: 'space-2',
        organization_id: 'ws-2',
        name: 'Current Team Bot',
        working_dir: 'C:\\Users\\me\\project',
        normalized_working_dir: 'C:\\Users\\me\\project',
        working_dir_type: 'code',
      },
    ];
    mockIMState.conversations = [
      {
        id: 'conv-1',
        organization_id: 'ws-2',
        space_id: 'space-conv-1',
        type: 1,
        name: 'Team Two DM',
        unread_count: 0,
        member_count: 2,
      },
    ];

    const allItems = useSpaceListStore.getState().getSpaceList();

    expect(allItems.map(item => item.source_id)).toEqual(['space-1', 'space-2', 'conv-1']);
    expect(allItems.find(item => item.source_id === 'space-2')).toMatchObject({
      working_dir: 'C:\\Users\\me\\project',
      normalized_working_dir: 'C:\\Users\\me\\project',
      working_dir_type: 'code',
    });
  });

  it('getSpaceList 可按当前 organization 和 navigation kind 过滤列表', () => {
    mockOrganizations.value = [
      { id: 'ws-1', name: 'Personal', type: 'personal' },
      { id: 'ws-2', name: 'Team Two', type: 'team' },
    ];
    mockOrganizationId.value = 'ws-2';
    mockSpaceStoreState.spaces = [
      { id: 'space-1', organization_id: 'ws-1', name: 'Old Team Bot' },
      { id: 'space-2', organization_id: 'ws-2', name: 'Current Team Bot' },
    ];
    mockIMState.conversations = [
      {
        id: 'conv-1',
        organization_id: 'ws-2',
        space_id: 'space-conv-1',
        type: 1,
        name: 'Team Two DM',
        unread_count: 0,
        member_count: 2,
      },
    ];

    const scopedList = useSpaceListStore.getState().getSpaceList({
      organizationId: 'ws-2',
      navigationKinds: ['workspace'],
    });

    expect(scopedList.map(item => item.source_id)).toEqual(['space-2']);
  });

  it('getSpaceList 不把 team_space 放进执行 Space 切换列表', () => {
    mockSpaceStoreState.spaces = [
      { id: 'space-1', organization_id: 'ws-1', name: 'Owner Personal Space', type: 'workspace' },
      { id: 'team-space-1', organization_id: 'ws-1', name: 'Launch Team Space', type: 'team_space' },
    ];

    const items = useSpaceListStore.getState().getSpaceList({
      organizationId: 'ws-1',
      navigationKinds: ['workspace'],
    });

    expect(items.map(item => item.source_id)).toEqual(['space-1']);
  });

  it('getSpaceList workspace 顺序按 order/created_at 稳定，不随数组插入序漂移', () => {
    mockOrganizations.value = [{ id: 'ws-1', name: 'Personal', type: 'personal' }];
    mockOrganizationId.value = 'ws-1';
    // 模拟 loadSpaces 曾按 last_activity_at 把较新活跃的 B 排到前面
    mockSpaceStoreState.spaces = [
      {
        id: 'space-b',
        organization_id: 'ws-1',
        name: 'B',
        type: 'workspace',
        order: 0,
        created_at: '2026-01-02T00:00:00.000Z',
        last_activity_at: '2026-07-11T12:00:00.000Z',
      },
      {
        id: 'space-a',
        organization_id: 'ws-1',
        name: 'A',
        type: 'workspace',
        order: 0,
        created_at: '2026-01-03T00:00:00.000Z',
        last_activity_at: '2026-07-10T12:00:00.000Z',
      },
      {
        id: 'space-c',
        organization_id: 'ws-1',
        name: 'C',
        type: 'workspace',
        order: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        last_activity_at: '2026-07-11T18:00:00.000Z',
      },
    ];

    const items = useSpaceListStore.getState().getSpaceList({
      organizationId: 'ws-1',
      navigationKinds: ['workspace'],
    });

    // order=0 内按 created_at 降序：A(更新) → B；再是 order=1 的 C
    expect(items.map(item => item.source_id)).toEqual(['space-a', 'space-b', 'space-c']);
  });

  it('selectSpaceBySpaceId 不允许 team_space 进入执行 Space 选择链', () => {
    mockSpaceStoreState.spaces = [
      { id: 'team-space-1', organization_id: 'ws-1', name: 'Launch Team Space', type: 'team_space' },
    ];

    const selected = useSpaceListStore.getState().selectSpaceBySpaceId('team-space-1');

    expect(selected).toBe(false);
    expect(mockSpaceStoreState.selectSpace).not.toHaveBeenCalled();
    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: null,
      selectedSpaceKind: null,
    });
  });

  it('activateSpace 和 selectSpaceById 不允许 team_space 被当作 workspace 激活', () => {
    mockSpaceStoreState.spaces = [
      { id: 'team-space-1', organization_id: 'ws-1', name: 'Launch Team Space', type: 'team_space' },
    ];

    useSpaceListStore.getState().activateSpace('team-space-1');
    useSpaceListStore.getState().selectSpaceById('workspace', 'team-space-1');

    expect(mockSpaceStoreState.selectSpace).toHaveBeenCalledWith(null);
    expect(mockSpaceStoreState.selectSpace).not.toHaveBeenCalledWith(
      expect.objectContaining({ id: 'team-space-1' }),
    );
    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: null,
      selectedSpaceKind: null,
    });
  });

  it('#8759 only completes the organization switch after its Workspace is activated', () => {
    const target = {
      id: 'space-b',
      organization_id: 'ws-2',
      name: 'Organization B Workspace',
      type: 'workspace',
    };
    mockSpaceStoreState.spaces = [target];

    expect(useSpaceListStore.getState().activateSpace(target.id)).toBe(true);
    expect(mockSpaceStoreState.selectedSpace).toEqual(target);
    expect(mockCompleteOrganizationContextSwitch).toHaveBeenCalledWith('ws-2');
  });

  it('切换到 workspace 空间时会清掉 group / IM 的残留选中态', () => {
    mockSpaceStoreState.spaces = [
      { id: 'space-1', organization_id: 'ws-1', name: 'Bot One' },
    ];
    mockIMState.currentConversationId = 'conv-1';
    mockIMState.isIMActive = true;

    const success = useSpaceListStore
      .getState()
      .selectSpaceById('workspace', 'space-1');

    expect(success).toBeUndefined();
    expect(mockSpaceStoreState.selectedSpace?.id).toBe('space-1');
    expect(mockIMState.setCurrentConversation).toHaveBeenCalledWith(null);
    expect(mockIMState.closeIM).toHaveBeenCalled();
    expect(mockRuntimeBridge.closeAuxiliaryPanels).toHaveBeenCalledTimes(1);
    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: 'space-1',
      selectedSpaceKind: 'workspace',
    });
  });

  it('reconcileSelection：workspace 记忆下若仅残留 currentConversationId，会回拉 workspace（点消息须走 activateConversation）', () => {
    // ：primaryNavigation 若只 setCurrentConversation 不 activateConversation，
    // 会落入本分支并清掉 IM。回归锁：行为仍在，入口必须走完整激活。
    mockSpaceStoreState.spaces = [
      { id: 'space-1', organization_id: 'ws-1', name: 'Bot One', type: 'workspace' },
    ];
    mockSpaceStoreState.selectedSpace = {
      id: 'space-1',
      organization_id: 'ws-1',
      name: 'Bot One',
      type: 'workspace',
    };
    mockIMState.conversations = [
      {
        id: 'conv-1',
        organization_id: 'ws-1',
        space_id: 'space-conv-1',
        type: 1,
        name: 'DM One',
        unread_count: 0,
        member_count: 2,
      },
    ];
    mockIMState.currentConversationId = 'conv-1';
    mockIMState.isIMActive = false;
    useSpaceListStore.setState({
      selectedSpaceId: 'workspace:space-1',
      selectedSpaceKind: 'workspace',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().reconcileSelection();

    expect(mockIMState.closeIM).toHaveBeenCalled();
    expect(mockIMState.setCurrentConversation).toHaveBeenCalledWith(null);
    expect(mockRuntimeBridge.closeAuxiliaryPanels).toHaveBeenCalled();
  });

  it('reconcileSelection 会把记忆的 IM 选择重新同步到域 store', () => {
    mockSpaceStoreState.selectedSpace = {
      id: 'space-legacy',
      organization_id: 'ws-1',
      name: 'Legacy',
    };
    mockIMState.conversations = [
      {
        id: 'conv-1',
        organization_id: 'ws-1',
        space_id: 'space-conv-1',
        type: 1,
        name: 'DM One',
        unread_count: 0,
        member_count: 2,
      },
    ];
    useSpaceListStore.setState({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().reconcileSelection();

    expect(mockSpaceStoreState.selectedSpace).toBe(null);
    expect(mockIMState.openIM).toHaveBeenCalled();
    expect(mockIMState.setCurrentConversation).toHaveBeenCalledWith('conv-1');
    expect(mockRuntimeBridge.closeAuxiliaryPanels).toHaveBeenCalledTimes(1);
    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
    });
  });

  it('ensureActiveSelection 保留 team 项目选择态，即使当前活跃 Workspace 不是组织默认', () => {
    // selectedSpace 停在非默认个人 Workspace（Project 沉浸常态），不得被 ensure 踢回 is_default。
    const other = {
      id: 'space-other',
      organization_id: 'ws-1',
      name: 'Other',
      type: 'workspace',
    };
    const home = {
      id: 'space-home',
      organization_id: 'ws-1',
      name: 'Home',
      type: 'workspace',
      is_default: true,
    };
    mockSpaceStoreState.spaces = [other, home];
    mockSpaceStoreState.selectedSpace = other;
    useSpaceListStore.setState({
      selectedSpaceId: 'team:team-space-1',
      selectedSpaceKind: 'team',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(mockRuntimeBridge.closeAuxiliaryPanels).not.toHaveBeenCalled();
    expect(mockIMState.closeIM).not.toHaveBeenCalled();
    expect(mockSpaceStoreState.selectSpace).not.toHaveBeenCalled();
    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: 'team:team-space-1',
      selectedSpaceKind: 'team',
    });
    expect(mockSpaceStoreState.selectedSpace).toEqual(other);
  });

  it('ensureActiveSelection：IM loading 时保留 dm 选中，不回落 Workspace', () => {
    const home = {
      id: 'space-home',
      organization_id: 'ws-1',
      name: 'Home',
      type: 'workspace',
      is_default: true,
    };
    mockSpaceStoreState.spaces = [home];
    mockIMState.isLoading = true;
    mockIMState.conversations = [];
    useSpaceListStore.setState({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(mockSpaceStoreState.selectSpace).not.toHaveBeenCalled();
    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
    });
  });

  it('首次切换到新 organization 时，不会把旧组织选中误写成新组织记忆', () => {
    mockSpaceStoreState.spaces = [
      { id: 'space-1', organization_id: 'ws-1', name: 'Bot One' },
    ];
    useSpaceListStore.setState({
      selectedSpaceId: 'space-1',
      selectedSpaceKind: 'workspace',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().handleOrganizationChange('ws-2', {
      preferCurrentSelectionAsFallback: true,
    });

    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: null,
      selectedSpaceKind: null,
      selectionByOrganization: {},
    });
  });

  it('syncSelectionState 在域数据加载中不会提前清空记忆快照或清理派生状态', () => {
    mockSpaceStoreState.spaces = [
      { id: 'space-old', organization_id: 'ws-1', name: 'Legacy Space' },
    ];
    mockSpaceStoreState.isLoading = true;
    useSpaceListStore.setState({
      selectedSpaceId: 'space-new',
      selectedSpaceKind: 'workspace',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().syncSelectionState();

    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: 'space-new',
      selectedSpaceKind: 'workspace',
    });
    expect(
      mockRuntimeBridge.purgeInvalidSpaceDerivedState,
    ).not.toHaveBeenCalled();
    expect(mockSpaceStoreState.selectSpace).not.toHaveBeenCalled();
  });

  it('ensureActiveSelection：IM loadError 不阻断有效 workspace 记忆激活', () => {
    const target = {
      id: 'space-1',
      organization_id: 'ws-1',
      name: '测试',
      type: 'workspace',
    };
    mockSpaceStoreState.spaces = [target];
    mockSpaceStoreState.selectedSpace = null;
    mockIMState.error = 'loadConversationsFailed';
    useSpaceListStore.setState({
      selectedSpaceId: 'space-1',
      selectedSpaceKind: 'workspace',
      selectionByOrganization: {
        'ws-1': {
          selectedSpaceId: 'space-1',
          selectedSpaceKind: 'workspace',
        },
      },
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(mockSpaceStoreState.selectSpace).toHaveBeenCalledWith(target);
    expect(mockSpaceStoreState.selectedSpace).toEqual(target);
  });

  it('ensureActiveSelection：markReadFailed 不把当前 IM 会话踢回 Workspace', () => {
    const home = {
      id: 'space-home',
      organization_id: 'ws-1',
      name: '默认',
      type: 'workspace',
      is_default: true,
    };
    mockSpaceStoreState.spaces = [home];
    mockSpaceStoreState.selectedSpace = null;
    mockIMState.conversations = [
      { id: 'conv-1', type: 1, organization_id: 'ws-1' },
    ];
    mockIMState.error = 'markReadFailed';
    mockIMState.currentConversationId = 'conv-1';
    mockIMState.isIMActive = true;
    useSpaceListStore.setState({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
      selectionByOrganization: {
        'ws-1': {
          selectedSpaceId: 'dm:conv-1',
          selectedSpaceKind: 'dm',
        },
      },
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
    });
    expect(mockIMState.currentConversationId).toBe('conv-1');
    expect(mockIMState.isIMActive).toBe(true);
    expect(mockIMState.setCurrentConversation).not.toHaveBeenCalledWith(null);
    expect(mockSpaceStoreState.selectSpace).not.toHaveBeenCalled();
  });

  it('ensureActiveSelection：无选中时自动激活默认 Workspace', () => {
    const home = {
      id: 'space-home',
      organization_id: 'ws-1',
      name: '默认',
      type: 'workspace',
      is_default: true,
    };
    mockSpaceStoreState.spaces = [
      {
        id: 'space-other',
        organization_id: 'ws-1',
        name: '其他',
        type: 'workspace',
      },
      home,
    ];
    useSpaceListStore.setState({
      selectedSpaceId: null,
      selectedSpaceKind: null,
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(mockSpaceStoreState.selectSpace).toHaveBeenCalledWith(home);
  });

  it('ensureActiveSelection：无选中时优先本机最后使用 Workspace', () => {
    const lastUsed = {
      id: 'space-last',
      organization_id: 'ws-1',
      name: '最近用过',
      type: 'workspace',
    };
    const home = {
      id: 'space-home',
      organization_id: 'ws-1',
      name: '默认',
      type: 'workspace',
      is_default: true,
    };
    mockSpaceStoreState.spaces = [lastUsed, home];
    setExternalStoreAdapters({
      im: {
        getConversations: () => mockIMState.conversations,
        getUnreadCounts: () => mockIMState.unreadCounts,
        isLoading: () => mockIMState.isLoading,
        getError: () => mockIMState.error,
        openIM: () => mockIMState.openIM(),
        closeIM: () => mockIMState.closeIM(),
        setCurrentConversation: (id) => mockIMState.setCurrentConversation(id),
        isIMActive: () => mockIMState.isIMActive,
        isContactsViewActive: () => mockIMState.isContactsViewActive,
        getCurrentConversationId: () => mockIMState.currentConversationId,
        reset: () => mockIMState.reset(),
      },
      getLastUsedWorkspaceId: () => 'space-last',
    });
    useSpaceListStore.setState({
      selectedSpaceId: null,
      selectedSpaceKind: null,
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(mockSpaceStoreState.selectSpace).toHaveBeenCalledWith(lastUsed);
  });

  it('ensureActiveSelection：loadConversationsFailed 且缓存无会话时 dm 回落 Workspace', () => {
    const home = {
      id: 'space-home',
      organization_id: 'ws-1',
      name: '默认',
      type: 'workspace',
      is_default: true,
    };
    mockSpaceStoreState.spaces = [home];
    mockIMState.error = 'loadConversationsFailed';
    mockIMState.conversations = [];
    useSpaceListStore.setState({
      selectedSpaceId: 'dm:conv-missing',
      selectedSpaceKind: 'dm',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(mockSpaceStoreState.selectSpace).toHaveBeenCalledWith(home);
  });

  it('ensureActiveSelection：loadConversationsFailed 但缓存仍有会话时不踢出', () => {
    const home = {
      id: 'space-home',
      organization_id: 'ws-1',
      name: '默认',
      type: 'workspace',
      is_default: true,
    };
    mockSpaceStoreState.spaces = [home];
    mockSpaceStoreState.selectedSpace = null;
    mockIMState.error = 'loadConversationsFailed';
    mockIMState.conversations = [
      { id: 'conv-1', type: 1, organization_id: 'ws-1' },
    ];
    mockIMState.currentConversationId = 'conv-1';
    mockIMState.isIMActive = true;
    useSpaceListStore.setState({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
      selectionByOrganization: {
        'ws-1': {
          selectedSpaceId: 'dm:conv-1',
          selectedSpaceKind: 'dm',
        },
      },
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(useSpaceListStore.getState()).toMatchObject({
      selectedSpaceId: 'dm:conv-1',
      selectedSpaceKind: 'dm',
    });
    expect(mockIMState.currentConversationId).toBe('conv-1');
    expect(mockIMState.isIMActive).toBe(true);
    expect(mockIMState.setCurrentConversation).not.toHaveBeenCalledWith(null);
    expect(mockSpaceStoreState.selectSpace).not.toHaveBeenCalled();
  });

  it('ensureActiveSelection：真无 Workspace 时不臆造激活', () => {
    mockSpaceStoreState.spaces = [];
    useSpaceListStore.setState({
      selectedSpaceId: null,
      selectedSpaceKind: null,
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().ensureActiveSelection();

    expect(mockSpaceStoreState.selectSpace).toHaveBeenCalledWith(null);
  });

  // Wave 4: 切换 organization 不再 reset IM —— Centrifugo 用户级连接持续，
  // IM conversations / messages / unreadCounts 应跨 organization 共存。
  it('Wave 4: handleOrganizationChange 不调用 adapters.im.reset（fallback 路径）', () => {
    // fallback 路径：目标 organization 的 remembered selection 为 'workspace' 但 spaces
    // 列表里查不到 → 走 selectSpace(null) + hydrate
    useSpaceListStore.setState({
      selectedSpaceId: null,
      selectedSpaceKind: null,
      selectionByOrganization: {
        'ws-2': { selectedSpaceId: 'unknown-space', selectedSpaceKind: 'workspace' },
      },
    });

    useSpaceListStore.getState().handleOrganizationChange('ws-2');

    expect(mockIMState.reset).not.toHaveBeenCalled();
  });

  it('Wave 4: handleOrganizationChange 不调用 adapters.im.reset（organizationId=null 路径）', () => {
    useSpaceListStore.setState({
      selectedSpaceId: 'space-1',
      selectedSpaceKind: 'workspace',
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().handleOrganizationChange(null);

    expect(mockIMState.reset).not.toHaveBeenCalled();
  });

  it('#8617: handleOrganizationChange 会清跨 org selectedAgent', () => {
    useSpaceListStore.setState({
      selectedSpaceId: null,
      selectedSpaceKind: null,
      selectionByOrganization: {},
    });

    useSpaceListStore.getState().handleOrganizationChange('ws-2');

    expect(
      mockSpaceStoreState.clearSelectedAgentOutsideOrganization,
    ).toHaveBeenCalledWith('ws-2');
  });
});
