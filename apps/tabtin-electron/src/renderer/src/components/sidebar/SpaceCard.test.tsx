import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.setConfig({ testTimeout: 20_000, hookTimeout: 20_000 })

const {
  mockSelectSpace,
  mockOpenSpaceSettingsIntent,
  mockActivateForegroundSpace,
  mockSpacesRef,
} = vi.hoisted(() => ({
  mockSelectSpace: vi.fn(),
  mockOpenSpaceSettingsIntent: vi.fn(),
  mockActivateForegroundSpace: vi.fn(),
  mockSpacesRef: {
    current: [
      {
        id: 'space-1',
        name: 'Bot One',
        control_device_id: null,
        bound_device_id: null,
      },
    ] as Array<Record<string, unknown>>,
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string; [key: string]: unknown }) => {
      let text = options?.defaultValue ?? key;
      for (const [name, value] of Object.entries(options ?? {})) {
        if (name === 'defaultValue') continue;
        text = text.replaceAll(`{{${name}}}`, String(value));
      }
      return text;
    },
  }),
}));

vi.mock('@stores/useSpaceListStore', () => ({
  useSpaceListStore: Object.assign(
    (selector: (state: Record<string, unknown>) => unknown) =>
      selector({
        selectSpace: mockSelectSpace,
      }),
    {
      getState: () => ({
        selectSpace: mockSelectSpace,
      }),
    },
  ),
}));

vi.mock('@stores/useSpaceStore', () => ({
  useSpaceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      spaces: mockSpacesRef.current,
      agentCache: {},
    }),
}));

vi.mock('@stores/useDeviceStore', () => ({
  useDeviceStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      devices: [],
    }),
}));

vi.mock('@stores/useIMStore', () => ({
  useIMStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      conversations: [],
    }),
}));

vi.mock('@components/context-space/hooks/useSpaceContextNavigation', () => ({
  useSpaceContextNavigation: () => ({
    openHome: vi.fn(),
  }),
}));

vi.mock('@components/space-settings/spaceSettingsNavigation', () => ({
  openSpaceSettingsIntent: mockOpenSpaceSettingsIntent,
}));

vi.mock('@/stores/useWorkbenchSceneStore', () => ({
  useWorkbenchSceneStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activateForegroundSpace: mockActivateForegroundSpace,
    }),
}));

vi.mock('./AgentContextMenu', () => ({
  AgentContextMenu: ({
    children,
    onSettings,
  }: {
    children: React.ReactNode;
    onSettings: () => void;
  }) =>
    React.createElement(
      'div',
      null,
      children,
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'open-settings',
          onClick: onSettings,
        },
        'settings',
      ),
    ),
}));

vi.mock('./SpaceContextMenu', () => ({
  SpaceContextMenu: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

describe('SpaceCard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSpacesRef.current = [
      {
        id: 'space-1',
        name: 'Bot One',
        control_device_id: null,
        bound_device_id: null,
      },
    ];
  });

  it('workspace 设置入口会同步选中 space 并立即打开设置，不再依赖延时', async () => {
    const { SpaceCard } = await import('./SpaceCard');

    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout');

    render(
      React.createElement(SpaceCard, {
        space: {
          id: 'space-1',
          source_id: 'space-1',
          organization_id: 'ws-1',
          navigationKind: 'workspace',
          type: 'workspace',
          name: 'Bot One',
          order: 1,
          unread_count: 0,
        },
        isSelected: false,
      }),
    );

    setTimeoutSpy.mockClear();
    fireEvent.click(screen.getByTestId('open-settings'));

    expect(mockOpenSpaceSettingsIntent).toHaveBeenCalledWith('space-1', {
      activateWorkspaceSelection: true,
    });
    expect(setTimeoutSpy).not.toHaveBeenCalled();

    setTimeoutSpy.mockRestore();
  });

  it('无障碍标签会带上所属身份标记，便于区分个人与团队 Agent', async () => {
    const { SpaceCard } = await import('./SpaceCard');

    render(
      React.createElement(SpaceCard, {
        space: {
          id: 'space-1',
          source_id: 'space-1',
          organization_id: 'ws-1',
          organization_type: 'personal',
          navigationKind: 'workspace',
          type: 'workspace',
          name: 'Bot One',
          order: 1,
          unread_count: 0,
        },
        isSelected: false,
      }),
    );

    expect(screen.getByLabelText(/@个人身份/)).toBeTruthy();
  });

  it('workspace 忽略历史头像并使用名称首字母', async () => {
    const { SpaceCard } = await import('./SpaceCard');

    render(
      React.createElement(SpaceCard, {
        space: {
          id: 'space-1',
          source_id: 'space-1',
          organization_id: 'ws-1',
          navigationKind: 'workspace',
          type: 'workspace',
          name: 'Bot One',
          avatar: 'https://cdn.example.com/legacy-avatar.png',
          order: 1,
          unread_count: 0,
        },
        isSelected: false,
      }),
    );

    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByText('B')).toBeTruthy();
  });

  it('非工作空间仍展示会话自定义头像', async () => {
    const { SpaceCard } = await import('./SpaceCard');

    render(
      React.createElement(SpaceCard, {
        space: {
          id: 'group-1',
          source_id: 'group-1',
          organization_id: 'ws-1',
          navigationKind: 'im-group',
          type: 'im_group',
          name: '项目讨论',
          avatar: 'https://cdn.example.com/group-avatar.png',
          order: 1,
          unread_count: 0,
        },
        isSelected: false,
      }),
    );

    expect(screen.getByRole('img').getAttribute('src')).toBe('https://cdn.example.com/group-avatar.png');
  });

  it('workspace 无障碍标签会展示完整工作目录', async () => {
    const { SpaceCard } = await import('./SpaceCard');

    render(
      React.createElement(SpaceCard, {
        space: {
          id: 'space-1',
          source_id: 'space-1',
          organization_id: 'ws-1',
          navigationKind: 'workspace',
          type: 'workspace',
          name: 'Bot One',
          order: 1,
          unread_count: 0,
          working_dir: 'C:\\Users\\me\\project',
          normalized_working_dir: 'C:\\Users\\me\\project',
          working_dir_type: 'code',
        },
        isSelected: false,
      }),
    );

    expect(screen.getByLabelText(/工作目录：C:\\Users\\me\\project/)).toBeTruthy();
  });
});
