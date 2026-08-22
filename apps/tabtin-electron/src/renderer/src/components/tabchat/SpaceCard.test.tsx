import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { mockCloseSettings, mockEnsureSpaceSelectedWithFeedback } = vi.hoisted(() => ({
  mockCloseSettings: vi.fn(),
  mockEnsureSpaceSelectedWithFeedback: vi.fn().mockResolvedValue(true),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) =>
      typeof options?.defaultValue === 'string' ? options.defaultValue : key,
  }),
}));

vi.mock('@/services/spaceNavigation', () => ({
  ensureSpaceSelectedWithFeedback: mockEnsureSpaceSelectedWithFeedback,
}));

vi.mock('@stores/useSettingsSpaceStore', () => ({
  useSettingsSpaceStore: (selector: (state: { closeSettings: () => void }) => unknown) =>
    selector({ closeSettings: mockCloseSettings }),
}));

describe('tabchat SpaceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('点击后走统一的 ensureSpaceSelected 导航链路', async () => {
    const { SpaceCard } = await import('./SpaceCard');

    render(
      React.createElement(SpaceCard, {
        spaceId: 'space-1',
        name: 'Bot One',
      }),
    );

    fireEvent.click(screen.getByRole('button'));

    expect(mockCloseSettings).toHaveBeenCalled();
    expect(mockEnsureSpaceSelectedWithFeedback).toHaveBeenCalledWith('space-1', {
      failureToast: {
        title: '无法打开该 Agent',
        description: '该 Agent 可能已归档、删除，或数据尚未同步完成',
        variant: 'destructive',
      },
    });
  });
});
