import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockEnsureSpaceSelected, mockToast } = vi.hoisted(() => ({
  mockEnsureSpaceSelected: vi.fn(),
  mockToast: vi.fn(),
}));

vi.mock('../spaceSelection', () => ({
  ensureSpaceSelected: mockEnsureSpaceSelected,
}));

vi.mock('@tabtin/smartsheet-ui/toast', () => ({
  toast: mockToast,
}));

describe('spaceNavigation service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('成功选中时不触发 toast', async () => {
    mockEnsureSpaceSelected.mockResolvedValue(true);
    const { ensureSpaceSelectedWithFeedback } = await import('../spaceNavigation');

    await expect(
      ensureSpaceSelectedWithFeedback('space-1', {
        organizationId: 'ws-1',
      }),
    ).resolves.toBe(true);

    expect(mockEnsureSpaceSelected).toHaveBeenCalledWith('space-1', 'ws-1');
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('传入 isCurrent 时将其交给底层选择，且过期调用不显示失败提示', async () => {
    const isCurrent = vi.fn(() => false);
    mockEnsureSpaceSelected.mockResolvedValue(false);
    const { ensureSpaceSelectedWithFeedback } = await import('../spaceNavigation');

    await expect(
      ensureSpaceSelectedWithFeedback('space-stale', { isCurrent }),
    ).resolves.toBe(false);

    expect(mockEnsureSpaceSelected).toHaveBeenCalledWith('space-stale', undefined, isCurrent);
    expect(mockToast).not.toHaveBeenCalled();
  });

  it('失败时使用自定义 toast 文案反馈', async () => {
    mockEnsureSpaceSelected.mockResolvedValue(false);
    const { ensureSpaceSelectedWithFeedback } = await import('../spaceNavigation');

    await expect(
      ensureSpaceSelectedWithFeedback('space-2', {
        failureToast: {
          title: '打开失败',
          description: '请稍后重试',
          variant: 'destructive',
        },
      }),
    ).resolves.toBe(false);

    expect(mockToast).toHaveBeenCalledWith({
      title: '打开失败',
      description: '请稍后重试',
      variant: 'destructive',
    });
  });

  it('失败时回退到默认错误提示', async () => {
    mockEnsureSpaceSelected.mockResolvedValue(false);
    const { ensureSpaceSelectedWithFeedback } = await import('../spaceNavigation');

    await expect(ensureSpaceSelectedWithFeedback('space-3')).resolves.toBe(false);

    expect(mockToast).toHaveBeenCalledWith({
      title: '无法打开该 Space',
      description: '该 Space 可能是私有的、你没有访问权限、已归档，或当前工作区数据尚未同步完成',
      variant: 'destructive',
    });
  });

  it('throw helper 在选中成功时直接通过', async () => {
    mockEnsureSpaceSelected.mockResolvedValue(true);
    const { ensureSpaceSelectedOrThrow } = await import('../spaceNavigation');

    await expect(
      ensureSpaceSelectedOrThrow('space-4', {
        organizationId: 'ws-4',
        failureMessage: '不应抛错',
      }),
    ).resolves.toBeUndefined();

    expect(mockEnsureSpaceSelected).toHaveBeenCalledWith('space-4', 'ws-4');
  });

  it('throw helper 在失败时抛出自定义错误', async () => {
    mockEnsureSpaceSelected.mockResolvedValue(false);
    const { ensureSpaceSelectedOrThrow } = await import('../spaceNavigation');

    await expect(
      ensureSpaceSelectedOrThrow('space-5', {
        failureMessage: '空间不可用',
      }),
    ).rejects.toThrow('空间不可用');

    expect(mockToast).not.toHaveBeenCalled();
  });
});
