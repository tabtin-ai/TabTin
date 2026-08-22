/**
 * ensureLocalWorkspace —  加载失败 / 刷新后已有本机现场时禁止误建
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockEnsureHome,
  mockLoadSpaces,
  mockSelectSpaceBySpaceId,
  mockDeviceState,
  mockSpaceState,
  mockOrganizationState,
  mockEnsureDefaultAgentDir,
} = vi.hoisted(() => ({
  mockEnsureHome: vi.fn(),
  mockLoadSpaces: vi.fn(),
  mockSelectSpaceBySpaceId: vi.fn(),
  mockEnsureDefaultAgentDir: vi.fn(),
  mockDeviceState: {
    currentDevice: { id: 'device-1' } as { id: string } | null,
    devices: [{ id: 'device-1' }] as Array<{
      id: string;
      fingerprint?: string;
      status?: string;
    }>,
  },
  mockSpaceState: {
    spaces: [] as any[],
    error: null as string | null,
    lastLoadError: null as string | null,
    loadSpaces: vi.fn(),
  },
  mockOrganizationState: {
    selectedOrganization: { id: 'org-1', name: 'Org' } as {
      id: string;
      name: string;
    } | null,
    organizations: [{ id: 'org-1', name: 'Org' }],
  },
}));

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: {
    getState: () => ({
      currentDevice: mockDeviceState.currentDevice,
      devices: mockDeviceState.devices,
    }),
  },
}));

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      spaces: mockSpaceState.spaces,
      error: mockSpaceState.error,
      lastLoadError: mockSpaceState.lastLoadError,
      loadSpaces: mockLoadSpaces,
    }),
  },
}));

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({ selectSpaceBySpaceId: mockSelectSpaceBySpaceId }),
  },
}));

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => mockOrganizationState,
  },
}));

vi.mock('@stores/sessionResetRegistry', () => ({
  registerResetAction: vi.fn(),
}));

vi.mock('@utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@tabtin/app-shell', () => ({
  WorkspaceApiService: {
    ensureHome: mockEnsureHome,
  },
}));

function createDeferred(): {
  promise: Promise<void>;
  resolve: () => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: () => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<void>((promiseResolve, promiseReject) => {
    resolve = () => promiseResolve();
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

describe('ensureLocalWorkspaceForOrganization', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mockDeviceState.currentDevice = { id: 'device-1' };
    mockDeviceState.devices = [{ id: 'device-1' }];
    mockSpaceState.spaces = [];
    mockSpaceState.error = null;
    mockSpaceState.lastLoadError = null;
    mockLoadSpaces.mockResolvedValue(undefined);
    mockEnsureHome.mockResolvedValue({
      id: 'new-space',
      organization_id: 'org-1',
      name: '默认工作空间',
    });
    mockEnsureDefaultAgentDir.mockResolvedValue({
      success: true,
      path: '/tmp/默认工作空间',
    });
    (globalThis as any).window = {
      tabtin: {
        fileSystem: {
          ensureDefaultAgentDir: mockEnsureDefaultAgentDir,
        },
      },
    };
  });

  it('space list 仍有 error 时不 ensure home 工作空间', async () => {
    mockSpaceState.error = 'Failed to load spaces';
    mockSpaceState.spaces = [];

    const {
      ensureLocalWorkspaceForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    await ensureLocalWorkspaceForOrganization('org-1');

    expect(mockEnsureHome).not.toHaveBeenCalled();
    expect(mockLoadSpaces).not.toHaveBeenCalled();
  });

  it('刷新后已有本机工作空间时跳过 create', async () => {
    mockSpaceState.spaces = [];
    mockLoadSpaces.mockImplementation(async () => {
      mockSpaceState.spaces = [
        {
          id: 'existing',
          organization_id: 'org-1',
          type: 'workspace',
          project_id: null,
          control_device_id: 'device-1',
          name: '默认工作空间',
        },
      ];
    });

    const {
      ensureLocalWorkspaceForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    await ensureLocalWorkspaceForOrganization('org-1');

    expect(mockLoadSpaces).toHaveBeenCalledWith('org-1');
    expect(mockEnsureHome).not.toHaveBeenCalled();
  });

  it('已有绑定在其他设备的工作空间时不创建空默认工作空间', async () => {
    mockSpaceState.spaces = [
      {
        id: 'remote-existing',
        organization_id: 'org-1',
        type: 'workspace',
        project_id: null,
        control_device_id: 'device-old',
        name: '原有工作空间',
      },
    ];

    const {
      ensureLocalWorkspaceForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    await ensureLocalWorkspaceForOrganization('org-1');

    expect(mockLoadSpaces).not.toHaveBeenCalled();
    expect(mockEnsureHome).not.toHaveBeenCalled();
    expect(mockEnsureDefaultAgentDir).not.toHaveBeenCalled();
  });

  it('刷新确认仍缺本机现场时才会 ensure home 工作空间', async () => {
    mockSpaceState.spaces = [];

    const {
      ensureLocalWorkspaceForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    await ensureLocalWorkspaceForOrganization('org-1');

    expect(mockLoadSpaces).toHaveBeenCalledWith('org-1');
    expect(mockEnsureDefaultAgentDir).toHaveBeenCalled();
    expect(mockEnsureHome).toHaveBeenCalledWith(
      expect.objectContaining({
        organization_id: 'org-1',
        name: '默认工作空间',
        device_id: 'device-1',
      }),
    );
    expect(mockSelectSpaceBySpaceId).toHaveBeenCalledWith('new-space');
  });

  it('ensure home 返回其他 Organization 的工作空间时不选中', async () => {
    mockEnsureHome.mockResolvedValue({
      id: 'foreign-space',
      organization_id: 'other-org',
      name: '默认工作空间',
    });

    const {
      ensureLocalWorkspaceForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    await ensureLocalWorkspaceForOrganization('org-1');

    expect(mockSelectSpaceBySpaceId).not.toHaveBeenCalled();
  });

  it('allBoundToOthers 时启动兜底不建，force 才 ensure home', async () => {
    mockSpaceState.spaces = [
      {
        id: 'remote-1',
        organization_id: 'org-1',
        type: 'workspace',
        name: '远程',
        control_device_id: 'device-other',
      },
    ];
    mockDeviceState.devices = [
      mockDeviceState.currentDevice,
      { id: 'device-other', fingerprint: 'fp-other', status: 'offline' },
    ];

    const {
      ensureLocalWorkspaceForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    await ensureLocalWorkspaceForOrganization('org-1');
    expect(mockEnsureHome).not.toHaveBeenCalled();

    await ensureLocalWorkspaceForOrganization('org-1', { force: true });
    expect(mockEnsureHome).toHaveBeenCalled();
  });

  it('成员移出后失效初始化标记，重新加入会再次 ensure home', async () => {
    const {
      ensureLocalWorkspaceForOrganization,
      invalidateLocalWorkspaceBootstrapForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    await ensureLocalWorkspaceForOrganization('org-1');
    expect(mockEnsureHome).toHaveBeenCalledTimes(1);

    invalidateLocalWorkspaceBootstrapForOrganization('org-1');
    await ensureLocalWorkspaceForOrganization('org-1');

    expect(mockEnsureHome).toHaveBeenCalledTimes(2);
  });

  it('await 中失效时旧 ensure 不能提交 bootstrapped，且 inflight 仍去重', async () => {
    const firstLoadSpaces = createDeferred();
    mockLoadSpaces.mockImplementationOnce(() => firstLoadSpaces.promise);

    const {
      ensureLocalWorkspaceForOrganization,
      invalidateLocalWorkspaceBootstrapForOrganization,
      __resetLocalWorkspaceBootstrapForTests,
    } = await import('../ensureLocalWorkspace');
    __resetLocalWorkspaceBootstrapForTests();

    const firstEnsure = ensureLocalWorkspaceForOrganization('org-1');
    expect(mockLoadSpaces).toHaveBeenCalledTimes(1);

    invalidateLocalWorkspaceBootstrapForOrganization('org-1');

    await ensureLocalWorkspaceForOrganization('org-1');
    expect(mockLoadSpaces).toHaveBeenCalledTimes(1);
    expect(mockEnsureHome).not.toHaveBeenCalled();

    firstLoadSpaces.resolve();
    await firstEnsure;
    expect(mockEnsureHome).not.toHaveBeenCalled();

    await ensureLocalWorkspaceForOrganization('org-1');

    expect(mockEnsureHome).toHaveBeenCalledTimes(1);
    expect(mockEnsureDefaultAgentDir).toHaveBeenCalledTimes(1);
    expect(mockSelectSpaceBySpaceId).toHaveBeenCalledTimes(1);
  });
});
