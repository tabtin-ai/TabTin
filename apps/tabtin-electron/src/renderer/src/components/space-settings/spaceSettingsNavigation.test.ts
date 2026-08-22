import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockDispatchSelect,
  mockBuildTabKey,
  mockOpenResourceTab,
  mockSelectSpaceById,
  mockSetCurrentTab,
  mockGetSpaceSettingsTitle,
  mockExpandCanvasForScope,
} = vi.hoisted(() => ({
  mockDispatchSelect: vi.fn(),
  mockBuildTabKey: vi.fn((type: string, id: string) => `${type}:${id}`),
  mockOpenResourceTab: vi.fn(),
  mockSelectSpaceById: vi.fn(),
  mockSetCurrentTab: vi.fn(),
  mockGetSpaceSettingsTitle: vi.fn((spaceId: string) => `settings:${spaceId}`),
  mockExpandCanvasForScope: vi.fn(),
}));

vi.mock('@components/context-space/registry', () => ({
  contextRegistry: {
    buildTabKey: mockBuildTabKey,
    dispatchSelect: mockDispatchSelect,
  },
}));

vi.mock('@stores/useSpaceContextTabsStore', () => ({
  useSpaceContextTabsStore: {
    getState: () => ({
      openResourceTab: mockOpenResourceTab,
    }),
  },
}));

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({
      selectSpaceById: mockSelectSpaceById,
    }),
  },
}));

vi.mock('@stores/useMainNavStore', () => ({
  useMainNavStore: {
    getState: () => ({
      setCurrentTab: mockSetCurrentTab,
    }),
  },
}));

vi.mock('./settingsTitle', () => ({
  getSpaceSettingsTitle: mockGetSpaceSettingsTitle,
}));

vi.mock('@/services/openResourceLink', () => ({
  expandCanvasForScope: mockExpandCanvasForScope,
}));

describe('openSpaceSettingsIntent', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockDispatchSelect.mockReturnValue(true);
  });

  it('spaceId 缺失时直接返回 false', async () => {
    const { openSpaceSettingsIntent } = await import(
      './spaceSettingsNavigation'
    );

    expect(openSpaceSettingsIntent(null)).toBe(false);
    expect(mockSelectSpaceById).not.toHaveBeenCalled();
    expect(mockDispatchSelect).not.toHaveBeenCalled();
    expect(mockOpenResourceTab).not.toHaveBeenCalled();
  });

  it('可先对齐 workspace selection，再通过 handler 打开 settings tab', async () => {
    const { openSpaceSettingsIntent } = await import(
      './spaceSettingsNavigation'
    );

    expect(
      openSpaceSettingsIntent('space-1', {
        activateWorkspaceSelection: true,
        section: 'archived',
      }),
    ).toBe(true);

    expect(mockSelectSpaceById).toHaveBeenCalledWith('workspace', 'space-1');
    expect(mockSetCurrentTab).toHaveBeenCalledWith('agent');
    expect(mockDispatchSelect).toHaveBeenCalledWith(
      {
        type: 'tabsettings',
        id: 'space-1',
        tabKey: 'tabsettings:space-1',
        title: 'settings:space-1',
        meta: {
          spaceId: 'space-1',
          section: 'archived',
        },
      },
      {
        spaceId: 'space-1',
        tabScopeKey: 'space-1',
        closeBrowserView: expect.any(Function),
      },
    );
    expect(mockOpenResourceTab).not.toHaveBeenCalled();
    expect(mockExpandCanvasForScope).toHaveBeenCalledWith('space-1');
  });

  it('显式传入 tabScopeKey 时按当前工作台 scope 打开 tab', async () => {
    mockDispatchSelect.mockReturnValue(false);
    const { openSpaceSettingsIntent } = await import(
      './spaceSettingsNavigation'
    );

    expect(
      openSpaceSettingsIntent('space-3', {
        tabScopeKey: 'desktop:organization-1:user:user-1',
      }),
    ).toBe(true);
    expect(mockOpenResourceTab).toHaveBeenCalledWith('desktop:organization-1:user:user-1', {
      type: 'tabsettings',
      id: 'space-3',
      title: 'settings:space-3',
      meta: { spaceId: 'space-3' },
    });
    expect(mockExpandCanvasForScope).toHaveBeenCalledWith('desktop:organization-1:user:user-1');
  });

  it('handler 不可用时回退到 context tabs store', async () => {
    mockDispatchSelect.mockReturnValue(false);
    const { openSpaceSettingsIntent } = await import(
      './spaceSettingsNavigation'
    );

    expect(openSpaceSettingsIntent('space-2')).toBe(true);
    expect(mockSelectSpaceById).not.toHaveBeenCalled();
    expect(mockOpenResourceTab).toHaveBeenCalledWith('space-2', {
      type: 'tabsettings',
      id: 'space-2',
      title: 'settings:space-2',
      meta: { spaceId: 'space-2' },
    });
    expect(mockExpandCanvasForScope).toHaveBeenCalledWith('space-2');
  });
});
