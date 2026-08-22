import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockLoadSpaces,
  mockLoadConversations,
  mockSelectSpaceBySpaceId,
  mockSelectedOrganizationId,
} = vi.hoisted(() => ({
  mockLoadSpaces: vi.fn().mockResolvedValue(undefined),
  mockLoadConversations: vi.fn().mockResolvedValue(undefined),
  mockSelectSpaceBySpaceId: vi.fn(),
  mockSelectedOrganizationId: { value: 'ws-1' as string | null },
}));

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: {
    getState: () => ({
      loadSpaces: mockLoadSpaces,
    }),
  },
}));

vi.mock('@stores/useIMStore', () => ({
  useIMStore: {
    getState: () => ({
      loadConversations: mockLoadConversations,
    }),
  },
}));

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: {
    getState: () => ({
      selectSpaceBySpaceId: mockSelectSpaceBySpaceId,
    }),
  },
}));

vi.mock('@stores/useOrganizationStore', () => ({
  useOrganizationStore: {
    getState: () => ({
      selectedOrganization: mockSelectedOrganizationId.value
        ? { id: mockSelectedOrganizationId.value }
        : null,
    }),
  },
}));

describe('spaceSelection service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSelectedOrganizationId.value = 'ws-1';
  });

  it('loadOrganizationSpaceSelectionSources 会并行加载 Agent 与 IM 两类 selection 数据源', async () => {
    const { loadOrganizationSpaceSelectionSources } =
      await import('../spaceSelection');

    await loadOrganizationSpaceSelectionSources('ws-42');

    expect(mockLoadSpaces).toHaveBeenCalledWith('ws-42');
    expect(mockLoadConversations).toHaveBeenCalledWith('ws-42');
  });

  it('ensureSpaceSelected 首次未命中时会加载数据后重试 selection', async () => {
    mockSelectSpaceBySpaceId
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    const { ensureSpaceSelected } = await import('../spaceSelection');

    const success = await ensureSpaceSelected('space-1', 'ws-9');

    expect(success).toBe(true);
    expect(mockSelectSpaceBySpaceId).toHaveBeenNthCalledWith(1, 'space-1');
    expect(mockLoadSpaces).toHaveBeenCalledWith('ws-9');
    expect(mockLoadConversations).toHaveBeenCalledWith('ws-9');
    expect(mockSelectSpaceBySpaceId).toHaveBeenNthCalledWith(2, 'space-1');
  });

  it('异步加载期间调用已过期时不再选中旧 Space', async () => {
    let resolveLoad!: () => void;
    const slowLoad = new Promise<void>((resolve) => {
      resolveLoad = resolve;
    });
    let isCurrent = true;
    mockSelectSpaceBySpaceId.mockReturnValue(false);
    mockLoadSpaces.mockImplementationOnce(() => slowLoad);

    const { ensureSpaceSelected } = await import('../spaceSelection');
    const selection = ensureSpaceSelected('space-old', 'ws-1', () => isCurrent);
    isCurrent = false;
    resolveLoad();

    await expect(selection).resolves.toBe(false);
    expect(mockSelectSpaceBySpaceId).toHaveBeenCalledTimes(1);
    expect(mockSelectSpaceBySpaceId).toHaveBeenCalledWith('space-old');
  });

  it('ensureSpaceSelected 缺少 organization 时不会盲目加载', async () => {
    mockSelectedOrganizationId.value = null;
    mockSelectSpaceBySpaceId.mockReturnValue(false);

    const { ensureSpaceSelected } = await import('../spaceSelection');

    const success = await ensureSpaceSelected('space-1');

    expect(success).toBe(false);
    expect(mockLoadSpaces).not.toHaveBeenCalled();
    expect(mockLoadConversations).not.toHaveBeenCalled();
  });
});
